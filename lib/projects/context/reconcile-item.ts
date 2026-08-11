import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { ensureIncludeMembership, closeOtherMemberships } from "@/lib/projects/context/memberships";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * Partition ONE item into the §11 system topology: reconcile its item-grain unit (audience
 * mirrored from the item's current access), route an include membership into General (team) or
 * external-shared (external) by that reconciled audience, and CLOSE any membership into the
 * other system project (the move — a tier flip must not leave the item in both). This is the
 * per-item core shared by two callers (spec §11.2):
 *
 *   - the §11 BACKFILL (`backfill.ts`) — the one-time sweep over the pre-existing corpus;
 *   - the INGEST HOOK (this slice) — runs on every push so NEW content is partitioned
 *     immediately, not only when a sweep next runs.
 *
 * Idempotent and self-healing on re-run. Returns `skipped:true` (not an error) when the team's
 * system projects don't exist yet — a team ingested before its bootstrap ran; the bootstrap +
 * backfill cover it, so the hook must not fail the push over it.
 */

export interface ReconcileItemResult {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  unitId?: string;
  unitCreated?: boolean;
  membershipCreated?: boolean;
}

/**
 * Resolve the two §11 system project ids (kind='system') for a team.
 *   { ids } — bootstrapped;  null — not bootstrapped yet (or a squatter holds the slug);
 *   undefined — the read FAILED (distinct from null so a caller doesn't mask an outage as a skip).
 */
export async function systemProjectIds(
  db: DbClient,
  teamId: string
): Promise<{ general: string; externalShared: string } | null | undefined> {
  const { data, error } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", teamId)
    // kind='system' is load-bearing (slice-5 Fable HIGH): a dashboard-created initiative can hold
    // the slug 'general'/'external-shared' (bootstrap REFUSES to adopt it, slice 3). Without this
    // filter the hook would resolve the squatter's id and partition into it — the hook and the
    // sweep diverging in exactly the refusal case the shared core exists to prevent. A squat now
    // resolves to null → skipped, and the scheduler backstop surfaces the bootstrap refusal.
    .eq("kind", "system")
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  // A read ERROR is not "no system projects yet": returning null would mask an outage as a
  // benign skip. Signal it so the caller can distinguish (systemProjectIds returns undefined on
  // error; reconcileItemContext surfaces it as !ok, not skipped).
  if (error) return undefined;
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  const general = bySlug.get(GENERAL_SLUG);
  const externalShared = bySlug.get(EXTERNAL_SHARED_SLUG);
  if (!general || !externalShared) return null;
  return { general, externalShared };
}

export async function reconcileItemContext(
  db: DbClient,
  teamId: string,
  itemId: string,
  sys?: { general: string; externalShared: string }
): Promise<ReconcileItemResult> {
  let projects = sys;
  if (!projects) {
    const resolved = await systemProjectIds(db, teamId);
    if (resolved === undefined) return { ok: false, error: "system project read failed" };
    if (resolved === null) return { ok: true, skipped: true }; // team not bootstrapped yet
    projects = resolved;
  }

  const unit = await reconcileItemUnit(db, teamId, itemId);
  if (!unit.ok || !unit.unitId || !unit.audience) return { ok: false, error: `unit: ${unit.error}` };

  const target = unit.audience === "external" ? projects.externalShared : projects.general;
  const m = await ensureIncludeMembership(db, teamId, { projectId: target, contextUnitId: unit.unitId });
  if (!m.ok) return { ok: false, error: `membership: ${m.error}` };

  const closed = await closeOtherMemberships(db, teamId, unit.unitId, target);
  if (!closed.ok) return { ok: false, error: `move: ${closed.error}` };

  return { ok: true, unitId: unit.unitId, unitCreated: unit.created, membershipCreated: m.created };
}
