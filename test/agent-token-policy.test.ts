import { describe, expect, it } from "vitest";
import {
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
