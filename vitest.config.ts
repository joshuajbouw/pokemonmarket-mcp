import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10000,
    hookTimeout: 10000,
    // Enable type checking
    typecheck: {
      enabled: false, // Set to true to enable type checking during tests
    },
    // Coverage configuration (optional)
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "tests/",
        "**/*.test.ts",
        "vitest.config.ts",
      ],
    },
  },
  resolve: {
    alias: {
      // Handle .js extensions for ESM imports
    },
  },
});
