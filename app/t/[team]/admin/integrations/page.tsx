import type { Metadata } from "next";
import { adminClient } from "@/lib/supabase/admin";
import { listConnections } from "@/lib/connections";
import { ConnectionsManager, type ConnectionRow } from "@/components/admin/connections-manager";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Admin → Integrations. Manage ingestion connections (source + config + an encrypted secret).
 * The whole /admin subtree is admin-gated by the layout. Reads use the service-role client
 * (already past the admin gate) so `hasSecret` is derivable; the secret value is never sent
 * to the browser — only `hasSecret`. The ingestion sidecar pulls these via GET /api/v1/connections.
 */
export default async function IntegrationsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = adminClient();
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const connections: ConnectionRow[] = (await listConnections(supabase, team.id)).map((c) => ({
    id: c.id,
    source: c.source,
    name: c.name,
    config: c.config,
    enabled: c.enabled,
    hasSecret: c.hasSecret,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Connect sources for the ingestion sidecar (Slack, GitHub, Notion, …). Secrets are stored
          encrypted and never shown again; the sidecar fetches enabled connections to run ingestion.
        </p>
      </div>
      <ConnectionsManager teamSlug={teamSlug} connections={connections} />
    </div>
  );
}
