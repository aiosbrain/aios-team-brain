import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { listOpportunities } from "@/lib/social/store";
import { listTeamMediaMeta } from "@/lib/media/store";
import { imageBudget } from "@/lib/media/generate-image";
import { getAutonomy, getPublishDryRun } from "@/lib/social/settings";
import { getSocialJobsHealth } from "@/lib/jobs/store";
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

  // Operator surface — spends money + posts publicly, so admin-only (matches the nav gate). Admin AND
  // team-tier: an external-tier admin must not reach it (no RLS backstop, CLAUDE.md §5).
  const me = await currentMember(team.id);
  if (!me || !canAccessAdmin(me)) {
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

  // Every read below is independent — all the derived structures are pure JS post-processing done
  // after the awaits — so fire them concurrently instead of in a ~13-deep request waterfall (each
  // round-trip to Railway Postgres has real latency; serial they stacked into most of the render).
  // ENFB-4: the viewer's ORACLE set — the ONE social read rule (EVERY-visible evidence) and
  // every downstream chain hang off it. A resolution error is the error boundary, never an
  // unfiltered render (the ENFB-2 L8 shape).
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const { adminClient: ac } = await import("@/lib/db/admin");
  const vis = await visibleItemIds(ac(), { teamId: team.id, memberId: me.id });
  if (vis.error) throw new Error("social visibility resolution failed");

  const [
    opportunities,
    budget,
    jobsHealth,
    autonomy,
    tf,
    publishDryRun,
    analyticsRows,
    analytics,
  ] = await Promise.all([
    listOpportunities(db, team.id, "team", 100, vis.ids),
    imageBudget(db, team.id),
    getSocialJobsHealth(db, team.id),
    getAutonomy(db, team.id),
    typefullyStatus(db, team.id),
    getPublishDryRun(db, team.id),
    listTeamAnalytics(db, team.id, 500),
    teamAnalyticsSummary(db, team.id),
  ]);

  // ENFB-4 inheritance: plan → variant → approval/publication/media all descend from the
  // VISIBLE opportunity set (parent-id chains through the store — the one seam). The three
  // variant-child reads are bounded IN-QUERY by the visible-variant set (Codex diff fold: a
  // post-limit filter let newer hidden rows starve visible history out of the capped window).
  const { listPlansForOpportunities, listVariantsForPlans } = await import("@/lib/social/store");
  const visibleOppIds = new Set(opportunities.map((o) => o.id));
  const plans = await listPlansForOpportunities(db, team.id, visibleOppIds);
  const variants = await listVariantsForPlans(db, team.id, new Set(plans.map((p) => p.id)));
  const visibleVariantIds = new Set(variants.map((v) => v.id));
  const [media, pendingRows, pubs] = await Promise.all([
    listTeamMediaMeta(db, team.id, 200, visibleVariantIds),
    listPendingApprovals(db, team.id, 50, visibleVariantIds),
    listPublications(db, team.id, 200, visibleVariantIds),
  ]);
  const planToOpp = new Map((plans ?? []).map((p: { id: string; opportunity_id: string }) => [p.id, p.opportunity_id]));

  const byOpportunity: Record<string, VariantView[]> = {};
  const allVariants = (variants ?? []) as (VariantView & { plan_id: string })[];
  for (const v of allVariants) {
    const oppId = planToOpp.get(v.plan_id);
    if (oppId) (byOpportunity[oppId] ??= []).push(v);
  }

  // The reads above are already chain-bounded in-query; these groupings only shape the views.
  const mediaByVariant: Record<string, string[]> = {};
  for (const m of media) (mediaByVariant[m.variant_id] ??= []).push(m.id);

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

  // ENFB-4: `pubs` is already the chain-visible set (bounded in-query above), so lists and the
  // KPI count the same rows by construction.
  const publishedCount = pubs.filter((p) => p.status === "published").length;

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

      {jobsHealth.dead > 0 ? (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          <strong>
            {jobsHealth.dead} background job{jobsHealth.dead === 1 ? "" : "s"} failed permanently
          </strong>{" "}
          (dead-lettered after retries) — image generation, publishing, or analytics may not be
          running.
          {jobsHealth.lastDeadError ? ` Most recent error: ${jobsHealth.lastDeadError}` : ""}
        </p>
      ) : null}

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
