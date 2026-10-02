import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PROJECT_SCOPE,
  canSubmitMint,
  expiryInstantFor,
  mintRequestFor,
  validateMintRequest,
  MAX_TOKEN_LIFETIME_MS,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  type MintRequest,
} from "@/lib/access/agent-token-policy";
import { SCOPE_ERRORS, parseTokenMintScope } from "@/lib/access/agent-token-scope";

/**
 * AGENTUI-1 — the mint-request policy.
 *
 * Every assertion here is written in the FAIL-OPEN direction: it asserts a request is REFUSED. That
 * is deliberate. Each rule exists because the permissive outcome is the dangerous one — an
 * unattenuated token, a never-expiring token, a token that impersonates — and a test that only
 * checked the happy path would stay green with every rule deleted.
 */

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const MEMBER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const ALL_REACHABLE = { kind: "all-reachable" } as const;

/**
 * A request that is legal in every respect, so each test varies exactly one thing. AUDITFIX-19: the
 * baseline carries an EXPLICIT all-reachable choice — an omitted scope is no longer legal.
 */
function legal(over: Partial<MintRequest> = {}): MintRequest {
  return {
    memberId: MEMBER,
    scope: ALL_REACHABLE,
    expiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function errorFor(req: unknown): string {
  const r = validateMintRequest(req, NOW);
  return r.ok ? "(accepted)" : r.error;
}

function accepted(req: unknown): boolean {
  return validateMintRequest(req, NOW).ok;
}

describe("agent token mint policy", () => {
  it("accepts the legal baseline (non-vacuity: if this fails, every refusal below proves nothing)", () => {
    expect(accepted(legal())).toBe(true);
  });

  describe("acting-as is refused server-side, not merely hidden from the form", () => {
    it("refuses onBehalfOf even when it is a well-formed member uuid", () => {
      expect(errorFor(legal({ onBehalfOf: "33333333-3333-4333-8333-333333333333" }))).toMatch(/self-only/);
    });

    it("still accepts an explicit null (absent acting-as is the normal case)", () => {
      expect(accepted(legal({ onBehalfOf: null }))).toBe(true);
    });
  });

  /**
   * AUDITFIX-19 supersedes "accepts an omitted scope" and "accepts an explicit null scope": both
   * encoded the defect (silent inherit-everything). They are now refusals with a scope-specific
   * reason; the legacy `projectScope` key is its own separate refusal.
   */
  describe("scope: an explicit choice is REQUIRED; 'sees nothing' is not a legal request", () => {
    it("REFUSES an omitted scope (was: accepted as inherit)", () => {
      const { scope: _omit, ...rest } = legal();
      expect(errorFor(rest)).toBe(SCOPE_ERRORS.required);
    });

    it("REFUSES an explicit null scope (was: accepted as inherit)", () => {
      expect(errorFor({ ...legal(), scope: null })).toBe(SCOPE_ERRORS.required);
    });

    it("REFUSES the legacy projectScope: null key, even beside a valid choice", () => {
      expect(errorFor({ ...legal(), projectScope: null })).toBe(SCOPE_ERRORS.legacyKey);
    });

    it("accepts a deliberate all-reachable choice and returns it normalized", () => {
      const r = validateMintRequest(legal(), NOW);
      expect(r.ok && r.request.scope).toEqual({ kind: "all-reachable" });
    });

    it("REFUSES an empty project list — the accidental 'reads nothing' token", () => {
      expect(errorFor(legal({ scope: { kind: "projects", projectIds: [] } }))).toBe(SCOPE_ERRORS.projectIdsEmpty);
    });

    it("accepts a populated project list and returns it normalized", () => {
      const r = validateMintRequest(legal({ scope: { kind: "projects", projectIds: [PROJECT] } }), NOW);
      expect(r.ok && r.request.scope).toEqual({ kind: "projects", projectIds: [PROJECT] });
    });

    it("refuses a project list containing a non-uuid", () => {
      expect(errorFor(legal({ scope: { kind: "projects", projectIds: [PROJECT, "not-a-uuid"] } }))).toBe(
        SCOPE_ERRORS.projectIdsNotUuids
      );
    });
  });

  describe("expiry is required and bounded — a null expiry never expires", () => {
    // Rule-specific: `/expiresAt is required/`, never a bare `/required/` that a scope refusal
    // ("scope is required …") would also satisfy.
    it("refuses an absent expiry", () => {
      expect(errorFor({ memberId: MEMBER, scope: ALL_REACHABLE })).toMatch(/^expiresAt is required$/);
    });

    it("refuses an explicitly null expiry", () => {
      expect(errorFor(legal({ expiresAt: null }))).toMatch(/^expiresAt is required$/);
    });

    it("refuses an empty-string expiry (an untouched date input, not a choice)", () => {
      expect(errorFor(legal({ expiresAt: "" }))).toMatch(/^expiresAt is required$/);
    });

    it("refuses an unparseable expiry", () => {
      expect(errorFor(legal({ expiresAt: "next tuesday" }))).toMatch(/^expiresAt must be an ISO timestamp$/);
    });

    it("refuses an expiry in the past — it would mint an already-dead credential", () => {
      expect(errorFor(legal({ expiresAt: new Date(NOW - 1000).toISOString() }))).toMatch(
        /^expiresAt must be in the future$/
      );
    });

    it("refuses an expiry exactly at now (boundary: <= now, not < now)", () => {
      expect(errorFor(legal({ expiresAt: new Date(NOW).toISOString() }))).toMatch(/^expiresAt must be in the future$/);
    });

    it("accepts an expiry exactly at the 365-day cap (boundary: <= max is legal)", () => {
      expect(accepted(legal({ expiresAt: new Date(NOW + MAX_TOKEN_LIFETIME_MS).toISOString() }))).toBe(true);
    });

    it("refuses one millisecond beyond the cap", () => {
      expect(
        errorFor(legal({ expiresAt: new Date(NOW + MAX_TOKEN_LIFETIME_MS + 1).toISOString() }))
      ).toMatch(/^expiresAt is beyond the 365-day maximum$/);
    });
  });

  it("refuses a malformed memberId", () => {
    expect(errorFor(legal({ memberId: "nope" }))).toMatch(/member uuid/);
  });

  it("the form's default lifetime is inside the cap the action enforces (one constant, two readers)", () => {
    expect(DEFAULT_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toBeLessThan(MAX_TOKEN_LIFETIME_MS);
  });
});

/**
 * SPEC AC (agent-tokens-admin-ui-v1.md "Automated"): the form's scope+expiry contract. Extracted to
 * a pure rule so it is pinned by assertions rather than by reading JSX — the "untouched scope
 * silently inherits everything" hazard is the fail-open direction both spec reviewers flagged.
 */
describe("mint form submit rule", () => {
  const base = { memberId: MEMBER, expiry: "2026-12-01" };

  it("an UNTOUCHED scope is not submittable — never a silent inherit", () => {
    expect(canSubmitMint({ ...base, scope: null })).toBe(false);
  });

  it("a deliberate all-reachable choice IS submittable", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "all-reachable" } })).toBe(true);
  });

  it("a project choice with zero projects is not submittable — never a silent 'sees nothing'", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "projects", projectIds: [] } })).toBe(false);
  });

  it("a project choice with one project is submittable", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "projects", projectIds: [PROJECT] } })).toBe(true);
  });

  it("a missing member or a cleared expiry blocks submit", () => {
    expect(canSubmitMint({ memberId: "", expiry: "2026-12-01", scope: { kind: "all-reachable" } })).toBe(false);
    expect(canSubmitMint({ memberId: MEMBER, expiry: "", scope: { kind: "all-reachable" } })).toBe(false);
  });
});

/**
 * AUDITFIX-19 AC-07: the EXACT payload the form sends. `mintRequestFor` is what the component calls;
 * pinning its output pins the wire contract (and the component wiring guard below pins the call).
 */
describe("mint form payload mapping (AUDITFIX-19)", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const form = { memberId: MEMBER, name: "agent", expiry: "2026-09-20" };

  it("untouched scope produces NO request at all — not null, not inherit, not []", () => {
    expect(mintRequestFor({ ...form, scope: null }, now)).toBeNull();
  });

  it("an empty project selection produces no request", () => {
    expect(mintRequestFor({ ...form, scope: { kind: "projects", projectIds: [] } }, now)).toBeNull();
  });

  it("a deliberate all-reachable choice maps to exactly { kind: 'all-reachable' } and no legacy key", () => {
    const req = mintRequestFor({ ...form, scope: { kind: "all-reachable" } }, now);
    expect(req).toEqual({
      memberId: MEMBER,
      name: "agent",
      expiresAt: "2026-09-20T23:59:59.000Z",
      scope: { kind: "all-reachable" },
    });
    expect(Object.hasOwn(req!, "projectScope"), "the form must never emit the legacy key").toBe(false);
    expect(Object.keys(req!.scope)).toEqual(["kind"]);
    expect(accepted(req), "the form's own payload is accepted by the action policy").toBe(true);
  });

  it("a deliberate project choice maps to exactly { kind: 'projects', projectIds } — a copy, not the UI array", () => {
    const ui = [PROJECT];
    const req = mintRequestFor({ ...form, scope: { kind: "projects", projectIds: ui } }, now);
    expect(req).toEqual({
      memberId: MEMBER,
      name: "agent",
      expiresAt: "2026-09-20T23:59:59.000Z",
      scope: { kind: "projects", projectIds: [PROJECT] },
    });
    expect(Object.hasOwn(req!, "projectScope")).toBe(false);
    expect(req!.scope.kind === "projects" && req!.scope.projectIds).not.toBe(ui);
    expect(accepted(req)).toBe(true);
  });
});

/**
 * SPEC AC: two source-level obligations the runtime tests cannot see.
 */
describe("agent-token admin surface obligations", () => {
  const ROOT = join(import.meta.dirname, "..");
  const page = readFileSync(join(ROOT, "app", "t", "[team]", "admin", "agents", "page.tsx"), "utf8");
  const actions = readFileSync(join(ROOT, "app", "t", "[team]", "admin", "agents", "actions.ts"), "utf8");
  const form = readFileSync(join(ROOT, "components", "admin", "mint-agent-token.tsx"), "utf8");

  it("AUDITFIX-19: the form sends the mapped request — never a hand-built legacy projectScope payload", () => {
    expect(form, "the component must build its payload with mintRequestFor").toMatch(
      /mintRequestFor\(\{ memberId, name, expiry, scope \}, Date\.now\(\)\)/
    );
    expect(form, "the action receives that mapped request").toMatch(/mintAgentTokenAction\(teamSlug, request\)/);
    expect(form, "no legacy projectScope key may be emitted by the form").not.toMatch(/projectScope/);
  });

  it("the page never selects token_hash — checked per QUERY, not by mere absence of the word", () => {
    // Occurrence checks were the weakness Codex named: a SECOND `.from("agent_tokens")` could add
    // the hash while the first stayed clean. So pin the query count, then check each one.
    const queries = [...page.matchAll(/\.from\("agent_tokens"\)([\s\S]*?)(?=\n\s*\]|\n\s*\);)/g)];
    expect(queries.length, "exactly one agent_tokens query — add a test arm if a second is ever needed").toBe(1);
    for (const q of queries) {
      expect(q[1], "no agent_tokens query may select token_hash").not.toMatch(/token_hash/);
      expect(q[1], "non-vacuity: the query body was actually captured").toMatch(/\.select\(/);
    }
  });

  it("mint and revoke EACH revalidate — per function body, not a global count", () => {
    // A global count of 2 stays green with both calls in mint and none in revoke (Codex).
    const bodies = actions.split(/export async function /).slice(1);
    const byName = new Map(bodies.map((b) => [b.slice(0, b.indexOf("(")), b]));
    for (const fn of ["mintAgentTokenAction", "revokeAgentTokenAction"]) {
      expect(byName.get(fn), `non-vacuity: ${fn} body was found`).toBeTruthy();
      expect(byName.get(fn)!, `${fn} must revalidate on success`).toMatch(/revalidateAgents\(teamSlug\)/);
    }
    expect(actions, "revalidation must not be able to throw away a minted token").toMatch(/try \{[\s\S]*?revalidatePath/);
  });

  it("the expiry column uses fmtDate, not timeAgo (timeAgo renders every FUTURE date as 'just now')", () => {
    expect(page).toMatch(/fmtDate\(t\.expires_at\)/);
    expect(page, "a future expiry through timeAgo reads 'just now' for every live token").not.toMatch(/timeAgo\(t\.expires_at\)/);
  });

  it("the expiry instant offered by the form is always inside the cap the action enforces", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    // The exact failure Codex found: the max date the picker offered, submitted at end-of-day,
    // overshot the 365-day cap by ~12h and the action refused its own picker's value.
    const maxDate = new Date(now + MAX_TOKEN_LIFETIME_MS).toISOString().slice(0, 10);
    const instant = expiryInstantFor(maxDate, now);
    expect(Date.parse(instant)).toBeLessThanOrEqual(now + MAX_TOKEN_LIFETIME_MS);
    expect(validateMintRequest({ memberId: MEMBER, scope: ALL_REACHABLE, expiresAt: instant }, now).ok).toBe(true);
  });

  it("a normal date is unchanged by the clamp (non-vacuity: it does not clamp everything)", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    expect(expiryInstantFor("2026-09-20", now)).toBe("2026-09-20T23:59:59.000Z");
  });
});

describe("policy hardening against malformed input (a public endpoint receives anything)", () => {
  const NOW2 = Date.parse("2026-08-22T12:00:00.000Z");
  const EXP = "2026-09-20T00:00:00.000Z";
  const bad = (req: unknown) => validateMintRequest(req, NOW2);
  const err = (req: unknown) => {
    const r = bad(req);
    return r.ok ? "(accepted)" : r.error;
  };

  it("refuses null/undefined/array/primitive requests with the invalid-request refusal, instead of throwing", () => {
    for (const r of [null, undefined, [], "nope", 7, true]) expect(err(r)).toBe("invalid request");
  });

  it("refuses an ARRAY memberId — RegExp.test coerces, so a type check must come first", () => {
    expect(bad({ memberId: [MEMBER], scope: ALL_REACHABLE, expiresAt: EXP })).toEqual({
      ok: false,
      error: "memberId must be a member uuid",
    });
  });

  it("refuses a non-ISO date that Date.parse would happily accept", () => {
    expect(err({ memberId: MEMBER, scope: ALL_REACHABLE, expiresAt: "12/31/2026" })).toBe(
      "expiresAt must be an ISO timestamp"
    );
  });

  it("accepts a numeric UTC offset (a legal ISO instant)", () => {
    expect(bad({ memberId: MEMBER, scope: ALL_REACHABLE, expiresAt: "2026-09-20T10:00:00+02:00" }).ok).toBe(true);
  });

  it("refuses a non-array project list instead of throwing inside .some()", () => {
    expect(err({ memberId: MEMBER, expiresAt: EXP, scope: { kind: "projects", projectIds: "x" } })).toBe(
      SCOPE_ERRORS.projectIdsNotArray
    );
  });

  it("refuses duplicates and over-cap project lists, each for its own reason", () => {
    expect(err({ memberId: MEMBER, expiresAt: EXP, scope: { kind: "projects", projectIds: [PROJECT, PROJECT] } })).toBe(
      SCOPE_ERRORS.projectIdsDuplicate
    );
    const many = Array.from({ length: MAX_PROJECT_SCOPE + 1 }, (_, i) => `${i}`.padStart(8, "0") + "-2222-4222-8222-222222222222");
    expect(err({ memberId: MEMBER, expiresAt: EXP, scope: { kind: "projects", projectIds: many } })).toBe(
      SCOPE_ERRORS.projectIdsTooMany
    );
    // Non-vacuity for the cap: exactly MAX is legal.
    expect(bad({ memberId: MEMBER, expiresAt: EXP, scope: { kind: "projects", projectIds: many.slice(0, MAX_PROJECT_SCOPE) } }).ok).toBe(true);
  });

  it("refuses a non-string name", () => {
    expect(err({ memberId: MEMBER, scope: ALL_REACHABLE, expiresAt: EXP, name: 5 })).toBe("name must be a string");
  });
});

/**
 * AUDITFIX-19 AC-03/AC-04 — the shared scope parser, called directly. Each case asserts its OWN
 * reason, so a case cannot pass on an unrelated refusal (e.g. the legacy-key rule).
 */
describe("explicit scope parser (AUDITFIX-19)", () => {
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const parse = (scope: unknown) => parseTokenMintScope({ scope });
  const reason = (r: ReturnType<typeof parseTokenMintScope>) => (r.ok ? "(accepted)" : r.error);

  const MALFORMED: [label: string, scope: () => unknown, error: string][] = [
    ["undefined scope", () => undefined, SCOPE_ERRORS.required],
    ["null scope", () => null, SCOPE_ERRORS.required],
    ["string scope", () => "all-reachable", SCOPE_ERRORS.notObject],
    ["number scope", () => 1, SCOPE_ERRORS.notObject],
    ["boolean scope", () => true, SCOPE_ERRORS.notObject],
    ["array scope", () => [P1], SCOPE_ERRORS.notObject],
    ["empty object (no kind)", () => ({}), SCOPE_ERRORS.badKind],
    ["inherited kind", () => Object.create({ kind: "all-reachable" }), SCOPE_ERRORS.badKind],
    ["unknown kind", () => ({ kind: "inherit" }), SCOPE_ERRORS.badKind],
    ["legacy UI kind restrict", () => ({ kind: "restrict", projectIds: [P1] }), SCOPE_ERRORS.badKind],
    ["non-string kind", () => ({ kind: 1 }), SCOPE_ERRORS.badKind],
    ["case-variant kind", () => ({ kind: "ALL-REACHABLE" }), SCOPE_ERRORS.badKind],
    ["all-reachable + projectIds", () => ({ kind: "all-reachable", projectIds: [P1] }), SCOPE_ERRORS.allReachableExtra],
    ["all-reachable + undefined projectIds", () => ({ kind: "all-reachable", projectIds: undefined }), SCOPE_ERRORS.allReachableExtra],
    ["all-reachable + stray field", () => ({ kind: "all-reachable", everything: true }), SCOPE_ERRORS.allReachableExtra],
    ["projects + stray field", () => ({ kind: "projects", projectIds: [P1], all: true }), SCOPE_ERRORS.projectsExtra],
    ["projects without projectIds", () => ({ kind: "projects" }), SCOPE_ERRORS.projectIdsRequired],
    ["projects with inherited projectIds", () => Object.assign(Object.create({ projectIds: [P1] }), { kind: "projects" }), SCOPE_ERRORS.projectIdsRequired],
    ["projects with null projectIds", () => ({ kind: "projects", projectIds: null }), SCOPE_ERRORS.projectIdsNotArray],
    ["projects with string projectIds", () => ({ kind: "projects", projectIds: P1 }), SCOPE_ERRORS.projectIdsNotArray],
    ["projects with object projectIds", () => ({ kind: "projects", projectIds: { 0: P1, length: 1 } }), SCOPE_ERRORS.projectIdsNotArray],
    ["empty projectIds", () => ({ kind: "projects", projectIds: [] }), SCOPE_ERRORS.projectIdsEmpty],
    ["bad uuid", () => ({ kind: "projects", projectIds: ["not-a-uuid"] }), SCOPE_ERRORS.projectIdsNotUuids],
    ["non-string id", () => ({ kind: "projects", projectIds: [42] }), SCOPE_ERRORS.projectIdsNotUuids],
    ["null id", () => ({ kind: "projects", projectIds: [P1, null] }), SCOPE_ERRORS.projectIdsNotUuids],
    ["present undefined id", () => ({ kind: "projects", projectIds: [P1, undefined] }), SCOPE_ERRORS.projectIdsNotUuids],
    ["exact duplicate", () => ({ kind: "projects", projectIds: [P1, P1] }), SCOPE_ERRORS.projectIdsDuplicate],
    ["mixed-case duplicate", () => ({ kind: "projects", projectIds: [P1.toUpperCase(), P1] }), SCOPE_ERRORS.projectIdsDuplicate],
    [
      "201 ids",
      () => ({
        kind: "projects",
        projectIds: Array.from({ length: MAX_PROJECT_SCOPE + 1 }, (_, i) => `${i}`.padStart(8, "0") + "-2222-4222-8222-222222222222"),
      }),
      SCOPE_ERRORS.projectIdsTooMany,
    ],
  ];

  for (const [label, scope, error] of MALFORMED) {
    it(`refuses ${label} with its own reason`, () => {
      expect(reason(parse(scope()))).toBe(error);
    });
  }

  it("accepts exactly the two valid shapes (non-vacuity for the table above)", () => {
    expect(parse({ kind: "all-reachable" })).toEqual({ ok: true, scope: { kind: "all-reachable" } });
    expect(parse({ kind: "projects", projectIds: [P1, P2] })).toEqual({
      ok: true,
      scope: { kind: "projects", projectIds: [P1, P2] },
    });
  });

  describe("request-level own-property rules", () => {
    it("an omitted scope is refused as required", () => {
      expect(reason(parseTokenMintScope({ memberId: MEMBER }))).toBe(SCOPE_ERRORS.required);
    });

    it("an INHERITED scope is not a decision", () => {
      const req = Object.assign(Object.create({ scope: { kind: "all-reachable" } }), { memberId: MEMBER });
      expect(reason(parseTokenMintScope(req))).toBe(SCOPE_ERRORS.required);
    });

    it("an own legacy projectScope key is refused whatever its value — even undefined, even beside a valid choice", () => {
      for (const legacy of [undefined, null, [], [P1]]) {
        expect(reason(parseTokenMintScope({ scope: { kind: "all-reachable" }, projectScope: legacy }))).toBe(SCOPE_ERRORS.legacyKey);
        expect(reason(parseTokenMintScope({ scope: { kind: "projects", projectIds: [P1] }, projectScope: legacy }))).toBe(SCOPE_ERRORS.legacyKey);
        expect(reason(parseTokenMintScope({ projectScope: legacy }))).toBe(SCOPE_ERRORS.legacyKey);
      }
    });

    it("an INHERITED legacy key is not an own key — the explicit choice decides", () => {
      const req = Object.assign(Object.create({ projectScope: null }), { scope: { kind: "all-reachable" } });
      expect(parseTokenMintScope(req).ok).toBe(true);
    });

    it("refuses null/primitive/array whole requests without throwing", () => {
      for (const r of [null, undefined, 0, "x", [], [{ kind: "all-reachable" }]]) {
        expect(reason(parseTokenMintScope(r))).toBe("invalid request");
      }
    });
  });

  describe("canonicalization (case-insensitive UUIDs, lowercased before the duplicate check)", () => {
    it("accepts uppercase spelling and returns the canonical lowercase ordered list", () => {
      const r = parse({ kind: "projects", projectIds: [P2.toUpperCase(), P1] });
      expect(r).toEqual({ ok: true, scope: { kind: "projects", projectIds: [P2, P1] } });
    });

    it("never silently deduplicates: a mixed-case pair is a duplicate refusal, not a one-element list", () => {
      expect(reason(parse({ kind: "projects", projectIds: [P1, P1.toUpperCase()] }))).toBe(SCOPE_ERRORS.projectIdsDuplicate);
    });
  });

  describe("dense snapshot (holes, accessors, mutation after parse)", () => {
    it("a sparse list with a valid neighbour is refused — the hole is read as undefined, not skipped", () => {
      const sparse: unknown[] = new Array(3);
      sparse[0] = P1;
      sparse[2] = P2;
      expect(1 in sparse, "fixture really has a hole").toBe(false);
      expect(sparse.every((id) => id === P1 || id === P2), "array helpers skip the hole — why the snapshot exists").toBe(true);
      expect(reason(parse({ kind: "projects", projectIds: sparse }))).toBe(SCOPE_ERRORS.projectIdsNotUuids);
    });

    it("a list whose length was extended past its last element is refused", () => {
      const ids = [P1];
      ids.length = 2;
      expect(reason(parse({ kind: "projects", projectIds: ids }))).toBe(SCOPE_ERRORS.projectIdsNotUuids);
    });

    it("reads the discriminant and the list ONCE — a getter that would change on a second read cannot", () => {
      let kindReads = 0;
      let listReads = 0;
      const scope = {
        get kind() {
          kindReads += 1;
          return kindReads === 1 ? "projects" : "all-reachable";
        },
        get projectIds() {
          listReads += 1;
          return listReads === 1 ? [P1] : [P2, P1];
        },
      };
      const r = parse(scope);
      expect(r).toEqual({ ok: true, scope: { kind: "projects", projectIds: [P1] } });
      expect([kindReads, listReads]).toEqual([1, 1]);
    });

    it("reads length once and every index once, through an observing proxy", () => {
      const reads = new Map<PropertyKey, number>();
      const target = [P1, P2];
      const observed = new Proxy(target, {
        get(t, key, recv) {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return Reflect.get(t, key, recv);
        },
      });
      expect(parse({ kind: "projects", projectIds: observed }).ok).toBe(true);
      expect(reads.get("length")).toBe(1);
      expect(reads.get("0")).toBe(1);
      expect(reads.get("1")).toBe(1);
    });

    it("an index getter is evaluated once, and its FIRST value is what is validated and returned", () => {
      let n = 0;
      const ids: string[] = [];
      Object.defineProperty(ids, 0, {
        enumerable: true,
        get() {
          n += 1;
          return n === 1 ? P1 : "not-a-uuid";
        },
      });
      expect(parse({ kind: "projects", projectIds: ids })).toEqual({ ok: true, scope: { kind: "projects", projectIds: [P1] } });
      expect(n).toBe(1);
    });

    it("returns a COPY: mutating the caller's scope and list after parsing changes nothing returned", () => {
      const list = [P1];
      const scope: { kind: string; projectIds: string[] } = { kind: "projects", projectIds: list };
      const r = parse(scope);
      list[0] = P2;
      list.push(P2);
      scope.kind = "all-reachable";
      expect(r).toEqual({ ok: true, scope: { kind: "projects", projectIds: [P1] } });
      expect(r.ok && r.scope.kind === "projects" && r.scope.projectIds).not.toBe(list);
    });

    it("a hole the PROTOTYPE answers for is still a hole — an inherited index is not an own element", () => {
      const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const sparse: unknown[] = new Array(3);
      sparse[0] = P1;
      sparse[2] = P2;
      Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 1: P3 }));
      expect(Array.isArray(sparse), "fixture is still a genuine array").toBe(true);
      expect(Object.hasOwn(sparse, 1), "fixture really has a hole at 1").toBe(false);
      expect(sparse[1], "a plain indexed read falls through to the inherited, distinct, valid uuid").toBe(P3);
      expect(reason(parse({ kind: "projects", projectIds: sparse }))).toBe(SCOPE_ERRORS.projectIdsNotUuids);
    });

    it("holes are refused BEFORE the copy — no element of a holed list is read", () => {
      let reads = 0;
      const ids: unknown[] = [];
      Object.defineProperty(ids, 0, {
        enumerable: true,
        get() {
          reads += 1;
          return P1;
        },
      });
      ids.length = 2; // index 1 is a hole
      expect(reason(parse({ kind: "projects", projectIds: ids }))).toBe(SCOPE_ERRORS.projectIdsNotUuids);
      expect(reads, "the own element before the hole was never read").toBe(0);
    });
  });

  /**
   * Review S1 — `length` is read once and must be a genuine array length. A proxy over an array passes
   * `Array.isArray`, so its `length` trap can answer anything; before the fix "0" slipped past `=== 0`
   * and `> 200`, drove both loops zero times and parsed as a VALID EMPTY list (which the core stored).
   */
  describe("a proxied list's length is validated without coercion (S1)", () => {
    function lengthLiar(length: unknown, target: unknown[]): { list: unknown[]; lengthReads: () => number } {
      let reads = 0;
      const list = new Proxy(target, {
        get(t, key, recv) {
          if (key === "length") {
            reads += 1;
            return length;
          }
          return Reflect.get(t, key, recv);
        },
      });
      return { list, lengthReads: () => reads };
    }

    const MALFORMED_LENGTHS: [label: string, length: unknown, target: () => unknown[]][] = [
      ['string "0" over an empty array', "0", () => []],
      ['string "1" over a one-uuid array', "1", () => [P1]],
      ['string "NaN"', "NaN", () => [P1]],
      ["numeric NaN", NaN, () => [P1]],
      ["negative", -1, () => [P1]],
      ["fractional", 1.5, () => [P1, P2]],
      ["Infinity", Infinity, () => [P1]],
      ["-Infinity", -Infinity, () => [P1]],
      ["beyond safe integers", 2 ** 53, () => [P1]],
      ["an object", { valueOf: () => 1 }, () => [P1]],
      ["a Symbol", Symbol("length"), () => [P1]],
    ];

    for (const [label, length, target] of MALFORMED_LENGTHS) {
      it(`refuses a proxied length of ${label}, read once, without throwing`, () => {
        const { list, lengthReads } = lengthLiar(length, target());
        expect(reason(parse({ kind: "projects", projectIds: list }))).toBe(SCOPE_ERRORS.projectIdsNotArray);
        expect(lengthReads()).toBe(1);
      });
    }

    it("a LEGITIMATE proxy with an honest numeric length still parses, reading length and each index once", () => {
      const reads = new Map<PropertyKey, number>();
      const list = new Proxy([P2.toUpperCase(), P1], {
        get(t, key, recv) {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return Reflect.get(t, key, recv);
        },
      });
      expect(parse({ kind: "projects", projectIds: list })).toEqual({ ok: true, scope: { kind: "projects", projectIds: [P2, P1] } });
      expect([reads.get("length"), reads.get("0"), reads.get("1")]).toEqual([1, 1, 1]);
    });

    it("ordinary arrays keep their own reasons: empty, beyond the cap, and exactly the cap (non-vacuity)", () => {
      const ids = Array.from({ length: MAX_PROJECT_SCOPE + 1 }, (_, i) => `${i}`.padStart(8, "0") + "-2222-4222-8222-222222222222");
      expect(reason(parse({ kind: "projects", projectIds: [] }))).toBe(SCOPE_ERRORS.projectIdsEmpty);
      expect(reason(parse({ kind: "projects", projectIds: ids }))).toBe(SCOPE_ERRORS.projectIdsTooMany);
      const atCap = parse({ kind: "projects", projectIds: ids.slice(0, MAX_PROJECT_SCOPE) });
      expect(atCap.ok && atCap.scope.kind === "projects" && atCap.scope.projectIds.length).toBe(MAX_PROJECT_SCOPE);
    });
  });

  /**
   * Review S2 — any read of an untrusted object can throw. The parser and the policy return the FIXED
   * invalid-request refusal instead, and never echo the thrown text (asserted by exact equality).
   */
  describe("a request whose reads throw is refused, never rethrown or echoed (S2)", () => {
    const SENTINEL = "S2_SENTINEL_THROWN_TEXT";
    const boom = (): never => {
      throw new Error(SENTINEL);
    };
    const INVALID = { ok: false, error: "invalid request" };
    const revoked = (target: object): object => {
      const r = Proxy.revocable(target, {});
      r.revoke();
      return r.proxy;
    };
    const exp = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();
    /** Legal scalars, so the policy's refusal can only come from the throwing read under test. */
    const base = () => ({ memberId: MEMBER, expiresAt: exp });

    const THROWING: [label: string, request: () => unknown][] = [
      ["a revoked whole-request proxy (throws inside Array.isArray)", () => revoked({ ...base(), scope: ALL_REACHABLE })],
      ["a whole-request proxy whose own-key check throws", () => new Proxy({ ...base(), scope: ALL_REACHABLE }, { getOwnPropertyDescriptor: boom })],
      ["a throwing scope getter", () => ({ ...base(), get scope() { return boom(); } })],
      ["a revoked scope proxy", () => ({ ...base(), scope: revoked({ kind: "all-reachable" }) })],
      ["a scope proxy whose ownKeys trap throws", () => ({ ...base(), scope: new Proxy({ kind: "all-reachable" }, { ownKeys: boom }) })],
      ["a throwing kind getter", () => ({ ...base(), scope: { get kind() { return boom(); } } })],
      ["a throwing projectIds getter", () => ({ ...base(), scope: { kind: "projects", get projectIds() { return boom(); } } })],
      ["a revoked projectIds proxy", () => ({ ...base(), scope: { kind: "projects", projectIds: revoked([P1]) } })],
      [
        "a throwing length trap",
        () => ({ ...base(), scope: { kind: "projects", projectIds: new Proxy([P1], { get: (t, k, r) => (k === "length" ? boom() : Reflect.get(t, k, r)) }) } }),
      ],
      ["a throwing own-index check", () => ({ ...base(), scope: { kind: "projects", projectIds: new Proxy([P1], { getOwnPropertyDescriptor: boom }) } })],
      [
        "a throwing index getter",
        () => {
          const ids: unknown[] = [];
          Object.defineProperty(ids, 0, { enumerable: true, get: boom });
          return { ...base(), scope: { kind: "projects", projectIds: ids } };
        },
      ],
    ];

    for (const [label, request] of THROWING) {
      it(`parser and policy refuse ${label}`, () => {
        expect(parseTokenMintScope(request())).toEqual(INVALID);
        expect(validateMintRequest(request(), NOW)).toEqual(INVALID);
      });
    }

    for (const field of ["memberId", "onBehalfOf", "name", "expiresAt"] as const) {
      it(`policy refuses a throwing ${field} getter, before any field rule`, () => {
        const req: Record<string, unknown> = { memberId: MEMBER, scope: ALL_REACHABLE, expiresAt: exp };
        delete req[field];
        Object.defineProperty(req, field, { enumerable: true, get: boom });
        expect(validateMintRequest(req, NOW)).toEqual(INVALID);
      });
    }

    it("non-throwing getters are still read ONCE and their first values are what the policy returns (control)", () => {
      const reads: Record<string, number> = {};
      const once = <T>(key: string, first: T, later: unknown) => () => {
        reads[key] = (reads[key] ?? 0) + 1;
        return reads[key] === 1 ? first : later;
      };
      const req = Object.defineProperties({} as Record<string, unknown>, {
        memberId: { enumerable: true, get: once("memberId", MEMBER, "not-a-uuid") },
        onBehalfOf: { enumerable: true, get: once("onBehalfOf", null, MEMBER) },
        name: { enumerable: true, get: once("name", "first", 5) },
        expiresAt: { enumerable: true, get: once("expiresAt", exp, "never") },
        scope: { enumerable: true, get: once("scope", { kind: "projects", projectIds: [P1] }, ALL_REACHABLE) },
      });
      expect(validateMintRequest(req, NOW)).toEqual({
        ok: true,
        request: { memberId: MEMBER, onBehalfOf: null, scope: { kind: "projects", projectIds: [P1] }, name: "first", expiresAt: exp },
      });
      expect(reads).toEqual({ memberId: 1, onBehalfOf: 1, name: 1, expiresAt: 1, scope: 1 });
    });
  });

  it("policy returns the same normalized copy (not the raw input) for the action to consume", () => {
    const EXP_FOR_COPY = new Date(NOW + 10 * 24 * 60 * 60 * 1000).toISOString();
    const list = [P1.toUpperCase()];
    const req = { memberId: MEMBER, scope: { kind: "projects", projectIds: list }, expiresAt: EXP_FOR_COPY, name: "x".repeat(250) };
    const r = validateMintRequest(req, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    list[0] = P2;
    req.memberId = "22222222-2222-4222-8222-000000000000";
    expect(r.request).toEqual({
      memberId: MEMBER,
      onBehalfOf: null,
      scope: { kind: "projects", projectIds: [P1] },
      name: "x".repeat(200),
      expiresAt: EXP_FOR_COPY,
    });
  });
});
