/**
 * railway-policy.mjs — the one definition of which Railway CLI verbs this repo may run.
 *
 * Two audiences, one policy:
 *   - `scripts/railway-deploy-guard.sh` enforces it at the tool layer in Claude Code.
 *   - `scripts/setup.mjs` restrains itself with it, so provisioning cannot drift into deploying.
 * `test/railway-policy.test.ts` executes the real guard against this table so the two can
 * never disagree.
 *
 * THE DISTINCTION THAT MAKES PROVISIONING SAFE
 *
 * The 2026-06-27 Kula incident was not really about `up` — it was about the *link*. The Railway
 * CLI resolves the target project from `~/.railway/config.json`, keyed by absolute path, so any
 * write verb run from a drifted directory hits someone else's project. `railway variables --set`
 * against a drifted link would overwrite another project's production environment just as surely
 * as `railway up` overwrote its code.
 *
 * So provisioning verbs are conditionally allowed, never unconditionally:
 *
 *   FORBIDDEN     up · redeploy · down · delete — always, everywhere, no framing.
 *                 Deploys reach production ONLY through Railway's GitHub integration, which is
 *                 bound to the right project in the dashboard and cannot target another.
 *   PROVISIONING  init · add · variables · domain · link · run — allowed only while standing up a
 *                 BRAND-NEW project, and only against a target that has been pinned and verified
 *                 (see `assertPinnedTarget`). Never against an existing instance.
 *   READ-ONLY     status · logs · whoami · list · deployment · connect · open — always fine.
 *
 * Note what is deliberately absent: there is no verb here that deploys. A new project's first
 * release comes from pushing to `main`, exactly like every release after it — one deploy path
 * for the life of the instance.
 */

/** Never, under any framing. The four verbs that caused or could repeat the Kula incident. */
export const FORBIDDEN_VERBS = Object.freeze(["up", "redeploy", "down", "delete"]);

/** Writes. Legal only against a freshly created, pinned project — see assertPinnedTarget. */
export const PROVISIONING_VERBS = Object.freeze(["init", "add", "variables", "domain", "link", "run"]);

/** Reads. Always safe: they cannot mutate another project. */
export const READONLY_VERBS = Object.freeze(["status", "logs", "whoami", "list", "deployment", "connect", "open"]);

/**
 * Matches a real `railway <verb>` INVOCATION — at a command boundary (line start, or after
 * whitespace/`;`/`|`/`&`/`(`, so `cd elsewhere && railway up` is caught). Prose that merely
 * mentions a verb is not at a boundary, so documenting these commands is never blocked. This
 * mirrors the regex in railway-deploy-guard.sh; the test asserts they agree.
 */
const INVOCATION = /(^|[\s;|&(])railway\s+([a-z-]+)/g;

/**
 * Classify a proposed shell command.
 * @returns {{decision: "allow"|"block", verb: string|null, reason: string}}
 */
export function classifyRailwayCommand(command) {
  const text = String(command ?? "");
  const verbs = [...text.matchAll(INVOCATION)].map((m) => m[2]);

  if (verbs.length === 0) return { decision: "allow", verb: null, reason: "not a railway invocation" };

  const forbidden = verbs.find((v) => FORBIDDEN_VERBS.includes(v));
  if (forbidden) {
    return {
      decision: "block",
      verb: forbidden,
      reason: `\`railway ${forbidden}\` is permanently forbidden — production deploys go through the GitHub integration (Kula, 2026-06-27)`,
    };
  }

  const provisioning = verbs.find((v) => PROVISIONING_VERBS.includes(v));
  if (provisioning) {
    return {
      decision: "allow",
      verb: provisioning,
      reason: `\`railway ${provisioning}\` is a provisioning verb — legal only against a pinned, brand-new project`,
    };
  }

  return { decision: "allow", verb: verbs[0], reason: "read-only" };
}

/**
 * Service/project naming, mirroring scripts/service-guard.mjs: the runtime guard aborts the
 * schema load when RAILWAY_SERVICE_NAME isn't one of AIOS's, so a name chosen here that the
 * guard would later reject produces a project that can never deploy. Enforced at creation
 * instead of discovered at first deploy.
 */
export function isSanctionedProjectName(name) {
  return /^aios(-[a-z0-9-]+)?$/.test(String(name ?? ""));
}

/** Normalize a user-supplied team slug into a sanctioned project name. */
export function toProjectName(slug) {
  const clean = String(slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean) return null;
  return clean === "aios" || clean.startsWith("aios-") ? clean : `aios-${clean}`;
}

/**
 * The pin check. Every write must be preceded by proof that the CLI is pointed where we think.
 * `status` is whatever `railway status --json` reported; `expected` is the project we created.
 * Throws rather than returning false — a caller that forgets to check a boolean is the exact
 * failure mode this exists to prevent.
 */
export function assertPinnedTarget(status, expected) {
  const actual = status?.name ?? status?.project?.name ?? null;
  if (!actual) {
    throw new Error("railway status reported no project — refusing to run a write verb against an unknown target");
  }
  if (actual !== expected) {
    throw new Error(
      `railway is linked to "${actual}" but this run provisions "${expected}" — refusing to write. ` +
        `This is the link drift that took Kula down; re-run from a clean directory.`
    );
  }
  if (!isSanctionedProjectName(actual)) {
    throw new Error(`project "${actual}" is not an AIOS project name — scripts/service-guard.mjs would abort its schema load`);
  }
  return true;
}
