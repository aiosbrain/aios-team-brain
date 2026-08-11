import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * §11 backfill — the "give every existing item a membership" half of the migration. For each
 * item: reconcile its item-grain unit, then ensure an include membership into `general` if
 * `access='team'`, into `external-shared` if `access='external'`. Result per §11: **day-one
 * visibility byte-identical to today** — a team member sees General (all team content) and
 * external-shared; an external principal sees external-shared only. The topology those slugs
 * point at is created by ensureAccessBootstrap (slice 3), which this calls first.
 *
 * Resumable and batched: processes items in `id` order after a cursor, bounded per call, so a
 * scheduler leg or a one-shot admin run can chip through a large corpus without a long
 * transaction. Idempotent — a re-run over an already-backfilled item is two no-op ensures.
 */

export interface BackfillResult {
  ok: boolean;
  error?: string;
  scanned: number;
  unitsCreated: number;
  membershipsCreated: number;
  /** The last item id processed — pass as `afterId` to resume; null when the corpus is drained. */
  cursor: string | null;
}

type ItemRow = { id: string; access: "team" | "external" };

export async function backfillTeamContext(
  db: DbClient,
  teamId: string,
  opts: { batchSize?: number; afterId?: string | null; createdBefore?: string } = {}
): Promise<BackfillResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 2000);

  // The system projects + grants must exist before we can point memberships at them.
  const boot = await ensureAccessBootstrap(db, teamId);
  if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}`, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  const projectId = await resolveSystemProjectIds(db, teamId);
  if (!projectId.ok) return { ok: false, error: projectId.error, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  let q = db
    .from("items")
    .select("id, access")
    .eq("team_id", teamId)
    .order("id", { ascending: true })
    .limit(batchSize);
  if (opts.afterId) q = q.gt("id", opts.afterId);
  // Random uuids are stable once assigned, so id-keyset covers every EXISTING row exactly once.
  // A cutoff bounds the run to the pre-existing corpus so a concurrent insert (which the ingest
  // hook will unit-ize itself, next slice) can't be skipped-yet-reported-drained (Codex Medium).
  if (opts.createdBefore) q = q.lt("created_at", opts.createdBefore);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  const items = (data ?? []) as ItemRow[];
  let unitsCreated = 0;
  let membershipsCreated = 0;
  let scanned = 0;
  // On failure the cursor is the last item that FULLY succeeded (or the incoming afterId if the
  // first item fails), so a resume RETRIES the failed item rather than skipping past it —
  // skipping would leave a unit with no membership, i.e. content visible to no one under a
  // Phase-B read (Fable H2). Progress within a failed batch is preserved (the successes before
  // it committed and are idempotent on retry).
  let lastGood: string | null = opts.afterId ?? null;
  for (const item of items) {
    // Per-item reconcile+route+move — the SAME core the ingest hook uses (spec §11.2), so the
    // one-time sweep and the on-push path can never diverge in how they partition an item.
    const r = await reconcileItemContext(db, teamId, item.id, projectId);
    if (!r.ok) return { ok: false, error: `${item.id}: ${r.error}`, scanned, unitsCreated, membershipsCreated, cursor: lastGood };
    if (r.unitCreated) unitsCreated++;
    if (r.membershipCreated) membershipsCreated++;
    scanned++;
    lastGood = item.id;
  }

  // Drained when the batch came back short.
  const cursor = items.length === batchSize ? items[items.length - 1].id : null;
  return { ok: true, scanned, unitsCreated, membershipsCreated, cursor };
}

async function resolveSystemProjectIds(
  db: DbClient,
  teamId: string
): Promise<{ ok: true; general: string; externalShared: string } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", teamId)
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  if (error) return { ok: false, error: error.message };
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  const general = bySlug.get(GENERAL_SLUG);
  const externalShared = bySlug.get(EXTERNAL_SHARED_SLUG);
  if (!general || !externalShared) return { ok: false, error: "system projects missing after bootstrap" };
  return { ok: true, general, externalShared };
}

/** Backfill every team to completion (drains the cursor per team). Best-effort per team. */
export async function backfillAllTeams(
  db: DbClient,
  cutoff: string
): Promise<{ teams: number; succeeded: string[]; failed: { teamId: string; error: string }[] }> {
  const { data: teams, error } = await db.from("teams").select("id");
  if (error) return { teams: 0, succeeded: [], failed: [{ teamId: "*", error: `teams read failed: ${error.message}` }] };
  const succeeded: string[] = [];
  const failed: { teamId: string; error: string }[] = [];
  const MAX_BATCHES = 10_000;
  for (const t of (teams ?? []) as { id: string }[]) {
    try {
      // Cheap convergence short-circuit — counts CURRENT MEMBERSHIPS, not units (slice-5 Codex
      // HIGH): a unit whose membership creation FAILED still has a unit, so a unit-count check
      // would skip the broken item forever. A current membership means the item was fully
      // reconciled (unit AND membership) at least once. Stale-audience from a tier change is
      // reconverged at the reclassification fan-out (settleReclassification), not here — so a
      // membership-count convergence is safe. ~2 counts when converged instead of an O(N) drain.
      const [{ count: itemCount }, { count: memCount }] = await Promise.all([
        db.from("items").select("id", { count: "exact", head: true }).eq("team_id", t.id),
        db.from("project_context_memberships").select("id", { count: "exact", head: true }).eq("team_id", t.id).is("valid_to", null),
      ]);
      if (typeof itemCount === "number" && typeof memCount === "number" && memCount >= itemCount) { succeeded.push(t.id); continue; }
      let cursor: string | null = null;
      let drained = false;
      for (let guard = 0; guard < MAX_BATCHES; guard++) {
        const r: BackfillResult = await backfillTeamContext(db, t.id, { afterId: cursor, createdBefore: cutoff });
        if (!r.ok) {
          failed.push({ teamId: t.id, error: r.error ?? "unknown" });
          drained = true; // recorded as failed; don't ALSO report guard-exhaustion below
          break;
        }
        if (r.cursor === null) {
          drained = true;
          break;
        }
        cursor = r.cursor;
      }
      // Fail LOUD on a silent partial: a corpus larger than MAX_BATCHES*batchSize left
      // un-drained would otherwise report as covered (Fable M1).
      if (!drained) failed.push({ teamId: t.id, error: `guard exhausted at cursor ${cursor} — corpus not fully backfilled` });
      else if (!failed.some((f) => f.teamId === t.id)) succeeded.push(t.id);
    } catch (e) {
      failed.push({ teamId: t.id, error: e instanceof Error ? e.message : "threw" });
    }
  }
  return { teams: (teams ?? []).length, succeeded, failed };
}
