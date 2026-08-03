// Spec: the wizard must be usable by a human who knows nothing about the flags, must never invent
// answers when no human is present, and must prove a credential rather than assume it. The pure
// layers are tested here without a terminal or a network — the interactive shell over them is thin
// by design so that this tier can carry the weight.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import {
  PROBE_BAD_CREDENTIAL,
  PROBE_NO_ACCESS,
  PROBE_OK,
  PROBE_UNREACHABLE,
  dockerVerdict,
  probeCredential,
  probeRequestFor,
  verdictForStatus,
} from "../scripts/setup/probe.mjs";
import { composeEnvFor, runRailway } from "../scripts/setup-wizard.mjs";
import { credentialPlan, credentialSummary } from "../scripts/setup/credential-plan.mjs";
import {
  RAILWAY_PLANS_URL,
  RAILWAY_TEMPLATE_URL,
  RAILWAY_TEMPLATE_INPUTS,
} from "../scripts/setup/railway-template.mjs";
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
} from "../scripts/setup/interview.mjs";
import { createPrompter, resolveInputSource } from "../scripts/setup/prompt.mjs";

describe("input source — the curl | sh problem", () => {
  it("reads the terminal directly when stdin is the piped script", () => {
    // `curl … | sh` makes the SCRIPT stdin. Reading stdin would consume script bytes, so the only
    // correct source is /dev/tty. Getting this wrong doesn't error — it silently answers the
    // interview with defaults, which is worse.
    expect(resolveInputSource({ stdinIsTty: false, devTtyOpens: true })).toBe("dev-tty");
  });

  it("uses stdin for a normal invocation", () => {
    expect(resolveInputSource({ stdinIsTty: true, devTtyOpens: true })).toBe("stdin");
  });

  it("refuses rather than defaulting when there is no terminal at all", () => {
    // CI, cron, or `| sh` inside a pipeline. An installer that defaults its way through an
    // interview produces a misconfigured instance and reports success.
    expect(resolveInputSource({ stdinIsTty: false, devTtyOpens: false })).toBe("none");
  });
});

describe("the prompter itself — driven through an injected stream, no terminal needed", () => {
  /** A fake reader + captured output, so prompt behaviour is testable in CI. */
  function harness(lines: string[]) {
    const input = new PassThrough();
    // A real stream: readline with `terminal: true` attaches listeners to the output, so a
    // `{ write }` stub isn't enough.
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (c) => written.push(String(c)));
    const p = createPrompter({
      reader: { source: "dev-tty", stream: input, close: () => {} },
      out: output as unknown as NodeJS.WriteStream,
    });
    // Feed one answer at a time. Writing them all at once loses the later ones: readline in
    // terminal mode pauses the input stream between questions, so a queued line is dropped rather
    // than held for the re-prompt.
    void (async () => {
      for (const l of lines) {
        await new Promise((r) => setTimeout(r, 15));
        input.write(`${l}\n`);
      }
    })();
    return { p, written: () => written.join("") };
  }

  it("re-asks until the answer validates, showing the complaint", async () => {
    const { p, written } = harness(["api", "acme"]);
    const value = await p.text("slug:", { validate: validateSlug });
    expect(value).toBe("acme");
    expect(written()).toMatch(/reserved/i); // told the user WHY, then asked again
    p.close();
  });

  it("takes the default on an empty answer", async () => {
    const { p } = harness([""]);
    expect(await p.text("name:", { def: "chetan" })).toBe("chetan");
    p.close();
  });

  it("masks a secret answer but still shows the question", async () => {
    // Masking by muting readline's echo BEFORE the prompt renders collapsed the whole question to
    // a single "*" — the user saw an asterisk and a cursor with no idea what was being asked.
    const { p, written } = harness(["sk-ant-supersecretvalue"]);
    const key = await p.text("Anthropic API key:", { secret: true });
    expect(key).toBe("sk-ant-supersecretvalue"); // captured correctly…
    expect(written()).not.toContain("supersecret"); // …never printed…
    expect(written()).toContain("Anthropic API key:"); // …and the question survived
    p.close();
  });

  it("accepts y/n and re-asks anything else", async () => {
    const { p, written } = harness(["maybe", "n"]);
    expect(await p.confirm("go?", { def: true })).toBe(false);
    expect(written()).toMatch(/answer y or n/i);
    p.close();
  });

  it("rejects an out-of-range choice instead of silently picking one", async () => {
    // Coercing a bad choice to a default is how someone ends up provisioning the wrong target.
    const { p, written } = harness(["9", "2"]);
    const target = await p.choose("where?", TARGETS, { def: 0 });
    expect(target).toBe("railway");
    expect(written()).toMatch(/between 1 and 3/i);
    p.close();
  });
});

describe("the interview asks the routing question first", () => {
  it("offers local, Railway and demo — in that order", () => {
    expect(TARGETS.map((t) => t.value)).toEqual(["local", "railway", "demo"]);
  });

  it("asks only what a target needs", () => {
    // Asking for a Railway login before knowing the user wants Docker wastes their time.
    expect(questionsFor("demo")).toEqual(["confirm-demo"]);
    expect(questionsFor("local")).not.toContain("mail-transport"); // local logs in directly
    expect(questionsFor("railway")).toEqual(["railway-template"]); // Railway owns its form
  });

  it("never asks for a secret it can generate", () => {
    // A human-chosen SECRETS_KEY is how the wrong byte width gets in, and it only fails at the
    // first connector save.
    const asked = [...questionsFor("local"), ...questionsFor("railway")].join(" ").toLowerCase();
    expect(asked).not.toContain("auth_secret");
    expect(asked).not.toContain("secrets_key");
  });

  it("plans a local install that ends with a working login, not a running container", () => {
    const ids = planFor({ target: "local", slug: "acme" }).map((s) => s.id);
    expect(ids).toContain("team"); // a stack with no team has nothing to log into
    expect(ids).toContain("doctor"); // verify, don't assume
    expect(ids.indexOf("compose")).toBeLessThan(ids.indexOf("team")); // DB must exist first
  });

  it("plans a Railway template deploy with no GitHub-fork pause", () => {
    const ids = planFor({ target: "railway", slug: "acme" }).map((s) => s.id);
    expect(ids).toEqual(["railway-template", "railway-config", "railway-deploy", "railway-connect"]);
    expect(ids).not.toContain("github");
  });

  it("opens the stable deploy front door and always prints a copyable fallback", async () => {
    const output: string[] = [];
    const open = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await runRailway({}, { write: (s: string) => output.push(s) }, { open, platform: "darwin" });
    expect(open).toHaveBeenCalledWith("open", [RAILWAY_TEMPLATE_URL]);
    expect(output.join("")).toContain(RAILWAY_TEMPLATE_URL);
    expect(output.join("")).toContain("active plan");
    expect(output.join("")).toContain(RAILWAY_PLANS_URL);
    expect(output.join("")).not.toMatch(/Fork aiosbrain|run `railway login`/i);
  });

  it("keeps template-owned identity inputs explicit", () => {
    expect(RAILWAY_TEMPLATE_INPUTS).toEqual([
      "TEAM_NAME", "TEAM_SLUG", "ADMIN_NAME", "ADMIN_EMAIL", "ADMIN_PASSWORD",
    ]);
  });

  it("preserves Docker bootstrap behavior under Railway's start-command override", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "railway.json"), "utf8"),
    );
    const start = readFileSync(
      join(import.meta.dirname, "..", "scripts", "railway-start.sh"),
      "utf8",
    );
    expect(config.deploy.startCommand).toBe("sh scripts/railway-start.sh");
    expect(start).not.toContain('AIOS_TEMPLATE_BOOTSTRAP:-false');
    expect(start).toContain("node docker/bootstrap.mjs");
    expect(start).toContain("exec npm start");
  });
});

describe("answer validation catches the mistakes that cost an hour later", () => {
  it("rejects a slug that would collide with the app's own routes", () => {
    expect(validateSlug("api")).toMatch(/reserved/i);
    expect(validateSlug("admin")).toMatch(/reserved/i);
    expect(validateSlug("acme")).toBeNull();
  });

  it("rejects slug shapes the URL can't carry", () => {
    expect(validateSlug("Acme Corp")).toBeTruthy();
    expect(validateSlug("-acme")).toBeTruthy();
    expect(validateSlug("")).toBeTruthy();
    expect(validateSlug("acme-robotics-2")).toBeNull();
  });

  it("accepts unusual but legal email addresses", () => {
    // Rejecting a legal address is worse than accepting a typo the user can see.
    expect(validateEmail("a+tag@sub.example.co.uk")).toBeNull();
    expect(validateEmail("not-an-email")).toBeTruthy();
    expect(validateEmail("")).toBeTruthy();
  });

  it("catches a truncated or wrong-provider key paste before a network round trip", () => {
    expect(validateLlmKey("anthropic", "sk-proj-abcdefghijklmnop")).toMatch(/sk-ant-/);
    expect(validateLlmKey("anthropic", "sk-ant-" + "x".repeat(40))).toBeNull();
    expect(validateLlmKey("openai", "sk-ant-short")).toMatch(/too short/i);
    expect(validateLlmKey("anthropic", "sk-ant-aaa bbb ccc ddd eee fff")).toMatch(/whitespace/i);
  });

  it("validates a local endpoint URL", () => {
    expect(validateBaseUrl("http://localhost:11434/v1")).toBeNull();
    expect(validateBaseUrl("localhost:11434")).toBeTruthy(); // no scheme
    expect(validateBaseUrl("ftp://x/v1")).toMatch(/http/i);
  });

  it("agrees with the slug rule the database layer actually enforces", () => {
    // The wizard validates a slug hours before `createTeam` sees it. If the two rules drift, the
    // wizard accepts a slug that then throws deep inside provisioning — after the Railway project
    // has already been created. Pinned against the real source rather than restated.
    const src = readFileSync(join(import.meta.dirname, "..", "lib", "admin", "teams.ts"), "utf8");
    const rule = /const SLUG_RE = (\/.*?\/);/.exec(src)?.[1];
    expect(rule).toBe("/^[a-z0-9][a-z0-9-]*$/");
    for (const good of ["acme", "acme-2", "a"]) expect(validateSlug(good)).toBeNull();
    for (const bad of ["-acme", "Acme", "acme corp"]) expect(validateSlug(bad)).toBeTruthy();
  });

  it("suggests a slug from the email domain, and stays quiet when it can't", () => {
    expect(suggestSlug("chetan@acme.com")).toBe("acme");
    expect(suggestSlug("someone@api.dev")).toBe(""); // "api" is reserved — suggest nothing
    expect(suggestSlug("nonsense")).toBe("");
  });
});

describe("credential probes prove the key, and say which thing is wrong", () => {
  it("separates a rejected key from a valid key without access", () => {
    // 401 → re-paste the key. 403 → the key was right; the plan or workspace is the problem.
    // Telling a 403 user to check their key sends them to re-paste a correct key.
    expect(verdictForStatus(401).verdict).toBe(PROBE_BAD_CREDENTIAL);
    expect(verdictForStatus(403).verdict).toBe(PROBE_NO_ACCESS);
    expect(verdictForStatus(200).verdict).toBe(PROBE_OK);
  });

  it("treats a rate limit as proof the key authenticates", () => {
    // 429 means the provider recognised the key. Failing setup here would be a false negative.
    expect(verdictForStatus(429).verdict).toBe(PROBE_OK);
  });

  it("sends the anthropic-version header, whose absence fails for an unrelated reason", () => {
    const req = probeRequestFor("anthropic", { key: "sk-ant-x" });
    expect(req.url).toBe("https://api.anthropic.com/v1/models");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["x-api-key"]).toBe("sk-ant-x"); // not a Bearer token
  });

  it("uses Bearer auth for the OpenAI-compatible providers", () => {
    expect(probeRequestFor("openai", { key: "sk-x" }).headers.authorization).toBe("Bearer sk-x");
    expect(probeRequestFor("openrouter", { key: "sk-or-x" }).url).toContain("openrouter.ai");
  });

  it("probes a local endpoint with no key at all", () => {
    const req = probeRequestFor("local", { baseUrl: "http://localhost:11434/v1/" });
    expect(req.url).toBe("http://localhost:11434/v1/models"); // trailing slash collapsed
    expect(req.headers).toEqual({});
  });

  it("only ever issues a free metadata GET — never a billable completion", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await probeCredential("anthropic", { key: "sk-ant-x", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(String(url)).not.toContain("messages"); // not the generation endpoint
    expect(String(url)).not.toContain("chat/completions");
  });

  it("bounds the wait, and reports a hang as unreachable rather than as a bad key", async () => {
    // This runs inside an interactive prompt; an unbounded fetch leaves the user staring at a dead
    // terminal. And a network problem must not be reported as "your key is wrong".
    const fetchImpl = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const r = await probeCredential("anthropic", { key: "k", fetchImpl, timeoutMs: 10 });
    expect(r.verdict).toBe(PROBE_UNREACHABLE);
    expect(r.detail).toMatch(/no response/i);
  });

  it("reports a connection failure as unreachable, not as a rejected key", async () => {
    const fetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    };
    const r = await probeCredential("anthropic", { key: "k", fetchImpl });
    expect(r.verdict).toBe(PROBE_UNREACHABLE);
    expect(r.verdict).not.toBe(PROBE_BAD_CREDENTIAL);
  });

  it("skips the probe for a choice with nothing to check", async () => {
    const fetchImpl = vi.fn();
    const r = await probeCredential("skip", { fetchImpl });
    expect(r.verdict).toBe(PROBE_OK);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Spec: `curl … | sh` executes remote code as the user, so the properties below aren't style
// preferences — they're the reason it's safe to publish. Asserted against the file so they can't
// quietly regress.
describe("the curl installer's safety properties", () => {
  const sh = readFileSync(join(import.meta.dirname, "..", "install.sh"), "utf8");
  /** Comments stripped: prose documenting that we never sudo is not an invocation of sudo — the
   *  same distinction `railway-policy.mjs` draws for its forbidden verbs. */
  const code = sh
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("never escalates privileges", () => {
    expect(code).not.toMatch(/\bsudo\b|\bdoas\b/);
    expect(sh).toMatch(/Never uses sudo/); // and says so, so a reader doesn't have to check
  });

  it("reads answers from /dev/tty, without which a piped install answers its own interview", () => {
    expect(sh).toContain("< /dev/tty");
  });

  it("pins a ref and allows overriding it, rather than always taking the tip of main", () => {
    expect(sh).toMatch(/AIOS_REF/);
    expect(sh).toMatch(/--branch "\$REF"/);
  });

  it("refuses to overwrite a directory it did not create", () => {
    // The install path must never re-initialise a working instance: that is how an installer
    // destroys the secrets that decrypt a team's connector tokens.
    expect(code).toMatch(/already exists and is not a checkout of/);
    expect(code).toMatch(/re-running setup there/);
  });

  it("verifies the git remote, not just the presence of marker files", () => {
    // Marker files alone are forgeable: a planted directory with .git + setup-wizard.mjs and a
    // hostile package.json would get `npm ci` run in it, executing arbitrary lifecycle scripts.
    expect(code).toMatch(/remote get-url origin/);
    expect(code).toMatch(/\[ "\$ORIGIN" = "\$REPO" \]/);
  });

  it("renders an absolute target directory without a bogus ./ prefix", () => {
    // `./$DIR` with AIOS_DIR=/tmp/x printed "./tmp/x" — a path that does not exist, sending the
    // reader to look in the wrong place.
    expect(code).toMatch(/show_dir\(\)/);
    expect(code).not.toMatch(/"\.\/\$DIR"/);
  });

  it("fails loudly on a failed clone instead of continuing into a half-install", () => {
    expect(sh).toMatch(/clone failed/);
    expect(sh).toMatch(/^set -eu$/m);
  });
});

// This is the guard for the bug that made the whole local target dead code: the wizard forwarded
// TEAM_SLUG/ADMIN_EMAIL/… in the environment of the `docker compose` PROCESS, but compose.yml did
// not list them under `environment:` — and compose does not inherit the parent environment. So
// bootstrap never saw them, provisionRealTeam never ran, and the flagship path produced the exact
// un-loginable stack it exists to prevent. Nothing failed; it just quietly did nothing.
describe("the wizard's container env and compose.yml agree", () => {
  const compose = readFileSync(join(import.meta.dirname, "..", "compose.yml"), "utf8");

  it("is importable without running the CLI", () => {
    // This file imports `composeEnvFor`. Without the argv guard at the bottom of the wizard, that
    // import starts the interview and calls process.exit() — killing the test worker from inside a
    // module import, which reads as a runner bug rather than a code bug.
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "setup-wizard.mjs"), "utf8");
    expect(src).toMatch(/endsWith\("setup-wizard\.mjs"\)/);
  });

  it("every variable the wizard forwards is declared in compose.yml", () => {
    const forwarded = Object.keys(
      composeEnvFor({
        slug: "acme",
        teamName: "Acme",
        email: "you@acme.com",
        memberName: "You",
        provider: "openrouter",
        llmKey: "sk-or-x",
      })
    );
    expect(forwarded).toContain("TEAM_SLUG"); // non-vacuous: there is something to check
    const missing = forwarded.filter((k) => !new RegExp(`^\\s+${k}:`, "m").test(compose));
    expect(missing).toEqual([]);
  });

  it("declares every provider key the interview can produce", () => {
    // A provider offered in the menu but absent from compose.yml is a key the user pastes, watches
    // get validated, and then never reaches the app.
    for (const envKey of LLM_PROVIDERS.map((p) => p.envKey).filter(Boolean)) {
      expect(compose).toMatch(new RegExp(`^\\s+${envKey}:`, "m"));
    }
  });

  it("names the team the user chose, and never seeds the demo over it", () => {
    const env = composeEnvFor({ slug: "acme", teamName: "Acme Robotics", email: "a@b.co" });
    expect(env.TEAM_SLUG).toBe("acme");
    expect(env.SEED_DEMO).toBe("false");
  });
});

// Measured, not reasoned: a real container restart rotated the stored password hash while the
// bootstrap reported "unchanged". Cause — omitting `--password` does not skip setting one.
describe("the local install keeps its login across a restart", () => {
  it("does not run create-member at all once a credential exists", () => {
    // "Skip" must mean "don't run the command". Running it without --password installs a RANDOM
    // password nobody sees, which locks the user out — strictly worse than the rotation it replaced.
    expect(credentialPlan({ hasCredential: true, adminPassword: undefined })).toEqual({
      action: "skip",
      password: null,
    });
  });

  it("creates a credential on the first provision", () => {
    const plan = credentialPlan({ hasCredential: false, adminPassword: undefined, generate: () => "gen-pw" });
    expect(plan).toEqual({ action: "create", password: "gen-pw" });
  });

  it("honours an operator-supplied password over a generated one", () => {
    expect(credentialPlan({ hasCredential: false, adminPassword: "mine" }).password).toBe("mine");
  });

  it("does not render an operator-supplied password into deployment logs", () => {
    expect(credentialSummary({ password: "mine", supplied: true })).not.toContain("mine");
    expect(credentialSummary({ password: "mine", supplied: true })).toMatch(/not printed/i);
    expect(credentialSummary({ password: "generated", supplied: false })).toContain("generated");
  });

  it("pins WHY skipping means not running the command — admin.ts always sets a password", () => {
    // If this line ever stops defaulting, the whole dance above can be simplified. Until then it is
    // the reason for it, and a reader who doesn't know it will "simplify" straight back into the bug.
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "admin.ts"), "utf8");
    expect(src).toMatch(/flags\.password as string\) \|\| randomPassword\(\)/);
  });
});

describe("docker is diagnosed by what's actually wrong", () => {
  it("distinguishes not-installed from installed-but-not-running", () => {
    // These have completely different fixes, and `docker --version` succeeds in both cases —
    // which is why this checks the daemon, not the binary.
    expect(dockerVerdict({ status: 1, stderr: "docker: command not found" }).detail).toMatch(/isn't installed/i);
    expect(dockerVerdict({ status: 1, stderr: "Cannot connect to the Docker daemon" }).detail).toMatch(
      /not running/i
    );
    expect(dockerVerdict({ status: 1, stderr: "permission denied" }).verdict).toBe(PROBE_NO_ACCESS);
    expect(dockerVerdict({ status: 0 }).verdict).toBe(PROBE_OK);
  });
});
