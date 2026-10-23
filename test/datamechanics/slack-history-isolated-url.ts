import { Client } from "pg";

/**
 * The ONE `DATABASE_TEST_URL` guard for the three AIO-1170 Slack history data-mechanics suites
 * (`slack-history-progress-upgrade`, `slack-history-progress-conflicts`,
 * `slack-history-progress-catalog`). Those suites CREATE and DROP scratch databases, so the URL is
 * refused unless it names exactly one of the two runners that provide a disposable server. This file
 * is a helper, not a suite (`*.datamechanics.test.ts` is the collected pattern). It is exercised
 * directly by `test/slack-history-isolated-url.test.ts`.
 *
 * Common to both modes:
 *  - the scheme is `postgres:` or `postgresql:`;
 *  - the database is exactly `/app_test`;
 *  - the port is explicit;
 *  - there is no query string and no fragment;
 *  - the raw value carries no whitespace, backslash, `?` or `#`.
 *
 * Modes:
 *  - LOCAL (`scripts/dm-isolated.sh`): host `localhost`, `127.0.0.1` or `[::1]` (IPv6 loopback as
 *    `URL` normalizes it), on any explicit port EXCEPT the shared `5434` service;
 *  - CI (the `datamechanics-tests` job): host exactly `postgres`, port exactly `5432`, and ONLY when
 *    `GITHUB_ACTIONS` is exactly `"true"`.
 *
 * Everything else is refused with one static message that never contains the URL. There is no
 * `DATABASE_URL` fallback.
 */
export const ISOLATED_URL_REFUSAL = "refusing to run: DATABASE_TEST_URL is not the isolated data-mechanics runner's database";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function requireIsolatedTestUrl(raw: string | undefined, env: Record<string, string | undefined> = process.env): string {
  const refuse = (): never => {
    throw new Error(ISOLATED_URL_REFUSAL);
  };
  if (typeof raw !== "string" || raw === "" || /[\s\\?#]/.test(raw)) return refuse();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse();
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return refuse();
  if (parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/app_test" || !/^\d+$/.test(parsed.port)) return refuse();
  const local = LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port !== "5434";
  const ci = parsed.hostname === "postgres" && parsed.port === "5432" && env.GITHUB_ACTIONS === "true";
  if (!local && !ci) return refuse();
  return raw;
}

/** The narrow admin-client surface the scratch-database creator needs (injectable for its own tests). */
export interface AdminClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
}
const pgAdminClient = (connectionString: string): AdminClient => new Client({ connectionString });

/**
 * The guard FIRST, before any client object exists. Only then: connect, `create database <name>`,
 * close. Returns the guarded admin URL and the scratch database's URL. The name must be a plain
 * lowercase identifier, and is refused otherwise.
 */
export async function createIsolatedScratchDatabase(
  name: string,
  { env = process.env, makeClient = pgAdminClient }: { env?: Record<string, string | undefined>; makeClient?: (connectionString: string) => AdminClient } = {},
): Promise<{ adminUrl: string; url: string }> {
  const adminUrl = requireIsolatedTestUrl(env.DATABASE_TEST_URL, env);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("refusing to run: scratch database name is not a plain lowercase identifier");
  const admin = makeClient(adminUrl);
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end().catch(() => {});
  }
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  return { adminUrl, url: target.toString() };
}
