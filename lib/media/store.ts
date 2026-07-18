import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { audit } from "@/lib/api/audit";
import type { AccessTier } from "@/lib/social/types";

/**
 * SINGLE WRITER for the `media_assets` table (CLAUDE.md §2) — generated images for a content
 * variant. Writes go through `addMediaAsset` (audited with provider/model/cost, never the bytes).
 * The image bytes (`data_base64`) are read only by the media-serving route, never listed in bulk.
 * Guarded by test/guards/single-writer-media-assets.
 */

export interface MediaAssetMeta {
  id: string;
  variant_id: string;
  access: AccessTier;
  provider: string;
  model: string;
  cost_usd: number;
  created_at: string;
}

const META_COLS = "id, variant_id, access, provider, model, cost_usd, created_at";

function normalize(row: Record<string, unknown>): MediaAssetMeta {
  return { ...(row as unknown as MediaAssetMeta), cost_usd: Number(row.cost_usd ?? 0) };
}

export interface AddMediaInput {
  variantId: string;
  access: AccessTier;
  provider: string;
  model: string;
  prompt: string;
  dataBase64: string;
  costUsd: number;
}

export async function addMediaAsset(
  db: DbClient,
  teamId: string,
  input: AddMediaInput,
  actor: { memberId?: string | null } = {}
): Promise<MediaAssetMeta> {
  const { data, error } = await db
    .from("media_assets")
    .insert({
      team_id: teamId,
      variant_id: input.variantId,
      access: input.access,
      kind: "image",
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      data_base64: input.dataBase64,
      cost_usd: input.costUsd,
      created_by: actor.memberId ?? null,
    })
    .select(META_COLS)
    .single();
  if (error || !data) throw new Error(`addMediaAsset failed: ${error?.message ?? "no row"}`);

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "media.generated",
    target_type: "media_asset",
    target_id: data.id,
    meta: { provider: input.provider, model: input.model, cost_usd: input.costUsd },
  });
  return normalize(data);
}

/** Metadata for a team's media, newest first (no bytes — for listing/rendering via the route). */
export async function listTeamMediaMeta(db: DbClient, teamId: string, limit = 100): Promise<MediaAssetMeta[]> {
  const { data } = await db
    .from("media_assets")
    .select(META_COLS)
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Record<string, unknown>[]).map(normalize);
}

/** The image bytes for one asset (team-scoped). Used only by the media-serving route. */
export async function getMediaBytes(
  db: DbClient,
  teamId: string,
  id: string
): Promise<{ access: AccessTier; data_base64: string } | null> {
  const { data } = await db
    .from("media_assets")
    .select("access, data_base64")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  return (data as { access: AccessTier; data_base64: string }) ?? null;
}

/** The UTC calendar day (YYYY-MM-DD) that owns `now` — the cost-cap bucket key. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Images reserved for a team on the UTC day of `now` — the authoritative cost-cap usage counter. */
export async function getImageUsage(db: DbClient, teamId: string, now: Date): Promise<number> {
  const { data } = await db
    .from("social_image_usage")
    .select("count")
    .eq("team_id", teamId)
    .eq("day", utcDay(now))
    .maybeSingle();
  return Number((data as { count?: number } | null)?.count ?? 0);
}

/**
 * ATOMICALLY reserve one image slot for the team's UTC day, or return false if the daily cap is
 * reached (audit #8). A single conditional `INSERT … ON CONFLICT DO UPDATE … WHERE count < cap`
 * row-locks the one (team, day) counter row, so two concurrent requests can't both pass the cap —
 * unlike the old check-then-act on `count(media_assets)`. Reserve BEFORE any provider spend; call
 * `releaseImageSlot` if the generation then fails so a failed attempt doesn't burn the cap.
 */
export async function reserveImageSlot(_db: DbClient, teamId: string, cap: number, now: Date): Promise<boolean> {
  if (cap <= 0) return false;
  const { rows } = await runSql<{ count: number }>(
    `insert into social_image_usage (team_id, day, count) values ($1, $2, 1)
       on conflict (team_id, day) do update
         set count = social_image_usage.count + 1, updated_at = now()
         where social_image_usage.count < $3
       returning count`,
    [teamId, utcDay(now), cap]
  );
  return rows.length > 0;
}

/** Release a previously-reserved slot (a generation that then failed) — best-effort, floored at 0. */
export async function releaseImageSlot(_db: DbClient, teamId: string, now: Date): Promise<void> {
  await runSql(
    `update social_image_usage set count = greatest(count - 1, 0), updated_at = now()
       where team_id = $1 and day = $2`,
    [teamId, utcDay(now)]
  );
}
