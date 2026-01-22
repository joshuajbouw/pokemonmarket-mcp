/**
 * Mock Nostr service for testing
 *
 * Provides mock implementations of NostrService methods
 * with deterministic, exact responses based on fixtures.
 */

import { vi } from "vitest";
import type { PendingPayment, ConfirmedPayment } from "../../src/unicity/types.js";
import type { PaymentRequestResult } from "../../src/unicity/nostr.js";
import unicityEventsFixture from "../fixtures/unicity-events.json";

/**
 * In-memory storage for mock pending payments
 */
const mockPendingPayments: Map<string, PendingPayment> = new Map();

/**
 * In-memory storage for mock confirmed payments
 */
const mockConfirmedPayments: Map<string, ConfirmedPayment> = new Map();

/**
 * Event ID counter for generating unique event IDs
 */
let eventIdCounter = 0;

/**
 * Generate a unique mock event ID
 */
function generateEventId(): string {
  eventIdCounter++;
  return `mock-event-${eventIdCounter.toString().padStart(6, "0")}`;
}

/**
 * Mock sendPaymentRequest function
 */
export const mockSendPaymentRequest = vi.fn(
  async (
    cartId: string,
    unicityId: string,
    amountTokens: bigint,
    _message?: string
  ): Promise<PaymentRequestResult> => {
    const eventId = generateEventId();
    const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

    // Simulate resolving the Unicity ID to a pubkey
    const customerPubkey =
      normalizedId === "test-customer"
        ? unicityEventsFixture.testPubkeys.customer
        : `pubkey-for-${normalizedId}`;

    return {
      eventId,
      amountTokens,
      recipientNametag: "runic-vault",
      coinId: "test-coin-id",
      customerPubkey,
    };
  }
);

/**
 * Mock waitForPayment function
 * By default, resolves successfully after a short delay
 */
export const mockWaitForPayment = vi.fn(
  async (
    cartId: string,
    eventId: string,
    _unicityId: string,
    _customerPubkey: string,
    _amountTokens: bigint,
    _timeoutMs?: number
  ): Promise<ConfirmedPayment> => {
    const confirmed: ConfirmedPayment = {
      cartId,
      requestEventId: eventId,
      transferEventId: `transfer-${eventId}`,
      confirmedAt: new Date(),
    };

    mockConfirmedPayments.set(cartId, confirmed);
    return confirmed;
  }
);

/**
 * Mock waitForPayment that times out
 */
export const mockWaitForPaymentTimeout = vi.fn(
  async (
    _cartId: string,
    eventId: string,
    _unicityId: string,
    _customerPubkey: string,
    _amountTokens: bigint,
    timeoutMs?: number
  ): Promise<never> => {
    const timeout = timeoutMs ?? 120000;
    throw new Error(
      `Payment timeout after ${timeout / 1000} seconds. Payment request eventId: ${eventId}`
    );
  }
);

/**
 * Mock getPendingPaymentForUser function
 */
export const mockGetPendingPaymentForUser = vi.fn(
  (unicityId: string): PendingPayment | undefined => {
    const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;
    for (const pending of mockPendingPayments.values()) {
      if (pending.unicityId === normalizedId) {
        return pending;
      }
    }
    return undefined;
  }
);

/**
 * Mock getPendingPaymentByCartId function
 */
export const mockGetPendingPaymentByCartId = vi.fn(
  (cartId: string): PendingPayment | undefined => {
    for (const pending of mockPendingPayments.values()) {
      if (pending.cartId === cartId) {
        return pending;
      }
    }
    return undefined;
  }
);

/**
 * Mock getPendingPaymentByEventId function
 */
export const mockGetPendingPaymentByEventId = vi.fn(
  (eventId: string): PendingPayment | undefined => {
    return mockPendingPayments.get(eventId);
  }
);

/**
 * Mock getConfirmedPayment function
 */
export const mockGetConfirmedPayment = vi.fn(
  (cartId: string): ConfirmedPayment | undefined => {
    return mockConfirmedPayments.get(cartId);
  }
);

/**
 * Mock isPaymentConfirmed function
 */
export const mockIsPaymentConfirmed = vi.fn((cartId: string): boolean => {
  return mockConfirmedPayments.has(cartId);
});

/**
 * Mock resolveUnicityId function
 */
export const mockResolveUnicityId = vi.fn(
  async (unicityId: string): Promise<string | null> => {
    const normalizedId = unicityId.startsWith("@") ? unicityId.slice(1) : unicityId;

    // Return null for "nonexistent" user
    if (normalizedId === "nonexistent-user") {
      return null;
    }

    // Return the test pubkey for test-customer
    if (normalizedId === "test-customer") {
      return unicityEventsFixture.testPubkeys.customer;
    }

    // Return a generated pubkey for any other user
    return `pubkey-for-${normalizedId}`;
  }
);

/**
 * Mock isConnected function
 */
export const mockIsConnected = vi.fn((): boolean => true);

/**
 * Add a pending payment to the mock storage
 */
export function addMockPendingPayment(payment: PendingPayment): void {
  mockPendingPayments.set(payment.eventId, payment);
}

/**
 * Add a confirmed payment to the mock storage
 */
export function addMockConfirmedPayment(payment: ConfirmedPayment): void {
  mockConfirmedPayments.set(payment.cartId, payment);
}

/**
 * Clear all mock storage
 */
export function clearMockStorage(): void {
  mockPendingPayments.clear();
  mockConfirmedPayments.clear();
}

/**
 * Reset all mocks and storage
 */
export function resetAllMocks(): void {
  mockSendPaymentRequest.mockClear();
  mockWaitForPayment.mockClear();
  mockWaitForPaymentTimeout.mockClear();
  mockGetPendingPaymentForUser.mockClear();
  mockGetPendingPaymentByCartId.mockClear();
  mockGetPendingPaymentByEventId.mockClear();
  mockGetConfirmedPayment.mockClear();
  mockIsPaymentConfirmed.mockClear();
  mockResolveUnicityId.mockClear();
  mockIsConnected.mockClear();
  clearMockStorage();
  eventIdCounter = 0;
}

/**
 * Create a mock NostrService instance
 */
export function createMockNostrService() {
  return {
    initialize: vi.fn(async () => {}),
    sendPaymentRequest: mockSendPaymentRequest,
    waitForPayment: mockWaitForPayment,
    getPendingPaymentForUser: mockGetPendingPaymentForUser,
    getPendingPaymentByCartId: mockGetPendingPaymentByCartId,
    getPendingPaymentByEventId: mockGetPendingPaymentByEventId,
    getConfirmedPayment: mockGetConfirmedPayment,
    isPaymentConfirmed: mockIsPaymentConfirmed,
    resolveUnicityId: mockResolveUnicityId,
    isConnected: mockIsConnected,
    shutdown: vi.fn(),
  };
}

/**
 * Get the test Unicity IDs from fixtures
 */
export function getTestUnicityIds() {
  return unicityEventsFixture.testUnicityIds;
}

/**
 * Get the test pubkeys from fixtures
 */
export function getTestPubkeys() {
  return unicityEventsFixture.testPubkeys;
}
