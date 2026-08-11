import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { ensureIncludeMembership } from "@/lib/projects/context/memberships";
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
  opts: { batchSize?: number; afterId?: string | null } = {}
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
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  const items = (data ?? []) as ItemRow[];
  let unitsCreated = 0;
  let membershipsCreated = 0;
  for (const item of items) {
    const unit = await reconcileItemUnit(db, teamId, item.id);
    if (!unit.ok || !unit.unitId) return { ok: false, error: `unit ${item.id}: ${unit.error}`, scanned: unitsCreated, unitsCreated, membershipsCreated, cursor: item.id };
    if (unit.created) unitsCreated++;
    const target = item.access === "external" ? projectId.externalShared : projectId.general;
    const m = await ensureIncludeMembership(db, teamId, { projectId: target, contextUnitId: unit.unitId });
    if (!m.ok) return { ok: false, error: `membership ${item.id}: ${m.error}`, scanned: unitsCreated, unitsCreated, membershipsCreated, cursor: item.id };
    if (m.created) membershipsCreated++;
  }

  // Drained when the batch came back short.
  const cursor = items.length === batchSize ? items[items.length - 1].id : null;
  return { ok: true, scanned: items.length, unitsCreated, membershipsCreated, cursor };
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
  db: DbClient
): Promise<{ teams: number; failed: { teamId: string; error: string }[] }> {
  const { data: teams, error } = await db.from("teams").select("id");
  if (error) return { teams: 0, failed: [{ teamId: "*", error: `teams read failed: ${error.message}` }] };
  const failed: { teamId: string; error: string }[] = [];
  for (const t of (teams ?? []) as { id: string }[]) {
    try {
      let cursor: string | null = null;
      // eslint-disable-next-line no-constant-condition
      for (let guard = 0; guard < 10_000; guard++) {
        const r: BackfillResult = await backfillTeamContext(db, t.id, { afterId: cursor });
        if (!r.ok) {
          failed.push({ teamId: t.id, error: r.error ?? "unknown" });
          break;
        }
        if (r.cursor === null) break;
        cursor = r.cursor;
      }
    } catch (e) {
      failed.push({ teamId: t.id, error: e instanceof Error ? e.message : "threw" });
    }
  }
  return { teams: (teams ?? []).length, failed };
}
