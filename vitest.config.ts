import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the brain's pure logic. Node env, no DB. The `@` alias mirrors
// tsconfig's "@/*"; `server-only` is stubbed so server modules import under test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Data-mechanics tests need a real DB; they run via vitest.datamechanics.config.ts.
    exclude: ["node_modules/**", "ingestion/**", ".next/**", ".claude/worktrees/**", "test/datamechanics/**"],
    // `npm run coverage` writes coverage/coverage-summary.json — the codebase scanner
    // reads total.lines.pct from it. Scoped to lib/** (the unit-tested core) for a
    // representative number rather than diluting with untested UI.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      include: ["lib/**"],
      // Merge gate: floor ≈ (baseline − 2pts) off the lib/** baseline
      // (lines 28.18 / functions 31.92 / branches 25.12). vitest exits non-zero
      // below these, so `npm run coverage` in CI blocks regressions. Ratchet up as
      // lib/** test coverage improves — never lower to make a red build pass.
      thresholds: {
        lines: 26,
        functions: 29,
        branches: 23,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/empty.ts", import.meta.url)),
    },
  },
});
