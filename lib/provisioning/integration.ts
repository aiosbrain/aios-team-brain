import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { IntegrationType } from "@/lib/api/schemas";
import {
  getEnabledIntegrationsWithSecrets,
  type IntegrationWithSecret,
} from "@/lib/integrations/manage";

/**
 * The team's earliest-created ENABLED integration of a given type, with its decrypted secret — or
 * null if none is enabled. Reused by every provisioning adapter so they resolve config/secret the
 * same way (and only ever see ENABLED integrations: a disabled tool never provisions). Server-only:
 * the secret is decrypted in-process and never crosses an HTTP boundary.
 */
export async function enabledIntegration(
  db: DbClient,
  teamId: string,
  type: IntegrationType
): Promise<IntegrationWithSecret | null> {
  const all = await getEnabledIntegrationsWithSecrets(db, teamId);
  return all.find((i) => i.type === type) ?? null;
}
