import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import { normalizeTaskStatus } from "@/lib/api/schemas";
import { parseExt } from "@/lib/pm-sync/linear-client";

/**
 * Pure: a Linear team's fetched issues → ONE brain `kind="task"` ItemPayload whose `rows[]`
 * diff-sync by `row_key` (the Linear identifier, e.g. ENG-123).
 *
 * Mirrors lib/ingest/sources/plane-normalize.ts — same invariants:
 *   • Dedicated brain project per Linear team (`linear-<teamKey>`). The task diff-delete is
 *     project-wide, so Linear imports never share a project with CLI/UI/Plane tasks.
 *   • One-directional (Linear → brain): import ONLY issues the brain doesn't already own — i.e.
 *     genuinely Linear-originated tasks (authored inside Linear). An issue is brain-owned if it
 *     carries the `aios-ext: <row_key>` footer (a brain→Linear round-tripper) OR its node id is in
 *     `ownedResourceIds` (a task_pm_links projection/adoption link). Brain-authored work stays out of
 *     the inbound mirror, so the mirror holds only net-new Linear-side tasks — keeps "brain wins".
 *   • Org structure preserved: sub-issue parent → parent_row_key (resolved within the imported set;
 *     a skipped/absent parent is nulled), project → sprint, cycle → `cycle:<name>` label,
 *     labels/state/priority/assignee carried through. Team tier; deterministic output (sha no-op).
 */

export interface LinearImportIssue {
  id: string;
  identifier: string;
  title?: string;
  description?: string | null;
  url?: string;
  priority?: number | null; // 0 none · 1 urgent · 2 high · 3 medium · 4 low
  state?: { name?: string; type?: string } | null; // type: backlog|unstarted|started|completed|canceled
  assignee?: { id?: string; displayName?: string } | null;
  parent?: { identifier?: string } | null;
  labels?: { nodes: { name: string }[] } | null;
  project?: { name?: string } | null;
  cycle?: { name?: string; number?: number } | null;
}

export interface NormalizeLinearInput {
  teamKey: string; // e.g. "ENG" — drives the brain project slug
  issues: LinearImportIssue[];
  // Linear node ids the brain already owns via a task_pm_links projection/adoption link. Issues whose
  // id is here are excluded from the inbound mirror (the brain authored & projected them outbound), so
  // only genuinely Linear-originated tasks are imported. Omitted in pure tests → falls back to footer-only.
  ownedResourceIds?: Set<string>;
}

/** Brain-owned = carries the aios-ext footer (round-tripper) OR has a projection/adoption link. */
function isBrainOwned(it: LinearImportIssue, owned: Set<string> | undefined): boolean {
  return !!parseExt(it.description) || (owned?.has(it.id) ?? false);
}

export interface LinearTaskRow {
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

// Linear state.type → brain status. Linear uses "canceled" (one l); both terminal states → done.
const TYPE_TO_STATUS: Record<string, string> = {
  backlog: "backlog",
  unstarted: "ready",
  started: "in_progress",
  completed: "done",
  canceled: "done",
};

/** A state NAMED like a brain status wins (e.g. a "Blocked" started state); else map by type. */
function linearStatus(stateName: string | undefined, type: string | undefined): string {
  const byName = normalizeTaskStatus(stateName ?? "");
  if (byName.raw_status === null && byName.status !== "backlog") return byName.status;
  return TYPE_TO_STATUS[type ?? ""] ?? "backlog";
}

// Linear priority int → brain priority word.
const PRIORITY_BY_INT: Record<number, string> = { 0: "none", 1: "urgent", 2: "high", 3: "medium", 4: "low" };

export function normalizeLinearTeam(input: NormalizeLinearInput): ItemPayload {
  const slugSeg = safeSegment(input.teamKey) || "team";
  const project = `linear-${slugSeg}`;

  // Exclude every brain-owned issue (footer round-trippers + projection-linked), importing only
  // net-new Linear-side tasks. Stable sort so a re-import is byte-identical → a no-op at the sha writer.
  const included = input.issues
    .filter((it) => !isBrainOwned(it, input.ownedResourceIds))
    .sort((a, b) => a.identifier.localeCompare(b.identifier));

  const includedKeys = new Set(included.map((it) => it.identifier));

  const rows: LinearTaskRow[] = included.map((it) => {
    const labels = (it.labels?.nodes ?? []).map((l) => l.name).filter(Boolean);
    const cycle = it.cycle?.name || (typeof it.cycle?.number === "number" ? `Cycle ${it.cycle.number}` : "");
    if (cycle) labels.push(`cycle:${cycle}`.slice(0, 80));
    const row: LinearTaskRow = {
      row_key: it.identifier,
      title: it.title?.trim() || "(untitled)",
      status: linearStatus(it.state?.name, it.state?.type),
      priority: PRIORITY_BY_INT[it.priority ?? 0] ?? "none",
      labels,
      assignee: it.assignee?.displayName ?? "",
      sprint: it.project?.name ?? "",
    };
    if (it.parent?.identifier) {
      // Resolve only within the imported set; a parent that was skipped/absent is nulled (never dangling).
      row.parent = includedKeys.has(it.parent.identifier) ? it.parent.identifier : null;
    }
    return row;
  });

  // Serialize every projectable field so any change shifts the sha (writer never short-circuits a real change).
  const lines = rows.map(
    (r) =>
      `| ${r.row_key} | ${r.title} | ${r.status} | ${r.priority} | ${r.sprint} | ${r.assignee} | ` +
      `${JSON.stringify(r.labels)} | ${r.parent ?? ""} |`
  );
  const body = `# Linear import — ${slugSeg}\n\n${lines.join("\n")}\n`;

  return {
    project,
    path: `linear/${slugSeg}/issues.md`,
    kind: "task",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "linear",
      team_key: input.teamKey,
      issue_count: rows.length,
    },
    body,
    rows,
  };
}

/**
 * Searchable companion to the task import: ONE `kind="deliverable"` item per issue carrying the full
 * title + description text, so issue prose is full-text searchable in the brain (the `items.search`
 * column) — not just the terse task table. Brain-owned issues (footer round-trippers + projection
 * links) are skipped, same as the task import. Content pattern (keyed by path, idempotent by sha).
 */
export function normalizeLinearDocs(input: NormalizeLinearInput): ItemPayload[] {
  const slugSeg = safeSegment(input.teamKey) || "team";
  return input.issues
    .filter((it) => !isBrainOwned(it, input.ownedResourceIds))
    .map((it) => {
      const title = it.title?.trim() || "(untitled)";
      const description = (it.description ?? "").trim();
      const body = `# ${it.identifier}: ${title}\n\n${description}\n`;
      return {
        project: `linear-${slugSeg}`,
        path: `linear/${slugSeg}/${it.identifier}.md`,
        kind: "deliverable" as const,
        content_sha256: sha256(body),
        actor: "",
        access: "team",
        frontmatter: {
          source: "linear",
          identifier: it.identifier,
          team_key: input.teamKey,
          url: it.url ?? "",
          state: it.state?.name ?? "",
          assignee: it.assignee?.displayName ?? "",
          // Assignee's Linear user id → resolved to a person at ingest (lib/ingest/run).
          assignee_id: it.assignee?.id ?? "",
          priority: PRIORITY_BY_INT[it.priority ?? 0] ?? "none",
          project_name: it.project?.name ?? "",
        },
        body,
      };
    });
}
