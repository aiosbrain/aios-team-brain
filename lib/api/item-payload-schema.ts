import { z } from "zod";

export const taskRowSchema = z.strictObject({
  row_key: z.string().min(1).max(200),
  title: z.string().max(2000),
  assignee: z.string().max(200).optional(),
  status: z.string().max(120).optional().default(""),
  sprint: z.string().max(200).optional().default(""),
  due: z.string().max(64).nullable().optional(),
  parent: z.string().max(200).nullable().optional(),
  labels: z.array(z.string().max(80)).max(50).optional(),
  priority: z.string().max(20).nullable().optional(),
  pm_provider: z.enum(["plane", "linear"]).nullable().optional(),
  pm_external_id: z.string().max(200).nullable().optional(),
  pm_url: z.string().max(500).nullable().optional(),
});

export const decisionRowSchema = z.strictObject({
  row_key: z.string().min(1).max(200),
  decided_at: z.string().max(64).nullable().optional(),
  title: z.string().max(2000),
  rationale: z.string().max(4000).optional().default(""),
  decided_by: z.string().max(500).optional().default(""),
  impact: z.string().max(4000).optional().default(""),
  tier: z.number().int().min(1).max(3).nullable().optional(),
  audience: z.enum(["team", "external"]).optional().default("team"),
});

export const factRowSchema = z.strictObject({
  row_key: z.string().min(1).max(128),
  title: z.string().min(1).max(500),
  occurred_at: z
    .string()
    .min(1)
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/)
    .optional(),
  fact_type: z.enum(["fact", "event"]),
  source_path: z.string().min(1).max(500),
  source_quote: z.string().min(1).max(4000),
});

export const stakeholderMentionRowSchema = z.strictObject({
  row_key: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(200).optional(),
  context: z.string().min(1).max(1000).optional(),
  source_path: z.string().min(1).max(500),
  source_quote: z.string().min(1).max(4000),
});

export type TaskRow = z.infer<typeof taskRowSchema>;
export type DecisionRow = z.infer<typeof decisionRowSchema>;
export type FactRow = z.infer<typeof factRowSchema>;
export type StakeholderMentionRow = z.infer<typeof stakeholderMentionRowSchema>;

const commonItemFields = {
  project: z.string().min(1).max(120),
  path: z.string().min(1).max(500),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().max(120).optional().default(""),
  access: z.enum(["team", "external", "client", "company", "admin", "private"]),
  frontmatter: z.record(z.string(), z.unknown()).optional().default({}),
  body: z.string().max(1_000_000),
};

const taskPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("task"),
  rows: z.array(taskRowSchema).optional(),
});

const decisionPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("decision"),
  rows: z.array(decisionRowSchema).optional(),
});

const factPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("fact"),
  rows: z.array(factRowSchema).min(1),
});

const stakeholderMentionPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("stakeholder_mention"),
  rows: z.array(stakeholderMentionRowSchema).min(1),
});

const nonRowPayloadSchema = (
  kind: "deliverable" | "transcript" | "artifact" | "skill" | "blueprint",
) =>
  z.strictObject({
    ...commonItemFields,
    kind: z.literal(kind),
    rows: z.never().optional(),
  });

export const itemPayloadSchema = z.discriminatedUnion("kind", [
  taskPayloadSchema,
  decisionPayloadSchema,
  factPayloadSchema,
  stakeholderMentionPayloadSchema,
  nonRowPayloadSchema("deliverable"),
  nonRowPayloadSchema("transcript"),
  nonRowPayloadSchema("artifact"),
  nonRowPayloadSchema("skill"),
  nonRowPayloadSchema("blueprint"),
]);

export type ItemPayload = z.infer<typeof itemPayloadSchema>;
