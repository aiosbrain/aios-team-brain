import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  setIdentity: vi.fn(),
  revalidate: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: h.requireAdmin }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/identity/member-identities", () => ({
  setMemberIdentity: h.setIdentity,
  removeMemberIdentity: vi.fn(),
}));
vi.mock("@/lib/ingest/reconcile-attribution", () => ({
  reconcileAttribution: vi.fn(),
  bustTeamLearningCaches: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("next/server", () => ({ after: h.after }));

import { linkMemberIdentity } from "@/app/t/[team]/admin/members/actions";

describe("admin identity link action", () => {
  beforeEach(() => {
    h.requireAdmin.mockReset().mockResolvedValue({ teamId: "team-1", memberId: "admin-1" });
    h.setIdentity.mockReset();
    h.revalidate.mockReset();
    h.after.mockReset();
  });

  it("returns the raw/qualified counterpart conflict without reporting a successful link", async () => {
    const note = "Slack account TSPACE:UABC has a live raw/qualified counterpart; use the attended identity cutover";
    h.setIdentity.mockResolvedValue({ created: false, updated: false, conflict: true,
      memberId: "member-1", note });

    expect(await linkMemberIdentity("acme", "member-1", "slack", "TSPACE:UABC"))
      .toEqual({ ok: false, error: note });
    expect(h.setIdentity).toHaveBeenCalledWith(
      expect.anything(), "team-1", "member-1",
      { provider: "slack", externalId: "TSPACE:UABC", handle: "" },
      { force: true, explicit: true, actor: { kind: "member", memberId: "admin-1" } }
    );
    expect(h.revalidate).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });

  it("revalidates and schedules repair after a successful link", async () => {
    h.setIdentity.mockResolvedValue({ created: true, updated: false, conflict: false,
      memberId: "member-1" });
    expect(await linkMemberIdentity("acme", "member-1", "slack", "UABC"))
      .toEqual({ ok: true });
    expect(h.revalidate).toHaveBeenCalledWith("/t/acme/admin/members");
    expect(h.after).toHaveBeenCalledOnce();
  });
});
