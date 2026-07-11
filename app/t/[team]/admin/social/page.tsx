import { serverClient } from "@/lib/db/server";
import { listOpportunities, listVariantsByOpportunity, listImageIdsByVariant } from "@/lib/social/store";
import { getImageDailyCap } from "@/lib/social/settings";
import { SocialOpportunitiesPanel } from "@/components/admin/social-opportunities-panel";
import type { VariantRow } from "@/lib/social/types";

export default async function SocialAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // Admin view — the whole /admin area is admin-gated, so it sees all tiers (team).
  const opportunities = await listOpportunities(db, team.id, "team", 100);
  const variantsByOpp = await listVariantsByOpportunity(
    db,
    team.id,
    opportunities.map((o) => o.id),
    "team"
  );
  const allVariantIds = [...variantsByOpp.values()].flat().map((v) => v.id);
  const imageByVariant = Object.fromEntries(await listImageIdsByVariant(db, team.id, allVariantIds, "team"));
  const imageCap = await getImageDailyCap(db, team.id);
  // Maps don't serialize across the server→client boundary — hand the client a plain object.
  const drafts: Record<string, VariantRow[]> = Object.fromEntries(variantsByOpp);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        The <strong>Social Brain</strong> turns your team’s knowledge into content opportunities —
        from recent decisions/deliverables and from your narrative arcs. Each opportunity inherits the
        tier of its source, so internal-only knowledge can never be surfaced for a public post.
        <strong> Generate</strong> drafts an X + LinkedIn post in your brand voice with an image;
        nothing publishes — copy the draft where you want it.
      </p>
      <SocialOpportunitiesPanel
        teamSlug={teamSlug}
        opportunities={opportunities}
        drafts={drafts}
        imageByVariant={imageByVariant}
        imageCap={imageCap}
      />
    </div>
  );
}
