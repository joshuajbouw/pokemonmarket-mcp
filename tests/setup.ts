/**
 * Test setup file
 *
 * Sets environment variables needed for tests before any modules are loaded.
 */

// Set required environment variables for testing
process.env.SHOPIFY_STORE_DOMAIN = "test-store.myshopify.com";
process.env.SHOPIFY_STOREFRONT_TOKEN = "test-storefront-token";
process.env.MCP_NAMETAG = "test-nametag";
process.env.PAYMENT_COIN_ID = "test-coin-id";
process.env.DATA_DIR = "./test-data";
