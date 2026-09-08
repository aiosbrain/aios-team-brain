import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_CHECKS, ACTIVATION_DOCUMENTS, ACTIVATION_STATUS, REQUIRED_CREDENTIAL_CLASSES,
  assertActivationPreflightReady, assertReadOnlyDocument, evaluateActivation, formatActivationReport,
  readActivationFacts,
} from "../scripts/staging-ops/activation-preflight.mjs";
import { FINGERPRINT_VERSION, fingerprintsComparable, fingerprintsEqual } from "../scripts/staging-ops/credential-fingerprint.mjs";
import { runImporter } from "../scripts/staging-ops/importer.mjs";
import { SYNTHETIC_COMPARISON_KEY_BASE64, writeSyntheticRemoteFingerprints } from "./helpers/activation-remote-fingerprints";

/**
 * H2: the recovered tree had `assertStagingTopology` — a pure validator over a supplied document,
 * with no production caller — and that is not a verifier. A JSON file can say anything; the
 * question activation turns on is what the PROVIDERS say. These tests pin the three properties
 * that distinguish the two: measured facts, an unverified verdict that refuses, and no claim
 * accepted as evidence.
 *
 * The Astra review of the first callable version accepted five more, each of which is a way for a
 * check to pass on something that is not evidence, and they are pinned here as their own cases:
 *
 *   1. the privileged health token must be bound to the MEASURED deployment domain BEFORE it is
 *      sent — a comparison performed afterwards cannot un-send a credential;
 *   2. an operator's `measuredFrom` label is not provenance, and the topology file is a document of
 *      expected pins that has to be corroborated against provider read-backs;
 *   3. a missing, malformed or differently-keyed fingerprint is INCOMPARABLE, not "different" —
 *      `fingerprintsEqual` answers false for all of them, and that false used to read as separation;
 *   4. BOTH runners, named — one successful measurement satisfied a check whose text says "both";
 *   5. the verdict may not be called `ACTIVATED` when its schedule check passes only while the
 *      automation is switched off.
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
const COMMIT = "c".repeat(40);

/**
 * A comparison KEY ID, not a secret — it names which comparison key minted a MAC and is meant to
 * travel in the clear. `compare-2026-09` nevertheless tripped gitleaks' `generic-api-key` rule,
 * because that rule matches any `key…: "<10+ chars>"` above 3.5 bits of entropy and cannot know the
 * difference. The value is now deliberately synthetic and low-entropy, which clears the finding
 * without allowlisting anything or weakening a single comparison assertion below — the tests only
 * ever depended on local and remote agreeing on this string, never on what it was.
 *
 * The opposite-environment fingerprint document that used to live in
 * `fixtures/activation-remote-fingerprints.json` failed the same rule for a different and
 * unavoidable reason — a `keyConfirmation` IS a maximal-entropy 32-byte HMAC — and is now generated
 * at runtime instead (`./helpers/activation-remote-fingerprints`).
 * Keep it that way if you change it (`test/guards/fixture-key-id-entropy.test.ts` pins both).
 */
const COMPARISON_KEY_ID = "example-key";

/** 32 bytes, base64url — the only MAC shape a well-formed fingerprint may carry. */
const mac = (fill: string) => Buffer.alloc(32, fill).toString("base64url");

const fingerprint = (credentialClass: string, credentialMac: string, over: Record<string, unknown> = {}) => ({
  version: FINGERPRINT_VERSION, keyId: COMPARISON_KEY_ID, keyConfirmation: mac("k"), credentialClass, mac: credentialMac, ...over,
});

const fingerprintSet = (fill: string) =>
  Object.fromEntries(REQUIRED_CREDENTIAL_CLASSES.map((c) => [c, fingerprint(c, mac(fill))]));

/** Everything measured, everything correct — the only input that may produce READY TO ACTIVATE. */
function fullyMeasured() {
  // H1: an acquisition also carries the SUBJECT identities it measured — the service IDs the
  // branch/host/reference facts above are ABOUT. `topology-identity` claims "pinned identities …
  // are corroborated", and until these were compared that sentence was true of everything except
  // the identities.
  const acquiredSide = (side: "staging" | "production") => ({
    scope: { projectId: "project-a", environmentId: side === "staging" ? "env-staging" : "env-production" },
    app: {
      serviceId: "service-app",
      source: { repository: "org/repo", branch: side === "staging" ? "staging" : "main" },
      postgresHost: "postgres.railway.internal", neo4jHost: "neo4j.railway.internal",
      references: { DATABASE_URL: { kind: "railway-service-reference" }, NEO4J_URL: { kind: "railway-service-reference" } },
    },
    resources: { postgres: { serviceId: "service-postgres" }, neo4j: { serviceId: "service-neo4j" } },
  });
  return {
    topology: { document: structuredClone(TOPOLOGY), measuredFrom: "railway project read-back 2026-09-07", acquisition: {
      repository: "org/repo", contributionBranch: "staging", github: { fullName: "org/repo", defaultBranch: "staging" },
      staging: acquiredSide("staging"), production: acquiredSide("production"),
    } },
    tokens: {
      staging: { projectId: "project-a", environmentId: "env-staging" },
      production: { projectId: "project-a", environmentId: "env-production" },
    },
    // The signed production measurement is about the production services THIS consumer pinned.
    // Absent or mismatched, `production-subject-identity` refuses and `credential-separation` may
    // not pass — both covered by their own cases below and in the acquisition suite.
    productionSubjects: { bound: true, mismatches: [], unmeasured: [] },
    // `imageDigest` is what the pinned ACTIVE deployment reports running; `image` is only what the
    // service is CONFIGURED with, and Railway's staged changes can advance one without the other.
    runners: {
      exporter: { serviceId: "svc-exporter", expectedServiceId: "svc-exporter", image: digest, imageDigest: `sha256:${"a".repeat(64)}`, expectedImage: digest, repo: null, autoDeploy: false },
      importer: { serviceId: "svc-importer", expectedServiceId: "svc-importer", image: digest, imageDigest: `sha256:${"a".repeat(64)}`, expectedImage: digest, repo: null, autoDeploy: false },
    },
    appDeployment: { id: "dep-1", status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app", url: "https://staging.example.com", commitSha: COMMIT },
    // The binding decision the ACQUISITION made before presenting a token. It is a fact like any
    // other: the evaluator judges it, and cannot re-derive it, because whether a request was sent
    // is not recoverable from the answer.
    healthBinding: { bound: true, origin: "https://staging.example.com", refusal: null, kind: null },
    // `refreshRunId` is part of the served contract, not decoration: a `copy-ready` claim with no
    // refresh run names a dataset that was never installed.
    appHealth: { status: 200, origin: "https://staging.example.com", body: { ok: true, commit: COMMIT, mode: "copy-ready", refreshRunId: "run-9", answering: "disabled", graph: "readable" } },
    graphitiProviderCredentials: [],
    // Authenticated, environment-bound provenance for BOTH sides. Remote-only provenance is still
    // "an unauthenticated local value differs from an authenticated remote one", which is not live
    // separation. NOTHING in this build can produce either (`readActivationFacts` sets both to
    // `null`), which is exactly why the real command cannot certify it — see the dedicated tests.
    credentialFingerprints: {
      local: fingerprintSet("a"), remote: fingerprintSet("b"),
      localProvenance: { authenticated: true, environmentId: "env-staging" },
      remoteProvenance: { authenticated: true, environmentId: "env-production" },
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
  it("reports READY TO ACTIVATE — never ACTIVATED — when every check is measured and passing", () => {
    const result = evaluateActivation(fullyMeasured());
    expect(result.status).toBe(ACTIVATION_STATUS.READY);
    // The name has to survive: a verifier whose schedule check passes only while the automation is
    // OFF cannot report a word that means the automation is running.
    expect(result.status).not.toBe("ACTIVATED");
    expect(JSON.stringify(ACTIVATION_STATUS)).not.toContain('"ACTIVATED"');
    // Every check reports, always. A check that can be omitted is a check that can be skipped.
    expect(result.checks.map((c) => c.id)).toEqual([...ACTIVATION_CHECKS]);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    // The two conditions added by this change are IN that passing set, so the negative cases below
    // are one changed term away from a genuinely passing input rather than from an already-broken one.
    expect(result.checks.find((c) => c.id === "production-subject-identity")!.status).toBe("pass");
    // ...and the schedule check says out loud that it read a file, not the platform.
    expect(result.checks.find((c) => c.id === "schedules-disabled-in-contract-file")!.detail)
      .toMatch(/local configuration check/);
  });

  it("H1: refuses when the signed production measurement is about other production services", () => {
    // ONE term changed from the passing input above. `topology-identity` must stop claiming that
    // "pinned identities … are corroborated", the named subject check must FAIL, and separation
    // must stop passing — the three statements the defect made simultaneously and wrongly.
    for (const pin of ["appServiceId", "postgresServiceId", "neo4jServiceId"] as const) {
      const facts = fullyMeasured();
      const measured = facts.topology.acquisition.production as Record<string, any>;
      if (pin === "appServiceId") measured.app.serviceId = "some-other-production-app";
      else measured.resources[pin === "postgresServiceId" ? "postgres" : "neo4j"].serviceId = `some-other-${pin}`;
      facts.productionSubjects = { bound: false, mismatches: [`the measurement describes a different ${pin} than the one pinned here`], unmeasured: [] };

      const result = evaluateActivation(facts);
      expect(result.status, pin).toBe(ACTIVATION_STATUS.NOT_ACTIVATED);
      expect(result.checks.find((c) => c.id === "production-subject-identity")!.status, pin).toBe("fail");
      expect(result.checks.find((c) => c.id === "topology-identity")!.status, pin).toBe("fail");
      expect(result.checks.find((c) => c.id === "credential-separation")!.status, pin).not.toBe("pass");
    }
  });

  it("the runner check is about the artifact RUNNING, not the one configured", () => {
    // Configuration exactly equals the pin — the two comparisons that already existed both pass —
    // and the pinned active deployment reports a DIFFERENT artifact. Railway documents staged
    // changes that can be committed without redeploying, so this is not a contrived divergence.
    const wrong = fullyMeasured();
    wrong.runners.exporter.imageDigest = `sha256:${"b".repeat(64)}`;
    const mismatch = evaluateActivation(wrong);
    expect(mismatch.status).toBe(ACTIVATION_STATUS.NOT_ACTIVATED);
    expect(mismatch.checks.find((c) => c.id === "runner-image-pinned")!.detail).toMatch(/RUNNING a different artifact/);

    // Absent or malformed metadata is UNVERIFIED, never a pass: the configured reference is not
    // evidence about the running artifact, which is the whole point of the measurement.
    for (const value of [undefined, null, "", "latest", "sha256:short"]) {
      const unmeasured = fullyMeasured();
      unmeasured.runners.importer.imageDigest = value as string;
      const result = evaluateActivation(unmeasured);
      expect(result.status, String(value)).not.toBe(ACTIVATION_STATUS.READY);
      expect(result.checks.find((c) => c.id === "runner-image-pinned")!.status, String(value)).toBe("unverified");
    }
  });

  it("reports UNVERIFIED — not READY — for anything it could not measure", () => {
    for (const drop of ["topology", "tokens", "runners", "appDeployment", "appHealth", "credentialFingerprints", "schedules", "productionSubjects"] as const) {
      const facts = fullyMeasured();
      delete (facts as Record<string, unknown>)[drop];
      const result = evaluateActivation(facts);
      expect(result.status, drop).toBe(ACTIVATION_STATUS.UNVERIFIED);
      expect(result.checks.some((c) => c.status === "unverified"), drop).toBe(true);
      // ...and never a fail, which would send the operator looking for a misconfiguration.
      expect(result.checks.filter((c) => c.status === "fail"), drop).toEqual([]);
    }
  });

  it("treats the topology file as CLAIMS: a provenance label corroborates nothing", () => {
    // The accepted finding: `STAGING_TOPOLOGY_MEASURED_FROM` is an arbitrary operator string, and it
    // used to be the whole difference between "claim" and "measurement". Corroboration is now the
    // provider read-backs, so a document with a beautiful label and no read-backs is UNVERIFIED —
    // and a document with read-backs that disagree is a FAIL.
    const noReadBacks = fullyMeasured();
    noReadBacks.topology.measuredFrom = "measured by me, honestly, on Tuesday";
    delete (noReadBacks as Record<string, unknown>).tokens;
    const unverified = evaluateActivation(noReadBacks).checks.find((c) => c.id === "topology-identity")!;
    expect(unverified.status).toBe("unverified");
    expect(unverified.detail).toMatch(/UNCORROBORATED/);
    expect(unverified.detail).toMatch(/operator label/);

    const disagrees = fullyMeasured();
    disagrees.tokens.staging.projectId = "project-somewhere-else";
    const failed = evaluateActivation(disagrees).checks.find((c) => c.id === "topology-identity")!;
    expect(failed.status).toBe("fail");

    // And a document with NO label still passes when the providers corroborate it — the label was
    // never the evidence in either direction.
    const unlabelled = fullyMeasured();
    unlabelled.topology.measuredFrom = null;
    expect(evaluateActivation(unlabelled).checks.find((c) => c.id === "topology-identity")).toMatchObject({ status: "pass" });
  });

  it("binds the health answer to the measured deployment, or reports it unverified", () => {
    const wrongOrigin = fullyMeasured();
    wrongOrigin.appHealth.origin = "https://unrelated.example.com";
    expect(evaluateActivation(wrongOrigin).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "fail" });

    const wrongCommit = fullyMeasured();
    wrongCommit.appHealth.body.commit = "d".repeat(40);
    expect(evaluateActivation(wrongCommit).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "fail" });

    const noCommit = fullyMeasured();
    delete (noCommit.appHealth.body as Record<string, unknown>).commit;
    expect(evaluateActivation(noCommit).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "unverified" });

    const mismatch = fullyMeasured() as Record<string, unknown>;
    mismatch.healthBinding = { bound: false, origin: null, kind: "contradiction", refusal: "the configured STAGING_ORIGIN is not the measured deployment domain" };
    const detail = evaluateActivation(mismatch).checks.find((c) => c.id === "app-health-bound")!;
    expect(detail.status).toBe("fail");
    expect(detail.detail).toMatch(/no health token was presented/);
  });

  it("will not call a building or failed deployment a serving identity", () => {
    const building = fullyMeasured();
    building.appDeployment.status = "BUILDING";
    expect(evaluateActivation(building).checks.find((c) => c.id === "app-deployment-measured")).toMatchObject({ status: "unverified" });

    const failed = fullyMeasured();
    failed.appDeployment.status = "FAILED";
    expect(evaluateActivation(failed).checks.find((c) => c.id === "app-deployment-measured")).toMatchObject({ status: "fail" });
  });

  it("requires BOTH runners, the right service and the pinned artifact", () => {
    const oneRunner = fullyMeasured();
    delete (oneRunner.runners as Record<string, unknown>).exporter;
    const image = evaluateActivation(oneRunner).checks.find((c) => c.id === "runner-image-pinned")!;
    expect(image.status, "one measured runner cannot satisfy a check about both").toBe("unverified");
    expect(image.detail).toMatch(/exporter/);
    expect(evaluateActivation(oneRunner).checks.find((c) => c.id === "runner-autodeploy-disabled")).toMatchObject({ status: "unverified" });

    const otherService = fullyMeasured();
    otherService.runners.importer.serviceId = "svc-something-else";
    expect(evaluateActivation(otherService).checks.find((c) => c.id === "runner-image-pinned")).toMatchObject({ status: "fail" });

    const otherArtifact = fullyMeasured();
    otherArtifact.runners.importer.image = "image.example/aios-staging-ops@sha256:" + "b".repeat(64);
    expect(evaluateActivation(otherArtifact).checks.find((c) => c.id === "runner-image-pinned")).toMatchObject({ status: "fail" });

    // An immutable digest with NOTHING pinned to compare it against is not the same as a verified
    // artifact, and says so.
    const unpinned = fullyMeasured();
    unpinned.runners.importer.expectedImage = null;
    expect(evaluateActivation(unpinned).checks.find((c) => c.id === "runner-image-pinned")).toMatchObject({ status: "unverified" });

    // A MISSING autodeploy reading is unverified; only a measured `true` is a failure.
    const unreported = fullyMeasured();
    unreported.runners.exporter.autoDeploy = null;
    expect(evaluateActivation(unreported).checks.find((c) => c.id === "runner-autodeploy-disabled")).toMatchObject({ status: "unverified" });
  });

  it("treats missing, forged and differently-keyed fingerprints as INCOMPARABLE, not as different", () => {
    // The defect this replaces: `fingerprintsEqual` returns false for a missing remote key, a
    // mismatched keyId, a wrong version and a malformed MAC alike — and "not equal" was read as
    // "the credentials differ", so an EMPTY opposite-environment document passed the separation
    // check outright.
    const cases: [string, (f: ReturnType<typeof fullyMeasured>) => void][] = [
      ["an empty opposite-environment document", (f) => { f.credentialFingerprints.remote = {}; }],
      ["a remote document missing one class", (f) => { delete (f.credentialFingerprints.remote as Record<string, unknown>)["secrets-key"]; }],
      ["a remote minted under another comparison key", (f) => { f.credentialFingerprints.remote = Object.fromEntries(REQUIRED_CREDENTIAL_CLASSES.map((c) => [c, fingerprint(c, mac("b"), { keyId: "some-other-key" })])); }],
      ["a malformed MAC", (f) => { f.credentialFingerprints.remote["auth-secret"] = fingerprint("auth-secret", "not-base64url-32-bytes!!"); }],
      ["a stale fingerprint version", (f) => { f.credentialFingerprints.remote["auth-secret"] = fingerprint("auth-secret", mac("b"), { version: "hmac-sha256-v0" }); }],
      ["a local class this runner never held", (f) => { delete (f.credentialFingerprints.local as Record<string, unknown>)["neo4j-credential"]; }],
    ];
    for (const [name, mutate] of cases) {
      const facts = fullyMeasured();
      mutate(facts);
      const result = evaluateActivation(facts);
      const check = result.checks.find((c) => c.id === "credential-separation")!;
      expect(check.status, name).toBe("unverified");
      expect(result.status, name).toBe(ACTIVATION_STATUS.UNVERIFIED);
    }
    // Positive control: a genuinely comparable pair still passes, so the refusals above are about
    // comparability and not about the fixture.
    expect(evaluateActivation(fullyMeasured()).checks.find((c) => c.id === "credential-separation")).toMatchObject({ status: "pass" });
  });

  it("defaults the unmeasurable sidecar check to unverified with a named reason", () => {
    const facts = fullyMeasured();
    delete (facts as Record<string, unknown>).graphitiProviderCredentials;
    const check = evaluateActivation(facts).checks.find((c) => c.id === "graphiti-no-provider-credentials");
    expect(check).toMatchObject({ status: "unverified" });
    expect(check!.detail).toContain("no variable read");
  });

  it.each([
    ["a token scoped to the wrong environment", (f: ReturnType<typeof fullyMeasured>) => { f.tokens.staging.environmentId = "env-production"; f.topology.document.staging.environmentId = "env-production"; }, "token-environment-scope"],
    ["one token seeing both environments", (f: ReturnType<typeof fullyMeasured>) => { f.tokens.production.environmentId = "env-staging"; f.topology.document.production.environmentId = "env-staging"; }, "token-environment-scope"],
    ["a runner on a mutable tag", (f: ReturnType<typeof fullyMeasured>) => { f.runners.importer.image = "image.example/aios-staging-ops:latest"; }, "runner-image-pinned"],
    ["a runner with a repository source", (f: ReturnType<typeof fullyMeasured>) => { f.runners.exporter.repo = "owner/repo"; }, "runner-image-pinned"],
    ["autodeploy left on", (f: ReturnType<typeof fullyMeasured>) => { f.runners.importer.autoDeploy = true; }, "runner-autodeploy-disabled"],
    ["a deployment in another environment", (f: ReturnType<typeof fullyMeasured>) => { f.appDeployment.environmentId = "env-production"; }, "app-deployment-measured"],
    ["a rejected health token", (f: ReturnType<typeof fullyMeasured>) => { f.appHealth = { status: 401, origin: "https://staging.example.com", body: {} }; }, "app-mode-declared"],
    ["no staging mode", (f: ReturnType<typeof fullyMeasured>) => { f.appHealth.body.mode = "production"; }, "app-mode-declared"],
    ["a shared credential", (f: ReturnType<typeof fullyMeasured>) => { f.credentialFingerprints.remote = f.credentialFingerprints.local; }, "credential-separation"],
    ["a sidecar holding provider keys", (f: ReturnType<typeof fullyMeasured>) => { f.graphitiProviderCredentials = ["OPENAI_API_KEY"]; }, "graphiti-no-provider-credentials"],
    ["schedules already enabled in the contract file", (f: ReturnType<typeof fullyMeasured>) => { f.schedules.activated = true; }, "schedules-disabled-in-contract-file"],
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

  it("scopes the answering evidence to answering, and claims no wider no-spend coverage", () => {
    const detail = evaluateActivation(fullyMeasured()).checks.find((c) => c.id === "app-no-model-spend")!.detail;
    expect(detail).toMatch(/answering posture only/);
    expect(detail).toMatch(/graph extraction/);
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

describe("assertActivationPreflightReady", () => {
  it("refuses UNVERIFIED as firmly as NOT ACTIVATED", () => {
    const unverified = evaluateActivation({});
    expect(unverified.status).toBe(ACTIVATION_STATUS.UNVERIFIED);
    expect(() => assertActivationPreflightReady(unverified)).toThrow(/staging activation preflight is UNVERIFIED/);
    const notActivated = fullyMeasured();
    notActivated.schedules.activated = true;
    expect(() => assertActivationPreflightReady(evaluateActivation(notActivated))).toThrow(/staging activation preflight is NOT ACTIVATED/);
    expect(assertActivationPreflightReady(evaluateActivation(fullyMeasured())).status).toBe(ACTIVATION_STATUS.READY);
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
    const fetchImpl = vi.fn();
    const facts = await readActivationFacts({} as NodeJS.ProcessEnv, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(facts.tokens).toEqual({ staging: null, production: null });
    expect(facts.notes.join(" ")).toContain("no read token supplied");
    expect(evaluateActivation(facts).status).toBe(ACTIVATION_STATUS.UNVERIFIED);
  });

  it("sends only listed read-only documents, with a PROJECT token header and never in a message", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
      seen.push(init.headers);
      return {
        ok: true,
        status: 200,
        json: async () => {
          const query = String(JSON.parse(init.body).query);
          assertReadOnlyDocument(query); // throws if anything unlisted is ever sent
          return { data: { projectToken: { projectId: "project-a", environmentId: "env-staging" } } };
        },
      };
    });
    const facts = await readActivationFacts(
      { RAILWAY_STAGING_READ_TOKEN: "staging-token-value" } as NodeJS.ProcessEnv,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(facts.tokens.staging).toEqual({ projectId: "project-a", environmentId: "env-staging" });
    // The contract is an environment-scoped project token, the same header `RailwayMaintenance`
    // uses. Sending `Authorization: Bearer` made a client mistake look like a platform finding.
    expect(seen[0]["Project-Access-Token"]).toBe("staging-token-value");
    expect(seen[0].Authorization).toBeUndefined();
    expect(JSON.stringify(facts.notes)).not.toContain("staging-token-value");
  });

  it("presents the health token ONLY to the measured deployment domain", async () => {
    // The accepted HIGH: the probe fired whenever `STAGING_ORIGIN` and a token both existed, with
    // no comparison to any measured domain, and the evaluator never compared them either. Three
    // cases, each asserting the REQUEST that was or was not made — not merely the verdict.
    const deploymentNode = {
      id: "dep-1", status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app",
      staticUrl: "staging.example.com", meta: { commitHash: COMMIT },
    };
    const build = (env: Record<string, string>) => {
      const health: string[] = [];
      const fetchImpl = vi.fn(async (url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
        const href = String(url);
        if (href.includes("/api/health")) {
          health.push(href);
          expect(init.headers?.["x-aios-staging-health-token"], "the token only ever goes to a bound origin").toBeTruthy();
          return { status: 200, url: href, json: async () => ({ ok: true, commit: COMMIT, mode: "copy-ready", answering: "disabled" }) };
        }
        const query = String(JSON.parse(String(init.body)).query);
        if (query.includes("ActivationProjectToken")) return { ok: true, status: 200, json: async () => ({ data: { projectToken: { projectId: "project-a", environmentId: "env-staging" } } }) };
        if (query.includes("ActivationDeployments")) return { ok: true, status: 200, json: async () => ({ data: { deployments: { edges: [{ node: deploymentNode }] } } }) };
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      });
      return { health, fetchImpl, env };
    };
    const topologyFile = new URL("./fixtures/activation-topology.json", import.meta.url).pathname;
    const baseEnv = {
      RAILWAY_STAGING_READ_TOKEN: "staging-token", STAGING_TOPOLOGY_FILE: topologyFile,
      STAGING_HEALTH_TOKEN: "health-token-value",
    };

    // (a) agreeing configured origin ⇒ probed exactly once, at the MEASURED domain.
    const agree = build({ ...baseEnv, STAGING_ORIGIN: "https://staging.example.com" });
    const agreed = await readActivationFacts(agree.env as NodeJS.ProcessEnv, { fetchImpl: agree.fetchImpl as unknown as typeof fetch });
    expect(agree.health).toEqual(["https://staging.example.com/api/health"]);
    expect(agreed.appHealth?.origin).toBe("https://staging.example.com");

    // (b) a configured origin naming ANOTHER host ⇒ ZERO health requests, and a failing bound check.
    const wrong = build({ ...baseEnv, STAGING_ORIGIN: "https://unrelated.example.com" });
    const refused = await readActivationFacts(wrong.env as NodeJS.ProcessEnv, { fetchImpl: wrong.fetchImpl as unknown as typeof fetch });
    expect(wrong.health, "no token may reach an unbound host").toEqual([]);
    expect(refused.appHealth).toBeNull();
    expect(evaluateActivation(refused).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "fail" });

    // (c) no measurable deployment domain ⇒ ZERO health requests, unverified rather than failed.
    const domainless = build({ ...baseEnv, STAGING_ORIGIN: "https://staging.example.com" });
    domainless.fetchImpl = vi.fn(async (url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
      const href = String(url);
      if (href.includes("/api/health")) { domainless.health.push(href); return { status: 200, url: href, json: async () => ({}) }; }
      const query = String(JSON.parse(String(init.body)).query);
      if (query.includes("ActivationProjectToken")) return { ok: true, status: 200, json: async () => ({ data: { projectToken: { projectId: "project-a", environmentId: "env-staging" } } }) };
      if (query.includes("ActivationDeployments")) return { ok: true, status: 200, json: async () => ({ data: { deployments: { edges: [{ node: { ...deploymentNode, staticUrl: null } }] } } }) };
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }) as unknown as typeof fetch;
    const unmeasured = await readActivationFacts(domainless.env as NodeJS.ProcessEnv, { fetchImpl: domainless.fetchImpl });
    expect(domainless.health).toEqual([]);
    expect(evaluateActivation(unmeasured).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "unverified" });
  });

  it("fingerprints no credential this runner does not hold", async () => {
    // `${undefined}\0${undefined}` is a perfectly good HMAC input, so the absent Neo4j credential
    // used to produce a fingerprint that differs from production's — "we hold nothing" reported as
    // "ours is distinct".
    // Generated at runtime under the SAME synthetic comparison key this env configures, rather
    // than read from a tracked JSON fixture whose `keyConfirmation` values are 43-character
    // maximal-entropy base64url and therefore trip gitleaks' `generic-api-key`. The comparability
    // assertion below is the whole point of the document, so a repeated-byte placeholder would not
    // do — see test/helpers/activation-remote-fingerprints.ts.
    const remote = writeSyntheticRemoteFingerprints({ keyId: COMPARISON_KEY_ID });
    try {
      const facts = await readActivationFacts({
        STAGING_COMPARISON_KEY_BASE64: SYNTHETIC_COMPARISON_KEY_BASE64,
        STAGING_COMPARISON_KEY_ID: COMPARISON_KEY_ID,
        OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE: remote.file,
        AUTH_SECRET: "local-auth-secret",
      } as NodeJS.ProcessEnv, { fetchImpl: vi.fn() as unknown as typeof fetch });
      expect(Object.keys(facts.credentialFingerprints!.local)).toEqual(["auth-secret"]);
      expect(facts.notes.join(" ")).toContain("holds no secrets-key");
      // The class this runner DOES hold is comparable against the document on disk — so the
      // unverified verdict below is about the two absent classes and not about a malformed
      // fixture. This is the POSITIVE CONTROL for the runtime generation: a document whose
      // confirmation did not match the configured key would make this false.
      expect(fingerprintsComparable(
        facts.credentialFingerprints!.local["auth-secret"],
        facts.credentialFingerprints!.remote["auth-secret"],
      )).toBe(true);
      // …and it is a REAL opposite-environment document: the values differ, so separation is not
      // being certified by two copies of the same secret.
      expect(fingerprintsEqual(
        facts.credentialFingerprints!.local["auth-secret"],
        facts.credentialFingerprints!.remote["auth-secret"],
      )).toBe(false);
      expect(evaluateActivation(facts).checks.find((c) => c.id === "credential-separation")).toMatchObject({ status: "unverified" });
    } finally { remote.cleanup(); }
  });
});

describe("the verifier has a caller", () => {
  it("is reachable as an importer action that refuses an unverified activation", async () => {
    const activationRunner = vi.fn(async () => {
      const result = evaluateActivation({});
      return { ...result, notes: [], report: formatActivationReport(result) };
    });
    await expect(runImporter({} as NodeJS.ProcessEnv, ["activation-preflight"], { activationRunner }))
      .rejects.toThrow(/staging activation preflight is UNVERIFIED/);
    expect(activationRunner).toHaveBeenCalledTimes(1);
  });

  it("returns the verdict when everything measures clean", async () => {
    const activationRunner = vi.fn(async () => {
      const result = evaluateActivation(fullyMeasured());
      return { ...result, notes: [], report: formatActivationReport(result) };
    });
    await expect(runImporter({} as NodeJS.ProcessEnv, ["activation-preflight"], { activationRunner }))
      .resolves.toMatchObject({ status: ACTIVATION_STATUS.READY });
  });
});
