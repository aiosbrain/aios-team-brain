import { serverClient } from "@/lib/db/server";
import { listOpportunities } from "@/lib/social/store";
import { listTeamMediaMeta } from "@/lib/media/store";
import { imageBudget } from "@/lib/media/generate-image";
import { getAutonomy, getPublishDryRun } from "@/lib/social/settings";
import { listPendingApprovals } from "@/lib/social/approvals";
import { listPublications } from "@/lib/social/publications";
import { typefullyStatus } from "@/lib/integrations/typefully";
import { SocialOpportunitiesPanel, type VariantView, type PendingApprovalView, type PublicationView } from "@/components/admin/social-opportunities-panel";

export default async function SocialAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // Admin view — the whole /admin area is admin-gated, so it sees all tiers (team).
  const opportunities = await listOpportunities(db, team.id, "team", 100);

  // Variants grouped by opportunity (plan is the join). Reads only; admin-gated area.
  const { data: plans } = await db.from("content_plans").select("id, opportunity_id").eq("team_id", team.id);
  const planToOpp = new Map((plans ?? []).map((p: { id: string; opportunity_id: string }) => [p.id, p.opportunity_id]));
  const { data: variants } = await db
    .from("content_variants")
    .select("id, plan_id, platform, status, body, validation")
    .eq("team_id", team.id)
    .order("created_at", { ascending: true });

  const byOpportunity: Record<string, VariantView[]> = {};
  for (const v of (variants ?? []) as (VariantView & { plan_id: string })[]) {
    const oppId = planToOpp.get(v.plan_id);
    if (oppId) (byOpportunity[oppId] ??= []).push(v);
  }

  // Generated images grouped by variant (ids only — bytes are served by the media route).
  const media = await listTeamMediaMeta(db, team.id, 200);
  const mediaByVariant: Record<string, string[]> = {};
  for (const m of media) (mediaByVariant[m.variant_id] ??= []).push(m.id);
  const budget = await imageBudget(db, team.id);

  // Approval workflow (M4): autonomy + the pending queue, with per-variant context for display.
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

  // Publishing (M5): Typefully connection, dry-run flag, and the publication ledger per variant.
  const [tf, publishDryRun, pubs] = await Promise.all([
    typefullyStatus(db, team.id),
    getPublishDryRun(db, team.id),
    listPublications(db, team.id, 200),
  ]);
  const publicationsByVariant: Record<string, PublicationView[]> = {};
  for (const p of pubs) {
    (publicationsByVariant[p.variant_id] ??= []).push({ status: p.status, url: p.external_url, dryRun: p.dry_run });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        The <strong>Social Brain</strong> turns your team’s knowledge into content. <em>Discover</em>
        ranks recent decisions, deliverables, and commits; <em>Plan</em> shapes brand-aware variants;
        <em>Generate</em> drafts each in your voice, grounded only in the source evidence and checked
        against your governance rules. Each opportunity inherits the tier of its source, so
        internal-only knowledge can never surface in a public post.
      </p>
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
