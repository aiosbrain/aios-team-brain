import "server-only";

import { createHash } from "node:crypto";

import type { IntegrationWithSecret } from "@/lib/integrations/manage";

export type PmProvider = "plane" | "linear";

// Canonical task status values (postgres `task_status` enum). The projection engine maps these
// onto provider workflow-state "groups" (Plane state `group` / Linear state `type`).
export type TaskStatusValue = "backlog" | "ready" | "in_progress" | "blocked" | "done";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export interface TaskPmLink {
  id: string;
  team_id: string;
  project_id: string;
  task_id: string | null;
  row_key: string;
  provider: PmProvider;
  provider_resource_id: string | null;
  provider_external_source: string;
  provider_external_id: string;
  provider_url: string;
  // Projection bookkeeping (brain-api v1.2). Present on rows loaded for projection; the legacy
  // moveToDone path may omit them.
  projection_fingerprint?: string | null;
  last_projected_status?: string | null;
  provider_seen_status?: string | null;
}

export interface ProviderSyncResult {
  provider: PmProvider;
  status: "synced" | "skipped";
  providerResourceId?: string | null;
  providerUrl?: string;
  syncedStatus?: string;
}

export interface ProviderSyncInput {
  link: TaskPmLink;
  integration: IntegrationWithSecret;
  fetchImpl?: typeof fetch;
}

// ── Projection (brain → PM, brain-wins, one-way) ───────────────────────────────

// The brain-canonical shape of a task the engine projects into the primary PM tool. `body` is
// plain text (Postgres-canonical); each adapter wraps/sends it natively. `parentResourceId` is the
// already-projected provider id of the epic (resolved by the orchestrator, parent-first).
export interface ProjectableTask {
  row_key: string;
  title: string;
  body: string;
  status: TaskStatusValue;
  priority: string; // normalized: none | low | medium | high | urgent
  labels: string[];
  sprint: string; // Wave name → Plane module membership ("" = none)
  // Free-text owner (brain-canonical). Adapters resolve it to a provider user; "" means the brain
  // asserts no owner — adapters MUST leave the provider assignee untouched (never force-unassign),
  // so a brain task with no owner can't blank an assignee a human set in the PM tool.
  assignee: string;
  parentResourceId?: string | null;
}

export interface UpsertWorkItemInput {
  task: ProjectableTask;
  link: TaskPmLink | null;
  integration: IntegrationWithSecret;
  // The orchestrator-computed desired fingerprint; the adapter echoes it back for persistence.
  desiredFingerprint: string;
  // statusOnly: only reconcile workflow state (used by moveToDone / done transitions). Never
  // touches title/body/labels/priority/parent so a partial caller can't blank fields.
  statusOnly?: boolean;
  // Optional per-run prefetch (states/labels/items) shared across a projectAllTasks batch.
  bootstrap?: unknown;
  fetchImpl?: typeof fetch;
}

export interface UpsertWorkItemResult extends ProviderSyncResult {
  providerResourceId: string;
  providerUrl: string;
  parentResourceId?: string | null;
  // The external_source actually used (persisted onto task_pm_links.provider_external_source).
  externalSource: string;
  fingerprint: string;
}

export interface PrepareInput {
  integration: IntegrationWithSecret;
  // Label names to ensure exist before the batch runs (created once, then reused).
  labels?: string[];
  fetchImpl?: typeof fetch;
}

export interface FetchSeenStatesInput {
  integration: IntegrationWithSecret;
  fetchImpl?: typeof fetch;
}

export interface PmAdapter {
  provider: PmProvider;
  // Optional per-run prefetch: returns an opaque provider bootstrap (states/labels/items/modules)
  // the orchestrator passes back into each upsertWorkItem to avoid re-listing per task.
  prepare?(input: PrepareInput): Promise<unknown>;
  upsertWorkItem(input: UpsertWorkItemInput): Promise<UpsertWorkItemResult>;
  moveToDone(input: ProviderSyncInput): Promise<ProviderSyncResult>;
  // Inbound reconciliation (brain-api v1.2 Phase 5): read the CURRENT provider workflow-state NAME
  // for every projected item, keyed by provider resource id. Read-only — never mutates the provider.
  // Optional: a provider without an implementation simply has no divergence detection.
  fetchSeenStates?(input: FetchSeenStatesInput): Promise<Map<string, string>>;
}

// status → desired provider state. Both providers share five workflow groups; `blocked` has no
// native group, so it maps to `started` unless a state literally named "Blocked" exists (UX caveat).
export interface DesiredState {
  group: StateGroup;
  preferredName: string;
}

export function desiredStateForStatus(status: string): DesiredState {
  switch (status) {
    case "ready":
      return { group: "unstarted", preferredName: "Todo" };
    case "in_progress":
      return { group: "started", preferredName: "In Progress" };
    case "blocked":
      return { group: "started", preferredName: "Blocked" };
    case "done":
      return { group: "completed", preferredName: "Done" };
    case "backlog":
    default:
      return { group: "backlog", preferredName: "Backlog" };
  }
}

// Plane stores priority as the same word set we use; Linear uses Int (0 none·1 urgent·2 high·3 med·4 low).
export function priorityToLinearInt(priority: string): number {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    default:
      return 0;
  }
}

// Deterministic hash of everything the engine would write. Equal fingerprint + a known provider
// resource id ⇒ the orchestrator can skip the provider round-trip entirely (zero mutations).
export function projectionFingerprint(
  task: ProjectableTask,
  parentResourceId: string | null | undefined
): string {
  const payload = JSON.stringify({
    title: task.title ?? "",
    body: task.body ?? "",
    labels: [...(task.labels ?? [])].map((l) => l.trim()).filter(Boolean).sort(),
    priority: task.priority || "none",
    parent: parentResourceId ?? "",
    sprint: task.sprint ?? "",
    assignee: task.assignee ?? "",
    group: desiredStateForStatus(task.status).group,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Strip the single-paragraph HTML wrapper providers/seed use, back to the plain text we store in
// tasks.body — so an adopted item whose description already matches produces no description write.
export function htmlToPlainText(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<\/?p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// Wrap plain-text body as Plane description_html. Empty body → "" (never a stray "<p></p>").
export function plainTextToHtml(text: string | null | undefined): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function sameLabelSet(a: string[], b: string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

export class PmSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PmSyncError";
  }
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PmSyncError(`${label} is required`);
  }
  return value.trim();
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}
