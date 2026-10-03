import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { extname, join } from "node:path";
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
 *     NODE_OPTIONS cannot reach a child. The recorder's build child is given the same construction.
 *   - the child LIFECYCLE: one owned, loopback-bound `next start` / `next dev` process group on an
 *     allocated port, with a finite readiness deadline and a bounded stop on every outcome — a
 *     SIGINT/SIGTERM sent to THIS process included: the owned groups are stopped first, then the
 *     signal takes its usual effect. "This process" is whichever one called `startNextChild` — in
 *     the carrier a Vitest forks worker, never the Vitest main process, which owns no group. A stop
 *     is finished only when the owned GROUP is established gone; a closed port alone is not that.
 *   - the SOURCE INVENTORY: every regular file under the project's source roots plus the root
 *     build/config/package/lock inputs, read from the filesystem (no Git), so a build record binds
 *     the artifact to all of them — edited, added or deleted — and not to a short list of paths.
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
  | "source-unsupported"
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
  /** The owned group was established without a member (ESRCH) — observed, never inferred from the port. */
  groupGone: boolean;
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

/**
 * What asking or signalling a process group says about it. Only ESRCH establishes absence: any other
 * refusal (EPERM included) is "unknown", never read as gone. "present" means a member accepted the
 * signal — which, depending on the platform, includes one that has exited and is not yet reaped. So
 * presence is not evidence that anything is still serving; only "gone" is a conclusion.
 */
type GroupPresence = "present" | "gone" | "unknown";

/** One detached process group this module started and has not yet established gone. */
interface OwnedGroup {
  label: string;
  child: ChildProcess;
  /** The leader's pid — also the group's id, because the leader was spawned detached. */
  pid: number;
  port: number;
  /**
   * The group, asked now. While its leader is unreaped or a member lives, the id stays reserved for
   * this group, so it can be asked and signalled as ours. "gone" is latched: once the group was seen
   * without a member its id can be reused by a stranger, and it is never asked or signalled again.
   */
  presence(): GroupPresence;
  /** The shared, idempotent stop: every caller gets the same cleanup. */
  stop(): Promise<CleanupRecord>;
}

/**
 * Groups this process started, kept until their own stop() has established the GROUP gone. A closed
 * port never releases one: a member that stopped listening and kept running is still owned.
 */
const owned = new Set<OwnedGroup>();

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;
/** Past one stop()'s own worst case (10s + 5s for the group, then 5s for the port): the last resort runs alone only then. */
const SIGNAL_CLEANUP_DEADLINE_MS = 30_000;
let exitHookInstalled = false;
let signalHooksInstalled = false;
let terminating: NodeJS.Signals | null = null;

/** Signal a group — or, with signal 0, only ask. Never throws: the answer is what it returns. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): GroupPresence {
  try {
    process.kill(-pid, signal);
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

/**
 * Synchronous last resort, owned groups only: SIGKILL what the bounded stop() did not establish
 * gone. A group still registered is one whose absence was never observed — its leader is unreaped
 * (the pid cannot have been reused) or a member outlived the leader (the id stays reserved while one
 * lives). One seen empty is skipped: never signalled by name, port or pid guess. Sending SIGKILL is
 * not verification, so nothing is reported from here. SIGKILL of this process itself cannot be
 * handled; nothing here pretends otherwise.
 */
function killOwnedGroupsNow(): void {
  for (const group of owned) {
    if (group.presence() === "gone") continue;
    signalGroup(group.pid, "SIGKILL");
  }
}

/**
 * SIGINT/SIGTERM: the default action would end this process without running its `exit` hook and
 * leave a detached, possibly opted-in dev server behind. Instead: stop every owned group through
 * its own stop() (so a forked listener that outlived its leader is accounted for by its group —
 * neither skipped, nor released because its port closed), then hand the SAME signal back so the
 * process still terminates by it. A repeated signal while that is in flight is absorbed — it
 * neither restarts the cleanup nor cuts it short.
 */
function onTerminationSignal(signal: NodeJS.Signals): void {
  if (terminating) return;
  terminating = signal;
  void (async () => {
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...owned].map((group) => group.stop())),
      new Promise<void>((resolvePromise) => {
        deadline = setTimeout(resolvePromise, SIGNAL_CLEANUP_DEADLINE_MS);
      }),
    ]);
    clearTimeout(deadline);
    killOwnedGroupsNow();
    for (const name of TERMINATION_SIGNALS) process.removeListener(name, onTerminationSignal);
    signalHooksInstalled = false;
    terminating = null;
    // With this module's listeners gone the signal has its conventional effect again (or reaches
    // whatever other listener the host process installed).
    process.kill(process.pid, signal);
  })();
}

function installLifecycleHooks(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // An abnormal exit that bypassed stop() (an uncaught error, a host calling process.exit()).
    process.once("exit", killOwnedGroupsNow);
  }
  if (!signalHooksInstalled) {
    signalHooksInstalled = true;
    for (const name of TERMINATION_SIGNALS) process.on(name, onTerminationSignal);
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
  installLifecycleHooks();

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
  let groupGone = false;
  /** Ask the owned group (signal 0) or signal it. Once it was seen gone its id is never touched again. */
  const ownedGroup = (signal: NodeJS.Signals | 0): GroupPresence => {
    if (groupGone || child.pid === undefined) return "gone";
    const presence = signalGroup(child.pid, signal);
    if (presence === "gone") groupGone = true;
    return presence;
  };
  child.once("exit", () => {
    exited = true;
    // Asked as the leader is reaped, before its pid can be reused: a group empty NOW is latched gone,
    // and one that still has a member keeps the id reserved for as long as that member lives.
    ownedGroup(0);
  });

  const secrets = [env.AUTH_SECRET, env.DATABASE_URL].filter((s): s is string => typeof s === "string" && s !== "");
  const output = (): string => {
    let text = raw.replace(ANSI, "");
    for (const secret of secrets) text = text.split(secret).join("<redacted>");
    return text;
  };
  const tail = (): string => output().slice(-2000);

  let stopped: Promise<CleanupRecord> | null = null;
  let group: OwnedGroup | null = null;
  const stop = (): Promise<CleanupRecord> => {
    stopped ??= (async () => {
      const pid = child.pid;
      if (pid === undefined) {
        // The spawn itself failed: no process, no group, nothing was ever owned.
        return { label, pid: -1, exitCode: null, signal: null, forced: false, groupGone: true, portClosed: true };
      }
      // Three separate observations: the leader reaped, the owned group without a member, the owned
      // port closed. `next dev` serves from a forked worker in the leader's group, and Next closes its
      // listener BEFORE the rest of its shutdown (installed start-server.js: `server.close`, then the
      // awaited cleanup, then exit). So neither the leader's exit nor a closed port says the group is
      // gone — only the group does, and it is asked whether or not the leader went first.
      let seen = "present" as GroupPresence;
      const groupStopped = (): boolean => {
        seen = ownedGroup(0);
        return exited && seen === "gone";
      };
      let forced = false;
      ownedGroup("SIGTERM");
      if (!(await waitUntil(groupStopped, 10_000))) {
        // Whatever the port says by now: a member that closed its listener and kept running is ours.
        forced = true;
        ownedGroup("SIGKILL");
        if (!(await waitUntil(groupStopped, 5_000))) {
          // Sending SIGKILL is not seeing it work. The group stays registered for the last resort and
          // no cleanup is reported.
          throw new DevLoginSetupFailure(
            "cleanup-failed",
            seen === "unknown"
              ? `${label}: whether owned process group ${pid} is gone could not be established (the probe was refused)`
              : !exited
                ? `${label}: owned child ${pid} did not exit after SIGKILL`
                : `${label}: owned process group ${pid} still has a member after SIGKILL (one not yet reaped counts)`
          );
        }
      }
      // Established gone: nothing is left to own, and that group id is not signalled again.
      if (group) owned.delete(group);
      const portClosed = await waitUntil(async () => !(await loopbackPortAccepts(port, 500)), 5_000, 200);
      if (!portClosed) {
        throw new DevLoginSetupFailure(
          "cleanup-failed",
          `${label}: port ${port} is still accepting connections although the owned group is gone — ` +
            "that listener is not this carrier's and was not signalled"
        );
      }
      const cleanup: CleanupRecord = {
        label,
        pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
        forced,
        groupGone,
        portClosed,
      };
      console.log(`DEV_LOGIN_CHILD_CLEANUP_OK ${JSON.stringify(cleanup)}`);
      return cleanup;
    })();
    return stopped;
  };
  // Registered in the same tick as the spawn (nothing above awaits), and only when a process exists.
  if (child.pid !== undefined) {
    group = { label, child, pid: child.pid, port, presence: () => ownedGroup(0), stop };
    owned.add(group);
  }

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

/** `changedKeys` for a message: the first paths by name, and how many more there are. */
export function describeChanged(before: Record<string, string>, after: Record<string, string>, shown = 20): string | null {
  const all = changedKeys(before, after, Number.POSITIVE_INFINITY);
  if (all.length === 0) return null;
  return all.length > shown ? `${all.slice(0, shown).join(", ")} (and ${all.length - shown} more)` : all.join(", ");
}

/**
 * Directories whose WHOLE content is a build/runtime input of this project. Taken whole on purpose:
 * nothing here resolves imports, so a transitive or dynamic dependency, a newly added file and a
 * deleted one are all bound without guessing. `scripts/` is one of them because product code imports
 * it (lib/staging/build-metadata.ts → scripts/staging-ops/build-identity.mjs). A root that does not
 * exist contributes nothing; `test/`, `docs/`, the Python sidecar and every other root directory are
 * never opened, so this is no claim about deployment-wide provenance.
 */
export const RUNTIME_SOURCE_ROOTS = ["app", "components", "config", "lib", "postgres", "public", "scripts", "styles"] as const;

/** Next application directories this project does not have. One appearing is refused, not ignored. */
const UNCOVERED_SOURCE_ROOTS = new Set(["pages", "src"]);

/**
 * Root-level files are taken by FORM rather than from a list of names, so a newly added config is
 * bound too: instrumentation(-client).ts, proxy.ts, next.config.ts, sentry.*.config.ts,
 * postcss.config.mjs, tsconfig.json, package.json and package-lock.json all have one of these.
 */
const ROOT_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".yml",
  ".yaml",
]);

/** Files Next generates on `dev`/`build`; reported separately, never folded into the source record. */
export const GENERATED_FILES = ["next-env.d.ts"] as const;

/** Never entered, wherever they sit: dependencies, VCS data, build output, handoff/agent trees. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".next", ".context", ".claude"]);

const PRIVATE_EXTENSIONS = new Set([".pem", ".key", ".crt", ".cer", ".der", ".p8", ".p12", ".pfx", ".jks", ".keystore"]);
const PRIVATE_NAMES = new Set([".npmrc", ".netrc", ".aios-demo-key"]);

/**
 * Env, key, certificate and local credential entries, decided by NAME: never opened, never keyed —
 * and, when the name is a directory's or a link's, never listed or resolved either. A naming policy,
 * not secret detection: a secret kept in an ordinarily named source file is hashed like any source.
 */
function isPrivateName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env") || lower.endsWith(".env") || PRIVATE_NAMES.has(lower) || PRIVATE_EXTENSIONS.has(extname(lower))
  );
}

/** The one name policy, asked of every entry at every depth BEFORE its type is looked at. */
const isExcludedName = (name: string): boolean => SKIPPED_DIRECTORIES.has(name) || isPrivateName(name);

const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_DEPTH = 32;

/**
 * THE runtime source inventory: POSIX path relative to the checkout → content sha256, for every
 * regular file under RUNTIME_SOURCE_ROOTS and every root-level source/config/package/lock file.
 * Every caller that needs "the sources" uses this one function — the recorder before and after the
 * build, the build-record check, and the wire run's baseline and final comparison.
 *
 * Portable and Git-free: it reads the filesystem, so an untracked new file counts and a disposable
 * copy without `.git` inventories the same way. Deterministic: keys are sorted by code unit whatever
 * order a directory lists them in. Bounded: explicit roots, a depth limit and a file limit.
 *
 * Excluded by NAME first (`isExcludedName`), at the checkout root and at every depth: such an entry —
 * file, directory or link — is not listed, resolved, opened or keyed, so nothing beneath an excluded
 * directory is ever seen.
 *
 * Fail closed: any other entry under a source root that is neither a directory nor a regular file is
 * a `source-unsupported` SETUP_FAILURE rather than a silently incomplete inventory. That includes
 * EVERY symbolic link among the inventoried inputs — under a source root, a root-level file of a
 * source form, or a source root itself — wherever it points. It is refused on the entry, before its
 * target is resolved or read, so no bytes from outside the roots enter through a link.
 *
 * Not covered, by design: installed dependencies (the boundary is package.json + package-lock.json,
 * not a node_modules tamper detector), generated output, and private configuration — see
 * `isPrivateName`. Read-only.
 */
export function inventoryRuntimeSources(cwd: string = process.cwd()): Record<string, string> {
  const unsupported = (rel: string, why: string) =>
    new DevLoginSetupFailure(
      "source-unsupported",
      `${rel} ${why}. The runtime source inventory would not be complete, so no build is credited against it.`
    );
  const linked = (rel: string) => unsupported(rel, "is a symbolic link, which this inventory never resolves or reads");
  const found: [string, string][] = [];

  const add = (rel: string, path: string): void => {
    if (found.length >= MAX_SOURCE_FILES) throw unsupported(rel, `is past the ${MAX_SOURCE_FILES}-file bound`);
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (err) {
      throw unsupported(rel, `could not be read (${String((err as NodeJS.ErrnoException).code)})`);
    }
    found.push([rel, sha256(data)]);
  };
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_SOURCE_DEPTH) throw unsupported(rel, `is nested deeper than ${MAX_SOURCE_DEPTH} directories`);
    for (const entry of readdirSync(join(cwd, rel), { withFileTypes: true })) {
      // The name decides first, whatever the entry is: an excluded one is not looked at again.
      if (isExcludedName(entry.name)) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw linked(child);
      } else if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else if (entry.isFile()) {
        add(child, join(cwd, child));
      } else {
        throw unsupported(child, "is neither a regular file nor a directory");
      }
    }
  };

  const roots = new Set<string>(RUNTIME_SOURCE_ROOTS);
  const generated = new Set<string>(GENERATED_FILES);
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    const name = entry.name;
    // The same name policy as inside a root, and as early: before the entry's type or form matters.
    if (isExcludedName(name)) continue;
    if (roots.has(name)) {
      if (!entry.isDirectory()) throw unsupported(name, "is a source root that is not a plain directory");
      walk(name, 1);
    } else if (UNCOVERED_SOURCE_ROOTS.has(name)) {
      throw unsupported(name, "is a Next application directory this inventory does not cover");
    } else if (entry.isDirectory() || generated.has(name) || !ROOT_SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) {
      continue;
    } else if (entry.isSymbolicLink()) {
      throw linked(name);
    } else if (entry.isFile()) {
      add(name, join(cwd, name));
    } else {
      throw unsupported(name, "is neither a regular file nor a directory");
    }
  }
  found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(found);
}

export interface SourceSummary {
  files: number;
  /** sha256 over the sorted `<path>\0<content sha256>` lines: the path set and every file's bytes. */
  hash: string;
}

/** What is safe and small enough to print about an inventory: a count and one fingerprint. */
export function summarizeSources(sources: Record<string, string>): SourceSummary {
  const hash = createHash("sha256");
  const paths = Object.keys(sources).sort();
  for (const rel of paths) hash.update(`${rel}\0${sources[rel]}\n`);
  return { files: paths.length, hash: hash.digest("hex") };
}

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
 * only after that command exited 0 with the runtime source inventory identical before and after
 * (same path set, same bytes), and it binds that inventory to the BUILD_ID and server output the
 * command left behind. The two source maps carry the whole inventory, so a record written when they
 * held a short fixed list of paths no longer matches any checkout and is stale.
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
 * identical across the build), then compared with the runtime source inventory (its complete path
 * set and content), BUILD_ID, route artifact and server JS inventory as they are NOW. An emitted-JS
 * check alone cannot see a source edited after the build; the source comparison is what does.
 * Read-only; `expectedCommand` exists for the recorder's own stand-in tests and is never passed by
 * the carrier.
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
  const duringBuild = describeChanged(record.sourcesBefore, record.sourcesAfter);
  if (duringBuild) throw invalid(`reports sources that changed during the build: ${duringBuild}`);

  const stale = (why: string) =>
    new DevLoginSetupFailure("build-record-stale", `the build record no longer describes this checkout: ${why}. ${rebuild}`);
  const sources = inventoryRuntimeSources(cwd);
  const sinceBuild = describeChanged(record.sourcesAfter, sources);
  if (sinceBuild) throw stale(`source(s) changed, added or removed since the build: ${sinceBuild}`);
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
      sources: summarizeSources(sources),
      generated: fingerprintFiles(cwd, GENERATED_FILES),
    })}`
  );
  return async () => {
    console.log("DEV_LOGIN_CARRIER_TEARDOWN_OK");
  };
}
