import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertServiceIdentity, isAiosService } from "../../scripts/service-guard.mjs";

/**
 * Service-identity guard — the runtime backstop that refuses to load this repo's schema
 * when it is running on a NON-AIOS Railway service. Spec = the 2026-06-27 incident: an
 * aios-team-brain worktree was `railway up`'d onto the **kula** service, whose
 * preDeployCommand (`npm run pg:schema`) then injected our schema into Kula's prod DB.
 *
 * The guard mirrors Kula's `src/lib/service-guard.ts`. These assertions are derived from
 * the intended contract, not the implementation:
 *   - AIOS's own services (aios / aios-team-brain / aios-*) are accepted.
 *   - Any other service (kula, kula-worker, …) is rejected.
 *   - The check is a no-op off Railway (RAILWAY_SERVICE_NAME unset).
 *   - An explicit AIOS_RAILWAY_SERVICES override wins.
 * Plus a STRUCTURAL guard: both schema loaders must actually call assertServiceIdentity
 * before opening a DB connection — otherwise the backstop isn't in the injection path.
 */

describe("isAiosService — allow-list policy", () => {
  const saved = process.env.AIOS_RAILWAY_SERVICES;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIOS_RAILWAY_SERVICES;
    else process.env.AIOS_RAILWAY_SERVICES = saved;
  });

  it("accepts AIOS's own services (prod + a future web/worker split)", () => {
    delete process.env.AIOS_RAILWAY_SERVICES;
    expect(isAiosService("aios-team-brain")).toBe(true); // the real prod service
    expect(isAiosService("aios")).toBe(true);
    expect(isAiosService("aios-web")).toBe(true);
    expect(isAiosService("aios-worker")).toBe(true);
  });

  it("rejects a foreign service — Kula and anything else", () => {
    delete process.env.AIOS_RAILWAY_SERVICES;
    expect(isAiosService("kula")).toBe(false);
    expect(isAiosService("kula-worker")).toBe(false);
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

describe("assertServiceIdentity — abort on a foreign service", () => {
  const savedService = process.env.RAILWAY_SERVICE_NAME;
  const savedOverride = process.env.AIOS_RAILWAY_SERVICES;
  beforeEach(() => {
    delete process.env.AIOS_RAILWAY_SERVICES;
  });
  afterEach(() => {
    if (savedService === undefined) delete process.env.RAILWAY_SERVICE_NAME;
    else process.env.RAILWAY_SERVICE_NAME = savedService;
    if (savedOverride === undefined) delete process.env.AIOS_RAILWAY_SERVICES;
    else process.env.AIOS_RAILWAY_SERVICES = savedOverride;
  });

  it("is a no-op off Railway (RAILWAY_SERVICE_NAME unset) — local/CI run unguarded", () => {
    delete process.env.RAILWAY_SERVICE_NAME;
    expect(() => assertServiceIdentity("load the AIOS schema")).not.toThrow();
  });

  it("passes on AIOS's own service", () => {
    process.env.RAILWAY_SERVICE_NAME = "aios-team-brain";
    expect(() => assertServiceIdentity("load the AIOS schema")).not.toThrow();
  });

  it("THROWS on the kula service — this is the 2026-06-27 injection it must stop", () => {
    process.env.RAILWAY_SERVICE_NAME = "kula";
    expect(() => assertServiceIdentity("load the AIOS schema")).toThrow(/not an AIOS service/);
  });
});

describe("the schema loaders wire the guard into the injection path", () => {
  // "It should have been there" — made permanent. If a future edit removes the guard
  // call (or moves it after the DB connection), this fails the build.
  const scriptsDir = join(import.meta.dirname, "..", "..", "scripts");

  for (const file of ["pg-load-schema.mjs", "pg-load-vector.mjs"]) {
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
});
