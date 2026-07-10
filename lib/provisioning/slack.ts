import "server-only";
import type { DbClient } from "@/lib/db/types";
import { enabledIntegration } from "./integration";
import type { ProvisioningAdapter, ProvisioningMember, ProvisioningResult } from "./types";

/**
 * Slack provisioning adapter — LINK MODE ONLY. The workspace is on Slack Free/Pro, which has no
 * invite API, so we surface the team's standing workspace join link and let the member self-join;
 * acceptance is not verifiable (status `link_provided`, never `sent`).
 *
 * Config (non-secret, in the enabled `slack` integration's `config`):
 *   - inviteLink: the standing workspace join link.
 *
 * A future SCIM / `admin.users.invite` mode (paid Slack) would branch here on `config.mode`
 * ("link" today, additive "invite" later) — not built.
 */

export const slackAdapter: ProvisioningAdapter = {
  tool: "slack",

  async isConfigured(db: DbClient, teamId: string) {
    const integ = await enabledIntegration(db, teamId, "slack");
    if (!integ) return { configured: false, reason: "no enabled Slack integration" };
    const link = typeof integ.config?.inviteLink === "string" ? integ.config.inviteLink : "";
    if (!link) return { configured: false, reason: "no Slack invite link set" };
    return { configured: true };
  },

  async invite(
    db: DbClient,
    teamId: string,
    _member: ProvisioningMember,
    _fetchImpl: typeof fetch
  ): Promise<ProvisioningResult> {
    const integ = await enabledIntegration(db, teamId, "slack");
    const link = typeof integ?.config?.inviteLink === "string" ? integ.config.inviteLink : "";
    if (link) {
      return {
        tool: "slack",
        status: "link_provided",
        detail: "standing workspace join link; acceptance is not verified",
        inviteLink: link,
      };
    }
    return {
      tool: "slack",
      status: "skipped",
      detail: "set a Slack invite link in Admin → Integrations → Member onboarding",
    };
  },
};
