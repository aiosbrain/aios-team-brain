import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { runSql } from "@/lib/db/pg/pool";
import { newSqlParams, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";

/** Tier of the pulling principal (the API key's member tier). */
export type ViewerTier = "team" | "external";

export interface DecisionWritebackRow {
  row_key: string;
  decided_at: string | null;
  title: string;
  rationale: string;
  decided_by: string;
  impact: string;
  tier: number | null;
  audience: string;
}

export interface DecisionWritebackGroup {
  project: string;
  rows: DecisionWritebackRow[];
}

/**
 * Decisions created or edited IN THE DASHBOARD since `since`, grouped by project, for
 * `aios pull` to merge into `3-log/decision-log.md`. Mirrors the task writeback.
 *
 * A row is "UI-changed" when it was created in the dashboard (`source_item_id IS NULL`,
 * the discriminator) OR a synced row was edited after its source item's `synced_at`.
 *
 * ENFB-2 §2.2: this feed serves full `rationale`/`impact` PROSE (the body surface ENFB-1's
 * table missed), so the provenance predicate AND the UI-changed test both compile IN-QUERY,
 * before the 500-row window — a caller receives a window of rows it may see that will all
 * serve (design round 1 F3: an app-side mode filter after LIMIT re-opens starvation).
 *
 * Tier isolation (no RLS on postgres — the audience conjunct is the sole posture
 * enforcement): an `external` viewer receives only `audience='external'` decisions.
 */
export async function getDecisionWriteback(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
  since: string,
  enforce: { visibleItemIds: ReadonlySet<string>; teamPosture: boolean }
): Promise<DecisionWritebackGroup[]> {
  void db; // the feed reads through the shared pool (raw SQL); kept for signature stability
  const p = newSqlParams();
  const conds = [
    `d.team_id = ${p.add(teamId)}`,
    `d.updated_at > ${p.add(since)}::timestamptz`,
    provenanceRowSqlFromIds("d", p, enforce),
    // UI-changed: dashboard-created (null source — already provenance-proven hand-typed
    // above) OR a synced row edited after its source item's push.
    `(d.source_item_id is null or (i.synced_at is not null and d.updated_at > i.synced_at))`,
  ];
  if (isRestrictedTier(tier)) conds.push(`d.audience = 'external'`);

  const res = await runSql<{
    row_key: string;
    decided_at: string | null;
    title: string;
    rationale: string;
    decided_by: string;
    impact: string;
    tier: number | null;
    audience: string;
    project_slug: string | null;
  }>(
    `select d.row_key, d.decided_at::text as decided_at, d.title, d.rationale, d.decided_by, d.impact,
            d.tier, d.audience, p.slug as project_slug
       from decisions d
       left join projects p on p.id = d.project_id
       left join items i on i.id = d.source_item_id
      where ${conds.join(" and ")}
      order by d.updated_at asc
      limit 500`,
    p.values
  );

  const byProject = new Map<string, DecisionWritebackRow[]>();
  for (const d of res.rows) {
    const slug = d.project_slug ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push({
      row_key: d.row_key,
      decided_at: d.decided_at,
      title: d.title,
      rationale: d.rationale,
      decided_by: d.decided_by,
      impact: d.impact,
      tier: d.tier,
      audience: d.audience,
    });
  }
  return [...byProject.entries()].map(([project, rows]) => ({ project, rows }));
}
