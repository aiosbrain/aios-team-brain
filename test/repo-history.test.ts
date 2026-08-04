import { describe, expect, it } from "vitest";
import { resolveRepoHistory } from "@/lib/integrations/github-link";
import { validateIntegrationConfig } from "@/lib/api/schemas";

/**
 * The per-repo history window's storage semantics (AIO-798). Two contracts carry the whole design:
 *
 * 1. THE ANCHOR IS READ BACK VERBATIM. `sinceIso` is resolved once at link; if the importer ever
 *    recomputed `now − days`, the window would SLIDE — and because a repo's issues are one
 *    diff-synced item, issues aging out of a sliding fetch are diff-DELETED from the brain, tick
 *    after tick (the plan-review blocker on this design's first draft).
 * 2. ABSENT MEANS ABSENT. A repo with no entry imports exactly as before this feature existed —
 *    `.optional()` at the schema, null from the resolver, and the importer's optional-chaining
 *    passes `undefined` through to today's defaults.
 */

describe("resolveRepoHistory", () => {
  const entry = { repo: "Acme/Widgets", days: 14, sinceIso: "2026-08-04T01:02:03.000Z" };

  it("returns the stored anchor VERBATIM — never recomputed", () => {
    const hit = resolveRepoHistory({ repoHistory: [entry] }, "acme/widgets");
    expect(hit?.sinceIso).toBe("2026-08-04T01:02:03.000Z");
    expect(hit?.days).toBe(14);
  });

  it("matches case-insensitively, like every other repo comparison in this panel", () => {
    expect(resolveRepoHistory({ repoHistory: [entry] }, "ACME/WIDGETS")).not.toBeNull();
  });

  it("no entry → null → the pre-window behaviour (the existing-behaviour pin)", () => {
    expect(resolveRepoHistory({}, "acme/widgets")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: [] }, "acme/widgets")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: [entry] }, "other/repo")).toBeNull();
  });

  it("malformed entries are ignored, not thrown on — config is external data", () => {
    expect(resolveRepoHistory({ repoHistory: [{ repo: "a/b" }] }, "a/b")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: "nonsense" }, "a/b")).toBeNull();
  });
});

describe("github config schema — repoHistory (AIO-798)", () => {
  it("accepts the anchored array shape", () => {
    const out = validateIntegrationConfig("github", {
      repos: ["acme/widgets"],
      repoHistory: [{ repo: "acme/widgets", days: 14, sinceIso: "2026-08-04T01:02:03.000Z" }],
    }) as { repoHistory?: unknown[] };
    expect(out.repoHistory).toHaveLength(1);
  });

  it("an absent repoHistory stays ABSENT — legacy rows must remain byte-identical", () => {
    // `.optional()`, never `.default([])`: this is also the existing normalization pin.
    expect(validateIntegrationConfig("github", {})).toEqual({ repos: [] });
  });

  it("a repo whose NAME looks like a secret survives the secret-key scan (array shape, not Record keys)", () => {
    // The Record<full_name, days> shape died here: the scan walks nested object KEYS, so
    // `acme/token-service` in key position made the whole config unsavable (plan-review blocker).
    const out = validateIntegrationConfig("github", {
      repos: ["acme/token-service"],
      repoHistory: [{ repo: "acme/token-service", days: 30, sinceIso: "2026-08-04T00:00:00.000Z" }],
    }) as { repoHistory?: unknown[] };
    expect(out.repoHistory).toHaveLength(1);
  });

  it("rejects a malformed anchor and unknown entry keys", () => {
    expect(() =>
      validateIntegrationConfig("github", {
        repoHistory: [{ repo: "a/b", days: 14, sinceIso: "not-a-date" }],
      })
    ).toThrow();
    expect(() =>
      validateIntegrationConfig("github", {
        repoHistory: [{ repo: "a/b", days: 14, sinceIso: "2026-08-04T00:00:00.000Z", extra: 1 }],
      })
    ).toThrow();
  });
});
