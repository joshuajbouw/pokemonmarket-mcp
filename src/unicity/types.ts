/**
 * Unicity integration types
 */

import type { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import type { NostrKeyManager } from "@unicitylabs/nostr-js-sdk";

/**
 * Identity data persisted to disk
 */
export interface StoredIdentity {
  /** Private key as hex string */
  privateKeyHex: string;
  /** Public key as hex string */
  publicKeyHex: string;
  /** Nametag (e.g., "runic-vault") */
  nametag: string;
  /** Unicity wallet address */
  walletAddress: string;
  /** When identity was first created */
  createdAt: string;
}

/**
 * Runtime identity with initialized services
 */
export interface Identity {
  /** Signing service for blockchain operations */
  signingService: SigningService;
  /** Key manager for Nostr operations */
  keyManager: NostrKeyManager;
  /** Public key bytes */
  publicKey: Uint8Array;
  /** Private key as hex string (for token finalization) */
  privateKeyHex: string;
  /** Nametag identifier */
  nametag: string;
  /** Wallet address string */
  walletAddress: string;
}

/**
 * Nametag token stored on disk
 */
export interface StoredNametagToken {
  /** Nametag identifier */
  nametag: string;
  /** Serialized mint transaction as JSON */
  transaction: unknown;
  /** When the token was minted */
  mintedAt: string;
}

/**
 * Pending payment awaiting confirmation
 */
export interface PendingPayment {
  /** Cart ID this payment is for */
  cartId: string;
  /** Nostr event ID for the payment request */
  eventId: string;
  /** Customer's Unicity ID (nametag) */
  unicityId: string;
  /** Customer's Nostr public key */
  customerPubkey: string;
  /** Amount in tokens (smallest unit) */
  amountTokens: bigint;
  /** When the payment request was created */
  createdAt: Date;
}

/**
 * Confirmed payment details
 */
export interface ConfirmedPayment {
  /** Cart ID this payment is for */
  cartId: string;
  /** Nostr event ID for the payment request */
  requestEventId: string;
  /** Nostr event ID for the token transfer */
  transferEventId: string;
  /** When the payment was confirmed */
  confirmedAt: Date;
}

/**
 * Token type identifier for nametag tokens
 * This is a fixed value from the Unicity blockchain
 */
export const NAMETAG_TOKEN_TYPE_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
