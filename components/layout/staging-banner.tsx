import { isStagingDeployment } from "@/lib/env/deployment";

/**
 * STGENV-1 — the "this is not production" band.
 *
 * WHY IT SAYS WHAT IT SAYS. Staging runs a COPY of production's data (`scripts/staging-refresh.sh`),
 * so every name, meeting and decision on screen is real. That is the whole hazard: the thing that makes
 * staging useful is exactly what makes it easy to mistake for production. So the banner names the
 * environment AND the reason it looks convincing, rather than a bare "staging" chip that reads as
 * decoration after a day.
 *
 * Server component: `isStagingDeployment` reads a server-only variable and this never ships to the
 * client bundle. Renders nothing at all off staging — see the module header for why that asymmetry is
 * the right way round.
 */
export function StagingBanner() {
  if (!isStagingDeployment()) return null;
  return (
    <div
      role="status"
      aria-label="Staging environment"
      data-testid="staging-banner"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:text-amber-200"
    >
      <span aria-hidden="true">⚠️</span>
      <span>
        <strong className="font-semibold">STAGING</strong> — a copy of production data. Changes here do
        not reach production, and production is never written from here.
      </span>
    </div>
  );
}
