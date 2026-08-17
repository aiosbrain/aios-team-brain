import { z } from "zod";

/**
 * The maximum number of `rows` one item payload may carry (brain-api 1.20, AIO-923).
 *
 * WHY A ROW BOUND AND NOT A BIGGER TRANSPORT ONE: `rows` was unbounded, so the only thing that
 * actually stopped an over-large push was `POST /api/v1/items`'s `content-length` gate — a bare
 * `413 payload_too_large / "max 1 MB"` naming no field and no ceiling. A real ClickUp/Linear
 * workspace crossed it at roughly 1,100 tasks (measured: 1,000 rows = 1,089,970 B accepted;
 * 3,500 = 1,918,564 B rejected), so a 35-List workspace failed atomically at ~32 tasks per List
 * with an error that read like a server limit rather than a payload one.
 *
 * WHY NOT CHUNK CLIENT-SIDE: the row sweep in `lib/ingest/tasks.ts` DELETES every synced row in the
 * project that the incoming item omits, so a second chunk deletes the first. Splitting a workspace
 * across pushes silently destroys data; the contract has to accept the whole set or say why not.
 *
 * So the bound moves to where it can be DIAGNOSED: Zod rejects at a stated row count and
 * `route.ts` surfaces that message as a `422 invalid_payload` naming the real limit, while the
 * transport gate is raised to fit 5,000 rows (~700 B/row ≈ 3.5 MB). `body` stays capped at 1 MB
 * independently — a huge document and a huge row set are different failures and keep different caps.
 */
export const MAX_PAYLOAD_ROWS = 5_000;

/**
 * `route.ts` returns `issues[0].message` VERBATIM and drops the issue `path`, so the field name and
 * the ceiling both have to be inside the message or the 422 is as undiagnosable as the 413 it replaces.
 */
const ROWS_LIMIT_MESSAGE = `rows: at most ${MAX_PAYLOAD_ROWS} rows per item payload (split the source across projects, never across pushes — a second push deletes the first)`;

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
  // Provider work-signal time (the task's last STATE-TRANSITION timestamp; Linear
  // startedAt/completedAt/canceledAt, falling back to updatedAt). Brain-INTERNAL: the mirror
  // importers (lib/ingest/sources/{linear,plane}-normalize) build `task` payloads carrying it and
  // re-enter through this same strict parser, so it must be accepted here. It is deliberately NOT in
  // the published wire schema (item-payload-1.12.schema.json, additionalProperties:false) — the
  // workspace CLI does not send it yet, so the Zod parser is a superset of the wire contract for the
  // task kind. Absent key ⇒ preserve the stored value (partial-write, like assignee/parent);
  // materialized into tasks.worked_at as the timeline "did work on it" signal.
  worked_at: z.string().max(64).nullable().optional(),
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
  rows: z.array(taskRowSchema).max(MAX_PAYLOAD_ROWS, ROWS_LIMIT_MESSAGE).optional(),
});

const decisionPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("decision"),
  rows: z.array(decisionRowSchema).max(MAX_PAYLOAD_ROWS, ROWS_LIMIT_MESSAGE).optional(),
});

const factPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("fact"),
  rows: z.array(factRowSchema).min(1).max(MAX_PAYLOAD_ROWS, ROWS_LIMIT_MESSAGE),
});

const stakeholderMentionPayloadSchema = z.strictObject({
  ...commonItemFields,
  kind: z.literal("stakeholder_mention"),
  rows: z.array(stakeholderMentionRowSchema).min(1).max(MAX_PAYLOAD_ROWS, ROWS_LIMIT_MESSAGE),
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
