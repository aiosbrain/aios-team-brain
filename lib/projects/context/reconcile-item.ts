import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { ensureIncludeMembership, closeMembershipInto, noWideningGate } from "@/lib/projects/context/memberships";
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
 * Idempotent and self-healing on re-run. CONCURRENCY (slice-5 Codex HIGH, deferred with F3):
 * two reconciles for the same item (push hook + scheduler) can read the item's access at
 * different instants during a tier flip; the membership writer's live no-widening re-read
 * narrows the leak window but the unit-audience compare-and-set needed to close it fully wants
 * the transaction surface the adapter does not expose yet (the standing F3 deferral). Rare
 * (concurrent reconcile + a same-instant tier flip) and inert in Phase A. Returns `skipped:true`
 * (not an error) when the team's system projects don't exist yet — a team ingested before its bootstrap ran; the bootstrap +
 * backfill cover it, so the hook must not fail the push over it.
 */

export interface ReconcileItemResult {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  unitId?: string;
  unitCreated?: boolean;
  membershipCreated?: boolean;
  /** CLOSEMODE-1: opposite-project rows left standing (a human's non-auto exclude). */
  spared?: number;
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
  // AUDITFIX-4: a lost audience CAS is not a failure to report as one — another reconciler owns
  // this unit's current audience, and its own pass will place the item. Surfaced as `skipped` so a
  // batch neither fails nor claims convergence it did not achieve.
  if (unit.stale) return { ok: true, skipped: true };
  if (!unit.ok || !unit.unitId || !unit.audience) return { ok: false, error: `unit: ${unit.error}` };

  const target = unit.audience === "external" ? projects.externalShared : projects.general;
  const other = unit.audience === "external" ? projects.general : projects.externalShared;

  // ORDER IS DIRECTION-AWARE (AUDITFIX-4 §3a). A NARROWING move (external → team) that opens the
  // target first leaves the item STILL EXTERNALLY GRANTED if the close then fails; closing first
  // leaves it in neither project, which the sweep repairs (ARM 2) and which denies rather than
  // discloses in the meantime. A WIDENING move keeps open-first: a failure there leaves the item
  // visible to fewer people, and CLOSEMODE-1's protected-exclusion return depends on that order.
  const narrowing = unit.audience === "team";

  if (narrowing) {
    // PREFLIGHT — non-destructive (round 2 HIGH). Ask the gate whether it CAN answer before the
    // close destroys anything. `noWideningGate` performs no write, which is the whole point: doing
    // this through `ensureIncludeMembership` would open the target first and be the very
    // open-then-close order this branch exists to avoid.
    const pre = await noWideningGate(db, teamId, target, unit.audience);
    if (!pre.ok) return { ok: false, error: `membership: ${pre.error}` };

    // CLOSE FIRST: a failure from here leaves the item in NEITHER project — denial, which ARM 2 of
    // the candidate sweep repairs — rather than still externally granted.
    const closedFirst = await closeMembershipInto(db, teamId, unit.unitId, other);
    if (!closedFirst.ok) return { ok: false, error: `move: ${closedFirst.error}` };

    const opened = await ensureIncludeMembership(db, teamId, { projectId: target, contextUnitId: unit.unitId });
    if (!opened.ok) return { ok: false, error: `membership: ${opened.error}` };
    return {
      ok: true,
      unitId: unit.unitId,
      unitCreated: unit.created,
      membershipCreated: opened.created,
      spared: closedFirst.spared,
    };
  }

  const m = await ensureIncludeMembership(db, teamId, { projectId: target, contextUnitId: unit.unitId });
  if (!m.ok) return { ok: false, error: `membership: ${m.error}` };

  // Close ONLY the opposite system project (never arbitrary initiative memberships — Codex HIGH):
  // the move swaps between general↔external-shared, nothing else.
  const closed = await closeMembershipInto(db, teamId, unit.unitId, other);
  if (!closed.ok) return { ok: false, error: `move: ${closed.error}` };

  return { ok: true, unitId: unit.unitId, unitCreated: unit.created, membershipCreated: m.created, spared: closed.spared };
}
