#!/usr/bin/env node
/**
 * setup.mjs — provision a NEW AIOS Team Brain on Railway, end to end.
 *
 * Collapses README §2.1–§2.4 (create services → set variables → deploy → create team + admin)
 * into one resumable command. It is the deterministic half of the `/setup-brain` skill: the
 * script does the work, the agent drives it and reads the failures.
 *
 * WHAT IT WILL NOT DO — and why that is the point
 *
 * It never deploys. `railway up`/`redeploy`/`down`/`delete` are refused by
 * `scripts/railway-policy.mjs`, which every command here is classified against before it runs
 * (see `railway()`), so the restraint is executable rather than a promise in a comment. The
 * first release comes from pushing to `main` through Railway's GitHub integration — the same
 * path as every release after it, bound in the dashboard and unable to target another project.
 *
 * Provisioning verbs (`init`/`add`/`variables`/`domain`/`run`) DO write, so each is gated on
 * `assertPinnedTarget`: proof from `railway status --json` that the CLI is pointed at the
 * project this run created. The Kula incident was link drift, and a drifted `variables --set`
 * would clobber another project's environment just as effectively as a drifted `up`.
 *
 * Resumable and idempotent. Connecting the GitHub repo is a dashboard OAuth step no CLI can do,
 * so the run stops there, tells you exactly what to click, and picks up where it left off.
 *
 * Idempotent INCLUDES the secrets: a re-run reads the project's environment and preserves an
 * existing AUTH_SECRET / SECRETS_KEY rather than generating fresh ones (see `resolveSecrets`).
 * Rotating them would log the whole team out and make every encrypted connector token
 * undecryptable, so if the environment can't be read, the run aborts instead of guessing.
 *
 *   node scripts/setup.mjs --slug acme --name "Acme Robotics" --email you@acme.com
 *   node scripts/setup.mjs --dry-run     # print the plan, touch nothing
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  READONLY_VERBS,
  assertPinnedTarget,
  classifyRailwayCommand,
  isSanctionedProjectName,
  toProjectName,
} from "./railway-policy.mjs";

// ── pure helpers (exported for tests) ───────────────────────────────────────

/**
 * The variables a brain cannot boot without, plus the ones whose absence fails silently later.
 * DATABASE_URL uses Railway's reference syntax so the value tracks the Postgres service rather
 * than being copied (a copied URL goes stale the moment credentials rotate).
 */
export function buildVariables({ appUrl, authSecret, secretsKey, anthropicKey, openaiKey, openrouterKey, llmBaseUrl, resendKey, resendFrom }) {
  const vars = {
    DATABASE_URL: "${{Postgres.DATABASE_URL}}",
    // Managed Postgres rejects plaintext; omitting this is the top first-deploy failure.
    PGSSL: "require",
    AUTH_SECRET: authSecret,
    SECRETS_KEY: secretsKey,
    // Invite and magic links are built in server actions, where there is no request origin to
    // fall back on — an unset APP_URL mails every teammate a broken link.
    APP_URL: appUrl,
  };
  if (anthropicKey) vars.ANTHROPIC_API_KEY = anthropicKey;
  // The wizard lets the user pick any provider. Carrying only Anthropic here meant a pasted
  // OpenAI/OpenRouter key was validated and then silently dropped, producing an instance with no
  // answering model that still reported success.
  if (openaiKey) vars.OPENAI_API_KEY = openaiKey;
  if (openrouterKey) vars.OPENROUTER_API_KEY = openrouterKey;
  if (llmBaseUrl) vars.LLM_BASE_URL = llmBaseUrl;
  if (resendKey) vars.RESEND_API_KEY = resendKey;
  if (resendFrom) vars.RESEND_FROM = resendFrom;
  return vars;
}

/** `railway variables` takes repeated `--set K=V`. */
export function toVariableArgs(vars) {
  return Object.entries(vars).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
}

export function generateSecrets() {
  return {
    authSecret: randomBytes(32).toString("hex"),
    // Exactly 32 bytes — AES-256-GCM. Any other width and connector saves 500 (README §5).
    secretsKey: randomBytes(32).toString("base64"),
  };
}

/**
 * Keep the secrets an instance already has; generate only what is missing.
 *
 * Regenerating these is destructive, not merely wasteful: AUTH_SECRET invalidates every
 * session, and SECRETS_KEY is the AES-256-GCM key connector tokens are encrypted at rest
 * with — rotate it and every stored Slack/GitHub/Linear token becomes undecryptable. This
 * script advertises itself as resumable and the skill tells you to re-run after fixing a
 * failure, so a second run reaches this code on a live instance by design. `compose.yml`
 * already persists both generated secrets for exactly this reason.
 *
 * A malformed existing value is preserved, not repaired: replacing a wrong-width SECRETS_KEY
 * would "fix" the width by destroying the data it protects. The caller warns instead.
 */
export function resolveSecrets(existing, generated) {
  const kept = (v) => (typeof v === "string" && v.trim().length > 0 ? v : null);
  const authSecret = kept(existing?.AUTH_SECRET);
  const secretsKey = kept(existing?.SECRETS_KEY);
  return {
    authSecret: authSecret ?? generated.authSecret,
    secretsKey: secretsKey ?? generated.secretsKey,
    reused: [authSecret && "AUTH_SECRET", secretsKey && "SECRETS_KEY"].filter(Boolean),
  };
}

/** null when fine, else the reason — a base64 SECRETS_KEY that isn't exactly 32 bytes. */
export function secretsKeyComplaint(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  // No try/catch: `Buffer.from(junk, "base64")` never throws, it yields a short buffer — so
  // garbage reports "decodes to 0 bytes", which is the actionable message anyway.
  const width = Buffer.from(value, "base64").length;
  if (width === 32) return null;
  return `SECRETS_KEY decodes to ${width} bytes, not 32 — connector saves will fail (\`npm run doctor\` explains the fix)`;
}

/**
 * Does this invocation only read? `variables` is a provisioning (write) verb in the policy, but
 * `variables --json` with no `--set` is a read — the one verb whose direction depends on flags.
 */
export function isReadOnly(args) {
  const verb = args[0];
  if (verb === "variables") return !args.includes("--set") && !args.includes("--set-from-stdin");
  return READONLY_VERBS.includes(verb);
}

/** The environment read must be a JSON OBJECT. `[]` and `"ok"` are truthy and parse fine, and
 * treating either as "no secrets present" would fall through to generating fresh ones — the
 * precise failure the abort exists to prevent. */
export function isEnvironmentMap(parsed) {
  return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
}

/**
 * Render a command for the dry-run plan with secret VALUES masked.
 *
 * The plan is printed to a terminal and read by agents, and each line is a paste-ready
 * `railway variables --set …`. Echoing a real AUTH_SECRET/SECRETS_KEY there hands someone a
 * copyable command that performs exactly the rotation this script now prevents.
 */
export const PLAN_REDACTED_KEYS = Object.freeze([
  "AUTH_SECRET",
  "SECRETS_KEY",
  // Provider keys belong here for the same reason, and are the ones a widening is likely to miss:
  // they arrived later than the two above, and a redactor that only knows the original pair leaks
  // every key added after it.
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "RESEND_API_KEY",
]);

export function redactSecretsForPlan(rendered) {
  const keys = PLAN_REDACTED_KEYS.join("|");
  return String(rendered).replace(
    new RegExp(`(--set (?:${keys})=)\\S+`, "g"),
    (_m, prefix) => `${prefix}<redacted>`
  );
}

/** Where a run should resume from, given what already exists. */
export function nextPhase(state) {
  if (!state.projectExists) return "create";
  if (!state.databaseExists) return "database";
  if (!state.variablesSet) return "variables";
  if (!state.domainSet) return "domain";
  if (!state.deployed) return "await-deploy";
  if (!state.teamExists) return "team";
  return "done";
}

// ── io ──────────────────────────────────────────────────────────────────────

function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Every Railway invocation funnels through here so the policy is applied to what we ACTUALLY
 * run, not to what a comment claims we run. A forbidden verb throws before reaching the CLI.
 */
export function makeRailway(io, { dryRun = false } = {}) {
  // `verify` pin-checks a READ. Reading the environment back is not a mutation, but its result
  // is written straight back out — so a read from a drifted link would copy another project's
  // secrets into this one. Same proof, same reason.
  return function railway(args, { write = false, verify = false, pin = null, status = null } = {}) {
    const rendered = `railway ${args.join(" ")}`;
    const verdict = classifyRailwayCommand(rendered);
    if (verdict.decision === "block") {
      throw new Error(`setup.mjs refused its own command: ${verdict.reason}`);
    }
    if (write || verify) {
      if (!pin) throw new Error(`internal: \`${rendered}\` attempted with no pinned target`);
      assertPinnedTarget(status, pin); // throws on drift
    }
    // `--dry-run` suppresses WRITES, not reads. Faking the reads too made the plan blind: it
    // could not see whether the project already existed (so it showed a secret rotation a real
    // run would not perform), and it could not detect the link drift that a real run aborts on.
    // A read mutates nothing, so running it for real is what makes the plan predictive.
    if (dryRun && !isReadOnly(args)) {
      io.log(`  [dry-run] ${redactSecretsForPlan(rendered)}`);
      return { status: 0, stdout: "", stderr: "" };
    }
    return io.exec("railway", args);
  };
}

// ── runner ──────────────────────────────────────────────────────────────────

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function runSetup(opts, io = { exec: defaultExec, log: console.log }) {
  // displayName / memberName belong to finishSetup — the team and member are created there.
  const { slug, email, anthropicKey, openaiKey, openrouterKey, llmBaseUrl, resendKey, resendFrom, dryRun } = opts;

  const project = toProjectName(slug);
  if (!project || !isSanctionedProjectName(project)) {
    throw new Error(`"${slug}" does not yield a valid AIOS project name (expected aios or aios-<something>)`);
  }

  const railway = makeRailway(io, { dryRun });

  // 1. Preflight — the CLI must exist and be authenticated. `railway login` is a browser flow
  //    we cannot and should not automate.
  const who = railway(["whoami"]);
  if (who.status !== 0) {
    throw new Error("railway CLI not authenticated — run `railway login` (opens a browser), then re-run");
  }
  io.log(`✓ railway: ${who.stdout.trim() || "authenticated"}`);

  // 2. Refuse to provision from a directory already linked somewhere. This is the drift
  //    condition itself: init here would be ambiguous and every later write would target
  //    whatever this directory happens to point at.
  const existing = parseJson(railway(["status", "--json"]).stdout);
  const existingName = existing?.name ?? existing?.project?.name ?? null;
  if (existingName && existingName !== project) {
    throw new Error(
      `this directory is already linked to Railway project "${existingName}". ` +
        `Provisioning writes from here would target it. Run setup from a fresh clone, or unlink first.`
    );
  }

  // 3. Create the project. Named up front so scripts/service-guard.mjs will accept it — a name
  //    it rejects yields a project whose schema load aborts on every deploy.
  if (!existingName) {
    io.log(`▶ creating project ${project}…`);
    const init = railway(["init", "--name", project]);
    if (init.status !== 0) throw new Error(`railway init failed: ${init.stderr.trim()}`);
  } else {
    io.log(`▶ project ${project} already exists — continuing`);
  }

  // 4. Pin the target. Everything after this point is a write and must prove where it points.
  const pinned = dryRun ? { name: project } : parseJson(railway(["status", "--json"]).stdout);
  assertPinnedTarget(pinned, project);
  io.log(`✓ pinned to ${project}`);

  // 5. Postgres.
  io.log("▶ adding Postgres…");
  const db = railway(["add", "--database", "postgres"], { write: true, pin: project, status: pinned });
  if (db.status !== 0 && !/already/i.test(db.stderr)) {
    throw new Error(`railway add postgres failed: ${db.stderr.trim()}`);
  }

  // 6. A domain, before variables — APP_URL cannot be known until the domain exists, and
  //    guessing it is how every invite link ends up broken.
  io.log("▶ generating a public domain…");
  const dom = railway(["domain"], { write: true, pin: project, status: pinned });
  const appUrl = dryRun
    ? `https://${project}.up.railway.app`
    : `https://${(dom.stdout.match(/[a-z0-9.-]+\.up\.railway\.app/i) || [])[0] ?? ""}`;
  if (!dryRun && !appUrl.includes(".up.railway.app")) {
    throw new Error(`could not determine the public domain from: ${dom.stdout.trim() || dom.stderr.trim()}`);
  }
  io.log(`✓ domain ${appUrl}`);

  // 7. Variables — secrets generated here, never prompted for and never echoed.
  //
  // On a project that already existed, read the environment FIRST. A re-run must not rotate
  // AUTH_SECRET (logs the team out) or SECRETS_KEY (orphans every encrypted connector token).
  // No read for a project this run just created: there is nothing to preserve.
  // Runs in dry-run too — it is a read, and it is what lets the plan say truthfully whether a
  // real run would preserve or generate.
  let existingVars = {};
  if (existingName) {
    // Deliberately the same service targeting as the write below — an asymmetric read could
    // preserve one service's secrets while overwriting another's. Nothing between this read
    // and the write below can relink the CLI, so the two cannot resolve differently.
    const read = railway(["variables", "--json"], { verify: true, pin: project, status: pinned });
    const parsed = read.status === 0 ? parseJson(read.stdout) : null;
    if (!isEnvironmentMap(parsed)) {
      throw new Error(
        `could not read the existing environment of "${project}" — refusing to continue, because ` +
          `overwriting AUTH_SECRET/SECRETS_KEY unseen would log the team out and make every stored ` +
          `connector token undecryptable. Fix the read (\`railway variables\`) and re-run.`
      );
    }
    existingVars = parsed;
  }

  io.log("▶ setting environment variables…");
  const { authSecret, secretsKey, reused } = resolveSecrets(existingVars, generateSecrets());
  if (reused.length) io.log(`  ↺ preserving existing ${reused.join(" + ")} (rotating them is destructive)`);
  const complaint = secretsKeyComplaint(existingVars.SECRETS_KEY);
  if (complaint) io.log(`  ⚠ ${complaint}`);
  const vars = buildVariables({
    appUrl, authSecret, secretsKey,
    anthropicKey, openaiKey, openrouterKey, llmBaseUrl,
    resendKey, resendFrom,
  });
  const setv = railway(["variables", ...toVariableArgs(vars)], { write: true, pin: project, status: pinned });
  if (setv.status !== 0) throw new Error(`setting variables failed: ${setv.stderr.trim()}`);
  io.log(`✓ ${Object.keys(vars).length} variables set (secrets generated, not printed)`);

  // 8. Hand off the one step no CLI can take. Connecting a GitHub repo is a dashboard OAuth
  //    grant — and it is also the deploy path, so this is deliberately the human's action.
  io.log(
    [
      "",
      "─".repeat(64),
      "  Next — connect the repo (this is the deploy path, and it is manual):",
      "",
      `  1. Fork aiosbrain/aios-team-brain to your GitHub account`,
      `  2. Railway dashboard → project ${project} → New → GitHub Repo → your fork`,
      `  3. Push to main. Railway builds; railway.json's preDeployCommand loads the schema.`,
      "",
      "  Then finish setup (creates your team + admin login):",
      `     node scripts/setup.mjs --slug ${slug} --email ${email} --resume`,
      "─".repeat(64),
      "",
    ].join("\n")
  );

  return { project, appUrl, phase: "awaiting-github-connection" };
}

/** Phase C — after the first deploy exists. Creates the team and the first admin. */
export async function finishSetup(opts, io = { exec: defaultExec, log: console.log }) {
  const { slug, displayName, email, memberName, dryRun } = opts;
  const project = toProjectName(slug);
  const railway = makeRailway(io, { dryRun });

  const pinned = dryRun ? { name: project } : parseJson(railway(["status", "--json"]).stdout);
  assertPinnedTarget(pinned, project);

  // `railway run` executes against the service's own environment, which is the only place
  // DATABASE_URL resolves — these commands cannot be run from a laptop.
  const admin = (args) =>
    railway(["run", "--", "npx", "tsx", "--conditions", "react-server", "scripts/admin.ts", ...args], {
      write: true,
      pin: project,
      status: pinned,
    });

  io.log(`▶ creating team ${slug}…`);
  const team = admin(["create-team", slug, "--name", displayName || slug]);
  if (team.status !== 0 && !/already|duplicate/i.test(team.stderr)) {
    throw new Error(`create-team failed: ${team.stderr.trim()}`);
  }

  io.log(`▶ creating admin ${email}…`);
  const member = admin([
    "create-member", email, "--name", memberName || email.split("@")[0],
    "--handle", (memberName || email.split("@")[0]).toLowerCase().replace(/\W+/g, ""),
    "--role", "admin", "--team", slug,
  ]);
  if (member.status !== 0) throw new Error(`create-member failed: ${member.stderr.trim()}`);

  // The password is printed exactly once by admin.ts and never recoverable — surface it rather
  // than leaving it buried in command output.
  const password = (member.stdout.match(/password set \(copy now, shown once\): (\S+)/) || [])[1];
  return { project, email, password: password ?? "(see output above)", phase: "done" };
}

// ── cli ─────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      "member-name": { type: "string" },
      "anthropic-key": { type: "string" },
      "openai-key": { type: "string" },
      "openrouter-key": { type: "string" },
      "llm-base-url": { type: "string" },
      "resend-key": { type: "string" },
      "resend-from": { type: "string" },
      resume: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help || !values.slug || !values.email) {
    console.log(
      [
        "Usage: node scripts/setup.mjs --slug <team> --email <you@example.com> [options]",
        "",
        "  --name <display>       team display name",
        "  --member-name <name>   your display name",
        "  --anthropic-key <k>    answering model (or configure per-team in Admin later)",
        "  --openai-key <k> | --openrouter-key <k> | --llm-base-url <url>   other providers",
        "  --resend-key <k> --resend-from <addr>   magic-link email",
        "  --resume               continue after connecting the GitHub repo",
        "  --dry-run              print the plan and write nothing. Reads DO run (so the plan can",
        "                         tell you whether secrets would be preserved, and can catch link",
        "                         drift) — so it needs an authenticated `railway login`.",
      ].join("\n")
    );
    process.exit(values.help ? 0 : 1);
  }

  const opts = {
    slug: values.slug,
    displayName: values.name,
    email: values.email,
    memberName: values["member-name"],
    anthropicKey: values["anthropic-key"],
    openaiKey: values["openai-key"],
    openrouterKey: values["openrouter-key"],
    llmBaseUrl: values["llm-base-url"],
    resendKey: values["resend-key"],
    resendFrom: values["resend-from"],
    dryRun: values["dry-run"],
  };

  if (values.resume) {
    const r = await finishSetup(opts);
    console.log(
      ["", "─".repeat(64), "  Your brain is live", "",
       `  Login     ${r.email}`, `  Password  ${r.password}`, "",
       "  Next: Admin → Integrations to connect Slack / GitHub / Linear.",
       "─".repeat(64), ""].join("\n")
    );
  } else {
    await runSetup(opts);
  }
}

if (process.argv[1] && process.argv[1].endsWith("setup.mjs")) {
  main().catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
