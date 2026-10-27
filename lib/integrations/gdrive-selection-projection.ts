import "server-only";

import type { ApiAuth } from "@/lib/api/auth";
import { runSql } from "@/lib/db/pg/pool";
import { isGdriveConnectorPrincipal, LIVE_GDRIVE_CONNECTOR_SQL } from "@/lib/integrations/gdrive-authority";
import type { IntegrationSelection } from "@/lib/integrations/manage";

/**
 * AIO-1167 R42 F5 — who may read a Drive connection's account and selection metadata over the API.
 *
 * A Drive row's config names the connected Google account (email, OAuth subject, whether the email is
 * verified), the granted scopes, every selected file/folder/shared-drive id, the audience projects
 * and the service-account identity. Only the connection's BOUND, LIVE connector principal needs any
 * of that (its run overlays it onto the local connection), so only that principal receives it, and
 * only for the connections bound to it. Every other key — ordinary members, external-tier members,
 * Slack/GitHub connectors, a Drive connector bound to a different connection or rotated away —
 * still DISCOVERS every row (id, type, name, status), with its Drive config reduced to the keys below.
 * Non-Drive rows are untouched.
 */

/** The Drive config keys any team key may read: how a connection authenticates, never whose or what. */
export const GDRIVE_DISCOVERY_CONFIG_KEYS: readonly string[] = ["authMode"];

/**
 * The ids of the Drive connections whose LIVE bound connector principal is exactly this key and
 * member. Empty for any caller that is not a team-tier `gdrive-sync` connector. Read-only: the
 * execution boundary (`gdrive-authority`) remains the authority for every action; this decides only
 * what metadata a read returns, from the same predicate.
 */
export async function gdriveConnectionsBoundTo(auth: ApiAuth): Promise<ReadonlySet<string>> {
  if (!isGdriveConnectorPrincipal(auth)) return new Set();
  const { rows } = await runSql<{ integration_id: string }>(
    `select a.integration_id
       from gdrive_connection_authority a
       join integrations i on i.id = a.integration_id and i.team_id = a.team_id and i.type = 'gdrive'
       join api_keys k on k.id = a.connector_api_key_id and k.team_id = a.team_id
       join members m on m.id = a.connector_member_id and m.team_id = a.team_id and m.id = k.member_id
      where a.team_id = $1 and a.connector_api_key_id = $2 and a.connector_member_id = $3
        and ${LIVE_GDRIVE_CONNECTOR_SQL}`,
    [auth.teamId, auth.apiKeyId, auth.memberId],
  );
  return new Set(rows.map((row) => row.integration_id));
}

/** A Drive row's config as an unbound caller sees it: the discovery keys only. */
export function discoveryGdriveConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    GDRIVE_DISCOVERY_CONFIG_KEYS.filter((key) => key in config).map((key) => [key, config[key]]),
  );
}

/** Project selections for a caller: full config for its bound Drive rows and every non-Drive row. */
export function projectSelectionsFor(
  selections: readonly IntegrationSelection[],
  bound: ReadonlySet<string>,
): IntegrationSelection[] {
  return selections.map((selection) =>
    selection.type !== "gdrive" || bound.has(selection.id)
      ? selection
      : { ...selection, config: discoveryGdriveConfig(selection.config) },
  );
}
