import "server-only";

import type { IntegrationWithSecret } from "@/lib/integrations/manage";

export type PmProvider = "plane" | "linear";

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

export interface PmAdapter {
  provider: PmProvider;
  moveToDone(input: ProviderSyncInput): Promise<ProviderSyncResult>;
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
