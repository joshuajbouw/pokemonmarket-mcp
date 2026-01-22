/**
 * Shopify Storefront API response types
 */

/**
 * Money type from Shopify
 */
export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

/**
 * Image type from Shopify
 */
export interface ShopifyImage {
  url: string;
  altText: string | null;
  width: number;
  height: number;
}

/**
 * Product variant from Shopify
 */
export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  availableForSale: boolean;
  quantityAvailable: number | null;
  price: ShopifyMoney;
  compareAtPrice: ShopifyMoney | null;
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
  image: ShopifyImage | null;
}

/**
 * Product from Shopify
 */
/**
 * Product option (e.g., Size, Color)
 */
export interface ShopifyProductOption {
  name: string;
  values: string[];
}

/**
 * Product from Shopify
 */
export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  availableForSale: boolean;
  featuredImage: ShopifyImage | null;
  images: {
    edges: Array<{
      node: ShopifyImage;
    }>;
  };
  variants: {
    edges: Array<{
      node: ShopifyVariant;
    }>;
  };
  options: ShopifyProductOption[];
  priceRange: {
    minVariantPrice: ShopifyMoney;
    maxVariantPrice: ShopifyMoney;
  };
}

/**
 * GraphQL connection edge
 */
export interface ShopifyEdge<T> {
  node: T;
  cursor: string;
}

/**
 * GraphQL connection
 */
export interface ShopifyConnection<T> {
  edges: Array<ShopifyEdge<T>>;
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

/**
 * Products query response
 */
export interface ProductsQueryResponse {
  data: {
    products: ShopifyConnection<ShopifyProduct>;
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

/**
 * Product by handle query response
 */
export interface ProductByHandleQueryResponse {
  data: {
    productByHandle: ShopifyProduct | null;
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

/**
 * Variant by ID query response (via node query)
 */
export interface VariantByIdQueryResponse {
  data: {
    node: (ShopifyVariant & {
      product: ShopifyProduct;
    }) | null;
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

/**
 * Generic GraphQL error response
 */
export interface GraphQLErrorResponse {
  errors: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}
