/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { reapplyTesterCredentials } from "../scripts/staging-ops/reapply-testers";

function db(row: any, teamPosture = true) {
  const member: any = { select: vi.fn(() => member), eq: vi.fn(() => member), maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }) };
  const groups: any = { select: vi.fn(() => groups), eq: vi.fn(() => groups), then: (resolve: (value: unknown) => void) => resolve({ data: teamPosture ? [{ groups: { slug: "everyone", is_builtin: true } }] : [], error: null }) };
  return { from: vi.fn((name: string) => name === "members" ? member : groups) } as never;
}

describe("staging-only tester credential reapply", () => {
  const tester = { email: "tester@example.test", password: "a-strong-staging-password", teamId: "team", memberId: "member", role: "member", posture: "team" as const };
  it("updates only a byte-matching existing member posture through the auth writer", async () => {
    const set = vi.fn();
    await expect(reapplyTesterCredentials(db({ id: "member", team_id: "team", email: tester.email, role: "member", status: "active" }), [tester], set)).resolves.toBe(1);
    expect(set).toHaveBeenCalledWith(tester.email, tester.password);
  });
  it("refuses missing or widened identities before writing credentials", async () => {
    const set = vi.fn();
    await expect(reapplyTesterCredentials(db({ id: "member", team_id: "team", email: tester.email, role: "member", status: "active" }, false), [tester], set)).rejects.toThrow(/posture mismatch/);
    expect(set).not.toHaveBeenCalled();
  });
});
