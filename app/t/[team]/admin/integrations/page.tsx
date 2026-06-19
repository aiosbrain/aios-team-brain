import type { Metadata } from "next";
import { adminClient } from "@/lib/supabase/admin";
import { listIntegrations } from "@/lib/integrations/read";
import { IntegrationsManager, type IntegrationRow } from "@/components/admin/integrations-manager";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Admin → Integrations. Manage ingestion integrations (type + non-secret selection + an
 * encrypted secret). The /admin subtree is admin-gated by the layout. Reads use the
 * service-role client (already past the admin gate) so `hasSecret` is derivable; the secret
 * value is never sent to the browser. The sidecar pulls these via GET /api/v1/integrations.
 */
export default async function IntegrationsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = adminClient();
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const integrations = (await listIntegrations(supabase, team.id)) as IntegrationRow[];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Connect sources for the ingestion sidecar (Slack, GitHub, Notion, …). The selection
          (channels/repos) and an encrypted secret are stored here; the sidecar fetches enabled
          integrations to run ingestion. Secrets are stored encrypted and never shown again.
        </p>
      </div>
      <IntegrationsManager teamSlug={teamSlug} integrations={integrations} />
    </div>
  );
}
