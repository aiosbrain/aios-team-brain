import { z } from "zod";

/**
 * Zod schemas mirroring the pinned contract:
 * aios-workspace/docs/brain-api.md (v1).
 * Tier vocabulary: canonical admin|team|external; `client` is a legacy alias
 * normalized to external on ingest; `admin` is rejected with 422.
 */

export const taskRowSchema = z.object({
  row_key: z.string().min(1),
  title: z.string(),
  assignee: z.string().optional().default(""),
  status: z.string().optional().default(""),
  sprint: z.string().optional().default(""),
  due: z.string().nullable().optional(),
  // Hierarchy fields (brain-api v1.2, all optional). `parent` is the epic's row_key; `labels` is a
  // string array; `priority` is sent verbatim and normalized server-side. `body` is intentionally
  // absent — it is dashboard/DB-only and never travels through the contract.
  parent: z.string().nullable().optional(),
  labels: z.array(z.string().max(80)).max(50).optional(),
  priority: z.string().max(20).nullable().optional(),
  pm_provider: z.enum(["plane", "linear"]).nullable().optional(),
  pm_external_id: z.string().max(200).nullable().optional(),
  pm_url: z.string().max(500).nullable().optional(),
});

export const decisionRowSchema = z.object({
  row_key: z.string().min(1),
  decided_at: z.string().nullable().optional(),
  title: z.string(),
  rationale: z.string().optional().default(""),
  decided_by: z.string().optional().default(""),
  impact: z.string().optional().default(""),
  tier: z.number().int().nullable().optional(),
  audience: z.string().optional().default("team"),
});

export const itemPayloadSchema = z.object({
  project: z.string().min(1).max(120),
  path: z.string().min(1).max(500),
  kind: z.enum(["deliverable", "transcript", "decision", "task", "artifact", "skill", "blueprint"]),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().max(120).optional().default(""),
  access: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional().default({}),
  body: z.string().max(1_000_000),
  rows: z.array(z.unknown()).optional(),
});
export type ItemPayload = z.infer<typeof itemPayloadSchema>;

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
    .regex(/^[A-Za-z0-9._-]+$/, "slug must be route-safe (letters, digits, '.', '_', '-')"),
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
  test_coverage_pct: z.number().min(0).max(100).nullable().optional().default(null),
  recent_commits: z.array(z.record(z.string(), z.unknown())),
  // explicit scaffolding inputs (required)
  has_claude_md: z.boolean(),
  has_agents_md: z.boolean(),
  agents_md_count: z.number().int().nonnegative(),
  skills_count: z.number().int().nonnegative(),
  commands_count: z.number().int().nonnegative(),
  // cadence inputs (used to compute cadence_score; not persisted raw)
  active_days: z.number().int().nonnegative().optional().default(0),
  days_since_last_commit: z.number().int().nonnegative().nullable().optional().default(null),
  // AEM agent-readiness — scored scanner-side against the canonical rubric
  // (agentic-engineering-maturity/rubric/agent-readiness.json); the brain persists as-is.
  // Validate at the boundary so malformed scanner output can't become permanent analytics:
  // level is the fixed L0..L5 ladder, and a pillar can't report more passed than total.
  readiness_level: z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]).nullable().optional().default(null),
  readiness_pct: z.number().min(0).max(100).nullable().optional().default(null),
  readiness_pillars: z
    .record(
      z.string(),
      z
        .object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
        .refine((p) => p.passed <= p.total, { message: "passed must be <= total" })
    )
    .optional()
    .default({}),
  readiness_rubric_version: z.string().max(32).nullable().optional().default(null),
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

export const codebaseScanPayloadSchema = z.object({
  codebase: codebaseRecordSchema,
  metrics: codeMetricsSchema,
  contributions: z.array(codeContributionSchema).max(5000).optional().default([]),
  issues: z.array(githubIssueSchema).max(5000).optional().default([]),
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
});
export type MaturitySnapshotPayload = z.infer<typeof maturitySnapshotPayloadSchema>;

export const usageCostPayloadSchema = z.object({
  member: z.string().max(120).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.enum(["cursor", "claude", "anthropic", "openai", "codex", "other"]),
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

export const querySchema = z.object({
  question: z.string().min(1).max(4000),
  project: z.string().nullable().optional(),
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

/**
 * Normalize tier per contract. Outward labels client (consultant) and company
 * (employee) → external. Returns null for admin/private/unknown (never stored).
 */
export function normalizeTier(tier: string): "team" | "external" | null {
  if (tier === "team") return "team";
  if (tier === "external" || tier === "client" || tier === "company") return "external";
  return null;
}

export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"] as const;
export function normalizeTaskStatus(raw: string): {
  status: (typeof TASK_STATUSES)[number];
  raw_status: string | null;
} {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((TASK_STATUSES as readonly string[]).includes(s)) {
    return { status: s as (typeof TASK_STATUSES)[number], raw_status: null };
  }
  return { status: "backlog", raw_status: raw };
}

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
// Normalize a free-text priority to the allowed set. Unknown / empty → "none". Also accepts a few
// common aliases (e.g. Plane's "urgent", Linear's numeric labels are mapped upstream).
export function normalizeTaskPriority(raw: string | null | undefined): TaskPriority {
  const s = (raw ?? "").trim().toLowerCase();
  if ((TASK_PRIORITIES as readonly string[]).includes(s)) return s as TaskPriority;
  if (s === "critical" || s === "p0" || s === "highest") return "urgent";
  if (s === "p1") return "high";
  if (s === "p2") return "medium";
  if (s === "p3" || s === "p4") return "low";
  return "none";
}

export function errorResponse(code: string, message: string, status: number) {
  return Response.json(
    { error: { code, message, request_id: crypto.randomUUID() } },
    { status }
  );
}

// ── Integrations (Wave 1 framework) ────────────────────────────────────────────
// The `integrations.config` jsonb holds NON-SECRET selection only. Secrets (tokens) live
// in the sidecar's env/connections.yaml and are merged locally — the brain never stores them.
// Enforcement (not just a comment): per-type `.strict()` allowlists reject unknown keys, an
// explicit secret-key scan rejects token-like keys anywhere (incl. nested), and a byte cap
// bounds the column.

export const INTEGRATION_TYPES = ["github", "granola", "slack", "wise", "linear", "plane"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];
export const INTEGRATION_STATUSES = ["enabled", "disabled"] as const;

/** Per-type NON-SECRET config allowlists. `.strict()` rejects any key not listed. */
const integrationConfigSchemas: Record<IntegrationType, z.ZodType> = {
  github: z.object({ repos: z.array(z.string().min(1).max(200)).max(200).default([]) }).strict(),
  slack: z.object({ channelIds: z.array(z.string().min(1).max(40)).max(200).default([]) }).strict(),
  granola: z
    .object({
      // Privacy allowlist: only meetings matching these are candidates for decision extraction.
      matchKeywords: z.array(z.string().min(1).max(120)).max(50).default([]),
      participantEmails: z.array(z.string().email().max(200)).max(50).default([]),
    })
    .strict(),
  wise: z.object({ profileId: z.string().max(64).optional() }).strict(),
  linear: z
    .object({
      teamId: z.string().max(64).optional(),
      projectId: z.string().max(64).optional(),
      doneStateName: z.string().max(80).optional(),
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
};

const SECRET_KEY_RE = /token|secret|api[_-]?key|password|bearer|credential|client[_-]?secret|private[_-]?key/i;
const MAX_CONFIG_BYTES = 8 * 1024;

/** Thrown when integration config is malformed/oversized/contains a secret-like key (→ 400). */
export class IntegrationConfigError extends Error {}

/**
 * A client-side validation failure detected during ingest (e.g. a malformed task row or a
 * task-hierarchy violation: missing/self/cyclic parent). The /api/v1/items route maps this to
 * 422 invalid_payload so the CLI gets a structured "fix your markdown" signal, not a 500.
 */
export class IngestValidationError extends Error {}

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
  config: unknown
): Record<string, unknown> {
  const value = config ?? {};
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_CONFIG_BYTES) {
    throw new IntegrationConfigError(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  for (const key of collectKeys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new IntegrationConfigError(
        `secret-like key "${key}" is not allowed — secrets stay in the sidecar's local config, never the brain`
      );
    }
  }
  const parsed = integrationConfigSchemas[type].safeParse(value);
  if (!parsed.success) {
    throw new IntegrationConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")
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
