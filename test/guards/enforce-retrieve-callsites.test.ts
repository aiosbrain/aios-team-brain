import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin the enforcement wiring at BOTH query routes (Phase B slice 2). retrieve() enforces only when
 * the caller passes `enforce`; a route that forgot to compute+pass it would silently serve an
 * enforcing team unfiltered retrieval — the leak this slice closes. Deleting the wiring must
 * redden here (the repo's recurring "call site pinned by nothing" failure).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

for (const route of ["app/api/v1/query/route.ts", "app/api/dashboard/query/route.ts"]) {
  describe(`enforcement wired in ${route}`, () => {
    const src = read(route);
    it("PRET-6 (the anti-zombie inverted pin): enforcement is constructed UNCONDITIONALLY — no flag read, no mode branch, no permissive null arm", () => {
      // AC1's greps cannot catch a renamed mode source; this call-site pin can. The non-token arm
      // must build enforce with no conditional guarding it.
      // (Was a pin on the comment text 'PRET-6: enforcing is the only behavior' — prose proves
      // nothing about control flow, so it is replaced by structural pins on the code itself.)
      expect(src).not.toMatch(/teamEnforcesAccess/);
      expect(src).not.toMatch(/access_enforcement|accessEnforcement|ACCESS_ENFORCEMENT/);
      // TIERRET-1: the non-token arm is built by the ONE admission resolver (member vs legacy is its
      // decision, never the route's) — an ordinary key is not assumed to be a member.
      const call = /enforce\s*=\s*retrieveEnforceFor\(\s*await\s+resolveContentView\(/;
      expect(src).toMatch(call);
      // Exactly ONE resolver-built assignment, and it is not under any `if (<flag/mode>)`: the line
      // immediately governing it is either the try body (dashboard) or the token branch's `else`
      // (v1). A wrapping conditional would have to appear between that opener and the call.
      // split() cuts at EVERY non-overlapping match regardless of flags; `call` is capture-free and
      // never matches empty, so exactly one occurrence yields exactly two pieces.
      expect(src.split(call)).toHaveLength(2);
      const at = src.search(call);
      const opener = Math.max(src.lastIndexOf("try {", at), src.lastIndexOf("} else {", at));
      expect(opener, "the resolver call sits directly in the try body or the token branch's else").toBeGreaterThan(-1);
      const between = src
        .slice(opener + 1, at)
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(between, "no conditional wraps the resolver call (no feature-flag opt-out)").not.toMatch(/\bif\s*\(|\bswitch\s*\(|&&|\|\||\?\?|\?\s/);
      // …and the resolver itself has no opt-out: it never reads a flag or mode before choosing an arm.
      const adm = read("lib/access/admission.ts");
      expect(adm).not.toMatch(/process\.env|teamEnforcesAccess|access_enforcement/);
    });
    it("resolves the member's visible items and passes enforce to retrieve", () => {
      expect(src).toMatch(/resolveContentView\s*\(/);
      // retrieve is called WITH the enforce arg (not the 5-arg permissive form).
      expect(src).toMatch(/retrieve\([^)]*enforce\s*\)/);
    });
    it("fails closed on a flag-read error (500, never unfiltered)", () => {
      expect(src).toMatch(/enforcement check failed/);
    });
  });
}

describe("dense-leg enforcement wired in lib/query/retrieve.ts (Codex B3 Medium)", () => {
  const src = read("lib/query/retrieve.ts");
  it("denseSearch receives the visible-item set (in-query, not post-filter-only)", () => {
    expect(src).toMatch(/denseSearch\(\s*teamId\s*,\s*tier\s*,\s*q\s*,\s*projectSlug\s*,\s*undefined\s*,\s*undefined\s*,\s*visArr\s*\)/);
  });
  it("dense grounding counts only VISIBLE hits (an invisible-only match must not suppress abstention)", () => {
    expect(src).toMatch(/denseHits\.some\(\s*\(h\)\s*=>\s*visible\(h\.item_id\)\s*\)/);
    // The unconditional form must be gone.
    expect(src).not.toMatch(/if\s*\(denseHits\.length\)\s*\{\s*grounded\s*=\s*true/s);
  });
});

describe("arc enforcement wiring in app/api/brain/arcs/route.ts (Phase B slice 5, §5.8)", () => {
  const src = read("app/api/brain/arcs/route.ts");
  it("resolves member visibility inside the epoch-bound fused owner, which performs the final filter", () => {
    expect(src).toMatch(/memberEnforcement\(\s*admin\s*,\s*\{\s*teamId:\s*team\.id\s*,\s*memberId\s*\}\s*\)/);
    expect(src).toContain("getAuthorizationBoundFusedArcs(");
    const owner = read("lib/graph/arc-fusion.ts");
    expect(owner).toMatch(/filterArcsByVisibleItems\(panel\.arcs, authorization\.visibleItemIds\)/);
    expect(owner).toMatch(/withLockedAuthorizationEpoch\(teamId/);
  });
  it("fails closed on enforcement errors and returns retryable unavailable for authority churn", () => {
    expect(src).toContain('errorResponse("temporarily_unavailable", "arc authorization changed; retry the request", 503)');
    expect(src).toContain('errorResponse("internal", "enforcement check failed", 500)');
  });
  it("the RECOMPUTE route filters too, under the same locked epoch as response serving", () => {
    const rc = read("app/api/brain/arcs/recompute/route.ts");
    expect(rc).toMatch(/memberEnforcement\(\s*admin\s*,\s*\{\s*teamId:\s*team\.id\s*,\s*memberId\s*\}\s*\)/);
    expect(rc).toMatch(/withLockedAuthorizationEpoch\(team\.id[\s\S]*arcs:\s*filterArcsByVisibleItems\(allArcs, enforce\.visibleItemIds\)/);
    expect(rc).toContain('errorResponse("internal", "enforcement check failed", 500)');
    expect(rc).toContain('errorResponse("temporarily_unavailable", "arc authorization changed; retry the request", 503)');
  });
  it("the recompute route gates the correction WRITE by visibility BEFORE recomputeArcs (Codex B5 High: arbitrary/invisible corrections poison the shared synthesis)", () => {
    const rc = read("app/api/brain/arcs/recompute/route.ts");
    // reads the CACHED arcs (no synthesis) + filters + rejects an out-of-visibility target …
    expect(rc).toMatch(/readArcCache\(/);
    expect(rc).toMatch(/corrections\.some\(\s*\(c\)\s*=>\s*!visibleIds\.has\(c\.arc_id\)\s*\)/);
    expect(rc).toMatch(/a correction targets an arc outside your visibility/);
    // … and that gate must sit BEFORE the recomputeArcs call (which writes + projects).
    const gateAt = rc.indexOf("outside your visibility");
    const recomputeAt = rc.indexOf("await recomputeArcs(");
    expect(gateAt, "the write gate must precede recomputeArcs").toBeLessThan(recomputeAt);
  });
  it("both arc routes neutralize the response for a member whose result is empty (§5.7 — no absent-vs-invisible disclosure)", () => {
    // PRET-6: the team-wide empty-panel DIAGNOSTIC is RETIRED with the permissive mode (it read
    // unscoped graph/LLM health, which §5.7 forbids serving to a partitioned member) — pin its
    // ABSENCE, not its gating.
    expect(read("app/api/brain/arcs/route.ts")).not.toMatch(/no_facts|model_failing|synthesis_empty/);
    // … and both routes return a neutral envelope on empty.
    expect(read("app/api/brain/arcs/route.ts")).toMatch(/if \(arcs\.length === 0\)/);
    expect(read("app/api/brain/arcs/recompute/route.ts")).toMatch(/served\.arcs\.length === 0[\s\S]*freshnessWire\(computedNow\(\)\)/);
  });
});

describe("timeline enforcement wiring (Phase B slice 4, §5.8)", () => {
  it("every timeline surface passes its PRINCIPAL to getCachedWorkTimeline (4th arg — a forgotten one would serve the tier row)", () => {
    expect(read("app/api/v1/timeline/route.ts")).toMatch(/getCachedWorkTimeline\(db,\s*auth\.teamId,\s*auth\.memberTier,\s*auth\.memberId\s*\)/);
    expect(read("app/api/dashboard/team-work/route.ts")).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*team\.id,\s*tier,\s*\(me as \{ id: string \}\)\.id\s*\)/);
    expect(read("components/learning/timeline-panel.tsx")).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*teamId,\s*tier,\s*memberId\s*\)/);
  });
  it("the windowed dashboard route enforces BOTH arms (the fresh-build arm bypasses the cache layer)", () => {
    const src = read("app/api/dashboard/timeline/route.ts");
    expect(src).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*team\.id,\s*tier,\s*memberId\s*\)/);
    // TIERRET-1: the fresh-build arm carries the READER too (the cached arm resolves it inside).
    expect(src).toMatch(/getWorkTimeline\([^;]*days,\s*await\s+contentTimelineEnforcement\(/);
  });
  it("the cache layer fails closed: no principal on an enforcing team throws", () => {
    expect(read("lib/dashboard/timeline-cache.ts")).toMatch(/timeline read without a principal/); // PRET-6: always throws
  });
});

describe("delegated query wiring in app/api/v1/query/route.ts (Phase B slice 3)", () => {
  const src = read("app/api/v1/query/route.ts");
  it("delegated principals get the ALWAYS-attenuated path (flag-independent)", () => {
    // Pin the FULL sequence in one regex (Fable B3 Medium): the agent branch must resolve
    // delegatedVisibleItemIds WITH the agent principal, ASSIGN the result to `enforce`, and the
    // flag-gated member path must be its else-branch — so the agent arm can neither lose the
    // assignment (call kept, enforce stays null → unfiltered retrieve with graph legs live) nor
    // be nested inside teamEnforcesAccess (flag-dependent → permissive team widens the token).
    // QMIR-1 widened the pin: the agent arm must ALSO carry `principal: "token"` — the
    // org-structural mirror legs key on the positive member test, so losing the discriminant
    // here silently costs nothing today but is the field a future refactor must not drop.
    // AUDITFIX-7 widened it again, for the SAME reason and it is worth stating twice: the arm must
    // destructure `projectIds` from what `delegatedVisibleItemIds` returned and forward it as
    // `tokenProjectIds`. Dropping it closes every token's hand-typed arm — which is EXACTLY the
    // pre-AUDITFIX-7 behaviour, so no test would redden and no user would report it. The regex
    // requires the forwarded name to be the destructured one, so a recomputed or same-named
    // substitute does not satisfy it.
    // Comment lines between the resolve and the assignment are permitted; code is not.
    expect(src).toMatch(
      // PRET-6: the member arm is the unconditional ELSE (the flag read retired).
      /if\s*\(agent\)\s*\{\s*const\s*\{\s*ids\s*,\s*projectIds\s*\}\s*=\s*await\s+delegatedVisibleItemIds\(\s*db\s*,\s*agent\s*\)\s*;\s*(?:\/\/[^\n]*\n\s*)*enforce\s*=\s*\{\s*visibleItemIds:\s*ids\s*,\s*principal:\s*"token"\s*,\s*tokenProjectIds:\s*projectIds\s*\}\s*;\s*\}\s*else\s*\{/
    );
    // No bare `enforce = null` assignment may exist anywhere (Codex B3 Low: the sequence regex
    // above survives a later re-null). The typed declaration (`let enforce: … | null = null`)
    // does not match this pattern, so the legal count is zero.
    expect(src.match(/enforce\s*=\s*null/g) ?? [], "enforce must never be re-nulled after the branch").toHaveLength(0);
  });
  it("both non-token arms route through the admission resolver, whose arms are pinned here (QMIR-1 review Low 1; TIERRET-1)", () => {
    // A call site pinned by nothing is this repo's flagship defect class — so pin both halves:
    // the routes delegate, and the resolver's two arms carry exactly their authority.
    expect(src).toMatch(/enforce\s*=\s*retrieveEnforceFor\(\s*await\s+resolveContentView\(\s*db\s*,\s*teamId\s*,\s*auth!\.memberId\s*\)\s*\)/);
    const dash = read("app/api/dashboard/query/route.ts");
    expect(dash).toMatch(/enforce\s*=\s*retrieveEnforceFor\(\s*await\s+resolveContentView\(\s*db\s*,\s*team\.id\s*,\s*me\.id\s*\)\s*\)/);
    const adm = read("lib/access/admission.ts");
    // Member arm: item set + Everyone bit + granted projects + graph partitions = the oracle set.
    expect(adm).toMatch(
      /principal:\s*reader\.principal,\s*memberEveryone:\s*reader\.everyone,\s*memberProjectIds:\s*reader\.memberProjectIds,\s*graphProjectIds:\s*view\.projectIds/
    );
    // Legacy arm: no graph scope, no member authority — the baseline shape only.
    expect(adm).toMatch(/return \{ visibleItemIds: view\.ids, principal: reader\.principal \};/);
    // Positive admission is `isPrincipal` on a same-team members row, read by the resolver itself —
    // and an inactive row is refused BEFORE either arm (never demoted to legacy).
    expect(adm).toMatch(/if \(!isPrincipal\(eligibility\)\) return \{ kind: "legacy"/);
    expect(adm.indexOf('if (member.status !== "active") throw new ContentAdmissionError')).toBeLessThan(
      adm.indexOf('if (!isPrincipal(eligibility)) return { kind: "legacy"')
    );
  });
  it("the Phase A 403 refusal is gone — delegated tokens authenticate instead", () => {
    expect(src).not.toMatch(/delegation_not_supported/);
    expect(src).toMatch(/authenticateAgentToken\s*\(/);
  });
  it("delegated queries are stateless: conversation_id refused, no thread reads/writes", () => {
    expect(src).toMatch(/agent\s*&&\s*conversation_id/);
    // Conversation store access hangs off `owner`, which is null for agents.
    expect(src).toMatch(/const\s+owner\s*=\s*auth\s*\?/);
  });
});
