import { describe, expect, it } from "vitest";
import { arcKeyBelongsToTeam } from "@/lib/graph/arcs";
import { staleArcCache } from "@/lib/graph/arc-cache";
import { reconcileAttribution } from "@/lib/ingest/reconcile-attribution";
import type { DbClient } from "@/lib/db/types";

/** Spec: the arc-cache eviction key match is slug-exact (no prefix collisions), and the propagation
 *  primitives are best-effort — they never throw on a DB failure (callers run them in after()). */

describe("arcKeyBelongsToTeam — slug-exact, no prefix collision", () => {
  it("matches the team's own group keys", () => {
    expect(arcKeyBelongsToTeam("acme_external,acme_team", "acme")).toBe(true);
    expect(arcKeyBelongsToTeam("acme_external", "acme")).toBe(true);
  });
  it("does NOT match a sibling team whose slug shares a prefix", () => {
    expect(arcKeyBelongsToTeam("acme-corp_team", "acme")).toBe(false); // '-' after acme, not '_'
    expect(arcKeyBelongsToTeam("acmex_team", "acme")).toBe(false);
    expect(arcKeyBelongsToTeam("other_team", "acme")).toBe(false);
  });
});

describe("propagation primitives are best-effort (never throw)", () => {
  // A db whose terminal awaits reject — proves the try/catch contracts.
  const rejectingDb = {
    from: () => ({
      update: () => ({ eq: () => Promise.reject(new Error("db down")) }),
      select: () => ({ eq: () => ({ neq: () => Promise.reject(new Error("db down")) }) }),
    }),
  } as unknown as DbClient;

  it("staleArcCache swallows a DB error", async () => {
    await expect(staleArcCache(rejectingDb, "t")).resolves.toBeUndefined();
  });
  it("reconcileAttribution swallows a failing re-attribution scan", async () => {
    await expect(reconcileAttribution(rejectingDb, "t", "acme")).resolves.toBeUndefined();
  });
});
