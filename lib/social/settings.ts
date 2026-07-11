import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Social Brain per-team settings that live on the `teams` row (not the content tables). Today: the
 * daily image-generation cap (`teams.social_image_daily_cap`) — images are on by default, capped so
 * a runaway loop or an eager admin can't burn the image budget. Adjustable in Admin → Social.
 */

export const DEFAULT_IMAGE_DAILY_CAP = 10;
const MAX_IMAGE_DAILY_CAP = 100;

/** The team's daily image cap (defaults to 10 if unset/malformed). */
export async function getImageDailyCap(db: DbClient, teamId: string): Promise<number> {
  const { data } = await db.from("teams").select("social_image_daily_cap").eq("id", teamId).maybeSingle();
  const raw = (data as { social_image_daily_cap: number | null } | null)?.social_image_daily_cap;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_IMAGE_DAILY_CAP) : DEFAULT_IMAGE_DAILY_CAP;
}

/** Set the team's daily image cap (clamped 0…100). 0 disables image generation. */
export async function setImageDailyCap(db: DbClient, teamId: string, cap: number): Promise<number> {
  const clamped = Math.max(0, Math.min(MAX_IMAGE_DAILY_CAP, Math.floor(Number(cap) || 0)));
  const { error } = await db.from("teams").update({ social_image_daily_cap: clamped }).eq("id", teamId);
  if (error) throw new Error(`setImageDailyCap failed: ${error.message}`);
  return clamped;
}

/** Start of the current UTC day, ISO — the window the daily cap counts within. */
export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
