import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnabledIntegrationsWithSecrets, type IntegrationWithSecret } from "@/lib/integrations/manage";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { planeAdapter } from "@/lib/pm-sync/plane";
import type { PmAdapter, PmProvider, ProviderSyncResult, TaskPmLink } from "@/lib/pm-sync/provider";

const ADAPTERS: Record<PmProvider, PmAdapter> = {
  plane: planeAdapter,
  linear: linearAdapter,
};

export interface TaskForPmSync {
  id: string;
  team_id: string;
  project_id: string;
  row_key: string | null;
}

export interface TaskPmSyncReport {
  row_key: string;
  provider: PmProvider | null;
  status: "synced" | "skipped" | "no_link" | "missing_integration" | "failed";
  error?: string;
}

async function updateLinkSuccess(
  supabase: SupabaseClient,
  link: TaskPmLink,
  result: ProviderSyncResult
) {
  await supabase
    .from("task_pm_links")
    .update({
      provider_resource_id: result.providerResourceId ?? link.provider_resource_id,
      provider_url: result.providerUrl ?? link.provider_url ?? "",
      last_synced_status: result.syncedStatus ?? "done",
      last_synced_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", link.id);
}

async function updateLinkError(supabase: SupabaseClient, link: TaskPmLink, error: string) {
  await supabase
    .from("task_pm_links")
    .update({ last_error: error.slice(0, 1000), updated_at: new Date().toISOString() })
    .eq("id", link.id);
}

function chooseIntegration(
  integrations: IntegrationWithSecret[],
  provider: PmProvider
): IntegrationWithSecret | null {
  return integrations.find((i) => i.type === provider && i.secret) ?? null;
}

export async function syncTaskPmLinks(
  supabase: SupabaseClient,
  task: TaskForPmSync,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<TaskPmSyncReport[]> {
  if (!task.row_key) return [{ row_key: "", provider: null, status: "no_link" }];

  const { data, error } = await supabase
    .from("task_pm_links")
    .select("*")
    .eq("team_id", task.team_id)
    .eq("project_id", task.project_id)
    .eq("row_key", task.row_key);
  if (error) throw new Error(`load task PM links failed: ${error.message}`);

  const links = (data ?? []) as TaskPmLink[];
  if (!links.length) return [{ row_key: task.row_key, provider: null, status: "no_link" }];

  const integrations = await getEnabledIntegrationsWithSecrets(supabase, task.team_id);
  const reports: TaskPmSyncReport[] = [];
  for (const link of links) {
    const provider = link.provider;
    const integration = chooseIntegration(integrations, provider);
    if (!integration) {
      const message = `${provider} integration is not enabled or has no secret`;
      await updateLinkError(supabase, link, message);
      reports.push({ row_key: link.row_key, provider, status: "missing_integration", error: message });
      continue;
    }
    try {
      const result = await ADAPTERS[provider].moveToDone({ link, integration, fetchImpl: opts.fetchImpl });
      await updateLinkSuccess(supabase, link, result);
      reports.push({ row_key: link.row_key, provider, status: result.status });
    } catch (e) {
      const message = e instanceof Error ? e.message : "PM sync failed";
      await updateLinkError(supabase, link, message);
      reports.push({ row_key: link.row_key, provider, status: "failed", error: message });
    }
  }
  return reports;
}
