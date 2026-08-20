import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIOS_RAILWAY_PROJECT_ID,
  assertServiceIdentity,
  enforcementMarker,
  isAiosService,
} from "../../scripts/service-guard.mjs";

/**
 * Service-identity guard — the runtime backstop that refuses to load this repo's schema when
 * it is running on a Railway service this app does not belong on. Spec = the 2026-06-27
 * cross-project deploy incident: a worktree of this repo was `railway up`'d onto another
 * project's service, whose preDeployCommand (`npm run pg:schema`) then applied our schema.sql
 * to that project's production database.
 *
 * These assertions are derived from the intended contract, not the implementation. The
 * contract has TWO halves and the tests below must keep both honest, because each one is the
 * failure mode of over-satisfying the other:
 *
 *   A. It must still ABORT. On a deploy we can identify as AIOS-operated, a service outside
 *      the allow-list stops the release before any DB connection. If this half rots, the guard
 *      is decoration — so the aborting cases below are the non-vacuity proof: delete the throw
 *      (or make `isAiosService` return true) and they go red.
 *   B. It must NEVER block a third-party self-hoster. This repo is public and self-hosted; an
 *      operator who names their Railway service after their own company gets an unrecoverable
 *      failed release from a pre-deploy hook if the guard treats "not named aios*" as fatal.
 *
 * Plus a STRUCTURAL guard: both schema loaders must actually call assertServiceIdentity before
 * opening a DB connection — otherwise the backstop isn't in the injection path at all.
 */

/** A deploy inside AIOS's own Railway project — the platform injects the project id. */
const aiosDeploy = (service: string, extra: Record<string, string> = {}) => ({
  RAILWAY_SERVICE_NAME: service,
  RAILWAY_PROJECT_ID: AIOS_RAILWAY_PROJECT_ID,
  ...extra,
});

/** A stranger self-hosting this repo: their Railway project, their service name. */
const selfHostDeploy = (service: string, extra: Record<string, string> = {}) => ({
  RAILWAY_SERVICE_NAME: service,
  RAILWAY_PROJECT_ID: "7f3a1c90-0000-4000-8000-abcdefabcdef",
  ...extra,
});

const silent = { log: () => {} };

describe("A. it still aborts — the deploy this guard exists to stop", () => {
  it("THROWS when an AIOS deploy lands on a service outside the allow-list", () => {
    // The 2026-06-27 shape, reproduced inside the AIOS project: our app, someone else's
    // service, a pre-deploy schema load one step away from a foreign production database.
    expect(() =>
      assertServiceIdentity("load the AIOS schema", { env: aiosDeploy("other-app"), logger: silent })
    ).toThrow(/Refusing to load the AIOS schema/);
    expect(() =>
      assertServiceIdentity("load the AIOS schema", { env: aiosDeploy("postgres"), logger: silent })
    ).toThrow(/other-app|postgres/);
  });

  it("aborts BEFORE the database is named — the message never needs DATABASE_URL", () => {
    // The whole value is aborting before a connection exists, so the guard must reach its
    // verdict from the service identity alone.
    const env = aiosDeploy("other-app"); // deliberately no DATABASE_URL
    expect(() => assertServiceIdentity("load the AIOS schema", { env, logger: silent })).toThrow();
  });

  it("passes on AIOS's own services (prod + a future web/worker split)", () => {
    for (const svc of ["aios", "aios-team-brain", "aios-web", "aios-worker"]) {
      expect(() =>
        assertServiceIdentity("load the AIOS schema", { env: aiosDeploy(svc), logger: silent })
      ).not.toThrow();
    }
  });

  it("still enforces on AIOS's service when AIOS_RAILWAY_SERVICES is absent", () => {
    // The anti-accident property. An opt-in flag would have made pruning one "unused" variable
    // enough to silently disable production protection forever; the project id cannot be
    // forgotten into absence, so removing every AIOS-set variable changes nothing here.
    const env = aiosDeploy("other-app");
    expect(env.AIOS_RAILWAY_SERVICES).toBeUndefined();
    expect(enforcementMarker(env)).toBe("aios-project");
    expect(() => assertServiceIdentity("load the AIOS schema", { env, logger: silent })).toThrow();
  });

  it("is not disabled by a stray truthy-looking flag in the environment", () => {
    // Anything an operator (or a copied template) can set must not be able to turn the guard
    // off — only ON. These are the shapes someone would plausibly add by hand.
    for (const extra of [
      { AIOS_DEPLOY: "false" },
      { AIOS_SERVICE_GUARD: "off" },
      { SERVICE_GUARD_DISABLED: "1" },
      { NODE_ENV: "development" },
    ]) {
      expect(() =>
        assertServiceIdentity("load the AIOS schema", { env: aiosDeploy("other-app", extra), logger: silent })
      ).toThrow();
    }
  });
});

describe("B. it never blocks a third-party self-hoster", () => {
  it("does not throw on a self-hosted deploy whose service is named after its owner", () => {
    // This repo is public and self-hosted. `pg-load-schema.mjs` is the Railway
    // preDeployCommand, so a throw here is an unrecoverable failed release for someone who did
    // nothing wrong but name their service.
    for (const svc of ["acme-corp", "brain", "team-brain", "not-aios", "web"]) {
      expect(() =>
        assertServiceIdentity("load the AIOS schema", { env: selfHostDeploy(svc), logger: silent })
      ).not.toThrow();
    }
  });

  it("says out loud that it is not enforcing, so the deploy log is not ambiguous", () => {
    const lines: string[] = [];
    assertServiceIdentity("load the AIOS schema", {
      env: selfHostDeploy("acme-corp"),
      logger: { log: (m: string) => lines.push(m) },
    });
    expect(lines.join("\n")).toMatch(/not enforced/i);
    expect(lines.join("\n")).toMatch(/AIOS_RAILWAY_SERVICES/); // how to opt in
  });

  it("is a no-op off Railway (RAILWAY_SERVICE_NAME unset) — local/CI run unguarded", () => {
    expect(() => assertServiceIdentity("load the AIOS schema", { env: {}, logger: silent })).not.toThrow();
    expect(enforcementMarker({ RAILWAY_PROJECT_ID: AIOS_RAILWAY_PROJECT_ID })).toBe("aios-project");
  });

  it("lets a self-hoster opt IN, and then enforces their names, not ours", () => {
    const env = selfHostDeploy("acme-brain", { AIOS_RAILWAY_SERVICES: "acme-brain, acme-worker" });
    expect(enforcementMarker(env)).toBe("opt-in");
    expect(() => assertServiceIdentity("load the AIOS schema", { env, logger: silent })).not.toThrow();

    const wrong = selfHostDeploy("some-other-service", { AIOS_RAILWAY_SERVICES: "acme-brain, acme-worker" });
    expect(() => assertServiceIdentity("load the AIOS schema", { env: wrong, logger: silent })).toThrow(
      /some-other-service/
    );
  });
});

describe("the operator can act on the failure without knowing our history", () => {
  it("names the service, the allowed set, and the escape hatch — and nothing else", () => {
    let message = "";
    try {
      assertServiceIdentity("load the AIOS schema", { env: aiosDeploy("other-app"), logger: silent });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("other-app"); // what is wrong
    expect(message).toMatch(/aios \/ aios-\*/); // what was expected
    expect(message).toContain("AIOS_RAILWAY_SERVICES"); // how to fix it
    expect(message).toMatch(/before opening a database connection/i); // what did NOT happen
    // This string is printed into any self-hoster's deploy log. It must stay a description of
    // THEIR deployment, never a narrative about someone else's outage.
    expect(message).not.toMatch(/incident|outage|injected|took .* down/i);
  });

  it("reports the override list when one is configured", () => {
    expect(() =>
      assertServiceIdentity("load the AIOS schema", {
        env: aiosDeploy("other-app", { AIOS_RAILWAY_SERVICES: "brain-prod,brain-staging" }),
        logger: silent,
      })
    ).toThrow(/brain-prod,brain-staging/);
  });
});

describe("isAiosService — allow-list policy", () => {
  const saved = process.env.AIOS_RAILWAY_SERVICES;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIOS_RAILWAY_SERVICES;
    else process.env.AIOS_RAILWAY_SERVICES = saved;
  });

  it("accepts AIOS's own services and rejects everything else", () => {
    delete process.env.AIOS_RAILWAY_SERVICES; // exercise the process.env default binding
    expect(isAiosService("aios-team-brain")).toBe(true); // the real prod service
    expect(isAiosService("aios")).toBe(true);
    expect(isAiosService("aios-web")).toBe(true);
    expect(isAiosService("postgres")).toBe(false);
    expect(isAiosService("some-other-app")).toBe(false);
    // "aios" must be a real prefix, not a substring anywhere in the name.
    expect(isAiosService("not-aios")).toBe(false);
  });

  it("honors an explicit AIOS_RAILWAY_SERVICES override (exact match only)", () => {
    process.env.AIOS_RAILWAY_SERVICES = "brain-prod, brain-staging";
    expect(isAiosService("brain-prod")).toBe(true);
    expect(isAiosService("brain-staging")).toBe(true);
    expect(isAiosService("aios-team-brain")).toBe(false); // override replaces the default policy
  });
});

describe("the schema loaders wire the guard into the injection path", () => {
  // "It should have been there" — made permanent. If a future edit removes the guard call (or
  // moves it after the DB connection), this fails the build.
  const scriptsDir = join(import.meta.dirname, "..", "..", "scripts");

  // migrate-from-existing.mjs is here for a sharper reason than the other two: it is the only script
  // in the repo that issues CREATE DATABASE / DROP DATABASE, so an unguarded DATABASE_URL would mean
  // unsupervised DDL on whatever cluster the shell happens to point at.
  for (const file of ["pg-load-schema.mjs", "pg-load-vector.mjs", "migrate-from-existing.mjs"]) {
    it(`${file} calls assertServiceIdentity before constructing the pg Client`, () => {
      const src = readFileSync(join(scriptsDir, file), "utf8");
      expect(src).toMatch(/import\s*\{\s*assertServiceIdentity\s*\}\s*from\s*["']\.\/service-guard\.mjs["']/);
      const guardAt = src.indexOf("assertServiceIdentity(");
      const clientAt = src.indexOf("new Client(");
      expect(guardAt).toBeGreaterThan(-1);
      expect(clientAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(clientAt); // guard runs BEFORE any DB connection
    });
  }

  it("pins the enforcement marker to a platform-injected project id, not an opt-in flag", () => {
    // The choice is the security property (see the module header): an opt-in flag fails open
    // the moment it is pruned. A change here should be a deliberate one, with the header's
    // argument re-made.
    expect(AIOS_RAILWAY_PROJECT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const src = readFileSync(join(scriptsDir, "service-guard.mjs"), "utf8");
    expect(src).toMatch(/RAILWAY_PROJECT_ID/);
  });
});
