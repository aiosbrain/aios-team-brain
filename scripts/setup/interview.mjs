/**
 * interview.mjs — what we ask, in what order, and what counts as a valid answer.
 *
 * Pure on purpose: no prompting, no network, no filesystem. The question set and its validation
 * are the part most worth testing, and the part most likely to drift from what the code
 * downstream actually needs, so they are data here rather than a sequence of inline prompts.
 *
 * Two rules encoded below:
 *
 * 1. ASK THE ROUTING QUESTION FIRST. Local and Railway need different credentials — asking for
 *    a Railway login before knowing you want Docker wastes the user's time and teaches them the
 *    tool doesn't understand its own shape.
 * 2. NEVER ASK FOR A SECRET WE CAN GENERATE. AUTH_SECRET and SECRETS_KEY are generated
 *    everywhere they are used (setup.mjs, docker/bootstrap.mjs). A human-chosen SECRETS_KEY is
 *    how the wrong byte width gets in, which fails only at the first connector save.
 */

/** Where the brain will run. Asked first, because it determines everything after it. */
export const TARGETS = [
  {
    value: "local",
    label: "On this machine (Docker)",
    detail: "your own team, real install, no accounts needed. Best for trying it properly.",
  },
  {
    value: "railway",
    label: "On Railway (shared server for your team)",
    detail: "how a team actually runs one — connectors poll on a schedule. Needs a Railway login.",
  },
  {
    value: "demo",
    label: "Just show me the demo",
    detail: "Northwind Robotics sample data, one command, nothing to configure.",
  },
];

export const LLM_PROVIDERS = [
  { value: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY", keyHint: "sk-ant-…" },
  { value: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY", keyHint: "sk-…" },
  {
    value: "openrouter",
    label: "OpenRouter (one key, models from every major lab)",
    envKey: "OPENROUTER_API_KEY",
    keyHint: "sk-or-…",
  },
  { value: "local", label: "A model on my own hardware (OpenAI-compatible endpoint)", envKey: null },
  { value: "skip", label: "Skip for now — configure it in Admin later", envKey: null },
];

// ── validators: each returns null when fine, else the complaint shown to the user ───────────

export function validateEmail(value) {
  if (!value) return "an email is required — it becomes your admin login";
  // Deliberately loose. The only property we depend on is that a magic link can be addressed
  // to it; rejecting unusual-but-legal addresses is worse than accepting a typo the user sees.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `"${value}" doesn't look like an email address`;
  return null;
}

export function validateSlug(value) {
  if (!value) return "a team slug is required — it's the URL path, e.g. /t/acme";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return "lowercase letters, numbers and hyphens only, starting with a letter or number";
  if (value.length > 40) return "keep it under 40 characters";
  // `reserved` would collide with the app's own routes.
  if (["api", "admin", "login", "t", "new"].includes(value)) return `"${value}" is reserved — pick another`;
  return null;
}

export function validateTeamName(value) {
  if (!value) return "a display name is required";
  if (value.length > 80) return "keep it under 80 characters";
  return null;
}

/**
 * Format-only. Whether the key WORKS is a live question answered by probe.mjs — but catching an
 * obviously-wrong paste here saves a network round trip and gives a better message than a 401.
 */
export function validateLlmKey(provider, value) {
  if (!value) return "paste the key, or re-run and choose “Skip for now”";
  if (/\s/.test(value)) return "that contains whitespace — did the paste get truncated or wrapped?";
  const expected = { anthropic: "sk-ant-", openrouter: "sk-or-" }[provider];
  if (expected && !value.startsWith(expected)) {
    return `an ${provider} key normally starts with "${expected}" — check you pasted the right one`;
  }
  if (value.length < 20) return "that looks too short to be an API key";
  return null;
}

export function validateBaseUrl(value) {
  if (!value) return "a base URL is required, e.g. http://localhost:11434/v1";
  let url;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" isn't a valid URL`;
  }
  if (!["http:", "https:"].includes(url.protocol)) return "must be http:// or https://";
  return null;
}

/**
 * Which questions a target actually needs. Data rather than control flow, so "what does the
 * Railway path ask for?" is answerable by reading one array — and testable.
 */
export function questionsFor(target) {
  if (target === "demo") return ["confirm-demo"];
  const shared = ["team-slug", "team-name", "admin-email", "admin-name", "llm-provider"];
  if (target === "local") return shared;
  return [...shared, "mail-transport"]; // Railway invites go out by email; local logs in directly
}

/**
 * The ordered steps we will run, given the answers. Returned as data so the wizard can print
 * the plan for confirmation before touching anything — the same courtesy `--dry-run` gives.
 */
export function planFor(answers) {
  if (answers.target === "demo") {
    return [
      { id: "compose-demo", label: "Start Postgres + the app with the Northwind demo (docker compose)" },
      { id: "login", label: "Print the demo login" },
    ];
  }
  if (answers.target === "local") {
    return [
      { id: "secrets", label: "Generate AUTH_SECRET + SECRETS_KEY (persisted, never rotated)" },
      { id: "env", label: "Write .env.local (gitignored)" },
      { id: "compose", label: "Start Postgres + the app and load the schema (docker compose)" },
      { id: "team", label: `Create team "${answers.slug}" and your admin login` },
      { id: "doctor", label: "Run npm run doctor to confirm the result" },
    ];
  }
  return [
    { id: "railway-project", label: `Create the Railway project aios-${answers.slug} + Postgres` },
    { id: "railway-domain", label: "Claim a public domain and set the environment" },
    { id: "github", label: "Hand off the GitHub connection (the deploy path — yours to click)" },
    { id: "team", label: `Create team "${answers.slug}" and your admin login` },
  ];
}

/** A slug suggestion from an email domain — acme.com → acme. Saves a keystroke, never guesses wrong silently. */
export function suggestSlug(email) {
  const domain = String(email ?? "").split("@")[1] ?? "";
  const first = domain.split(".")[0] ?? "";
  const clean = first.toLowerCase().replace(/[^a-z0-9-]+/g, "");
  return validateSlug(clean) ? "" : clean;
}
