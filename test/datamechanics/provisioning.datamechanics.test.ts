import { describe, expect, it } from "vitest";
import { upsertIntegration, setIntegrationStatus } from "@/lib/integrations/manage";
import { runProvisioning, getMemberProvisioning } from "@/lib/provisioning/run";
import type { ProvisioningMember } from "@/lib/provisioning/types";
import { db, seedTeam } from "./helpers";

// Spec: runProvisioning is the SINGLE WRITER of member_provisioning. It upserts one row per
// (team, member, tool) — re-running updates the same row (never duplicates) — and the rows
// cascade-delete with the member. Verified to the observable outcome on real Postgres.

// A fetch that throws: the deterministic paths here (slack link-mode; linear/github skipped for
// lack of config) must never reach the network, and runProvisioning must still not throw.
const noNetwork = (() => {
  throw new Error("no network expected in this data-mechanics path");
}) as unknown as typeof fetch;

function member(id: string, over: Partial<ProvisioningMember> = {}): ProvisioningMember {
  return { id, email: "invitee@test.local", displayName: "Invitee", role: "member", tier: "team", ...over };
}

describe("member provisioning (real Postgres)", () => {
  it("upserts one row per tool and updates in place on re-run", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const m = member(seed.memberId);

    // Slack configured with a standing join link → deterministic link_provided (no network).
    await upsertIntegration(db(), auth, {
      type: "slack",
      name: "slack",
      config: { inviteLink: "https://join.slack.com/t/x/abc" },
    });

    // Run 1: all tools. slack → link_provided; linear/github → skipped (unconfigured).
    const first = await runProvisioning(db(), seed.teamId, m, "all", noNetwork);
    expect(new Set(first.map((r) => r.tool))).toEqual(new Set(["linear", "slack", "github"]));
    expect(first.find((r) => r.tool === "slack")?.status).toBe("link_provided");

    let rows = await getMemberProvisioning(db(), seed.teamId, seed.memberId);
    expect(rows).toHaveLength(3);
    const slackRow = rows.find((r) => r.tool === "slack");
    expect(slackRow?.status).toBe("link_provided");
    expect(slackRow?.inviteLink).toBe("https://join.slack.com/t/x/abc");
    const firstSlackUpdatedAt = slackRow!.updatedAt;

    // Audit: one member.provisioned per tool.
    const { data: audits } = await db()
      .from("audit_log")
      .select("action, meta")
      .eq("team_id", seed.teamId)
      .eq("action", "member.provisioned");
    expect(audits!.length).toBe(3);
    // Audit meta carries tool + status ONLY — never the invite link / email.
    expect(JSON.stringify(audits)).not.toContain("join.slack.com");
    expect(JSON.stringify(audits)).not.toContain("invitee@test.local");

    // Disable slack, re-run: the SAME slack row flips to skipped (no duplicate row).
    const { data: slackInteg } = await db()
      .from("integrations")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("type", "slack")
      .single();
    await setIntegrationStatus(db(), auth, slackInteg.id, "disabled");

    await runProvisioning(db(), seed.teamId, m, "all", noNetwork);
    rows = await getMemberProvisioning(db(), seed.teamId, seed.memberId);
    expect(rows).toHaveLength(3); // still one row per tool
    const slack2 = rows.find((r) => r.tool === "slack");
    expect(slack2?.status).toBe("skipped");
    expect(new Date(slack2!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(firstSlackUpdatedAt).getTime());
  });

  it("cascade-deletes provisioning rows when the member is removed", async () => {
    const seed = await seedTeam();
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "slack",
      name: "slack",
      config: { inviteLink: "https://join.slack.com/t/x/abc" },
    });
    await runProvisioning(db(), seed.teamId, member(seed.memberId), "all", noNetwork);
    expect(await getMemberProvisioning(db(), seed.teamId, seed.memberId)).toHaveLength(3);

    await db().from("members").delete().eq("id", seed.memberId);

    const { data } = await db()
      .from("member_provisioning")
      .select("id")
      .eq("member_id", seed.memberId);
    expect(data ?? []).toHaveLength(0);
  });
});
