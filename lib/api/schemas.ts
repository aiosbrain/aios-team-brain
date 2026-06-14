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
  kind: z.enum(["deliverable", "transcript", "decision", "task", "artifact", "skill"]),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().max(120).optional().default(""),
  access: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional().default({}),
  body: z.string().max(1_000_000),
  rows: z.array(z.unknown()).optional(),
});
export type ItemPayload = z.infer<typeof itemPayloadSchema>;

export const querySchema = z.object({
  question: z.string().min(1).max(4000),
  project: z.string().nullable().optional(),
});

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

export function errorResponse(code: string, message: string, status: number) {
  return Response.json(
    { error: { code, message, request_id: crypto.randomUUID() } },
    { status }
  );
}
