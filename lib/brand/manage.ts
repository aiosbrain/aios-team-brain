import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { validateBrandProfile } from "./schema";
import type { BrandGovernance, BrandKnowledge, BrandVoice } from "./schema";

/**
 * SINGLE WRITER for the `brand_profiles` table (CLAUDE.md §2) — what the Admin → Brand editor
 * calls. Validates the config (allowlist `.strict()` + byte cap, in ./schema), upserts one row
 * per team, and audits every change with section KEYS only (never the values). Guarded by
 * test/guards/single-writer-brand.test.ts. Reads are unrestricted at the lib level; the /admin
 * area is admin-gated in app code (no RLS backstop).
 */

export interface BrandProfileRecord {
  voice: BrandVoice;
  knowledge: BrandKnowledge;
  governance: BrandGovernance;
  updated_at: string | null;
}

export interface BrandActor {
  memberId?: string | null;
}

/** The team's brand profile, or null if none has been saved yet. */
export async function getBrandProfile(
  db: DbClient,
  teamId: string
): Promise<BrandProfileRecord | null> {
  const { data, error } = await db
    .from("brand_profiles")
    .select("voice, knowledge, governance, updated_at")
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw new Error(`brand profile read failed: ${error.message}`);
  return (data as BrandProfileRecord) ?? null;
}

/** Create or replace the team's brand profile (validated + audited). */
export async function saveBrandProfile(
  db: DbClient,
  teamId: string,
  input: unknown,
  actor: BrandActor = {}
): Promise<void> {
  const clean = validateBrandProfile(input);
  const voice = clean.voice ?? {};
  const knowledge = clean.knowledge ?? {};
  const governance = clean.governance ?? {};

  const { error } = await db.from("brand_profiles").upsert(
    {
      team_id: teamId,
      voice,
      knowledge,
      governance,
      created_by: actor.memberId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "team_id" }
  );
  if (error) throw new Error(`brand profile save failed: ${error.message}`);

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: "brand.updated",
    target_type: "brand_profile",
    target_id: teamId,
    // Keys only — never the brand values (mirrors the integrations audit discipline).
    meta: {
      voiceKeys: Object.keys(voice),
      knowledgeKeys: Object.keys(knowledge),
      governanceKeys: Object.keys(governance),
    },
  });
}
