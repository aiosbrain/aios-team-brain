import type { ViewerTier } from "@/lib/auth/visibility";

/**
 * Social Brain content domain types (M2 foundation). The opportunity → plan → variant chain, each
 * carrying an `access` tier inherited from its source evidence. See postgres/schema.sql.
 */

export type AccessTier = ViewerTier; // 'team' | 'external'

export type OpportunityStatus = "discovered" | "evaluated" | "planned" | "rejected" | "expired";

export type ContentStatus =
  | "planned"
  | "generating"
  | "generated"
  | "validating"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "analyzing"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled"
  | "expired";

export type PlanStatus = "planned" | "active" | "archived";

/** One piece of provenance tying an opportunity back to brain knowledge. */
export interface Evidence {
  itemId?: string;
  path?: string;
  note?: string;
}

export interface OpportunityRow {
  id: string;
  team_id: string;
  access: AccessTier;
  source_type: string;
  title: string;
  summary: string;
  evidence: Evidence[];
  topics: string[];
  audiences: string[];
  novelty_score: number;
  relevance_score: number;
  urgency_score: number;
  confidence_score: number;
  status: OpportunityStatus;
  dedup_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: string;
  team_id: string;
  opportunity_id: string;
  access: AccessTier;
  objective: string;
  audience: string;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  team_id: string;
  plan_id: string;
  access: AccessTier;
  platform: string;
  format: string;
  tone: string;
  body: string;
  status: ContentStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateOpportunityInput {
  access: AccessTier;
  sourceType: string;
  title: string;
  summary?: string;
  evidence?: Evidence[];
  topics?: string[];
  audiences?: string[];
  noveltyScore?: number;
  relevanceScore?: number;
  urgencyScore?: number;
  confidenceScore?: number;
  dedupKey?: string;
}

export interface CreatePlanInput {
  objective?: string;
  audience?: string;
}

export interface CreateVariantInput {
  platform: string;
  format: string;
  tone?: string;
  body?: string;
}

/** A generated image for a post variant (base64-encoded; tier inherited from the variant). */
export interface ContentImageRow {
  id: string;
  team_id: string;
  variant_id: string;
  access: AccessTier;
  mime: string;
  data_base64: string;
  prompt: string;
  created_at: string;
}

export interface CreateImageInput {
  mime: string;
  dataBase64: string;
  prompt?: string;
}

export interface SocialActor {
  memberId?: string | null;
}
