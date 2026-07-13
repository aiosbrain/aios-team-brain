import { serverClient } from "@/lib/db/server";
import { getBrandProfile } from "@/lib/brand/manage";
import { listBrandAssets } from "@/lib/brand/assets";
import { BrandManager } from "@/components/admin/brand-manager";
import { BrandAssetsPanel } from "@/components/admin/brand-assets-panel";
import type { BrandProfileInput } from "@/lib/brand/schema";

export default async function BrandAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const [record, assets] = await Promise.all([getBrandProfile(db, team.id), listBrandAssets(db, team.id)]);
  const profile: BrandProfileInput | null = record
    ? { voice: record.voice, knowledge: record.knowledge, governance: record.governance }
    : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        The <strong>Brand Brain</strong>: your team&apos;s voice, company knowledge, and governance rules.
        The Social Brain generates content in this voice and validates every draft against these guardrails
        before it can be approved or published. Everything here is optional — fill in what matters.
      </p>
      <BrandManager teamSlug={teamSlug} profile={profile} />
      <BrandAssetsPanel teamSlug={teamSlug} assets={assets} />
    </div>
  );
}
