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
    // The point of normalising is to never reach `createTeam`'s throw, so the rule this asserts
    // against has to be the rule createTeam actually applies. Pinned three ways rather than by
    // compiling the file's text into a live RegExp (a dynamic RegExp from file contents is a
    // ReDoS shape, and CI is right to flag it): the literal below, the literal in the normaliser,
    // and the literal in teams.ts must all read identically — so tightening any one of them fails
    // here instead of in a client's deploy log.
    const readSlugRe = (rel: string[]) => {
      const src = readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
      return /const SLUG_RE = (\/.+?\/);/.exec(src)?.[1];
    };
    const pinned = "/^[a-z0-9][a-z0-9-]*$/";
    expect(readSlugRe(["lib", "admin", "teams.ts"]), "SLUG_RE not found in lib/admin/teams.ts").toBe(pinned);
    expect(readSlugRe(["scripts", "setup", "deploy-policy.mjs"])).toBe(pinned);

    const slugRe = /^[a-z0-9][a-z0-9-]*$/; // === pinned, asserted above
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

describe("compose does not answer the opt-in on the operator's behalf", () => {
  // The policy is only real if the environment reaching bootstrap is the operator's. compose.yml
  // used to materialise SEED_DEMO=true and DEMO_PASSWORD=aios-demo-password as explicit values —
  // so `docker compose up` behind a real domain (APP_URL edited, as it must be for invite links)
  // looked to bootstrap exactly like a deliberate opt-in, and seeded the documented password onto
  // a public URL. Local behaviour is unchanged either way: an empty SEED_DEMO still seeds on a
  // localhost APP_URL, and an empty DEMO_PASSWORD still falls back to the documented one there.
  const compose = readFileSync(join(import.meta.dirname, "..", "compose.yml"), "utf8");

  it("forwards SEED_DEMO and DEMO_PASSWORD empty rather than defaulting them", () => {
    expect(compose).toMatch(/SEED_DEMO:\s*\$\{SEED_DEMO:-\}/);
    expect(compose).toMatch(/DEMO_PASSWORD:\s*\$\{DEMO_PASSWORD:-\}/);
    expect(compose).not.toContain("${SEED_DEMO:-true}");
    expect(compose).not.toContain("aios-demo-password");
  });

  it("still seeds a laptop stack with the documented login", () => {
    // What compose actually hands bootstrap now, with the Dockerfile's NODE_ENV.
    const composeEnv = { NODE_ENV: "production", APP_URL: "http://localhost:3000", SEED_DEMO: "", DEMO_PASSWORD: "" };
    expect(demoSeedDecision(composeEnv)).toMatchObject({ seed: true, publicProduction: false });
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

  it("lets the decision GATE the seed, not merely be computed", () => {
    // Computing a decision and ignoring it is the shape this repo keeps getting bitten by: every
    // test above would stay green if `if (!DEMO.seed) … return` were dropped from main(), and the
    // documented credential would ship to public deploys again. main() can't be imported (module
    // scope calls process.exit), so pin the branch structurally.
    const gateAt = src.search(/if \(!DEMO\.seed\)/);
    const returnAt = src.indexOf("return;", gateAt);
    const seedAt = src.indexOf("scripts/seed-demo.ts");
    expect(gateAt, "the !DEMO.seed early return is gone").toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(gateAt);
    expect(returnAt).toBeLessThan(seedAt); // the gate returns BEFORE anything is seeded
  });

  it("normalises TEAM_SLUG before create-team runs", () => {
    const normalizeAt = src.indexOf("normalizeTeamSlug(");
    const createTeamAt = src.indexOf('"create-team"');
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(createTeamAt).toBeGreaterThan(-1);
    expect(normalizeAt).toBeLessThan(createTeamAt);
  });
});
