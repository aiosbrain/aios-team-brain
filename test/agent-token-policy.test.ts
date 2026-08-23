import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PROJECT_SCOPE,
  canSubmitMint,
  expiryInstantFor,
  validateMintRequest,
  MAX_TOKEN_LIFETIME_MS,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  type MintRequest,
} from "@/lib/access/agent-token-policy";

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

/** A request that is legal in every respect, so each test varies exactly one thing. */
function legal(over: Partial<MintRequest> = {}): MintRequest {
  return {
    memberId: MEMBER,
    expiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function errorFor(req: MintRequest): string {
  const r = validateMintRequest(req, NOW);
  return r.ok ? "(accepted)" : r.error;
}

describe("agent token mint policy", () => {
  it("accepts the legal baseline (non-vacuity: if this fails, every refusal below proves nothing)", () => {
    expect(validateMintRequest(legal(), NOW)).toEqual({ ok: true });
  });

  describe("acting-as is refused server-side, not merely hidden from the form", () => {
    it("refuses onBehalfOf even when it is a well-formed member uuid", () => {
      expect(errorFor(legal({ onBehalfOf: "33333333-3333-4333-8333-333333333333" }))).toMatch(/self-only/);
    });

    it("still accepts an explicit null (absent acting-as is the normal case)", () => {
      expect(validateMintRequest(legal({ onBehalfOf: null }), NOW)).toEqual({ ok: true });
    });
  });

  describe("scope: inherit is legal, 'sees nothing' is not a legal request", () => {
    it("accepts an omitted scope (inherit the launcher's projects)", () => {
      expect(validateMintRequest(legal(), NOW)).toEqual({ ok: true });
    });

    it("accepts an explicit null scope", () => {
      expect(validateMintRequest(legal({ projectScope: null }), NOW)).toEqual({ ok: true });
    });

    it("REFUSES an empty array — the accidental 'reads nothing' token", () => {
      expect(errorFor(legal({ projectScope: [] }))).toMatch(/at least one project/);
    });

    it("accepts a populated scope", () => {
      expect(validateMintRequest(legal({ projectScope: [PROJECT] }), NOW)).toEqual({ ok: true });
    });

    it("refuses a scope containing a non-uuid", () => {
      expect(errorFor(legal({ projectScope: [PROJECT, "not-a-uuid"] }))).toMatch(/project uuids/);
    });
  });

  describe("expiry is required and bounded — a null expiry never expires", () => {
    it("refuses an absent expiry", () => {
      expect(errorFor({ memberId: MEMBER })).toMatch(/required/);
    });

    it("refuses an explicitly null expiry", () => {
      expect(errorFor(legal({ expiresAt: null }))).toMatch(/required/);
    });

    it("refuses an empty-string expiry (an untouched date input, not a choice)", () => {
      expect(errorFor(legal({ expiresAt: "" }))).toMatch(/required/);
    });

    it("refuses an unparseable expiry", () => {
      expect(errorFor(legal({ expiresAt: "next tuesday" }))).toMatch(/ISO timestamp/);
    });

    it("refuses an expiry in the past — it would mint an already-dead credential", () => {
      expect(errorFor(legal({ expiresAt: new Date(NOW - 1000).toISOString() }))).toMatch(/in the future/);
    });

    it("refuses an expiry exactly at now (boundary: <= now, not < now)", () => {
      expect(errorFor(legal({ expiresAt: new Date(NOW).toISOString() }))).toMatch(/in the future/);
    });

    it("accepts an expiry exactly at the 365-day cap (boundary: <= max is legal)", () => {
      expect(
        validateMintRequest(legal({ expiresAt: new Date(NOW + MAX_TOKEN_LIFETIME_MS).toISOString() }), NOW)
      ).toEqual({ ok: true });
    });

    it("refuses one millisecond beyond the cap", () => {
      expect(
        errorFor(legal({ expiresAt: new Date(NOW + MAX_TOKEN_LIFETIME_MS + 1).toISOString() }))
      ).toMatch(/365-day maximum/);
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

  it("a deliberate inherit IS submittable", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "inherit" } })).toBe(true);
  });

  it("restrict with zero projects is not submittable — never a silent 'sees nothing'", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "restrict", projectIds: [] } })).toBe(false);
  });

  it("restrict with one project is submittable", () => {
    expect(canSubmitMint({ ...base, scope: { kind: "restrict", projectIds: [PROJECT] } })).toBe(true);
  });

  it("a missing member or a cleared expiry blocks submit", () => {
    expect(canSubmitMint({ memberId: "", expiry: "2026-12-01", scope: { kind: "inherit" } })).toBe(false);
    expect(canSubmitMint({ memberId: MEMBER, expiry: "", scope: { kind: "inherit" } })).toBe(false);
  });
});

/**
 * SPEC AC: two source-level obligations the runtime tests cannot see.
 */
describe("agent-token admin surface obligations", () => {
  const ROOT = join(import.meta.dirname, "..");
  const page = readFileSync(join(ROOT, "app", "t", "[team]", "admin", "agents", "page.tsx"), "utf8");
  const actions = readFileSync(join(ROOT, "app", "t", "[team]", "admin", "agents", "actions.ts"), "utf8");

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
    expect(validateMintRequest({ memberId: MEMBER, expiresAt: instant }, now)).toEqual({ ok: true });
  });

  it("a normal date is unchanged by the clamp (non-vacuity: it does not clamp everything)", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    expect(expiryInstantFor("2026-09-20", now)).toBe("2026-09-20T23:59:59.000Z");
  });
});

describe("policy hardening against malformed input (a public endpoint receives anything)", () => {
  const NOW2 = Date.parse("2026-08-22T12:00:00.000Z");
  const bad = (req: unknown) => validateMintRequest(req as never, NOW2);

  it("refuses null/undefined/array requests instead of throwing", () => {
    for (const r of [null, undefined, [], "nope"]) expect(bad(r).ok).toBe(false);
  });

  it("refuses an ARRAY memberId — RegExp.test coerces, so a type check must come first", () => {
    expect(bad({ memberId: [MEMBER], expiresAt: "2026-09-20T00:00:00.000Z" })).toEqual({
      ok: false,
      error: "memberId must be a member uuid",
    });
  });

  it("refuses a non-ISO date that Date.parse would happily accept", () => {
    expect(bad({ memberId: MEMBER, expiresAt: "12/31/2026" }).ok).toBe(false);
  });

  it("accepts a numeric UTC offset (a legal ISO instant)", () => {
    expect(bad({ memberId: MEMBER, expiresAt: "2026-09-20T10:00:00+02:00" })).toEqual({ ok: true });
  });

  it("refuses a non-array projectScope instead of throwing inside .some()", () => {
    expect(bad({ memberId: MEMBER, expiresAt: "2026-09-20T00:00:00.000Z", projectScope: "x" }).ok).toBe(false);
  });

  it("refuses duplicates and over-cap scope lists", () => {
    const dup = bad({ memberId: MEMBER, expiresAt: "2026-09-20T00:00:00.000Z", projectScope: [PROJECT, PROJECT] });
    expect(dup.ok).toBe(false);
    const many = Array.from({ length: MAX_PROJECT_SCOPE + 1 }, (_, i) => `${i}`.padStart(8, "0") + "-2222-4222-8222-222222222222");
    expect(bad({ memberId: MEMBER, expiresAt: "2026-09-20T00:00:00.000Z", projectScope: many }).ok).toBe(false);
  });

  it("refuses a non-string name", () => {
    expect(bad({ memberId: MEMBER, expiresAt: "2026-09-20T00:00:00.000Z", name: 5 }).ok).toBe(false);
  });
});
