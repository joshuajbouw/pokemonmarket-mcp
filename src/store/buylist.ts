/**
 * In-memory buy list store for Runic Vault MCP Server
 * Handles customer requests to sell cards to the shop
 */

import { randomUUID } from "crypto";
import type { BuylistRequest, BuylistRequestStatus } from "../types.js";

/**
 * In-memory storage for buy list requests
 */
const buylistRequests: Map<string, BuylistRequest> = new Map();

/**
 * Parameters for creating a new buy list request
 */
export interface CreateBuylistRequestParams {
  variantId: string;
  productHandle: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  offerPriceCents: number;
  retailPriceCents: number;
  currency: string;
  sellerUnicityId: string;
}

/**
 * Create a new buy list request
 * @param params - Request parameters
 * @returns The newly created buy list request
 */
export function createBuylistRequest(params: CreateBuylistRequestParams): BuylistRequest {
  const id = randomUUID();
  const now = new Date();

  const request: BuylistRequest = {
    id,
    variantId: params.variantId,
    productHandle: params.productHandle,
    productTitle: params.productTitle,
    variantTitle: params.variantTitle,
    quantity: params.quantity,
    offerPriceCents: params.offerPriceCents,
    retailPriceCents: params.retailPriceCents,
    currency: params.currency,
    sellerUnicityId: params.sellerUnicityId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  buylistRequests.set(id, request);
  return request;
}

/**
 * Retrieve a buy list request by ID
 * @param requestId - The request's unique identifier
 * @returns The request if found, null otherwise
 */
export function getBuylistRequest(requestId: string): BuylistRequest | null {
  return buylistRequests.get(requestId) ?? null;
}

/**
 * Update the status of a buy list request
 * @param requestId - The request's unique identifier
 * @param status - The new status
 * @returns The updated request if found, null otherwise
 */
export function updateBuylistRequestStatus(
  requestId: string,
  status: BuylistRequestStatus
): BuylistRequest | null {
  const request = buylistRequests.get(requestId);
  if (!request) {
    return null;
  }

  request.status = status;
  request.updatedAt = new Date();
  return request;
}

/**
 * Get all buy list requests for a specific seller
 * @param sellerUnicityId - The seller's Unicity ID
 * @returns Array of requests from this seller
 */
export function getRequestsBySeller(sellerUnicityId: string): BuylistRequest[] {
  return Array.from(buylistRequests.values()).filter(
    (request) => request.sellerUnicityId === sellerUnicityId
  );
}

/**
 * Get all buy list requests (useful for debugging/testing)
 * @returns Array of all buy list requests
 */
export function getAllBuylistRequests(): BuylistRequest[] {
  return Array.from(buylistRequests.values());
}

/**
 * Delete a buy list request
 * @param requestId - The request's unique identifier
 * @returns true if deleted, false if not found
 */
export function deleteBuylistRequest(requestId: string): boolean {
  return buylistRequests.delete(requestId);
}

/**
 * Clear all buy list requests from the store (useful for testing)
 */
export function clearAllBuylistRequests(): void {
  buylistRequests.clear();
}

/**
 * Get the number of buy list requests currently in the store
 * @returns Number of requests
 */
export function getBuylistRequestCount(): number {
  return buylistRequests.size;
}
