import "server-only";

/**
 * Role gate for the dashboard Integrations surface (CLAUDE.md §5). Integrations hold a team's
 * ingestion config — non-secret selection plus an ENCRYPTED connector secret — and are
 * **admin-tier**: there is no per-row `access` column, so the unit of access is the whole table
 * and only an `admin` role may read/manage it. An `external`-tier collaborator is never an admin,
 * so this gate also keeps integration config off the external surface.
 *
 * In postgres mode there is NO RLS, so this app-code check is the SOLE enforcement for dashboard
 * reads; the integrations-tier-filter guard asserts every read helper routes through it, and the
 * data-mechanics tier test proves the observable outcome (a non-admin read returns nothing).
 *
 * (This gates the dashboard READ. Writes are gated by `resolveIntegrationsAdmin` in the server
 * action; the API-key selection read is gated by `authenticateApiKey` at the route — different
 * boundaries, each tested.)
 */
export function canManageIntegrations(role: string | null | undefined): boolean {
  return role === "admin";
}
