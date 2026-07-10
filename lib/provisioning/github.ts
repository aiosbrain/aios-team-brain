import "server-only";
import type { DbClient } from "@/lib/db/types";
import { enabledIntegration } from "./integration";
import type { ProvisioningAdapter, ProvisioningMember, ProvisioningResult } from "./types";

/**
 * GitHub provisioning adapter. Invites a member into a GitHub org via
 * `POST /orgs/{org}/invitations` (role `direct_member`). GitHub emails the invite → status `sent`.
 *
 * Config (non-secret, in the enabled `github` integration's `config`):
 *   - org: the GitHub org login new members are invited into.
 * Token: the github integration's decrypted secret, falling back to `process.env.GITHUB_TOKEN`.
 */

type GithubErrorBody = { message?: string; errors?: Array<{ message?: string }> } | null;

function ghErrorText(body: GithubErrorBody, status: number): string {
  const parts = [
    body?.message,
    ...(Array.isArray(body?.errors) ? body!.errors.map((e) => e?.message) : []),
  ].filter(Boolean);
  return parts.join("; ") || `HTTP ${status}`;
}

function resolveToken(integSecret: string | null | undefined): string {
  return integSecret || process.env.GITHUB_TOKEN || "";
}

export const githubAdapter: ProvisioningAdapter = {
  tool: "github",

  async isConfigured(db: DbClient, teamId: string) {
    const integ = await enabledIntegration(db, teamId, "github");
    const org = typeof integ?.config?.org === "string" ? integ.config.org : "";
    if (!org) return { configured: false, reason: "no GitHub org set" };
    if (!resolveToken(integ?.secret)) {
      return { configured: false, reason: "no GitHub token (connect one, or set GITHUB_TOKEN)" };
    }
    return { configured: true };
  },

  async invite(
    db: DbClient,
    teamId: string,
    member: ProvisioningMember,
    fetchImpl: typeof fetch
  ): Promise<ProvisioningResult> {
    const integ = await enabledIntegration(db, teamId, "github");
    const org = typeof integ?.config?.org === "string" ? integ.config.org : "";
    if (!org) {
      return {
        tool: "github",
        status: "skipped",
        detail: "set a GitHub org in Admin → Integrations → Member onboarding",
      };
    }
    const token = resolveToken(integ?.secret);

    try {
      const res = await fetchImpl(`https://api.github.com/orgs/${org}/invitations`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "aios-team-brain",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: member.email, role: "direct_member" }),
      });

      if (res.status === 201) {
        return { tool: "github", status: "sent", detail: `GitHub org invite sent to ${member.email}` };
      }

      const body = (await res.json().catch(() => null)) as GithubErrorBody;
      const text = ghErrorText(body, res.status);

      // 422 for an already-member / pending-invite is expected → skipped (the person is reachable).
      if (res.status === 422) {
        if (/already|pending/i.test(text)) return { tool: "github", status: "skipped", detail: text };
        return { tool: "github", status: "failed", detail: `GitHub invite rejected (422): ${text}` };
      }
      if (res.status === 403 || res.status === 404) {
        return {
          tool: "github",
          status: "failed",
          detail: `GitHub token lacks admin:org scope for org '${org}' (or org not found)`,
        };
      }
      return { tool: "github", status: "failed", detail: `GitHub invite failed (${res.status}): ${text}` };
    } catch (e) {
      return { tool: "github", status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  },
};
