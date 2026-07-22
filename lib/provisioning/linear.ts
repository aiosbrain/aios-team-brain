import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { linearGraphql } from "@/lib/pm-sync/linear-client";
import { enabledIntegration } from "./integration";
import type { ProvisioningAdapter, ProvisioningMember, ProvisioningResult } from "./types";

/**
 * Linear provisioning adapter. Invites a member into the team's Linear organization via the
 * `organizationInviteCreate` GraphQL mutation (Linear auto-sends the invite email → status `sent`).
 *
 * Config (non-secret, in the enabled `linear` integration's `config`):
 *   - inviteRole:    "user" | "admin" | "guest" (default resolves from tier: external→guest else user)
 *   - inviteTeamIds: Linear team ids to add the invitee to (the `teamIds` field is omitted when unset)
 * Secret: the Linear API key in `secret_ciphertext`.
 */

type InviteCreateData = { organizationInviteCreate: { success: boolean } | null };

const INVITE_MUTATION = `mutation($input: OrganizationInviteCreateInput!) {
  organizationInviteCreate(input: $input) { success }
}`;

export const linearAdapter: ProvisioningAdapter = {
  tool: "linear",

  async isConfigured(db: DbClient, teamId: string) {
    const integ = await enabledIntegration(db, teamId, "linear");
    if (!integ) return { configured: false, reason: "no enabled Linear integration" };
    if (!integ.secret) return { configured: false, reason: "Linear API key not set" };
    return { configured: true };
  },

  async invite(
    db: DbClient,
    teamId: string,
    member: ProvisioningMember,
    fetchImpl: typeof fetch
  ): Promise<ProvisioningResult> {
    const integ = await enabledIntegration(db, teamId, "linear");
    if (!integ || !integ.secret) {
      return { tool: "linear", status: "skipped", detail: "connect Linear first (Admin → Integrations)" };
    }
    const config = integ.config ?? {};
    const role =
      (typeof config.inviteRole === "string" && config.inviteRole) ||
      (isRestrictedTier(member.tier) ? "guest" : "user"); // unknown/future tier → least-privileged guest
    const teamIds = Array.isArray(config.inviteTeamIds) ? (config.inviteTeamIds as string[]) : [];
    const input: Record<string, unknown> = { email: member.email, role };
    if (teamIds.length) input.teamIds = teamIds; // omit the field entirely when unset/empty

    try {
      const data = await linearGraphql<InviteCreateData>(fetchImpl, integ.secret, INVITE_MUTATION, {
        input,
      });
      if (data.organizationInviteCreate?.success) {
        return { tool: "linear", status: "sent", detail: `Linear invite email sent to ${member.email}` };
      }
      return { tool: "linear", status: "failed", detail: "Linear did not create the invite (success=false)" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An already-member / already-invited error is not a failure — the person is reachable.
      // Linear's live wording for a duplicate pending invite is exactly "Existing invite."
      // (observed in the 2026-07-10 prod E2E), which a plain /already/i heuristic misses.
      if (/already|existing invite/i.test(msg)) return { tool: "linear", status: "skipped", detail: msg };
      return { tool: "linear", status: "failed", detail: msg };
    }
  },
};
