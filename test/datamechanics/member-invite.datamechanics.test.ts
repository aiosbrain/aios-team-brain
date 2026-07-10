import { describe, expect, it } from "vitest";
import { upsertIntegration } from "@/lib/integrations/manage";
import { issueMemberInvite } from "@/lib/admin/invite";
import { getMemberProvisioning } from "@/lib/provisioning/run";
import { db, seedTeam } from "./helpers";

// Spec: the shared invite core (lib/admin/invite.issueMemberInvite) — used by BOTH the admin action
// and POST /api/v1/members/invite — grants access and runs the provisioning cascade for an
// already-existing member. Re-inviting the SAME member must UPSERT the provisioning rows (one per
// tool), never duplicate them — the idempotency the REST re-invite (created:false) relies on.
// Verified to the observable outcome on real Postgres, in manual mode (deterministic, no network:
// Slack is link-mode, linear/github are unconfigured → skipped, so no adapter reaches fetch).

describe("issueMemberInvite — idempotent re-invite (real Postgres)", () => {
  it("re-runs provisioning in place (no duplicate rows) and sets a manual password + message", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const member = {
      id: seed.memberId,
      email: "invitee@test.local",
      displayName: "Invitee",
      role: "member" as const,
      tier: "team" as const,
    };

    await upsertIntegration(db(), auth, {
      type: "slack",
      name: "slack",
      config: { inviteLink: "https://join.slack.com/t/x/abc" },
    });

    const first = await issueMemberInvite(db(), {
      teamId: seed.teamId,
      member,
      teamName: "Acme",
      inviterName: "Grace Hopper",
      nextPath: `/t/${seed.teamSlug}`,
      teamUrl: "https://brain.acme.test",
      tools: "all",
      manual: true,
      password: "example-invite-password",
      actor: { kind: "member", memberId: seed.memberId },
    });

    // Fetch impl is default here (unused in these deterministic paths); assert the manual outcome.
    expect(first.ok).toBe(true);
    if (!first.ok || first.mode !== "manual") throw new Error("expected manual mode");
    expect(first.password).toBe("example-invite-password");
    expect(first.inviteMessage).toContain("Sign in at: https://brain.acme.test");
    expect(first.provisioning.find((r) => r.tool === "slack")?.status).toBe("link_provided");

    const afterFirst = await getMemberProvisioning(db(), seed.teamId, seed.memberId);
    expect(afterFirst).toHaveLength(3); // one row per tool
    expect(afterFirst.find((r) => r.tool === "slack")?.inviteLink).toBe("https://join.slack.com/t/x/abc");

    // Re-invite the SAME member → the same three rows are upserted, never duplicated.
    const second = await issueMemberInvite(db(), {
      teamId: seed.teamId,
      member,
      teamName: "Acme",
      inviterName: "Grace Hopper",
      nextPath: `/t/${seed.teamSlug}`,
      teamUrl: "https://brain.acme.test",
      tools: "all",
      manual: true,
      password: "second-invite-password",
      actor: { kind: "member", memberId: seed.memberId },
    });
    expect(second.ok).toBe(true);

    const afterSecond = await getMemberProvisioning(db(), seed.teamId, seed.memberId);
    expect(afterSecond).toHaveLength(3); // still exactly one row per tool — upserted, not duplicated
  });

  it("provisions nothing when tools = 'none' (empty cascade)", async () => {
    const seed = await seedTeam();
    const res = await issueMemberInvite(db(), {
      teamId: seed.teamId,
      member: {
        id: seed.memberId,
        email: "invitee@test.local",
        displayName: "Invitee",
        role: "member",
        tier: "team",
      },
      teamName: "Acme",
      inviterName: "Grace Hopper",
      nextPath: `/t/${seed.teamSlug}`,
      teamUrl: "https://brain.acme.test",
      tools: "none",
      manual: true,
      password: "example-invite-password",
      actor: { kind: "member", memberId: seed.memberId },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.provisioning).toHaveLength(0);
    expect(await getMemberProvisioning(db(), seed.teamId, seed.memberId)).toHaveLength(0);
  });
});
