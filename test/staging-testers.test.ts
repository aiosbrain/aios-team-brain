/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { reapplyTesterCredentials } from "../scripts/staging-ops/reapply-testers";

/**
 * ONE CONDITION PER FIXTURE.
 *
 * The refusal this file guards is a conjunction — the member must exist, and its email, role,
 * posture and active status must all match the configured tester — but the negative case only ever
 * varied POSTURE while its title claimed "missing or widened identities". A fixture that trips one
 * term of a conjunction proves nothing about the other four: delete the `status !== "active"` test
 * and every assertion here would have stayed green while a suspended tester got a fresh password.
 *
 * The four identity terms deliberately share one refusal message — the code says nothing about
 * WHICH term failed, so that a misconfiguration cannot be used to enumerate real members. These
 * rows therefore discriminate by CONSTRUCTION (one changed field each), not by message text, and
 * that is stated here rather than papered over with an assertion that cannot hold.
 */

const VALID_ROW = { id: "member", team_id: "team", email: "tester@example.test", role: "member", status: "active" };

function db({ row = VALID_ROW as any, teamPosture = true, error = null as { message: string } | null } = {}) {
  const member: any = {
    select: vi.fn(() => member),
    eq: vi.fn(() => member),
    maybeSingle: vi.fn().mockResolvedValue({ data: error ? null : row, error }),
  };
  const groups: any = {
    select: vi.fn(() => groups),
    eq: vi.fn(() => groups),
    then: (resolve: (value: unknown) => void) =>
      resolve({ data: teamPosture ? [{ groups: { slug: "everyone", is_builtin: true } }] : [], error: null }),
  };
  return { from: vi.fn((name: string) => (name === "members" ? member : groups)) } as never;
}

const tester = {
  email: "tester@example.test",
  password: "a-strong-staging-password",
  teamId: "team",
  memberId: "member",
  role: "member",
  posture: "team" as const,
};

describe("staging-only tester credential reapply", () => {
  it("updates only a byte-matching existing member posture through the auth writer", async () => {
    const set = vi.fn();
    await expect(reapplyTesterCredentials(db(), [tester], set)).resolves.toBe(1);
    expect(set).toHaveBeenCalledWith(tester.email, tester.password);
  });

  it.each([
    ["the member does not exist", { row: null }],
    ["the stored email is a different address", { row: { ...VALID_ROW, email: "someone-else@example.test" } }],
    ["the stored role is not the configured role", { row: { ...VALID_ROW, role: "admin" } }],
    ["the member is not active", { row: { ...VALID_ROW, status: "invited" } }],
    ["the posture is wider than the configured one", { teamPosture: false }],
  ])("refuses before writing a credential when %s", async (_name, options) => {
    const set = vi.fn();
    await expect(reapplyTesterCredentials(db(options), [tester], set))
      .rejects.toThrow(/identity\/posture mismatch; refusing to grant or widen access/);
    // The load-bearing half: the refusal has to happen BEFORE the password writer, not instead of
    // reporting success afterwards.
    expect(set, "a credential was written despite the refusal").not.toHaveBeenCalled();
  });

  it("refuses with its OWN message when the identity lookup itself fails", async () => {
    // A read failure is not a mismatch: it means we could not check, and telling the two apart is
    // what keeps an outage from being reported as a misconfigured tester.
    const set = vi.fn();
    await expect(reapplyTesterCredentials(db({ error: { message: "connection terminated" } }), [tester], set))
      .rejects.toThrow(/tester identity verification failed: connection terminated/);
    expect(set).not.toHaveBeenCalled();
  });

  it("refuses a weak or incomplete credential before it ever reaches the database", async () => {
    const set = vi.fn();
    const from = vi.fn();
    await expect(reapplyTesterCredentials({ from } as never, [{ ...tester, password: "short" }], set))
      .rejects.toThrow(/incomplete or weak/);
    expect(from, "a weak credential still queried the database").not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
