import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { linearAdapter } from "./linear";
import { slackAdapter } from "./slack";
import { githubAdapter } from "./github";
import type {
  ProvisioningAdapter,
  ProvisioningMember,
  ProvisioningResult,
  ProvisioningStatus,
  ProvisioningTool,
} from "./types";

/**
 * THE SINGLE WRITER of the `member_provisioning` table (CLAUDE.md §2). Runs the requested tool
 * adapters for one member, upserts one row per (team, member, tool), and audits each outcome
 * (`member.provisioned`, tool + status only — never emails/links). `runProvisioning` NEVER throws:
 * adapters are defensive, `Promise.allSettled` catches anything that slips through, and the
 * DB/audit writes are best-effort.
 */

const ADAPTERS: Record<ProvisioningTool, ProvisioningAdapter> = {
  linear: linearAdapter,
  slack: slackAdapter,
  github: githubAdapter,
};

export const ALL_TOOLS: ProvisioningTool[] = ["linear", "slack", "github"];

/** Resolve the tool selection: "all" → every adapter; "none"/[] → none; a list → de-duped + valid. */
export function resolveRequestedTools(
  tools: ProvisioningTool[] | "all" | "none"
): ProvisioningTool[] {
  if (tools === "none") return [];
  if (tools === "all") return [...ALL_TOOLS];
  const seen = new Set<ProvisioningTool>();
  for (const t of tools) if (ALL_TOOLS.includes(t)) seen.add(t);
  return [...seen];
}

async function upsertProvisioning(
  db: DbClient,
  teamId: string,
  memberId: string,
  r: ProvisioningResult
): Promise<void> {
  const now = new Date().toISOString();
  const meta: Record<string, unknown> = r.inviteLink ? { inviteLink: r.inviteLink } : {};
  await db.from("member_provisioning").upsert(
    {
      team_id: teamId,
      member_id: memberId,
      tool: r.tool,
      status: r.status,
      detail: r.detail,
      meta,
      updated_at: now,
    },
    { onConflict: "team_id,member_id,tool" }
  );
}

export async function runProvisioning(
  db: DbClient,
  teamId: string,
  member: ProvisioningMember,
  tools: ProvisioningTool[] | "all" | "none",
  fetchImpl: typeof fetch = fetch
): Promise<ProvisioningResult[]> {
  const requested = resolveRequestedTools(tools);
  if (requested.length === 0) return [];

  const settled = await Promise.allSettled(
    requested.map((t) => ADAPTERS[t].invite(db, teamId, member, fetchImpl))
  );
  const results: ProvisioningResult[] = requested.map((tool, i) => {
    const s = settled[i];
    if (s.status === "fulfilled") return s.value;
    // Defensive: adapters shouldn't throw, but a rejected promise still becomes a failed result.
    return { tool, status: "failed" as ProvisioningStatus, detail: String(s.reason) };
  });

  for (const r of results) {
    try {
      await upsertProvisioning(db, teamId, member.id, r);
      await audit(db, {
        team_id: teamId,
        actor_kind: "system",
        action: "member.provisioned",
        target_type: "member",
        target_id: member.id,
        meta: { tool: r.tool, status: r.status }, // never emails/links
      });
    } catch {
      // provisioning must never take the caller down — persistence is best-effort
    }
  }

  return results;
}

/** Per-tool configured/reason for a team — the later UI PR renders availability from this. */
export async function getProvisioningAvailability(
  db: DbClient,
  teamId: string
): Promise<Array<{ tool: ProvisioningTool; configured: boolean; reason?: string }>> {
  return Promise.all(
    ALL_TOOLS.map(async (tool) => {
      try {
        const { configured, reason } = await ADAPTERS[tool].isConfigured(db, teamId);
        return { tool, configured, reason };
      } catch (e) {
        return { tool, configured: false, reason: e instanceof Error ? e.message : "check failed" };
      }
    })
  );
}

export type MemberProvisioningRow = ProvisioningResult & { updatedAt: string };

/** Current provisioning rows for one member (for the members page). Read path — no writes. */
export async function getMemberProvisioning(
  db: DbClient,
  teamId: string,
  memberId: string
): Promise<MemberProvisioningRow[]> {
  const { data, error } = await db
    .from("member_provisioning")
    .select("tool, status, detail, meta, updated_at")
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .order("tool", { ascending: true });
  if (error) throw new Error(`load member provisioning failed: ${error.message}`);
  return (data ?? []).map((r) => {
    const meta = (r.meta as Record<string, unknown> | null) ?? {};
    const inviteLink = typeof meta.inviteLink === "string" ? meta.inviteLink : undefined;
    return {
      tool: r.tool as ProvisioningTool,
      status: r.status as ProvisioningStatus,
      detail: (r.detail as string) ?? "",
      inviteLink,
      updatedAt: r.updated_at as string,
    };
  });
}
