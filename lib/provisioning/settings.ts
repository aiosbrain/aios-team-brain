import "server-only";
import type { DbClient } from "@/lib/db/types";
import { upsertIntegration, type IntegrationAuth } from "@/lib/integrations/manage";

/**
 * Persistence for the Admin → Integrations "Member onboarding" panel. Merges ONLY the non-secret
 * provisioning invite hints into each tool's canonical integration row's config, through the
 * single-writer `upsertIntegration` (which validates + audits). Repos/channels/pm-mapping already
 * in a row's config are preserved; secrets are never touched here. Lives in lib/ (not the app
 * action) so the direct `integrations` read stays out of the dashboard-pages tier-filter guard —
 * the same reason github-link.ts reads it here rather than in a page.
 */

export interface ProvisioningSettingsInput {
  /** Linear team ids to add invitees to (empty clears the hint). */
  linearTeamIds: string[];
  /** "user" | "admin" | "guest", or "" to clear (→ the adapter's tier default). */
  linearRole: string;
  /** Standing Slack workspace join link, or "" to clear. */
  slackInviteLink: string;
  /** GitHub org login new members are invited into, or "" to clear. */
  githubOrg: string;
}

type Row = { name: string; config: Record<string, unknown>; status: "enabled" | "disabled" };

/** Earliest-created canonical row per provisioning tool (or null), for a merge-preserving upsert. */
async function readRows(
  db: DbClient,
  teamId: string
): Promise<Record<"linear" | "slack" | "github", Row | null>> {
  const { data } = await db
    .from("integrations")
    .select("name, type, config, status")
    .eq("team_id", teamId)
    .in("type", ["linear", "slack", "github"])
    .order("created_at", { ascending: true });
  const rows: Record<"linear" | "slack" | "github", Row | null> = { linear: null, slack: null, github: null };
  for (const r of data ?? []) {
    const t = r.type as "linear" | "slack" | "github";
    if (rows[t]) continue; // keep the earliest-created
    rows[t] = {
      name: r.name as string,
      config: ((r.config as Record<string, unknown>) ?? {}) as Record<string, unknown>,
      status: ((r.status as "enabled" | "disabled") ?? "enabled") as "enabled" | "disabled",
    };
  }
  return rows;
}

/** Set a config key to a non-empty value, or delete it when the value is blank (a form clear). */
function setOrClear(config: Record<string, unknown>, key: string, value: unknown): void {
  const empty = value === "" || value === undefined || (Array.isArray(value) && value.length === 0);
  if (empty) delete config[key];
  else config[key] = value;
}

/**
 * Merge the provisioning hints into each tool's canonical integration row. A tool is written only
 * when it already has a row OR the admin supplied a value for it (so blank fields don't spawn empty
 * rows). Throws `IntegrationConfigError` (from `upsertIntegration`) on an invalid value.
 */
export async function saveProvisioningSettings(
  db: DbClient,
  auth: IntegrationAuth,
  input: ProvisioningSettingsInput
): Promise<void> {
  const rows = await readRows(db, auth.teamId);

  const role = ["user", "admin", "guest"].includes(input.linearRole) ? input.linearRole : "";
  if (rows.linear || input.linearTeamIds.length || role) {
    const config = { ...(rows.linear?.config ?? {}) };
    setOrClear(config, "inviteTeamIds", input.linearTeamIds);
    setOrClear(config, "inviteRole", role);
    await upsertIntegration(db, auth, {
      type: "linear",
      name: rows.linear?.name ?? "linear",
      config,
      status: rows.linear?.status ?? "enabled",
    });
  }

  const link = input.slackInviteLink.trim();
  if (rows.slack || link) {
    const config = { ...(rows.slack?.config ?? {}) };
    setOrClear(config, "inviteLink", link);
    await upsertIntegration(db, auth, {
      type: "slack",
      name: rows.slack?.name ?? "slack",
      config,
      status: rows.slack?.status ?? "enabled",
    });
  }

  const org = input.githubOrg.trim();
  if (rows.github || org) {
    const config = { ...(rows.github?.config ?? {}) };
    setOrClear(config, "org", org);
    await upsertIntegration(db, auth, {
      type: "github",
      name: rows.github?.name ?? "github",
      config,
      status: rows.github?.status ?? "enabled",
    });
  }
}
