import type { Metadata } from "next";
import { adminClient } from "@/lib/supabase/admin";
import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { isSupabaseBackend } from "@/lib/db/backend";
import { listIntegrations } from "@/lib/integrations/read";
import { IntegrationsManager, type IntegrationRow } from "@/components/admin/integrations-manager";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Admin → Integrations. Manage ingestion integrations (type + non-secret selection + an
 * encrypted secret). The /admin subtree is admin-gated by the layout; this page ALSO resolves the
 * viewer's role and passes it to `listIntegrations`, which gates on it — the read is admin-tier
 * and there is no RLS backstop on postgres (CLAUDE.md §5), so the gate is defense-in-depth here
 * and the sole enforcement in the helper. The secret value is never sent to the browser (only
 * `hasSecret`). The sidecar pulls enabled selections via GET /api/v1/integrations.
 *
 * Fail-closed on the legacy Supabase backend: the integrations surface (pg-adapter reads, app-code
 * tier gate, encrypted-secret model) targets the self-hosted postgres backend, so under
 * DB_BACKEND=supabase we show a notice and read nothing rather than half-render.
 */
export default async function IntegrationsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;

  if (isSupabaseBackend()) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        </div>
        <p className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-sm text-ink-secondary">
          Integrations are not available on the legacy Supabase backend. Run the Team Brain on the
          self-hosted Postgres backend (the default) to manage ingestion integrations.
        </p>
      </div>
    );
  }

  // Resolve the viewer's role on this team for the read gate (the layout already blocks non-admins).
  const sessionDb = await serverClient();
  const user = await getSessionUser();
  const { data: team } = await sessionDb
    .from("teams")
    .select("id, primary_pm_provider")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;
  const { data: me } = user
    ? await sessionDb
        .from("members")
        .select("role")
        .eq("team_id", team.id)
        .eq("auth_user_id", user.id)
        .eq("status", "active")
        .maybeSingle()
    : { data: null };

  const supabase = adminClient();
  const integrations = (await listIntegrations(supabase, team.id, {
    role: me?.role as string | undefined,
  })) as IntegrationRow[];

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
      <IntegrationsManager
        teamSlug={teamSlug}
        integrations={integrations}
        primaryPmProvider={(team.primary_pm_provider as "plane" | "linear" | null) ?? null}
      />
    </div>
  );
}
