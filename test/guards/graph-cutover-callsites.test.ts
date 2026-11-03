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
  // ENFB-3 — the graph FEEDS' cutover call sites, with the two load-bearing ARGUMENTS pinned
  // (Fable diff M1: presence of the call alone left `arm: false` and the uncapped k one silent
  // edit away — a 60s-polling feed must never become an arming heartbeat or truncate quietly).
  {
    file: join("app", "api", "brain", "facts", "route.ts"),
    needle: "k: Number.MAX_SAFE_INTEGER,\n      arm: false,",
    why: "the facts feed resolves the member's oracle partitions uncapped and NON-arming",
  },
  {
    file: join("app", "api", "brain", "events", "route.ts"),
    needle: "k: Number.MAX_SAFE_INTEGER,\n      arm: false,",
    why: "the events feed resolves the member's oracle partitions uncapped and NON-arming",
  },
  {
    file: join("app", "api", "brain", "facts", "route.ts"),
    needle: "!scope.generalSuppressed",
    why: "the loud arm must exclude debt-suppressed zeros (a restriction move is a legitimate fail-closed empty, never a 500)",
  },
  {
    file: join("app", "api", "brain", "events", "route.ts"),
    needle: "!scope.generalSuppressed",
    why: "same discrimination as facts",
  },
  // TIERRET-1: the two query routes no longer spell the member's graph scope themselves — they hand
  // the WHOLE enforcement to the admission resolver, and the resolver's member arm carries the oracle
  // partition set. Both halves are pinned: a route that stopped calling the resolver, or a resolver
  // that stopped forwarding `graphProjectIds`, would silently drop the members' graph leg.
  {
    file: join("app", "api", "v1", "query", "route.ts"),
    needle: "enforce = retrieveEnforceFor(await resolveContentView(db, teamId, auth!.memberId));",
    why: "the API query route must hand admitted members their partition set (via the admission resolver)",
  },
  {
    file: join("app", "api", "dashboard", "query", "route.ts"),
    needle: "enforce = retrieveEnforceFor(await resolveContentView(db, team.id, me.id));",
    why: "the dashboard chat is the members' primary surface — an unwired split here shipped once in review",
  },
  {
    file: join("lib", "access", "admission.ts"),
    needle: "memberProjectIds: reader.memberProjectIds,\n      graphProjectIds: view.projectIds,",
    why: "the member arm's graph scope IS the oracle granted set the view resolved — never recomputed, never a fallback",
  },
  {
    file: join("lib", "access", "admission.ts"),
    needle: "projectIds: items.error ? [] : [...admission.grantedProjectIds],",
    why: "a substrate error yields an EMPTY scope (fail closed), never the granted set served next to an error",
  },
  {
    file: join("lib", "access", "admission.ts"),
    needle: "return { visibleItemIds: view.ids, principal: reader.principal };",
    why: "the legacy arm carries NO graphProjectIds — a connector/offroster key gains no graph authority",
  },
  {
    file: join("app", "api", "v1", "query", "route.ts"),
    needle: 'enforce = { visibleItemIds: ids, principal: "token", tokenProjectIds: projectIds };',
    why: "delegated tokens keep the §5.8b omit — their enforcement carries no graphProjectIds",
  },
  {
    file: join("lib", "graph", "partition-read.ts"),
    needle: "if (args.visibleProjectIds.length === 0) return { groups: [], covered: 0, total: 0, generalSuppressed: false };",
    why: "an EMPTY member scope selects no partitions — never a whole-team or tier-group fallback",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "if (!enforce?.graphProjectIds) return [];",
    why: "an absent scope (legacy key, token) omits the graph leg entirely",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "selectEnforcedGraphPartitions(db, { teamId, visibleProjectIds: enforce.graphProjectIds })",
    why: "the enforced graph leg must resolve partitions, not recompute or omit",
  },
  // PRET-6: the permissive-union pin retired with the union itself (fetchGraphFacts deleted).
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "graph expansion covered",
    why: "the covered/total disclosure (the spec's own-scope §5.7 exception) must reach the context",
  },
  // PCCC6B-1 — the arcs cutover call sites. Deleting any of these leaves every module-level test
  // green while an enforced member silently falls back to the tier cache (the laundering path).
  {
    file: join("app", "api", "brain", "arcs", "route.ts"),
    needle: "resolveArcScope(admin, { teamId: team.id, teamSlug, memberId, tier, enforcement: enforce })",
    why: "PRET-3: every reader's arcs scope comes from the ONE mode-keyed resolution — an ad-hoc scope here re-splits the read paths",
  },
  {
    file: join("app", "api", "brain", "arcs", "route.ts"),
    needle: "getAuthorizationBoundFusedArcs(admin, team.id, teamSlug, keys",
    why: "the epoch-bound fused panel is THE arcs read — dropping it silently resurrects a tier fallback or reuses stale authorization",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "resolveArcScope(admin, { teamId: team.id, teamSlug, memberId, tier, enforcement: enforce })",
    why: "an enforced member's recompute must run in their own scope, or the correction records against the tier row",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "readArcCache(admin, team.id, scopeKey)",
    why: "the write gate must consult the member's OWN scope row — the arcs they were actually shown",
  },
  {
    file: join("app", "api", "brain", "arcs", "recompute", "route.ts"),
    needle: "!scope.groups.includes(sourceGroup)",
    why: "PPARC-3: the claimed partition must be validated against the FRESHLY-RESOLVED scope — arc_id is sha(title), derivable without ever being served the arc",
  },
  {
    file: join("lib", "graph", "partition-read.ts"),
    needle: "k: Number.MAX_SAFE_INTEGER",
    why: "the arcs scope is UNCAPPED — a K-capped scope truncates coverage undisclosed and churns the cache key (Fable 6b Medium 3)",
  },
  {
    file: join("lib", "graph", "partition-read.ts"),
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
  it("TIERRET-1: neither query route builds a graph scope of its own (the resolver is the only source)", () => {
    for (const file of [join("app", "api", "v1", "query", "route.ts"), join("app", "api", "dashboard", "query", "route.ts")]) {
      const code = readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code, `${file}: a route-local graphProjectIds would bypass the admission resolver`).not.toMatch(/graphProjectIds\s*:/);
    }
  });
});
