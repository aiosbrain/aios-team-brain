import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".claude/worktrees/**",
    "next-env.d.ts",
  ]),
  {
    // Allow deliberately-unused identifiers when prefixed with `_` (stub params,
    // placeholder destructures) — the conventional escape hatch.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Layering ratchet (both zones hold today — preventive, no current violations).
      // See docs/ARCHITECTURE.md "Module map". The `import` plugin is provided by eslint-config-next.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              // The backend domain layer must not depend on the app/UI layer: app/ → lib/, never the reverse.
              target: "./lib",
              from: "./app",
              message:
                "lib/ is the backend domain layer and must not import from app/ (dependency flows app -> lib, never the reverse).",
            },
            {
              // Don't reach past the backend factory into the pg client. Go through
              // lib/supabase/{server,admin} (which select pg vs supabase) or a lib/ domain service.
              target: "./app",
              from: "./lib/db/pg",
              message:
                "Do not import lib/db/pg internals from app/. Use the backend factory (lib/supabase/server|admin) or a lib/ domain service so the db backend stays swappable.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
