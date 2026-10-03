import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_ONLY_AUTH_SECRET,
  BUILD_ONLY_DATABASE_URL,
  recordedBuildEnv,
  runRecordedBuild,
} from "./http/dev-login-build-record";
import {
  BUILD_RECORD_COMMAND,
  BUILD_RECORD_FILE,
  CHILD_ENV_OS_ALLOWLIST,
  DevLoginSetupFailure,
  NEXT_LOADED_ENV_FILES,
  assertBuildRecordCurrent,
  changedKeys,
  describeChildEnv,
  fingerprintFiles,
  inventoryRuntimeSources,
  inventoryServerJs,
  summarizeSources,
  type BuildRecord,
  type SetupFailureKind,
} from "./http/dev-login-dev-setup";

// Spec (AIO-1210 AC08/AC10, docs/design/aio1210-dev-login.md): the dev-login wire carrier consumes a
// production build it did not make, so it may credit that build only when something OBSERVED it
// being built from the current sources — "a stale/copied build is not proof". These cases pin both
// halves on synthetic checkouts in disposable temp directories:
//
//   - the recorder writes a record only for a command it ran itself that exited 0 with the runtime
//     source inventory unchanged, and never when a Next-loaded env file is present;
//   - that command runs in a finite synthetic environment, not the caller's ("do not inherit
//     arbitrary provider/telemetry credentials or NODE_OPTIONS hooks");
//   - "the sources" are the whole inventory — every file under the source roots plus the root
//     config/package/lock inputs, read from the filesystem with no Git — so an edit, an addition or
//     a deletion anywhere in it makes a record stale;
//   - the carrier-side check refuses a build with no record, a record whose own claims do not hold,
//     and a record the checkout or the artifact has since moved away from.
//
// The "build" is a real child process (a generated Node script standing in for one command), so the
// exit status and the environment it sees are real ones. Nothing here runs `next`, opens a socket,
// contacts a database or provider, or touches the task checkout.

const ROUTE = join("app", "auth", "dev-login", "route.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The recorder reads DATABASE_TEST_URL from this process. Whatever the runner exported, each case
// starts without one and sets its own; the recorder's evidence line is captured, not printed.
beforeEach(() => {
  vi.stubEnv("DATABASE_TEST_URL", undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const loggedLines = (): string[] => vi.mocked(console.log).mock.calls.map((args) => String(args[0]));

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A synthetic checkout: just enough sources to inventory. Never a Git checkout. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "aio1210-build-record-"));
  roots.push(dir);
  expect(realpathSync(dir).startsWith(realpathSync(process.cwd()) + sep)).toBe(false);
  write(dir, ROUTE, "// synthetic route source\n");
  write(dir, "package.json", "{}\n");
  return dir;
}

// What the nine-path list this inventory replaced left out, as the real project has it: the pg pool
// and readiness behind the route, the script product code imports, the Sentry/PostCSS configuration
// and the lockfile.
const POOL = "lib/db/pg/pool.ts";
const READINESS = "lib/health/readiness.ts";
const BUILD_IDENTITY = "scripts/staging-ops/build-identity.mjs";
const RICH_SOURCES = [
  POOL,
  READINESS,
  BUILD_IDENTITY,
  "components/login-form.tsx",
  "config/staging-ops/schedules.json",
  "postgres/schema.sql",
  "public/file.svg",
  "next.config.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "postcss.config.mjs",
  "tsconfig.json",
  "package-lock.json",
];

/** `checkout()` plus those files — and, on purpose, no `.git`. */
function richCheckout(): string {
  const dir = checkout();
  for (const rel of RICH_SOURCES) write(dir, rel, `// synthetic ${rel}\n`);
  expect(existsSync(join(dir, ".git"))).toBe(false);
  return dir;
}

const HOSTILE = "hostile-ambient-marker";
/** Named variables the stand-in build reports on. Values are written only for these mode switches. */
const PROBE_VALUES = [
  "NODE_ENV",
  "AIOS_DEV_LOGIN",
  "DB_BACKEND",
  "NEXT_PUBLIC_DB_BACKEND",
  "NEXT_TELEMETRY_DISABLED",
  "INGEST_POLL_ENABLED",
  "GRAPH_PROJECT_ENABLED",
  "SOCIAL_JOBS_ENABLED",
];
/** Reported as a digest only, so no URL or secret is written anywhere. */
const PROBE_DIGESTS = ["DATABASE_URL", "AUTH_SECRET", "SECRETS_KEY", "APP_URL"];
/** Reported as absent / blank / hostile (holds the marker) / set. */
const PROBE_PRESENCE = [
  ...PROBE_DIGESTS,
  "PATH",
  "NODE_OPTIONS",
  "ALLOW_DEV_LOGIN",
  "DATABASE_TEST_URL",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_BASE_URL",
  "GRAPHITI_URL",
  "NEO4J_URL",
  "NEO4J_PASSWORD",
  "RESEND_API_KEY",
  "SMTP_URL",
  "NEXT_PUBLIC_AIO1210_MARKER",
  "PGHOST",
  "PGPASSWORD",
  "AIO1210_UNKNOWN_SECRET_MARKER",
];
const ENV_REPORT = "build-env.report";

interface EnvReport {
  values: Record<string, string | null>;
  digests: Record<string, string | null>;
  presence: Record<string, "absent" | "blank" | "hostile" | "set">;
}

/**
 * A stand-in build COMMAND. Like `next build` it clears `.next` first, then emits the files the
 * carrier reads; it can also exit non-zero, run extra statements while it "builds" (`during`), and
 * report — into its own disposable checkout — what environment it was actually started with.
 */
function fakeBuild(
  dir: string,
  opts: { buildId?: string; exitCode?: number; editSource?: boolean; during?: string[]; probeEnv?: boolean } = {}
): string[] {
  const script = join(dir, "fake-build.mjs");
  writeFileSync(
    script,
    [
      'import { createHash } from "node:crypto";',
      'import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
      'import { dirname } from "node:path";',
      "const out = (rel, text) => { mkdirSync(dirname(rel), { recursive: true }); writeFileSync(rel, text); };",
      'rmSync(".next", { recursive: true, force: true });',
      `out(".next/BUILD_ID", ${JSON.stringify(opts.buildId ?? "synthetic-build-1")});`,
      'out(".next/server/app-paths-manifest.json", JSON.stringify({ "/auth/dev-login/route": "app/auth/dev-login/route.js" }));',
      'out(".next/server/app/auth/dev-login/route.js", "// synthetic entry\\n");',
      'out(".next/server/chunks/handler.js", "// synthetic handler chunk\\n");',
      'out(".next/server/chunks/handler.js.map", "{}");',
      'out(".next/prerender-manifest.json", JSON.stringify({ routes: {} }));',
      'out("build-ran.sentinel", "ran");',
      opts.editSource ? 'appendFileSync("app/auth/dev-login/route.ts", "// edited during the build\\n");' : "",
      ...(opts.during ?? []),
      ...(opts.probeEnv
        ? [
            // Only the named variables are read; a value is written only for the mode switches.
            `const seen = (name) => { const v = process.env[name]; return v === undefined ? "absent" : v === "" ? "blank" : v.includes(${JSON.stringify(HOSTILE)}) ? "hostile" : "set"; };`,
            'const digest = (name) => (process.env[name] === undefined ? null : createHash("sha256").update(process.env[name]).digest("hex"));',
            `out(${JSON.stringify(ENV_REPORT)}, JSON.stringify({`,
            `  values: Object.fromEntries(${JSON.stringify(PROBE_VALUES)}.map((name) => [name, process.env[name] ?? null])),`,
            `  digests: Object.fromEntries(${JSON.stringify(PROBE_DIGESTS)}.map((name) => [name, digest(name)])),`,
            `  presence: Object.fromEntries(${JSON.stringify(PROBE_PRESENCE)}.map((name) => [name, seen(name)])),`,
            "}));",
          ]
        : []),
      `process.exit(${opts.exitCode ?? 0});`,
      "",
    ].join("\n")
  );
  return [process.execPath, script];
}

function failureOf(run: () => unknown): DevLoginSetupFailure {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
  return thrown as DevLoginSetupFailure;
}

function expectFailure(run: () => unknown, kind: SetupFailureKind): DevLoginSetupFailure {
  const failure = failureOf(run);
  expect(failure.kind).toBe(kind);
  expect(failure.message).toContain(`SETUP_FAILURE[${kind}]`);
  return failure;
}

const recordFile = (dir: string): string => join(dir, BUILD_RECORD_FILE);
const readRecord = (dir: string): BuildRecord => JSON.parse(readFileSync(recordFile(dir), "utf8")) as BuildRecord;

/** A checkout holding a recorded stand-in build, plus the command that record names. */
function recorded(dir: string = checkout()): { dir: string; command: string[]; record: BuildRecord } {
  const command = fakeBuild(dir);
  return { dir, command, record: runRecordedBuild(dir, command) };
}

/**
 * Run `run` with `ambient` exported in THIS process, as a developer shell or CI step would have it,
 * then restore. Synchronous and short: the recorder's spawnSync is the only thing that runs inside.
 */
function withAmbient<T>(ambient: Record<string, string>, run: () => T): T {
  for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
  try {
    return run();
  } finally {
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_TEST_URL", undefined);
  }
}

/**
 * A harmless preload hook in its own directory of the disposable checkout (not a source root): if a
 * Node process is ever started with it, it leaves a sentinel beside itself and does nothing else.
 * It is never loaded into this test process — NODE_OPTIONS is only read when a process starts.
 */
function hostileHook(dir: string): { file: string; sentinel: string } {
  const file = join(dir, "ambient", "hostile-hook.cjs");
  write(dir, join("ambient", "hostile-hook.cjs"), 'require("node:fs").writeFileSync(require("node:path").join(__dirname, "hook-ran.sentinel"), "ran");\n');
  return { file, sentinel: join(dir, "ambient", "hook-ran.sentinel") };
}

/** Everything a hostile or merely configured caller environment could hand a build. */
function hostileAmbient(hook: string): Record<string, string> {
  return {
    NODE_ENV: "development",
    AIOS_DEV_LOGIN: "1",
    ALLOW_DEV_LOGIN: "1",
    NODE_OPTIONS: `--require ${JSON.stringify(hook)}`,
    DATABASE_URL: `postgres://${HOSTILE}:${HOSTILE}@db.example.invalid:5432/production`,
    AUTH_SECRET: `${HOSTILE}-auth-secret`,
    SECRETS_KEY: `${HOSTILE}-secrets-key`,
    APP_URL: `https://${HOSTILE}.example.invalid`,
    DB_BACKEND: HOSTILE,
    NEXT_PUBLIC_DB_BACKEND: HOSTILE,
    SENTRY_ORG: HOSTILE,
    SENTRY_PROJECT: HOSTILE,
    SENTRY_AUTH_TOKEN: HOSTILE,
    SENTRY_DSN: `https://${HOSTILE}@sentry.example.invalid/1`,
    NEXT_PUBLIC_SENTRY_DSN: `https://${HOSTILE}@sentry.example.invalid/1`,
    ANTHROPIC_API_KEY: HOSTILE,
    ANTHROPIC_BASE_URL: `https://${HOSTILE}.example.invalid`,
    OPENAI_API_KEY: HOSTILE,
    OPENROUTER_API_KEY: HOSTILE,
    LLM_BASE_URL: `https://${HOSTILE}.example.invalid/v1`,
    GRAPHITI_URL: `https://${HOSTILE}.example.invalid`,
    NEO4J_URL: `bolt://${HOSTILE}.example.invalid:7687`,
    NEO4J_PASSWORD: HOSTILE,
    RESEND_API_KEY: HOSTILE,
    SMTP_URL: `smtp://${HOSTILE}.example.invalid`,
    NEXT_PUBLIC_AIO1210_MARKER: HOSTILE,
    PGHOST: `${HOSTILE}.example.invalid`,
    PGPASSWORD: HOSTILE,
    INGEST_POLL_ENABLED: "true",
    GRAPH_PROJECT_ENABLED: "true",
    SOCIAL_JOBS_ENABLED: "true",
    NEXT_TELEMETRY_DISABLED: "0",
    AIO1210_UNKNOWN_SECRET_MARKER: HOSTILE,
  };
}

const readEnvReport = (dir: string): EnvReport => JSON.parse(readFileSync(join(dir, ENV_REPORT), "utf8")) as EnvReport;

describe("server JS inventory (pure)", () => {
  const emit = (dir: string, files: [string, string][]): void => {
    for (const [rel, text] of files) write(dir, join(".next", "server", rel), text);
  };
  const FILES: [string, string][] = [
    ["app/auth/dev-login/route.js", "entry"],
    ["chunks/a.js", "chunk a"],
    ["chunks/ssr/b.js", "chunk b"],
    ["webpack-runtime.js", "runtime"],
  ];

  it("is deterministic: the same emitted files hash the same whatever order they were written in", () => {
    const forward = checkout();
    const reverse = checkout();
    emit(forward, FILES);
    emit(reverse, [...FILES].reverse());

    const a = inventoryServerJs(forward);
    const b = inventoryServerJs(reverse);
    expect(a.hash).toBe(b.hash);
    expect(a.entries).toEqual(b.entries);
    expect(Object.keys(a.entries)).toEqual(FILES.map(([rel]) => rel).sort());
    expect(a.files).toBe(4);
    expect(a.bytes).toBe(FILES.reduce((sum, [, text]) => sum + text.length, 0));
    expect(a.nonRegular).toBe(0);
  });

  it("covers JS only: source maps, other files and a dev server's .next/dev output never enter", () => {
    const dir = checkout();
    emit(dir, FILES);
    const before = inventoryServerJs(dir);

    emit(dir, [
      ["chunks/a.js.map", "{}"],
      ["app-paths-manifest.json", "{}"],
      ["app/auth/dev-login/route.js.nft.json", "{}"],
    ]);
    write(dir, join(".next", "dev", "server", "chunks", "a.js"), "dev output");
    expect(inventoryServerJs(dir)).toEqual(before);
  });

  it.each<[string, (dir: string) => void]>([
    ["a chunk's content changes", (dir) => write(dir, ".next/server/chunks/a.js", "chunk a, changed")],
    ["a chunk is added", (dir) => write(dir, ".next/server/chunks/new.js", "new")],
    ["a chunk is removed", (dir) => rmSync(join(dir, ".next/server/chunks/a.js"))],
    ["the route entry changes", (dir) => write(dir, ".next/server/app/auth/dev-login/route.js", "entry, changed")],
  ])("the hash moves when %s", (_name, mutate) => {
    const dir = checkout();
    emit(dir, FILES);
    const before = inventoryServerJs(dir);
    mutate(dir);
    expect(inventoryServerJs(dir).hash).not.toBe(before.hash);
  });

  it("a checkout with no server output is a named setup failure", () => {
    expectFailure(() => inventoryServerJs(checkout()), "build-missing");
  });
});

describe("runtime source inventory (pure, portable, no Git)", () => {
  it("covers every file under the source roots and the root config/package/lock inputs, sorted by code unit", () => {
    const dir = richCheckout();
    const inventory = inventoryRuntimeSources(dir);
    expect(Object.keys(inventory)).toEqual([ROUTE.split(sep).join("/"), "package.json", ...RICH_SOURCES].sort());
    for (const digest of Object.values(inventory)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(inventory[POOL]).toBe(sha256(`// synthetic ${POOL}\n`));
    expect(summarizeSources(inventory).files).toBe(RICH_SOURCES.length + 2);
  });

  it("is deterministic: the same files inventory the same whatever order they were written in", () => {
    const forward = checkout();
    const reverse = checkout();
    for (const rel of RICH_SOURCES) write(forward, rel, `// synthetic ${rel}\n`);
    for (const rel of [...RICH_SOURCES].reverse()) write(reverse, rel, `// synthetic ${rel}\n`);
    expect(inventoryRuntimeSources(reverse)).toEqual(inventoryRuntimeSources(forward));
    expect(summarizeSources(inventoryRuntimeSources(reverse))).toEqual(summarizeSources(inventoryRuntimeSources(forward)));
  });

  it.each<[string, string, (dir: string) => void]>([
    ["the pg pool is edited", POOL, (dir) => appendFileSync(join(dir, POOL), "// edited\n")],
    ["readiness is deleted", READINESS, (dir) => rmSync(join(dir, READINESS))],
    ["a script product code imports is edited", BUILD_IDENTITY, (dir) => appendFileSync(join(dir, BUILD_IDENTITY), "// edited\n")],
    ["an untracked new source file appears", "lib/db/pg/new-file.ts", (dir) => write(dir, "lib/db/pg/new-file.ts", "// new\n")],
    ["a new root config appears", "added.config.mjs", (dir) => write(dir, "added.config.mjs", "// new\n")],
    ["the lockfile drifts", "package-lock.json", (dir) => appendFileSync(join(dir, "package-lock.json"), "\n")],
    ["the Sentry configuration is edited", "sentry.server.config.ts", (dir) => appendFileSync(join(dir, "sentry.server.config.ts"), "// edited\n")],
    ["a static asset is replaced", "public/file.svg", (dir) => write(dir, "public/file.svg", "<svg/>")],
  ])("the path set or content moves, and the summary with it, when %s", (_name, path, mutate) => {
    const dir = richCheckout();
    const before = inventoryRuntimeSources(dir);
    mutate(dir);
    const after = inventoryRuntimeSources(dir);
    expect(changedKeys(before, after)).toEqual([path]);
    expect(summarizeSources(after).hash).not.toBe(summarizeSources(before).hash);
  });

  it("handoff, test, docs, dependency, generated and private files never enter — and private ones are never opened", () => {
    const dir = richCheckout();
    const before = inventoryRuntimeSources(dir);
    const MARKER = "private-content-marker";
    const outside = [
      ".context/aio1210-handoff/notes.ts",
      ".context/aio1210-mutation-1/app/auth/dev-login/route.ts",
      ".claude/worktrees/other/lib/x.ts",
      "test/dev-login-route.test.ts",
      "docs/design/aio1210-dev-login.md",
      "node_modules/dependency/index.js",
      "lib/node_modules/vendored/index.js",
      "scripts/.context/scratch.mjs",
      ".next/server/chunks/handler.js",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      "README.md",
    ];
    const privateFiles = [
      ".env.local",
      ".env.example",
      ".aios-demo-key",
      "scripts/.env.local",
      "config/staging-ops/exporter.example.env",
      "lib/tls/server.pem",
      "lib/tls/server.key",
      "config/client.p12",
    ];
    for (const rel of [...outside, ...privateFiles]) write(dir, rel, `${MARKER} ${rel}\n`);
    // Unreadable to this user: an inventory that opened one would fail instead of passing quietly.
    for (const rel of privateFiles) chmodSync(join(dir, rel), 0o000);

    const after = inventoryRuntimeSources(dir);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(MARKER);
    for (const rel of [...outside, ...privateFiles]) expect(rel in after).toBe(false);
  });

  it("a symbolic link is taken only as the regular file it names inside the checkout", () => {
    const dir = richCheckout();
    symlinkSync(join(dir, POOL), join(dir, "lib", "db", "pg", "pool-link.ts"));
    const inventory = inventoryRuntimeSources(dir);
    expect(inventory["lib/db/pg/pool-link.ts"]).toBe(inventory[POOL]);
  });

  it.each<[string, string, (dir: string, elsewhere: string) => void]>([
    [
      "a link out of the checkout",
      "lib/escape.ts",
      (dir, elsewhere) => {
        write(elsewhere, "outside.ts", "outside-content-marker\n");
        symlinkSync(join(elsewhere, "outside.ts"), join(dir, "lib", "escape.ts"));
      },
    ],
    ["a dangling link", "lib/dangling.ts", (dir) => symlinkSync(join(dir, "lib", "no-such-file.ts"), join(dir, "lib", "dangling.ts"))],
    ["a link to a directory", "lib/db-link", (dir) => symlinkSync(join(dir, "lib", "db"), join(dir, "lib", "db-link"))],
    [
      "a link to a private file",
      "lib/settings.ts",
      (dir) => {
        write(dir, ".env.local", "outside-content-marker\n");
        symlinkSync(join(dir, ".env.local"), join(dir, "lib", "settings.ts"));
      },
    ],
    [
      "a link into the dependencies",
      "lib/vendored.js",
      (dir) => {
        write(dir, "node_modules/dependency/index.js", "outside-content-marker\n");
        symlinkSync(join(dir, "node_modules", "dependency", "index.js"), join(dir, "lib", "vendored.js"));
      },
    ],
    ["a source root that is itself a link", "styles", (dir) => symlinkSync(join(dir, "public"), join(dir, "styles"))],
    ["a pages/ application directory", "pages", (dir) => write(dir, "pages/index.tsx", "// uncovered\n")],
    ["a src/ application directory", "src", (dir) => write(dir, "src/app/page.tsx", "// uncovered\n")],
  ])("fails closed, by name, on %s rather than claiming a complete inventory", (_name, path, arrange) => {
    const dir = richCheckout();
    const elsewhere = mkdtempSync(join(tmpdir(), "aio1210-build-record-outside-"));
    roots.push(elsewhere);
    arrange(dir, elsewhere);
    const failure = expectFailure(() => inventoryRuntimeSources(dir), "source-unsupported");
    expect(failure.message).toContain(path);
    expect(failure.message).not.toContain("outside-content-marker");
  });
});

describe("dev-login build recorder — the build's environment (real child process, synthetic checkout)", () => {
  const SYNTHETIC_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

  it("the spawned build sees a finite synthetic production environment: nothing the caller exported reaches it, and no preload hook runs", () => {
    const dir = richCheckout();
    const hook = hostileHook(dir);
    const command = fakeBuild(dir, { probeEnv: true });

    const record = withAmbient(hostileAmbient(hook.file), () => runRecordedBuild(dir, command));

    expect(record.exitCode).toBe(0);
    const report = readEnvReport(dir);
    // Production, opt-in off, postgres, telemetry and all three schedulers off — whatever was exported.
    expect(report.values).toEqual({
      NODE_ENV: "production",
      AIOS_DEV_LOGIN: "0",
      DB_BACKEND: "postgres",
      NEXT_PUBLIC_DB_BACKEND: "postgres",
      NEXT_TELEMETRY_DISABLED: "1",
      INGEST_POLL_ENABLED: "false",
      GRAPH_PROJECT_ENABLED: "false",
      SOCIAL_JOBS_ENABLED: "false",
    });
    // The synthetic values won; DATABASE_URL is the non-serving stand-in, never the exported one.
    expect(report.digests).toEqual({
      DATABASE_URL: sha256(BUILD_ONLY_DATABASE_URL),
      AUTH_SECRET: sha256(BUILD_ONLY_AUTH_SECRET),
      SECRETS_KEY: sha256(SYNTHETIC_SECRETS_KEY),
      APP_URL: sha256("http://127.0.0.1:9"),
    });
    for (const name of ["PATH", ...PROBE_DIGESTS]) expect(report.presence[name], name).toBe("set");
    // Not inherited at all.
    for (const name of [
      "NODE_OPTIONS",
      "ALLOW_DEV_LOGIN",
      "DATABASE_TEST_URL",
      "NEXT_PUBLIC_AIO1210_MARKER",
      "PGHOST",
      "PGPASSWORD",
      "AIO1210_UNKNOWN_SECRET_MARKER",
    ]) {
      expect(report.presence[name], name).toBe("absent");
    }
    // Explicitly blank (not merely absent): graph, LLM, mail and Sentry endpoints and credentials.
    for (const name of [
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "LLM_BASE_URL",
      "GRAPHITI_URL",
      "NEO4J_URL",
      "NEO4J_PASSWORD",
      "RESEND_API_KEY",
      "SMTP_URL",
    ]) {
      expect(report.presence[name], name).toBe("blank");
    }
    expect(Object.values(report.presence)).not.toContain("hostile");

    // The hook was really there to be loaded, and was not.
    expect(existsSync(hook.file)).toBe(true);
    expect(existsSync(hook.sentinel)).toBe(false);
    // Still the one observed build: it ran, exited 0, and its record is current.
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(true);
    expect(assertBuildRecordCurrent(dir, command).record).toEqual(record);
  });

  it("prints the build's mode and presence only — never a URL, a secret or anything the caller exported", () => {
    const dir = checkout();
    const hook = hostileHook(dir);
    withAmbient(hostileAmbient(hook.file), () => runRecordedBuild(dir, fakeBuild(dir)));

    const lines = loggedLines().filter((line) => line.startsWith("DEV_LOGIN_BUILD_ENV "));
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0].slice("DEV_LOGIN_BUILD_ENV ".length)) as { database: string; env: Record<string, string> };
    expect(printed.database).toBe("build-only-default");
    expect(printed.env).toMatchObject({
      NODE_ENV: "production",
      AIOS_DEV_LOGIN: "0",
      DATABASE_URL: "<set>",
      AUTH_SECRET: "<set>",
      SECRETS_KEY: "<set>",
      APP_URL: "<set>",
      SENTRY_AUTH_TOKEN: "<blank>",
    });
    for (const text of [HOSTILE, BUILD_ONLY_DATABASE_URL, BUILD_ONLY_AUTH_SECRET, "postgres://", "http://"]) {
      expect(lines[0]).not.toContain(text);
    }
  });

  it("the environment is the finite allowlist plus the carrier's explicit keys — no key of the caller's is added", () => {
    const { env, database } = recordedBuildEnv(hostileAmbient("/nonexistent/hostile-hook.cjs"));
    const explicit = Object.keys(recordedBuildEnv({}).env);
    expect(database).toBe("build-only-default");
    expect(Object.keys(env).sort()).toEqual(explicit.sort());
    for (const name of CHILD_ENV_OS_ALLOWLIST) expect(explicit).not.toContain(name);
    expect(JSON.stringify(env)).not.toContain(HOSTILE);
    expect(JSON.stringify(describeChildEnv(env))).not.toContain(BUILD_ONLY_DATABASE_URL);
  });

  it("a validated DATABASE_TEST_URL is the build's only database source: DATABASE_URL is never one", () => {
    const dir = checkout();
    const owned = "postgres://app:app@127.0.0.1:5999/app_test";
    withAmbient(
      { DATABASE_TEST_URL: owned, DATABASE_URL: `postgres://${HOSTILE}:${HOSTILE}@db.example.invalid:5432/production` },
      () => runRecordedBuild(dir, fakeBuild(dir, { probeEnv: true }))
    );
    const report = readEnvReport(dir);
    expect(report.digests.DATABASE_URL).toBe(sha256(owned));
    expect(report.presence.DATABASE_URL).toBe("set");
    expect(report.presence.DATABASE_TEST_URL).toBe("absent");
    expect(loggedLines().some((line) => line.startsWith("DEV_LOGIN_BUILD_ENV ") && line.includes('"database":"DATABASE_TEST_URL"'))).toBe(true);
  });

  it.each([
    ["a remote host", "postgres://app:credential-marker@db.example.invalid:5432/app_test"],
    ["a non-test database", "postgres://app:credential-marker@127.0.0.1:5432/app"],
    ["a connection-parameter override", "postgres://app:credential-marker@127.0.0.1:5432/app_test?host=db.example.invalid"],
  ])("an unsafe DATABASE_TEST_URL (%s) is refused before the build command runs, not replaced or echoed", (_name, unsafe) => {
    const dir = checkout();
    const command = fakeBuild(dir);
    const failure = withAmbient({ DATABASE_TEST_URL: unsafe }, () =>
      expectFailure(() => runRecordedBuild(dir, command), "database-url-unsafe")
    );
    expect(failure.message).not.toContain("credential-marker");
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
    expect(existsSync(join(dir, ".next"))).toBe(false);
  });
});

describe("dev-login build recorder (real child process, synthetic checkout)", () => {
  it("records a build only after watching it exit 0 with the sources unchanged, bound to BUILD_ID and the server JS", () => {
    const { dir, command, record } = recorded();

    expect(record.command).toEqual(command);
    expect(record.exitCode).toBe(0);
    expect(record.sourcesBefore).toEqual(record.sourcesAfter);
    expect(record.sourcesAfter[ROUTE.split(sep).join("/")]).toMatch(/^[0-9a-f]{64}$/);
    expect(record.buildId).toBe("synthetic-build-1");
    expect(record.routeEntry).toBe("app/auth/dev-login/route.js");
    const inventory = inventoryServerJs(dir);
    expect(record.serverJs).toEqual({ files: 2, bytes: inventory.bytes, nonRegular: 0, hash: inventory.hash });

    // The file on disk is that record, and the carrier-side check accepts it for this command.
    expect(readRecord(dir)).toEqual(record);
    const current = assertBuildRecordCurrent(dir, command);
    expect(current.record).toEqual(record);
    expect(current.artifact.buildId).toBe("synthetic-build-1");
    expect(current.serverJs.hash).toBe(record.serverJs.hash);
  });

  it("a failing build leaves no record, even though it left a complete artifact behind", () => {
    const dir = checkout();
    const failure = expectFailure(() => runRecordedBuild(dir, fakeBuild(dir, { exitCode: 3 })), "build-failed");
    expect(failure.message).toContain("status 3");
    // The artifact is all there — only the observed exit status says the build failed.
    expect(readFileSync(join(dir, ".next", "BUILD_ID"), "utf8")).toBe("synthetic-build-1");
    expect(existsSync(recordFile(dir))).toBe(false);
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-missing");
  });

  it("an earlier record does not survive a later failed build that leaves the old artifact in place", () => {
    const { dir } = recorded();
    expect(existsSync(recordFile(dir))).toBe(true);
    expectFailure(() => runRecordedBuild(dir, [process.execPath, "-e", "process.exit(4)"]), "build-failed");
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it("a command that cannot be started is a build failure, not a record", () => {
    const dir = checkout();
    expectFailure(() => runRecordedBuild(dir, ["aio1210-no-such-build-command"]), "build-failed");
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it("a tracked source edited while the build ran is refused: the artifact cannot be attributed to either version", () => {
    const dir = checkout();
    const failure = expectFailure(() => runRecordedBuild(dir, fakeBuild(dir, { editSource: true })), "build-source-changed");
    expect(failure.message).toContain("app/auth/dev-login/route.ts");
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  // The same refusal for inputs the route file never names: what the build imported, a file that
  // appeared or vanished, the lockfile. The stand-in still exits 0 and leaves a complete artifact.
  it.each<[string, string, string]>([
    ["the imported pg pool is edited", POOL, `appendFileSync(${JSON.stringify(POOL)}, "// edited during the build\\n");`],
    ["an imported script is edited", BUILD_IDENTITY, `appendFileSync(${JSON.stringify(BUILD_IDENTITY)}, "// edited during the build\\n");`],
    ["a new source file appears", "lib/db/pg/appeared.ts", 'out("lib/db/pg/appeared.ts", "// appeared during the build\\n");'],
    ["a source file is deleted", READINESS, `rmSync(${JSON.stringify(READINESS)});`],
    ["the lockfile drifts", "package-lock.json", 'appendFileSync("package-lock.json", "\\n");'],
    ["the PostCSS configuration is edited", "postcss.config.mjs", 'appendFileSync("postcss.config.mjs", "// edited during the build\\n");'],
  ])("no record is written when %s while the build runs", (_name, path, statement) => {
    const dir = richCheckout();
    const failure = expectFailure(() => runRecordedBuild(dir, fakeBuild(dir, { during: [statement] })), "build-source-changed");
    expect(failure.message).toContain(path);
    // A successful, complete build — and still nothing creditable.
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(true);
    expect(readFileSync(join(dir, ".next", "BUILD_ID"), "utf8")).toBe("synthetic-build-1");
    expect(existsSync(recordFile(dir))).toBe(false);
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-missing");
  });

  it("an unchanged build of a checkout with the whole inventory records every source, with no Git involved", () => {
    const { dir, command, record } = recorded(richCheckout());
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(record.sourcesBefore).toEqual(record.sourcesAfter);
    for (const rel of [ROUTE.split(sep).join("/"), "package.json", ...RICH_SOURCES]) {
      expect(record.sourcesAfter[rel], rel).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(record.sourcesAfter).toEqual(inventoryRuntimeSources(dir));
    expect(assertBuildRecordCurrent(dir, command).record).toEqual(record);
  });

  it("a source structure the inventory cannot cover is refused before the build command runs", () => {
    const dir = richCheckout();
    const command = fakeBuild(dir);
    symlinkSync(join(dir, "lib", "db"), join(dir, "lib", "db-link"));
    expectFailure(() => runRecordedBuild(dir, command), "source-unsupported");
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it.each([...NEXT_LOADED_ENV_FILES])("a checkout holding %s is refused before the build command runs", (name) => {
    const dir = checkout();
    const command = fakeBuild(dir);
    // A disposable temp checkout, never the task checkout; the file is empty and never read.
    writeFileSync(join(dir, name), "");
    const failure = expectFailure(() => runRecordedBuild(dir, command), "env-file-present");
    expect(failure.message).toContain(name);
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
    expect(existsSync(join(dir, ".next"))).toBe(false);
  });

  it("a checkout holding only .env.example builds and records", () => {
    const dir = checkout();
    writeFileSync(join(dir, ".env.example"), "");
    expect(runRecordedBuild(dir, fakeBuild(dir)).exitCode).toBe(0);
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(true);
  });

  it("a directory that is not the task root is refused before the build command runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "aio1210-build-record-"));
    roots.push(dir);
    expectFailure(() => runRecordedBuild(dir, fakeBuild(dir)), "wrong-cwd");
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
  });
});

describe("dev-login carrier build-record check (read-only, synthetic checkout)", () => {
  it("a complete artifact nobody recorded is refused: its mere presence proves nothing about its sources", () => {
    const dir = checkout();
    const [file, ...args] = fakeBuild(dir);
    expect(spawnSync(file, args, { cwd: dir }).status).toBe(0);
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-missing");
  });

  it("the carrier accepts only a record of the ordinary build command", () => {
    const { dir, command } = recorded();
    expect(command).not.toEqual([...BUILD_RECORD_COMMAND]);
    expect(() => assertBuildRecordCurrent(dir, command)).not.toThrow();
    // With no command passed — as the carrier calls it — a stand-in build's record is not creditable.
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-invalid");
  });

  it.each<[string, (dir: string) => void, string]>([
    ["a tracked source edited since the build", (dir) => appendFileSync(join(dir, ROUTE), "// edited later\n"), "app/auth/dev-login/route.ts"],
    ["a tracked source deleted since the build", (dir) => rmSync(join(dir, "package.json")), "package.json"],
    ["a different BUILD_ID", (dir) => write(dir, ".next/BUILD_ID", "synthetic-build-2"), "BUILD_ID"],
    ["a changed route entry", (dir) => write(dir, ".next/server/app/auth/dev-login/route.js", "// other entry\n"), "entry"],
    ["a changed server chunk", (dir) => write(dir, ".next/server/chunks/handler.js", "// other chunk\n"), "server JS inventory"],
    ["an added server chunk", (dir) => write(dir, ".next/server/chunks/extra.js", "// extra\n"), "server JS inventory"],
    ["a removed server chunk", (dir) => rmSync(join(dir, ".next/server/chunks/handler.js")), "server JS inventory"],
  ])("a record is stale after %s", (_name, mutate, names) => {
    const { dir, command } = recorded();
    expect(() => assertBuildRecordCurrent(dir, command)).not.toThrow();
    mutate(dir);
    expect(expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-stale").message).toContain(names);
  });

  it("a record stays current across changes it does not cover: a source map, dev output, a generated file", () => {
    const { dir, command, record } = recorded();
    write(dir, ".next/server/chunks/handler.js.map", '{"changed":true}');
    write(dir, ".next/dev/server/chunks/handler.js", "// dev output\n");
    write(dir, "next-env.d.ts", "// generated\n");
    expect(assertBuildRecordCurrent(dir, command).record).toEqual(record);
  });

  it.each<[string, (record: BuildRecord) => unknown]>([
    ["a non-zero exit status", (record) => ({ ...record, exitCode: 1 })],
    ["sources that differ across the build", (record) => ({ ...record, sourcesBefore: { ...record.sourcesBefore, "package.json": "0".repeat(64) } })],
    ["another schema", (record) => ({ ...record, schema: 2 })],
    ["no exit status at all", (record) => ({ ...record, exitCode: undefined })],
    ["a success flag instead of observations", () => ({ schema: 1, ok: true, success: true })],
  ])("a record claiming %s is refused, not trusted", (_name, edit) => {
    const { dir, command, record } = recorded();
    writeFileSync(recordFile(dir), JSON.stringify(edit(record)));
    expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-invalid");
  });

  it("an unreadable record is refused", () => {
    const { dir, command } = recorded();
    writeFileSync(recordFile(dir), "not json");
    expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-invalid");
  });

  it("a record copied onto another checkout's identical artifact does not attribute it to different sources", () => {
    const built = recorded();
    const other = checkout();
    appendFileSync(join(other, ROUTE), "// a different source\n");
    const [file, ...args] = fakeBuild(other);
    expect(spawnSync(file, args, { cwd: other }).status).toBe(0);
    writeFileSync(recordFile(other), JSON.stringify({ ...built.record, command: fakeBuild(other) }));

    const failure = expectFailure(() => assertBuildRecordCurrent(other, fakeBuild(other)), "build-record-stale");
    expect(failure.message).toContain("app/auth/dev-login/route.ts");
  });
});
