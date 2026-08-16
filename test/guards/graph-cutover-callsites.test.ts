import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PCCC-6 call-site guard (the pin-the-call-site class this repo's review lore names — module-level
 * dm tests prove the machinery; nothing else proves the surfaces actually CALL it). Each entry is a
 * load-bearing wiring whose deletion left every dm test green in review (Fable 6a Medium 9).
 */
const ROOT = join(import.meta.dirname, "..", "..");
const REQUIRED: { file: string; needle: string; why: string }[] = [
  {
    file: join("app", "api", "v1", "query", "route.ts"),
    needle: "graphProjectIds: projectIds",
    why: "the API query route must hand team members their partition set",
  },
  {
    file: join("app", "api", "dashboard", "query", "route.ts"),
    needle: "graphProjectIds: projectIds",
    why: "the dashboard chat is the members' primary surface — an unwired split here shipped once in review",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "selectEnforcedGraphPartitions(db, { teamId, visibleProjectIds: enforce.graphProjectIds })",
    why: "the enforced graph leg must resolve partitions, not recompute or omit",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "arm: false, k: Number.MAX_SAFE_INTEGER",
    why: "the permissive union is UNCAPPED and never arms — §2.2's coverage-equivalence co-land",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "graph expansion covered",
    why: "the covered/total disclosure (the spec's own-scope §5.7 exception) must reach the context",
  },
  // PCCC6B-1 — the arcs cutover call sites. Deleting any of these leaves every module-level test
  // green while an enforced member silently falls back to the tier cache (the laundering path).
  {
    file: join("app", "api", "brain", "arcs", "route.ts"),
    needle: "selectEnforcedGraphPartitions(admin, {",
    why: "an enforced team member's arcs must resolve their partition scope, not read the tier cache",
  },
  {
    file: join("app", "api", "brain", "arcs", "route.ts"),
    needle: "scopeKey: partitionArcScopeKey(teamSlug, scopeGroups)",
    why: "the scoped read must CACHE under the partition namespace — an un-namespaced key collides with the tier row",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "selectEnforcedGraphPartitions(admin, {",
    why: "an enforced member's recompute must run in their own scope, or the correction records against the tier row",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "readArcCache(admin, team.id, scopeKey)",
    why: "the write gate must consult the member's OWN scope row — the arcs they were actually shown",
  },
  {
    file: join("app", "api", "brain", "arcs", "route.ts"),
    needle: "k: Number.MAX_SAFE_INTEGER",
    why: "the arcs scope is UNCAPPED — a K-capped scope truncates coverage undisclosed and churns the cache key (Fable 6b Medium 3)",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "k: Number.MAX_SAFE_INTEGER",
    why: "the recompute must resolve the SAME uncapped scope as the GET, or the write gate reads a row the member never saw",
  },
];

describe("PCCC-6 cutover call sites", () => {
  it("every load-bearing wiring exists", () => {
    for (const { file, needle, why } of REQUIRED) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src.includes(needle), `${file}: missing "${needle}" — ${why}`).toBe(true);
    }
  });
});
