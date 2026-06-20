#!/usr/bin/env tsx
import { adminClient } from "@/lib/supabase/admin";
import { planeAdapter } from "@/lib/pm-sync/plane";
import { getEnabledIntegrationsWithSecrets, type IntegrationWithSecret } from "@/lib/integrations/manage";
import type { TaskPmLink } from "@/lib/pm-sync/provider";

const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};
const has = (name: string) => args.includes(name);

const APPLY = has("--apply");
const STATUS = flag("--status", "");
const KEYS = flag("--keys", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEAM = flag("--team", process.env.AIOS_TEAM || "");
const PROJECT = flag("--project", process.env.AIOS_PROJECT || "aios-team-brain");
let BASE_URL = (process.env.PLANE_BASE_URL || "https://api.plane.so").replace(/\/$/, "");
let WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || "";
let PROJECT_ID = process.env.PLANE_PROJECT_ID || "";
let API_KEY = process.env.PLANE_API_KEY || "";
let DONE_STATE = process.env.PLANE_DONE_STATE || "DONE";
let EXTERNAL_SOURCE = process.env.PLANE_EXTERNAL_SOURCE || "aios-backlog";

if (!TEAM) throw new Error("Set AIOS_TEAM or pass --team <team id or slug>");
if (!KEYS.length) throw new Error("Pass --keys P0 or --keys P0,P0.1");

type TaskRow = { id: string; team_id: string; project_id: string; row_key: string };

async function loadContext() {
  const db = adminClient();
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(TEAM);
  let team = null;
  if (looksLikeUuid) {
    const byId = await db
      .from("teams")
      .select("id, slug")
      .eq("id", TEAM)
      .maybeSingle();
    team = byId.data;
  }
  if (!team) {
    const bySlug = await db
      .from("teams")
      .select("id, slug")
      .eq("slug", TEAM)
      .maybeSingle();
    team = bySlug.data;
  }
  if (!team) throw new Error(`Team not found: ${TEAM}`);

  const { data: project } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", team.id)
    .eq("slug", PROJECT)
    .maybeSingle();
  if (!project) {
    return { db, teamId: team.id as string, projectId: null as string | null };
  }
  return { db, teamId: team.id as string, projectId: project.id as string };
}

async function findTask(teamId: string, projectId: string | null, rowKey: string): Promise<TaskRow | null> {
  if (!projectId) return null;
  const { data } = await adminClient()
    .from("tasks")
    .select("id, team_id, project_id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as TaskRow | null;
}

async function resolvePlaneConfig(teamId: string) {
  if (API_KEY && WORKSPACE_SLUG && PROJECT_ID) return;
  const integration = (await getEnabledIntegrationsWithSecrets(adminClient(), teamId)).find((i) => i.type === "plane");
  if (!integration) {
    throw new Error(
      "No Plane env vars and no enabled Team Brain Plane integration found. " +
        "Set PLANE_API_KEY/PLANE_WORKSPACE_SLUG/PLANE_PROJECT_ID or configure Admin → Integrations."
    );
  }
  const config = integration.config ?? {};
  API_KEY ||= integration.secret ?? "";
  WORKSPACE_SLUG ||= String(config.workspaceSlug ?? "");
  PROJECT_ID ||= String(config.projectId ?? "");
  BASE_URL = String(config.baseUrl ?? BASE_URL).replace(/\/$/, "");
  DONE_STATE = String(config.doneStateName ?? DONE_STATE);
  EXTERNAL_SOURCE = String(config.externalSource ?? EXTERNAL_SOURCE);
  if (!API_KEY || !WORKSPACE_SLUG || !PROJECT_ID) {
    throw new Error("Plane integration is missing secret, workspaceSlug, or projectId");
  }
}

async function upsertLink(task: TaskRow, rowKey: string): Promise<TaskPmLink> {
  const { data, error } = await adminClient()
    .from("task_pm_links")
    .upsert(
      {
        team_id: task.team_id,
        project_id: task.project_id,
        task_id: task.id,
        row_key: rowKey,
        provider: "plane",
        provider_external_source: EXTERNAL_SOURCE,
        provider_external_id: rowKey,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,project_id,row_key,provider" }
    )
    .select(
      "id, team_id, project_id, task_id, row_key, provider, provider_resource_id, provider_external_source, provider_external_id, provider_url"
    )
    .single();
  if (error || !data) throw new Error(`link upsert failed for ${rowKey}: ${error?.message}`);
  return data as TaskPmLink;
}

async function markDone(link: TaskPmLink) {
  const integration: IntegrationWithSecret = {
    id: "env-plane",
    type: "plane",
    name: "env-plane",
    secret: API_KEY,
    config: {
      baseUrl: BASE_URL,
      workspaceSlug: WORKSPACE_SLUG,
      projectId: PROJECT_ID,
      doneStateName: DONE_STATE,
      externalSource: EXTERNAL_SOURCE,
    },
  };
  const result = await planeAdapter.moveToDone({ link, integration });
  await adminClient()
    .from("task_pm_links")
    .update({
      provider_resource_id: result.providerResourceId ?? link.provider_resource_id,
      provider_url: result.providerUrl ?? link.provider_url,
      last_synced_status: result.syncedStatus ?? "done",
      last_synced_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", link.id);
  return result;
}

async function main() {
  const { teamId, projectId } = await loadContext();
  await resolvePlaneConfig(teamId);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"} · team=${TEAM} · project=${PROJECT}`);
  if (!projectId) console.log(`Project ${PROJECT} is not present in Team Brain; Plane state can still be inspected.`);

  for (const key of KEYS) {
    const task = await findTask(teamId, projectId, key);
    console.log(`${key}: ${task ? `task ${task.id}` : "no matching AIOS task"}`);
    if (!APPLY) {
      console.log(`  would link plane external_source=${EXTERNAL_SOURCE} external_id=${key}`);
      if (STATUS === "done") console.log("  would move Plane work item to completed state");
      continue;
    }

    const link = task
      ? await upsertLink(task, key)
      : ({
          id: "dry-link",
          team_id: teamId,
          project_id: projectId || "",
          task_id: null,
          row_key: key,
          provider: "plane",
          provider_resource_id: null,
          provider_external_source: EXTERNAL_SOURCE,
          provider_external_id: key,
          provider_url: "",
        } as TaskPmLink);
    console.log("  linked");
    if (STATUS === "done") {
      const result = await markDone(link);
      console.log(`  Plane ${result.status}: ${result.syncedStatus || "done"}`);
    }
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
