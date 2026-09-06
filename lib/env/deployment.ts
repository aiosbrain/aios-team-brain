/**
 * STGENV-1 — which deployment am I? Server-side only.
 *
 * WHY A PLATFORM VARIABLE AND NOT ONE OF OURS. Railway injects `RAILWAY_ENVIRONMENT_NAME` into every
 * deploy, and application code cannot forge it — it is the same trust basis `scripts/service-guard.mjs`
 * already relies on for `RAILWAY_PROJECT_ID` / `RAILWAY_SERVICE_NAME` when it refuses a schema load on
 * a service that is not AIOS's. A banner keyed on a variable we set ourselves would be one careless
 * `railway variables --set` away from lying in the direction that matters (production silently claiming
 * to be staging, or worse, staging claiming to be production).
 *
 * WHY NOT `NEXT_PUBLIC_*`. The only consumer is a SERVER component (`app/layout.tsx`), so the value
 * never needs to reach the client bundle. Exposing it would add a second, client-side copy that can
 * drift from the server's answer, for no benefit.
 *
 * THE DEFAULT IS "NOT STAGING", DELIBERATELY. Off Railway — local dev, `npm test`, CI — the variable is
 * unset, and an unset variable must not paint a staging banner across every developer's screen. But note
 * the asymmetry this creates and why it is the right way round: a staging deploy that somehow loses the
 * variable shows NO banner, which is a real failure mode (see `isStagingDeployment`'s guard test). It is
 * still preferable to the inverse, because a banner that cries wolf on localhost is a banner people
 * learn to ignore — and then it is worth nothing on the day it matters.
 */

/** The platform's name for this deployment's environment, or null off-platform. */
export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? null;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Is this the staging deployment?
 *
 * Compared case-insensitively against the exact name, not a prefix or a substring: `staging` matches,
 * `Staging` matches, and `staging-2`/`prestaging` do NOT. A substring test would make a future
 * environment called `staging-experiments` inherit the banner silently, and — the direction that
 * actually bites — nothing named like production could ever be mistaken for it either way round.
 */
export function isStagingDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return deploymentEnvironment(env)?.toLowerCase() === "staging";
}
