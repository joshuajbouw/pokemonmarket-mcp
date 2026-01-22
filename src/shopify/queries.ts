/**
 * GraphQL query strings for Shopify Storefront API
 */

/**
 * Fragment for product image fields
 */
const IMAGE_FRAGMENT = `
  url
  altText
  width
  height
`;

/**
 * Fragment for money fields
 */
const MONEY_FRAGMENT = `
  amount
  currencyCode
`;

/**
 * Fragment for variant fields
 */
const VARIANT_FRAGMENT = `
  id
  title
  sku
  availableForSale
  quantityAvailable
  price {
    ${MONEY_FRAGMENT}
  }
  compareAtPrice {
    ${MONEY_FRAGMENT}
  }
  selectedOptions {
    name
    value
  }
  image {
    ${IMAGE_FRAGMENT}
  }
`;

/**
 * Fragment for product fields
 */
const PRODUCT_FRAGMENT = `
  id
  title
  handle
  description
  descriptionHtml
  vendor
  productType
  tags
  availableForSale
  featuredImage {
    ${IMAGE_FRAGMENT}
  }
  images(first: 10) {
    edges {
      node {
        ${IMAGE_FRAGMENT}
      }
    }
  }
  variants(first: 100) {
    edges {
      node {
        ${VARIANT_FRAGMENT}
      }
    }
  }
  options {
    name
    values
  }
  priceRange {
    minVariantPrice {
      ${MONEY_FRAGMENT}
    }
    maxVariantPrice {
      ${MONEY_FRAGMENT}
    }
  }
`;

/**
 * Search products by query string
 */
export const SEARCH_PRODUCTS_QUERY = `
  query SearchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          ${PRODUCT_FRAGMENT}
        }
        cursor
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

/**
 * Get all products (paginated)
 */
export const GET_ALL_PRODUCTS_QUERY = `
  query GetAllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          ${PRODUCT_FRAGMENT}
        }
        cursor
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

/**
 * Get single product by handle
 */
export const GET_PRODUCT_BY_HANDLE_QUERY = `
  query GetProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      ${PRODUCT_FRAGMENT}
    }
  }
`;

/**
 * Get variant by ID with parent product info
 */
export const GET_VARIANT_BY_ID_QUERY = `
  query GetVariantById($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        ${VARIANT_FRAGMENT}
        product {
          ${PRODUCT_FRAGMENT}
        }
      }
    }
  }
`;
