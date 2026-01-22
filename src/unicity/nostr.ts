/**
 * Nostr service for payment requests and token transfer handling
 *
 * Handles:
 * - Connecting to Nostr relay
 * - Sending payment requests to customers
 * - Listening for TOKEN_TRANSFER events
 * - Matching incoming payments to pending requests
 * - Token finalization and storage
 * - Tracking pending payments
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  NostrClient,
  EventKinds,
  Filter,
  TokenTransferProtocol,
} from "@unicitylabs/nostr-js-sdk";
import type { Event, NostrEventListener } from "@unicitylabs/nostr-js-sdk";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TransferTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js";
import { AddressScheme } from "@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import type { IMintTransactionReason } from "@unicitylabs/state-transition-sdk/lib/transaction/IMintTransactionReason.js";
import type { Config } from "../config.js";
import type { PendingPayment, ConfirmedPayment } from "./types.js";
import type { IdentityService } from "./identity.js";

/**
 * Internal pending payment with promise resolver
 */
interface PendingPaymentInternal extends PendingPayment {
  resolve: (payment: ConfirmedPayment) => void;
  reject: (error: Error) => void;
}

/**
 * Result of a payment request
 */
export interface PaymentRequestResult {
  /** Nostr event ID for the payment request */
  eventId: string;
  /** Amount in tokens (smallest unit) */
  amountTokens: bigint;
  /** Recipient nametag for receiving payment */
  recipientNametag: string;
  /** Coin ID for the payment */
  coinId: string;
  /** Customer's Nostr public key */
  customerPubkey: string;
}

/**
 * NostrService manages payment communication over Nostr
 */
export class NostrService {
  private client: NostrClient | null = null;
  private config: Config | null = null;
  private identityService: IdentityService | null = null;
  private pendingPayments: Map<string, PendingPaymentInternal> = new Map();
  private confirmedPayments: Map<string, ConfirmedPayment> = new Map();
  private transferSubscriptionId: string | null = null;
  private isInitialized = false;

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Initialize the Nostr service
   * Connects to the relay and sets up TOKEN_TRANSFER subscription
   */
  async initialize(config: Config, identityService: IdentityService): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.config = config;
    this.identityService = identityService;
    this.client = new NostrClient(identityService.getKeyManager(), {
      queryTimeoutMs: 15000,
      autoReconnect: true,
      pingIntervalMs: 30000,
    });

    // Add connection event listeners for logging and reconnection handling
    this.client.addConnectionListener({
      onConnect: (url: string) => {
        console.error(`[NostrService] Connected to ${url}`);
      },
      onDisconnect: (url: string, reason: string) => {
        console.error(`[NostrService] Disconnected from ${url}: ${reason}`);
      },
      onReconnecting: (url: string, attempt: number) => {
        console.error(`[NostrService] Reconnecting to ${url} (attempt ${attempt})...`);
      },
      onReconnected: (url: string) => {
        console.error(`[NostrService] Reconnected to ${url}`);
        this.subscribeToTokenTransfers();
      },
    });

    // Connect to the relay
    await this.client.connect(config.unicity.nostrRelayUrl);
    console.error(`Connected to Nostr relay: ${config.unicity.nostrRelayUrl}`);

    // Subscribe to incoming TOKEN_TRANSFER events addressed to us
    this.subscribeToTokenTransfers();

    this.isInitialized = true;
  }

  /**
   * Subscribe to TOKEN_TRANSFER events addressed to our public key
   */
  private subscribeToTokenTransfers(): void {
    if (!this.client || !this.identityService) {
      return;
    }

    const myPubkeyHex = this.identityService.getKeyManager().getPublicKeyHex();

    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(myPubkeyHex)
      .build();

    const listener: NostrEventListener = {
      onEvent: (event: Event) => {
        this.handleIncomingTransfer(event).catch((err) => {
          console.error("Error handling token transfer:", err);
        });
      },
      onEndOfStoredEvents: () => {
        // End of stored events - we're now receiving live events
      },
    };

    this.transferSubscriptionId = this.client.subscribe(filter, listener);
    console.error(`Subscribed to TOKEN_TRANSFER events for ${myPubkeyHex.substring(0, 16)}...`);
  }

  /**
   * Process and finalize a token transfer
   * Handles both PROXY and DIRECT address schemes
   */
  private async processTokenTransfer(payloadObj: Record<string, unknown>): Promise<boolean> {
    let sourceTokenInput = payloadObj["sourceToken"];
    let transferTxInput = payloadObj["transferTx"];

    // Handle double-encoded JSON (sometimes payload fields are JSON strings)
    if (typeof sourceTokenInput === "string") {
      try {
        sourceTokenInput = JSON.parse(sourceTokenInput);
      } catch {
        // Not JSON, keep as-is
      }
    }
    if (typeof transferTxInput === "string") {
      try {
        transferTxInput = JSON.parse(transferTxInput);
      } catch {
        // Not JSON, keep as-is
      }
    }

    if (!sourceTokenInput || !transferTxInput) {
      console.error("Token transfer payload missing sourceToken or transferTx");
      return false;
    }

    try {
      const sourceToken = await Token.fromJSON(sourceTokenInput);
      const transferTx = await TransferTransaction.fromJSON(transferTxInput);

      return await this.finalizeTransfer(sourceToken, transferTx);
    } catch (error) {
      console.error("Failed to parse token transfer:", error);
      return false;
    }
  }

  /**
   * Finalize a token transfer
   * PROXY addresses require full blockchain finalization
   * DIRECT addresses just need to be saved
   */
  private async finalizeTransfer(
    sourceToken: Token<IMintTransactionReason>,
    transferTx: TransferTransaction
  ): Promise<boolean> {
    if (!this.identityService) {
      console.error("IdentityService not available for finalization");
      return false;
    }

    const addressScheme = transferTx.data.recipient.scheme;

    try {
      if (addressScheme === AddressScheme.PROXY) {
        // PROXY requires full finalization with nametag token
        const nametagToken = this.identityService.getNametagToken();
        if (!nametagToken) {
          console.error("Cannot finalize PROXY transfer: nametag token not available");
          return false;
        }

        const signingService = this.identityService.getSigningService();

        // Create recipient predicate for the transfer
        const recipientPredicate = await UnmaskedPredicate.create(
          sourceToken.id,
          sourceToken.type,
          signingService,
          HashAlgorithm.SHA256,
          transferTx.data.salt
        );
        const recipientState = new TokenState(recipientPredicate, null);

        // Finalize the transaction on the blockchain
        const finalizedToken = await this.identityService.getStateTransitionClient()
          .finalizeTransaction(
            this.identityService.getRootTrustBase(),
            sourceToken,
            recipientState,
            transferTx,
            [nametagToken]
          );

        this.saveReceivedToken(finalizedToken);
        console.error("Token finalized successfully (PROXY)");
      } else {
        // DIRECT address - just save the token
        this.saveReceivedToken(sourceToken);
        console.error("Token saved successfully (DIRECT)");
      }

      return true;
    } catch (error) {
      console.error("Token finalization failed:", error);
      return false;
    }
  }

  /**
   * Save a received token to disk
   */
  private saveReceivedToken(token: Token<IMintTransactionReason>): void {
    if (!this.config) {
      console.error("Cannot save token: config not available");
      return;
    }

    const tokensDir = path.join(this.config.dataDir, "tokens");
    if (!fs.existsSync(tokensDir)) {
      fs.mkdirSync(tokensDir, { recursive: true });
    }

    const tokenIdHex = Buffer.from(token.id.bytes).toString("hex").slice(0, 16);
    const filename = `token-${tokenIdHex}-${Date.now()}.json`;

    fs.writeFileSync(
      path.join(tokensDir, filename),
      JSON.stringify({ token: token.toJSON(), receivedAt: Date.now() }, null, 2)
    );

    console.error(`Token saved to ${filename}`);
  }

  /**
   * Handle an incoming TOKEN_TRANSFER event
   * Matches it to pending payments, finalizes the token, and resolves the promise
   */
  private async handleIncomingTransfer(event: Event): Promise<void> {
    if (!TokenTransferProtocol.isTokenTransfer(event)) {
      return;
    }

    // Get the reply-to event ID (payment request correlation)
    const replyToEventId = TokenTransferProtocol.getReplyToEventId(event);
    const senderPubkey = TokenTransferProtocol.getSender(event);

    // Try to match by reply-to event ID first (most reliable)
    let pendingPayment: PendingPaymentInternal | undefined;

    if (replyToEventId) {
      pendingPayment = this.pendingPayments.get(replyToEventId);
    }

    // Fallback: match by sender pubkey
    if (!pendingPayment) {
      for (const [eventId, pending] of this.pendingPayments) {
        if (pending.customerPubkey === senderPubkey) {
          pendingPayment = pending;
          break;
        }
      }
    }

    if (!pendingPayment) {
      console.error(`Received token transfer from ${senderPubkey.substring(0, 16)}... with no matching pending payment`);
      return;
    }

    // Parse and validate the token transfer
    try {
      if (!this.identityService) {
        throw new Error("IdentityService not initialized");
      }

      // Decrypt and parse the token data
      const tokenJson = await TokenTransferProtocol.parseTokenTransfer(
        event,
        this.identityService.getKeyManager()
      );

      // Validate the token (basic check - actual validation would be more extensive)
      if (!tokenJson) {
        throw new Error("Empty token data");
      }

      // Parse and finalize the token
      const payloadObj = JSON.parse(tokenJson) as Record<string, unknown>;
      const finalizationSuccess = await this.processTokenTransfer(payloadObj);
      if (!finalizationSuccess) {
        console.error("Token finalization failed, but continuing with payment confirmation");
        // Note: We continue even if finalization fails to not block the payment flow
        // The token may still be recoverable, and the customer has already sent funds
      }

      // Check amount - reject if mismatch
      const transferAmount = TokenTransferProtocol.getAmount(event);
      if (transferAmount !== undefined && transferAmount !== pendingPayment.amountTokens) {
        const errorMessage = `Payment amount mismatch: received ${transferAmount} tokens but expected ${pendingPayment.amountTokens} tokens`;
        console.error(errorMessage);
        // Remove from pending and reject
        this.pendingPayments.delete(pendingPayment.eventId);
        pendingPayment.reject(new Error(errorMessage));
        return;
      }

      // Create confirmed payment record
      const confirmed: ConfirmedPayment = {
        cartId: pendingPayment.cartId,
        requestEventId: pendingPayment.eventId,
        transferEventId: event.id,
        confirmedAt: new Date(),
      };

      // Store confirmed payment
      this.confirmedPayments.set(pendingPayment.cartId, confirmed);

      // Remove from pending
      this.pendingPayments.delete(pendingPayment.eventId);

      // Resolve the promise
      pendingPayment.resolve(confirmed);

      console.error(`Payment confirmed for cart ${pendingPayment.cartId}`);
    } catch (error) {
      console.error("Failed to process token transfer:", error);
      // If this transfer was matched to a pending payment by eventId, reject it
      // Otherwise, might be a malformed transfer not meant for us
      if (replyToEventId && pendingPayment) {
        const errorMessage = error instanceof Error ? error.message : "Failed to process token transfer";
        this.pendingPayments.delete(pendingPayment.eventId);
        pendingPayment.reject(new Error(`Payment failed: ${errorMessage}`));
      }
    }
  }

  /**
   * Resolve a Unicity ID to a Nostr public key with retry logic
   * Handles timeouts and network issues with exponential backoff
   */
  private async resolvePubkeyWithRetry(
    unicityId: string,
    maxRetries: number = 3
  ): Promise<string | null> {
    if (!this.client) {
      throw new Error("NostrService not initialized");
    }

    const cleanId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      const pubkey = await this.client.queryPubkeyByNametag(cleanId);
      const elapsed = Date.now() - startTime;

      if (pubkey) {
        return pubkey;
      }

      const isTimeout = elapsed >= 14900;
      if (isTimeout) {
        console.error(
          `[NostrService] Pubkey resolution timed out for @${cleanId} (attempt ${attempt}/${maxRetries})`
        );
      }

      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.error(
          `[NostrService] Retrying pubkey resolution for @${cleanId} in ${delayMs}ms...`
        );
        await this.delay(delayMs);
      }
    }

    console.error(
      `[NostrService] Failed to resolve @${cleanId} after ${maxRetries} attempts`
    );
    return null;
  }

  /**
   * Send a payment request to a customer
   *
   * @param cartId Cart ID this payment is for
   * @param unicityId Customer's Unicity ID (nametag, without @)
   * @param amountTokens Amount in tokens (smallest unit)
   * @param message Optional message describing the payment
   * @returns Payment request result with event ID
   */
  async sendPaymentRequest(
    cartId: string,
    unicityId: string,
    amountTokens: bigint,
    message?: string
  ): Promise<PaymentRequestResult> {
    if (!this.client || !this.config || !this.identityService) {
      throw new Error("NostrService not initialized");
    }

    // Normalize unicityId (remove @ if present)
    const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

    // Resolve the unicityId to a Nostr pubkey with retry logic
    const customerPubkey = await this.resolvePubkeyWithRetry(normalizedId);
    if (!customerPubkey) {
      throw new Error(`Could not resolve Unicity ID @${normalizedId} to a public key`);
    }

    // Send the payment request
    const eventId = await this.client.sendPaymentRequest(customerPubkey, {
      amount: amountTokens,
      coinId: this.config.unicity.paymentCoinId,
      recipientNametag: this.config.unicity.nametag,
      message: message || `Payment for Runic Vault order`,
    });

    console.error(
      `Sent payment request to @${normalizedId} for ${amountTokens} tokens, eventId: ${eventId}`
    );

    return {
      eventId,
      amountTokens,
      recipientNametag: this.config.unicity.nametag,
      coinId: this.config.unicity.paymentCoinId,
      customerPubkey,
    };
  }

  /**
   * Wait for a payment to be confirmed
   *
   * @param cartId Cart ID to wait for
   * @param eventId Payment request event ID
   * @param unicityId Customer's Unicity ID
   * @param customerPubkey Customer's Nostr public key
   * @param amountTokens Expected amount
   * @param timeoutMs Timeout in milliseconds (default from config)
   * @returns Confirmed payment details
   */
  async waitForPayment(
    cartId: string,
    eventId: string,
    unicityId: string,
    customerPubkey: string,
    amountTokens: bigint,
    timeoutMs?: number
  ): Promise<ConfirmedPayment> {
    if (!this.config) {
      throw new Error("NostrService not initialized");
    }

    const timeout = timeoutMs ?? this.config.unicity.paymentTimeoutSeconds * 1000;

    // Check if already confirmed
    const existing = this.confirmedPayments.get(cartId);
    if (existing) {
      return existing;
    }

    // Create promise that resolves when payment is received
    return new Promise<ConfirmedPayment>((resolve, reject) => {
      // Normalize unicityId
      const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

      const pendingPayment: PendingPaymentInternal = {
        cartId,
        eventId,
        unicityId: normalizedId,
        customerPubkey,
        amountTokens,
        createdAt: new Date(),
        resolve,
        reject,
      };

      // Store the pending payment
      this.pendingPayments.set(eventId, pendingPayment);

      // Set timeout
      const timeoutId = setTimeout(() => {
        // Check if still pending
        if (this.pendingPayments.has(eventId)) {
          this.pendingPayments.delete(eventId);
          reject(
            new Error(
              `Payment timeout after ${timeout / 1000} seconds. Payment request eventId: ${eventId}`
            )
          );
        }
      }, timeout);

      // Wrap resolve to clear timeout
      const originalResolve = pendingPayment.resolve;
      pendingPayment.resolve = (payment: ConfirmedPayment) => {
        clearTimeout(timeoutId);
        originalResolve(payment);
      };
    });
  }

  /**
   * Get pending payment for a user by their Unicity ID
   */
  getPendingPaymentForUser(unicityId: string): PendingPayment | undefined {
    const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

    for (const pending of this.pendingPayments.values()) {
      if (pending.unicityId === normalizedId) {
        // Return without internal fields
        return {
          cartId: pending.cartId,
          eventId: pending.eventId,
          unicityId: pending.unicityId,
          customerPubkey: pending.customerPubkey,
          amountTokens: pending.amountTokens,
          createdAt: pending.createdAt,
        };
      }
    }

    return undefined;
  }

  /**
   * Get pending payment by cart ID
   */
  getPendingPaymentByCartId(cartId: string): PendingPayment | undefined {
    for (const pending of this.pendingPayments.values()) {
      if (pending.cartId === cartId) {
        return {
          cartId: pending.cartId,
          eventId: pending.eventId,
          unicityId: pending.unicityId,
          customerPubkey: pending.customerPubkey,
          amountTokens: pending.amountTokens,
          createdAt: pending.createdAt,
        };
      }
    }

    return undefined;
  }

  /**
   * Get pending payment by event ID
   */
  getPendingPaymentByEventId(eventId: string): PendingPayment | undefined {
    const pending = this.pendingPayments.get(eventId);
    if (!pending) {
      return undefined;
    }

    return {
      cartId: pending.cartId,
      eventId: pending.eventId,
      unicityId: pending.unicityId,
      customerPubkey: pending.customerPubkey,
      amountTokens: pending.amountTokens,
      createdAt: pending.createdAt,
    };
  }

  /**
   * Get confirmed payment for a cart
   */
  getConfirmedPayment(cartId: string): ConfirmedPayment | undefined {
    return this.confirmedPayments.get(cartId);
  }

  /**
   * Check if a cart has a confirmed payment
   */
  isPaymentConfirmed(cartId: string): boolean {
    return this.confirmedPayments.has(cartId);
  }

  /**
   * Resolve a Unicity ID to a Nostr public key
   */
  async resolveUnicityId(unicityId: string): Promise<string | null> {
    if (!this.client) {
      throw new Error("NostrService not initialized");
    }

    return this.resolvePubkeyWithRetry(unicityId);
  }

  /**
   * Check if the service is initialized and connected
   */
  isConnected(): boolean {
    return this.isInitialized && (this.client?.isConnected() ?? false);
  }

  /**
   * Shutdown the service and cleanup
   */
  shutdown(): void {
    if (this.client) {
      // Unsubscribe from TOKEN_TRANSFER events
      if (this.transferSubscriptionId) {
        this.client.unsubscribe(this.transferSubscriptionId);
        this.transferSubscriptionId = null;
      }

      // Reject all pending payments
      for (const pending of this.pendingPayments.values()) {
        pending.reject(new Error("NostrService shutting down"));
      }
      this.pendingPayments.clear();

      // Disconnect from relay
      this.client.disconnect();
      this.client = null;
    }

    this.identityService = null;
    this.config = null;
    this.isInitialized = false;

    console.error("NostrService shutdown complete");
  }
}

// Singleton instance
let nostrServiceInstance: NostrService | null = null;

/**
 * Get or create the NostrService singleton
 */
export function getNostrService(): NostrService {
  if (!nostrServiceInstance) {
    nostrServiceInstance = new NostrService();
  }
  return nostrServiceInstance;
}

/**
 * Initialize the NostrService singleton
 */
export async function initializeNostrService(
  config: Config,
  identityService: IdentityService
): Promise<NostrService> {
  const service = getNostrService();
  await service.initialize(config, identityService);
  return service;
}

/**
 * Shutdown the NostrService singleton
 */
export function shutdownNostrService(): void {
  if (nostrServiceInstance) {
    nostrServiceInstance.shutdown();
    nostrServiceInstance = null;
  }
}

/**
 * Set the NostrService instance (for testing/dependency injection)
 * Allows tests to inject mock implementations
 * @param service - The NostrService instance to use, or null to clear
 */
export function setNostrService(service: NostrService | null): void {
  nostrServiceInstance = service;
}

/**
 * Reset the NostrService singleton (for testing)
 * Shuts down any existing instance and clears the reference
 */
export function resetNostrService(): void {
  shutdownNostrService();
}
