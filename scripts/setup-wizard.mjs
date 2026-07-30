#!/usr/bin/env node
/**
 * setup-wizard.mjs — the front door. `npm run setup`.
 *
 * WHAT THIS REPLACES
 *
 * README §2 is eleven steps across three UIs, and §5 lists ten ways it silently goes wrong.
 * `scripts/setup.mjs` already collapsed the Railway half into one command — but it is flag-driven:
 * omit `--slug` and it prints usage. The only "interview" lived inside the `/setup-brain` skill,
 * which means the guided path existed only for people driving Claude Code. This is that interview
 * for everyone else, and it is what `curl … | sh` lands in.
 *
 * The layers underneath are pure and tested (`scripts/setup/*.mjs`, `test/setup-wizard.test.ts`);
 * this file is deliberately thin orchestration over them.
 *
 * TWO THINGS IT REFUSES TO DO
 *
 * 1. Invent answers. With no terminal (CI, a pipeline) it stops and prints the flag-driven form,
 *    rather than defaulting its way to a misconfigured instance and reporting success.
 * 2. Deploy. The Railway path delegates to `setup.mjs`, which classifies every command against
 *    `railway-policy.mjs` — `up`/`redeploy`/`down`/`delete` are refused there, so this file cannot
 *    reach them either.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { NoTerminalError, createPrompter, openReader } from "./setup/prompt.mjs";
import {
  LLM_PROVIDERS,
  TARGETS,
  planFor,
  questionsFor,
  suggestSlug,
  validateBaseUrl,
  validateEmail,
  validateLlmKey,
  validateSlug,
  validateTeamName,
} from "./setup/interview.mjs";
import { PROBE_BAD_CREDENTIAL, PROBE_OK, dockerVerdict, probeCredential } from "./setup/probe.mjs";

const ENV_FILE = ".env.local";

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/** Stream a long-running command so the user sees progress instead of a frozen terminal. */
function streamed(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// ── the interview ───────────────────────────────────────────────────────────

async function interview(p, out) {
  out.write("\n  Where should this brain run?\n\n");
  const target = await p.choose("", TARGETS, { def: 0 });
  const answers = { target };
  if (target === "demo") return answers;

  const needs = new Set(questionsFor(target));
  out.write("\n  A few details, then I'll show you the plan before touching anything.\n\n");

  answers.email = await p.text("  Your email (becomes your admin login):", { validate: validateEmail });
  answers.memberName = await p.text("  Your name:", { def: answers.email.split("@")[0] });
  answers.slug = await p.text("  Team slug (the URL path, e.g. /t/acme):", {
    def: suggestSlug(answers.email),
    validate: validateSlug,
  });
  answers.teamName = await p.text("  Team display name:", { def: answers.slug, validate: validateTeamName });

  // The model. Asked last because it is the only optional one — the dashboard works without it.
  out.write("\n  Which model should answer questions? (switchable later in Admin, no redeploy)\n\n");
  answers.provider = await p.choose("", LLM_PROVIDERS, { def: 0 });
  if (answers.provider === "local") {
    answers.baseUrl = await p.text("  OpenAI-compatible base URL:", {
      def: "http://localhost:11434/v1",
      validate: validateBaseUrl,
    });
  } else if (answers.provider !== "skip") {
    const spec = LLM_PROVIDERS.find((x) => x.value === answers.provider);
    answers.llmKey = await p.text(`  ${spec.label} API key (${spec.keyHint}, not echoed):`, {
      secret: true,
      validate: (v) => validateLlmKey(answers.provider, v),
    });
  }

  if (needs.has("mail-transport")) {
    out.write("\n  Invites and magic links go out by email. Without a transport they are dropped\n");
    out.write("  silently in production — you can still log in with a password.\n\n");
    if (await p.confirm("  Configure a Resend key now?", { def: false })) {
      answers.resendKey = await p.text("  Resend API key:", { secret: true });
      answers.resendFrom = await p.text('  From address (e.g. "Brain <noreply@yourdomain>"):');
    }
  }

  return answers;
}

/** Prove what we can before doing anything — a wrong key found now costs a re-paste, not an hour. */
async function preflight(answers, out) {
  const checks = [];

  if (answers.target === "local" || answers.target === "demo") {
    // `docker info` (not `--version`): the daemon being down is the common case and the binary
    // exists either way.
    const r = sh("docker", ["info"]);
    checks.push(["docker", dockerVerdict({ status: r.status ?? 1, stderr: r.stderr || r.stdout })]);
  }

  if (answers.target === "railway") {
    const r = sh("railway", ["whoami"]);
    checks.push([
      "railway",
      r.status === 0
        ? { verdict: PROBE_OK, detail: (r.stdout || "").trim() || "authenticated" }
        : { verdict: PROBE_BAD_CREDENTIAL, detail: "not logged in — run `railway login` (opens a browser), then re-run" },
    ]);
  }

  if (answers.llmKey || answers.baseUrl) {
    out.write("  checking the model key…\n");
    checks.push([
      `${answers.provider} key`,
      await probeCredential(answers.provider, { key: answers.llmKey, baseUrl: answers.baseUrl }),
    ]);
  }

  for (const [name, r] of checks) {
    out.write(`  ${r.verdict === PROBE_OK ? "✓" : "✗"} ${name}: ${r.detail}\n`);
  }
  return checks.filter(([, r]) => r.verdict !== PROBE_OK);
}

// ── execution ───────────────────────────────────────────────────────────────

/**
 * Write .env.local for the local target. Gitignored (`.env*`), 0600, and existing values win —
 * clobbering a file the user already tuned would be the installer destroying their work.
 */
function writeEnvLocal(answers, out) {
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const has = (k) => new RegExp(`^${k}=`, "m").test(existing);
  const add = [];
  const put = (k, v) => {
    if (v && !has(k)) add.push(`${k}=${v}`);
  };

  // Generated, never prompted — and only when absent, for the same reason setup.mjs preserves
  // them: rotating SECRETS_KEY orphans every encrypted connector token.
  put("AUTH_SECRET", randomBytes(32).toString("hex"));
  put("SECRETS_KEY", randomBytes(32).toString("base64"));
  const providerEnv = LLM_PROVIDERS.find((x) => x.value === answers.provider)?.envKey;
  if (providerEnv) put(providerEnv, answers.llmKey);
  if (answers.baseUrl) put("LLM_BASE_URL", answers.baseUrl);

  if (!add.length) {
    out.write(`  ✓ ${ENV_FILE} already has what's needed — left untouched\n`);
    return;
  }
  const body = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  writeFileSync(ENV_FILE, `${body}${add.join("\n")}\n`, { mode: 0o600 });
  out.write(`  ✓ wrote ${add.length} value(s) to ${ENV_FILE} (gitignored, 0600)\n`);
}

/**
 * The container environment for a real local install.
 *
 * Every one of these must also be listed in `compose.yml`'s `environment:` block — compose does not
 * inherit the parent process's environment. Forwarding them here while compose drops them is how the
 * local target booted a brain with no team and no login: `provisionRealTeam` simply never ran.
 */
export function composeEnvFor(answers) {
  const env = {
    SEED_DEMO: "false",
    TEAM_SLUG: answers.slug,
    TEAM_NAME: answers.teamName ?? answers.slug,
    ADMIN_EMAIL: answers.email,
    ADMIN_NAME: answers.memberName ?? "",
  };
  const providerEnv = LLM_PROVIDERS.find((x) => x.value === answers.provider)?.envKey;
  if (providerEnv && answers.llmKey) env[providerEnv] = answers.llmKey;
  if (answers.baseUrl) env.LLM_BASE_URL = answers.baseUrl;
  return env;
}

async function runLocal(answers, out) {
  writeEnvLocal(answers, out);
  out.write("\n  Starting Postgres + the app. The first run builds the image — a few minutes.\n\n");
  // Detached + --wait so the wizard can verify the result. Running in the foreground would mean
  // everything after this only happened once the user hit Ctrl-C.
  const code = await streamed("docker", ["compose", "up", "-d", "--build", "--wait"], composeEnvFor(answers));
  if (code !== 0) {
    out.write("\n  ✗ the stack didn't come up. `docker compose logs app` has the reason.\n");
    return code;
  }

  // bootstrap prints the login into the container log; surface it rather than making the user dig.
  const logs = sh("docker", ["compose", "logs", "--no-log-prefix", "app"]).stdout ?? "";
  const box = logs.slice(logs.lastIndexOf("─".repeat(58)));
  if (box.trim()) out.write(`\n${box.trimEnd()}\n`);

  out.write("\n  Verifying with `npm run doctor`…\n\n");
  await streamed("npm", ["run", "--silent", "doctor"]);
  out.write("\n  Running in the background. `docker compose logs -f app` to follow, `docker compose down` to stop.\n\n");
  return 0;
}

async function runDemo(out) {
  out.write("\n  Starting the demo stack — Northwind Robotics, login printed when it's up.\n\n");
  return streamed("docker", ["compose", "up"]);
}

async function runRailway(answers, out) {
  out.write("\n  Provisioning on Railway. This never deploys — the GitHub connection does that.\n\n");
  const args = [
    "scripts/setup.mjs",
    "--slug", answers.slug,
    "--name", answers.teamName,
    "--email", answers.email,
    "--member-name", answers.memberName,
  ];
  // Carry whichever provider the user actually chose. Forwarding only Anthropic meant an
  // OpenAI/OpenRouter key was validated live and then dropped, leaving an instance that could not
  // answer anything while the wizard reported success.
  const providerFlag = { anthropic: "--anthropic-key", openai: "--openai-key", openrouter: "--openrouter-key" }[
    answers.provider
  ];
  if (providerFlag && answers.llmKey) args.push(providerFlag, answers.llmKey);
  if (answers.baseUrl) args.push("--llm-base-url", answers.baseUrl);
  if (answers.resendKey) args.push("--resend-key", answers.resendKey, "--resend-from", answers.resendFrom ?? "");
  out.write("  (dry run first — nothing is written yet)\n\n");
  const dry = await streamed("node", [...args, "--dry-run"]);
  if (dry !== 0) return dry;
  return streamed("node", args);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: { help: { type: "boolean", default: false } },
    allowPositionals: false,
  });
  const out = process.stdout;

  if (values.help) {
    out.write(
      [
        "Usage: npm run setup",
        "",
        "  Interactive. Asks where to run (this machine / Railway / demo), collects the handful of",
        "  credentials that target needs, validates each one, shows the plan, then executes.",
        "",
        "  Non-interactive equivalents:",
        "    docker compose up                     # the demo",
        "    node scripts/setup.mjs --help         # Railway, flag-driven",
        "",
      ].join("\n")
    );
    return 0;
  }

  out.write("\n  AIOS Team Brain — setup\n");

  const reader = openReader();
  let p;
  try {
    p = createPrompter({ reader, out });
  } catch (err) {
    if (!(err instanceof NoTerminalError)) throw err;
    // No human to ask. Refuse rather than default — see the header.
    out.write(`\n  ✗ ${err.message}\n\n`);
    return 1;
  }

  try {
    const answers = await interview(p, out);

    out.write("\n  Here's the plan:\n\n");
    planFor(answers).forEach((step, i) => out.write(`   ${i + 1}. ${step.label}\n`));
    out.write("\n");

    const failures = await preflight(answers, out);
    if (failures.length) {
      out.write("\n  Fix the ✗ line(s) above and re-run. Nothing has been changed.\n\n");
      return 1;
    }

    if (!(await p.confirm("\n  Go ahead?", { def: true }))) {
      out.write("\n  Stopped. Nothing was changed.\n\n");
      return 0;
    }
    p.close();

    if (answers.target === "demo") return runDemo(out);
    if (answers.target === "local") return runLocal(answers, out);
    return runRailway(answers, out);
  } finally {
    try {
      p.close();
    } catch {
      /* already closed after the confirm — fine */
    }
  }
}

// Run ONLY when invoked as a script — the same guard `setup.mjs` uses. Without it, merely importing
// this module for `composeEnvFor` starts the interview and then calls `process.exit()`: the test file
// that imports it was running the CLI as an import side effect, and a `process.exit` from inside a
// test worker is the kind of failure that gets blamed on the runner.
if (process.argv[1] && process.argv[1].endsWith("setup-wizard.mjs")) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`\n✗ ${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    });
}
