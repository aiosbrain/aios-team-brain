import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { AccessTier } from "./types";

/**
 * SINGLE WRITER for the `social_publications` table (CLAUDE.md §2) — the publish ledger. One row per
 * publish attempt of a variant; the M0 job runner drives it scheduled → publishing → published /
 * failed. Tier inherited from the variant. Guarded by test/guards/single-writer-social-publications.
 */

export type PublicationStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export interface PublicationRow {
  id: string;
  variant_id: string;
  access: AccessTier;
  provider: string;
  status: PublicationStatus;
  dry_run: boolean;
  scheduled_at: string | null;
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  created_at: string;
}

const COLS =
  "id, variant_id, access, provider, status, dry_run, scheduled_at, published_at, external_id, external_url, last_error, created_at";

export async function createPublication(
  db: DbClient,
  teamId: string,
  input: { variantId: string; access: AccessTier; dryRun: boolean; scheduledAt: string; provider?: string },
  actor: { memberId?: string | null } = {}
): Promise<PublicationRow> {
  const { data, error } = await db
    .from("social_publications")
    .insert({
      team_id: teamId,
      variant_id: input.variantId,
      access: input.access,
      provider: input.provider ?? "typefully",
      status: "scheduled",
      dry_run: input.dryRun,
      scheduled_at: input.scheduledAt,
      created_by: actor.memberId ?? null,
    })
    .select(COLS)
    .single();
  if (error || !data) throw new Error(`createPublication failed: ${error?.message ?? "no row"}`);
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "content.scheduled",
    target_type: "social_publication",
    target_id: (data as PublicationRow).id,
    meta: { provider: input.provider ?? "typefully", dryRun: input.dryRun },
  });
  return data as PublicationRow;
}

export async function setPublicationState(
  db: DbClient,
  teamId: string,
  id: string,
  fields: Partial<{ status: PublicationStatus; external_id: string; external_url: string | null; published_at: string; last_error: string | null }>
): Promise<void> {
  const { error } = await db
    .from("social_publications")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`setPublicationState failed: ${error.message}`);
}

/**
 * Cancel a PENDING publication so its queued `publish` job won't post it (2026-07-16 audit #6 — a
 * scheduled live post previously could not be stopped). Conditional on the row still being cancellable
 * (`scheduled`/`failed`) — you can't un-publish an already-posted one, and a row already `publishing`
 * is mid-provider-call: cancelling it would be false assurance (the in-flight call may still land and
 * overwrite the row), so it's NOT cancellable here (a clean stop of an in-flight post needs the
 * idempotency/reclaim work, audit #2/#4). Reports whether it actually cancelled.
 */
export async function cancelPublication(
  db: DbClient,
  teamId: string,
  id: string,
  actor: { memberId?: string | null } = {}
): Promise<{ cancelled: boolean }> {
  const { data, error } = await db
    .from("social_publications")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id)
    .in("status", ["scheduled", "failed"])
    .select("id");
  if (error) throw new Error(`cancelPublication failed: ${error.message}`);
  const cancelled = ((data ?? []) as { id: string }[]).length > 0;
  if (cancelled) {
    await audit(db, {
      team_id: teamId,
      actor_kind: "member",
      member_id: actor.memberId ?? null,
      action: "content.publish_cancelled",
      target_type: "social_publication",
      target_id: id,
      meta: {},
    });
  }
  return { cancelled };
}

export async function getPublication(db: DbClient, teamId: string, id: string): Promise<PublicationRow | null> {
  const { data } = await db.from("social_publications").select(COLS).eq("team_id", teamId).eq("id", id).maybeSingle();
  return (data as PublicationRow) ?? null;
}

/** Publications for the team, newest first (for the admin view). */
export async function listPublications(db: DbClient, teamId: string, limit = 100): Promise<PublicationRow[]> {
  const { data } = await db
    .from("social_publications")
    .select(COLS)
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as PublicationRow[];
}
