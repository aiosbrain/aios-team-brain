import { z } from "zod";

export {
  decisionRowSchema,
  factRowSchema,
  itemPayloadSchema,
  stakeholderMentionRowSchema,
  taskRowSchema,
} from "./item-payload-schema";
export type {
  DecisionRow,
  FactRow,
  ItemPayload,
  StakeholderMentionRow,
  TaskRow,
} from "./item-payload-schema";

/**
 * Zod schemas mirroring the pinned contract:
 * aios-workspace/docs/brain-api.md (v1).
 * Tier vocabulary: canonical admin|team|external; `client` is a legacy alias
 * normalized to external on ingest; `admin` is rejected with 422.
 */

// ── codebase scan ingest (POST /api/v1/codebases) ────────────────────────────
// The Python scanner pushes RAW metrics only; the brain computes scores at ingest
// (lib/codebases/score) and writes them. Team-tier keys only (enforced in the route).

export const codebaseRecordSchema = z.object({
  // Route-safe: the slug is used directly as a /codebases/[slug] path segment, so it
  // must not contain '/', '?', '#', or whitespace. Broader than the team-slug shape
  // because codebase slugs are real repo names (allow '.' and '_', e.g. llama_index).
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "slug must be route-safe (letters, digits, '.', '_', '-')",
    ),
  full_name: z.string().max(200).optional().default(""),
  provider: z.string().max(40).optional().default("github"),
  default_branch: z.string().max(120).optional().default("main"),
  description: z.string().max(2000).optional().default(""),
  homepage: z.string().max(500).optional().default(""),
  primary_language: z.string().max(80).optional().default(""),
  languages: z.record(z.string(), z.number()).optional().default({}),
  stars: z.number().int().nonnegative().optional().default(0),
  forks: z.number().int().nonnegative().optional().default(0),
  open_issues: z.number().int().nonnegative().optional().default(0),
  is_archived: z.boolean().optional().default(false),
});

// `metrics.codebase_health` — a provenance-only snapshot scored scanner-side. V1 is the
// original brain-api 1.15 scalar contract. Brain-api 1.17 adds the closed v2 metadata
// contract (test/fixtures/contract/codebase-health-v2.schema.json): evidence completeness,
// repository capability profile, fail-closed automation admission, and redacted findings.
// Both reject paths, source text, finding detail, and contributor identity. Guarded by
// test/guards/codebase-payload-contract.test.ts against the vendored canonical artifacts.
const codebaseHealthV1Schema = z.strictObject({
  schema_version: z.string().min(1).max(20).refine((value) => value !== "2"),
  rubric_version: z.string().min(1).max(40),
  head_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  score_pct: z.number().min(0).max(100),
  status: z.enum(["pass", "warn", "fail"]),
  dimensions: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      z.strictObject({
        passed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }),
    )
    .refine((d) => Object.keys(d).length >= 1, {
      message: "dimensions must have at least one entry",
    }),
  failed_invariant_ids: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
    .max(200),
  measured_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/),
});

const evidenceStatusSchema = z.enum(["complete", "partial", "missing", "stale", "error"]);
const codebaseHealthV2Schema = z.strictObject({
  schema_version: z.literal("2"),
  rubric_version: z.string().min(1).max(40),
  profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  profile_version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  head_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  score_pct: z.number().min(0).max(100),
  status: z.enum(["pass", "warn", "fail"]),
  evidence_status: evidenceStatusSchema,
  quality_gate: z.enum(["pass", "fail", "unknown"]),
  automation_eligible: z.boolean(),
  dimensions: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      z.strictObject({
        passed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        band: z.number().int().min(0).max(4).nullable(),
        evidence_status: evidenceStatusSchema,
      }),
    )
    .refine((dimensions) => Object.keys(dimensions).length >= 1, {
      message: "dimensions must have at least one entry",
    }),
  failed_invariant_ids: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
    .max(200),
  measured_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/),
  findings: z
    .array(
      z.strictObject({
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        check_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        axis: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        kind: z.enum(["quality_issue", "evidence_gap"]),
        severity: z.enum(["low", "medium", "high", "critical"]),
        evidence_status: evidenceStatusSchema,
        remediation_tier: z.number().int().min(0).max(3),
      }),
    )
    .max(500),
}).superRefine((health, context) => {
  if (health.quality_gate === "pass" && health.evidence_status !== "complete") {
    context.addIssue({
      code: "custom",
      path: ["quality_gate"],
      message: "a passing quality gate requires complete evidence",
    });
  }
  if (health.quality_gate === "unknown" && health.evidence_status === "complete") {
    context.addIssue({
      code: "custom",
      path: ["quality_gate"],
      message: "an unknown quality gate cannot claim complete evidence",
    });
  }
  if (
    health.automation_eligible &&
    (health.quality_gate !== "pass" ||
      health.evidence_status !== "complete" ||
      health.status === "fail")
  ) {
    context.addIssue({
      code: "custom",
      path: ["automation_eligible"],
      message: "automation requires complete evidence, a passing gate, and non-failing health",
    });
  }
});

// V1 remains accepted byte-for-byte. V2 adds the evidence needed to decide whether a
// background remediation worker may act, without accepting raw source or finding text.
export const codebaseHealthSchema = z.union([codebaseHealthV2Schema, codebaseHealthV1Schema]);
export type CodebaseHealth = z.infer<typeof codebaseHealthSchema>;

export const codeMetricsSchema = z.object({
  head_sha: z.string().min(1).max(64),
  window_days: z.number().int().positive().max(3650).optional().default(90),
  scanned_at: z.string().nullable().optional(),
  // Core raw-scan fields are REQUIRED — a partial/sparse push (e.g. a readiness-only payload)
  // is rejected at the boundary (422) instead of upserting a row that zeroes existing analytics
  // (code_metrics upserts on (codebase_id, head_sha) and REPLACES the row). The ingestion
  // scanner (`aios-ingest scan`) always sends the full block; readiness fields stay optional.
  loc: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  commits_window: z.number().int().nonnegative(),
  ai_commits_window: z.number().int().nonnegative(),
  additions_window: z.number().int().nonnegative(),
  deletions_window: z.number().int().nonnegative(),
  test_coverage_pct: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .default(null),
  test_coverage_functions_pct: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .default(null),
  test_coverage_branches_pct: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .default(null),
  recent_commits: z.array(z.record(z.string(), z.unknown())),
  // explicit scaffolding inputs (required)
  has_claude_md: z.boolean(),
  has_agents_md: z.boolean(),
  agents_md_count: z.number().int().nonnegative(),
  skills_count: z.number().int().nonnegative(),
  commands_count: z.number().int().nonnegative(),
  // cadence inputs (used to compute cadence_score; not persisted raw)
  active_days: z.number().int().nonnegative().optional().default(0),
  days_since_last_commit: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .default(null),
  // AEM agent-readiness — scored scanner-side against the canonical rubric
  // (agentic-engineering-maturity/rubric/agent-readiness.json); the brain persists as-is.
  // Validate at the boundary so malformed scanner output can't become permanent analytics:
  // level is the fixed L0..L5 ladder, and a pillar can't report more passed than total.
  readiness_level: z
    .enum(["L0", "L1", "L2", "L3", "L4", "L5"])
    .nullable()
    .optional()
    .default(null),
  readiness_pct: z.number().min(0).max(100).nullable().optional().default(null),
  readiness_pillars: z
    .record(
      z.string(),
      z
        .object({
          passed: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .refine((p) => p.passed <= p.total, {
          message: "passed must be <= total",
        }),
    )
    .optional()
    .default({}),
  readiness_rubric_version: z
    .string()
    .max(32)
    .nullable()
    .optional()
    .default(null),
  // Workspace-governance health snapshot (brain-api document revision 1.15) — scored
  // scanner-side, persisted VERBATIM, never recomputed here (same posture as readiness_*).
  // Optional and additive: a pre-1.15 payload without it stays valid unchanged. No
  // `.default()`/no null: omitted must stay distinguishable from a scored object.
  codebase_health: codebaseHealthSchema.optional(),
});

export const codeContributionSchema = z.object({
  author_key: z.string().min(1).max(320),
  author_name: z.string().max(200).optional().default(""),
  author_email: z.string().max(320).optional().default(""),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  commits: z.number().int().nonnegative().optional().default(0),
  ai_commits: z.number().int().nonnegative().optional().default(0),
  additions: z.number().int().nonnegative().optional().default(0),
  deletions: z.number().int().nonnegative().optional().default(0),
});

export const githubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000).optional().default(""),
  state: z.enum(["open", "closed"]).optional().default("open"),
  is_pull_request: z.boolean().optional().default(false),
  author_login: z.string().max(120).optional().default(""),
  assignee_login: z.string().max(120).optional().default(""),
  labels: z.array(z.string()).optional().default([]),
  comments: z.number().int().nonnegative().optional().default(0),
  url: z.string().max(500).optional().default(""),
  opened_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
});

export const codebaseScanPayloadSchema = z
  .object({
    codebase: codebaseRecordSchema,
    metrics: codeMetricsSchema,
    contributions: z
      .array(codeContributionSchema)
      .max(5000)
      .optional()
      .default([]),
    issues: z.array(githubIssueSchema).max(5000).optional().default([]),
  })
  .superRefine((payload, context) => {
    const health = payload.metrics.codebase_health;
    if (health?.schema_version === "2" && health.head_sha !== payload.metrics.head_sha) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "codebase_health", "head_sha"],
        message: "codebase health head_sha must match metrics head_sha",
      });
    }
  });
export type CodebaseScanPayload = z.infer<typeof codebaseScanPayloadSchema>;

// AEM individual-scope maturity signals (ratios + counts; the entire privacy
// surface — no tool names, no branch, no cwd, no message text).
export const aemSignalsSchema = z.object({
  delegation_ratio: z.number().min(0).optional().default(0),
  correction_loop_avg: z.number().min(0).optional().default(0),
  error_rate: z.number().min(0).optional().default(0),
  cost_per_task: z.number().min(0).optional().default(0),
  tokens_per_task: z.number().min(0).optional().default(0),
  cache_hit_rate: z.number().min(0).optional().default(0),
  tool_diversity: z.number().min(0).optional().default(0),
  verify_tool_rate: z.number().min(0).optional().default(0),
  subagent_usage: z.number().min(0).optional().default(0),
  total_cost_usd: z.number().min(0).optional().default(0),
  input_tokens: z.number().int().nonnegative().optional().default(0),
  output_tokens: z.number().int().nonnegative().optional().default(0),
  cache_read_tokens: z.number().int().nonnegative().optional().default(0),
});

export const maturitySnapshotPayloadSchema = z.object({
  // optional; defaults to the authenticated key's member. A supplied handle must
  // resolve to a member on the caller's team or the push is rejected.
  member: z.string().max(120).nullable().optional(),
  metric: z.string().max(60).optional().default("aem-individual"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window_days: z.number().int().positive().max(3650).optional().default(1),
  signals: aemSignalsSchema,
  // client-side provisional placement (persisted as provenance only)
  provisional: z
    .object({
      spine: z.string().max(8).optional().default("L1"),
      axes: z.record(z.string(), z.number()).optional().default({}),
    })
    .optional()
    .default({ spine: "L1", axes: {} }),
  sessions: z.number().int().nonnegative().optional().default(0),
  tasks: z.number().int().nonnegative().optional().default(0),
  // Shadow Cognitive-Ergonomics band (v1.3). No `.default()`: omitted (older client) must
  // stay distinguishable from an explicit null. Provenance-only — never recomputed here.
  ce_band: z.number().int().min(0).max(4).nullable().optional(),
  // Context Engineering Health scan summary (brain-api 1.11). Scalars only — never file
  // paths, filenames, or the checks' free-text detail strings. Same posture as `ce_band`:
  // no `.default()`, so an omitted field (older client, or the check simply didn't run)
  // stays distinguishable and can never clear a previously stored summary. It is an
  // object-or-absent field — the wire contract has no explicit-null form for it.
  // Provenance-only — never recomputed here, never feeds placement().
  context_health: z
    .object({
      score: z.number().int().min(0).max(4),
      mode: z.enum(["workspace", "repo"]),
      drift_count: z.number().int().nonnegative(),
      versions_behind: z.number().int().nonnegative().nullable().optional(),
      coverage_pct: z.number().min(0).max(100).nullable().optional(),
      broken_link_count: z.number().int().nonnegative(),
      checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});
export type MaturitySnapshotPayload = z.infer<
  typeof maturitySnapshotPayloadSchema
>;

export const usageCostPayloadSchema = z.object({
  member: z.string().max(120).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.enum([
    "cursor",
    "claude",
    "opencode",
    "anthropic",
    "openai",
    "codex",
    "other",
  ]),
  source: z.string().min(1).max(60),
  project: z.string().max(120).optional().default(""),
  input_tokens: z.number().int().nonnegative().optional().default(0),
  output_tokens: z.number().int().nonnegative().optional().default(0),
  cache_read_tokens: z.number().int().nonnegative().optional().default(0),
  cost_usd: z.number().nonnegative(),
  events: z.number().int().nonnegative().optional().default(0),
  meta: z.record(z.string(), z.unknown()).optional().default({}),
});
export type UsageCostPayload = z.infer<typeof usageCostPayloadSchema>;

/** A member's flat AI-tool subscription (v1.8) — real recurring spend, not per-token. */
export const subscriptionPayloadSchema = z.object({
  member: z.string().max(120).nullable().optional(),
  provider: z.enum([
    "cursor",
    "claude",
    "opencode",
    "anthropic",
    "openai",
    "codex",
    "other",
  ]),
  plan: z.string().max(60).optional().default(""),
  monthly_usd: z.number().nonnegative(),
  source: z.string().min(1).max(60).optional().default("unknown"),
});
export type SubscriptionPayload = z.infer<typeof subscriptionPayloadSchema>;

export const querySchema = z.object({
  question: z.string().min(1).max(4000),
  project: z.string().nullable().optional(),
  // Optional persistent thread (owned by the key's member). Omit to start a new one — the server
  // returns its id via a `conversation` SSE event. Pass it back so history loads server-side; this
  // is what lets the CLI / Telegram-via-Hermes share threads with the dashboard chat.
  conversation_id: z.string().uuid().optional(),
});

// Action-layer request (Organ 4). The brain authorizes `type` against policy before running.
export const actionRequestSchema = z.object({
  type: z.string().min(1).max(120),
  resource: z.string().min(1).max(500).optional().default("*"),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export const workEventPayloadSchema = z.object({
  project: z.string().min(1).max(120),
  event_kind: z.enum(["merged"]).optional().default("merged"),
  repo: z.string().min(1).max(200),
  merged_sha: z.string().min(7).max(64),
  pr_url: z.string().max(500).optional().default(""),
  pr_title: z.string().max(1000).optional().default(""),
  pr_body: z.string().max(100_000).optional().default(""),
  branch: z.string().max(300).optional().default(""),
  work_keys: z.array(z.string().min(1).max(80)).max(50).optional().default([]),
  actor: z.string().max(120).optional().default(""),
});
export type WorkEventPayload = z.infer<typeof workEventPayloadSchema>;

// ── Member invite (brain-api v1.7: POST /api/v1/members/invite) ─────────────────
// Wire is snake_case. `tools` selects the provisioning cascade: the literal "all"/"none", or an
// explicit array of tool names — an unknown tool name fails the `z.enum` (→ 422 invalid_payload).
// `.strict()` rejects unknown top-level keys. Email uses zod's `.email()`, identical to
// `isValidInviteEmail` (`lib/admin/members`, which is `z.string().email()`), kept inline so this
// shared schema module stays free of the server-only members lib.
export const PROVISIONING_TOOLS = ["linear", "slack", "github"] as const;

export const memberInviteRequestSchema = z
  .object({
    email: z.string().email(),
    display_name: z.string().trim().min(1),
    actor_handle: z.string().trim().min(1),
    role: z.enum(["member", "lead", "admin"]).optional().default("member"),
    // PRET-4 §1c: the invite-time access default — internal ('team', auto-enrolled in the
    // everyone group) vs external collaborator ('external', enrolled in the external group
    // only). Optional; absent keeps the historical wire behavior (team).
    tier: z.enum(["team", "external"]).optional().default("team"),
    tools: z
      .union([
        z.literal("all"),
        z.literal("none"),
        z.array(z.enum(PROVISIONING_TOOLS)),
      ])
      .optional()
      .default("all"),
  })
  .strict();
export type MemberInviteRequest = z.infer<typeof memberInviteRequestSchema>;

/**
 * Normalize tier per contract. Outward labels client (consultant) and company
 * (employee) → external. Returns null for admin/private/unknown (never stored).
 */
export function normalizeTier(tier: string): "team" | "external" | null {
  if (tier === "team") return "team";
  if (tier === "external" || tier === "client" || tier === "company")
    return "external";
  return null;
}

// The canonical task status set (brain-api §"Task rows"; postgres `task_status` enum). ORDER IS
// PART OF THE CONTRACT — it is the board's left-to-right order and the enum's sort order.
// `in_review` joined at brain-api v1.21 (AIO-950), between `in_progress` and `blocked`.
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done",
] as const;
export function normalizeTaskStatus(raw: string): {
  status: (typeof TASK_STATUSES)[number];
  raw_status: string | null;
} {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((TASK_STATUSES as readonly string[]).includes(s)) {
    return { status: s as (typeof TASK_STATUSES)[number], raw_status: null };
  }
  return { status: "backlog", raw_status: raw };
}

export const TASK_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
// Normalize a free-text priority to the allowed set. Unknown / empty → "none". Also accepts a few
// common aliases (e.g. Plane's "urgent", Linear's numeric labels are mapped upstream).
export function normalizeTaskPriority(
  raw: string | null | undefined,
): TaskPriority {
  const s = (raw ?? "").trim().toLowerCase();
  if ((TASK_PRIORITIES as readonly string[]).includes(s))
    return s as TaskPriority;
  if (s === "critical" || s === "p0" || s === "highest") return "urgent";
  if (s === "p1") return "high";
  if (s === "p2") return "medium";
  if (s === "p3" || s === "p4") return "low";
  return "none";
}

export function errorResponse(code: string, message: string, status: number) {
  return Response.json(
    { error: { code, message, request_id: crypto.randomUUID() } },
    { status },
  );
}

// ── Integrations (Wave 1 framework) ────────────────────────────────────────────
// The `integrations.config` jsonb holds NON-SECRET selection only. Secrets (tokens) live
// in the sidecar's env/connections.yaml and are merged locally — the brain never stores them.
// Enforcement (not just a comment): per-type `.strict()` allowlists reject unknown keys, an
// explicit secret-key scan rejects token-like keys anywhere (incl. nested), and a byte cap
// bounds the column.

export const INTEGRATION_TYPES = [
  "github",
  "slack",
  // Notion: the token is the SECRET; the non-secret selection is which pages (or one database) to pull.
  // The connector already exists (ingestion/aios_ingest/sources/notion.py + notion_authors.py, which
  // resolves created_by/last_edited_by → the item's authors) — it just had nowhere to read a token from.
  "notion",
  "linear",
  "plane",
  // ClickUp: the token is the SECRET (a `pk_…` personal API token); the non-secret selection is the
  // workspace, which Lists to import tasks from, and which Docs to read. The read client + normalizers
  // already exist (lib/ingest/sources/clickup.ts + clickup-normalize.ts, AIO-819) — they just had
  // nowhere to read a token from, so ClickUp could not be connected at all.
  "clickup",
  // LLM provider API keys. The key is stored encrypted in secret_ciphertext, same path as the
  // source connectors above. openai/anthropic/google are secret-only; openrouter also carries a
  // NON-secret `model` selection (the OpenAI-compatible gateway needs a model slug).
  "openai",
  "anthropic",
  "google",
  "openrouter",
  // Social publishing provider (Social Brain M5). Secret = the Typefully v2 API key; NON-secret
  // config carries the social-set id to post into.
  "typefully",
] as const;
/** Provider key integration types — the LLM providers whose key the query path resolves per team. */
export const PROVIDER_INTEGRATION_TYPES = ["openai", "anthropic", "google", "openrouter"] as const;
export type ProviderIntegrationType = (typeof PROVIDER_INTEGRATION_TYPES)[number];
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];
export const INTEGRATION_STATUSES = ["enabled", "disabled"] as const;

/**
 * Embeddings-provider config for the per-team "Embeddings model" Admin picker.
 *
 * ONLY openai + openrouter: the semantic index column is `item_chunks.embedding vector(1536)`
 * (fixed at load time), so the model MUST emit 1536 dims. Both providers serve OpenAI's
 * `text-embedding-3-small` (1536) over an OpenAI-compatible `/embeddings` endpoint. Anthropic has no
 * embeddings API; Google's are 768-dim — either would need a column rebuild + full re-index. The
 * curated list is a SINGLE model per provider so the UI can never introduce a second vector space
 * (see `canonicalEmbeddingModel` + the save-time space check in setEmbeddingModel).
 */
export const EMBEDDING_PROVIDER_TYPES = ["openai", "openrouter"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDER_TYPES)[number];

/** The vector dimension the `item_chunks` column is built at — every curated model must match it. */
export const EMBEDDING_DIM = 1536;

/** Curated 1536-dim models per provider (label shown in the picker). Widening this needs a re-index flow. */
export const EMBEDDING_MODELS: Record<EmbeddingProvider, { model: string; label: string }[]> = {
  openai: [{ model: "text-embedding-3-small", label: "text-embedding-3-small (1536d)" }],
  openrouter: [{ model: "openai/text-embedding-3-small", label: "openai/text-embedding-3-small (1536d)" }],
};

/**
 * Canonical vector-SPACE identity for an embedding model slug — provider prefix stripped, lowercased.
 * `openai/text-embedding-3-small` and `text-embedding-3-small` are the SAME underlying model → same
 * space → interchangeable with no re-embed. A different model (e.g. `text-embedding-ada-002`) is a
 * different space even at the same 1536 dims, so switching to it silently corrupts a 3-small index —
 * the save-time check compares canonical spaces to block exactly that. Pure + unit-tested.
 */
export function canonicalEmbeddingModel(model: string): string {
  const slug = (model ?? "").trim().toLowerCase();
  const slash = slug.lastIndexOf("/");
  return slash >= 0 ? slug.slice(slash + 1) : slug;
}

/** Is `model` an allowed 1536-dim model for `provider`? (Save-time corruption guard.) */
export function isCuratedEmbeddingModel(provider: EmbeddingProvider, model: string): boolean {
  return EMBEDDING_MODELS[provider].some((m) => m.model === model);
}

/** Per-type NON-SECRET config allowlists. `.strict()` rejects any key not listed. */
const integrationConfigSchemas: Record<IntegrationType, z.ZodType> = {
  github: z
    .object({
      repos: z.array(z.string().min(1).max(200)).max(200).default([]),
      // Inbound file-content ingestion: glob(s) of repo files to import as deliverable items.
      // Empty/absent ⇒ default to markdown (see lib/ingest/sources/github-files).
      fileGlobs: z.array(z.string().min(1).max(100)).max(50).optional(),
      // Member-onboarding provisioning: the GitHub org new members are invited into
      // (POST /orgs/{org}/invitations). NON-secret; the token stays encrypted in secret_ciphertext.
      org: z.string().max(100).optional(),
      // Per-repo import-history windows (AIO-798). An ARRAY of objects, not a Record keyed by
      // full_name: the secret-key scan walks nested object KEYS, so a repo literally named
      // `acme/token-service` in key position would make the whole config unsavable. `sinceIso` is
      // the anchor resolved ONCE at link — a recomputed (sliding) window would diff-delete issues
      // as they age out of the fetch. `.optional()`, never defaulted: an absent key stays absent,
      // so legacy rows are byte-identical and "no entry = pre-window behaviour" holds at the
      // storage layer. See docs/design/repo-import-history-estimate.md.
      repoHistory: z
        .array(
          z
            .object({
              repo: z.string().min(1).max(200),
              days: z.number().int().min(0).max(3650),
              sinceIso: z.string().datetime({ offset: true }).max(40),
            })
            .strict()
        )
        .max(200)
        .optional(),
    })
    .strict(),
  slack: z
    .object({
      channelIds: z.array(z.string().min(1).max(40)).max(200).default([]),
      // Member-onboarding provisioning: a standing workspace join link surfaced to new members
      // (Slack Free/Pro has no invite API — link mode only). NON-secret, so it lives in config.
      inviteLink: z.string().url().max(500).optional(),
    })
    .strict(),
  // Either pageIds OR databaseId — the connector requires one (it raises if both are absent). Not
  // enforced here: a half-configured integration must be savable, and the connector reports the error.
  notion: z
    .object({
      pageIds: z.array(z.string().min(1).max(120)).max(200).default([]),
      databaseId: z.string().max(120).optional(),
    })
    .strict(),
  linear: z
    .object({
      teamId: z.string().max(64).optional(),
      projectId: z.string().max(64).optional(),
      doneStateName: z.string().max(80).optional(),
      // Per-team opt-in for the v1.4 inbound apply (Linear→brain status + adopt). Default off:
      // enabling Linear-writes-brain is a deliberate, reversible, per-team act (brain-api v1.4).
      inboundApply: z.boolean().optional(),
      // Member-onboarding provisioning: which Linear team(s) a new member is added to on invite, and
      // the invite role (default resolves from tier: external→guest, else user). NON-secret hints.
      inviteTeamIds: z.array(z.string().max(64)).max(20).optional(),
      inviteRole: z.enum(["user", "admin", "guest"]).optional(),
    })
    .strict(),
  // ClickUp: `workspaceId` drives the brain project slug (`clickup-<ws>`) and every task/doc identity;
  // `listIds` is the task selection; `docIds`/`docParent*` select Docs. A half-configured integration
  // stays savable (same stance as notion) — the runner reports what's missing.
  //
  // `statusMaps` is an ARRAY keyed by an INNER `listId` field, deliberately not a
  // `Record<listId, …>`: the secret-key scan below walks nested object KEYS, so a List id in key
  // position would be scanned as a config key — the same hazard `github.repoHistory` documents.
  clickup: z
    .object({
      workspaceId: z.string().max(64).optional(),
      listIds: z.array(z.string().min(1).max(64)).max(200).default([]),
      statusMaps: z
        .array(
          z
            .object({
              listId: z.string().min(1).max(64),
              backlog: z.string().min(1).max(80),
              ready: z.string().min(1).max(80),
              in_progress: z.string().min(1).max(80),
              // brain-api v1.21: OPTIONAL, unlike its five siblings. This map is an operator's saved
              // per-List configuration; making the new member required would `.strict()`-invalidate
              // every config saved before 1.21 and fail-close its whole ClickUp import. Absent = this
              // List simply has no In Review state, exactly as before the bump.
              in_review: z.string().min(1).max(80).optional(),
              blocked: z.string().min(1).max(80),
              done: z.string().min(1).max(80),
            })
            .strict()
        )
        .max(200)
        .optional(),
      docIds: z.array(z.string().min(1).max(64)).max(200).optional(),
      docParentType: z.enum(["SPACE", "FOLDER", "LIST", "EVERYTHING", "WORKSPACE"]).optional(),
      docParentId: z.string().max(64).optional(),
    })
    .strict(),
  plane: z
    .object({
      baseUrl: z.string().max(200).optional(),
      workspaceSlug: z.string().max(120).optional(),
      projectId: z.string().max(64).optional(),
      doneStateName: z.string().max(80).optional(),
      externalSource: z.string().max(80).optional(),
    })
    .strict(),
  // Provider key types hold the encrypted secret plus an optional NON-secret answer-model slug
  // (which model that provider's key answers with — surfaced/chosen in Admin → Integrations).
  // google stays config-less (not wired into answering yet).
  openai: z.object({ model: z.string().min(1).max(120).optional() }).strict(),
  anthropic: z.object({ model: z.string().min(1).max(120).optional() }).strict(),
  google: z.object({}).strict(),
  openrouter: z.object({ model: z.string().min(1).max(120).optional() }).strict(),
  // Typefully: the social-set id to publish into (NON-secret); the API key stays encrypted.
  typefully: z.object({ socialSetId: z.string().min(1).max(120).optional() }).strict(),
};

const SECRET_KEY_RE =
  /token|secret|api[_-]?key|password|bearer|credential|client[_-]?secret|private[_-]?key/i;
const MAX_CONFIG_BYTES = 8 * 1024;

/** Thrown when integration config is malformed/oversized/contains a secret-like key (→ 400). */
export class IntegrationConfigError extends Error {}

/**
 * A client-side validation failure detected during ingest (e.g. a malformed task row or a
 * task-hierarchy violation: missing/self/cyclic parent). The /api/v1/items route maps this to
 * 422 invalid_payload so the CLI gets a structured "fix your markdown" signal, not a 500.
 */
export class IngestValidationError extends Error {}

/**
 * The pushing principal's tier forbids this write. Distinct from `IngestValidationError` because the
 * payload is well-formed — it's the PRINCIPAL that isn't allowed, so the wire answer is 403 (`forbidden_tier`),
 * not 422. Tier isolation is enforced entirely in app code (no RLS, CLAUDE.md §5), which is exactly why a
 * refusal here has to be loud rather than a silent clamp: an external key that finds itself pushing at a
 * team item's path is either misconfigured or probing, and both deserve an error the caller can see.
 */
export class TierViolationError extends Error {}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  }
  return out;
}

/**
 * Validate + normalize an integration's NON-SECRET config. Order: byte cap → secret-key scan
 * (anywhere, incl. nested) → per-type `.strict()` allowlist. Throws IntegrationConfigError.
 */
export function validateIntegrationConfig(
  type: IntegrationType,
  config: unknown,
): Record<string, unknown> {
  const value = config ?? {};
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_CONFIG_BYTES) {
    throw new IntegrationConfigError(
      `config exceeds ${MAX_CONFIG_BYTES} bytes`,
    );
  }
  for (const key of collectKeys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new IntegrationConfigError(
        `secret-like key "${key}" is not allowed — secrets stay in the sidecar's local config, never the brain`,
      );
    }
  }
  // A RETIRED type (`wise`, `granola`) or any forged value has no schema. The DB CHECK still
  // tolerates the retired ones so a self-host's legacy row can't break a schema load — but nothing
  // may CREATE one, and dereferencing the missing schema would surface a raw TypeError instead of
  // a clean validation failure.
  const schema = integrationConfigSchemas[type];
  if (!schema) {
    throw new IntegrationConfigError(`unknown or retired integration type "${type}"`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new IntegrationConfigError(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data as Record<string, unknown>;
}

export const integrationInputSchema = z.object({
  type: z.enum(INTEGRATION_TYPES),
  name: z.string().min(1).max(120),
  config: z.unknown().optional(),
  status: z.enum(INTEGRATION_STATUSES).optional(),
  // Connector secret (e.g. a Slack `xoxb-` token). Stored ENCRYPTED, never in `config`.
  // Omit to leave an existing secret unchanged; provide to set/rotate it.
  secret: z.string().min(1).max(8192).optional(),
});
export type IntegrationInput = z.infer<typeof integrationInputSchema>;
