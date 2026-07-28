import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: both proxy routes rate-limit, and only AFTER authorizing.
 *
 * `proxy.ts` excludes all of `/api/*` from middleware and this app has a public domain, so these
 * routes are reachable from the internet with the shared secret as the only gate. Unbounded, one
 * leaked secret becomes unmetered spend on the team's provider account. Ordering matters too: rate
 * limiting before the auth check would let an anonymous flood consume the authorized budget and wedge
 * the graph — the exact failure this module exists to prevent.
 */
const ROUTES = [
  join("app", "api", "internal", "llm", "v1", "chat", "completions", "route.ts"),
  join("app", "api", "internal", "llm", "v1", "embeddings", "route.ts"),
];

describe("guard: the graph proxy routes are authorized then rate limited", () => {
  for (const rel of ROUTES) {
    it(`${rel} rate-limits after authorizing`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const auth = src.indexOf("authorizeGraphProxy");
      const limit = src.indexOf("graphProxyWithinRateLimit(db)");
      expect(auth, "must authorize").toBeGreaterThan(-1);
      expect(limit, "must rate limit").toBeGreaterThan(-1);
      expect(limit, "rate limit must come AFTER the auth check").toBeGreaterThan(auth);
    });
  }
});
