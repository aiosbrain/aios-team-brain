import "server-only";

import type { DbClient } from "@/lib/db/types";

import { withTransaction } from "@/lib/db/pg/tx";
import { timeoutFetch } from "@/lib/http";
import { fetchLinearTeam, type FetchedLinearTeam } from "@/lib/ingest/sources/linear";
import {
  linearMirrorProject,
  linearStatusOrNull,
  type LinearImportIssue,
} from "@/lib/ingest/sources/linear-normalize";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { linearGraphql, parseExt, stripFooter, withFooter } from "@/lib/pm-sync/linear-client";
import {
  PROJECTION_TASK_COLS,
  resolvePrimaryProvider,
  toProjectable,
  type ProjectionTaskRow,
  type ResolvedPrimary,
} from "@/lib/pm-sync/project";
import {
  projectionFingerprint,
  type SeenState,
  type TaskStatusValue,
} from "@/lib/pm-sync/provider";
import { isDiverged } from "@/lib/pm-sync/reconcile";
import { adminClient } from "@/lib/db/admin";

/**
 * Inbound Linear→brain apply + adopt (brain-api v1.4, AIO-145) — the write half that turns the
 * Phase 5 surface-only divergence read (`reconcile.ts`) into a policy-driven sync.
 *
 * Field policy (v1.4, hardcoded default): `status = pm-wins-if-brain-unchanged`;
 * `title/body/labels/priority` stay brain-wins and are NEVER written by the apply loop.
 *
 * "Brain unchanged" is TWO checks, both required (round-3 review, binding):
 *   1. exact-status baseline — `task_pm_links.last_projected_brain_status === tasks.status`.
 *      The projection fingerprint hashes the provider state GROUP, and in_progress/blocked both
 *      hash to `started`, so the fingerprint alone would silently overwrite a same-group brain
 *      edit. The baseline is written by outbound projection success, adopt, and inbound apply.
 *   2. fingerprint equality — `projection_fingerprint === projectionFingerprint(task, parent)`.
 *      Catches a pending title/body/labels/priority/parent edit; applying a status while another
 *      field is pending would either swallow that edit (if we refreshed the fingerprint) or echo
 *      it — so both-changed is a CONFLICT, surfaced, never auto-merged.
 *
 * Loop prevention (normative): an apply updates `tasks.status` and the link bookkeeping
 * (`last_projected_status` + `last_projected_brain_status` + a recomputed `projection_fingerprint`)
 * ATOMICALLY in one Postgres transaction, guarded on the expected pre-apply status (optimistic
 * concurrency — a concurrent brain edit aborts into a conflict). The next reactive projection sees
 * an equal fingerprint and makes ZERO provider writes: no echo loop.
 *
 * Adopt (Phase B): a Linear-native issue (no `aios-ext` footer, no link) was already imported by
 * `runLinearIngestion` as a mirror task under the deterministic `linear-<teamKey>` project — adopt
 * BACKFILLS the two-way link (never a fresh task insert), flips `origin` to 'ui' (so the next
 * ingest diff-delete can't remove it), seeds `tasks.body` once from the Linear description (so a
 * later outbound projection can't wipe the native description with an empty brain body), and
 * appends the `aios-ext` footer to the EXISTING Linear description. Tier safety is structural
 * (`access_tier` has no admin; the mirror import is fixed to `team`) and asserted here.
 *
 * Trigger: poll-only — the 30-min ingest scheduler tick + manual "sync now", both AFTER the Linear
 * ingest leg. Gated per team by `config.inboundApply === true` on the Linear integration (default
 * off). Webhooks are explicitly out of scope for v1 (brain-api v1.4).
 */

// Adoption NEVER creates or elevates beyond team tier (brain-api v1.4 tier-safety invariant).
// `access_tier` is structurally admin-free ('team' | 'external'), but assert intent explicitly.
const ADOPT_TIER = "team" as const;

// ── Result shapes (signal-shaped, per the bidirectional-pm-sync spec) ───────────────────────────

export interface InboundConflict {
  kind: "pm_sync_conflict";
  source: "linear";
  tier: typeof ADOPT_TIER;
  occurredAt: string;
  /** Linear resource (node) id. */
  ref: string;
  payload: {
    task_id: string | null;
    row_key: string;
    linear_state: string;
    brain_state: string | null;
    reason: string;
  };
}

export interface InboundApplied {
  kind: "pm_sync_applied";
  source: "linear";
  tier: typeof ADOPT_TIER;
  occurredAt: string;
  ref: string;
  payload: { task_id: string; row_key: string; linear_state: string; brain_state: string; from: string };
}

export interface InboundResult {
  provider: "linear" | null;
  /** false when the team hasn't opted in (config.inboundApply) — everything else is empty. */
  enabled: boolean;
  applied: InboundApplied[];
  conflicts: InboundConflict[];
  noops: number;
  /** row_keys adopted this pass (link backfilled onto an ingest-created mirror task). */
  adopted: string[];
  /** Fail-soft skip reasons (no destination, missing mirror task, footer backfill failure…). */
  skipped: string[];
  reason?: string;
}

function emptyResult(over: Partial<InboundResult> = {}): InboundResult {
  return { provider: null, enabled: false, applied: [], conflicts: [], noops: 0, adopted: [], skipped: [], ...over };
}

// ── Enriched read (links + tasks + parent resolution) — shared by the engine and the admin page ──

const INBOUND_LINK_COLS =
  "id, team_id, project_id, task_id, row_key, provider, provider_resource_id, provider_external_source, provider_url, projection_fingerprint, last_projected_status, last_projected_brain_status, provider_seen_status";

export interface InboundLink {
  id: string;
  team_id: string;
  project_id: string;
  task_id: string | null;
  row_key: string;
  provider: string;
  provider_resource_id: string | null;
  provider_external_source: string;
  provider_url: string;
  projection_fingerprint: string | null;
  last_projected_status: string | null;
  last_projected_brain_status: string | null;
  provider_seen_status: string | null;
}

export interface InboundRow {
  link: InboundLink;
  task: ProjectionTaskRow | null;
  /** The parent task's provider resource id, resolved exactly as outbound does (by parent_row_key). */
  parentResourceId: string | null;
  /** Fingerprint recomputed from the CURRENT persisted task row (null when the task is missing). */
  currentFingerprint: string | null;
  brainUnchanged: boolean;
}

export type InboundRowState = "in_sync" | "pending_apply" | "conflict";

/**
 * Pure, persisted-data-only classification — the admin PM-sync page uses this to deterministically
 * distinguish "conflict (both changed)" from "pending apply (Linear moved, brain unchanged)"
 * without a provider round-trip (round-3 review Major 3).
 */
export function classifyInboundRow(row: InboundRow): InboundRowState {
  if (!isDiverged(row.link)) return "in_sync";
  return row.brainUnchanged ? "pending_apply" : "conflict";
}

/**
 * Load every Linear link for the team enriched with its task row, outbound-identical parent
 * resolution, the recomputed fingerprint, and the two-check `brainUnchanged` verdict.
 */
export async function loadInboundRows(supabase: DbClient, teamId: string): Promise<InboundRow[]> {
  const { data: linkData } = await supabase
    .from("task_pm_links")
    .select(INBOUND_LINK_COLS)
    .eq("team_id", teamId)
    .eq("provider", "linear");
  const links = (linkData ?? []) as InboundLink[];
  if (!links.length) return [];

  const taskIds = links.map((l) => l.task_id).filter((v): v is string => !!v);
  const tasksById = new Map<string, ProjectionTaskRow>();
  if (taskIds.length) {
    const { data: taskData } = await supabase
      .from("tasks")
      .select(PROJECTION_TASK_COLS)
      .eq("team_id", teamId)
      .in("id", taskIds);
    for (const t of (taskData ?? []) as ProjectionTaskRow[]) tasksById.set(t.id, t);
  }

  // parent_row_key → provider resource id, per project — the same lookup outbound resolves
  // through its `resolved` map / parent link (Major 4: children must not false-conflict).
  const resourceByProjectRowKey = new Map<string, string>();
  for (const l of links) {
    if (l.provider_resource_id) resourceByProjectRowKey.set(`${l.project_id}:${l.row_key}`, l.provider_resource_id);
  }

  return links.map((link) => {
    const task = link.task_id ? (tasksById.get(link.task_id) ?? null) : null;
    const parentKey = (task?.parent_row_key ?? "").trim();
    const parentResourceId = parentKey
      ? (resourceByProjectRowKey.get(`${link.project_id}:${parentKey}`) ?? null)
      : null;
    const currentFingerprint = task
      ? projectionFingerprint(toProjectable(task, parentResourceId), parentResourceId)
      : null;
    const brainUnchanged =
      !!task &&
      link.last_projected_brain_status !== null &&
      link.last_projected_brain_status === task.status &&
      link.projection_fingerprint !== null &&
      link.projection_fingerprint === currentFingerprint;
    return { link, task, parentResourceId, currentFingerprint, brainUnchanged };
  });
}

// ── Phase A: apply (pm-wins-if-brain-unchanged, status only) ────────────────────────────────────

function conflictOf(link: InboundLink, seenName: string, brainState: string | null, reason: string): InboundConflict {
  return {
    kind: "pm_sync_conflict",
    source: "linear",
    tier: ADOPT_TIER,
    occurredAt: new Date().toISOString(),
    ref: link.provider_resource_id ?? link.row_key,
    payload: { task_id: link.task_id, row_key: link.row_key, linear_state: seenName, brain_state: brainState, reason },
  };
}

/**
 * Atomic apply: `tasks.status` first (guarded on the expected pre-apply status — optimistic
 * concurrency), then the link bookkeeping, in ONE transaction. Returns false when the guard
 * trips (concurrent brain edit) — the caller surfaces a conflict instead.
 */
async function applyStatusTx(args: {
  link: InboundLink;
  task: ProjectionTaskRow;
  newStatus: TaskStatusValue;
  seenName: string;
  parentResourceId: string | null;
}): Promise<boolean> {
  const { link, task, newStatus, seenName, parentResourceId } = args;
  // Recompute the OUTBOUND fingerprint for the post-apply shape so the next projection
  // short-circuits (no echo). Separate concept from the conflict baseline (review Major 2).
  const postFingerprint = projectionFingerprint(
    toProjectable({ ...task, status: newStatus }, parentResourceId),
    parentResourceId
  );
  return withTransaction(async (client) => {
    if (newStatus !== task.status) {
      const res = await client.query(
        `update tasks set status = $1, updated_at = now() where id = $2 and status = $3`,
        [newStatus, task.id, task.status]
      );
      if ((res.rowCount ?? 0) === 0) return false; // concurrent brain edit → conflict, no write
    } else {
      // Status text is already equal (e.g. two Linear names mapping to the same brain status):
      // verify the baseline still holds under lock, then only refresh the bookkeeping — never
      // bump tasks.updated_at for a no-change apply (it would trigger a spurious writeback row).
      const res = await client.query(`select status from tasks where id = $1 for update`, [task.id]);
      if (res.rows[0]?.status !== task.status) return false;
    }
    await client.query(
      `update task_pm_links
          set projection_fingerprint = $1,
              last_projected_status = $2,
              last_projected_brain_status = $3,
              provider_seen_status = $2,
              last_error = null,
              updated_at = now()
        where id = $4`,
      [postFingerprint, seenName, newStatus, link.id]
    );
    return true;
  });
}

async function applyInbound(
  supabase: DbClient,
  teamId: string,
  seenByResource: Map<string, SeenState>,
  result: InboundResult
): Promise<void> {
  const rows = await loadInboundRows(supabase, teamId);
  for (const row of rows) {
    const { link, task } = row;
    if (!link.provider_resource_id) continue; // never projected/adopted — nothing to reconcile
    const seen = seenByResource.get(link.provider_resource_id);
    if (!seen) {
      result.noops += 1; // provider has no state for this item (e.g. deleted) — leave as-is
      continue;
    }

    // Persist the freshly-seen state name (write-if-changed — same semantics as reconcile.ts).
    if (seen.name !== link.provider_seen_status) {
      await supabase
        .from("task_pm_links")
        .update({ provider_seen_status: seen.name, updated_at: new Date().toISOString() })
        .eq("id", link.id);
      link.provider_seen_status = seen.name;
    }

    if (!isDiverged({ last_projected_status: link.last_projected_status, provider_seen_status: seen.name })) {
      result.noops += 1;
      continue;
    }
    if (!task) {
      result.conflicts.push(conflictOf(link, seen.name, null, "no brain task row linked"));
      continue;
    }
    if (!row.brainUnchanged) {
      // Both changed since the last projection — surface, never auto-merge (v1.4 normative).
      result.conflicts.push(conflictOf(link, seen.name, task.status, "brain changed since last projection"));
      continue;
    }

    const newStatus = linearStatusOrNull(seen.name, seen.type) as TaskStatusValue | null;
    if (!newStatus) {
      // Renamed/deleted state with no resolvable group → conflict, not an apply (v1.4 normative).
      const reason = `unresolvable Linear state "${seen.name}" (type "${seen.type}")`;
      result.conflicts.push(conflictOf(link, seen.name, task.status, reason));
      await supabase
        .from("task_pm_links")
        .update({ last_error: `inbound: ${reason}`.slice(0, 1000), updated_at: new Date().toISOString() })
        .eq("id", link.id);
      continue;
    }

    const applied = await applyStatusTx({
      link,
      task,
      newStatus,
      seenName: seen.name,
      parentResourceId: row.parentResourceId,
    });
    if (!applied) {
      result.conflicts.push(conflictOf(link, seen.name, task.status, "concurrent brain edit during apply"));
      continue;
    }
    result.applied.push({
      kind: "pm_sync_applied",
      source: "linear",
      tier: ADOPT_TIER,
      occurredAt: new Date().toISOString(),
      ref: link.provider_resource_id,
      payload: {
        task_id: task.id,
        row_key: link.row_key,
        linear_state: seen.name,
        brain_state: newStatus,
        from: task.status,
      },
    });
  }
}

// ── Phase B: adopt (backfill the link onto the ingest-created mirror task) ──────────────────────

/** Parent-before-child ordering over the candidate issues (by Linear identifier). */
function topoIssues(issues: LinearImportIssue[]): LinearImportIssue[] {
  const byKey = new Map(issues.map((it) => [it.identifier, it]));
  const ordered: LinearImportIssue[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (it: LinearImportIssue) => {
    if (placed.has(it.identifier) || visiting.has(it.identifier)) return;
    visiting.add(it.identifier);
    const parentKey = it.parent?.identifier;
    if (parentKey && byKey.has(parentKey)) place(byKey.get(parentKey)!);
    visiting.delete(it.identifier);
    placed.add(it.identifier);
    ordered.push(it);
  };
  for (const it of issues) place(it);
  return ordered;
}

async function adoptInbound(
  supabase: DbClient,
  teamId: string,
  primary: ResolvedPrimary,
  fetched: FetchedLinearTeam,
  result: InboundResult,
  fetchImpl: typeof fetch
): Promise<void> {
  // Tier-safety assertion (mirrors the /api/v1/items 422 boundary): adoption is team-tier, always.
  if ((ADOPT_TIER as string) !== "team") throw new Error("inbound adopt must be team-tier");

  const mirrorSlug = linearMirrorProject(fetched.teamKey);
  const { data: proj } = await supabase
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", mirrorSlug)
    .maybeSingle();
  if (!proj) {
    result.skipped.push(`mirror project ${mirrorSlug} not found — run Linear ingest first`);
    return;
  }
  const projectId = (proj as { id: string }).id;

  // Links for dedupe (owned node ids) + outbound-identical parent resolution within the mirror.
  const { data: linkData } = await supabase
    .from("task_pm_links")
    .select("project_id, row_key, provider_resource_id")
    .eq("team_id", teamId)
    .eq("provider", "linear");
  const ownedIds = new Set<string>();
  const resourceByRowKey = new Map<string, string>();
  for (const l of (linkData ?? []) as { project_id: string; row_key: string; provider_resource_id: string | null }[]) {
    if (!l.provider_resource_id) continue;
    ownedIds.add(l.provider_resource_id);
    if (l.project_id === projectId) resourceByRowKey.set(l.row_key, l.provider_resource_id);
  }

  // Candidates: genuinely Linear-authored (no aios-ext footer, no projection/adoption link yet).
  const candidates = topoIssues(fetched.issues.filter((it) => !parseExt(it.description) && !ownedIds.has(it.id)));
  const externalSource = (primary.integration.config?.externalSource as string | undefined) || "aios-backlog";

  for (const it of candidates) {
    const { data: taskData } = await supabase
      .from("tasks")
      .select(PROJECTION_TASK_COLS)
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .eq("row_key", it.identifier)
      .maybeSingle();
    const task = taskData as ProjectionTaskRow | null;
    if (!task) {
      result.skipped.push(`${it.identifier}: no mirror task yet (Linear ingest pending)`);
      continue;
    }

    // One-time ownership seed of the description (not the recurring apply loop, which never
    // writes body): without it, the first outbound projection after a brain-side edit would
    // overwrite the Linear-native description with the mirror task's empty body.
    const body = (task.body ?? "").trim() ? task.body : stripFooter(it.description);
    // Adopt takes the CURRENT Linear state as the task's status (the mirror row may be stale if
    // the board moved after the last ingest tick) — content flows from Linear at adoption.
    const status = (linearStatusOrNull(it.state?.name, it.state?.type) ?? task.status) as TaskStatusValue;
    const stateName = it.state?.name ?? "";
    const parentKey = (task.parent_row_key ?? "").trim();
    const parentResourceId = parentKey ? (resourceByRowKey.get(parentKey) ?? null) : null;
    // Seed the fingerprint for the post-adopt shape so the first outbound pass short-circuits
    // (adopt-no-duplicate: projection must never create a second Linear issue).
    const fingerprint = projectionFingerprint(
      toProjectable({ ...task, status, body }, parentResourceId),
      parentResourceId
    );

    const inserted = await withTransaction(async (client) => {
      const res = await client.query(
        `insert into task_pm_links
           (team_id, project_id, task_id, row_key, provider, provider_resource_id,
            provider_external_source, provider_external_id, provider_url,
            last_projected_status, last_projected_brain_status, projection_fingerprint,
            provider_seen_status, updated_at)
         values ($1, $2, $3, $4, 'linear', $5, $6, $7, $8, $9, $10, $11, $9, now())
         on conflict (team_id, project_id, row_key, provider) do nothing
         returning id`,
        [
          teamId,
          projectId,
          task.id,
          it.identifier,
          it.id,
          externalSource,
          it.identifier,
          it.url ?? "",
          stateName,
          status,
          fingerprint,
        ]
      );
      if ((res.rowCount ?? 0) === 0) return false; // raced adopt — the unique index guarantees no duplicate
      // origin 'ui': once owned, ingest excludes this issue from the mirror push, and only
      // origin='sync' rows are diff-deleted — the flip is what makes the adopted task durable.
      await client.query(
        `update tasks set origin = 'ui', status = $1, body = $2, updated_at = now() where id = $3`,
        [status, body, task.id]
      );
      return true;
    });
    if (!inserted) continue;

    resourceByRowKey.set(it.identifier, it.id);
    result.adopted.push(it.identifier);

    // Post-commit: append the durable aios-ext footer to the EXISTING Linear description so
    // `isBrainOwned` excludes the issue on the next ingest tick. Best-effort — the link's
    // provider_resource_id already excludes it (ownedResourceIds), so a failure self-heals.
    try {
      await linearGraphql(
        fetchImpl,
        primary.integration.secret ?? "",
        `mutation AdoptFooter($id: String!, $description: String!) {
          issueUpdate(id: $id, input: { description: $description }) { success issue { id } }
        }`,
        { id: it.id, description: withFooter(stripFooter(it.description), it.identifier, externalSource) }
      );
    } catch (err) {
      result.skipped.push(
        `${it.identifier}: adopted, but footer backfill failed (${err instanceof Error ? err.message : "error"})`
      );
    }
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────────────

/**
 * Run the full inbound pass (apply + adopt) for one team. Fail-soft at every gate: no Linear
 * primary / no opt-in / no teamId / supabase legacy backend all return an explanatory reason
 * instead of throwing (matching the ingest runner's surfaced-reason pattern).
 */
export async function runInboundForTeam(
  supabase: DbClient,
  teamId: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<InboundResult> {
  const primary = await resolvePrimaryProvider(supabase, teamId);
  if (primary.provider !== "linear") {
    return emptyResult({ provider: null, reason: primary.provider === null ? (primary.reason ?? "no primary PM provider") : "inbound apply is Linear-only" });
  }
  if (primary.integration === null) {
    return emptyResult({ provider: "linear", reason: primary.reason });
  }
  if (primary.integration.config?.inboundApply !== true) {
    return emptyResult({
      provider: "linear",
      reason: "inbound apply is not enabled for this team (set inboundApply on the Linear integration)",
    });
  }
  const teamIdConfig = primary.integration.config?.teamId as string | undefined;
  if (!teamIdConfig) {
    return emptyResult({
      provider: "linear",
      enabled: true,
      skipped: ["Linear integration has no teamId configured — cannot reconcile or adopt"],
      reason: "missing config.teamId",
    });
  }

  const fetchImpl = opts.fetchImpl ?? timeoutFetch;
  const result = emptyResult({ provider: "linear", enabled: true });

  // Phase A — apply. One read-only provider listing ({name,type} per issue id).
  const seenByResource = await linearAdapter.fetchSeenStates!({ integration: primary.integration, fetchImpl });
  await applyInbound(supabase, teamId, seenByResource, result);

  // Phase B — adopt. Reuses the ingest fetch (identifier/description/url, footer detection).
  const fetched = await fetchLinearTeam({
    apiKey: primary.integration.secret ?? "",
    teamId: teamIdConfig,
    fetchImpl,
  });
  await adoptInbound(supabase, teamId, primary, fetched, result, fetchImpl);

  return result;
}

export interface InboundRunSummary {
  ok: boolean;
  teams: number;
  applied: number;
  adopted: number;
  conflicts: number;
  noops: number;
  errors: string[];
  skippedReasons: string[];
  /** true when another inbound run was already in flight (single-flight, like the ingest runners). */
  skipped?: boolean;
}

let inboundRunning = false;

/**
 * Run the inbound pass for every team with an enabled Linear integration (or one team). Called by
 * the ingest scheduler tick and manual "sync now" AFTER the Linear ingest leg, so adopt sees
 * freshly-imported mirror tasks. Single-flight, per-team fail-soft — mirrors runLinearIngestion.
 */
export async function runLinearInbound(
  opts: { teamId?: string; fetchImpl?: typeof fetch } = {}
): Promise<InboundRunSummary> {
  const summary: InboundRunSummary = {
    ok: true,
    teams: 0,
    applied: 0,
    adopted: 0,
    conflicts: 0,
    noops: 0,
    errors: [],
    skippedReasons: [],
  };
  if (inboundRunning) return { ...summary, skipped: true };
  inboundRunning = true;
  try {
    const supabase = adminClient();
    let teamIds: string[];
    if (opts.teamId) {
      teamIds = [opts.teamId];
    } else {
      const { data } = await supabase
        .from("integrations")
        .select("team_id")
        .eq("type", "linear")
        .eq("status", "enabled");
      teamIds = [...new Set(((data ?? []) as { team_id: string }[]).map((r) => r.team_id))];
    }
    for (const teamId of teamIds) {
      try {
        const r = await runInboundForTeam(supabase, teamId, { fetchImpl: opts.fetchImpl });
        if (!r.enabled) continue; // not opted in / not Linear — quiet no-op
        summary.teams += 1;
        summary.applied += r.applied.length;
        summary.adopted += r.adopted.length;
        summary.conflicts += r.conflicts.length;
        summary.noops += r.noops;
        summary.skippedReasons.push(...r.skipped.map((s) => `team ${teamId}: ${s}`));
        for (const c of r.conflicts) {
          console.info(
            `[pm-sync] inbound conflict ${c.payload.row_key}: linear "${c.payload.linear_state}" vs brain "${c.payload.brain_state}" (${c.payload.reason})`
          );
        }
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "inbound failed"}`);
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    inboundRunning = false;
  }
}
