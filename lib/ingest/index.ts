import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ItemPayload,
  taskRowSchema,
  decisionRowSchema,
  normalizeTier,
  normalizeTaskStatus,
  normalizeTaskPriority,
  IngestValidationError,
} from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import {
  effectiveProjectable,
  projectableChanged,
  type ProjectableSnapshot,
} from "@/lib/ingest/projectable-diff";

/**
 * The ONLY write path for synced content. Runs with the service role (bypasses
 * RLS), so it is deliberately narrow, validated, and audited. Semantics are
 * normative in aios-workspace/docs/brain-api.md:
 *   1. upsert project on (team_id, slug)
 *   2. identical sha → bump synced_at, return "unchanged"
 *   3. upsert item; version on body change
 *   4. rows[] → diff-sync by row_key; never delete origin='ui' task rows
 *   5. access 'client' → 'external' (handled by caller); 'admin' → 422 (caller)
 *
 * For task items, returns `projectId` + `changedTaskRowKeys` (the row_keys whose *projected* fields
 * changed this push) so the route can schedule a bounded reactive projection via `after()`. These
 * are internal scheduling hints — the route strips them from the HTTP response (wire format unchanged).
 */
export interface IngestResult {
  status: "created" | "updated" | "unchanged";
  id: string;
  projectId?: string;
  changedTaskRowKeys?: string[];
}

export async function ingestItem(
  supabase: SupabaseClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: ItemPayload,
  access: "team" | "external",
  // INTERNAL-only attribution override (NOT on the wire ItemPayload, so external pushers can't
  // spoof authorship). When an internal caller already knows the content's author — e.g. the
  // codebase scanner attributing a commit to a resolved member — it passes that here; otherwise
  // the item is attributed to the ingesting actor (`auth.memberId`), as before.
  opts?: { authorMemberId?: string | null }
): Promise<IngestResult> {
  // 1. project
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .upsert(
      { team_id: auth.teamId, slug: payload.project, last_synced_at: new Date().toISOString() },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projErr || !project) throw new Error(`project upsert failed: ${projErr?.message}`);

  // 2. existing item?
  const { data: existing } = await supabase
    .from("items")
    .select("id, content_sha256")
    .eq("team_id", auth.teamId)
    .eq("project_id", project.id)
    .eq("path", payload.path)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing && existing.content_sha256 === payload.content_sha256) {
    await supabase.from("items").update({ synced_at: now }).eq("id", existing.id);
    await audit(supabase, {
      team_id: auth.teamId, actor_kind: "api_key",
      member_id: auth.memberId, api_key_id: auth.apiKeyId,
      action: "item.unchanged", target_type: "item", target_id: existing.id,
      meta: { path: payload.path },
    });
    // No projection on an unchanged push (the route also guards status !== "unchanged").
    return { status: "unchanged", id: existing.id, projectId: project.id };
  }

  // Validate task rows before mutating items so a 422 never leaves a revised item/version behind.
  let validatedTaskRows: TaskRow[] | undefined;
  if (payload.rows && payload.kind === "task") {
    validatedTaskRows = await parseAndValidateTaskRows(
      supabase,
      auth.teamId,
      project.id,
      payload.rows
    );
  }

  // 3. upsert item (+ version when body changed)
  const itemRecord = {
    team_id: auth.teamId,
    project_id: project.id,
    path: payload.path,
    kind: payload.kind,
    access,
    frontmatter: payload.frontmatter ?? {},
    body: payload.body,
    content_sha256: payload.content_sha256,
    actor: payload.actor ?? "",
    member_id: opts?.authorMemberId ?? auth.memberId,
    synced_at: now,
    updated_at: now,
  };

  let itemId: string;
  if (existing) {
    const { error } = await supabase.from("items").update(itemRecord).eq("id", existing.id);
    if (error) throw new Error(`item update failed: ${error.message}`);
    itemId = existing.id;
  } else {
    const { data, error } = await supabase.from("items").insert(itemRecord).select("id").single();
    if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
    itemId = data.id;
  }

  await supabase.from("item_versions").insert({
    item_id: itemId,
    content_sha256: payload.content_sha256,
    frontmatter: payload.frontmatter ?? {},
    body: payload.body,
    member_id: auth.memberId,
  });

  // 4. materialize rows. Present (even if empty) for task/decision items, so an emptied
  // markdown table diff-deletes its synced rows. `now` (the item's synced_at) is used as
  // the row updated_at, so a freshly-synced row is NOT mistaken for "edited after sync"
  // by the writeback (which would otherwise re-emit a just-written-back UI row forever).
  let changedTaskRowKeys: string[] | undefined;
  if (payload.rows && (payload.kind === "task" || payload.kind === "decision")) {
    if (payload.kind === "task") {
      changedTaskRowKeys = await materializeTasks(
        supabase,
        auth.teamId,
        project.id,
        itemId,
        validatedTaskRows!,
        now
      );
    } else {
      await materializeDecisions(supabase, auth.teamId, project.id, itemId, payload.rows, now);
    }
  }

  await audit(supabase, {
    team_id: auth.teamId, actor_kind: "api_key",
    member_id: auth.memberId, api_key_id: auth.apiKeyId,
    action: existing ? "item.updated" : "item.created",
    target_type: "item", target_id: itemId,
    meta: { path: payload.path, kind: payload.kind, access, rows: payload.rows?.length ?? 0 },
  });

  return { status: existing ? "updated" : "created", id: itemId, projectId: project.id, changedTaskRowKeys };
}

type TaskRow = NonNullable<ReturnType<typeof taskRowSchema.safeParse>["data"]>;

/** Parse + parent-integrity checks only (no writes). Called before item upsert so 422 is clean. */
async function parseAndValidateTaskRows(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  rawRows: unknown[]
): Promise<TaskRow[]> {
  const parsed = rawRows.map((r) => taskRowSchema.safeParse(r));
  const firstBad = parsed.find((r) => !r.success);
  if (firstBad && !firstBad.success) {
    throw new IngestValidationError(
      `invalid task row: ${firstBad.error.issues[0]?.message ?? "bad shape"}`
    );
  }
  const rows = parsed.map((r) => r.data!);

  const incomingByKey = new Map(rows.map((r) => [r.row_key, r]));
  const parentOf = (r: TaskRow) => (r.parent ?? "").trim();

  const parentMap = new Map<string, string>();
  const existingKeys = new Set<string>();
  {
    const { data: existing } = await supabase
      .from("tasks")
      .select("row_key, parent_row_key")
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .not("row_key", "is", null);
    for (const t of existing ?? []) {
      if (!t.row_key) continue;
      existingKeys.add(t.row_key);
      const p = (t.parent_row_key ?? "").trim();
      if (p) parentMap.set(t.row_key, p);
    }
  }
  for (const row of rows) {
    if (!("parent" in row)) continue;
    const parent = parentOf(row);
    if (!parent) {
      parentMap.delete(row.row_key);
      continue;
    }
    if (parent === row.row_key) {
      throw new IngestValidationError(`task ${row.row_key}: parent cannot reference itself`);
    }
    if (!incomingByKey.has(parent) && !existingKeys.has(parent)) {
      throw new IngestValidationError(`task ${row.row_key}: parent "${parent}" not found in project`);
    }
    parentMap.set(row.row_key, parent);
  }
  for (const start of parentMap.keys()) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur) {
      if (seen.has(cur)) throw new IngestValidationError(`task ${start}: parent cycle detected`);
      seen.add(cur);
      cur = parentMap.get(cur);
    }
  }
  return rows;
}

async function materializeTasks(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: TaskRow[],
  syncedAt: string
): Promise<string[]> {
  const incomingKeys = new Set(rows.map((r) => r.row_key));
  const parentOf = (r: TaskRow) => (r.parent ?? "").trim();

  // Snapshot the incoming rows' projectable columns BEFORE the upsert loop, so we can detect which
  // rows' projected fields changed this push (bounded reactive projection — see projectable-diff).
  const snapshotByKey = new Map<string, ProjectableSnapshot>();
  if (incomingKeys.size) {
    const { data: before } = await supabase
      .from("tasks")
      .select("row_key, title, status, sprint, priority, labels, parent_row_key")
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .not("row_key", "is", null);
    for (const t of before ?? []) {
      if (!t.row_key || !incomingKeys.has(t.row_key)) continue;
      snapshotByKey.set(t.row_key, {
        title: t.title ?? "",
        status: t.status ?? "backlog",
        sprint: t.sprint ?? "",
        priority: t.priority || "none",
        labels: t.labels ?? [],
        parent_row_key: t.parent_row_key ?? null,
      });
    }
  }
  const changed = new Set<string>();

  for (const row of rows) {
    const { status, raw_status } = normalizeTaskStatus(row.status || "");
    // Projected-field change detection (title/status/sprint/priority/labels/parent only). A new row
    // (no snapshot) is always "changed"; assignee/due/body changes never trigger projection.
    const snapshot = snapshotByKey.get(row.row_key) ?? null;
    if (projectableChanged(snapshot, effectiveProjectable(row, snapshot))) changed.add(row.row_key);
    // `body` is dashboard/DB-only and `parent`/`labels`/`priority` are optional v1.2 fields: each is
    // written ONLY when the row carries the key, so a six-column push preserves them on update and
    // falls back to DB defaults on insert. (A present-but-empty value is authoritative — it clears.)
    const upsertRow: Record<string, unknown> = {
      team_id: teamId,
      project_id: projectId,
      source_item_id: itemId,
      row_key: row.row_key,
      title: row.title,
      assignee: row.assignee ?? "",
      status,
      raw_status,
      sprint: row.sprint ?? "",
      due_date: row.due || null,
      origin: "sync",
      updated_at: syncedAt,
    };
    if ("parent" in row) upsertRow.parent_row_key = parentOf(row) || null;
    if ("labels" in row) upsertRow.labels = row.labels ?? [];
    if ("priority" in row) upsertRow.priority = normalizeTaskPriority(row.priority);
    const { data: task, error } = await supabase
      .from("tasks")
      .upsert(upsertRow, { onConflict: "team_id,project_id,row_key" })
      .select("id")
      .single();
    if (error) throw new Error(`task row ${row.row_key}: ${error.message}`);

    if (row.pm_provider && row.pm_external_id) {
      const { error: linkErr } = await supabase.from("task_pm_links").upsert(
        {
          team_id: teamId,
          project_id: projectId,
          task_id: (task as { id: string } | null)?.id ?? null,
          row_key: row.row_key,
          provider: row.pm_provider,
          provider_external_id: row.pm_external_id,
          provider_url: row.pm_url ?? "",
          updated_at: syncedAt,
        },
        { onConflict: "team_id,project_id,row_key,provider" }
      );
      if (linkErr) throw new Error(`task PM link ${row.row_key}: ${linkErr.message}`);
    }
  }

  // diff-delete: sync-originated rows absent from this push; UI rows survive.
  const { data: current } = await supabase
    .from("tasks")
    .select("id, row_key, origin, parent_row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  const survivors = new Set<string>();
  for (const t of current ?? []) {
    if (t.origin === "sync" && t.row_key && !incomingKeys.has(t.row_key)) {
      await supabase.from("tasks").delete().eq("id", t.id);
    } else if (t.row_key) {
      survivors.add(t.row_key);
    }
  }
  // No DB FK backs parent_row_key, so a deleted epic can leave a surviving child pointing at a
  // now-missing parent. Null those dangling references so the brain stays internally consistent
  // (the projection's topological sort errors on a missing parent).
  for (const t of current ?? []) {
    const parent = (t.parent_row_key ?? "").trim();
    if (parent && survivors.has(t.row_key!) && !survivors.has(parent)) {
      await supabase.from("tasks").update({ parent_row_key: null }).eq("id", t.id);
      // Nulling a dangling parent IS a projected-field change (the child must un-nest on the board),
      // but it happens after the snapshot diff — so flag it here or reactive projection would miss it.
      if (t.row_key) changed.add(t.row_key);
    }
  }

  // The row_keys whose projected fields changed this push. The route projects only these (the
  // after() callback reloads each row's final DB state, so a parent nulled above is reflected).
  return [...changed];
}

async function materializeDecisions(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rawRows: unknown[],
  syncedAt: string
) {
  const rows = rawRows
    .map((r) => decisionRowSchema.safeParse(r))
    .filter((r) => r.success)
    .map((r) => r.data!);

  for (const row of rows) {
    const audience = normalizeTier(row.audience || "team") ?? "team";
    const { error } = await supabase.from("decisions").upsert(
      {
        team_id: teamId,
        project_id: projectId,
        source_item_id: itemId,
        row_key: row.row_key,
        decided_at: row.decided_at || null,
        title: row.title,
        rationale: row.rationale ?? "",
        decided_by: row.decided_by ?? "",
        impact: row.impact ?? "",
        tier: row.tier ?? null,
        audience,
        updated_at: syncedAt,
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`decision row ${row.row_key}: ${error.message}`);
  }
}
