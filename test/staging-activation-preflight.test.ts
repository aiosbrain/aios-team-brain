import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_CHECKS, ACTIVATION_DOCUMENTS, ACTIVATION_STATUS,
  assertActivated, assertReadOnlyDocument, evaluateActivation, formatActivationReport,
  readActivationFacts,
} from "../scripts/staging-ops/activation-preflight.mjs";
import { runImporter } from "../scripts/staging-ops/importer.mjs";

/**
 * H2: the recovered tree had `assertStagingTopology` — a pure validator over a supplied document,
 * with no production caller — and that is not a verifier. A JSON file can say anything; the
 * question activation turns on is what the PROVIDERS say. These tests pin the three properties
 * that distinguish the two: measured facts, an unverified verdict that refuses, and no claim
 * accepted as evidence.
 */

const TOPOLOGY = {
  repositoryDefaultBranch: "staging",
  contributionBranch: "staging",
  staging: {
    projectId: "project-a", environmentId: "env-staging",
    appServiceId: "service-app", graphitiServiceId: "service-graphiti",
    postgresServiceId: "service-postgres", neo4jServiceId: "service-neo4j",
    appSourceBranch: "staging", postgresHost: "postgres.railway.internal", neo4jHost: "neo4j.railway.internal",
    variableReferences: { DATABASE_URL: "${{Postgres.DATABASE_URL}}", NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687" },
  },
  production: {
    projectId: "project-a", environmentId: "env-production",
    appServiceId: "service-app", graphitiServiceId: "service-graphiti",
    postgresServiceId: "service-postgres", neo4jServiceId: "service-neo4j",
    appSourceBranch: "main", postgresHost: "postgres.railway.internal", neo4jHost: "neo4j.railway.internal",
    variableReferences: { DATABASE_URL: "${{Postgres.DATABASE_URL}}", NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687" },
  },
};

const digest = "image.example/aios-staging-ops@sha256:" + "a".repeat(64);

/** Everything measured, everything correct — the only input that may produce ACTIVATED. */
function fullyMeasured() {
  return {
    topology: { document: structuredClone(TOPOLOGY), measuredFrom: "railway project read-back 2026-09-07" },
    tokens: {
      staging: { projectId: "project-a", environmentId: "env-staging" },
      production: { projectId: "project-a", environmentId: "env-production" },
    },
    runners: {
      exporter: { image: digest, repo: null, autoDeploy: false },
      importer: { image: digest, repo: null, autoDeploy: false },
    },
    appDeployment: { id: "dep-1", status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app", url: "https://staging.example.com" },
    appHealth: { status: 200, body: { ok: true, mode: "copy-ready", answering: "disabled", graph: "readable" } },
    graphitiProviderCredentials: [],
    credentialFingerprints: {
      local: { "auth-secret": { version: 1, keyId: "k1", credentialClass: "auth-secret", mac: "a".repeat(43) } },
      remote: { "auth-secret": { version: 1, keyId: "k1", credentialClass: "auth-secret", mac: "b".repeat(43) } },
    },
    schedules: { activated: false },
    operatorClaims: {},
  };
}

describe("the verifier reads and never writes", () => {
  it("refuses any mutating or unlisted document before it reaches the network", () => {
    expect(() => assertReadOnlyDocument("mutation Whatever { deploymentStop(id: \"x\") }")).toThrow(/mutating/);
    expect(() => assertReadOnlyDocument("query SomethingElse { me { id } }")).toThrow(/unlisted/);
    expect(() => assertReadOnlyDocument("{ projectToken { projectId } }")).toThrow(/unlisted/);
  });

  it("accepts exactly the three documents it ships, and they are all queries", () => {
    for (const document of Object.values(ACTIVATION_DOCUMENTS)) {
      expect(() => assertReadOnlyDocument(document)).not.toThrow();
      expect(String(document)).not.toMatch(/\bmutation\b/i);
    }
  });
});

describe("evaluateActivation", () => {
  it("reports ACTIVATED only when every check is measured and passing", () => {
    const result = evaluateActivation(fullyMeasured());
    expect(result.status).toBe(ACTIVATION_STATUS.ACTIVATED);
    // Every check reports, always. A check that can be omitted is a check that can be skipped.
    expect(result.checks.map((c) => c.id)).toEqual([...ACTIVATION_CHECKS]);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("reports UNVERIFIED — not ACTIVATED — for anything it could not measure", () => {
    // The distinction that matters: "we could not look" must never read as "we looked and it is
    // fine". This is the state the recovered tree's pure validator could not express at all.
    for (const drop of ["topology", "tokens", "runners", "appDeployment", "appHealth", "credentialFingerprints", "schedules"] as const) {
      const facts = fullyMeasured();
      delete (facts as Record<string, unknown>)[drop];
      const result = evaluateActivation(facts);
      expect(result.status, drop).toBe(ACTIVATION_STATUS.UNVERIFIED);
      expect(result.checks.some((c) => c.status === "unverified"), drop).toBe(true);
      // ...and never a fail, which would send the operator looking for a misconfiguration.
      expect(result.checks.filter((c) => c.status === "fail"), drop).toEqual([]);
    }
  });

  it("treats a topology document with no recorded provenance as a claim, not a measurement", () => {
    const facts = fullyMeasured();
    facts.topology.measuredFrom = null;
    const result = evaluateActivation(facts);
    expect(result.status).toBe(ACTIVATION_STATUS.UNVERIFIED);
    expect(result.checks.find((c) => c.id === "topology-identity")).toMatchObject({ status: "unverified" });
  });

  it("defaults the unmeasurable sidecar check to unverified with a named reason", () => {
    // Reading the sidecar's variables needs provider surface this verifier deliberately does not
    // carry. That is a KNOWN gap with a name, not a silent pass.
    const facts = fullyMeasured();
    delete (facts as Record<string, unknown>).graphitiProviderCredentials;
    const check = evaluateActivation(facts).checks.find((c) => c.id === "graphiti-no-provider-credentials");
    expect(check).toMatchObject({ status: "unverified" });
    expect(check!.detail).toContain("no variable read");
  });

  it.each([
    ["a token scoped to the wrong environment", (f: ReturnType<typeof fullyMeasured>) => { f.tokens.staging.environmentId = "env-production"; }, "token-environment-scope"],
    ["one token seeing both environments", (f: ReturnType<typeof fullyMeasured>) => { f.tokens.production.environmentId = "env-staging"; f.topology.document.production.environmentId = "env-staging"; }, "token-environment-scope"],
    ["a runner on a mutable tag", (f: ReturnType<typeof fullyMeasured>) => { f.runners.importer.image = "image.example/aios-staging-ops:latest"; }, "runner-image-pinned"],
    ["a runner with a repository source", (f: ReturnType<typeof fullyMeasured>) => { f.runners.exporter.repo = "owner/repo"; }, "runner-image-pinned"],
    ["autodeploy left on", (f: ReturnType<typeof fullyMeasured>) => { f.runners.importer.autoDeploy = true; }, "runner-autodeploy-disabled"],
    ["a deployment in another environment", (f: ReturnType<typeof fullyMeasured>) => { f.appDeployment.environmentId = "env-production"; }, "app-deployment-measured"],
    ["a rejected health token", (f: ReturnType<typeof fullyMeasured>) => { f.appHealth = { status: 401, body: {} }; }, "app-mode-declared"],
    ["no staging mode", (f: ReturnType<typeof fullyMeasured>) => { f.appHealth.body.mode = "production"; }, "app-mode-declared"],
    ["a shared credential", (f: ReturnType<typeof fullyMeasured>) => { f.credentialFingerprints.remote = f.credentialFingerprints.local; }, "credential-separation"],
    ["a sidecar holding provider keys", (f: ReturnType<typeof fullyMeasured>) => { f.graphitiProviderCredentials = ["OPENAI_API_KEY"]; }, "graphiti-no-provider-credentials"],
    ["schedules already enabled", (f: ReturnType<typeof fullyMeasured>) => { f.schedules.activated = true; }, "schedules-disabled"],
  ])("reports NOT ACTIVATED for %s", (_name, mutate, expectedCheck) => {
    const facts = fullyMeasured();
    mutate(facts);
    const result = evaluateActivation(facts);
    expect(result.status).toBe(ACTIVATION_STATUS.NOT_ACTIVATED);
    expect(result.checks.find((c) => c.id === expectedCheck)).toMatchObject({ status: "fail" });
  });

  it("fails an app configured for the unimplemented budgeted interactive mode, by name", () => {
    const facts = fullyMeasured();
    facts.appHealth.body.answering = "unsupported-budgeted-mode";
    const result = evaluateActivation(facts);
    expect(result.status).toBe(ACTIVATION_STATUS.NOT_ACTIVATED);
    expect(result.checks.find((c) => c.id === "app-no-model-spend")!.detail)
      .toContain("staging-budgeted-interactive-query-unsupported");
  });

  it("records an operator's claim and lets it satisfy nothing", () => {
    const facts = fullyMeasured();
    delete (facts as Record<string, unknown>).appHealth;
    facts.operatorClaims = { ACTIVATION_CLAIM_HEALTH_CHECKED: "claimed (not evidence)" };
    const result = evaluateActivation(facts);
    expect(result.status).toBe(ACTIVATION_STATUS.UNVERIFIED);
    expect(result.claims).toHaveProperty("ACTIVATION_CLAIM_HEALTH_CHECKED");
    expect(formatActivationReport(result)).toContain("NOT evidence");
  });
});

describe("assertActivated", () => {
  it("refuses UNVERIFIED as firmly as NOT ACTIVATED", () => {
    const unverified = evaluateActivation({});
    expect(unverified.status).toBe(ACTIVATION_STATUS.UNVERIFIED);
    expect(() => assertActivated(unverified)).toThrow(/staging activation is UNVERIFIED/);
    const notActivated = fullyMeasured();
    notActivated.schedules.activated = true;
    expect(() => assertActivated(evaluateActivation(notActivated))).toThrow(/staging activation is NOT ACTIVATED/);
    expect(assertActivated(evaluateActivation(fullyMeasured())).status).toBe(ACTIVATION_STATUS.ACTIVATED);
  });
});

describe("the report is redacted", () => {
  it("prints no variable values, tokens or connection strings", () => {
    const facts = fullyMeasured();
    facts.topology.document.staging.variableReferences.DATABASE_URL = "postgres://user:hunter2@host/db";
    const report = formatActivationReport(evaluateActivation(facts), ["staging health: origin or token not supplied"]);
    expect(report).not.toContain("hunter2");
    expect(report).not.toContain("postgres://");
    expect(report).toContain("staging activation:");
  });
});

describe("readActivationFacts", () => {
  it("measures nothing it has no credential for, and says so instead of throwing", async () => {
    // A verifier that dies on the first missing input reports nothing about everything else, which
    // is the same blind spot as passing silently.
    const fetchImpl = vi.fn();
    const facts = await readActivationFacts({} as NodeJS.ProcessEnv, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(facts.tokens).toEqual({ staging: null, production: null });
    expect(facts.notes.join(" ")).toContain("no read token supplied");
    expect(evaluateActivation(facts).status).toBe(ACTIVATION_STATUS.UNVERIFIED);
  });

  it("sends only listed read-only documents, with the token in the header and never in a message", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => {
        const query = String(JSON.parse(init.body).query);
        assertReadOnlyDocument(query); // throws if anything unlisted is ever sent
        return { data: { projectToken: { projectId: "project-a", environmentId: "env-staging" } } };
      },
    }));
    const facts = await readActivationFacts(
      { RAILWAY_STAGING_READ_TOKEN: "staging-token-value" } as NodeJS.ProcessEnv,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(facts.tokens.staging).toEqual({ projectId: "project-a", environmentId: "env-staging" });
    expect(JSON.stringify(facts.notes)).not.toContain("staging-token-value");
  });
});

describe("the verifier has a caller", () => {
  it("is reachable as an importer action that refuses an unverified activation", async () => {
    // The recovered validator's whole problem was having no caller. This is the caller: a
    // read-only action needing no database, no locks and no runner role — a check an operator runs
    // BEFORE the system it authorises exists.
    const activationRunner = vi.fn(async () => {
      const result = evaluateActivation({});
      return { ...result, notes: [], report: formatActivationReport(result) };
    });
    await expect(runImporter({} as NodeJS.ProcessEnv, ["activation-preflight"], { activationRunner }))
      .rejects.toThrow(/staging activation is UNVERIFIED/);
    expect(activationRunner).toHaveBeenCalledTimes(1);
  });

  it("returns the verdict when everything measures clean", async () => {
    const activationRunner = vi.fn(async () => {
      const result = evaluateActivation(fullyMeasured());
      return { ...result, notes: [], report: formatActivationReport(result) };
    });
    await expect(runImporter({} as NodeJS.ProcessEnv, ["activation-preflight"], { activationRunner }))
      .resolves.toMatchObject({ status: ACTIVATION_STATUS.ACTIVATED });
  });
});
