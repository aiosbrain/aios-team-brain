import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { validateBrandAsset } from "./schema";
import type { BrandAssetInput } from "./schema";

/**
 * SINGLE WRITER for the `brand_assets` table (CLAUDE.md §2) — the per-team reference library the
 * Brand Brain layers into generation (website/URLs, logo/image links, examples to emulate).
 * Validates each asset (kind/label/url shape, ./schema) and audits add/remove with label+kind only
 * (URLs are non-secret but we keep meta minimal). Guarded by test/guards/single-writer-brand-assets.
 * Reads are unrestricted at the lib level; the /admin area is admin-gated in app code.
 */

export interface BrandAssetRow {
  id: string;
  kind: "url" | "asset" | "reference";
  label: string;
  url: string | null;
  notes: string;
  created_at: string;
}

export interface BrandActor {
  memberId?: string | null;
}

const COLS = "id, kind, label, url, notes, created_at";

/** The team's brand assets, newest first. */
export async function listBrandAssets(db: DbClient, teamId: string): Promise<BrandAssetRow[]> {
  const { data, error } = await db
    .from("brand_assets")
    .select(COLS)
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`brand assets read failed: ${error.message}`);
  return (data ?? []) as BrandAssetRow[];
}

/** Add a brand asset (validated + audited). Returns the created row. */
export async function addBrandAsset(
  db: DbClient,
  teamId: string,
  input: BrandAssetInput,
  actor: BrandActor = {}
): Promise<BrandAssetRow> {
  const clean = validateBrandAsset(input);
  const { data, error } = await db
    .from("brand_assets")
    .insert({
      team_id: teamId,
      kind: clean.kind,
      label: clean.label,
      url: clean.url || null,
      notes: clean.notes ?? "",
      created_by: actor.memberId ?? null,
    })
    .select(COLS)
    .single();
  if (error || !data) throw new Error(`brand asset add failed: ${error?.message ?? "no row"}`);

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "brand.asset_added",
    target_type: "brand_asset",
    target_id: data.id,
    meta: { kind: clean.kind, label: clean.label },
  });
  return data as BrandAssetRow;
}

/** Remove a brand asset (team-scoped + audited). */
export async function removeBrandAsset(
  db: DbClient,
  teamId: string,
  id: string,
  actor: BrandActor = {}
): Promise<void> {
  const { error } = await db.from("brand_assets").delete().eq("team_id", teamId).eq("id", id);
  if (error) throw new Error(`brand asset remove failed: ${error.message}`);
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "brand.asset_removed",
    target_type: "brand_asset",
    target_id: id,
    meta: {},
  });
}
