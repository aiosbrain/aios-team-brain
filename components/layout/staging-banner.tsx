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
 * WHAT IT DELIBERATELY DOES NOT CLAIM. An earlier draft added "production is never written from here".
 * That is a property of `DATABASE_URL`, and this key knows only the ENVIRONMENT NAME. Point staging's
 * `DATABASE_URL` at production — the exact careless `railway variables --set` this design cites — and
 * the banner would have been affirming a safety property above every write that reached production.
 * The repo's real discriminator for that is the `staging_marker` table; cross-checking it is follow-on
 * work (STGENV-3/4), and until then this claims only what it can prove.
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
      // `--staging-banner-h` lets sticky descendants offset by exactly this band. Without it the
      // team sidebar (`app/t/[team]/layout.tsx`, `sticky top-0 h-dvh`) sits UNDER the banner at
      // z-50: its "Sign out" footer falls below the fold on every staging page, and once scrolled
      // the banner covers the sidebar header instead. Fable measured that.
      style={{ ["--staging-banner-h" as string]: "2rem" }}
      className="sticky top-0 z-50 flex h-8 items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 text-center text-xs font-medium text-amber-900 dark:text-amber-200 [&~*_[data-staging-offset]]:top-[var(--staging-banner-h)]"
    >
      <span aria-hidden="true">⚠️</span>
      <span>
        <strong className="font-semibold">STAGING</strong> — this environment serves a copy of
        production data.
      </span>
    </div>
  );
}
