/**
 * Identity service for Unicity integration
 *
 * Handles:
 * - Private key generation/loading
 * - Wallet address derivation
 * - Nametag minting on first run
 * - Nostr binding publication
 * - Identity persistence
 * - Token finalization services
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
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import type { IMintTransactionReason } from "@unicitylabs/state-transition-sdk/lib/transaction/IMintTransactionReason.js";
import { NostrKeyManager, NostrClient } from "@unicitylabs/nostr-js-sdk";
import type { Config } from "../config.js";
import type { Identity, StoredIdentity, StoredNametagToken } from "./types.js";
import { NAMETAG_TOKEN_TYPE_HEX } from "./types.js";
import trustbaseJson from "../trustbase-testnet.json" with { type: "json" };

const IDENTITY_FILE = "identity.json";
const NAMETAG_MINT_RETRIES = 3;
const NAMETAG_MINT_RETRY_DELAY_MS = 2000;
const INCLUSION_PROOF_POLL_INTERVAL_MS = 1000;
const INCLUSION_PROOF_MAX_WAIT_MS = 60000;

/**
 * Ensure data directory exists
 */
function ensureDataDir(dataDir: string): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Load identity from disk if it exists
 */
function loadStoredIdentity(dataDir: string): StoredIdentity | null {
  const filePath = path.join(dataDir, IDENTITY_FILE);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as StoredIdentity;
}

/**
 * Save identity to disk
 */
function saveStoredIdentity(dataDir: string, identity: StoredIdentity): void {
  ensureDataDir(dataDir);
  const filePath = path.join(dataDir, IDENTITY_FILE);
  fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), "utf-8");
}

/**
 * Load nametag token from disk
 */
export function loadNametagToken(dataDir: string, nametag: string): StoredNametagToken | null {
  const filePath = path.join(dataDir, `nametag-${nametag}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as StoredNametagToken;
}

/**
 * Save nametag token to disk
 */
function saveNametagToken(dataDir: string, token: StoredNametagToken): void {
  ensureDataDir(dataDir);
  const filePath = path.join(dataDir, `nametag-${token.nametag}.json`);
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2), "utf-8");
}

/**
 * Generate a new random private key
 */
function generatePrivateKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * Load private key from config or generate a new one
 */
function loadOrGeneratePrivateKey(config: Config, dataDir: string): { privateKey: Uint8Array; isNew: boolean } {
  // First, check if there's a key in environment
  if (config.unicity.privateKeyHex) {
    return {
      privateKey: HexConverter.decode(config.unicity.privateKeyHex),
      isNew: false,
    };
  }

  // Check if there's a stored identity
  const storedIdentity = loadStoredIdentity(dataDir);
  if (storedIdentity) {
    return {
      privateKey: HexConverter.decode(storedIdentity.privateKeyHex),
      isNew: false,
    };
  }

  // Generate a new key
  return {
    privateKey: generatePrivateKey(),
    isNew: true,
  };
}

/**
 * Derive wallet address from signing service
 */
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

/**
 * Wait for inclusion proof with polling
 */
async function waitForInclusionProof(
  aggregatorClient: AggregatorClient,
  requestId: unknown
): Promise<unknown> {
  const startTime = Date.now();

  while (Date.now() - startTime < INCLUSION_PROOF_MAX_WAIT_MS) {
    try {
      // @ts-expect-error - RequestId type complexity
      const response = await aggregatorClient.getInclusionProof(requestId);
      if (response && response.inclusionProof) {
        return response.inclusionProof;
      }
    } catch {
      // Not ready yet, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, INCLUSION_PROOF_POLL_INTERVAL_MS));
  }

  throw new Error("Timeout waiting for inclusion proof");
}

/**
 * Mint a nametag token on the Unicity blockchain
 */
async function mintNametag(
  config: Config,
  signingService: SigningService,
  walletAddress: string,
  nametag: string
): Promise<StoredNametagToken> {
  const tokenType = new TokenType(HexConverter.decode(NAMETAG_TOKEN_TYPE_HEX));
  const tokenId = await TokenId.fromNameTag(nametag);

  // Create the recipient address from the predicate reference
  const predicateRef = await UnmaskedPredicateReference.createFromSigningService(
    tokenType,
    signingService,
    HashAlgorithm.SHA256
  );
  const recipientAddress = await predicateRef.toAddress();

  // Generate salt for the mint
  const salt = randomBytes(32);

  // Create mint transaction data
  const mintData = await MintTransactionData.createFromNametag(
    nametag,
    tokenType,
    recipientAddress,
    salt,
    recipientAddress
  );

  // Create mint commitment
  const commitment = await MintCommitment.create(mintData);

  // Calculate transaction hash for signing
  const transactionHash = await mintData.calculateHash();

  // Create initial state for the token
  const mintState = await MintTransactionState.create(tokenId);

  // Create authenticator
  const authenticator = await Authenticator.create(signingService, transactionHash, mintState);

  // Get request ID
  const requestId = await authenticator.calculateRequestId();

  // Create aggregator client
  const aggregatorClient = new AggregatorClient(
    config.unicity.aggregatorUrl,
    config.unicity.aggregatorApiKey
  );

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= NAMETAG_MINT_RETRIES; attempt++) {
    try {
      // Submit the commitment
      await aggregatorClient.submitCommitment(requestId, transactionHash, authenticator, true);

      // Wait for inclusion proof
      const inclusionProof = await waitForInclusionProof(aggregatorClient, requestId);

      // Create the mint transaction from commitment and proof
      // @ts-expect-error - InclusionProof type complexity
      const mintTransaction = commitment.toTransaction(inclusionProof);

      // Save and return the token
      const storedToken: StoredNametagToken = {
        nametag,
        transaction: mintTransaction.toJSON(),
        mintedAt: new Date().toISOString(),
      };

      return storedToken;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Nametag mint attempt ${attempt}/${NAMETAG_MINT_RETRIES} failed:`, lastError.message);

      if (attempt < NAMETAG_MINT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, NAMETAG_MINT_RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(`Failed to mint nametag after ${NAMETAG_MINT_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Publish nametag binding to Nostr relay
 */
async function publishNostrBinding(
  config: Config,
  keyManager: NostrKeyManager,
  nametag: string,
  walletAddress: string
): Promise<boolean> {
  const client = new NostrClient(keyManager);

  try {
    await client.connect(config.unicity.nostrRelayUrl);

    // Check if binding already exists
    const existingPubkey = await client.queryPubkeyByNametag(nametag);
    if (existingPubkey === keyManager.getPublicKeyHex()) {
      // Binding already exists for our key
      client.disconnect();
      return true;
    }

    // Publish the binding
    const success = await client.publishNametagBinding(nametag, walletAddress);

    client.disconnect();
    return success;
  } catch (error) {
    console.error("Failed to publish Nostr binding:", error);
    client.disconnect();
    return false;
  }
}

/**
 * IdentityService class that manages identity and provides token finalization services
 */
export class IdentityService {
  private config: Config;

  // Sync-initialized in constructor
  private aggregatorClient: AggregatorClient;
  private stateTransitionClient: StateTransitionClient;
  private rootTrustBase: RootTrustBase;

  // Async-initialized in initialize()
  private _identity: Identity | null = null;
  private nametagToken: Token<IMintTransactionReason> | null = null;
  private isInitialized = false;

  constructor(config: Config) {
    this.config = config;
    this.aggregatorClient = new AggregatorClient(
      config.unicity.aggregatorUrl,
      config.unicity.aggregatorApiKey
    );
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);
    this.rootTrustBase = RootTrustBase.fromJSON(trustbaseJson);
  }

  /**
   * Initialize the identity service
   * Loads or generates identity, mints nametag if needed, publishes Nostr binding
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const dataDir = this.config.dataDir;
    ensureDataDir(dataDir);

    // Load or generate private key
    const { privateKey, isNew } = loadOrGeneratePrivateKey(this.config, dataDir);

    // Create signing service (async factory method)
    const signingService = await SigningService.createFromSecret(privateKey);

    // Create Nostr key manager
    const keyManager = NostrKeyManager.fromPrivateKey(privateKey);

    // Get public key
    const publicKey = signingService.publicKey;
    const publicKeyHex = HexConverter.encode(publicKey);
    const privateKeyHex = HexConverter.encode(privateKey);

    // Derive wallet address
    const walletAddress = await deriveWalletAddress(signingService);

    const nametag = this.config.unicity.nametag;

    // Check if nametag token exists
    let storedNametagToken = loadNametagToken(dataDir, nametag);

    if (!storedNametagToken) {
      console.error(`Minting nametag @${nametag}...`);
      storedNametagToken = await mintNametag(this.config, signingService, walletAddress, nametag);
      saveNametagToken(dataDir, storedNametagToken);
      console.error(`Nametag @${nametag} minted successfully`);
    }

    // Load nametag as Token object for finalization
    this.nametagToken = await this.loadNametagAsToken(storedNametagToken);

    // Publish Nostr binding
    console.error(`Publishing Nostr binding for @${nametag}...`);
    const bindingSuccess = await publishNostrBinding(this.config, keyManager, nametag, walletAddress);
    if (bindingSuccess) {
      console.error(`Nostr binding published for @${nametag}`);
    } else {
      console.error(`Warning: Failed to publish Nostr binding for @${nametag}`);
    }

    // Save identity if it's new
    if (isNew) {
      const storedIdentity: StoredIdentity = {
        privateKeyHex,
        publicKeyHex,
        nametag,
        walletAddress,
        createdAt: new Date().toISOString(),
      };
      saveStoredIdentity(dataDir, storedIdentity);
      console.error(`Identity saved to ${path.join(dataDir, IDENTITY_FILE)}`);
    }

    this._identity = {
      signingService,
      keyManager,
      publicKey,
      privateKeyHex,
      nametag,
      walletAddress,
    };

    this.isInitialized = true;
  }

  /**
   * Load nametag token as Token object from stored data
   */
  private async loadNametagAsToken(stored: StoredNametagToken): Promise<Token<IMintTransactionReason> | null> {
    try {
      return await Token.fromJSON(stored.transaction);
    } catch (error) {
      console.error("Failed to load nametag as Token:", error);
      return null;
    }
  }

  /**
   * Get the identity (throws if not initialized)
   */
  getIdentity(): Identity {
    if (!this._identity) {
      throw new Error("IdentityService not initialized");
    }
    return this._identity;
  }

  /**
   * Get the signing service
   */
  getSigningService(): SigningService {
    return this.getIdentity().signingService;
  }

  /**
   * Get the Nostr key manager
   */
  getKeyManager(): NostrKeyManager {
    return this.getIdentity().keyManager;
  }

  /**
   * Get the state transition client for token finalization
   */
  getStateTransitionClient(): StateTransitionClient {
    return this.stateTransitionClient;
  }

  /**
   * Get the root trust base for token validation
   */
  getRootTrustBase(): RootTrustBase {
    return this.rootTrustBase;
  }

  /**
   * Get the nametag token (for proxy address finalization)
   */
  getNametagToken(): Token<IMintTransactionReason> | null {
    return this.nametagToken;
  }

  /**
   * Get the config
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

/**
 * Initialize identity service (backward-compatible function)
 *
 * This function:
 * 1. Loads or generates a private key
 * 2. Creates signing service and key manager
 * 3. Derives wallet address
 * 4. Mints nametag if needed (first run)
 * 5. Publishes Nostr binding
 * 6. Persists identity to disk
 */
export async function initializeIdentity(config: Config): Promise<Identity> {
  const service = new IdentityService(config);
  await service.initialize();
  return service.getIdentity();
}

/**
 * Load existing identity without minting or publishing
 * Useful for testing or when identity already exists
 */
export async function loadIdentity(config: Config): Promise<Identity | null> {
  const dataDir = config.dataDir;

  const storedIdentity = loadStoredIdentity(dataDir);
  if (!storedIdentity) {
    return null;
  }

  const privateKey = HexConverter.decode(storedIdentity.privateKeyHex);
  const signingService = await SigningService.createFromSecret(privateKey);
  const keyManager = NostrKeyManager.fromPrivateKey(privateKey);

  return {
    signingService,
    keyManager,
    publicKey: signingService.publicKey,
    privateKeyHex: storedIdentity.privateKeyHex,
    nametag: storedIdentity.nametag,
    walletAddress: storedIdentity.walletAddress,
  };
}
