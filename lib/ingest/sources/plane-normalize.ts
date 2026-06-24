import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import { normalizeTaskStatus } from "@/lib/api/schemas";

/**
 * Pure: a Plane project's fetched work-items → ONE brain `kind="task"` ItemPayload
 * whose `rows[]` diff-sync by a stable `row_key`.
 *
 * Design invariants (see docs/ARCHITECTURE.md, lib/ingest/index.ts):
 *   • Dedicated brain project per Plane project (`plane-<identifier>`). The task
 *     diff-delete in materializeTasks is PROJECT-WIDE, so Plane imports must never
 *     share a project with CLI/UI tasks or each import would delete the others.
 *   • One-directional (Plane → brain). Items the brain itself projected OUT to Plane
 *     (external_source starting "aios") are de-duped (skipped): the brain already owns
 *     that row_key in its real project, so re-importing would duplicate. This also
 *     keeps the "brain wins, one-way out" pm-sync invariant intact.
 *   • Org structure preserved: sub-issue parent → parent_row_key (resolved only within
 *     the imported set; a parent that was skipped/absent is nulled, never dangling),
 *     module → sprint (round-trip-consistent with pm-sync's sprint→module mapping),
 *     labels/state/priority/assignee carried through.
 *   • Deterministic output: rows are sorted and every projectable field is serialized
 *     into the body, so re-importing an unchanged board is a true no-op at the writer
 *     (sha256 dedup) while any real change shifts the sha.
 */

export interface PlaneState {
  id: string;
  name?: string;
  group?: string; // backlog | unstarted | started | completed | cancelled
}

export interface PlaneWorkItemRaw {
  id: string;
  sequence_id?: number;
  name?: string;
  state?: string; // state id
  priority?: string | null;
  labels?: string[] | null; // label ids
  assignees?: string[] | null; // member ids
  parent?: string | null; // parent work-item id
  external_id?: string | null;
  external_source?: string | null;
}

export interface NormalizePlaneInput {
  projectId: string;
  /** Plane project's short identifier (e.g. "ENG") — drives the brain project slug + row_key prefix. */
  projectIdentifier?: string;
  workspaceSlug: string;
  baseUrl: string;
  items: PlaneWorkItemRaw[];
  states: PlaneState[];
  labels?: { id: string; name: string }[];
  /** member id → display name (best-effort). */
  members?: Record<string, string>;
  /** work-item id → module (epic) name. Maps to `sprint` (round-trip-consistent with pm-sync). */
  moduleByItem?: Record<string, string>;
  /** work-item id → cycle (iteration) name. Maps to a namespaced `cycle:<name>` label. */
  cycleByItem?: Record<string, string>;
  /** external_source values that mark a brain-projected round-tripper. Defaults to the aios markers. */
  aiosSources?: string[];
}

export interface PlaneTaskRow {
  row_key: string;
  title: string;
  status: string;
  priority: string;
  labels: string[];
  assignee: string;
  sprint: string;
  parent?: string | null;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

const GROUP_TO_STATUS: Record<string, string> = {
  backlog: "backlog",
  unstarted: "ready",
  started: "in_progress",
  completed: "done",
  cancelled: "done", // terminal/closed; the brain has no distinct "cancelled"
};

/** A state literally NAMED like a brain status wins (e.g. a "Blocked" state in the started group); else map by group. */
function planeStatus(stateName: string | undefined, group: string | undefined): string {
  const byName = normalizeTaskStatus(stateName ?? "");
  if (byName.raw_status === null && byName.status !== "backlog") return byName.status;
  return GROUP_TO_STATUS[group ?? ""] ?? "backlog";
}

function isAiosOrigin(src: string | null | undefined, aiosSources: string[]): boolean {
  if (!src) return false;
  const s = src.toLowerCase();
  return aiosSources.includes(src) || s.startsWith("aios");
}

function rowKeyFor(item: PlaneWorkItemRaw, identifier: string | undefined): string {
  const prefix = (identifier && safeSegment(identifier).toUpperCase()) || "PLANE";
  if (typeof item.sequence_id === "number") return `${prefix}-${item.sequence_id}`;
  return `${prefix}-${item.id.slice(0, 8)}`;
}

export function normalizePlaneProject(input: NormalizePlaneInput): ItemPayload {
  const aiosSources = input.aiosSources ?? ["aios", "aios-backlog"];
  const stateById = new Map(input.states.map((s) => [s.id, s]));
  const labelById = new Map((input.labels ?? []).map((l) => [l.id, l.name]));
  const members = input.members ?? {};
  const moduleByItem = input.moduleByItem ?? {};
  const cycleByItem = input.cycleByItem ?? {};

  const identifier = input.projectIdentifier;
  const slugSeg = safeSegment(identifier || input.projectId.slice(0, 8)) || "project";
  const project = `plane-${slugSeg}`;

  // Included = everything except brain-projected round-trippers (de-dupe). Stable sort so re-import
  // produces byte-identical output → a true no-op at the sha256 writer.
  const included = input.items
    .filter((it) => !isAiosOrigin(it.external_source, aiosSources))
    .sort((a, b) => (a.sequence_id ?? 0) - (b.sequence_id ?? 0) || a.id.localeCompare(b.id));

  // plane item id → row_key, for resolving sub-issue parents within the imported set only.
  const idToRowKey = new Map(included.map((it) => [it.id, rowKeyFor(it, identifier)]));

  const rows: PlaneTaskRow[] = included.map((it) => {
    const st = it.state ? stateById.get(it.state) : undefined;
    const labels = (it.labels ?? [])
      .map((id) => labelById.get(id))
      .filter((n): n is string => Boolean(n));
    // Cycle (iteration) has no dedicated task column → carry it as a namespaced label so it survives
    // and stays distinct from module→sprint. Cap at the row schema's 80-char label limit.
    const cycle = cycleByItem[it.id];
    if (cycle) labels.push(`cycle:${cycle}`.slice(0, 80));
    const assignee = (it.assignees ?? [])
      .map((id) => members[id] ?? id)
      .join(", ");
    const row: PlaneTaskRow = {
      row_key: rowKeyFor(it, identifier),
      title: it.name?.trim() || "(untitled)",
      status: planeStatus(st?.name, st?.group),
      priority: (it.priority ?? "none") || "none",
      labels,
      assignee,
      sprint: moduleByItem[it.id] ?? "",
    };
    if (it.parent) {
      // Resolve only within the imported set; a parent that was skipped/absent is nulled (never dangling).
      row.parent = idToRowKey.get(it.parent) ?? null;
    }
    return row;
  });

  // Serialize every projectable field so any change shifts the sha (writer never short-circuits a real change).
  const lines = rows.map(
    (r) =>
      `| ${r.row_key} | ${r.title} | ${r.status} | ${r.priority} | ${r.sprint} | ${r.assignee} | ` +
      `${JSON.stringify(r.labels)} | ${r.parent ?? ""} |`
  );
  const body = `# Plane import — ${input.workspaceSlug}/${slugSeg}\n\n${lines.join("\n")}\n`;

  return {
    project,
    path: `plane/${slugSeg}/work-items.md`,
    kind: "task",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "plane",
      workspace: input.workspaceSlug,
      project_id: input.projectId,
      identifier: identifier ?? "",
      item_count: rows.length,
    },
    body,
    rows,
  };
}
