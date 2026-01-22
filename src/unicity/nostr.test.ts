/**
 * Tests for NostrService - payment communication over Nostr
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../config.js";
import type { ConfirmedPayment, PendingPayment } from "./types.js";

// Mock external dependencies before imports
const mockFilterBuilder = {
  kinds: vi.fn().mockReturnThis(),
  pTags: vi.fn().mockReturnThis(),
  build: vi.fn().mockReturnValue({ kinds: [30078], pTags: ["mock-pubkey"] }),
};

vi.mock("@unicitylabs/nostr-js-sdk", () => ({
  NostrClient: vi.fn(),
  EventKinds: { TOKEN_TRANSFER: 30078 },
  Filter: { builder: vi.fn(() => mockFilterBuilder) },
  TokenTransferProtocol: {
    isTokenTransfer: vi.fn(),
    getReplyToEventId: vi.fn(),
    getSender: vi.fn(),
    parseTokenTransfer: vi.fn(),
    getAmount: vi.fn(),
  },
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/token/Token.js", () => ({
  Token: {
    fromJSON: vi.fn(),
  },
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js", () => ({
  TransferTransaction: {
    fromJSON: vi.fn(),
  },
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js", () => ({
  AddressScheme: {
    PROXY: 1,
    DIRECT: 0,
  },
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js", () => ({
  UnmaskedPredicate: {
    create: vi.fn(),
  },
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/token/TokenState.js", () => ({
  TokenState: vi.fn(),
}));

vi.mock("@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js", () => ({
  HashAlgorithm: {
    SHA256: "SHA256",
  },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Import after mocks are set up
import {
  NostrService,
  getNostrService,
  shutdownNostrService,
  type PaymentRequestResult,
} from "./nostr.js";
import { NostrClient, TokenTransferProtocol } from "@unicitylabs/nostr-js-sdk";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TransferTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js";
import { AddressScheme } from "@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import * as fs from "node:fs";

// ============================================================================
// Factory Functions
// ============================================================================

interface MockNostrClient {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  queryPubkeyByNametag: ReturnType<typeof vi.fn>;
  sendPaymentRequest: ReturnType<typeof vi.fn>;
  addConnectionListener: ReturnType<typeof vi.fn>;
}

function createMockNostrClient(): MockNostrClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    subscribe: vi.fn().mockReturnValue("sub-123"),
    unsubscribe: vi.fn(),
    queryPubkeyByNametag: vi.fn().mockResolvedValue("customer-pubkey-hex"),
    sendPaymentRequest: vi.fn().mockResolvedValue("evt-123"),
    addConnectionListener: vi.fn(),
  };
}

interface MockKeyManager {
  getPublicKeyHex: ReturnType<typeof vi.fn>;
}

interface MockSigningService {
  sign: ReturnType<typeof vi.fn>;
}

interface MockStateTransitionClient {
  finalizeTransaction: ReturnType<typeof vi.fn>;
}

interface MockRootTrustBase {
  id: string;
}

interface MockNametagToken {
  id: { bytes: Uint8Array };
  type: { bytes: Uint8Array };
  toJSON: ReturnType<typeof vi.fn>;
}

interface MockIdentityService {
  getKeyManager: ReturnType<typeof vi.fn>;
  getSigningService: ReturnType<typeof vi.fn>;
  getStateTransitionClient: ReturnType<typeof vi.fn>;
  getRootTrustBase: ReturnType<typeof vi.fn>;
  getNametagToken: ReturnType<typeof vi.fn>;
  keyManager: MockKeyManager;
  signingService: MockSigningService;
  stateTransitionClient: MockStateTransitionClient;
  rootTrustBase: MockRootTrustBase;
  nametagToken: MockNametagToken | null;
}

function createMockIdentityService(): MockIdentityService {
  const keyManager: MockKeyManager = {
    getPublicKeyHex: vi.fn().mockReturnValue("server-pubkey-hex-1234567890abcdef"),
  };

  const signingService: MockSigningService = {
    sign: vi.fn(),
  };

  const stateTransitionClient: MockStateTransitionClient = {
    finalizeTransaction: vi.fn().mockResolvedValue({ id: { bytes: new Uint8Array(16) }, toJSON: vi.fn() }),
  };

  const rootTrustBase: MockRootTrustBase = { id: "root-trust-base" };

  const nametagToken: MockNametagToken = {
    id: { bytes: new Uint8Array(16) },
    type: { bytes: new Uint8Array(32) },
    toJSON: vi.fn(),
  };

  return {
    getKeyManager: vi.fn().mockReturnValue(keyManager),
    getSigningService: vi.fn().mockReturnValue(signingService),
    getStateTransitionClient: vi.fn().mockReturnValue(stateTransitionClient),
    getRootTrustBase: vi.fn().mockReturnValue(rootTrustBase),
    getNametagToken: vi.fn().mockReturnValue(nametagToken),
    keyManager,
    signingService,
    stateTransitionClient,
    rootTrustBase,
    nametagToken,
  };
}

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    shopify: {
      storeDomain: "test-store.myshopify.com",
      storefrontToken: "test-storefront-token",
    },
    unicity: {
      nametag: "runic-vault",
      paymentCoinId: "test-coin-id-12345",
      nostrRelayUrl: "wss://test-relay.example.com",
      aggregatorUrl: "https://test-aggregator.example.com",
      paymentTimeoutSeconds: 5, // Short timeout for tests
    },
    dataDir: "./test-data",
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("NostrService", () => {
  let service: NostrService;
  let mockClient: MockNostrClient;
  let mockIdentityService: MockIdentityService;
  let testConfig: Config;
  let connectionListener: {
    onConnect?: (url: string) => void;
    onDisconnect?: (url: string, reason: string) => void;
    onReconnecting?: (url: string, attempt: number) => void;
    onReconnected?: (url: string) => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockClient = createMockNostrClient();
    mockIdentityService = createMockIdentityService();
    testConfig = createTestConfig();

    // Capture the connection listener when addConnectionListener is called
    mockClient.addConnectionListener.mockImplementation((listener) => {
      connectionListener = listener;
    });

    // Set up NostrClient mock to return our mock client
    vi.mocked(NostrClient).mockImplementation(() => mockClient as unknown as NostrClient);

    service = new NostrService();
  });

  afterEach(() => {
    vi.useRealTimers();
    shutdownNostrService();
  });

  // ==========================================================================
  // Group: initialize
  // ==========================================================================

  describe("initialize", () => {
    it("connects to relay and subscribes", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      expect(mockClient.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.connect).toHaveBeenCalledWith("wss://test-relay.example.com");
      expect(mockClient.subscribe).toHaveBeenCalledTimes(1);
    });

    it("idempotent (no-op on second call)", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      await service.initialize(testConfig, mockIdentityService as never);

      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it("registers connection listeners", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      expect(mockClient.addConnectionListener).toHaveBeenCalledTimes(1);
      expect(mockClient.addConnectionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          onConnect: expect.any(Function),
          onDisconnect: expect.any(Function),
          onReconnecting: expect.any(Function),
          onReconnected: expect.any(Function),
        })
      );
    });

    it("resubscribes on reconnect", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      expect(mockClient.subscribe).toHaveBeenCalledTimes(1);

      // Trigger reconnection
      connectionListener.onReconnected?.("wss://test-relay.example.com");

      expect(mockClient.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Group: resolveUnicityId / retry logic
  // ==========================================================================

  describe("resolveUnicityId", () => {
    beforeEach(async () => {
      await service.initialize(testConfig, mockIdentityService as never);
    });

    it("returns pubkey on first success", async () => {
      mockClient.queryPubkeyByNametag.mockResolvedValue("resolved-pubkey-abc123");

      const result = await service.resolveUnicityId("alice");

      expect(result).toBe("resolved-pubkey-abc123");
      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledWith("alice");
    });

    it("strips @ prefix", async () => {
      mockClient.queryPubkeyByNametag.mockResolvedValue("resolved-pubkey-xyz");

      await service.resolveUnicityId("@alice");

      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledWith("alice");
    });

    it("throws if not initialized", async () => {
      const uninitializedService = new NostrService();

      await expect(uninitializedService.resolveUnicityId("alice")).rejects.toThrow(
        "NostrService not initialized"
      );
    });

    it("retries with exponential backoff", async () => {
      mockClient.queryPubkeyByNametag
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("success-on-third");

      const resultPromise = service.resolveUnicityId("bob");

      // First attempt - immediate
      await vi.advanceTimersByTimeAsync(0);
      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledTimes(1);

      // Wait 1000ms for first retry (2^0 * 1000)
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledTimes(2);

      // Wait 2000ms for second retry (2^1 * 1000)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledTimes(3);

      const result = await resultPromise;
      expect(result).toBe("success-on-third");
    });

    it("returns null after max retries", async () => {
      mockClient.queryPubkeyByNametag.mockResolvedValue(null);

      const resultPromise = service.resolveUnicityId("nonexistent");

      // Advance through all retry delays
      await vi.advanceTimersByTimeAsync(1000); // First retry delay
      await vi.advanceTimersByTimeAsync(2000); // Second retry delay

      const result = await resultPromise;

      expect(result).toBeNull();
      expect(mockClient.queryPubkeyByNametag).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Group: sendPaymentRequest
  // ==========================================================================

  describe("sendPaymentRequest", () => {
    it("throws if not initialized", async () => {
      const uninitializedService = new NostrService();

      await expect(
        uninitializedService.sendPaymentRequest("cart-1", "alice", 1000n)
      ).rejects.toThrow("NostrService not initialized");
    });

    it("throws if ID cannot be resolved", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.queryPubkeyByNametag.mockResolvedValue(null);

      // Create promise and assertion in one go, advancing timers in parallel
      const resultPromise = service.sendPaymentRequest("cart-1", "@alice", 1000n);
      const assertionPromise = expect(resultPromise).rejects.toThrow(
        "Could not resolve Unicity ID @alice to a public key"
      );

      // First attempt happens immediately, then 1s delay before second
      await vi.advanceTimersByTimeAsync(1000);
      // Second attempt, then 2s delay before third
      await vi.advanceTimersByTimeAsync(2000);

      await assertionPromise;
    });

    it("returns exact PaymentRequestResult", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.queryPubkeyByNametag.mockResolvedValue("customer-pubkey-resolved");
      mockClient.sendPaymentRequest.mockResolvedValue("evt-payment-123");

      const result = await service.sendPaymentRequest("cart-xyz", "customer1", 5000n);

      expect(result).toEqual({
        eventId: "evt-payment-123",
        amountTokens: 5000n,
        recipientNametag: "runic-vault",
        coinId: "test-coin-id-12345",
        customerPubkey: "customer-pubkey-resolved",
      } satisfies PaymentRequestResult);
    });

    it("uses default message", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.queryPubkeyByNametag.mockResolvedValue("customer-pubkey");

      await service.sendPaymentRequest("cart-1", "customer", 1000n);

      expect(mockClient.sendPaymentRequest).toHaveBeenCalledWith(
        "customer-pubkey",
        expect.objectContaining({
          message: "Payment for Runic Vault order",
        })
      );
    });

    it("passes custom message", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.queryPubkeyByNametag.mockResolvedValue("customer-pubkey");

      await service.sendPaymentRequest("cart-1", "customer", 1000n, "Custom payment message");

      expect(mockClient.sendPaymentRequest).toHaveBeenCalledWith(
        "customer-pubkey",
        expect.objectContaining({
          message: "Custom payment message",
        })
      );
    });
  });

  // ==========================================================================
  // Group: waitForPayment
  // ==========================================================================

  describe("waitForPayment", () => {
    it("throws if not initialized", async () => {
      const uninitializedService = new NostrService();

      await expect(
        uninitializedService.waitForPayment("cart-1", "evt-1", "alice", "pubkey", 1000n)
      ).rejects.toThrow("NostrService not initialized");
    });

    it("returns immediately if already confirmed", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      // Manually set up a confirmed payment by going through the flow
      const confirmedPayment: ConfirmedPayment = {
        cartId: "cart-confirmed",
        requestEventId: "evt-confirmed",
        transferEventId: "transfer-evt-1",
        confirmedAt: new Date("2024-01-15T10:00:00Z"),
      };

      // Access private confirmedPayments map via any cast
      (service as unknown as { confirmedPayments: Map<string, ConfirmedPayment> }).confirmedPayments.set(
        "cart-confirmed",
        confirmedPayment
      );

      const result = await service.waitForPayment(
        "cart-confirmed",
        "evt-confirmed",
        "alice",
        "pubkey",
        1000n
      );

      expect(result).toEqual(confirmedPayment);
    });

    it("timeout with exact message", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      const resultPromise = service.waitForPayment(
        "cart-timeout",
        "evt-123",
        "alice",
        "pubkey",
        1000n,
        5000 // 5 second timeout
      );

      // Advance past timeout
      vi.advanceTimersByTime(5001);

      await expect(resultPromise).rejects.toThrow(
        "Payment timeout after 5 seconds. Payment request eventId: evt-123"
      );
    });

    it("uses config timeout by default", async () => {
      const configWith10sTimeout = createTestConfig({
        unicity: {
          ...testConfig.unicity,
          paymentTimeoutSeconds: 10,
        },
      });

      await service.initialize(configWith10sTimeout, mockIdentityService as never);

      const resultPromise = service.waitForPayment(
        "cart-default-timeout",
        "evt-456",
        "bob",
        "pubkey",
        2000n
      );

      // Advance to just before timeout (9999ms)
      vi.advanceTimersByTime(9999);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getPendingPaymentByEventId("evt-456")).toBeDefined();

      // Advance past timeout
      vi.advanceTimersByTime(2);

      await expect(resultPromise).rejects.toThrow(
        "Payment timeout after 10 seconds. Payment request eventId: evt-456"
      );
    });

    it("resolves when transfer received", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      // Set up mocks for incoming transfer
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("evt-wait-test");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("customer-pubkey-wait");
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({
          sourceToken: { id: "token-1" },
          transferTx: { data: { recipient: { scheme: AddressScheme.DIRECT } } },
        })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(3000n);

      vi.mocked(Token.fromJSON).mockResolvedValue({
        id: { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn(),
      } as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.DIRECT }, salt: new Uint8Array(16) },
      } as never);

      const resultPromise = service.waitForPayment(
        "cart-wait",
        "evt-wait-test",
        "alice",
        "customer-pubkey-wait",
        3000n
      );

      // Get the subscription listener from subscribe call
      const subscribeCall = mockClient.subscribe.mock.calls[0];
      const listener = subscribeCall[1] as { onEvent: (event: unknown) => void };

      // Simulate incoming transfer event
      const mockEvent = {
        id: "transfer-evt-received",
        kind: 30078,
        pubkey: "customer-pubkey-wait",
        content: "encrypted-content",
        tags: [],
        created_at: Date.now() / 1000,
        sig: "signature",
      };

      // Trigger the event handler
      await vi.advanceTimersByTimeAsync(0);
      listener.onEvent(mockEvent);
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;

      expect(result).toEqual({
        cartId: "cart-wait",
        requestEventId: "evt-wait-test",
        transferEventId: "transfer-evt-received",
        confirmedAt: expect.any(Date),
      });
    });
  });

  // ==========================================================================
  // Group: handleIncomingTransfer (via waitForPayment)
  // ==========================================================================

  describe("handleIncomingTransfer (via waitForPayment)", () => {
    beforeEach(async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      vi.mocked(Token.fromJSON).mockResolvedValue({
        id: { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn(),
      } as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.DIRECT }, salt: new Uint8Array(16) },
      } as never);
    });

    function getSubscriptionListener() {
      const subscribeCall = mockClient.subscribe.mock.calls[0];
      return subscribeCall[1] as { onEvent: (event: unknown) => void };
    }

    it("matches by reply-to eventId first", async () => {
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("evt-reply-match");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("different-pubkey");
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({ sourceToken: {}, transferTx: { data: { recipient: { scheme: 0 } } } })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(1000n);

      const resultPromise = service.waitForPayment(
        "cart-reply",
        "evt-reply-match",
        "alice",
        "alice-pubkey",
        1000n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-reply", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      expect(result.cartId).toBe("cart-reply");
    });

    it("falls back to sender pubkey", async () => {
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue(undefined as unknown as string);
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("sender-pubkey-fallback");
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({ sourceToken: {}, transferTx: { data: { recipient: { scheme: 0 } } } })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(2000n);

      const resultPromise = service.waitForPayment(
        "cart-fallback",
        "evt-fallback",
        "bob",
        "sender-pubkey-fallback",
        2000n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-fallback", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      expect(result.cartId).toBe("cart-fallback");
    });

    it("ignores unmatched transfers", async () => {
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("unknown-evt-id");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("unknown-sender");

      const resultPromise = service.waitForPayment(
        "cart-ignore",
        "evt-ignore",
        "charlie",
        "charlie-pubkey",
        500n,
        1000 // Short timeout
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-unknown", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      // Payment should still be pending (no match)
      expect(service.getPendingPaymentByEventId("evt-ignore")).toBeDefined();

      // Let it timeout
      vi.advanceTimersByTime(1001);
      await expect(resultPromise).rejects.toThrow("Payment timeout");
    });

    it("creates exact ConfirmedPayment", async () => {
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("evt-exact");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("exact-sender");
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({ sourceToken: {}, transferTx: { data: { recipient: { scheme: 0 } } } })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(7500n);

      const resultPromise = service.waitForPayment(
        "cart-exact",
        "evt-exact",
        "dave",
        "exact-sender",
        7500n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-evt-exact-123", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;

      expect(result.cartId).toBe("cart-exact");
      expect(result.requestEventId).toBe("evt-exact");
      expect(result.transferEventId).toBe("transfer-evt-exact-123");
      expect(result.confirmedAt).toBeInstanceOf(Date);
    });

    it("removes from pending after confirm", async () => {
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("evt-remove");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("remove-sender");
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({ sourceToken: {}, transferTx: { data: { recipient: { scheme: 0 } } } })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(1000n);

      const resultPromise = service.waitForPayment(
        "cart-remove",
        "evt-remove",
        "eve",
        "remove-sender",
        1000n
      );

      expect(service.getPendingPaymentByEventId("evt-remove")).toBeDefined();

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-remove", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;

      expect(service.getPendingPaymentByEventId("evt-remove")).toBeUndefined();
    });
  });

  // ==========================================================================
  // Group: token finalization
  // ==========================================================================

  describe("token finalization (via handleIncomingTransfer)", () => {
    beforeEach(async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(true);
      vi.mocked(TokenTransferProtocol.getReplyToEventId).mockReturnValue("evt-finalize");
      vi.mocked(TokenTransferProtocol.getSender).mockReturnValue("finalize-sender");
    });

    function getSubscriptionListener() {
      const subscribeCall = mockClient.subscribe.mock.calls[0];
      return subscribeCall[1] as { onEvent: (event: unknown) => void };
    }

    it("handles double-encoded JSON", async () => {
      const sourceTokenObj = { id: "token-double" };
      const transferTxObj = { data: { recipient: { scheme: AddressScheme.DIRECT }, salt: [] } };

      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({
          sourceToken: JSON.stringify(sourceTokenObj), // Double-encoded
          transferTx: JSON.stringify(transferTxObj), // Double-encoded
        })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(1000n);

      vi.mocked(Token.fromJSON).mockResolvedValue({
        id: { bytes: new Uint8Array(16) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn(),
      } as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.DIRECT }, salt: new Uint8Array(16) },
      } as never);

      const resultPromise = service.waitForPayment(
        "cart-double",
        "evt-finalize",
        "frank",
        "finalize-sender",
        1000n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-double", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      await resultPromise;

      // Token.fromJSON should have been called with the parsed object (not string)
      expect(Token.fromJSON).toHaveBeenCalledWith(sourceTokenObj);
      expect(TransferTransaction.fromJSON).toHaveBeenCalledWith(transferTxObj);
    });

    it("PROXY: calls finalizeTransaction", async () => {
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({
          sourceToken: { id: "proxy-token" },
          transferTx: { data: { recipient: { scheme: AddressScheme.PROXY }, salt: [] } },
        })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(1500n);

      const mockToken = {
        id: { bytes: new Uint8Array(16) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn(),
      };
      vi.mocked(Token.fromJSON).mockResolvedValue(mockToken as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.PROXY }, salt: new Uint8Array(16) },
      } as never);
      vi.mocked(UnmaskedPredicate.create).mockResolvedValue({ predicate: "mock" } as never);

      const resultPromise = service.waitForPayment(
        "cart-proxy",
        "evt-finalize",
        "grace",
        "finalize-sender",
        1500n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-proxy", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      await resultPromise;

      expect(mockIdentityService.stateTransitionClient.finalizeTransaction).toHaveBeenCalledWith(
        mockIdentityService.rootTrustBase,
        mockToken,
        expect.anything(), // TokenState
        expect.anything(), // TransferTransaction
        [mockIdentityService.nametagToken] // Nametag token array
      );
    });

    it("PROXY: fails if no nametag token", async () => {
      mockIdentityService.getNametagToken.mockReturnValue(null);

      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({
          sourceToken: { id: "proxy-no-nametag" },
          transferTx: { data: { recipient: { scheme: AddressScheme.PROXY }, salt: [] } },
        })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(2000n);

      vi.mocked(Token.fromJSON).mockResolvedValue({
        id: { bytes: new Uint8Array(16) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn(),
      } as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.PROXY }, salt: new Uint8Array(16) },
      } as never);

      const resultPromise = service.waitForPayment(
        "cart-proxy-fail",
        "evt-finalize",
        "hank",
        "finalize-sender",
        2000n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-proxy-fail", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      // Payment should still confirm even if finalization fails
      const result = await resultPromise;
      expect(result.cartId).toBe("cart-proxy-fail");

      // finalizeTransaction should NOT have been called
      expect(mockIdentityService.stateTransitionClient.finalizeTransaction).not.toHaveBeenCalled();
    });

    it("DIRECT: saves token without finalization", async () => {
      vi.mocked(TokenTransferProtocol.parseTokenTransfer).mockResolvedValue(
        JSON.stringify({
          sourceToken: { id: "direct-token" },
          transferTx: { data: { recipient: { scheme: AddressScheme.DIRECT }, salt: [] } },
        })
      );
      vi.mocked(TokenTransferProtocol.getAmount).mockReturnValue(3000n);

      const mockToken = {
        id: { bytes: new Uint8Array([0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0, 0, 0, 0, 0, 0, 0, 0]) },
        type: { bytes: new Uint8Array(32) },
        toJSON: vi.fn().mockReturnValue({ serialized: "token-data" }),
      };
      vi.mocked(Token.fromJSON).mockResolvedValue(mockToken as never);
      vi.mocked(TransferTransaction.fromJSON).mockResolvedValue({
        data: { recipient: { scheme: AddressScheme.DIRECT }, salt: new Uint8Array(16) },
      } as never);

      const resultPromise = service.waitForPayment(
        "cart-direct",
        "evt-finalize",
        "iris",
        "finalize-sender",
        3000n
      );

      const listener = getSubscriptionListener();
      listener.onEvent({ id: "transfer-direct", kind: 30078 });
      await vi.advanceTimersByTimeAsync(0);

      await resultPromise;

      // writeFileSync should have been called to save the token
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/test-data\/tokens\/token-abcdef123456789a-\d+\.json$/),
        expect.stringContaining('"serialized": "token-data"')
      );

      // finalizeTransaction should NOT have been called for DIRECT
      expect(mockIdentityService.stateTransitionClient.finalizeTransaction).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Group: query methods
  // ==========================================================================

  describe("query methods", () => {
    let pendingPromises: Promise<unknown>[];

    beforeEach(async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      pendingPromises = [];
    });

    afterEach(() => {
      // Ensure we catch any rejected promises from the test
      pendingPromises.forEach((p) => p.catch(() => {}));
    });

    it("getPendingPaymentForUser finds by unicityId", async () => {
      // Set up a pending payment via waitForPayment
      vi.mocked(TokenTransferProtocol.isTokenTransfer).mockReturnValue(false);

      const promise = service.waitForPayment("cart-user", "evt-user", "queriedUser", "query-pubkey", 500n, 10000);
      pendingPromises.push(promise);
      await vi.advanceTimersByTimeAsync(0);

      const result = service.getPendingPaymentForUser("queriedUser");

      expect(result).toEqual({
        cartId: "cart-user",
        eventId: "evt-user",
        unicityId: "queriedUser",
        customerPubkey: "query-pubkey",
        amountTokens: 500n,
        createdAt: expect.any(Date),
      } satisfies PendingPayment);

      // Should NOT have internal resolve/reject fields
      expect(result).not.toHaveProperty("resolve");
      expect(result).not.toHaveProperty("reject");
    });

    it("getPendingPaymentForUser strips @ prefix", async () => {
      const promise = service.waitForPayment("cart-at", "evt-at", "atUser", "at-pubkey", 100n, 10000);
      pendingPromises.push(promise);
      await vi.advanceTimersByTimeAsync(0);

      const result = service.getPendingPaymentForUser("@atUser");

      expect(result?.unicityId).toBe("atUser");
    });

    it("getPendingPaymentByCartId finds by cartId", async () => {
      const promise = service.waitForPayment("cart-by-id", "evt-by-id", "cartUser", "cart-pubkey", 750n, 10000);
      pendingPromises.push(promise);
      await vi.advanceTimersByTimeAsync(0);

      const result = service.getPendingPaymentByCartId("cart-by-id");

      expect(result).toEqual({
        cartId: "cart-by-id",
        eventId: "evt-by-id",
        unicityId: "cartUser",
        customerPubkey: "cart-pubkey",
        amountTokens: 750n,
        createdAt: expect.any(Date),
      });
    });

    it("getPendingPaymentByEventId finds by eventId", async () => {
      const promise = service.waitForPayment("cart-evt", "evt-direct", "evtUser", "evt-pubkey", 999n, 10000);
      pendingPromises.push(promise);
      await vi.advanceTimersByTimeAsync(0);

      const result = service.getPendingPaymentByEventId("evt-direct");

      expect(result).toEqual({
        cartId: "cart-evt",
        eventId: "evt-direct",
        unicityId: "evtUser",
        customerPubkey: "evt-pubkey",
        amountTokens: 999n,
        createdAt: expect.any(Date),
      });
    });

    it("getConfirmedPayment returns confirmed", async () => {
      const confirmedPayment: ConfirmedPayment = {
        cartId: "cart-get-confirmed",
        requestEventId: "evt-req",
        transferEventId: "evt-transfer",
        confirmedAt: new Date("2024-03-20T14:30:00Z"),
      };

      (service as unknown as { confirmedPayments: Map<string, ConfirmedPayment> }).confirmedPayments.set(
        "cart-get-confirmed",
        confirmedPayment
      );

      const result = service.getConfirmedPayment("cart-get-confirmed");

      expect(result).toEqual(confirmedPayment);
    });

    it("isPaymentConfirmed returns boolean", async () => {
      const confirmedPayment: ConfirmedPayment = {
        cartId: "cart-is-confirmed",
        requestEventId: "evt-is",
        transferEventId: "evt-is-transfer",
        confirmedAt: new Date(),
      };

      (service as unknown as { confirmedPayments: Map<string, ConfirmedPayment> }).confirmedPayments.set(
        "cart-is-confirmed",
        confirmedPayment
      );

      expect(service.isPaymentConfirmed("cart-is-confirmed")).toBe(true);
      expect(service.isPaymentConfirmed("cart-not-exists")).toBe(false);
    });
  });

  // ==========================================================================
  // Group: shutdown
  // ==========================================================================

  describe("shutdown", () => {
    it("unsubscribes from events", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      service.shutdown();

      expect(mockClient.unsubscribe).toHaveBeenCalledWith("sub-123");
    });

    it("rejects pending with exact error", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      const resultPromise = service.waitForPayment(
        "cart-shutdown",
        "evt-shutdown",
        "shutdownUser",
        "shutdown-pubkey",
        1000n
      );
      await vi.advanceTimersByTimeAsync(0);

      service.shutdown();

      await expect(resultPromise).rejects.toThrow("NostrService shutting down");
    });

    it("clears pending payments", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      const promise = service.waitForPayment("cart-clear", "evt-clear", "clearUser", "clear-pubkey", 100n, 10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(service.getPendingPaymentByEventId("evt-clear")).toBeDefined();

      service.shutdown();

      // Catch the rejection from shutdown
      await expect(promise).rejects.toThrow("NostrService shutting down");

      // Check that pending payments map is cleared
      const pendingMap = (service as unknown as { pendingPayments: Map<string, unknown> }).pendingPayments;
      expect(pendingMap.size).toBe(0);
    });

    it("disconnects from relay", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      service.shutdown();

      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("handles multiple shutdowns", async () => {
      await service.initialize(testConfig, mockIdentityService as never);

      service.shutdown();
      service.shutdown(); // Second call should not throw

      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Group: singleton functions
  // ==========================================================================

  describe("singleton functions", () => {
    it("getNostrService returns same instance", () => {
      const instance1 = getNostrService();
      const instance2 = getNostrService();

      expect(instance1).toBe(instance2);
    });

    it("shutdownNostrService clears instance", async () => {
      const instance1 = getNostrService();
      await instance1.initialize(testConfig, mockIdentityService as never);

      shutdownNostrService();

      const instance2 = getNostrService();

      expect(instance1).not.toBe(instance2);
    });
  });

  // ==========================================================================
  // Group: isConnected
  // ==========================================================================

  describe("isConnected", () => {
    it("returns false when not initialized", () => {
      expect(service.isConnected()).toBe(false);
    });

    it("returns true when initialized and client connected", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.isConnected.mockReturnValue(true);

      expect(service.isConnected()).toBe(true);
    });

    it("returns false when initialized but client disconnected", async () => {
      await service.initialize(testConfig, mockIdentityService as never);
      mockClient.isConnected.mockReturnValue(false);

      expect(service.isConnected()).toBe(false);
    });
  });
});
