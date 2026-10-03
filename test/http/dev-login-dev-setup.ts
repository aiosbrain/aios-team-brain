import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { scrubbedEnv } from "../../scripts/test-env-scrub";

/**
 * TEST-ONLY support for the AIO-1210 dev-login wire carrier (`vitest.dev-login.config.ts` →
 * `test/http/dev-login.dev-http.test.ts`). Never imported by product code, and separate from the
 * ordinary HTTP tier: that tier keeps `global-setup.ts`, its one shared `next start` server and its
 * inherited environment untouched.
 *
 * What lives here:
 *   - the PREFLIGHT (default export, run as the carrier's global setup): refuse before any spawn when
 *     the checkout holds a Next-loaded env file, the synthetic database URL is absent/unsafe, there is
 *     no production build to consume, or that build has no CURRENT build record. The carrier never
 *     builds, copies or reuses an artifact itself: the record is written by the separate recorder
 *     (`dev-login-build-record.ts`, `npm run test:http:dev-login:build`) and only READ here.
 *   - the child ENVIRONMENT: a finite OS allowlist plus explicit synthetic values. Nothing ambient is
 *     inherited, so a developer shell exporting a provider key, a scheduler switch, an opt-in or
 *     NODE_OPTIONS cannot reach a child.
 *   - the child LIFECYCLE: one owned, loopback-bound `next start` / `next dev` process group on an
 *     allocated port, with a finite readiness deadline and a bounded stop on every outcome.
 *   - the raw CLIENT: `node:http` to the literal 127.0.0.1 and the owned port with an explicit Host
 *     header, so the Host under test is whatever the test says and redirects are never followed.
 *
 * A failed start is a named SETUP_FAILURE — never a skip, an auth denial, or evidence about the route.
 * The carrier never stops, signals or attaches to a server it did not start.
 *
 * This module must not import vitest's runtime: the global setup loads it in Vitest's main process.
 */

export const LOOPBACK = "127.0.0.1";

export type SetupFailureKind =
  | "wrong-cwd"
  | "env-file-present"
  | "database-url-missing"
  | "database-url-unsafe"
  | "build-missing"
  | "build-failed"
  | "build-source-changed"
  | "build-record-missing"
  | "build-record-invalid"
  | "build-record-stale"
  | "port-in-use"
  | "held-lock"
  | "child-exited"
  | "not-ready"
  | "cleanup-failed";

export class DevLoginSetupFailure extends Error {
  readonly kind: SetupFailureKind;
  constructor(kind: SetupFailureKind, detail: string) {
    super(`SETUP_FAILURE[${kind}]: ${detail}`);
    this.name = "DevLoginSetupFailure";
    this.kind = kind;
  }
}

// ── env-file preflight ──────────────────────────────────────────────────────────────────────────

/**
 * The closed union of files Next loads into `process.env` (installed guide
 * `01-app/02-guides/environment-variables.md`, "Environment Variable Load Order":
 * `.env.$(NODE_ENV).local`, `.env.local`, `.env.$(NODE_ENV)`, `.env`, for the three allowed modes).
 * Exact names, not a `.env*` glob: `.env.example` is tracked documentation and must not block.
 */
export const NEXT_LOADED_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
] as const;

/** Pure directory inspection: entry NAMES only — a file's contents are never opened. */
export function findNextEnvFiles(dir: string): string[] {
  const loaded = new Set<string>(NEXT_LOADED_ENV_FILES);
  return readdirSync(dir)
    .filter((name) => loaded.has(name))
    .sort();
}

/**
 * Refuse a checkout that holds any Next-loaded env file. Next reads `process.env` first and fills
 * whatever is ABSENT from these files, so a present file could re-supply an opt-in, a mode or a
 * credential the carrier deliberately left out. The carrier never deletes one: a configured
 * developer checkout must use a separate clean copy.
 */
export function assertNoNextEnvFiles(dir: string): void {
  const present = findNextEnvFiles(dir);
  if (present.length > 0) {
    throw new DevLoginSetupFailure(
      "env-file-present",
      `the checkout holds Next-loaded env file(s): ${present.join(", ")}. This carrier runs only in CI ` +
        "or a clean task-owned checkout; use a separate clean copy rather than deleting them."
    );
  }
}

// ── synthetic database URL ──────────────────────────────────────────────────────────────────────

const LOOPBACK_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface SyntheticDatabase {
  url: string;
  hostClass: "loopback";
  database: string;
}

/** A raw ASCII control character, space or DEL (U+0000–U+0020, U+007F). Char codes, not a regex. */
function hasRawAsciiControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The carrier's ONLY database source is DATABASE_TEST_URL. It never falls back to DATABASE_URL, and
 * it accepts only an owned LOOPBACK Postgres whose database name ends in `_test`. Refusal messages
 * never echo the URL: it carries credentials.
 *
 * Loopback only, in CI too, and whatever the ambient environment says: the HTTP job that runs this
 * carrier publishes its service on localhost:5434, so no service-hostname exception is needed here.
 * The data-mechanics tier's `postgres:5432` service contract belongs to that tier's own config
 * (vitest.datamechanics.config.ts) and is untouched; it is simply not a wire-carrier database.
 *
 * The URL must be PLAIN — no query string and no fragment. The value returned here is handed raw to
 * `pg` (the fixture client and, as DATABASE_URL, every child's pool), and the installed
 * pg-connection-string 2.14 copies every query parameter into the connection config BEFORE it reads
 * the URL's own host and port (`index.js`: `searchParams` loop, then `if (!config.host)` /
 * `if (!config.port)`). So `…@127.0.0.1/app_test?host=elsewhere` passes a hostname check and connects
 * elsewhere. The whole query is refused rather than stripped or key-filtered: the checks below
 * describe the connection only when nothing after the path can re-describe it.
 *
 * It must also hold no RAW ASCII control character, space or DEL (U+0000–U+0020, U+007F), refused
 * BEFORE any URL parsing, because the two parsers read those characters differently. WHATWG
 * `new URL` trims leading/trailing C0-or-space and drops tabs and newlines anywhere; the installed
 * pg-connection-string instead `encodeURI`s a value holding a literal space and resolves the result
 * against `postgres://base`. So ` postgres://…@127.0.0.1/app_test` reads as loopback here yet reaches
 * `pg` as host `base`, and a trailing space names a different database than the one checked.
 * Percent-encoded bytes (`%20` in a credential) are untouched by both parsers and stay supported.
 */
export function validateSyntheticDatabaseUrl(raw: string | undefined): SyntheticDatabase {
  if (!raw) {
    throw new DevLoginSetupFailure(
      "database-url-missing",
      "DATABASE_TEST_URL is required (the task-owned synthetic Postgres). Refusing to start — there is " +
        "no fallback to DATABASE_URL."
    );
  }
  const unsafe = (reason: string) =>
    new DevLoginSetupFailure("database-url-unsafe", `DATABASE_TEST_URL ${reason}. Refusing to start.`);

  if (hasRawAsciiControlOrSpace(raw)) {
    throw unsafe(
      "holds a raw space or control character (this carrier accepts only a plain URL: percent-encode " +
        "such a byte, and remove any surrounding whitespace)"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unsafe("is not a parseable URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw unsafe("is not a postgres:// URL");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw unsafe(
      "carries a query string or fragment (this carrier accepts only a plain URL: connection parameters " +
        "after the database name are not allowed)"
    );
  }
  if (!LOOPBACK_DATABASE_HOSTS.has(parsed.hostname)) {
    throw unsafe("does not point at an owned loopback Postgres");
  }
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw unsafe("has an undecodable database name");
  }
  if (!/_test$/.test(database)) {
    throw unsafe("does not name a dedicated test database (the name must end in `_test`)");
  }
  return { url: raw, hostClass: "loopback", database };
}

// ── child environment ───────────────────────────────────────────────────────────────────────────

/** The ONLY ambient variables a child may receive: what the OS / Node / Next need to run at all. */
export const CHILD_ENV_OS_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "CI",
] as const;

/**
 * Transports and credentials set to "" on top of the shared scrub policy (scripts/test-env-scrub).
 * Blank rather than absent: Next stops at a variable `process.env` already defines.
 */
const EXTRA_BLANKED = [
  "GRAPHITI_URL",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "ANTHROPIC_BASE_URL",
  "RESEND_FROM",
  "SMTP_FROM",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
];

/** Fixed test key for integration-secret crypto (the same non-secret the other tiers use). */
const SYNTHETIC_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

export interface ChildEnvSpec {
  /** Runtime NODE_ENV, set explicitly before spawn. */
  nodeEnv: "production" | "development";
  /** AIOS_DEV_LOGIN, always explicit on the wire ("missing" is a direct-handler case). */
  devLoginOptIn: "0" | "1";
  /** Also set the obsolete ALLOW_DEV_LOGIN=1 escape (production hard-off negative coverage). */
  obsoleteAllowDevLogin?: boolean;
  /** The validated synthetic database URL. */
  databaseUrl: string;
  /** Synthetic per-child session-signing secret (>=16 chars). */
  authSecret: string;
  port: number;
}

export function buildChildEnv(spec: ChildEnvSpec, ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_OS_ALLOWLIST) {
    const value = ambient[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  // The scrub is derived from an EMPTY base: only its fixed list applies, never the ambient keys.
  Object.assign(env, scrubbedEnv({}), Object.fromEntries(EXTRA_BLANKED.map((name) => [name, ""])), {
    NODE_ENV: spec.nodeEnv,
    AIOS_DEV_LOGIN: spec.devLoginOptIn,
    DB_BACKEND: "postgres",
    NEXT_PUBLIC_DB_BACKEND: "postgres",
    DATABASE_URL: spec.databaseUrl,
    AUTH_SECRET: spec.authSecret,
    SECRETS_KEY: SYNTHETIC_SECRETS_KEY,
    APP_URL: `http://${LOOPBACK}:${spec.port}`,
    NEXT_TELEMETRY_DISABLED: "1",
    // All three in-process schedulers off (instrumentation.ts): the children must not poll or project.
    INGEST_POLL_ENABLED: "false",
    GRAPH_PROJECT_ENABLED: "false",
    SOCIAL_JOBS_ENABLED: "false",
  });
  if (spec.obsoleteAllowDevLogin) env.ALLOW_DEV_LOGIN = "1";
  return env;
}

/** Values safe to print as evidence; every other variable is reported by presence only. */
const PRINTABLE_ENV = new Set([
  "NODE_ENV",
  "AIOS_DEV_LOGIN",
  "ALLOW_DEV_LOGIN",
  "DB_BACKEND",
  "NEXT_PUBLIC_DB_BACKEND",
  "NEXT_TELEMETRY_DISABLED",
  "INGEST_POLL_ENABLED",
  "GRAPH_PROJECT_ENABLED",
  "SOCIAL_JOBS_ENABLED",
  "CI",
]);

export function describeChildEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((name) => [name, PRINTABLE_ENV.has(name) ? env[name] : env[name] === "" ? "<blank>" : "<set>"])
  );
}

// ── raw loopback client ─────────────────────────────────────────────────────────────────────────

export interface WireResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  location: string | null;
  cacheControl: string | null;
  setCookie: string[];
  /** The peer this request actually connected to — the literal loopback address and owned port. */
  remoteAddress: string | undefined;
  remotePort: number | undefined;
}

export interface RawGetOptions {
  port: number;
  path: string;
  /** Sent exactly as given. Must include `host`: Node would otherwise invent one from the socket. */
  headers: Record<string, string>;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * One bounded GET over a real socket to 127.0.0.1:<port>. `setHost: false` delivers the caller's
 * Host header verbatim, so a non-local Host still travels only to the owned loopback listener.
 * `node:http` never follows a redirect. A header value the client itself refuses to send rejects
 * here — an invalid client construction is not a route refusal.
 */
export function rawGet(opts: RawGetOptions): Promise<WireResponse> {
  const { port, path, headers, timeoutMs = 60_000 } = opts;
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) {
    return Promise.reject(new Error("rawGet requires an explicit Host header"));
  }
  return new Promise<WireResponse>((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: LOOPBACK,
        family: 4,
        port,
        method: "GET",
        path,
        headers: { ...headers, connection: "close" },
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const remoteAddress = res.socket.remoteAddress;
        const remotePort = res.socket.remotePort;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`rawGet: response body exceeded ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        res.on("end", () => {
          clearTimeout(timer);
          const one = (value: string | string[] | undefined): string | null =>
            value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            location: one(res.headers.location),
            cacheControl: one(res.headers["cache-control"]),
            setCookie: res.headers["set-cookie"] ?? [],
            remoteAddress,
            remotePort,
          });
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`rawGet: no complete response from ${LOOPBACK}:${port} within ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/** Directive tokens of a Cache-Control value: lower-cased, argument-free, order preserved. */
export function cacheControlDirectives(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().split("=")[0].trim().toLowerCase())
    .filter((part) => part !== "");
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  /** Attribute names lower-cased; a valueless attribute (HttpOnly, Secure) is `true`. */
  attributes: Record<string, string | true>;
}

export function parseSetCookie(line: string): ParsedSetCookie {
  const [pair, ...rest] = line.split(";");
  const eq = pair.indexOf("=");
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
  const rawValue = eq === -1 ? "" : pair.slice(eq + 1).trim();
  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    // not percent-encoded — keep the raw value
  }
  const attributes: Record<string, string | true> = {};
  for (const part of rest) {
    const at = part.indexOf("=");
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
    if (key === "") continue;
    attributes[key] = at === -1 ? true : part.slice(at + 1).trim();
  }
  return { name, value, attributes };
}

// ── ports ───────────────────────────────────────────────────────────────────────────────────────

/** Ask the OS for a free loopback port. The child then binds it explicitly (no port retry). */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
  });
}

export function loopbackPortAccepts(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: LOOPBACK, port, family: 4 });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolvePromise(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ── owned child lifecycle ───────────────────────────────────────────────────────────────────────

export interface CleanupRecord {
  label: string;
  pid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when SIGTERM was not enough and the owned process group was killed. */
  forced: boolean;
  portClosed: boolean;
}

export interface ChildRecord {
  label: string;
  command: "start" | "dev";
  /** CLI arguments after the Next binary: mode, binding and port exactly as launched. */
  args: string[];
  pid: number;
  port: number;
  env: Record<string, string>;
  /** Next's own "- Local:" startup line, when it printed one. */
  localLine: string | null;
  readyAfterMs: number;
}

export interface OwnedChild {
  label: string;
  command: "start" | "dev";
  port: number;
  pid: number;
  /** The exact environment passed to spawn (synthetic values only). */
  env: Record<string, string>;
  /** ANSI-stripped stdout+stderr captured so far. */
  output(): string;
  alive(): boolean;
  record(): ChildRecord;
  stop(): Promise<CleanupRecord>;
}

export interface StartChildOptions {
  label: string;
  /** `start` serves the existing production build; `dev` is the development server (.next/dev). */
  command: "start" | "dev";
  env: Record<string, string>;
  port: number;
  cwd?: string;
  readyTimeoutMs?: number;
}

const OUTPUT_CAP_BYTES = 1024 * 1024;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Children this process started and has not yet confirmed stopped. */
const owned = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort for an abnormal worker exit: a still-unreaped child is ours by construction (its
  // ChildProcess has not emitted `exit`), so its pid cannot have been reused.
  process.once("exit", () => {
    for (const child of owned) {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * Start ONE owned Next child bound to 127.0.0.1 on `port` and wait (finitely) until its own
 * `/api/health` answers 200 — the database-backed readiness route, never the session-minting GET.
 * Mode and environment are fixed before spawn; a running server cannot be re-configured by toggling
 * the parent's env. An explicit `--port` disables Next's dev port retry, so the child either owns
 * the allocated port or exits.
 */
export async function startNextChild(opts: StartChildOptions): Promise<OwnedChild> {
  const { label, command, env, port } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const readyTimeoutMs = opts.readyTimeoutMs ?? (command === "dev" ? 180_000 : 60_000);
  const nextBin = join(cwd, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) {
    throw new DevLoginSetupFailure("wrong-cwd", `${label}: no installed Next binary under the working directory`);
  }
  if (await loopbackPortAccepts(port)) {
    throw new DevLoginSetupFailure(
      "port-in-use",
      `${label}: ${LOOPBACK}:${port} is already serving. Refusing to attach to a server this carrier did not start.`
    );
  }

  const args = [command, "--hostname", LOOPBACK, "--port", String(port)];
  const startedAt = Date.now();
  // detached: the child leads its own process group, so `next dev`'s forked server is stopped with it.
  const child = spawn(process.execPath, [nextBin, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  installExitHook();
  owned.add(child);

  let raw = "";
  const capture = (chunk: Buffer) => {
    raw = (raw + chunk.toString("utf8")).slice(-OUTPUT_CAP_BYTES);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const secrets = [env.AUTH_SECRET, env.DATABASE_URL].filter((s): s is string => typeof s === "string" && s !== "");
  const output = (): string => {
    let text = raw.replace(ANSI, "");
    for (const secret of secrets) text = text.split(secret).join("<redacted>");
    return text;
  };
  const tail = (): string => output().slice(-2000);

  let stopped: Promise<CleanupRecord> | null = null;
  const stop = (): Promise<CleanupRecord> => {
    stopped ??= (async () => {
      const pid = child.pid;
      if (pid === undefined) {
        owned.delete(child);
        return { label, pid: -1, exitCode: null, signal: null, forced: false, portClosed: true };
      }
      let forced = false;
      if (!exited) {
        signalGroup(pid, "SIGTERM");
        if (!(await waitUntil(() => exited, 10_000))) {
          forced = true;
          signalGroup(pid, "SIGKILL");
          if (!(await waitUntil(() => exited, 5_000))) {
            throw new DevLoginSetupFailure("cleanup-failed", `${label}: owned child ${pid} did not exit after SIGKILL`);
          }
        }
      }
      // `next dev` serves from a forked worker in the same group: the port, not the parent's exit, is
      // the evidence that the listener is gone.
      let portClosed = await waitUntil(async () => !(await loopbackPortAccepts(port, 500)), 5_000, 200);
      if (!portClosed) {
        forced = true;
        signalGroup(pid, "SIGKILL");
        portClosed = await waitUntil(async () => !(await loopbackPortAccepts(port, 500)), 5_000, 200);
      }
      owned.delete(child);
      if (!portClosed) {
        throw new DevLoginSetupFailure(
          "cleanup-failed",
          `${label}: owned port ${port} is still accepting connections after the process group was killed`
        );
      }
      const cleanup: CleanupRecord = {
        label,
        pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
        forced,
        portClosed,
      };
      console.log(`DEV_LOGIN_CHILD_CLEANUP_OK ${JSON.stringify(cleanup)}`);
      return cleanup;
    })();
    return stopped;
  };

  const fail = async (kind: SetupFailureKind, detail: string): Promise<never> => {
    const context = tail();
    try {
      await stop();
    } catch {
      // the start failure is the one to report
    }
    throw new DevLoginSetupFailure(kind, `${label} (next ${command}, port ${port}): ${detail}\n--- child output tail ---\n${context}`);
  };

  const exitKind = (): SetupFailureKind => {
    const text = output();
    // Installed Next 16.3: setup-dev-bundler.js:162 → build/lockfile.js acquireWithRetriesOrExit.
    if (/Another .*next dev.* server is already running/.test(text)) return "held-lock";
    if (/EADDRINUSE/.test(text)) return "port-in-use";
    return "child-exited";
  };

  const deadline = startedAt + readyTimeoutMs;
  let lastStatus: number | null = null;
  let lastError = "";
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) return fail("child-exited", `spawn failed: ${(spawnError as Error).message}`);
    if (exited) {
      return fail(
        exitKind(),
        `exited before ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)}). ` +
          "A dev/build lock held by another process is never broken and that process is never stopped."
      );
    }
    try {
      const res = await rawGet({
        port,
        path: "/api/health",
        headers: { host: `${LOOPBACK}:${port}` },
        timeoutMs: Math.max(1000, Math.min(15_000, deadline - Date.now())),
      });
      lastStatus = res.status;
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  if (!ready) {
    return fail(
      "not-ready",
      `/api/health did not answer 200 within ${readyTimeoutMs}ms (last status ${String(lastStatus)}, last error "${lastError}")`
    );
  }
  if (exited || child.pid === undefined) {
    return fail(exitKind(), "the owned child exited while the port answered — refusing to credit another listener");
  }

  const pid = child.pid;
  const readyAfterMs = Date.now() - startedAt;
  const record = (): ChildRecord => ({
    label,
    command,
    args,
    pid,
    port,
    env: describeChildEnv(env),
    localLine:
      output()
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /Local:/.test(line)) ?? null,
    readyAfterMs,
  });
  console.log(`DEV_LOGIN_CHILD_READY ${JSON.stringify(record())}`);

  return {
    label,
    command,
    port,
    pid,
    env,
    output,
    alive: () => !exited,
    record,
    stop,
  };
}

// ── build / source provenance ───────────────────────────────────────────────────────────────────

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export interface ProductionArtifact {
  buildId: string;
  buildIdMtimeMs: number;
  /** `server/app-paths-manifest.json` entry for `/auth/dev-login/route`. */
  routeEntry: string;
  /** True when the build prerendered the route (it must not: the route is dynamic, ƒ). */
  prerendered: boolean;
  /** sha256 over BUILD_ID, the route's manifests and its compiled entry. */
  fingerprint: string;
}

const DEV_LOGIN_APP_PATH = "/auth/dev-login/route";

/** The package's ordinary build, exactly as CI runs it — the only command a build record may name. */
export const BUILD_RECORD_COMMAND: readonly string[] = ["npm", "run", "build"];
/** Inside `.next`, which `next build` clears first: a rebuild by any route removes the old record. */
export const BUILD_RECORD_FILE = join(".next", "aio1210-dev-login-build-record.json");
const BUILD_RECORDER = "npm run test:http:dev-login:build";

const missingBuild = (what: string) =>
  new DevLoginSetupFailure(
    "build-missing",
    `${what}. Run a successful \`${BUILD_RECORDER}\` from canonical bytes first; this carrier never builds or copies one.`
  );

/**
 * Read (never write) the production build this carrier consumes. A missing or incomplete build is
 * a SETUP_FAILURE: the carrier does not build, copy or reuse an artifact on its own.
 */
export function readProductionArtifact(cwd: string = process.cwd()): ProductionArtifact {
  const dist = join(cwd, ".next");
  const missing = missingBuild;
  const buildIdPath = join(dist, "BUILD_ID");
  if (!existsSync(buildIdPath)) throw missing("no production build (.next/BUILD_ID)");
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  if (buildId === "") throw missing("the production BUILD_ID is empty");

  const manifestRel = join("server", "app-paths-manifest.json");
  if (!existsSync(join(dist, manifestRel))) throw missing("the production build has no server/app-paths-manifest.json");
  const manifest = JSON.parse(readFileSync(join(dist, manifestRel), "utf8")) as Record<string, string>;
  const routeEntry = manifest[DEV_LOGIN_APP_PATH];
  if (typeof routeEntry !== "string") throw missing(`the production build has no ${DEV_LOGIN_APP_PATH} entry`);
  const entryRel = join("server", routeEntry);
  if (!existsSync(join(dist, entryRel))) throw missing(`the production build is missing ${entryRel}`);

  const prerenderRel = "prerender-manifest.json";
  if (!existsSync(join(dist, prerenderRel))) throw missing("the production build has no prerender-manifest.json");
  const prerender = JSON.parse(readFileSync(join(dist, prerenderRel), "utf8")) as { routes?: Record<string, unknown> };

  const hash = createHash("sha256");
  for (const rel of ["BUILD_ID", manifestRel, entryRel, prerenderRel]) {
    hash.update(`${rel}\0${sha256(readFileSync(join(dist, rel)))}\n`);
  }
  return {
    buildId,
    buildIdMtimeMs: statSync(buildIdPath).mtimeMs,
    routeEntry,
    prerendered: Object.keys(prerender.routes ?? {}).includes("/auth/dev-login"),
    fingerprint: hash.digest("hex"),
  };
}

export interface ServerJsInventory {
  /** Regular `.js` files under `.next/server`. */
  files: number;
  bytes: number;
  /** Entries that are neither a directory nor a regular file: named, never followed or read. */
  nonRegular: number;
  /** sha256 over the sorted `<path>\0<content sha256>` lines. */
  hash: string;
  /** Content hash per POSIX path relative to `.next/server`. */
  entries: Record<string, string>;
}

const NON_REGULAR = "<non-regular>";

/**
 * Every JavaScript file the production build emitted for the server — route entries, the runtime
 * and all chunks — with a content hash each. The route's own entry can be a thin loader whose
 * handler lives in shared chunks, so the entry hash in `readProductionArtifact` does not pin the
 * handler's bytes on its own; this does. Deterministic: paths are sorted by code unit, whatever
 * order the directory lists them in. Source maps are not read (`*.js.map` is not `*.js`), and a dev
 * server's output is under `.next/dev`, outside `.next/server`, so it can never enter. Read-only.
 */
export function inventoryServerJs(cwd: string = process.cwd()): ServerJsInventory {
  const root = join(cwd, ".next", "server");
  if (!existsSync(root)) throw missingBuild("no production server output (.next/server)");
  const found: [string, string][] = [];
  let files = 0;
  let bytes = 0;
  let nonRegular = 0;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (!entry.isFile()) {
        nonRegular += 1;
        found.push([child, NON_REGULAR]);
      } else if (entry.name.endsWith(".js")) {
        const data = readFileSync(join(root, child));
        files += 1;
        bytes += data.length;
        found.push([child, sha256(data)]);
      }
    }
  };
  walk("");
  found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const [rel, digest] of found) hash.update(`${rel}\0${digest}\n`);
  return { files, bytes, nonRegular, hash: hash.digest("hex"), entries: Object.fromEntries(found) };
}

/** Keys whose value differs between two hash maps (changed, added or removed), sorted and bounded. */
export function changedKeys(before: Record<string, string>, after: Record<string, string>, limit = 20): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort()
    .slice(0, limit);
}

/** Tracked sources whose bytes decide what the children run. Recorded before and after the run. */
export const RUNTIME_SOURCE_FILES = [
  "app/auth/dev-login/route.ts",
  "lib/auth/pg-login.ts",
  "lib/auth/pg-session.ts",
  "lib/auth/next-path.ts",
  "proxy.ts",
  "instrumentation.ts",
  "next.config.ts",
  "tsconfig.json",
  "package.json",
] as const;

/** Files Next generates on `dev`/`build`; reported separately, never folded into the source record. */
export const GENERATED_FILES = ["next-env.d.ts"] as const;

export function fingerprintFiles(cwd: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((rel) => {
      const path = join(cwd, rel);
      return [rel, existsSync(path) ? sha256(readFileSync(path)) : "<absent>"];
    })
  );
}

export function assertTaskRoot(cwd: string): void {
  if (!existsSync(join(cwd, "app", "auth", "dev-login", "route.ts"))) {
    throw new DevLoginSetupFailure("wrong-cwd", "run the carrier with cwd set to the task worktree root");
  }
}

// ── build record (read-only here; written by dev-login-build-record.ts) ─────────────────────────

/**
 * What the recorder OBSERVED around one run of the build command — not a success flag. It is written
 * only after that command exited 0 with the tracked runtime sources byte-identical before and after,
 * and it binds those source hashes to the BUILD_ID and server output the command left behind.
 */
export interface BuildRecord {
  schema: 1;
  /** The command the recorder ran, verbatim. */
  command: string[];
  /** The exit status the recorder observed from that command. */
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  sourcesBefore: Record<string, string>;
  sourcesAfter: Record<string, string>;
  generatedBefore: Record<string, string>;
  generatedAfter: Record<string, string>;
  buildId: string;
  routeEntry: string;
  artifactFingerprint: string;
  serverJs: { files: number; bytes: number; nonRegular: number; hash: string };
}

const isHashMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

function parseBuildRecord(text: string): BuildRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<BuildRecord>;
  const serverJs: unknown = record.serverJs;
  const wellFormed =
    record.schema === 1 &&
    Array.isArray(record.command) &&
    record.command.every((part) => typeof part === "string") &&
    typeof record.exitCode === "number" &&
    isHashMap(record.sourcesBefore) &&
    isHashMap(record.sourcesAfter) &&
    typeof record.buildId === "string" &&
    typeof record.routeEntry === "string" &&
    typeof record.artifactFingerprint === "string" &&
    typeof serverJs === "object" &&
    serverJs !== null &&
    typeof (serverJs as { hash?: unknown }).hash === "string";
  return wellFormed ? (value as BuildRecord) : null;
}

export interface CurrentBuild {
  record: BuildRecord;
  artifact: ProductionArtifact;
  serverJs: ServerJsInventory;
  sources: Record<string, string>;
}

/**
 * Refuse unless the production build in `cwd` carries a build record that still describes it AND
 * the checkout: the record's own claims are re-checked (the ordinary build command, exit 0, sources
 * identical across the build), then compared with the tracked sources, BUILD_ID, route artifact and
 * server JS inventory as they are NOW. Read-only; `expectedCommand` exists for the recorder's own
 * stand-in tests and is never passed by the carrier.
 */
export function assertBuildRecordCurrent(
  cwd: string = process.cwd(),
  expectedCommand: readonly string[] = BUILD_RECORD_COMMAND
): CurrentBuild {
  const artifact = readProductionArtifact(cwd);
  const rebuild = `Rebuild with \`${BUILD_RECORDER}\`; this carrier never builds or copies one.`;
  const path = join(cwd, BUILD_RECORD_FILE);
  if (!existsSync(path)) {
    throw new DevLoginSetupFailure(
      "build-record-missing",
      `the production build has no build record (${BUILD_RECORD_FILE}), so nothing ties it to the current sources. ${rebuild}`
    );
  }
  const invalid = (why: string) =>
    new DevLoginSetupFailure("build-record-invalid", `the build record ${why}. ${rebuild}`);
  const record = parseBuildRecord(readFileSync(path, "utf8"));
  if (!record) throw invalid("is not a readable schema-1 record");
  if (record.command.join("\0") !== expectedCommand.join("\0")) {
    throw invalid(`is not for the ordinary build command \`${expectedCommand.join(" ")}\``);
  }
  if (record.exitCode !== 0) throw invalid(`reports exit status ${record.exitCode}, not 0`);
  const duringBuild = changedKeys(record.sourcesBefore, record.sourcesAfter);
  if (duringBuild.length > 0) throw invalid(`reports sources that changed during the build: ${duringBuild.join(", ")}`);

  const stale = (why: string) =>
    new DevLoginSetupFailure("build-record-stale", `the build record no longer describes this checkout: ${why}. ${rebuild}`);
  const sources = fingerprintFiles(cwd, RUNTIME_SOURCE_FILES);
  const sinceBuild = changedKeys(record.sourcesAfter, sources);
  if (sinceBuild.length > 0) throw stale(`source(s) changed since the build: ${sinceBuild.join(", ")}`);
  if (artifact.buildId !== record.buildId) throw stale("BUILD_ID differs from the recorded build");
  if (artifact.fingerprint !== record.artifactFingerprint) throw stale("the route's manifests or entry differ from the recorded build");
  const serverJs = inventoryServerJs(cwd);
  if (serverJs.hash !== record.serverJs.hash) {
    throw stale(
      `the server JS inventory differs from the recorded build (${serverJs.files} files now, ${record.serverJs.files} recorded)`
    );
  }
  return { record, artifact, serverJs, sources };
}

// ── global setup: the preflight ─────────────────────────────────────────────────────────────────

/**
 * Runs once in Vitest's main process before any test worker or child exists. Pure inspection: it
 * spawns nothing and connects to nothing. Any refusal here aborts the run with a SETUP_FAILURE.
 */
export default async function devLoginCarrierPreflight(): Promise<() => Promise<void>> {
  const cwd = process.cwd();
  assertTaskRoot(cwd);
  assertNoNextEnvFiles(cwd);
  const database = validateSyntheticDatabaseUrl(process.env.DATABASE_TEST_URL);
  const { record, artifact, serverJs, sources } = assertBuildRecordCurrent(cwd);
  console.log(
    `DEV_LOGIN_CARRIER_PREFLIGHT_OK ${JSON.stringify({
      envFilesPresent: [],
      database: { hostClass: database.hostClass, name: database.database },
      buildId: artifact.buildId,
      routeEntry: artifact.routeEntry,
      artifactFingerprint: artifact.fingerprint,
      serverJs: { files: serverJs.files, bytes: serverJs.bytes, nonRegular: serverJs.nonRegular, hash: serverJs.hash },
      buildRecord: {
        command: record.command,
        exitCode: record.exitCode,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
      sources,
      generated: fingerprintFiles(cwd, GENERATED_FILES),
    })}`
  );
  return async () => {
    console.log("DEV_LOGIN_CARRIER_TEARDOWN_OK");
  };
}
