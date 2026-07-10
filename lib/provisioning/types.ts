import type { DbClient } from "@/lib/db/types";

/**
 * Member-provisioning core types (the tool-invite cascade). An adapter knows how to invite ONE
 * member into ONE external tool (Linear / Slack / GitHub) from the team's enabled integration
 * config. Adapters NEVER throw — every failure is a `ProvisioningResult` with status `failed`.
 * The single writer of the `member_provisioning` table is `lib/provisioning/run.ts`.
 */

export type ProvisioningTool = "linear" | "slack" | "github";

// sent          — the provider accepted the invite and will email it (Linear / GitHub)
// link_provided — a standing join link was surfaced (Slack Free/Pro has no invite API)
// skipped        — not configured, or the member is already a member / already invited
// failed         — the provider call errored (token scope, org not found, network, …)
export type ProvisioningStatus = "sent" | "link_provided" | "skipped" | "failed";

export type ProvisioningResult = {
  tool: ProvisioningTool;
  status: ProvisioningStatus;
  detail: string;
  /** For `link_provided`: the standing workspace join link (a link, never a secret token). */
  inviteLink?: string;
};

export type ProvisioningMember = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "lead" | "member";
  tier: "team" | "external";
};

export type ProvisioningAdapter = {
  tool: ProvisioningTool;
  /** Cheap read: is this tool wired up for provisioning on this team? (drives the later UI PR). */
  isConfigured(db: DbClient, teamId: string): Promise<{ configured: boolean; reason?: string }>;
  /** Invite one member. NEVER throws — errors become a `failed` result. */
  invite(
    db: DbClient,
    teamId: string,
    member: ProvisioningMember,
    fetchImpl: typeof fetch
  ): Promise<ProvisioningResult>;
};
