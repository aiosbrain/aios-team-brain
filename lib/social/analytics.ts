import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { AccessTier } from "./types";
import type { NormalizedMetrics } from "./providers/types";

/**
 * SINGLE WRITER for `publication_analytics` (CLAUDE.md §2) — normalized per-publication metrics.
 * One row per publication (upserted in place = latest snapshot). Store-and-display only: M6 does
 * NOT change strategy automatically (the plan's overfitting caution). Guarded by
 * test/guards/single-writer-publication-analytics.
 */

export interface AnalyticsRow {
  publication_id: string;
  access: AccessTier;
  provider: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  collected_at: string;
}

const COLS = "publication_id, access, provider, impressions, likes, comments, shares, saves, clicks, collected_at";

export async function upsertAnalytics(
  db: DbClient,
  teamId: string,
  input: { publicationId: string; access: AccessTier; provider: string; metrics: NormalizedMetrics }
): Promise<void> {
  const m = input.metrics;
  const { error } = await db.from("publication_analytics").upsert(
    {
      team_id: teamId,
      publication_id: input.publicationId,
      access: input.access,
      provider: input.provider,
      impressions: m.impressions ?? null,
      likes: m.likes ?? null,
      comments: m.comments ?? null,
      shares: m.shares ?? null,
      saves: m.saves ?? null,
      clicks: m.clicks ?? null,
      raw: m.raw ?? {},
      collected_at: new Date().toISOString(),
    },
    { onConflict: "publication_id" }
  );
  if (error) throw new Error(`upsertAnalytics failed: ${error.message}`);
  await audit(db, {
    team_id: teamId,
    actor_kind: "system",
    action: "content.analytics_collected",
    target_type: "social_publication",
    target_id: input.publicationId,
    meta: { provider: input.provider },
  });
}

export async function getAnalyticsForPublication(db: DbClient, teamId: string, publicationId: string): Promise<AnalyticsRow | null> {
  const { data } = await db
    .from("publication_analytics")
    .select(COLS)
    .eq("team_id", teamId)
    .eq("publication_id", publicationId)
    .maybeSingle();
  return (data as AnalyticsRow) ?? null;
}

export async function listTeamAnalytics(db: DbClient, teamId: string, limit = 200): Promise<AnalyticsRow[]> {
  const { data } = await db
    .from("publication_analytics")
    .select(COLS)
    .eq("team_id", teamId)
    .order("collected_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as AnalyticsRow[];
}

export interface AnalyticsSummary {
  posts: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
}

/** Team-wide totals across collected posts (display only — no auto strategy changes). */
export async function teamAnalyticsSummary(db: DbClient, teamId: string): Promise<AnalyticsSummary> {
  const rows = await listTeamAnalytics(db, teamId, 500);
  const sum = (k: keyof AnalyticsRow) => rows.reduce((n, r) => n + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  return {
    posts: rows.length,
    impressions: sum("impressions"),
    likes: sum("likes"),
    comments: sum("comments"),
    shares: sum("shares"),
  };
}
