/**
 * Shopify module exports
 */

// Types
export type {
  ShopifyMoney,
  ShopifyImage,
  ShopifyVariant,
  ShopifyProduct,
  ShopifyProductOption,
  ShopifyEdge,
  ShopifyConnection,
  ProductsQueryResponse,
  ProductByHandleQueryResponse,
  VariantByIdQueryResponse,
  GraphQLErrorResponse,
} from "./types.js";

// Client functions
export {
  searchProducts,
  getAllProducts,
  getProductByHandle,
  getVariantById,
  fetchProductImage,
  getFirstVariant,
  getAllVariants,
  formatPrice,
} from "./client.js";

// Queries (for testing/debugging)
export {
  SEARCH_PRODUCTS_QUERY,
  GET_ALL_PRODUCTS_QUERY,
  GET_PRODUCT_BY_HANDLE_QUERY,
  GET_VARIANT_BY_ID_QUERY,
} from "./queries.js";
