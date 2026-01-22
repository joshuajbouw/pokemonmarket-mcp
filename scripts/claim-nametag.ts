/**
 * One-off script to claim a nametag on Unicity testnet
 *
 * Usage:
 *   npx tsx scripts/claim-nametag.ts <nametag>
 *
 * Example:
 *   npx tsx scripts/claim-nametag.ts grittenald
 *
 * This will:
 * 1. Generate a new private key (or use existing if found)
 * 2. Mint the nametag on Unicity testnet
 * 3. Publish Nostr binding
 * 4. Save identity to data/user-<nametag>.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { UnmaskedPredicateReference } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { TokenType } from "@unicitylabs/state-transition-sdk/lib/token/TokenType.js";
import { TokenId } from "@unicitylabs/state-transition-sdk/lib/token/TokenId.js";
import { MintTransactionData } from "@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js";
import { MintCommitment } from "@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { Authenticator } from "@unicitylabs/state-transition-sdk/lib/api/Authenticator.js";
import { HexConverter } from "@unicitylabs/state-transition-sdk/lib/util/HexConverter.js";
import { MintTransactionState } from "@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionState.js";
import { NostrKeyManager, NostrClient } from "@unicitylabs/nostr-js-sdk";
import "dotenv/config";

// Nametag token type (same as in identity.ts)
const NAMETAG_TOKEN_TYPE_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

// Config from environment
const NOSTR_RELAY_URL = process.env.NOSTR_RELAY_URL || "wss://nostr-relay.testnet.unicity.network";
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || "https://goggregator-test.unicity.network";
const AGGREGATOR_API_KEY = process.env.AGGREGATOR_API_KEY || "";
const DATA_DIR = process.env.DATA_DIR || "./data";

interface UserIdentity {
  privateKeyHex: string;
  publicKeyHex: string;
  nostrPubkeyHex: string;
  nametag: string;
  walletAddress: string;
  createdAt: string;
}

async function deriveWalletAddress(signingService: SigningService): Promise<string> {
  const tokenType = new TokenType(HexConverter.decode(NAMETAG_TOKEN_TYPE_HEX));
  const predicateRef = await UnmaskedPredicateReference.createFromSigningService(
    tokenType,
    signingService,
    HashAlgorithm.SHA256
  );
  const address = await predicateRef.toAddress();
  return address.address;
}

async function waitForInclusionProof(
  aggregatorClient: AggregatorClient,
  requestId: unknown,
  maxWaitMs: number = 60000
): Promise<unknown> {
  const startTime = Date.now();
  const pollInterval = 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // @ts-expect-error - RequestId type complexity
      const response = await aggregatorClient.getInclusionProof(requestId);
      if (response && response.inclusionProof) {
        return response.inclusionProof;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error("Timeout waiting for inclusion proof");
}

async function mintNametag(
  signingService: SigningService,
  nametag: string
): Promise<object> {
  console.log(`\n📝 Minting nametag @${nametag}...`);

  const tokenType = new TokenType(HexConverter.decode(NAMETAG_TOKEN_TYPE_HEX));
  const tokenId = await TokenId.fromNameTag(nametag);

  const predicateRef = await UnmaskedPredicateReference.createFromSigningService(
    tokenType,
    signingService,
    HashAlgorithm.SHA256
  );
  const recipientAddress = await predicateRef.toAddress();

  const salt = randomBytes(32);

  const mintData = await MintTransactionData.createFromNametag(
    nametag,
    tokenType,
    recipientAddress,
    salt,
    recipientAddress
  );

  const commitment = await MintCommitment.create(mintData);
  const transactionHash = await mintData.calculateHash();
  const mintState = await MintTransactionState.create(tokenId);
  const authenticator = await Authenticator.create(signingService, transactionHash, mintState);
  const requestId = await authenticator.calculateRequestId();

  const aggregatorClient = new AggregatorClient(AGGREGATOR_URL, AGGREGATOR_API_KEY);

  console.log("   Submitting to aggregator...");
  await aggregatorClient.submitCommitment(requestId, transactionHash, authenticator, true);

  console.log("   Waiting for inclusion proof...");
  const inclusionProof = await waitForInclusionProof(aggregatorClient, requestId);

  // @ts-expect-error - InclusionProof type complexity
  const mintTransaction = commitment.toTransaction(inclusionProof);

  console.log(`✅ Nametag @${nametag} minted successfully!`);

  return mintTransaction.toJSON();
}

async function publishNostrBinding(
  keyManager: NostrKeyManager,
  nametag: string,
  walletAddress: string
): Promise<boolean> {
  console.log(`\n🔗 Publishing Nostr binding for @${nametag}...`);

  const client = new NostrClient(keyManager);

  try {
    await client.connect(NOSTR_RELAY_URL);
    console.log(`   Connected to ${NOSTR_RELAY_URL}`);

    // Check if binding already exists
    const existingPubkey = await client.queryPubkeyByNametag(nametag);
    if (existingPubkey === keyManager.getPublicKeyHex()) {
      console.log("   Binding already exists for this key");
      client.disconnect();
      return true;
    }

    if (existingPubkey) {
      console.log(`⚠️  Warning: @${nametag} is already bound to a different pubkey!`);
      console.log(`   Existing: ${existingPubkey.substring(0, 16)}...`);
      console.log(`   Yours:    ${keyManager.getPublicKeyHex().substring(0, 16)}...`);
      client.disconnect();
      return false;
    }

    const success = await client.publishNametagBinding(nametag, walletAddress);
    client.disconnect();

    if (success) {
      console.log("✅ Nostr binding published!");
    } else {
      console.log("❌ Failed to publish Nostr binding");
    }

    return success;
  } catch (error) {
    console.error("❌ Error publishing Nostr binding:", error);
    client.disconnect();
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: npx tsx scripts/claim-nametag.ts <nametag>");
    console.log("Example: npx tsx scripts/claim-nametag.ts grittenald");
    process.exit(1);
  }

  const nametag = args[0].replace(/^@/, ""); // Remove @ if present
  const identityFile = path.join(DATA_DIR, `user-${nametag}.json`);

  console.log("=".repeat(50));
  console.log(`  Claiming nametag: @${nametag}`);
  console.log("=".repeat(50));

  // Check if identity already exists
  let privateKey: Uint8Array;
  let isExisting = false;

  if (fs.existsSync(identityFile)) {
    console.log(`\n📂 Found existing identity at ${identityFile}`);
    const existing = JSON.parse(fs.readFileSync(identityFile, "utf-8")) as UserIdentity;
    privateKey = HexConverter.decode(existing.privateKeyHex);
    isExisting = true;
    console.log(`   Using existing key: ${existing.publicKeyHex.substring(0, 16)}...`);
  } else {
    console.log("\n🔑 Generating new private key...");
    privateKey = randomBytes(32);
  }

  // Create signing service
  const signingService = await SigningService.createFromSecret(privateKey);
  const publicKeyHex = HexConverter.encode(signingService.publicKey);
  const privateKeyHex = HexConverter.encode(privateKey);

  // Create Nostr key manager
  const keyManager = NostrKeyManager.fromPrivateKey(privateKey);
  const nostrPubkeyHex = keyManager.getPublicKeyHex();

  console.log(`\n📋 Identity:`);
  console.log(`   Public Key: ${publicKeyHex.substring(0, 32)}...`);
  console.log(`   Nostr Pubkey: ${nostrPubkeyHex.substring(0, 32)}...`);

  // Derive wallet address
  const walletAddress = await deriveWalletAddress(signingService);
  console.log(`   Wallet: ${walletAddress.substring(0, 40)}...`);

  // Mint nametag (skip if already done)
  const nametagFile = path.join(DATA_DIR, `nametag-${nametag}.json`);
  if (!fs.existsSync(nametagFile)) {
    try {
      const transaction = await mintNametag(signingService, nametag);

      // Save nametag transaction
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(
        nametagFile,
        JSON.stringify({ nametag, transaction, mintedAt: new Date().toISOString() }, null, 2)
      );
      console.log(`   Saved to ${nametagFile}`);
    } catch (error) {
      console.error(`\n❌ Failed to mint nametag:`, error);
      process.exit(1);
    }
  } else {
    console.log(`\n📝 Nametag already minted (found ${nametagFile})`);
  }

  // Publish Nostr binding
  const bindingSuccess = await publishNostrBinding(keyManager, nametag, walletAddress);

  // Save identity
  const identity: UserIdentity = {
    privateKeyHex,
    publicKeyHex,
    nostrPubkeyHex,
    nametag,
    walletAddress,
    createdAt: isExisting ? JSON.parse(fs.readFileSync(identityFile, "utf-8")).createdAt : new Date().toISOString(),
  };

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2));

  console.log("\n" + "=".repeat(50));
  console.log("  DONE!");
  console.log("=".repeat(50));
  console.log(`\n📁 Identity saved to: ${identityFile}`);
  console.log(`\n🔐 Your credentials:`);
  console.log(`   Nametag:     @${nametag}`);
  console.log(`   Private Key: ${privateKeyHex}`);
  console.log(`   Nostr Pubkey: ${nostrPubkeyHex}`);
  console.log(`   Wallet:      ${walletAddress}`);

  if (!bindingSuccess) {
    console.log(`\n⚠️  Nostr binding may have failed - you might need to retry`);
  }

  console.log(`\n💡 To use this identity in a Unicity wallet, import the private key above.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
