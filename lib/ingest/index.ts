import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ItemPayload,
  taskRowSchema,
  decisionRowSchema,
  normalizeTier,
  normalizeTaskStatus,
} from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";

/**
 * The ONLY write path for synced content. Runs with the service role (bypasses
 * RLS), so it is deliberately narrow, validated, and audited. Semantics are
 * normative in agentic-team-ops/docs/brain-api.md:
 *   1. upsert project on (team_id, slug)
 *   2. identical sha → bump synced_at, return "unchanged"
 *   3. upsert item; version on body change
 *   4. rows[] → diff-sync by row_key; never delete origin='ui' task rows
 *   5. access 'client' → 'external' (handled by caller); 'admin' → 422 (caller)
 */
export async function ingestItem(
  supabase: SupabaseClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: ItemPayload,
  access: "team" | "external"
): Promise<{ status: "created" | "updated" | "unchanged"; id: string }> {
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
    return { status: "unchanged", id: existing.id };
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
    member_id: auth.memberId,
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

  // 4. materialize rows
  if (payload.rows?.length) {
    if (payload.kind === "task") {
      await materializeTasks(supabase, auth.teamId, project.id, itemId, payload.rows);
    } else if (payload.kind === "decision") {
      await materializeDecisions(supabase, auth.teamId, project.id, itemId, payload.rows);
    }
  }

  await audit(supabase, {
    team_id: auth.teamId, actor_kind: "api_key",
    member_id: auth.memberId, api_key_id: auth.apiKeyId,
    action: existing ? "item.updated" : "item.created",
    target_type: "item", target_id: itemId,
    meta: { path: payload.path, kind: payload.kind, access, rows: payload.rows?.length ?? 0 },
  });

  return { status: existing ? "updated" : "created", id: itemId };
}

async function materializeTasks(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rawRows: unknown[]
) {
  const rows = rawRows
    .map((r) => taskRowSchema.safeParse(r))
    .filter((r) => r.success)
    .map((r) => r.data!);

  const incomingKeys = new Set(rows.map((r) => r.row_key));

  for (const row of rows) {
    const { status, raw_status } = normalizeTaskStatus(row.status || "");
    const { error } = await supabase.from("tasks").upsert(
      {
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`task row ${row.row_key}: ${error.message}`);
  }

  // diff-delete: sync-originated rows absent from this push; UI rows survive.
  const { data: current } = await supabase
    .from("tasks")
    .select("id, row_key, origin")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  for (const t of current ?? []) {
    if (t.origin === "sync" && t.row_key && !incomingKeys.has(t.row_key)) {
      await supabase.from("tasks").delete().eq("id", t.id);
    }
  }
}

async function materializeDecisions(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rawRows: unknown[]
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`decision row ${row.row_key}: ${error.message}`);
  }
}
