import type { Metadata } from "next";
import { adminClient } from "@/lib/db/admin";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { listIntegrations } from "@/lib/integrations/read";
import { IntegrationsManager, type IntegrationRow } from "@/components/admin/integrations-manager";
import { GithubReposPanel } from "@/components/admin/github-repos-panel";
import { OpenrouterPanel } from "@/components/admin/openrouter-panel";
import { MemberOnboardingPanel } from "@/components/admin/member-onboarding-panel";
import { getCodebaseFreshness } from "@/lib/metrics/codebases";
import { listRecentIngestRuns } from "@/lib/ingest/runs";
import { IngestRunsPanel } from "@/components/admin/ingest-runs-panel";
import { getRetrievalHealth } from "@/lib/query/retrieval-health";
import { RetrievalHealthCard } from "@/components/admin/retrieval-health-card";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { PipelineHealthBanner } from "@/components/admin/pipeline-health-banner";
import { describeAnswering } from "@/lib/query/llm-backend";
import { normalizeAnsweringProvider } from "@/lib/query/answering";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Admin → Integrations. Manage ingestion integrations (type + non-secret selection + an
 * encrypted secret). The /admin subtree is admin-gated by the layout; this page ALSO resolves the
 * viewer's role and passes it to `listIntegrations`, which gates on it — the read is admin-tier
 * and there is no RLS backstop on postgres (CLAUDE.md §5), so the gate is defense-in-depth here
 * and the sole enforcement in the helper. The secret value is never sent to the browser (only
 * `hasSecret`). The sidecar pulls enabled selections via GET /api/v1/integrations.
 */
export default async function IntegrationsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;

  // Resolve the viewer's role on this team for the read gate (the layout already blocks non-admins).
  const sessionDb = await serverClient();
  const user = await getSessionUser();
  const { data: team } = await sessionDb
    .from("teams")
    .select("id, primary_pm_provider, answering_provider, reasoning_model")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;
  const { data: me } = user
    ? await sessionDb
        .from("members")
        .select("role, tier")
        .eq("team_id", team.id)
        .eq("auth_user_id", user.id)
        .eq("status", "active")
        .maybeSingle()
    : { data: null };

  const db = adminClient();
  const [integrations, ingestRuns, pipelineHealth, freshness, retrievalHealth] = await Promise.all([
    listIntegrations(db, team.id, { role: me?.role as string | undefined }) as Promise<IntegrationRow[]>,
    listRecentIngestRuns(db, team.id, 30),
    getPipelineHealth(team.id),
    // Already-scanned repos (from codebase scans) → offered as one-click link suggestions. Read
    // through the tier-gated codebases choke point (CLAUDE.md §5), never the table directly.
    getCodebaseFreshness(db, team.id, (me?.tier as "team" | "external") ?? "external"),
    getRetrievalHealth(team.id),
  ]);
  const githubIntegration = integrations.find((i) => i.type === "github") ?? null;
  const openrouter = integrations.find((i) => i.type === "openrouter") ?? null;

  // "Active answering model" state: the explicit override + each provider's availability/model, and
  // the RESOLVED backend (provider + model) so the panel shows exactly what's answering — without
  // decrypting any key (a non-empty sentinel stands in for "key is set" since the resolver only
  // checks presence). LLM_BASE_URL comes from the server env (the self-hosted "local" backend).
  const modelOf = (type: "anthropic" | "openai" | "openrouter") =>
    (integrations.find((i) => i.type === type)?.config.model as string | undefined) ?? null;
  const hasKey = (type: "anthropic" | "openai" | "openrouter") =>
    !!integrations.find((i) => i.type === type)?.hasSecret;
  const answeringProvider = normalizeAnsweringProvider(team.answering_provider);
  const localBaseUrl = process.env.LLM_BASE_URL ?? undefined;
  const answering = describeAnswering(
    { LLM_BASE_URL: localBaseUrl, LLM_MODEL: process.env.LLM_MODEL },
    {
      anthropicKey: "env-or-set", // anthropic answers via env key even when no team key is stored
      anthropicModel: modelOf("anthropic"),
      openaiKey: hasKey("openai") ? "set" : null,
      openaiModel: modelOf("openai"),
      openrouterKey: hasKey("openrouter") ? "set" : null,
      openrouterModel: modelOf("openrouter"),
      activeProvider: answeringProvider,
    }
  );
  const answeringModels: Record<"anthropic" | "openai", string | null> = {
    anthropic: modelOf("anthropic"),
    openai: modelOf("openai"),
  };
  const localConfigured = !!localBaseUrl;
  const scannedRepos = Array.from(
    new Set(freshness.map((c) => c.full_name).filter((n): n is string => !!n))
  );

  // Prefill the Member onboarding panel from each tool's current (non-secret) config.
  const cfgOf = (type: "linear" | "slack" | "github") =>
    (integrations.find((i) => i.type === type)?.config ?? {}) as Record<string, unknown>;
  const linearCfg = cfgOf("linear");
  const onboardingValues = {
    linearTeamIds: Array.isArray(linearCfg.inviteTeamIds)
      ? (linearCfg.inviteTeamIds as string[]).join(", ")
      : "",
    linearRole: typeof linearCfg.inviteRole === "string" ? linearCfg.inviteRole : "",
    slackInviteLink: typeof cfgOf("slack").inviteLink === "string" ? (cfgOf("slack").inviteLink as string) : "",
    githubOrg: typeof cfgOf("github").org === "string" ? (cfgOf("github").org as string) : "",
  };

  return (
    <div className="flex flex-col gap-4">
      <PipelineHealthBanner health={pipelineHealth} href={`/t/${teamSlug}/admin/integrations`} />
      <div>
        <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Connect sources for the ingestion sidecar (Slack, GitHub, Notion, …). The selection
          (channels/repos) and an encrypted secret are stored here; the sidecar fetches enabled
          integrations to run ingestion. Secrets are stored encrypted and never shown again.
        </p>
      </div>
      <RetrievalHealthCard health={retrievalHealth} />
      <GithubReposPanel
        teamSlug={teamSlug}
        integration={githubIntegration}
        scannedRepos={scannedRepos}
      />
      <OpenrouterPanel
        teamSlug={teamSlug}
        connected={!!openrouter?.hasSecret}
        model={(openrouter?.config.model as string | undefined) ?? null}
      />
      <IntegrationsManager
        teamSlug={teamSlug}
        integrations={integrations}
        primaryPmProvider={(team.primary_pm_provider as "plane" | "linear" | null) ?? null}
        answering={{
          provider: answeringProvider,
          models: answeringModels,
          effective: { provider: answering.provider, model: answering.model },
          usedFallback: answering.usedFallback,
          localConfigured,
          openrouterConfigured: hasKey("openrouter"),
          openaiConfigured: hasKey("openai"),
          reasoningModel: (team.reasoning_model as string | null) ?? null,
        }}
      />
      <MemberOnboardingPanel teamSlug={teamSlug} values={onboardingValues} />
      <div>
        <h2 className="text-sm font-semibold text-ink">Recent ingestion runs</h2>
        <p className="mb-2 mt-1 text-xs text-ink-secondary">
          Every scheduler tick, manual <code>/sync</code>, and codebase scan and its outcome — so a
          failed or stale import is diagnosable here instead of only in server logs.
        </p>
        <IngestRunsPanel runs={ingestRuns} />
      </div>
    </div>
  );
}
