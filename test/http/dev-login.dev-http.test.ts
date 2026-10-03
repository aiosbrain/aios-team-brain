import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Client } from "pg";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import {
  CHILD_ENV_OS_ALLOWLIST,
  DevLoginSetupFailure,
  GENERATED_FILES,
  NEXT_LOADED_ENV_FILES,
  RUNTIME_SOURCE_FILES,
  allocateLoopbackPort,
  assertNoNextEnvFiles,
  buildChildEnv,
  cacheControlDirectives,
  findNextEnvFiles,
  fingerprintFiles,
  parseSetCookie,
  rawGet,
  readProductionArtifact,
  startNextChild,
  validateSyntheticDatabaseUrl,
  type OwnedChild,
  type WireResponse,
} from "./dev-login-dev-setup";

/**
 * AIO-1210 — `/auth/dev-login` over a REAL socket (spec AC01/AC03/AC04/AC05/AC06/AC07/AC08).
 *
 * Spec, not characterization: the route may mint a session only for a development server that was
 * deliberately started with AIOS_DEV_LOGIN=1 AND a request whose authority is strictly local. Every
 * other request gets the handler's own inert 404 — constant body, no-store, no Location, no cookie,
 * no auth rows. Production always denies, including the production artifact started under a
 * non-production runtime NODE_ENV.
 *
 * Children run strictly one at a time, in this order (the production artifact is proven before any
 * dev server exists, and BUILD_ID is re-checked after the dev servers are gone):
 *   1. `next start`, NODE_ENV=production,  AIOS_DEV_LOGIN=1 (+ obsolete ALLOW_DEV_LOGIN=1)
 *   2. `next start`, NODE_ENV=development, AIOS_DEV_LOGIN=1 (+ obsolete ALLOW_DEV_LOGIN=1)
 *   3. `next dev`,   AIOS_DEV_LOGIN=0
 *   4. `next dev`,   AIOS_DEV_LOGIN=1
 *
 * Every refusal is paired with an ADMITTED request made by the same client: a framework 404, a
 * compile failure or a dead server cannot satisfy a negative, because the handler's constant body is
 * asserted and the on child proves the same request shape mints a verified cookie. Each child signs
 * with its own synthetic AUTH_SECRET, so a cookie that verifies here was minted by that child.
 *
 * Requests go only to the literal 127.0.0.1 and the owned port, whatever Host header they carry, and
 * redirects are never followed. Fixtures are synthetic rows under a per-run email domain; snapshots
 * cover only this route's identity/member effects, never unrelated startup writes.
 */

const CWD = process.cwd();
const DISABLED_BODY = "dev-login is disabled";
const RUN = randomUUID().replace(/-/g, "").slice(0, 12);
const DOMAIN = `r${RUN}.aio1210.invalid`;
const PRODUCTION_REQUEST_TIMEOUT_MS = 30_000;
// The first request to a dev server compiles the route.
const DEV_REQUEST_TIMEOUT_MS = 120_000;

const email = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@${DOMAIN}`;
const evidence = (name: string, data: unknown): void => console.log(`DEV_LOGIN_EVIDENCE ${name} ${JSON.stringify(data)}`);

// Recorded before any child exists; compared again after the last one is gone.
const baseline = {
  artifact: readProductionArtifact(CWD),
  sources: fingerprintFiles(CWD, RUNTIME_SOURCE_FILES),
  generated: fingerprintFiles(CWD, GENERATED_FILES),
};

// ── synthetic database fixtures (this route's effects only) ─────────────────────────────────────

let client: Client | null = null;
async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!client) {
    const { url } = validateSyntheticDatabaseUrl(process.env.DATABASE_TEST_URL);
    client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    await client.connect();
  }
  return (await client.query(text, params)).rows as T[];
}

interface AuthUserRow {
  id: string;
  email: string;
}
interface MemberRow {
  id: string;
  email: string;
  auth_user_id: string | null;
  status: string;
  role: string;
  tier: string;
}

/** Every auth_users / members row under this run's email domain — the route's only possible effects. */
async function snapshot(): Promise<{ users: AuthUserRow[]; members: MemberRow[] }> {
  const pattern = `%@${DOMAIN}`;
  const users = await sql<AuthUserRow>(
    `select id::text as id, lower(email::text) as email from auth_users
      where lower(email::text) like $1 order by 2`,
    [pattern]
  );
  const members = await sql<MemberRow>(
    `select id::text as id, lower(email::text) as email, auth_user_id::text as auth_user_id,
            status::text as status, role::text as role, tier::text as tier
       from members where lower(email::text) like $1 order by 2, 1`,
    [pattern]
  );
  return { users, members };
}

async function memberOf(address: string): Promise<MemberRow[]> {
  return (await snapshot()).members.filter((m) => m.email === address);
}

const teamSlugs: string[] = [];
let team: Promise<string> | null = null;
function fixtureTeam(): Promise<string> {
  team ??= (async () => {
    const slug = `aio1210-${RUN}`;
    const rows = await sql<{ id: string }>(
      `insert into teams (slug, name) values ($1, $2) returning id::text as id`,
      [slug, "AIO-1210 dev-login wire fixture"]
    );
    teamSlugs.push(slug);
    return rows[0].id;
  })();
  return team;
}

async function seedMember(
  address: string,
  status: "active" | "invited" | "disabled",
  authUserId: string | null = null
): Promise<void> {
  await sql(
    `insert into members (team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values ($1, $2, $3, $4, 'member', 'team', $5::member_status, $6)`,
    [await fixtureTeam(), address, "AIO-1210 fixture", `aio1210-${randomUUID().slice(0, 12)}`, status, authUserId]
  );
}

// ── owned children ──────────────────────────────────────────────────────────────────────────────

interface Managed {
  label: string;
  /** This child's own synthetic signing secret. */
  secret: string;
  /** Start on first use. A failed start rejects EVERY test of the child with the same SETUP_FAILURE. */
  get(): Promise<OwnedChild>;
  stop(): Promise<void>;
}

const managedChildren: Managed[] = [];

function managedChild(spec: {
  label: string;
  command: "start" | "dev";
  nodeEnv: "production" | "development";
  optIn: "0" | "1";
  obsoleteAllowDevLogin?: boolean;
}): Managed {
  const secret = randomBytes(32).toString("hex");
  let started: Promise<OwnedChild> | null = null;
  const managed: Managed = {
    label: spec.label,
    secret,
    get() {
      started ??= (async () => {
        const port = await allocateLoopbackPort();
        const database = validateSyntheticDatabaseUrl(process.env.DATABASE_TEST_URL);
        const env = buildChildEnv({
          nodeEnv: spec.nodeEnv,
          devLoginOptIn: spec.optIn,
          obsoleteAllowDevLogin: spec.obsoleteAllowDevLogin,
          databaseUrl: database.url,
          authSecret: secret,
          port,
        });
        return startNextChild({ label: spec.label, command: spec.command, env, port, cwd: CWD });
      })();
      return started;
    },
    async stop() {
      if (!started) return;
      const child = await started.catch(() => null);
      if (child) await child.stop();
    },
  };
  managedChildren.push(managed);
  return managed;
}

interface Shape {
  /** The raw Host header, sent verbatim. */
  host: string;
  headers?: Record<string, string>;
}

function devLoginPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/auth/dev-login${query ? `?${query}` : ""}`;
}

/** The one client every case uses: production refusals, dev refusals and the admitted 307 alike. */
async function getDevLogin(child: OwnedChild, shape: Shape, params: Record<string, string>): Promise<WireResponse> {
  const res = await rawGet({
    port: child.port,
    path: devLoginPath(params),
    headers: { host: shape.host, ...(shape.headers ?? {}) },
    timeoutMs: child.command === "dev" ? DEV_REQUEST_TIMEOUT_MS : PRODUCTION_REQUEST_TIMEOUT_MS,
  });
  // Whatever Host said, the bytes went to the owned loopback listener.
  expect(res.remoteAddress).toBe("127.0.0.1");
  expect(res.remotePort).toBe(child.port);
  return res;
}

const localShape = (child: OwnedChild): Shape => ({ host: `127.0.0.1:${child.port}` });

/** The handler's own refusal — its constant body distinguishes it from a framework not-found. */
function expectHandlerRefusal(res: WireResponse): void {
  expect.soft(res.status).toBe(404);
  expect.soft(res.body).toBe(DISABLED_BODY);
  expect.soft(res.location).toBeNull();
  expect.soft(res.setCookie).toEqual([]);
}

async function verifyWith(secret: string, token: string): Promise<SessionUser | null> {
  vi.stubEnv("AUTH_SECRET", secret);
  try {
    return await verifySession(token);
  } finally {
    vi.unstubAllEnvs();
  }
}

/** 307 to the expected local origin with a session cookie the REAL verifier accepts for `address`. */
async function expectAdmitted(
  res: WireResponse,
  managed: Managed,
  expected: { origin: string; target?: string; address: string }
): Promise<SessionUser> {
  expect(res.status).toBe(307);
  expect(res.location).not.toBeNull();
  const destination = new URL(String(res.location));
  expect(destination.origin).toBe(expected.origin);
  expect(destination.pathname + destination.search + destination.hash).toBe(expected.target ?? "/t/demo");

  const session = res.setCookie.map(parseSetCookie).filter((cookie) => cookie.name === SESSION_COOKIE);
  expect(session).toHaveLength(1);
  const cookie = session[0];
  expect(cookie.attributes.httponly).toBe(true);
  expect(String(cookie.attributes.samesite).toLowerCase()).toBe("lax");
  expect(cookie.attributes.path).toBe("/");
  expect(cookie.attributes["max-age"]).toBe(String(SESSION_MAX_AGE_S));
  // Host-only: no Domain attribute. Development runtime: not Secure.
  expect("domain" in cookie.attributes).toBe(false);
  expect("secure" in cookie.attributes).toBe(false);

  const user = await verifyWith(managed.secret, cookie.value);
  expect(user).not.toBeNull();
  expect(user?.email).toBe(expected.address);
  // Signed by THIS child: another synthetic secret must not verify it.
  expect(await verifyWith(randomBytes(32).toString("hex"), cookie.value)).toBeNull();
  expect((await snapshot()).users.filter((row) => row.email === expected.address)).toEqual([
    { id: user?.id, email: expected.address },
  ]);
  return user as SessionUser;
}

/** The paired control: same client, same child, a strictly local authority → a verified session. */
async function admittedControl(managed: Managed): Promise<void> {
  const child = await managed.get();
  const address = email("control");
  const res = await getDevLogin(child, localShape(child), { email: address });
  await expectAdmitted(res, managed, { origin: `http://127.0.0.1:${child.port}`, address });
}

/** A refusal that changes no auth row, for a request that WOULD link an eligible member if admitted. */
async function expectInertRefusal(child: OwnedChild, shape: Shape): Promise<WireResponse> {
  const address = email("refused");
  await seedMember(address, "active");
  const before = await snapshot();
  const res = await getDevLogin(child, shape, { email: address });
  expectHandlerRefusal(res);
  expect.soft(await snapshot()).toEqual(before);
  return res;
}

afterAll(async () => {
  for (const managed of managedChildren) await managed.stop();
  if (!client) return;
  // Synthetic rows in the dedicated test database; removal is best-effort hygiene, reported either way.
  try {
    const pattern = `%@${DOMAIN}`;
    const members = await sql<{ id: string }>(`delete from members where lower(email::text) like $1 returning id::text as id`, [pattern]);
    const users = await sql<{ id: string }>(`delete from auth_users where lower(email::text) like $1 returning id::text as id`, [pattern]);
    const teams = await sql<{ id: string }>(`delete from teams where slug = any($1::text[]) returning id::text as id`, [teamSlugs]);
    evidence("fixture-cleanup", { members: members.length, authUsers: users.length, teams: teams.length });
  } catch (err) {
    evidence("fixture-cleanup", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await client.end();
  }
});

// ── 0. the carrier's own guards (pure; no child, no network) ────────────────────────────────────

describe("dev-login carrier preflight and environment (pure)", () => {
  const tempDirs: string[] = [];
  const tempCheckout = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "aio1210-env-preflight-"));
    tempDirs.push(dir);
    // Fixtures live in a disposable temp directory, never in the task checkout.
    expect(realpathSync(dir).startsWith(realpathSync(CWD) + sep)).toBe(false);
    for (const name of files) writeFileSync(join(dir, name), "");
    return dir;
  };
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("the refused set is exactly the eight Next-loaded env filenames", () => {
    expect([...NEXT_LOADED_ENV_FILES].sort()).toEqual(
      [
        ".env",
        ".env.development",
        ".env.development.local",
        ".env.local",
        ".env.production",
        ".env.production.local",
        ".env.test",
        ".env.test.local",
      ].sort()
    );
  });

  it.each([...NEXT_LOADED_ENV_FILES])("env-file preflight refuses a checkout containing %s", (name) => {
    const dir = tempCheckout([name, ".env.example"]);
    expect(findNextEnvFiles(dir)).toEqual([name]);
    let thrown: unknown;
    try {
      assertNoNextEnvFiles(dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
    expect((thrown as DevLoginSetupFailure).kind).toBe("env-file-present");
    expect((thrown as DevLoginSetupFailure).message).toContain(`SETUP_FAILURE[env-file-present]`);
    expect((thrown as DevLoginSetupFailure).message).toContain(name);
  });

  it("env-file preflight passes a checkout holding only .env.example", () => {
    const dir = tempCheckout([".env.example"]);
    expect(findNextEnvFiles(dir)).toEqual([]);
    expect(() => assertNoNextEnvFiles(dir)).not.toThrow();
  });

  it("env-file preflight is a closed list of names, not a .env* glob", () => {
    const dir = tempCheckout([".env.example", ".envrc", ".env.staging", ".env.local.bak", "env", ".environment"]);
    expect(findNextEnvFiles(dir)).toEqual([]);
    expect(() => assertNoNextEnvFiles(dir)).not.toThrow();
  });

  it("env-file preflight reports every present file by name", () => {
    const dir = tempCheckout([".env.production.local", ".env", ".env.example"]);
    expect(findNextEnvFiles(dir)).toEqual([".env", ".env.production.local"]);
  });

  it("the running task checkout holds no Next-loaded env file", () => {
    expect(findNextEnvFiles(CWD)).toEqual([]);
  });

  it("child environment is a finite allowlist plus explicit synthetic values — hostile ambient settings never reach a child", () => {
    const HOSTILE = "hostile-ambient-marker";
    const ambient: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/synthetic",
      NODE_ENV: "production",
      NODE_OPTIONS: `--require /${HOSTILE}.js`,
      AIOS_DEV_LOGIN: "1",
      ALLOW_DEV_LOGIN: "1",
      DATABASE_URL: `postgres://${HOSTILE}@db.example.com:5432/production`,
      DATABASE_TEST_URL: `postgres://${HOSTILE}@db.example.com:5432/other`,
      AUTH_SECRET: `${HOSTILE}-auth-secret`,
      SECRETS_KEY: `${HOSTILE}-secrets-key`,
      APP_URL: `https://${HOSTILE}.example.com`,
      HOSTNAME: "0.0.0.0",
      PORT: "9999",
      ANTHROPIC_API_KEY: HOSTILE,
      OPENAI_API_KEY: HOSTILE,
      OPENROUTER_API_KEY: HOSTILE,
      LLM_BASE_URL: `https://${HOSTILE}.example.com/v1`,
      GRAPHITI_URL: `https://${HOSTILE}.example.com`,
      NEO4J_URL: `bolt://${HOSTILE}.example.com:7687`,
      RESEND_API_KEY: HOSTILE,
      SMTP_URL: `smtp://${HOSTILE}.example.com`,
      SENTRY_DSN: `https://${HOSTILE}@sentry.example.com/1`,
      NEXT_PUBLIC_SENTRY_DSN: `https://${HOSTILE}@sentry.example.com/1`,
      SENTRY_AUTH_TOKEN: HOSTILE,
      INGEST_POLL_ENABLED: "true",
      GRAPH_PROJECT_ENABLED: "true",
      SOCIAL_JOBS_ENABLED: "true",
      NEXT_TELEMETRY_DISABLED: "0",
      SOME_VENDOR_TOKEN: HOSTILE,
    };
    const env = buildChildEnv(
      {
        nodeEnv: "development",
        devLoginOptIn: "0",
        databaseUrl: "postgres://synthetic:synthetic@127.0.0.1:5999/app_test",
        authSecret: "placeholder-child-secret-1234567890",
        port: 40123,
      },
      ambient
    );

    // Nothing ambient leaks: not a value, and not a key outside the OS allowlist.
    for (const value of Object.values(env)) expect(value).not.toContain(HOSTILE);
    expect("NODE_OPTIONS" in env).toBe(false);
    for (const name of ["ALLOW_DEV_LOGIN", "HOSTNAME", "PORT", "SOME_VENDOR_TOKEN", "DATABASE_TEST_URL"]) {
      expect(name in env).toBe(false);
    }
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect([...CHILD_ENV_OS_ALLOWLIST]).not.toContain("NODE_OPTIONS");

    // The explicit carrier values win.
    expect(env.NODE_ENV).toBe("development");
    expect(env.AIOS_DEV_LOGIN).toBe("0");
    expect(env.DATABASE_URL).toBe("postgres://synthetic:synthetic@127.0.0.1:5999/app_test");
    expect(env.AUTH_SECRET).toBe("placeholder-child-secret-1234567890");
    expect(env.APP_URL).toBe("http://127.0.0.1:40123");
    expect(env.DB_BACKEND).toBe("postgres");
    expect(env.NEXT_TELEMETRY_DISABLED).toBe("1");
    expect(env.INGEST_POLL_ENABLED).toBe("false");
    expect(env.GRAPH_PROJECT_ENABLED).toBe("false");
    expect(env.SOCIAL_JOBS_ENABLED).toBe("false");

    // Provider, graph, mail and telemetry transports are explicitly blank (not merely absent).
    for (const name of [
      "GRAPHITI_URL",
      "NEO4J_URL",
      "LLM_BASE_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "RESEND_API_KEY",
      "SMTP_URL",
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
      "SENTRY_AUTH_TOKEN",
    ]) {
      expect(env[name], name).toBe("");
    }
  });

  it("the obsolete ALLOW_DEV_LOGIN escape reaches a child only when a case asks for it", () => {
    const base = {
      nodeEnv: "production" as const,
      devLoginOptIn: "1" as const,
      databaseUrl: "postgres://synthetic:synthetic@127.0.0.1:5999/app_test",
      authSecret: "placeholder-child-secret-1234567890",
      port: 40123,
    };
    expect("ALLOW_DEV_LOGIN" in buildChildEnv(base, {})).toBe(false);
    expect(buildChildEnv({ ...base, obsoleteAllowDevLogin: true }, {}).ALLOW_DEV_LOGIN).toBe("1");
  });

  it("an absent DATABASE_TEST_URL is a named setup failure, never a fallback to DATABASE_URL", () => {
    const ambient = { DATABASE_URL: "postgres://app:app@127.0.0.1:5432/app_test" };
    for (const raw of [undefined, ""]) {
      let thrown: unknown;
      try {
        validateSyntheticDatabaseUrl(raw, ambient);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
      expect((thrown as DevLoginSetupFailure).kind).toBe("database-url-missing");
    }
  });

  it.each([
    ["a remote host", "postgres://app:credential-marker@db.example.com:5432/app_test", {}],
    ["a non-test database on loopback", "postgres://app:credential-marker@127.0.0.1:5432/app", {}],
    ["a development database on loopback", "postgres://app:credential-marker@localhost:5432/aios_dev", {}],
    ["the CI service hostname outside CI", "postgres://app:credential-marker@postgres:5432/app_test", {}],
    ["a non-postgres URL", "https://app:credential-marker@127.0.0.1:5432/app_test", {}],
    ["an unparseable value", "credential-marker not a url", {}],
    ["an unparseable value with no whitespace", "credential-marker-not-a-url", {}],
  ])("an unsafe DATABASE_TEST_URL (%s) is refused without echoing it", (_name, raw, ambient) => {
    let thrown: unknown;
    try {
      validateSyntheticDatabaseUrl(raw, ambient);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
    expect((thrown as DevLoginSetupFailure).kind).toBe("database-url-unsafe");
    expect((thrown as DevLoginSetupFailure).message).not.toContain("credential-marker");
  });

  // The validated value is handed RAW to pg, whose installed connection-string parser lets a query
  // parameter replace the URL's own host/port/user and adds TLS/options settings. A plain URL is the
  // only shape whose hostname and database checks describe the connection actually made. Validation
  // only: nothing here connects, and no path named in a parameter is ever opened.
  it.each([
    ["a host override", "?host=override-marker.example"],
    ["a percent-encoded host key", "?%68ost=override-marker.example"],
    ["a duplicate host (loopback first, remote last)", "?host=127.0.0.1&host=override-marker.example"],
    ["a unix-socket host", "?host=%2Foverride-marker%2Fsocket"],
    ["a port override", "?port=6543"],
    ["a database override", "?database=override-marker"],
    ["a user override", "?user=override-marker"],
    ["an sslmode override", "?sslmode=disable"],
    ["an sslcert path", "?sslcert=%2Foverride-marker%2Fclient.crt"],
    ["an options parameter", "?options=-c%20search_path%3Doverride-marker"],
    ["an unrecognised parameter (no key denylist)", "?override-marker=1"],
    ["a fragment", "#override-marker"],
    ["a query behind a fragment", "#?host=override-marker.example"],
  ])("a DATABASE_TEST_URL carrying %s is refused whole, while the same URL without it is accepted", (_name, suffix) => {
    for (const { plain, ambient } of [
      { plain: "postgres://app:credential-marker@127.0.0.1:58479/app_test", ambient: {} },
      { plain: "postgres://app:credential-marker@localhost:5434/app_test", ambient: {} },
      { plain: "postgres://app:credential-marker@postgres:5432/app_test", ambient: { GITHUB_ACTIONS: "true" } },
    ]) {
      // Paired control: only the suffix differs, and the accepted value is returned byte-for-byte.
      expect(validateSyntheticDatabaseUrl(plain, ambient).url).toBe(plain);

      let thrown: unknown;
      try {
        validateSyntheticDatabaseUrl(`${plain}${suffix}`, ambient);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
      expect((thrown as DevLoginSetupFailure).kind).toBe("database-url-unsafe");
      const message = (thrown as DevLoginSetupFailure).message;
      expect(message).toContain("SETUP_FAILURE[database-url-unsafe]");
      expect(message).not.toContain("credential-marker");
      expect(message).not.toContain("override-marker");
      expect(message).not.toContain(suffix.slice(1));
    }
  });

  // The same raw value is parsed twice, and the parsers disagree about whitespace and controls: WHATWG
  // `new URL` trims leading/trailing C0-or-space and drops tabs/newlines anywhere, while pg's installed
  // connection-string parser percent-encodes a value holding a literal space and resolves it against
  // `postgres://base`. Every value below passes the hostname and database checks once WHATWG has
  // normalised it, so the raw character itself is what must be refused. Validation only: no connection.
  it.each<{ name: string; mutate: (plain: string) => string }>([
    { name: "a leading space", mutate: (plain) => ` ${plain}` },
    { name: "a trailing space", mutate: (plain) => `${plain} ` },
    { name: "a space inside the database name", mutate: (plain) => plain.replace("/app_test", "/app _test") },
    { name: "a leading tab", mutate: (plain) => `\t${plain}` },
    { name: "a tab inside the host", mutate: (plain) => plain.replace("@", "@\t") },
    { name: "a trailing newline", mutate: (plain) => `${plain}\n` },
    { name: "a trailing carriage return and newline", mutate: (plain) => `${plain}\r\n` },
    { name: "a newline inside the database name", mutate: (plain) => plain.replace("/app_test", "/app\n_test") },
    { name: "a leading NUL", mutate: (plain) => `\u0000${plain}` },
    { name: "a trailing NUL", mutate: (plain) => `${plain}\u0000` },
    { name: "a DEL inside the database name", mutate: (plain) => plain.replace("/app_test", "/app\u007f_test") },
  ])("a DATABASE_TEST_URL holding $name is refused raw, while the same URL without it is accepted", ({ mutate }) => {
    for (const { plain, ambient } of [
      { plain: "postgres://app:credential-marker@127.0.0.1:58479/app_test", ambient: {} },
      { plain: "postgres://app:credential-marker@localhost:5434/app_test", ambient: {} },
      { plain: "postgres://app:credential-marker@postgres:5432/app_test", ambient: { GITHUB_ACTIONS: "true" } },
    ]) {
      // Paired control: only the one raw character differs.
      expect(validateSyntheticDatabaseUrl(plain, ambient).url).toBe(plain);
      const raw = mutate(plain);
      expect(raw).not.toBe(plain);
      expect(raw.length).toBeGreaterThan(plain.length);

      let thrown: unknown;
      try {
        validateSyntheticDatabaseUrl(raw, ambient);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
      expect((thrown as DevLoginSetupFailure).kind).toBe("database-url-unsafe");
      const message = (thrown as DevLoginSetupFailure).message;
      expect(message).toContain("SETUP_FAILURE[database-url-unsafe]");
      expect(message).not.toContain("credential-marker");
      expect(message).not.toContain("app_test");
    }
  });

  it("percent-encoded space and control bytes stay supported: only the raw characters are refused", () => {
    for (const plain of [
      "postgres://app:p%20ss%09w%0Aor%7Fd@127.0.0.1:58479/app_test",
      "postgres://us%20er:p%00ss@localhost:5434/app_test",
    ]) {
      expect(validateSyntheticDatabaseUrl(plain, {})).toEqual({ url: plain, hostClass: "loopback", database: "app_test" });
    }
  });

  it("an owned loopback test database and the CI job's isolated service are accepted", () => {
    expect(validateSyntheticDatabaseUrl("postgres://app:app@127.0.0.1:58479/app_test", {}).hostClass).toBe("loopback");
    expect(validateSyntheticDatabaseUrl("postgres://app:app@localhost:5434/app_test", {}).hostClass).toBe("loopback");
    expect(
      validateSyntheticDatabaseUrl("postgres://app:app@postgres:5432/app_test", { GITHUB_ACTIONS: "true" }).hostClass
    ).toBe("ci-service");
  });

  it("Cache-Control is compared by directive token, not by substring", () => {
    expect(cacheControlDirectives("no-store, must-revalidate")).toContain("no-store");
    expect(cacheControlDirectives("No-Store")).toEqual(["no-store"]);
    expect(cacheControlDirectives("private, no-storefront, max-age=0")).not.toContain("no-store");
    expect(cacheControlDirectives(null)).toEqual([]);
  });
});

// ── 1–2. the production artifact: hard-off in both runtime modes ────────────────────────────────

describe.each([
  { label: "production artifact, runtime NODE_ENV=production", nodeEnv: "production" as const, nonStandardWarning: false },
  { label: "production artifact, runtime NODE_ENV=development", nodeEnv: "development" as const, nonStandardWarning: true },
])("$label + AIOS_DEV_LOGIN=1", ({ label, nodeEnv, nonStandardWarning }) => {
  const managed = managedChild({ label, command: "start", nodeEnv, optIn: "1", obsoleteAllowDevLogin: true });
  afterAll(() => managed.stop());

  it("is the consumed production build, started loopback-bound with opt-in 1 under the declared runtime mode", async () => {
    const child = await managed.get();
    const record = child.record();
    expect(record.args).toEqual(["start", "--hostname", "127.0.0.1", "--port", String(child.port)]);
    // Verified BEFORE any denial is credited: the child really ran with the opt-in set.
    expect(child.env.NODE_ENV).toBe(nodeEnv);
    expect(child.env.AIOS_DEV_LOGIN).toBe("1");
    expect(child.env.ALLOW_DEV_LOGIN).toBe("1");
    expect("NODE_OPTIONS" in child.env).toBe(false);
    expect(child.alive()).toBe(true);
    // Next's own startup warning is the child's testimony about its runtime mode: `next start` under
    // NODE_ENV=development is non-standard; under NODE_ENV=production it is not.
    expect(child.output().includes('non-standard "NODE_ENV"')).toBe(nonStandardWarning);
    // The artifact being served is the one recorded before any child started.
    expect(readProductionArtifact(CWD).buildId).toBe(baseline.artifact.buildId);
    evidence("production-child", { ...record, buildId: baseline.artifact.buildId, routeEntry: baseline.artifact.routeEntry });
  });

  it("production denies a valid local authority with the handler's own 404: no cookie, no Location, no auth rows", async () => {
    const child = await managed.get();
    expect(child.env.AIOS_DEV_LOGIN).toBe("1");
    const res = await expectInertRefusal(child, localShape(child));
    evidence("production-refusal", { label, status: res.status, body: res.body, cacheControl: res.cacheControl });
  });

  it("production denies every loopback Host alias and a matching forwarded authority alike", async () => {
    const child = await managed.get();
    for (const shape of [
      { host: `localhost:${child.port}` },
      { host: `[::1]:${child.port}` },
      {
        host: `127.0.0.1:${child.port}`,
        headers: { "x-forwarded-host": `127.0.0.1:${child.port}`, "x-forwarded-proto": "http" },
      },
    ]) {
      await expectInertRefusal(child, shape);
    }
  });

  it("production denial is explicitly no-store", async () => {
    const child = await managed.get();
    const res = await getDevLogin(child, localShape(child), { email: email("no-store") });
    expect(res.status).toBe(404);
    expect(res.body).toBe(DISABLED_BODY);
    expect(res.cacheControl).toBe("no-store");
  });

  it("serving the artifact leaves it untouched", async () => {
    await managed.get();
    const now = readProductionArtifact(CWD);
    expect(now.buildId).toBe(baseline.artifact.buildId);
    expect(now.buildIdMtimeMs).toBe(baseline.artifact.buildIdMtimeMs);
    expect(now.fingerprint).toBe(baseline.artifact.fingerprint);
  });
});

describe("production artifact classification", () => {
  it("the build routes /auth/dev-login to a compiled handler and never prerendered it", () => {
    expect(baseline.artifact.routeEntry).toMatch(/auth\/dev-login\/route/);
    expect(baseline.artifact.prerendered).toBe(false);
  });
});

// ── 3. next dev, opt-in explicitly off ──────────────────────────────────────────────────────────

describe("next dev on loopback, AIOS_DEV_LOGIN=0", () => {
  const off = managedChild({ label: "next dev, opt-in off", command: "dev", nodeEnv: "development", optIn: "0" });
  afterAll(() => off.stop());

  it("is an actual next dev child, loopback-bound, with the opt-in explicitly 0", async () => {
    const child = await off.get();
    const record = child.record();
    expect(record.args).toEqual(["dev", "--hostname", "127.0.0.1", "--port", String(child.port)]);
    expect(child.env.NODE_ENV).toBe("development");
    expect(child.env.AIOS_DEV_LOGIN).toBe("0");
    expect("ALLOW_DEV_LOGIN" in child.env).toBe(false);
    expect("NODE_OPTIONS" in child.env).toBe(false);
    expect(child.alive()).toBe(true);
    expect(child.output().includes('non-standard "NODE_ENV"')).toBe(false);
    evidence("dev-child", record);
  });

  // Paired control: "on/local control: the request shape the off and production children refused…".
  it("off: a valid local request gets the handler's own inert 404 — no-store, no cookie, no Location, no auth rows", async () => {
    const child = await off.get();
    const res = await expectInertRefusal(child, localShape(child));
    expect.soft(cacheControlDirectives(res.cacheControl)).toContain("no-store");
    evidence("dev-off-refusal", { status: res.status, body: res.body, cacheControl: res.cacheControl });
  });

  it("off: every loopback Host alias and a matching forwarded authority are refused alike", async () => {
    const child = await off.get();
    for (const shape of [
      { host: `localhost:${child.port}` },
      { host: `[::1]:${child.port}` },
      {
        host: `127.0.0.1:${child.port}`,
        headers: { "x-forwarded-host": `127.0.0.1:${child.port}`, "x-forwarded-proto": "http" },
      },
    ]) {
      const res = await expectInertRefusal(child, shape);
      expect.soft(cacheControlDirectives(res.cacheControl)).toContain("no-store");
    }
  });
});

// ── 4. next dev, opt-in explicitly on ───────────────────────────────────────────────────────────

describe("next dev on loopback, AIOS_DEV_LOGIN=1", () => {
  const on = managedChild({ label: "next dev, opt-in on", command: "dev", nodeEnv: "development", optIn: "1" });
  afterAll(() => on.stop());

  it("is an actual next dev child, loopback-bound, with the opt-in explicitly 1", async () => {
    const child = await on.get();
    const record = child.record();
    expect(record.args).toEqual(["dev", "--hostname", "127.0.0.1", "--port", String(child.port)]);
    expect(child.env.NODE_ENV).toBe("development");
    expect(child.env.AIOS_DEV_LOGIN).toBe("1");
    expect("ALLOW_DEV_LOGIN" in child.env).toBe(false);
    expect("NODE_OPTIONS" in child.env).toBe(false);
    expect(child.alive()).toBe(true);
    expect(child.output().includes('non-standard "NODE_ENV"')).toBe(false);
    evidence("dev-child", record);
  });

  it("on/local control: the request shape the off and production children refused is admitted here — 307 and a verified session cookie", async () => {
    await admittedControl(on);
  });

  it.each([
    { name: "127.0.0.1", host: (port: number) => `127.0.0.1:${port}`, origin: (port: number) => `http://127.0.0.1:${port}` },
    { name: "localhost", host: (port: number) => `localhost:${port}`, origin: (port: number) => `http://localhost:${port}` },
    { name: "LOCALHOST (case-insensitive)", host: (port: number) => `LOCALHOST:${port}`, origin: (port: number) => `http://localhost:${port}` },
    { name: "[::1]", host: (port: number) => `[::1]:${port}`, origin: (port: number) => `http://[::1]:${port}` },
  ])("on/local: Host $name is admitted and the redirect stays on that Host and port", async ({ host, origin }) => {
    const child = await on.get();
    const address = email("host");
    const res = await getDevLogin(child, { host: host(child.port) }, { email: address });
    await expectAdmitted(res, on, { origin: origin(child.port), address });
  });

  it("on/local: an admitted success is no-store", async () => {
    const child = await on.get();
    const address = email("no-store");
    const res = await getDevLogin(child, localShape(child), { email: address });
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
    // Next's dev server may append directives of its own; the no-store token is what is required.
    expect(cacheControlDirectives(res.cacheControl)).toContain("no-store");
  });

  it.each<{ name: string; shape: (port: number) => Shape }>([
    { name: "a raw nonlocal Host on the owned port", shape: (port) => ({ host: `evil.example:${port}` }) },
    { name: "a raw nonlocal Host without a port", shape: () => ({ host: "evil.example" }) },
    { name: "a suffix lookalike Host", shape: (port) => ({ host: `localhost.evil.example:${port}` }) },
    { name: "a trailing-dot Host", shape: (port) => ({ host: `localhost.:${port}` }) },
    { name: "the short numeric loopback 127.1", shape: (port) => ({ host: `127.1:${port}` }) },
    { name: "another loopback address 127.0.0.2", shape: (port) => ({ host: `127.0.0.2:${port}` }) },
    { name: "the wildcard address 0.0.0.0", shape: (port) => ({ host: `0.0.0.0:${port}` }) },
    { name: "a local Host on a different port (port remapping)", shape: () => ({ host: "127.0.0.1:1" }) },
    { name: "a local Host with no port (effective port 80)", shape: () => ({ host: "localhost" }) },
    {
      name: "a raw public Host with a loopback x-forwarded-for",
      shape: (port) => ({ host: `evil.example:${port}`, headers: { "x-forwarded-for": "127.0.0.1" } }),
    },
    {
      name: "a raw public Host with a local x-forwarded-host",
      shape: (port) => ({ host: `evil.example:${port}`, headers: { "x-forwarded-host": `127.0.0.1:${port}` } }),
    },
    {
      name: "x-forwarded-host naming a public host",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-host": "evil.example" } }),
    },
    {
      name: "x-forwarded-host naming a public host on the owned port",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-host": `evil.example:${port}` } }),
    },
    {
      name: "x-forwarded-host using a different loopback alias",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-host": `localhost:${port}` } }),
    },
    {
      name: "x-forwarded-host on a different port",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-host": "127.0.0.1:1" } }),
    },
    {
      name: "an x-forwarded-host list",
      shape: (port) => ({
        host: `127.0.0.1:${port}`,
        headers: { "x-forwarded-host": `127.0.0.1:${port}, 127.0.0.1:${port}` },
      }),
    },
    {
      name: "an x-forwarded-host carrying a path",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-host": `127.0.0.1:${port}/x` } }),
    },
    {
      name: "x-forwarded-proto naming another scheme",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-proto": "ftp" } }),
    },
    {
      name: "x-forwarded-proto that is not exactly lower-case http",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-proto": "HTTP" } }),
    },
    {
      name: "an x-forwarded-proto list http,https",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-proto": "http,https" } }),
    },
    {
      name: "an x-forwarded-proto list https, http",
      shape: (port) => ({ host: `127.0.0.1:${port}`, headers: { "x-forwarded-proto": "https, http" } }),
    },
  ])("on: $name gets the same inert handler 404, while the local control is admitted", async ({ shape }) => {
    const child = await on.get();
    const res = await expectInertRefusal(child, shape(child.port));
    expect.soft(cacheControlDirectives(res.cacheControl)).toContain("no-store");
    // Same client, same child: only the authority differed.
    await admittedControl(on);
  });

  it("on/local: matching x-forwarded-host and x-forwarded-proto add no authority and do not block", async () => {
    const child = await on.get();
    const address = email("forwarded-match");
    const res = await getDevLogin(
      child,
      {
        host: `127.0.0.1:${child.port}`,
        headers: { "x-forwarded-host": `127.0.0.1:${child.port}`, "x-forwarded-proto": "http" },
      },
      { email: address }
    );
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
  });

  it("on/local: a spoofed x-forwarded-for does not change an admitted outcome", async () => {
    const child = await on.get();
    const address = email("forwarded-for");
    const res = await getDevLogin(
      child,
      { host: `127.0.0.1:${child.port}`, headers: { "x-forwarded-for": "203.0.113.7", forwarded: "for=203.0.113.7;host=evil.example;proto=https" } },
      { email: address }
    );
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
  });

  // Installed Next 16.3 derives the request URL's scheme from x-forwarded-proto (next-server.js), so a
  // plain-HTTP request carrying exactly `https` satisfies the scheme-equality rule. The redirect is
  // https but still LOCAL. This is the allowed request-authority observation — not proof of TLS.
  it("on/local observation: plain HTTP with x-forwarded-proto exactly https yields a local-origin https 307", async () => {
    const child = await on.get();
    const address = email("forwarded-https");
    const res = await getDevLogin(
      child,
      { host: `127.0.0.1:${child.port}`, headers: { "x-forwarded-proto": "https" } },
      { email: address }
    );
    await expectAdmitted(res, on, { origin: `https://127.0.0.1:${child.port}`, address });
    evidence("forwarded-https-observation", { status: res.status, locationOrigin: new URL(String(res.location)).origin });
  });

  it.each<{ name: string; next: string | undefined; target: string }>([
    { name: "an absent next defaults to /t/demo", next: undefined, target: "/t/demo" },
    {
      name: "a safe path, query and hash survive",
      next: "/t/demo/tasks?view=board&page=2#top",
      target: "/t/demo/tasks?view=board&page=2#top",
    },
    { name: "an empty next falls back to /", next: "", target: "/" },
    { name: "an absolute URL falls back to /", next: "https://evil.example/x", target: "/" },
    { name: "a protocol-relative next falls back to /", next: "//evil.example/x", target: "/" },
    { name: "a backslash escape falls back to /", next: "/\\evil.example", target: "/" },
    { name: "a tab-smuggled escape falls back to /", next: "/\t/evil.example", target: "/" },
    { name: "a dot-segment collapse to // falls back to /", next: "/..//evil.example", target: "/" },
  ])("on/local next: $name and stays on the admitted Host", async ({ next, target }) => {
    const child = await on.get();
    const address = email("next");
    const params: Record<string, string> = next === undefined ? { email: address } : { email: address, next };
    const res = await getDevLogin(child, localShape(child), params);
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, target, address });
  });

  it("on/local: links an active member's existing row and changes neither its status, role nor tier", async () => {
    const child = await on.get();
    const address = email("active");
    await seedMember(address, "active");
    const [before] = await memberOf(address);
    const res = await getDevLogin(child, localShape(child), { email: address });
    const user = await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
    expect(await memberOf(address)).toEqual([{ ...before, auth_user_id: user.id }]);
  });

  it("on/local: an invited member is linked but stays invited (the route supplies no team context)", async () => {
    const child = await on.get();
    const address = email("invited");
    await seedMember(address, "invited");
    const [before] = await memberOf(address);
    const res = await getDevLogin(child, localShape(child), { email: address });
    const user = await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
    expect(await memberOf(address)).toEqual([{ ...before, auth_user_id: user.id, status: "invited" }]);
  });

  it("on/local: a disabled member's row stays unlinked although the identity cookie is minted", async () => {
    const child = await on.get();
    const address = email("disabled");
    await seedMember(address, "disabled");
    const before = await memberOf(address);
    expect(before).toHaveLength(1);
    expect(before[0].auth_user_id).toBeNull();
    const res = await getDevLogin(child, localShape(child), { email: address });
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
    expect(await memberOf(address)).toEqual(before);
  });

  it("on/local: an email with no member gets an identity and a cookie but no membership", async () => {
    const child = await on.get();
    const address = email("no-member");
    const membersBefore = (await snapshot()).members;
    const res = await getDevLogin(child, localShape(child), { email: address });
    await expectAdmitted(res, on, { origin: `http://127.0.0.1:${child.port}`, address });
    expect(await memberOf(address)).toEqual([]);
    expect((await snapshot()).members).toEqual(membersBefore);
  });

  it("on/local: a second login reuses the same identity", async () => {
    const child = await on.get();
    const address = email("reuse");
    const first = await expectAdmitted(await getDevLogin(child, localShape(child), { email: address }), on, {
      origin: `http://127.0.0.1:${child.port}`,
      address,
    });
    const second = await expectAdmitted(await getDevLogin(child, localShape(child), { email: address }), on, {
      origin: `http://127.0.0.1:${child.port}`,
      address,
    });
    expect(second.id).toBe(first.id);
  });
});

// ── 5. restoration: nothing the run started changed the artifact or the sources ─────────────────

describe("after the development children", () => {
  it("the production BUILD_ID and route artifact are unchanged; dev output went to .next/dev", () => {
    const now = readProductionArtifact(CWD);
    expect(now.buildId).toBe(baseline.artifact.buildId);
    expect(now.buildIdMtimeMs).toBe(baseline.artifact.buildIdMtimeMs);
    expect(now.fingerprint).toBe(baseline.artifact.fingerprint);
    expect(existsSync(join(CWD, ".next", "dev"))).toBe(true);
    evidence("artifact-after-dev", { buildId: now.buildId, fingerprint: now.fingerprint, devDistDir: ".next/dev" });
  });

  it("no tracked runtime source changed while the children ran (generated files are reported separately)", () => {
    const sources = fingerprintFiles(CWD, RUNTIME_SOURCE_FILES);
    expect(sources).toEqual(baseline.sources);
    evidence("sources", { before: baseline.sources, after: sources });
    evidence("generated", { before: baseline.generated, after: fingerprintFiles(CWD, GENERATED_FILES) });
  });
});
