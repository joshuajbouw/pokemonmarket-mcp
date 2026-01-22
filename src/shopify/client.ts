/**
 * Shopify Storefront API GraphQL client
 */

import { config } from "../config.js";
import {
  ShopifyProduct,
  ShopifyVariant,
  ProductsQueryResponse,
  ProductByHandleQueryResponse,
  VariantByIdQueryResponse,
} from "./types.js";
import {
  SEARCH_PRODUCTS_QUERY,
  GET_ALL_PRODUCTS_QUERY,
  GET_PRODUCT_BY_HANDLE_QUERY,
  GET_VARIANT_BY_ID_QUERY,
} from "./queries.js";

/**
 * Shopify Storefront API endpoint
 */
function getApiUrl(): string {
  return `https://${config.shopify.storeDomain}/api/2025-01/graphql.json`;
}

/**
 * Delay helper for retry logic
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * Execute a GraphQL query against the Shopify Storefront API with retry logic
 */
async function executeQuery<T extends { data?: unknown; errors?: unknown[] }>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(getApiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": config.shopify.storefrontToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        if (
          RETRY_CONFIG.retryableStatuses.includes(response.status) &&
          attempt < RETRY_CONFIG.maxRetries
        ) {
          const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
          await delay(delayMs);
          continue;
        }
        throw new Error(
          `Shopify API request failed: ${response.status} ${response.statusText}`
        );
      }

      const result = (await response.json()) as T;

      if (!result.data) {
        throw new Error(
          "Shopify API returned invalid response: missing data property"
        );
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < RETRY_CONFIG.maxRetries) {
        const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        await delay(delayMs);
        continue;
      }
    }
  }

  throw lastError ?? new Error("Shopify API request failed after retries");
}

/**
 * Search products by query string
 * @param query - Search query string
 * @param limit - Maximum number of products to return (default: 10)
 * @returns Array of products matching the query
 */
export async function searchProducts(
  query: string,
  limit: number = 10
): Promise<ShopifyProduct[]> {
  const response = await executeQuery<ProductsQueryResponse>(
    SEARCH_PRODUCTS_QUERY,
    { query, first: limit }
  );

  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL error: ${response.errors.map((e) => e.message).join(", ")}`
    );
  }

  return response.data.products.edges.map((edge) => edge.node);
}

/**
 * Get all products with pagination
 * @param limit - Maximum number of products to return (default: 10)
 * @returns Array of all products up to limit
 */
export async function getAllProducts(
  limit: number = 10
): Promise<ShopifyProduct[]> {
  const response = await executeQuery<ProductsQueryResponse>(
    GET_ALL_PRODUCTS_QUERY,
    { first: limit }
  );

  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL error: ${response.errors.map((e) => e.message).join(", ")}`
    );
  }

  return response.data.products.edges.map((edge) => edge.node);
}

/**
 * Get a single product by its handle (URL slug)
 * @param handle - Product handle/slug
 * @returns Product if found, null otherwise
 */
export async function getProductByHandle(
  handle: string
): Promise<ShopifyProduct | null> {
  const response = await executeQuery<ProductByHandleQueryResponse>(
    GET_PRODUCT_BY_HANDLE_QUERY,
    { handle }
  );

  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL error: ${response.errors.map((e) => e.message).join(", ")}`
    );
  }

  return response.data.productByHandle;
}

/**
 * Type guard to check if a node is a ProductVariant with product
 */
function isProductVariantWithProduct(
  node: unknown
): node is ShopifyVariant & { product: ShopifyProduct } {
  if (!node || typeof node !== "object") {
    return false;
  }
  const obj = node as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id.includes("ProductVariant") &&
    typeof obj.product === "object" &&
    obj.product !== null
  );
}

/**
 * Get a variant by its ID with parent product information
 * @param variantId - Full GID format variant ID (e.g., "gid://shopify/ProductVariant/123")
 * @returns Variant with parent product if found, null otherwise
 */
export async function getVariantById(variantId: string): Promise<
  | (ShopifyVariant & {
      product: ShopifyProduct;
    })
  | null
> {
  const response = await executeQuery<VariantByIdQueryResponse>(
    GET_VARIANT_BY_ID_QUERY,
    { id: variantId }
  );

  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL error: ${response.errors.map((e) => e.message).join(", ")}`
    );
  }

  const node = response.data.node;

  if (!isProductVariantWithProduct(node)) {
    return null;
  }

  return node;
}

/**
 * Fetch a product image and convert to base64
 * @param imageUrl - URL of the image to fetch
 * @param width - Desired width (Shopify CDN supports resizing)
 * @returns Base64 encoded image data, or null if fetch fails
 */
export async function fetchProductImage(
  imageUrl: string,
  width: number = 400
): Promise<{ data: string; mimeType: string } | null> {
  try {
    // Shopify CDN supports width parameter for resizing
    const url = new URL(imageUrl);
    url.searchParams.set("width", String(width));

    const response = await fetch(url.toString());

    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return {
      data: base64,
      mimeType: contentType,
    };
  } catch (error) {
    console.error(`Error fetching image: ${error}`);
    return null;
  }
}

/**
 * Extract the first variant from a product
 */
export function getFirstVariant(product: ShopifyProduct): ShopifyVariant | null {
  if (product.variants.edges.length === 0) {
    return null;
  }
  return product.variants.edges[0].node;
}

/**
 * Extract all variants from a product
 */
export function getAllVariants(product: ShopifyProduct): ShopifyVariant[] {
  return product.variants.edges.map((edge) => edge.node);
}

/**
 * Format price for display
 */
export function formatPrice(amount: string, currencyCode: string): string {
  const num = parseFloat(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(num);
}
