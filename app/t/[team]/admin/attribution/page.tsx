import { requireTeamAdmin } from "@/lib/auth/guard";
import { getAttributionHealth } from "@/lib/attribution/health";
import { AttributionHealthView } from "@/components/admin/attribution-health-view";
import { AttributionCorrectionBox } from "@/components/admin/attribution-correction-box";

/**
 * Admin → Attribution. Per-source + per-person attribution health (who each data stream lands on), so
 * misattribution is visible and troubleshootable. `lib/attribution/health` spans ALL access tiers and
 * there is no RLS backstop (CLAUDE §5), so this page enforces admin ITSELF via `requireTeamAdmin`
 * (a Next layout's conditional UI does not stop a child page's server component from running) — that
 * also scopes `teamId` to the caller's own admin membership rather than resolving any team by slug.
 * A build guard (`test/guards/attribution-health-admin-only`) additionally forbids reading the health
 * lib from any non-admin surface.
 */
export default async function AttributionAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return null; // not an admin — the admin layout renders the "Admins only" card

  const health = await getAttributionHealth(ctx.teamId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">Attribution health</h2>
        <p className="text-sm text-ink-secondary">Is each data stream landing on the right person?</p>
      </div>
      <AttributionCorrectionBox teamSlug={teamSlug} />
      <AttributionHealthView health={health} />
    </div>
  );
}
