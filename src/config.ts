/**
 * Environment configuration loading and validation
 */

import { z } from "zod";

const configSchema = z.object({
  // Shopify (required)
  shopify: z.object({
    storeDomain: z.string().min(1, "SHOPIFY_STORE_DOMAIN is required"),
    storefrontToken: z.string().min(1, "SHOPIFY_STOREFRONT_TOKEN is required"),
  }),

  // Unicity (required)
  unicity: z.object({
    nametag: z.string().min(1, "MCP_NAMETAG is required"),
    paymentCoinId: z.string().min(1, "PAYMENT_COIN_ID is required"),
    privateKeyHex: z.string().optional(),
    nostrRelayUrl: z.string().url().default("wss://nostr-relay.testnet.unicity.network"),
    aggregatorUrl: z.string().url().default("https://goggregator-test.unicity.network"),
    aggregatorApiKey: z.string().optional(),
    paymentTimeoutSeconds: z.number().int().positive().default(120),
  }),

  // Data directory
  dataDir: z.string().default("./data"),

  // Server transport
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpPort: z.number().int().positive().default(3000),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const rawConfig = {
    shopify: {
      storeDomain: process.env.SHOPIFY_STORE_DOMAIN ?? "",
      storefrontToken: process.env.SHOPIFY_STOREFRONT_TOKEN ?? "",
    },
    unicity: {
      nametag: process.env.MCP_NAMETAG ?? "",
      paymentCoinId: process.env.PAYMENT_COIN_ID ?? "",
      privateKeyHex: process.env.MCP_PRIVATE_KEY_HEX || undefined,
      nostrRelayUrl: process.env.NOSTR_RELAY_URL,
      aggregatorUrl: process.env.AGGREGATOR_URL,
      aggregatorApiKey: process.env.AGGREGATOR_API_KEY || undefined,
      paymentTimeoutSeconds: process.env.PAYMENT_TIMEOUT_SECONDS
        ? parseInt(process.env.PAYMENT_TIMEOUT_SECONDS, 10)
        : undefined,
    },
    dataDir: process.env.DATA_DIR,
    transport: process.env.MCP_TRANSPORT,
    httpPort: process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined,
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}

let _config: Config | null = null;

/**
 * Get configuration (lazy loaded on first access)
 */
export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Configuration object (lazy loaded)
 * Use this for convenient access throughout the application
 */
export const config: Config = new Proxy({} as Config, {
  get(_target, prop: keyof Config) {
    return getConfig()[prop];
  },
});

/**
 * Reset config cache (useful for testing)
 */
export function resetConfig(): void {
  _config = null;
}
