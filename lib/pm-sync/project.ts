import "server-only";

import type { DbClient } from "@/lib/db/types";

import { getEnabledIntegrationsWithSecrets, type IntegrationWithSecret } from "@/lib/integrations/manage";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { planeAdapter } from "@/lib/pm-sync/plane";
import {
  projectionFingerprint,
  type PmAdapter,
  type PmProvider,
  type ProjectableTask,
  type TaskPmLink,
  type TaskStatusValue,
  type UpsertWorkItemResult,
} from "@/lib/pm-sync/provider";

const ADAPTERS: Record<PmProvider, PmAdapter> = { plane: planeAdapter, linear: linearAdapter };

// ~1 req/s throttle between provider-writing tasks (reused from the seed scripts). Injectable so
// tests run instantly.
const DEFAULT_THROTTLE_MS = 1000;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The brain-canonical task row the engine projects. Loaded from `tasks`.
export interface ProjectionTaskRow {
  id: string;
  team_id: string;
  project_id: string;
  row_key: string;
  title: string;
  status: TaskStatusValue;
  sprint: string;
  priority: string;
  labels: string[];
  body: string;
  parent_row_key: string | null;
  assignee: string;
}

export type ProjectionStatus =
  | "synced"
  | "skipped"
  | "no_row_key"
  | "no_primary_provider"
  | "missing_integration"
  | "missing_parent"
  | "cycle"
  | "failed";

export interface ProjectionReport {
  row_key: string;
  provider: PmProvider | null;
  status: ProjectionStatus;
  providerResourceId?: string | null;
  error?: string;
}

export interface ProjectTaskOptions {
  statusOnly?: boolean;
  fetchImpl?: typeof fetch;
  // Resolved once by the orchestrator and threaded through to avoid re-resolution per row. Accepts
  // any resolution (incl. provider-known-but-integration-missing) so projectTask still records the
  // missing_integration error on the link instead of re-resolving.
  primary?: PrimaryResolution;
  bootstrap?: unknown;
  // Map of row_key → already-projected provider resource id (parent-first ordering).
  resolved?: Map<string, string>;
  // Guards against parent cycles when projecting a single task's parent chain inline.
  visiting?: Set<string>;
}

export interface ResolvedPrimary {
  provider: PmProvider;
  integration: IntegrationWithSecret;
}

// Resolution outcomes: ready (provider + integration), provider-known-but-integration-missing
// (still link + record the error for the pm-sync surface), or unresolved (true no-op).
export type PrimaryResolution =
  | ResolvedPrimary
  | { provider: PmProvider; integration: null; reason: string }
  | { provider: null; reason: string };

const PROVIDERS: PmProvider[] = ["plane", "linear"];

function chooseIntegration(integrations: IntegrationWithSecret[], provider: PmProvider): IntegrationWithSecret | null {
  return integrations.find((i) => i.type === provider && i.secret) ?? null;
}

// Resolve the team's projection target: its configured primary_pm_provider, or — if unset — the
// sole enabled PM integration. Ambiguous/none → null (caller no-ops with a clear report).
export async function resolvePrimaryProvider(
  db: DbClient,
  teamId: string
): Promise<PrimaryResolution> {
  const integrations = await getEnabledIntegrationsWithSecrets(db, teamId);
  const { data: team } = await db.from("teams").select("primary_pm_provider").eq("id", teamId).maybeSingle();
  const configured = (team?.primary_pm_provider as PmProvider | null) ?? null;

  if (configured) {
    const integration = chooseIntegration(integrations, configured);
    if (!integration) {
      // Target is known but its integration is absent/secret-less: callers still record the
      // failure on the link (observability parity with pre-v1.2 markdown-link sync).
      return { provider: configured, integration: null, reason: `${configured} integration is not enabled or has no secret` };
    }
    return { provider: configured, integration };
  }

  const enabled = PROVIDERS.filter((p) => chooseIntegration(integrations, p));
  if (enabled.length === 1) {
    return { provider: enabled[0], integration: chooseIntegration(integrations, enabled[0])! };
  }
  if (enabled.length === 0) return { provider: null, reason: "no enabled PM integration" };
  return { provider: null, reason: "multiple PM integrations enabled but teams.primary_pm_provider is unset" };
}

// Exported so the inbound apply (lib/pm-sync/inbound.ts) recomputes fingerprints over the EXACT
// same projectable shape the outbound engine hashes — the two must never drift.
export function toProjectable(row: ProjectionTaskRow, parentResourceId: string | null): ProjectableTask {
  return {
    row_key: row.row_key,
    title: row.title,
    body: row.body ?? "",
    status: row.status,
    priority: row.priority || "none",
    labels: row.labels ?? [],
    sprint: row.sprint ?? "",
    assignee: row.assignee ?? "",
    parentResourceId,
  };
}

// Columns of task_pm_links the projection engine reads. The pg adapter (prod) rejects a bare
// "*" column reference, so every select / insert-returning must name columns explicitly.
const LINK_COLS =
  "id, team_id, project_id, task_id, row_key, provider, provider_resource_id, provider_external_source, provider_external_id, provider_url, projection_fingerprint, last_projected_status, last_projected_brain_status, provider_seen_status";

// The exact `tasks` columns that hydrate a ProjectionTaskRow. Named explicitly (the pg adapter
// rejects "*") and shared by every loader so the projected shape can't drift between call sites.
export const PROJECTION_TASK_COLS =
  "id, team_id, project_id, row_key, title, status, sprint, priority, labels, body, parent_row_key, assignee";

// Get-or-create the task_pm_links row for (team, project, row_key, provider).
async function ensureLink(
  db: DbClient,
  row: ProjectionTaskRow,
  provider: PmProvider,
  defaultSource: string
): Promise<TaskPmLink> {
  const { data: existing } = await db
    .from("task_pm_links")
    .select(LINK_COLS)
    .eq("team_id", row.team_id)
    .eq("project_id", row.project_id)
    .eq("row_key", row.row_key)
    .eq("provider", provider)
    .maybeSingle();
  if (existing) return existing as TaskPmLink;

  const insert = {
    team_id: row.team_id,
    project_id: row.project_id,
    task_id: row.id,
    row_key: row.row_key,
    provider,
    provider_external_id: row.row_key,
    provider_external_source: defaultSource,
    provider_url: "",
  };
  const { data, error } = await db.from("task_pm_links").insert(insert).select(LINK_COLS).single();
  if (error) throw new Error(`create task PM link failed: ${error.message}`);
  return data as TaskPmLink;
}

async function persistSuccess(
  db: DbClient,
  link: TaskPmLink,
  result: UpsertWorkItemResult,
  fingerprint: string,
  // Exact brain `tasks.status` this projection wrote from — the inbound conflict baseline
  // (brain-api v1.4). The group-granular fingerprint can't distinguish in_progress vs blocked.
  brainStatus: string
) {
  const now = new Date().toISOString();
  await db
    .from("task_pm_links")
    .update({
      provider_resource_id: result.providerResourceId,
      provider_url: result.providerUrl || link.provider_url || "",
      provider_external_source: result.externalSource || link.provider_external_source,
      last_synced_status: result.syncedStatus ?? null,
      last_synced_at: now,
      last_projected_status: result.syncedStatus ?? null,
      last_projected_brain_status: brainStatus,
      projection_fingerprint: fingerprint,
      last_error: null,
      updated_at: now,
    })
    .eq("id", link.id);
}

async function persistError(db: DbClient, link: TaskPmLink, message: string) {
  await db
    .from("task_pm_links")
    .update({ last_error: message.slice(0, 1000), updated_at: new Date().toISOString() })
    .eq("id", link.id);
}

async function loadTaskByRowKey(
  db: DbClient,
  teamId: string,
  projectId: string,
  rowKey: string
): Promise<ProjectionTaskRow | null> {
  const { data } = await db
    .from("tasks")
    .select(PROJECTION_TASK_COLS)
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return (data as ProjectionTaskRow | null) ?? null;
}

// Project one task into the team's primary PM tool. Resolves the parent first (so the provider
// sub-issue link exists), upserts the work item, and persists the link bookkeeping. Brain-wins.
export async function projectTask(
  db: DbClient,
  row: ProjectionTaskRow,
  opts: ProjectTaskOptions = {}
): Promise<ProjectionReport> {
  if (!row.row_key) return { row_key: "", provider: null, status: "no_row_key" };

  const primary: PrimaryResolution = opts.primary ?? (await resolvePrimaryProvider(db, row.team_id));
  if (primary.provider === null) {
    return { row_key: row.row_key, provider: null, status: "no_primary_provider", error: primary.reason };
  }
  if (primary.integration === null) {
    // Provider is known but its integration is missing — create/find the link and record the
    // error on it so the pm-sync failure surface shows it, then report missing_integration.
    const link = await ensureLink(db, row, primary.provider, "aios-backlog");
    await persistError(db, link, primary.reason);
    return { row_key: row.row_key, provider: primary.provider, status: "missing_integration", error: primary.reason };
  }
  const { provider, integration } = primary;
  const adapter = ADAPTERS[provider];
  const defaultSource = (integration.config?.externalSource as string | undefined) || "aios-backlog";

  // Resolve the parent's provider resource id (parent-first). In a batch this comes from the
  // resolved map; for a standalone projection we project the parent inline (cycle-guarded).
  let parentResourceId: string | null = null;
  if (!opts.statusOnly && row.parent_row_key) {
    const resolved = opts.resolved;
    if (resolved?.has(row.parent_row_key)) {
      parentResourceId = resolved.get(row.parent_row_key) ?? null;
    } else {
      const visiting = opts.visiting ?? new Set<string>();
      if (visiting.has(row.row_key)) {
        return { row_key: row.row_key, provider, status: "cycle", error: `parent cycle at ${row.row_key}` };
      }
      visiting.add(row.row_key);
      const parentRow = await loadTaskByRowKey(db, row.team_id, row.project_id, row.parent_row_key);
      if (!parentRow) {
        return { row_key: row.row_key, provider, status: "missing_parent", error: `parent ${row.parent_row_key} not found` };
      }
      const parentReport = await projectTask(db, parentRow, { ...opts, visiting });
      if (parentReport.status === "failed" || parentReport.status === "cycle" || parentReport.status === "missing_parent") {
        return { row_key: row.row_key, provider, status: parentReport.status, error: `parent ${row.parent_row_key}: ${parentReport.error ?? parentReport.status}` };
      }
      parentResourceId = parentReport.providerResourceId ?? null;
    }
  }

  const link = await ensureLink(db, row, provider, defaultSource);
  const task = toProjectable(row, parentResourceId);
  const fingerprint = projectionFingerprint(task, parentResourceId);

  // Fingerprint short-circuit: a known provider resource id + unchanged fingerprint ⇒ zero
  // provider round-trips (guarantees a second projectAllTasks run does no writes).
  if (!opts.statusOnly && link.provider_resource_id && link.projection_fingerprint === fingerprint) {
    opts.resolved?.set(row.row_key, link.provider_resource_id);
    return { row_key: row.row_key, provider, status: "skipped", providerResourceId: link.provider_resource_id };
  }

  try {
    const result = await adapter.upsertWorkItem({
      task,
      link,
      integration,
      desiredFingerprint: fingerprint,
      statusOnly: opts.statusOnly,
      bootstrap: opts.bootstrap,
      fetchImpl: opts.fetchImpl,
    });
    await persistSuccess(db, link, result, fingerprint, row.status);
    opts.resolved?.set(row.row_key, result.providerResourceId);
    return { row_key: row.row_key, provider, status: result.status, providerResourceId: result.providerResourceId };
  } catch (e) {
    const message = e instanceof Error ? e.message : "projection failed";
    await persistError(db, link, message);
    return { row_key: row.row_key, provider, status: "failed", error: message };
  }
}

// Order rows parent-before-child (epics first). Rows whose parent is missing/cyclic are still
// emitted (projectTask reports the failure) so the batch never silently drops them.
export function topoOrder(rows: ProjectionTaskRow[]): ProjectionTaskRow[] {
  const byKey = new Map(rows.map((r) => [r.row_key, r]));
  const ordered: ProjectionTaskRow[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (row: ProjectionTaskRow) => {
    if (placed.has(row.row_key) || visiting.has(row.row_key)) return;
    visiting.add(row.row_key);
    const parentKey = (row.parent_row_key ?? "").trim();
    if (parentKey && byKey.has(parentKey)) place(byKey.get(parentKey)!);
    visiting.delete(row.row_key);
    if (!placed.has(row.row_key)) {
      placed.add(row.row_key);
      ordered.push(row);
    }
  };
  for (const row of rows) place(row);
  return ordered;
}

export interface ProjectAllOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  throttleMs?: number;
}

// Shared batch projector: prefetch the provider bootstrap ONCE (labels/states/items), then project
// the rows parent-before-child sharing a single `resolved` map, paying the ~1 req/s throttle only on
// rows that actually wrote. Both `projectAllTasks` (whole board) and the reactive changed-rows path
// reuse this so the prepare/order/throttle semantics can't drift apart.
export async function projectRows(
  db: DbClient,
  primary: ResolvedPrimary,
  rows: ProjectionTaskRow[],
  opts: ProjectAllOptions = {}
): Promise<ProjectionReport[]> {
  if (!rows.length) return [];

  // Prefetch once: ensure all labels exist + cache states/items/issues for the run.
  const allLabels = Array.from(new Set(rows.flatMap((r) => r.labels ?? []).filter(Boolean)));
  const adapter = ADAPTERS[primary.provider];
  const bootstrap = adapter.prepare
    ? await adapter.prepare({ integration: primary.integration, labels: allLabels, fetchImpl: opts.fetchImpl })
    : undefined;

  const sleep = opts.sleep ?? realSleep;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const resolved = new Map<string, string>();
  const reports: ProjectionReport[] = [];

  for (const row of topoOrder(rows)) {
    const report = await projectTask(db, row, {
      primary,
      bootstrap,
      resolved,
      fetchImpl: opts.fetchImpl,
    });
    reports.push(report);
    // Only pay the throttle when we actually wrote to the provider.
    if (report.status === "synced") await sleep(throttleMs);
  }
  return reports;
}

// Server-side projection of the whole board for a (team, project) — the replacement for the
// retired plane:backlog / linear:backlog seed scripts. ~80 rows × 1 provider ≈ ~90s with the
// throttle. Continues on per-row failure and returns a per-row report.
export async function projectAllTasks(
  db: DbClient,
  teamId: string,
  projectId: string,
  opts: ProjectAllOptions = {}
): Promise<{ provider: PmProvider | null; reports: ProjectionReport[]; reason?: string }> {
  const primary = await resolvePrimaryProvider(db, teamId);
  if (primary.provider === null || primary.integration === null) {
    return { provider: primary.provider, reports: [], reason: primary.reason };
  }

  const { data: taskRows } = await db
    .from("tasks")
    .select(PROJECTION_TASK_COLS)
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  const rows = ((taskRows ?? []) as ProjectionTaskRow[]).filter((r) => r.row_key);
  if (!rows.length) return { provider: primary.provider, reports: [] };

  const reports = await projectRows(db, primary, rows, opts);
  return { provider: primary.provider, reports };
}
