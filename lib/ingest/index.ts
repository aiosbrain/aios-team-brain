import "server-only";
import type { DbClient } from "@/lib/db/types";
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
  db: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: ItemPayload,
  access: "team" | "external",
  // Attribution override, set by the CALLER (never a raw wire field). Internal callers that already
  // know the author pass it (the codebase scanner; the pm-sync per-author paths). The `/api/v1/items`
  // route DERIVES it from the push's frontmatter via `attributeIncomingItem` — but ONLY for trusted
  // TEAM-tier keys (it skips external-tier keys), so an untrusted external pusher still can't spoof
  // authorship onto a team member. When an internal caller already knows the content's author it
  // passes that here; otherwise
  // (opts omitted entirely) the item is attributed to the ingesting actor (`auth.memberId`). A
  // caller that HAS attempted resolution but come up empty must pass `authorMemberId: null`
  // explicitly (not omit opts) — that's the only way to say "leave this unattributed" rather than
  // "attribute to whoever's pushing," so a connector ingesting on behalf of an unresolved human
  // never silently falls back to the connector's own member_id.
  opts?: { authorMemberId: string | null }
): Promise<IngestResult> {
  // 1. project
  const { data: project, error: projErr } = await db
    .from("projects")
    .upsert(
      { team_id: auth.teamId, slug: payload.project, last_synced_at: new Date().toISOString() },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projErr || !project) throw new Error(`project upsert failed: ${projErr?.message}`);

  // 2. existing item?
  const { data: existing } = await db
    .from("items")
    .select("id, content_sha256, member_id")
    .eq("team_id", auth.teamId)
    .eq("project_id", project.id)
    .eq("path", payload.path)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing && existing.content_sha256 === payload.content_sha256) {
    // Refresh "last seen this sync"; do NOT write an audit row (audit M4). Every 30-min sync tick
    // re-pushes every unchanged item, so an `item.unchanged` audit here added ~one row/item/tick
    // (~24k/day at 500 items) — unbounded audit_log growth with no diagnostic value. The synced_at
    // bump is the freshness signal; create/update/delete stay audited on the paths below.
    //
    // HEAL ATTRIBUTION on an unchanged re-push: `content_sha256` covers only body+title, so a resolved
    // author that arrived AFTER first ingest (a source that only later exposes authorship, e.g. Notion
    // enrichment, or a first-ingest API flake) would otherwise be discarded here forever. Rescue it —
    // but ONLY when the item is currently UNATTRIBUTED (`member_id` null). We never RE-POINT an
    // already-attributed item on a routine unchanged re-push: doing so would auto-revert a deliberate
    // admin re-attribution (the NL correction / "Re-attribute content") on the very next sync, and
    // clobber a human self-push's own attribution. Re-pointing an existing (wrong) attribution stays the
    // job of the explicit, admin-triggered `reattributeItems` batch. Never clears to null either (a
    // connector's unresolved re-push passes `authorMemberId: null`).
    const patch: { synced_at: string; member_id?: string } = { synced_at: now };
    if (opts?.authorMemberId && existing.member_id === null) {
      patch.member_id = opts.authorMemberId;
    }
    await db.from("items").update(patch).eq("id", existing.id);
    // Audit the rare heal (a genuine attribution change — unlike the per-tick synced_at bump, so it
    // doesn't reintroduce the M4 unbounded-growth problem), so the change isn't a silent DB mutation.
    if (patch.member_id) {
      await audit(db, {
        team_id: auth.teamId,
        actor_kind: "system",
        member_id: null,
        action: "item.attribution_healed",
        target_type: "items",
        target_id: existing.id,
        meta: { to: patch.member_id, source: payload.frontmatter?.source ?? null },
      });
    }
    // No projection on an unchanged push (the route also guards status !== "unchanged").
    return { status: "unchanged", id: existing.id, projectId: project.id };
  }

  // Validate task rows before mutating items so a 422 never leaves a revised item/version behind.
  let validatedTaskRows: TaskRow[] | undefined;
  if (payload.rows && payload.kind === "task") {
    validatedTaskRows = await parseAndValidateTaskRows(
      db,
      auth.teamId,
      project.id,
      payload.rows
    );
  }

  // 3. upsert item (+ version when body changed). The item write and the row materialization below
  // are NOT one transaction (the compat adapter can't share a pinned connection), so we WITHHOLD the
  // new content_sha256 until materialize succeeds (audit H4). On a mid-materialize failure the item
  // keeps its OLD sha (or, for a brand-new row, an empty sentinel a 64-hex sha can never equal), so
  // the retry's "unchanged" fast-path above does NOT fire and the rows get re-materialized — instead
  // of the item being marked synced while its task/decision board stays permanently diverged. The
  // real hash is committed in one final update (step 5), the single point that marks this push synced.
  const PENDING_SHA = ""; // real content_sha256 is 64 hex chars; "" forces reprocess after a crash
  const itemRecord = {
    team_id: auth.teamId,
    project_id: project.id,
    path: payload.path,
    kind: payload.kind,
    access,
    frontmatter: payload.frontmatter ?? {},
    body: payload.body,
    content_sha256: existing ? existing.content_sha256 : PENDING_SHA,
    actor: payload.actor ?? "",
    member_id: opts ? opts.authorMemberId : auth.memberId,
    synced_at: now,
    updated_at: now,
  };

  let itemId: string;
  if (existing) {
    const { error } = await db.from("items").update(itemRecord).eq("id", existing.id);
    if (error) throw new Error(`item update failed: ${error.message}`);
    itemId = existing.id;
  } else {
    const { data, error } = await db.from("items").insert(itemRecord).select("id").single();
    if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
    itemId = data.id;
  }

  // Version history — surface errors (audit LOW: previously swallowed, silently losing versions).
  const { error: versionErr } = await db.from("item_versions").insert({
    item_id: itemId,
    content_sha256: payload.content_sha256,
    frontmatter: payload.frontmatter ?? {},
    body: payload.body,
    member_id: opts ? opts.authorMemberId : auth.memberId,
  });
  if (versionErr) throw new Error(`item version insert failed: ${versionErr.message}`);

  // 4. materialize rows. Present (even if empty) for task/decision items, so an emptied
  // markdown table diff-deletes its synced rows. `now` (the item's synced_at) is used as
  // the row updated_at, so a freshly-synced row is NOT mistaken for "edited after sync"
  // by the writeback (which would otherwise re-emit a just-written-back UI row forever).
  let changedTaskRowKeys: string[] | undefined;
  if (payload.rows && (payload.kind === "task" || payload.kind === "decision")) {
    if (payload.kind === "task") {
      changedTaskRowKeys = await materializeTasks(
        db,
        auth.teamId,
        project.id,
        itemId,
        validatedTaskRows!,
        now,
        access
      );
    } else {
      await materializeDecisions(db, auth.teamId, project.id, itemId, payload.rows, now);
    }
  }

  // 5. Commit the content hash LAST — marks the push durably synced (audit H4). Any throw above left
  // the old/sentinel sha, so a retry reprocesses rather than short-circuiting on "unchanged".
  const { error: shaErr } = await db
    .from("items")
    .update({ content_sha256: payload.content_sha256 })
    .eq("id", itemId);
  if (shaErr) throw new Error(`item sha commit failed: ${shaErr.message}`);

  await audit(db, {
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
  db: DbClient,
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
    const { data: existing } = await db
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
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: TaskRow[],
  syncedAt: string,
  // Tier the materialized rows inherit (audit H1). Tasks carry no wire-level audience; a task is
  // visible at exactly the tier of the item that produced it, so an external principal never reads
  // internal task boards. See tasks.audience / visibleTasks.
  audience: "team" | "external"
): Promise<string[]> {
  const incomingKeys = new Set(rows.map((r) => r.row_key));
  const parentOf = (r: TaskRow) => (r.parent ?? "").trim();

  // Snapshot the incoming rows' projectable columns BEFORE the upsert loop, so we can detect which
  // rows' projected fields changed this push (bounded reactive projection — see projectable-diff).
  const snapshotByKey = new Map<string, ProjectableSnapshot>();
  if (incomingKeys.size) {
    const { data: before, error: beforeErr } = await db
      .from("tasks")
      .select("row_key, title, status, sprint, priority, labels, parent_row_key, assignee")
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .not("row_key", "is", null);
    if (beforeErr) throw new Error(`task snapshot: ${beforeErr.message}`);
    for (const t of before ?? []) {
      if (!t.row_key || !incomingKeys.has(t.row_key)) continue;
      snapshotByKey.set(t.row_key, {
        title: t.title ?? "",
        status: t.status ?? "backlog",
        sprint: t.sprint ?? "",
        priority: t.priority || "none",
        labels: t.labels ?? [],
        parent_row_key: t.parent_row_key ?? null,
        assignee: t.assignee ?? "",
      });
    }
  }
  const changed = new Set<string>();

  for (const row of rows) {
    const { status, raw_status } = normalizeTaskStatus(row.status || "");
    // Projected-field change detection (title/status/sprint/priority/labels/parent/assignee). A new
    // row (no snapshot) is always "changed"; due_date/body changes never trigger projection.
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
      status,
      raw_status,
      sprint: row.sprint ?? "",
      due_date: row.due || null,
      origin: "sync",
      audience,
      updated_at: syncedAt,
    };
    if ("assignee" in row) upsertRow.assignee = (row.assignee ?? "").trim();
    else if (!snapshot) upsertRow.assignee = "";
    if ("parent" in row) upsertRow.parent_row_key = parentOf(row) || null;
    if ("labels" in row) upsertRow.labels = row.labels ?? [];
    if ("priority" in row) upsertRow.priority = normalizeTaskPriority(row.priority);
    const { data: task, error } = await db
      .from("tasks")
      .upsert(upsertRow, { onConflict: "team_id,project_id,row_key" })
      .select("id")
      .single();
    if (error) throw new Error(`task row ${row.row_key}: ${error.message}`);

    if (row.pm_provider && row.pm_external_id) {
      const { error: linkErr } = await db.from("task_pm_links").upsert(
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
  const { data: current } = await db
    .from("tasks")
    .select("id, row_key, origin, parent_row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  const survivors = new Set<string>();
  for (const t of current ?? []) {
    if (t.origin === "sync" && t.row_key && !incomingKeys.has(t.row_key)) {
      await db.from("tasks").delete().eq("id", t.id);
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
      await db.from("tasks").update({ parent_row_key: null }).eq("id", t.id);
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
  db: DbClient,
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
    const { error } = await db.from("decisions").upsert(
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
