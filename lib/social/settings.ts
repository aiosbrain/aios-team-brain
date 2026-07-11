import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { AUTONOMY_LEVELS, DEFAULT_AUTONOMY, type AutonomyLevel } from "./autonomy";

/**
 * SINGLE WRITER for the `social_settings` table (CLAUDE.md §2) — the per-team autonomy level that
 * gates the approval workflow. Defaults to `draft_only` (nothing advances past a draft) until an
 * admin raises it. Guarded by test/guards/single-writer-social-settings.
 */

export async function getAutonomy(db: DbClient, teamId: string): Promise<AutonomyLevel> {
  const { data } = await db.from("social_settings").select("autonomy").eq("team_id", teamId).maybeSingle();
  const level = (data as { autonomy?: string } | null)?.autonomy;
  return (level && (AUTONOMY_LEVELS as string[]).includes(level) ? level : DEFAULT_AUTONOMY) as AutonomyLevel;
}

export async function setAutonomy(
  db: DbClient,
  teamId: string,
  level: AutonomyLevel,
  actor: { memberId?: string | null } = {}
): Promise<void> {
  if (!AUTONOMY_LEVELS.includes(level)) throw new Error(`invalid autonomy level "${level}"`);
  const { error } = await db
    .from("social_settings")
    .upsert({ team_id: teamId, autonomy: level, updated_at: new Date().toISOString() }, { onConflict: "team_id" });
  if (error) throw new Error(`setAutonomy failed: ${error.message}`);
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "social.autonomy_set",
    target_type: "social_settings",
    target_id: teamId,
    meta: { autonomy: level },
  });
}
