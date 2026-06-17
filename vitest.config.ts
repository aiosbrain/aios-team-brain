import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the brain's pure logic. Node env, no DB. The `@` alias mirrors
// tsconfig's "@/*"; `server-only` is stubbed so server modules import under test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Data-mechanics tests need a real DB; they run via vitest.datamechanics.config.ts.
    exclude: ["node_modules/**", "ingestion/**", ".next/**", "test/datamechanics/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/empty.ts", import.meta.url)),
    },
  },
});
