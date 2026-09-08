import { describe, expect, it } from "vitest";
import {
  ACTION_REQUIREMENTS,
  assertActionConfiguration,
  parseTesterCredentials,
  validateHealthToken,
  validateStagingOrigin,
} from "../scripts/staging-ops/action-preflight.mjs";

const TESTERS = JSON.stringify([{
  email: "tester@example.test",
  password: "Staging-only-Tester-Password-123!",
  teamId: "11111111-1111-4111-8111-111111111111",
  memberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  role: "admin",
  posture: "team",
}]);

const VALID = {
  STAGING_ORIGIN: "https://staging.example.test",
  STAGING_HEALTH_TOKEN: "t".repeat(32),
  STAGING_TESTER_CREDENTIALS_JSON: TESTERS,
  STAGING_GITHUB_READ_TOKEN: "ghp_example",
  GITHUB_REPOSITORY: "aiosbrain/aios-team-brain",
} as unknown as NodeJS.ProcessEnv;

describe("H2 — staging origin", () => {
  it("accepts an https origin with no credentials and no path", () => {
    expect(validateStagingOrigin("https://staging.example.test")).toEqual([]);
  });

  it.each([
    ["a missing value", undefined, /STAGING_ORIGIN is required/],
    ["plain http on the Railway adapter", "http://staging.example.test", /must use https/],
    ["a non-URL", "staging.example.test", /not a valid absolute URL/],
    ["an unsupported scheme", "ftp://staging.example.test", /protocol ftp: is not permitted/],
    ["embedded credentials", "https://user:pass@staging.example.test", /must not embed credentials/],
    ["a path", "https://staging.example.test/app", /must be an origin, not a path/],
  ])("refuses %s", (_label, value, message) => {
    expect(validateStagingOrigin(value as string | undefined).join("; ")).toMatch(message as RegExp);
  });

  it("permits the local harness origin only under the local adapter", () => {
    // The reproducible two-environment harness serves over plain HTTP on a compose network name,
    // which is not `localhost` and must not have to be.
    expect(validateStagingOrigin("http://maintenance:3000", { allowLocalHttp: true })).toEqual([]);
    expect(validateStagingOrigin("http://maintenance:3000", { allowLocalHttp: false })).not.toEqual([]);
  });
});

describe("H2 — health token", () => {
  it("accepts a token at the length the app's comparison requires", () => {
    expect(validateHealthToken("t".repeat(32))).toEqual([]);
  });

  it("refuses a token that could never match", () => {
    // The app compares in constant time and rejects anything under 32 characters, so a shorter
    // token is not a maybe — it is a boot probe that can only ever 401, discovered after the app
    // has already been replaced.
    expect(validateHealthToken("short").join("; ")).toMatch(/at least 32 characters/);
    expect(validateHealthToken(undefined).join("; ")).toMatch(/is required/);
  });
});

describe("H2 — tester credentials are parsed ONCE, before anything is replaced", () => {
  it("accepts a well-formed array", () => {
    expect(parseTesterCredentials(TESTERS)).toHaveLength(1);
  });

  it.each([
    ["missing", undefined, /is required before a pair can be restored/],
    ["not JSON", "{", /not valid JSON/],
    ["not an array", '{"email":"x"}', /must be an array/],
    ["empty", "[]", /must not be empty/],
    ["a null entry", "[null]", /tester\[0\] is not an object/],
    ["a blank field", '[{"email":"","password":"Staging-only-Tester-Password-123!","teamId":"t","memberId":"m","role":"admin","posture":"team"}]', /tester\[0\]\.email must be a non-blank string/],
    ["a weak password", '[{"email":"a@b.test","password":"short","teamId":"t","memberId":"m","role":"admin","posture":"team"}]', /password must be a string of at least 12/],
    ["an invalid posture", '[{"email":"a@b.test","password":"Staging-only-Tester-Password-123!","teamId":"t","memberId":"m","role":"admin","posture":"admin"}]', /posture must be exactly team or external/],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => parseTesterCredentials(raw as string | undefined)).toThrow(message as RegExp);
  });

  it("refuses two entries that claim the same identity", () => {
    const duplicated = JSON.parse(TESTERS).concat(JSON.parse(TESTERS));
    expect(() => parseTesterCredentials(JSON.stringify(duplicated))).toThrow(/duplicates the identity of tester\[0\]/);
  });

  it("never echoes a password in its diagnostics", () => {
    let message = "";
    try { parseTesterCredentials('[{"email":"","password":"Staging-only-Tester-Password-123!","teamId":"t","memberId":"m","role":"admin","posture":"team"}]'); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("Staging-only-Tester-Password-123!");
  });
});

describe("H2 — every action is gated on exactly what it later reaches for", () => {
  it("passes a complete configuration for each destructive action", () => {
    for (const action of ["install", "tick", "daemon", "rollback", "bootstrap-rollback"]) {
      expect(assertActionConfiguration(VALID, action)).toBe(true);
    }
  });

  it.each([
    ["install", "STAGING_ORIGIN"],
    ["install", "STAGING_HEALTH_TOKEN"],
    ["install", "STAGING_TESTER_CREDENTIALS_JSON"],
    ["tick", "STAGING_TESTER_CREDENTIALS_JSON"],
    ["daemon", "STAGING_ORIGIN"],
    // Rollback re-enters the SAME install path with the SAME environment, so an invalid tester
    // configuration failed the automatic recovery for a second time and reached recovery-required.
    ["rollback", "STAGING_TESTER_CREDENTIALS_JSON"],
    ["rollback", "STAGING_HEALTH_TOKEN"],
    // Bootstrap stops the app before it ever reads the origin or the token.
    ["bootstrap-rollback", "STAGING_ORIGIN"],
    ["bootstrap-rollback", "STAGING_HEALTH_TOKEN"],
  ])("refuses %s when %s is missing", (action, name) => {
    const env = { ...VALID, [name]: undefined } as NodeJS.ProcessEnv;
    expect(() => assertActionConfiguration(env, action)).toThrow(new RegExp(`staging ${action} refused before any lifecycle change`));
  });

  it("does not make bootstrap or rollback acquire a GitHub dependency they never use", () => {
    // `readStagingHead` validates these before the ordinary install path sets anything destructive,
    // and recovery must not gain a way to fail that recovery does not need.
    const env = { ...VALID, STAGING_GITHUB_READ_TOKEN: undefined, GITHUB_REPOSITORY: undefined } as NodeJS.ProcessEnv;
    expect(assertActionConfiguration(env, "rollback")).toBe(true);
    expect(assertActionConfiguration(env, "bootstrap-rollback")).toBe(true);
    expect(() => assertActionConfiguration(env, "install")).toThrow(/STAGING_GITHUB_READ_TOKEN is required/);
  });

  it("requires nothing extra of the read-only actions", () => {
    expect(assertActionConfiguration({} as NodeJS.ProcessEnv, "verify")).toBe(true);
    expect(assertActionConfiguration({} as NodeJS.ProcessEnv, "install-ops")).toBe(true);
    // M1: the destination proof boots nothing, restores nothing and reads no branch head, so it
    // reaches for none of these three settings either. Its own dependencies — the project,
    // environment, Postgres and importer pins — are required by `importerPreflight`, not here.
    expect(assertActionConfiguration({} as NodeJS.ProcessEnv, "verify-target")).toBe(true);
  });

  it("enumerates the ordinary action-requirements contract, and refuses anything outside it", () => {
    // The previous title — "covers every action the importer CLI accepts" — overstated this list.
    // `runImporter` accepts NINE actions; this table has eight, and the missing one is deliberate:
    // `activation-preflight` returns from `runImporter` before `importerPreflight`, because the
    // activation verifier is read-only, needs no database, no locks and no runner role, and making
    // it depend on the runtime it authorises would be circular. `install-ops` is in the table but
    // also returns early inside `importerPreflight`, which is why it requires nothing extra above.
    //
    // What this row actually pins is the ORDINARY contract: every action that reaches
    // `assertActionConfiguration` has a requirements row, and an action with no row FAILS CLOSED.
    // A future action that quietly inherited no requirements is the shape of this whole defect —
    // and the second assertion is what makes that failure closed rather than permissive.
    expect(Object.keys(ACTION_REQUIREMENTS).sort()).toEqual(
      ["bootstrap-rollback", "daemon", "install", "install-ops", "rollback", "tick", "verify", "verify-target"]
    );
    expect(() => assertActionConfiguration(VALID, "not-an-action")).toThrow(/unknown importer action/);
    // The intentional exception, stated as an assertion rather than only in prose: it is absent from
    // the table AND it is refused here, so nothing reads its absence as a permissive fallback.
    expect(ACTION_REQUIREMENTS).not.toHaveProperty("activation-preflight");
    expect(() => assertActionConfiguration(VALID, "activation-preflight")).toThrow(/unknown importer action/);
  });
});
