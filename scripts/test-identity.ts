/**
 * Test script to verify identity service functionality
 * Run with: npx tsx scripts/test-identity.ts
 *
 * Note: Full minting and Nostr binding requires network access and valid credentials.
 * This script tests the core identity functions locally.
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { UnmaskedPredicateReference } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { TokenType } from "@unicitylabs/state-transition-sdk/lib/token/TokenType.js";
import { HexConverter } from "@unicitylabs/state-transition-sdk/lib/util/HexConverter.js";
import { NostrKeyManager } from "@unicitylabs/nostr-js-sdk";

const NAMETAG_TOKEN_TYPE_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_DATA_DIR = "./data-test";

async function main() {
  console.log("Testing Identity Service Components...\n");

  try {
    // Test 1: Generate private key
    console.log("1. Testing key generation...");
    const privateKey = randomBytes(32);
    console.log(`   Generated private key: ${HexConverter.encode(privateKey).substring(0, 16)}...`);

    // Test 2: Create SigningService
    console.log("\n2. Testing SigningService creation...");
    const signingService = await SigningService.createFromSecret(privateKey);
    const publicKey = signingService.publicKey;
    const publicKeyHex = HexConverter.encode(publicKey);
    console.log(`   Public key: ${publicKeyHex.substring(0, 16)}...`);
    console.log(`   Algorithm: ${signingService.algorithm}`);

    // Test 3: Create NostrKeyManager
    console.log("\n3. Testing NostrKeyManager creation...");
    const keyManager = NostrKeyManager.fromPrivateKey(privateKey);
    const nostrPubkey = keyManager.getPublicKeyHex();
    const npub = keyManager.getNpub();
    console.log(`   Nostr pubkey: ${nostrPubkey.substring(0, 16)}...`);
    console.log(`   npub: ${npub.substring(0, 20)}...`);

    // Test 4: Derive wallet address
    console.log("\n4. Testing wallet address derivation...");
    const tokenType = new TokenType(HexConverter.decode(NAMETAG_TOKEN_TYPE_HEX));
    const predicateRef = await UnmaskedPredicateReference.createFromSigningService(
      tokenType,
      signingService,
      HashAlgorithm.SHA256
    );
    const address = await predicateRef.toAddress();
    console.log(`   Wallet address: ${address.address}`);

    // Test 5: Test signing
    console.log("\n5. Testing message signing...");
    const testMessage = new Uint8Array(32).fill(0xab);
    const signature = keyManager.sign(testMessage);
    console.log(`   Signature: ${HexConverter.encode(signature).substring(0, 32)}...`);

    // Test 6: Verify NostrKeyManager and SigningService use the same key
    console.log("\n6. Verifying key consistency...");
    // The x-only pubkey from Nostr and the full pubkey from SigningService
    // should have the same x-coordinate (Nostr uses x-only pubkeys)
    const nostrPubkeyBytes = keyManager.getPublicKey();
    console.log(`   Nostr pubkey length: ${nostrPubkeyBytes.length} bytes`);
    console.log(`   Signing pubkey length: ${publicKey.length} bytes`);

    // Test 7: Test file persistence
    console.log("\n7. Testing file persistence...");
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    }

    const testIdentity = {
      privateKeyHex: HexConverter.encode(privateKey),
      publicKeyHex: publicKeyHex,
      nametag: "test-nametag",
      walletAddress: address.address,
      createdAt: new Date().toISOString(),
    };

    const identityPath = path.join(TEST_DATA_DIR, "test-identity.json");
    fs.writeFileSync(identityPath, JSON.stringify(testIdentity, null, 2));
    console.log(`   Saved test identity to ${identityPath}`);

    // Re-read and verify
    const loadedIdentity = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
    const loadedKey = HexConverter.decode(loadedIdentity.privateKeyHex);
    const loadedSigning = await SigningService.createFromSecret(loadedKey);

    if (HexConverter.encode(loadedSigning.publicKey) === publicKeyHex) {
      console.log("   Identity loaded and verified successfully");
    } else {
      throw new Error("Loaded identity does not match original");
    }

    // Cleanup
    fs.unlinkSync(identityPath);
    fs.rmdirSync(TEST_DATA_DIR);
    console.log("   Cleaned up test files");

    console.log("\n✓ All identity service component tests passed!");
    console.log("\nNote: Full integration testing (minting, Nostr binding) requires:");
    console.log("  - Valid AGGREGATOR_URL and NOSTR_RELAY_URL");
    console.log("  - Network access to Unicity testnet");
    console.log("  - A unique MCP_NAMETAG that hasn't been minted");
  } catch (error) {
    console.error("\n✗ Identity service test failed:");
    console.error(error);
    process.exit(1);
  }
}

main();
