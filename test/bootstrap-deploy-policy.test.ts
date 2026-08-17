import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoSeedDecision, isLocalAppUrl, normalizeTeamSlug } from "../scripts/setup/deploy-policy.mjs";

/**
 * The two decisions `docker/bootstrap.mjs` makes from the environment before it writes anything.
 * Both specs come from the same place: what a client hits when they deploy this PUBLIC repo by
 * hand, rather than through the Railway template that fills the variables in for them.
 *
 *   1. Demo seeding. The demo admin is a documented credential in a public repo
 *      (`admin@demo.local` / `aios-demo-password`) that bootstrap PRINTS. A hand deploy has no
 *      TEAM_SLUG, so it falls through to the demo path with NODE_ENV=production (the Dockerfile
 *      sets it) and a public address — a brain anyone who finds the URL can log into as admin.
 *   2. TEAM_SLUG. Railway's deploy form has no input validation, so "Acme Corp" is what an
 *      operator types. `createTeam` rejects it → `admin.ts` die() → restart loop → failed
 *      deployment over a half-provisioned database.
 *
 * Local-dev ergonomics are part of the spec, not a footnote: `docker compose up` must keep
 * seeding exactly as it did, so the tests below pin the compose environment too.
 */

const COMPOSE_LOCAL = { NODE_ENV: "production", APP_URL: "http://localhost:3000" }; // Dockerfile + compose.yml

describe("demo seeding — safe by default where it can be reached", () => {
  it("does NOT seed a production deploy on a public URL unless asked", () => {
    // The defect: a hand deploy of this repo came up with a documented admin login on a
    // public address, with the password in the deploy log.
    const d = demoSeedDecision({ NODE_ENV: "production", APP_URL: "https://brain.acme-corp.com" });
    expect(d.seed).toBe(false);
    expect(d.reason).toBe("opt-in-required");
    expect(d.publicProduction).toBe(true);
  });

  it("seeds that deploy when the operator explicitly opts in", () => {
    const env = { NODE_ENV: "production", APP_URL: "https://brain.acme-corp.com", SEED_DEMO: "true" };
    expect(demoSeedDecision(env)).toMatchObject({ seed: true, publicProduction: true });
  });

  it("keeps `docker compose up` seeding exactly as before", () => {
    // NODE_ENV=production comes from the Dockerfile even on a laptop, so production alone must
    // never be the trigger — the URL is what decides.
    expect(demoSeedDecision({ ...COMPOSE_LOCAL, SEED_DEMO: "true" }).seed).toBe(true); // compose default
    expect(demoSeedDecision(COMPOSE_LOCAL).seed).toBe(true); // SEED_DEMO unset
    expect(demoSeedDecision({ NODE_ENV: "production" }).seed).toBe(true); // APP_URL unset → localhost default
    expect(demoSeedDecision({ NODE_ENV: "test", APP_URL: "https://brain.acme-corp.com" }).seed).toBe(true);
  });

  it("still honours SEED_DEMO=false everywhere — and its obvious spellings", () => {
    for (const flag of ["false", "FALSE", "0", "no", "off"]) {
      expect(demoSeedDecision({ ...COMPOSE_LOCAL, SEED_DEMO: flag })).toMatchObject({
        seed: false,
        reason: "disabled",
      });
    }
  });

  it("treats an address it cannot parse as public, not as local", () => {
    // The two mistakes are not symmetrical: a public URL read as local publishes a known
    // password, a local URL read as public costs one opt-in.
    expect(isLocalAppUrl("brain.acme-corp.com")).toBe(false); // no scheme → unparseable
    expect(isLocalAppUrl("https://localhost.attacker.com")).toBe(false); // not a localhost host
    expect(isLocalAppUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalAppUrl("http://host.docker.internal:3000")).toBe(true);
    expect(isLocalAppUrl(undefined)).toBe(true);
  });
});

describe("TEAM_SLUG — a typo must not become a failed deployment", () => {
  it("normalises what an operator actually types into the deploy form", () => {
    expect(normalizeTeamSlug("Acme Corp")).toEqual({ slug: "acme-corp", changed: true });
    expect(normalizeTeamSlug("  Acme  Corp, Inc. ")).toEqual({ slug: "acme-corp-inc", changed: true });
    expect(normalizeTeamSlug("Café Ltd")).toEqual({ slug: "cafe-ltd", changed: true });
    expect(normalizeTeamSlug("-acme-")).toEqual({ slug: "acme", changed: true });
  });

  it("leaves an already-valid slug alone and reports no change", () => {
    // `changed` drives whether bootstrap warns, so a valid slug must not produce noise about a
    // URL that did not move.
    expect(normalizeTeamSlug("acme-corp")).toEqual({ slug: "acme-corp", changed: false });
    expect(normalizeTeamSlug("acme2")).toEqual({ slug: "acme2", changed: false });
  });

  it("produces something lib/admin/teams.ts will accept, for every input it accepts at all", () => {
    // The point of normalising is to never reach `createTeam`'s throw. Pin it against the REAL
    // regex read out of that module, so a tightening there fails here instead of in a client's
    // deploy log.
    const teams = readFileSync(join(import.meta.dirname, "..", "lib", "admin", "teams.ts"), "utf8");
    const source = /const SLUG_RE = \/(.+?)\/;/.exec(teams);
    expect(source, "SLUG_RE not found in lib/admin/teams.ts").toBeTruthy();
    const slugRe = new RegExp(source![1]);

    for (const input of ["Acme Corp", "ACME", "acme corp inc", "Café Ltd", "  spaced  ", "a", "9lives", "-x-"]) {
      const { slug } = normalizeTeamSlug(input);
      expect(slug, `no slug for ${input}`).toBeTruthy();
      expect(slugRe.test(slug!), `'${slug}' from '${input}' would be rejected by createTeam`).toBe(true);
    }
  });

  it("fails loudly rather than inventing a name when nothing usable is left", () => {
    // Normalising must not turn "!!!" into a team called "-" or "". The caller exits with a
    // message; what it must never do is guess.
    for (const input of ["!!!", "   ", "", undefined, "---"]) {
      expect(normalizeTeamSlug(input)).toEqual({ slug: null, changed: false });
    }
  });
});

describe("bootstrap wires both decisions in", () => {
  // The recurring failure here is a correct helper that nothing calls. Pin the call sites.
  const src = readFileSync(join(import.meta.dirname, "..", "docker", "bootstrap.mjs"), "utf8");

  it("asks deploy-policy before seeding, and never re-implements the check inline", () => {
    expect(src).toMatch(/import \{[^}]*demoSeedDecision[^}]*\} from "\.\.\/scripts\/setup\/deploy-policy\.mjs"/);
    expect(src).toContain("demoSeedDecision(process.env)");
    expect(src).not.toMatch(/SEED_DEMO === "false"/); // the exact-string check this replaced
  });

  it("normalises TEAM_SLUG before create-team runs", () => {
    const normalizeAt = src.indexOf("normalizeTeamSlug(");
    const createTeamAt = src.indexOf('"create-team"');
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(createTeamAt).toBeGreaterThan(-1);
    expect(normalizeAt).toBeLessThan(createTeamAt);
  });
});
