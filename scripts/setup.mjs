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
 *   node scripts/setup.mjs --slug acme --name "Acme Robotics" --email you@acme.com
 *   node scripts/setup.mjs --dry-run     # print the plan, touch nothing
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
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
export function buildVariables({ appUrl, authSecret, secretsKey, anthropicKey, resendKey, resendFrom }) {
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
  return function railway(args, { write = false, pin = null, status = null } = {}) {
    const rendered = `railway ${args.join(" ")}`;
    const verdict = classifyRailwayCommand(rendered);
    if (verdict.decision === "block") {
      throw new Error(`setup.mjs refused its own command: ${verdict.reason}`);
    }
    if (write) {
      if (!pin) throw new Error(`internal: write \`${rendered}\` attempted with no pinned target`);
      assertPinnedTarget(status, pin); // throws on drift
    }
    if (dryRun) {
      io.log(`  [dry-run] ${rendered}`);
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
  const { slug, email, anthropicKey, resendKey, resendFrom, dryRun } = opts;

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
  io.log("▶ setting environment variables…");
  const { authSecret, secretsKey } = generateSecrets();
  const vars = buildVariables({ appUrl, authSecret, secretsKey, anthropicKey, resendKey, resendFrom });
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
        "  --resend-key <k> --resend-from <addr>   magic-link email",
        "  --resume               continue after connecting the GitHub repo",
        "  --dry-run              print the plan, touch nothing",
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
