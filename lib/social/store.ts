import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleByAccess, type ViewerTier } from "@/lib/auth/visibility";
import { TierLeakError, violatesEvidenceTier } from "./tier";
import type {
  AccessTier,
  ContentStatus,
  CreateOpportunityInput,
  CreatePlanInput,
  CreateVariantInput,
  Evidence,
  OpportunityRow,
  OpportunityStatus,
  PlanRow,
  PlanStatus,
  SocialActor,
  VariantRow,
} from "./types";

/**
 * SINGLE WRITER for the Social Brain content tables (CLAUDE.md §2): `social_opportunities`,
 * `content_plans`, `content_variants`. Every insert/update lives here. Guarded by
 * test/guards/single-writer-social-content.test.ts.
 *
 * The one invariant this file exists to guarantee (beyond single-writer): **tier propagates down
 * the chain.** A plan inherits its opportunity's `access`; a variant inherits its plan's `access`.
 * The caller never sets tier on a plan/variant — the store reads the parent and copies it, so a
 * team-sourced opportunity can never spawn an `external` (publicly visible) plan/variant. Tier
 * isolation has no RLS backstop (CLAUDE.md §5); this is the sole enforcement, proven by the
 * social-content data-mechanics test.
 */

const OPP_COLS =
  "id, team_id, access, source_type, title, summary, evidence, topics, audiences, novelty_score, relevance_score, urgency_score, confidence_score, status, dedup_key, created_at, updated_at";
const PLAN_COLS =
  "id, team_id, opportunity_id, access, objective, audience, status, created_at, updated_at";
const VARIANT_COLS =
  "id, team_id, plan_id, access, platform, format, tone, body, status, validation, created_at, updated_at";

const SCORE_KEYS = ["novelty_score", "relevance_score", "urgency_score", "confidence_score"] as const;

/** numeric columns come back from node-pg as strings — coerce the four scores to numbers. */
function normalizeOpportunity(row: Record<string, unknown>): OpportunityRow {
  const out = { ...row } as Record<string, unknown>;
  for (const k of SCORE_KEYS) out[k] = Number(row[k] ?? 0);
  return out as unknown as OpportunityRow;
}

/**
 * Enforce the evidence→tier-leak invariant (lib/social/tier): the requested `access` may be at
 * most as public as the most-restrictive item this opportunity cites. Looks up the actual
 * `items.access` for every evidence entry that references an item and throws TierLeakError if the
 * request would over-expose. Fail-closed — an evidence id that resolves to no item counts as
 * restrictive. No item-evidence → unconstrained (a manual opportunity may be external).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertEvidenceTier(
  db: DbClient,
  teamId: string,
  access: AccessTier,
  evidence: Evidence[]
): Promise<void> {
  const itemIds = [...new Set(evidence.map((e) => e.itemId).filter((id): id is string => !!id))];
  if (itemIds.length === 0) return;

  // Only syntactically-valid UUIDs can reference a real item; a malformed id can't be looked up
  // (it would crash the `in` cast) and is counted as unresolved → restrictive (fail-closed).
  const uuids = itemIds.filter((id) => UUID_RE.test(id));
  let found: { id: string; access: AccessTier }[] = [];
  if (uuids.length) {
    const { data, error } = await db.from("items").select("id, access").eq("team_id", teamId).in("id", uuids);
    if (error) throw new Error(`assertEvidenceTier: items lookup failed: ${error.message}`);
    found = (data ?? []) as { id: string; access: AccessTier }[];
  }

  const missing = itemIds.length - found.length;
  if (violatesEvidenceTier(access, found.map((r) => r.access), missing)) {
    throw new TierLeakError(
      `opportunity access '${access}' exceeds its evidence tier — evidence cites ` +
        `non-public (team) or unresolved items, so it cannot be ${access}`
    );
  }
}

// ── opportunities ──────────────────────────────────────────────────────────────

/** Create an opportunity. Idempotent when `dedupKey` is set (returns the existing one). */
export async function createOpportunity(
  db: DbClient,
  teamId: string,
  input: CreateOpportunityInput,
  actor: SocialActor = {}
): Promise<OpportunityRow> {
  if (input.dedupKey) {
    const existing = await db
      .from("social_opportunities")
      .select(OPP_COLS)
      .eq("team_id", teamId)
      .eq("dedup_key", input.dedupKey)
      .maybeSingle();
    if (existing.data) return normalizeOpportunity(existing.data);
  }

  // §5 tier-leak guard: an opportunity can be no more public than its most-restrictive evidence.
  await assertEvidenceTier(db, teamId, input.access, input.evidence ?? []);

  const row: Record<string, unknown> = {
    team_id: teamId,
    access: input.access,
    source_type: input.sourceType,
    title: input.title,
    summary: input.summary ?? "",
    // jsonb ARRAY columns must be JSON-serialized for the pg adapter (it auto-casts plain
    // objects but binds arrays as Postgres arrays → invalid json). Matches lib/ingest/runs.
    evidence: JSON.stringify(input.evidence ?? []),
    topics: JSON.stringify(input.topics ?? []),
    audiences: JSON.stringify(input.audiences ?? []),
    novelty_score: input.noveltyScore ?? 0,
    relevance_score: input.relevanceScore ?? 0,
    urgency_score: input.urgencyScore ?? 0,
    confidence_score: input.confidenceScore ?? 0,
    created_by: actor.memberId ?? null,
  };
  if (input.dedupKey) row.dedup_key = input.dedupKey;

  const { data, error } = await db.from("social_opportunities").insert(row).select(OPP_COLS).single();
  if (error || !data) throw new Error(`createOpportunity failed: ${error?.message ?? "no row"}`);
  return normalizeOpportunity(data);
}

export async function setOpportunityStatus(
  db: DbClient,
  teamId: string,
  id: string,
  status: OpportunityStatus
): Promise<void> {
  const { error } = await db
    .from("social_opportunities")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`setOpportunityStatus failed: ${error.message}`);
}

export async function getOpportunity(db: DbClient, teamId: string, id: string): Promise<OpportunityRow | null> {
  const { data } = await db
    .from("social_opportunities")
    .select(OPP_COLS)
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  return data ? normalizeOpportunity(data) : null;
}

/** List opportunities visible to `tier` (external → only `access='external'`). Newest first. */
export async function listOpportunities(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
  limit = 50
): Promise<OpportunityRow[]> {
  const q = visibleByAccess(
    db.from("social_opportunities").select(OPP_COLS).eq("team_id", teamId),
    tier
  );
  const { data } = await q.order("created_at", { ascending: false }).limit(limit);
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeOpportunity);
}

// ── plans ──────────────────────────────────────────────────────────────────────

/** Create a plan for an opportunity. `access` is inherited from the opportunity (tier propagates). */
export async function createPlan(
  db: DbClient,
  teamId: string,
  opportunityId: string,
  input: CreatePlanInput = {},
  actor: SocialActor = {}
): Promise<PlanRow> {
  const opp = await getOpportunity(db, teamId, opportunityId);
  if (!opp) throw new Error(`createPlan: opportunity ${opportunityId} not found for team`);

  const { data, error } = await db
    .from("content_plans")
    .insert({
      team_id: teamId,
      opportunity_id: opportunityId,
      access: opp.access, // inherited — caller cannot widen tier
      objective: input.objective ?? "",
      audience: input.audience ?? "",
      created_by: actor.memberId ?? null,
    })
    .select(PLAN_COLS)
    .single();
  if (error || !data) throw new Error(`createPlan failed: ${error?.message ?? "no row"}`);
  return data as PlanRow;
}

export async function setPlanStatus(
  db: DbClient,
  teamId: string,
  id: string,
  status: PlanStatus
): Promise<void> {
  const { error } = await db
    .from("content_plans")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`setPlanStatus failed: ${error.message}`);
}

export async function getPlan(db: DbClient, teamId: string, id: string): Promise<PlanRow | null> {
  const { data } = await db
    .from("content_plans")
    .select(PLAN_COLS)
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  return (data as PlanRow) ?? null;
}

// ── variants ─────────────────────────────────────────────────────────────────────

/** Add a variant to a plan. `access` is inherited from the plan (tier propagates). */
export async function addVariant(
  db: DbClient,
  teamId: string,
  planId: string,
  input: CreateVariantInput
): Promise<VariantRow> {
  const plan = await getPlan(db, teamId, planId);
  if (!plan) throw new Error(`addVariant: plan ${planId} not found for team`);

  const { data, error } = await db
    .from("content_variants")
    .insert({
      team_id: teamId,
      plan_id: planId,
      access: plan.access, // inherited — caller cannot widen tier
      platform: input.platform,
      format: input.format,
      tone: input.tone ?? "",
      body: input.body ?? "",
    })
    .select(VARIANT_COLS)
    .single();
  if (error || !data) throw new Error(`addVariant failed: ${error?.message ?? "no row"}`);
  return data as VariantRow;
}

export async function setVariantStatus(
  db: DbClient,
  teamId: string,
  id: string,
  status: ContentStatus
): Promise<void> {
  const { error } = await db
    .from("content_variants")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`setVariantStatus failed: ${error.message}`);
}

export async function getVariant(db: DbClient, teamId: string, id: string): Promise<VariantRow | null> {
  const { data } = await db
    .from("content_variants")
    .select(VARIANT_COLS)
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  return (data as VariantRow) ?? null;
}

/** Persist a generated draft's body, status, and governance-gate result together. */
export async function setVariantGeneration(
  db: DbClient,
  teamId: string,
  id: string,
  fields: { body: string; status: ContentStatus; validation: Record<string, unknown> }
): Promise<void> {
  const { error } = await db
    .from("content_variants")
    .update({
      body: fields.body,
      status: fields.status,
      validation: fields.validation,
      updated_at: new Date().toISOString(),
    })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`setVariantGeneration failed: ${error.message}`);
}

/** Variants for a plan, visible to `tier` (external → only `access='external'`). */
export async function listVariants(
  db: DbClient,
  teamId: string,
  planId: string,
  tier: ViewerTier
): Promise<VariantRow[]> {
  const q = visibleByAccess(
    db.from("content_variants").select(VARIANT_COLS).eq("team_id", teamId).eq("plan_id", planId),
    tier
  );
  const { data } = await q.order("created_at", { ascending: true });
  return (data ?? []) as VariantRow[];
}
