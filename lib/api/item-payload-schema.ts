import { z } from "zod";

/**
 * The maximum number of `rows` one item payload may carry OVER THE WIRE (brain-api 1.20, AIO-923).
 *
 * WHY A ROW BOUND AND NOT JUST A BIGGER TRANSPORT ONE: `rows` was unbounded, so the only thing that
 * actually stopped an over-large push was `POST /api/v1/items`'s `content-length` gate — a bare
 * `413 payload_too_large / "max 1 MB"` naming no field and no ceiling. A real ClickUp workspace
 * crossed it at roughly 1,100 tasks (measured: 1,000 rows = 1,089,970 B accepted; 3,500 =
 * 1,918,564 B rejected), so a 35-List workspace failed atomically at ~32 tasks per List with an
 * error that read like a server limit rather than a payload one.
 *
 * WHY NOT CHUNK CLIENT-SIDE — for `task`, which is the kind this actually bit. `lib/ingest/tasks.ts`
 * sweeps PROJECT-wide (`project_id` + `origin='sync'`, no item filter), so a second `task` item in the
 * same project deletes the first one's rows. Splitting one project's tasks across pushes silently
 * destroys data; the contract has to accept the whole set or say why not.
 * The other three row kinds sweep per-ITEM — `decisions.ts` scopes its diff-delete to
 * `source_item_id = itemId`, and `evidence.ts` does the same for `fact`/`stakeholder_mention` — so
 * for those, splitting across DISTINCT PATHS is in fact safe. `task` is the exception, not the rule.
 *
 * So the bound moves to where it can be DIAGNOSED: Zod rejects at a stated row count and `route.ts`
 * surfaces that message as a `422 invalid_payload` naming the limit, while the transport gate is
 * raised so 5,000 rows fit. `body` keeps its independent 1 MB cap — a huge document and a huge row
 * set are different failures and deserve different errors.
 *
 * ⚠️ WIRE ONLY — this is deliberately NOT applied by `itemPayloadSchema`. `ingestItem`
 * (`lib/ingest/index.ts`) re-parses every payload through that schema, including the ones the
 * IN-PROCESS mirror legs build, and those have no transport step and legitimately exceed 5,000:
 * `fetchLinearTeam` paginates 200 × 100 = up to 20,000 issues into ONE `task` item, and the GitHub
 * and Plane legs are shaped the same way. Capping the shared schema would have turned a working
 * import into a permanent `IngestValidationError` on every tick, for a source whose admin cannot act
 * on the remediation ("select fewer Lists" means nothing to a Linear team). The cap belongs on
 * untrusted HTTP input, which is the only place a transport gate ever bounded it.
 */
export const MAX_PAYLOAD_ROWS = 5_000;

/**
 * `route.ts` returns `issues[0].message` VERBATIM and drops the issue `path`, so the field name and
 * the ceiling both have to be inside the message or the 422 is as undiagnosable as the 413 it replaces.
 *
 * The advice is "narrow the selection", not "split into two pushes": for `task`/`decision` a second
 * push of the same project deletes the first (project-scoped sweep). For `fact`/`stakeholder_mention`
 * the sweep is per-ITEM (`lib/ingest/evidence.ts`), so distinct paths would in fact be safe — the
 * message stays conservative rather than offering advice that is only sometimes true.
 */
const ROWS_LIMIT_MESSAGE = `rows: at most ${MAX_PAYLOAD_ROWS} rows per item payload — narrow the source selection so it maps to more than one project; do NOT split one project's rows across pushes`;

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

const nonRowPayloadSchema = (
  kind: "deliverable" | "transcript" | "artifact" | "skill" | "blueprint",
) =>
  z.strictObject({
    ...commonItemFields,
    kind: z.literal(kind),
    rows: z.never().optional(),
  });

/**
 * The payload union, parameterized by the `rows` cap — the ONE difference between the wire schema
 * and the storage schema. `maxRows: null` means unbounded (the pre-1.20 shape).
 *
 * Both unions are built from the same field definitions, so a shape change can only ever apply to
 * both: the wire schema is the storage schema PLUS a row ceiling, never a different contract.
 */
function buildItemPayloadSchema(maxRows: number | null) {
  const rows = <T extends z.ZodType>(row: T) => {
    const arr = z.array(row);
    return maxRows === null ? arr : arr.max(maxRows, ROWS_LIMIT_MESSAGE);
  };
  return z.discriminatedUnion("kind", [
    z.strictObject({ ...commonItemFields, kind: z.literal("task"), rows: rows(taskRowSchema).optional() }),
    z.strictObject({ ...commonItemFields, kind: z.literal("decision"), rows: rows(decisionRowSchema).optional() }),
    z.strictObject({ ...commonItemFields, kind: z.literal("fact"), rows: rows(factRowSchema).min(1) }),
    z.strictObject({
      ...commonItemFields,
      kind: z.literal("stakeholder_mention"),
      rows: rows(stakeholderMentionRowSchema).min(1),
    }),
    nonRowPayloadSchema("deliverable"),
    nonRowPayloadSchema("transcript"),
    nonRowPayloadSchema("artifact"),
    nonRowPayloadSchema("skill"),
    nonRowPayloadSchema("blueprint"),
  ]);
}

/**
 * The STORAGE shape — what `ingestItem` re-parses, and what every normalizer test asserts against.
 * `rows` is UNBOUNDED here on purpose (see `MAX_PAYLOAD_ROWS`): the in-process Linear/Plane/GitHub
 * mirror legs build one `task` item per team/repo and can legitimately exceed the wire ceiling.
 */
export const itemPayloadSchema = buildItemPayloadSchema(null);

/**
 * The WIRE shape — what `POST /api/v1/items` parses. Identical to `itemPayloadSchema` except that
 * `rows` is capped at `MAX_PAYLOAD_ROWS`, so untrusted HTTP input fails as a diagnosable 422 rather
 * than an opaque 413. Guarded by `test/guards/wire-vs-storage-payload-schema.test.ts`.
 */
export const wireItemPayloadSchema = buildItemPayloadSchema(MAX_PAYLOAD_ROWS);

export type ItemPayload = z.infer<typeof itemPayloadSchema>;
