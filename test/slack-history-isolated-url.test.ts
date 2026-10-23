import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ISOLATED_URL_REFUSAL,
  createIsolatedScratchDatabase,
  requireIsolatedTestUrl,
} from "./datamechanics/slack-history-isolated-url";

/**
 * The shared `DATABASE_TEST_URL` guard of the three AIO-1170 Slack history data-mechanics suites,
 * exercised DIRECTLY. The guard is the real implementation those suites import; nothing here
 * re-implements its predicate, and no suite is imported, so no suite hook runs. Default tier: no
 * database, no network.
 *
 * Contract:
 *  - LOCAL: loopback host (`localhost`, `127.0.0.1`, `[::1]` as `URL` normalizes it) on an explicit
 *    port other than 5434;
 *  - CI: exactly `postgres:5432`, only when `GITHUB_ACTIONS` is exactly `"true"`;
 *  - both modes: `postgres:`/`postgresql:` scheme, database exactly `/app_test`, an explicit port,
 *    no query string and no fragment;
 *  - one static, URL-free refusal message, and no `DATABASE_URL` fallback;
 *  - the guard runs before any client exists.
 */

const ROOT = process.cwd();
const CI_URL = "postgres://app:app@postgres:5432/app_test";
const CI_ENV = { GITHUB_ACTIONS: "true" };
const SUITES = [
  "test/datamechanics/slack-history-progress-upgrade.datamechanics.test.ts",
  "test/datamechanics/slack-history-progress-conflicts.datamechanics.test.ts",
  "test/datamechanics/slack-history-progress-catalog.datamechanics.test.ts",
];

/** The guard's verdict: "accepted", or its refusal message (which must be the static one). */
const verdict = (raw: string | undefined, env: Record<string, string | undefined> = {}): string => {
  try {
    return requireIsolatedTestUrl(raw, env) === raw ? "accepted" : "accepted a different value";
  } catch (error) {
    return error instanceof Error ? error.message : "non-Error refusal";
  }
};

describe("Slack history data-mechanics DATABASE_TEST_URL guard", () => {
  it("accepts the exact CI service URL only when GITHUB_ACTIONS is exactly \"true\"", () => {
    expect({
      true: verdict(CI_URL, CI_ENV),
      missing: verdict(CI_URL, {}),
      false: verdict(CI_URL, { GITHUB_ACTIONS: "false" }),
      one: verdict(CI_URL, { GITHUB_ACTIONS: "1" }),
      upper: verdict(CI_URL, { GITHUB_ACTIONS: "TRUE" }),
      empty: verdict(CI_URL, { GITHUB_ACTIONS: "" }),
      postgresqlScheme: verdict("postgresql://app:app@postgres:5432/app_test", CI_ENV),
    }).toEqual({
      true: "accepted", missing: ISOLATED_URL_REFUSAL, false: ISOLATED_URL_REFUSAL, one: ISOLATED_URL_REFUSAL,
      upper: ISOLATED_URL_REFUSAL, empty: ISOLATED_URL_REFUSAL, postgresqlScheme: "accepted",
    });
  });

  it("accepts the local isolated runner on localhost, IPv4 and bracketed IPv6 loopback with explicit permitted ports", () => {
    const local = [
      "postgres://app:app@localhost:55012/app_test",
      "postgres://app:app@127.0.0.1:5433/app_test",
      "postgres://app:app@[::1]:55012/app_test",
      "postgres://app:app@[0:0:0:0:0:0:0:1]:55012/app_test", // URL normalizes this to [::1]
      "postgresql://app:app@localhost:5432/app_test",
    ];
    for (const raw of local) {
      expect({ raw, local: verdict(raw, {}), underCi: verdict(raw, CI_ENV) }).toEqual({ raw, local: "accepted", underCi: "accepted" });
    }
  });

  it.each([
    ["the shared 5434 service on localhost", "postgres://app:app@localhost:5434/app_test"],
    ["the shared 5434 service on IPv4 loopback", "postgres://app:app@127.0.0.1:5434/app_test"],
    ["the shared 5434 service on IPv6 loopback", "postgres://app:app@[::1]:5434/app_test"],
    ["the CI host on 5434", "postgres://app:app@postgres:5434/app_test"],
    ["a missing local port", "postgres://app:app@localhost/app_test"],
    ["a missing CI port", "postgres://app:app@postgres/app_test"],
    ["the postgres host on another port", "postgres://app:app@postgres:5433/app_test"],
    ["another database", "postgres://app:app@localhost:5433/postgres"],
    ["a database suffix", "postgres://app:app@localhost:5433/app_test2"],
    ["a trailing slash", "postgres://app:app@localhost:5433/app_test/"],
    ["no database", "postgres://app:app@localhost:5433"],
    ["an unrelated host", "postgres://app:app@db.example.test:5432/app_test"],
    ["a private address", "postgres://app:app@10.0.0.5:5433/app_test"],
    ["a non-canonical IPv4 loopback", "postgres://app:app@127.1:5433/app_test"],
    ["a localhost suffix trick", "postgres://app:app@localhost.evil.test:5433/app_test"],
    ["an IPv4 suffix trick", "postgres://app:app@127.0.0.1.nip.io:5433/app_test"],
    ["a CI host suffix trick", "postgres://app:app@postgres.evil.test:5432/app_test"],
    ["a CI host prefix trick", "postgres://app:app@postgres-other:5432/app_test"],
    ["a userinfo trick", "postgres://localhost:5433@evil.test:5433/app_test"],
    ["the http scheme", "http://localhost:5433/app_test"],
    ["the mysql scheme", "mysql://app:app@localhost:5433/app_test"],
    ["the pg scheme", "pg://app:app@localhost:5433/app_test"],
    ["a query override of the host", "postgres://app:app@localhost:5433/app_test?host=/tmp"],
    ["a query override of the database", "postgres://app:app@localhost:5433/app_test?dbname=prod"],
    ["an empty query", "postgres://app:app@localhost:5433/app_test?"],
    ["a CI query override", "postgres://app:app@postgres:5432/app_test?sslmode=disable"],
    ["a fragment", "postgres://app:app@localhost:5433/app_test#x"],
    ["a fragment hiding a host", "postgres://app:app@evil.test#@localhost:5433/app_test"],
    ["an empty value", ""],
    ["a missing value", undefined],
    ["a non-URL", "not a url"],
    ["a bare scheme", "postgres://"],
    ["an out-of-range port", "postgres://app:app@localhost:99999/app_test"],
    ["leading whitespace", " postgres://app:app@localhost:5433/app_test"],
    ["trailing whitespace", "postgres://app:app@localhost:5433/app_test "],
    ["a backslash", "postgres://app:app@localhost:5433\\@evil.test/app_test"],
  ])("refuses %s in both modes with the static, URL-free message", (_label, raw) => {
    expect({ local: verdict(raw, {}), underCi: verdict(raw, CI_ENV) }).toEqual({ local: ISOLATED_URL_REFUSAL, underCi: ISOLATED_URL_REFUSAL });
    expect(ISOLATED_URL_REFUSAL.includes("://")).toBe(false);
  });

  it("runs the guard before any client exists, never falls back to DATABASE_URL, and only then connects and creates", async () => {
    const events: string[] = [];
    const makeClient = () => {
      events.push("construct");
      return {
        connect: async () => { events.push("connect"); },
        query: async (sql: string) => { events.push(`query ${sql}`); },
        end: async () => { events.push("end"); },
      };
    };
    const refusals: Array<Record<string, string | undefined>> = [
      { DATABASE_TEST_URL: "postgres://app:app@db.example.test:5432/app_test" },
      { DATABASE_TEST_URL: CI_URL },
      { DATABASE_TEST_URL: CI_URL, GITHUB_ACTIONS: "1" },
      { DATABASE_TEST_URL: "postgres://app:app@localhost:5434/app_test" },
      { DATABASE_URL: "postgres://app:app@localhost:5433/app_test" },
    ];
    for (const env of refusals) {
      await expect(createIsolatedScratchDatabase("slackguard_probe", { env, makeClient })).rejects.toThrow(ISOLATED_URL_REFUSAL);
    }
    await expect(createIsolatedScratchDatabase("Bad-Name; drop", {
      env: { DATABASE_TEST_URL: "postgres://app:app@localhost:5433/app_test" }, makeClient,
    })).rejects.toThrow("scratch database name");
    expect(events, "no client was constructed, connected or queried for any refused URL or name").toEqual([]);

    const local = await createIsolatedScratchDatabase("slackguard_local", {
      env: { DATABASE_TEST_URL: "postgres://app:app@localhost:5433/app_test" }, makeClient,
    });
    const ci = await createIsolatedScratchDatabase("slackguard_ci", { env: { DATABASE_TEST_URL: CI_URL, ...CI_ENV }, makeClient });
    expect({
      events,
      localPath: new URL(local.url).pathname, localHost: new URL(local.url).host,
      ciPath: new URL(ci.url).pathname, ciHost: new URL(ci.url).host,
    }).toEqual({
      events: [
        "construct", "connect", "query create database slackguard_local", "end",
        "construct", "connect", "query create database slackguard_ci", "end",
      ],
      localPath: "/slackguard_local", localHost: "localhost:5433",
      ciPath: "/slackguard_ci", ciHost: "postgres:5432",
    });
  });

  it("is the guard every Slack history suite uses, and CI still selects those suites against the accepted service URL", () => {
    for (const suite of SUITES) {
      const source = readFileSync(join(ROOT, suite), "utf8");
      expect({
        suite,
        importsSharedGuard: source.includes('import { createIsolatedScratchDatabase } from "./slack-history-isolated-url";'),
        createsThroughIt: source.includes("createIsolatedScratchDatabase("),
        noLocalGuard: !/function requireIsolatedTestUrl/.test(source),
        noDirectCreate: !/create database/i.test(source),
      }).toEqual({ suite, importsSharedGuard: true, createsThroughIt: true, noLocalGuard: true, noDirectCreate: true });
    }
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const declared = /DATABASE_TEST_URL:\s*(\S+)/.exec(workflow)?.[1];
    expect({
      declared, acceptedUnderCi: verdict(declared, CI_ENV),
      runsTier: /^\s*- run: npm run test:datamechanics\s*$/m.test(workflow),
    }).toEqual({ declared: CI_URL, acceptedUnderCi: "accepted", runsTier: true });
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:datamechanics"]).toBe("vitest run --config vitest.datamechanics.config.ts");
    const config = readFileSync(join(ROOT, "vitest.datamechanics.config.ts"), "utf8");
    expect(config.includes('include: ["test/datamechanics/**/*.datamechanics.test.ts"]')).toBe(true);
    for (const suite of SUITES) expect(suite.startsWith("test/datamechanics/") && suite.endsWith(".datamechanics.test.ts")).toBe(true);
  });
});
