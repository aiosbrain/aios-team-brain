import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isRestrictedTier } from "@/lib/auth/visibility";

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
 * Tier isolation (no RLS on postgres — this filter is the sole enforcement): an
 * `external` viewer receives only `audience='external'` decisions.
 */
export async function getDecisionWriteback(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
  since: string
): Promise<DecisionWritebackGroup[]> {
  let query = db
    .from("decisions")
    .select(
      "row_key, decided_at, title, rationale, decided_by, impact, tier, audience, updated_at, source_item_id, projects(slug), items:source_item_id(synced_at)"
    )
    .eq("team_id", teamId)
    .gt("updated_at", since)
    .order("updated_at", { ascending: true })
    .limit(500);
  if (isRestrictedTier(tier)) query = query.eq("audience", "external");

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const uiChanged = (data ?? []).filter((d) => {
    if (d.source_item_id == null) return true; // created in the dashboard
    const synced = (d.items as unknown as { synced_at: string } | null)?.synced_at;
    return synced ? new Date(d.updated_at as string) > new Date(synced) : false; // edited after sync
  });

  const byProject = new Map<string, DecisionWritebackRow[]>();
  for (const d of uiChanged) {
    const slug = (d.projects as unknown as { slug: string })?.slug ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push({
      row_key: d.row_key as string,
      decided_at: d.decided_at as string | null,
      title: d.title as string,
      rationale: d.rationale as string,
      decided_by: d.decided_by as string,
      impact: d.impact as string,
      tier: d.tier as number | null,
      audience: d.audience as string,
    });
  }
  return [...byProject.entries()].map(([project, rows]) => ({ project, rows }));
}
