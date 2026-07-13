import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { listOpportunities } from "@/lib/social/store";
import { listTeamMediaMeta } from "@/lib/media/store";
import { imageBudget } from "@/lib/media/generate-image";
import { getAutonomy, getPublishDryRun } from "@/lib/social/settings";
import { listPendingApprovals } from "@/lib/social/approvals";
import { listPublications } from "@/lib/social/publications";
import { listTeamAnalytics, teamAnalyticsSummary } from "@/lib/social/analytics";
import { typefullyStatus } from "@/lib/integrations/typefully";
import { SocialOpportunitiesPanel, type VariantView, type PendingApprovalView, type PublicationView } from "@/components/admin/social-opportunities-panel";

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="prism-card flex flex-col gap-0.5 px-4 py-3">
      <span className="text-2xl font-semibold text-ink">{value}</span>
      <span className="text-xs text-ink-tertiary">{label}</span>
    </div>
  );
}

export default async function SocialPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // Operator surface — spends money + posts publicly, so admin-only (matches the nav gate).
  const me = await currentMember(team.id);
  if (!me || me.role !== "admin") {
    return (
      <div className="prism-card flex max-w-lg flex-col items-start gap-2 p-6">
        <CircleAlert className="size-6 text-violet" strokeWidth={1.5} />
        <h1 className="text-lg font-semibold text-ink">Social Brain is admin-only</h1>
        <p className="text-sm text-ink-secondary">
          Discovering, generating, and publishing content is restricted to team admins. Ask an admin
          if you need access.
        </p>
      </div>
    );
  }

  const opportunities = await listOpportunities(db, team.id, "team", 100);

  const { data: plans } = await db.from("content_plans").select("id, opportunity_id").eq("team_id", team.id);
  const planToOpp = new Map((plans ?? []).map((p: { id: string; opportunity_id: string }) => [p.id, p.opportunity_id]));
  const { data: variants } = await db
    .from("content_variants")
    .select("id, plan_id, platform, status, body, validation")
    .eq("team_id", team.id)
    .order("created_at", { ascending: true });

  const byOpportunity: Record<string, VariantView[]> = {};
  const allVariants = (variants ?? []) as (VariantView & { plan_id: string })[];
  for (const v of allVariants) {
    const oppId = planToOpp.get(v.plan_id);
    if (oppId) (byOpportunity[oppId] ??= []).push(v);
  }

  const media = await listTeamMediaMeta(db, team.id, 200);
  const mediaByVariant: Record<string, string[]> = {};
  for (const m of media) (mediaByVariant[m.variant_id] ??= []).push(m.id);
  const budget = await imageBudget(db, team.id);

  const autonomy = await getAutonomy(db, team.id);
  const pendingRows = await listPendingApprovals(db, team.id);
  const variantCtx: Record<string, { platform: string; body: string; oppTitle: string }> = {};
  for (const [oppId, vs] of Object.entries(byOpportunity)) {
    const oppTitle = opportunities.find((o) => o.id === oppId)?.title ?? "";
    for (const v of vs) variantCtx[v.id] = { platform: v.platform, body: v.body, oppTitle };
  }
  const pendingApprovals: PendingApprovalView[] = pendingRows.map((a) => ({
    id: a.id,
    variantId: a.variant_id,
    access: a.access,
    platform: variantCtx[a.variant_id]?.platform ?? "",
    body: variantCtx[a.variant_id]?.body ?? "",
    oppTitle: variantCtx[a.variant_id]?.oppTitle ?? "",
  }));

  const [tf, publishDryRun, pubs] = await Promise.all([
    typefullyStatus(db, team.id),
    getPublishDryRun(db, team.id),
    listPublications(db, team.id, 200),
  ]);
  const analyticsRows = await listTeamAnalytics(db, team.id, 500);
  const analyticsByPublication = new Map(analyticsRows.map((a) => [a.publication_id, a]));
  const publicationsByVariant: Record<string, PublicationView[]> = {};
  for (const p of pubs) {
    const a = analyticsByPublication.get(p.id);
    (publicationsByVariant[p.variant_id] ??= []).push({
      id: p.id,
      status: p.status,
      url: p.external_url,
      dryRun: p.dry_run,
      metrics: a
        ? { impressions: a.impressions, likes: a.likes, comments: a.comments, shares: a.shares }
        : null,
    });
  }

  const publishedCount = pubs.filter((p) => p.status === "published").length;
  const analytics = await teamAnalyticsSummary(db, team.id);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">Social Brain</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
            Turn your team’s knowledge into content: <em>Discover</em> → <em>Plan</em> →{" "}
            <em>Generate</em> → <em>Approve</em> → <em>Publish</em>. Every draft is grounded only in
            its source evidence and checked against your brand governance, and each opportunity
            inherits its source’s tier — internal knowledge never surfaces in a public post.
          </p>
        </div>
        <Link href={`/t/${teamSlug}/admin/brand`} className="btn-ghost shrink-0">
          Brand settings
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Kpi label="Opportunities" value={opportunities.length} />
        <Kpi label="Drafts" value={allVariants.filter((v) => v.status === "generated" || v.body).length} />
        <Kpi label="Pending approvals" value={pendingApprovals.length} />
        <Kpi label="Published" value={publishedCount} />
        <Kpi label="Impressions" value={analytics.impressions.toLocaleString()} />
      </div>

      <SocialOpportunitiesPanel
        teamSlug={teamSlug}
        opportunities={opportunities}
        variantsByOpportunity={byOpportunity}
        mediaByVariant={mediaByVariant}
        imagesRemaining={budget.remaining}
        imageCap={budget.cap}
        autonomy={autonomy}
        pendingApprovals={pendingApprovals}
        typefullyConnected={tf.connected}
        typefullySocialSetId={tf.socialSetId}
        publishDryRun={publishDryRun}
        publicationsByVariant={publicationsByVariant}
      />
    </div>
  );
}
