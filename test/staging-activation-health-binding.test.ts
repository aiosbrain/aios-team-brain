import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  REQUIRED_CREDENTIAL_CLASSES,
  evaluateActivation,
  healthProbeBinding,
  readActivationFacts,
} from "../scripts/staging-ops/activation-preflight.mjs";
import { FINGERPRINT_VERSION, fingerprintsComparable } from "../scripts/staging-ops/credential-fingerprint.mjs";
import {
  SYNTHETIC_COMPARISON_KEY_BASE64, SYNTHETIC_COMPARISON_KEY_ID, writeSyntheticRemoteFingerprints,
} from "./helpers/activation-remote-fingerprints";

/**
 * The measured defect (`astra-activation-closure.md`, HEAD `0154a66e`): a provider-returned
 * hostname was enough to present the privileged staging health token. Independent mocked
 * acquisitions each sent ONE health-token request for a wrong-scope token, an absent scope, a wrong
 * service, a wrong environment, a `FAILED` deployment, a `BUILDING` deployment and a missing commit
 * — and several then reported `app-health-bound: pass`, because the answer that came back was read
 * as evidence about an identity nothing had established.
 *
 * Every case below asserts the REQUEST that was or was not made, not merely the verdict: "it
 * reported unverified" is satisfied by a run that sent the token and then disliked the answer, and
 * that is precisely the outcome this must exclude. `zero privileged requests` is the property.
 */

const COMMIT = "c".repeat(40);
const TOPOLOGY_FILE = new URL("./fixtures/activation-topology.json", import.meta.url).pathname;

const DEPLOYMENT = {
  id: "dep-1", status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app",
  staticUrl: "staging.example.com", meta: { commitHash: COMMIT },
};

const SCOPE = { projectId: "project-a", environmentId: "env-staging" };

/**
 * One acquisition, with every provider answer overridable and every health request recorded.
 * `health` is the observable the whole file is about.
 */
function acquisition({ node = DEPLOYMENT, scope = SCOPE as Record<string, string> | null, env = {} as Record<string, string> } = {}) {
  const health: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
    const href = String(url);
    if (href.includes("/api/health")) {
      health.push(href);
      return { status: 200, url: href, json: async () => ({ ok: true, commit: COMMIT, mode: "copy-ready", refreshRunId: "run-9", answering: "disabled" }) };
    }
    const query = String(JSON.parse(String(init.body)).query);
    if (query.includes("ActivationProjectToken")) return { ok: true, status: 200, json: async () => ({ data: { projectToken: scope } }) };
    if (query.includes("ActivationDeployments")) return { ok: true, status: 200, json: async () => ({ data: { deployments: { edges: node ? [{ node }] : [] } } }) };
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
  const run = () => readActivationFacts({
    RAILWAY_STAGING_READ_TOKEN: "staging-token",
    STAGING_TOPOLOGY_FILE: TOPOLOGY_FILE,
    STAGING_HEALTH_TOKEN: "health-token-value",
    ...env,
  } as NodeJS.ProcessEnv, { fetchImpl: fetchImpl as unknown as typeof fetch });
  return { health, run };
}

describe("no privileged health request without an established identity", () => {
  it("probes exactly once when the whole identity holds — the positive control", async () => {
    // Without this, every "zero requests" assertion below is satisfiable by a binding that refuses
    // unconditionally, and the check would be dead.
    const { health, run } = acquisition({ env: { STAGING_ORIGIN: "https://staging.example.com" } });
    const facts = await run();
    expect(health).toEqual(["https://staging.example.com/api/health"]);
    expect(facts.healthBinding).toMatchObject({ bound: true, origin: "https://staging.example.com" });
    expect(evaluateActivation(facts).checks.find((c) => c.id === "app-health-bound")).toMatchObject({ status: "pass" });
  });

  const refusals: [string, Parameters<typeof acquisition>[0], "fail" | "unverified"][] = [
    ["a read token scoped to another project", { scope: { projectId: "project-elsewhere", environmentId: "env-staging" } }, "fail"],
    ["a read token scoped to another environment", { scope: { projectId: "project-a", environmentId: "env-production" } }, "fail"],
    ["a read token whose scope was never measured", { scope: null }, "unverified"],
    ["a deployment of another service", { node: { ...DEPLOYMENT, serviceId: "service-graphiti" } }, "fail"],
    ["a deployment in another environment", { node: { ...DEPLOYMENT, environmentId: "env-production" } }, "fail"],
    ["a FAILED deployment", { node: { ...DEPLOYMENT, status: "FAILED" } }, "fail"],
    ["a BUILDING deployment", { node: { ...DEPLOYMENT, status: "BUILDING" } }, "fail"],
    ["a deployment with no commit identity", { node: { ...DEPLOYMENT, meta: {} } }, "unverified"],
    ["a deployment with a malformed commit identity", { node: { ...DEPLOYMENT, meta: { commitHash: "not-a-sha" } } }, "unverified"],
    ["no deployment at all", { node: null as unknown as typeof DEPLOYMENT }, "unverified"],
    ["a configured origin naming another host", { env: { STAGING_ORIGIN: "https://unrelated.example.com" } }, "fail"],
    ["a configured origin that is not https", { env: { STAGING_ORIGIN: "http://staging.example.com" } }, "fail"],
    ["a configured origin carrying credentials", { env: { STAGING_ORIGIN: "https://user:pw@staging.example.com" } }, "fail"],
    ["a configured origin that will not parse at all", { env: { STAGING_ORIGIN: "not an origin" } }, "fail"],
    ["no health token supplied", { env: { STAGING_HEALTH_TOKEN: "" } }, "unverified"],
  ];

  for (const [label, options, verdict] of refusals) {
    it(`sends ZERO health requests for ${label}, and never passes`, async () => {
      const { health, run } = acquisition(options);
      const facts = await run();
      expect(health, "the privileged token must not leave this process").toEqual([]);
      expect(facts.appHealth).toBeNull();
      expect(facts.healthBinding.bound).toBe(false);
      expect(facts.healthBinding.refusal).toBeTruthy();
      const bound = evaluateActivation(facts).checks.find((c) => c.id === "app-health-bound")!;
      expect(bound.status).toBe(verdict);
      // …and the downstream checks that read the health body cannot pass on an answer that was
      // never obtained.
      for (const id of ["app-mode-declared", "app-no-model-spend"]) {
        expect(evaluateActivation(facts).checks.find((c) => c.id === id)!.status, id).not.toBe("pass");
      }
    });
  }

  it("decides the binding without any I/O, so the refusal cannot depend on the answer", () => {
    const pin = { projectId: "project-a", environmentId: "env-staging", appServiceId: "service-app" };
    const deployment = { status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app", commitSha: COMMIT, url: "https://staging.example.com" };
    const env = { STAGING_HEALTH_TOKEN: "t" };
    expect(healthProbeBinding({ env, pin, tokenScope: SCOPE, deployment })).toEqual({
      bound: true, origin: "https://staging.example.com", refusal: null, kind: null,
    });
    // A measured disagreement is a CONTRADICTION (a failure); a missing prerequisite is an ABSENCE
    // (unverified). Conflating them either cries wolf or hides a real misconfiguration.
    expect(healthProbeBinding({ env, pin, tokenScope: { projectId: "other", environmentId: "env-staging" }, deployment }).kind).toBe("contradiction");
    expect(healthProbeBinding({ env, pin, tokenScope: null, deployment }).kind).toBe("absence");
    expect(healthProbeBinding({ env: {}, pin, tokenScope: SCOPE, deployment }).kind).toBe("absence");
    expect(healthProbeBinding({}).bound).toBe(false);
  });
});

describe("a bound answer still has to be a SERVING answer", () => {
  const served = (body: Record<string, unknown>) => ({
    topology: { document: JSON.parse(readFileSync(TOPOLOGY_FILE, "utf8")), measuredFrom: "read-back" },
    appDeployment: { id: "dep-1", status: "SUCCESS", environmentId: "env-staging", serviceId: "service-app", url: "https://staging.example.com", commitSha: COMMIT },
    healthBinding: { bound: true, origin: "https://staging.example.com", refusal: null, kind: null },
    appHealth: { status: 200, origin: "https://staging.example.com", body },
  });
  const checkFor = (body: Record<string, unknown>, id: string) =>
    evaluateActivation(served(body)).checks.find((c) => c.id === id)!;

  it("refuses ok:false even when the commit and the origin match perfectly", () => {
    // The exact diagnostic response the adjudicator reproduced: correctly bound, correct commit,
    // `copy-ready` — and `ok:false` with no refresh run. It passed both checks.
    const body = { ok: false, commit: COMMIT, mode: "copy-ready", answering: "disabled" };
    expect(checkFor(body, "app-health-bound").status).toBe("fail");
    expect(checkFor(body, "app-mode-declared").status).toBe("fail");
  });

  it("refuses a copy-ready claim with no refresh run behind it", () => {
    const body = { ok: true, commit: COMMIT, mode: "copy-ready", answering: "disabled" };
    const mode = checkFor(body, "app-mode-declared");
    expect(mode.status).toBe("fail");
    expect(mode.detail).toMatch(/no refresh run/);
    // The positive control: the same answer WITH a run passes, so the refusal is about the run and
    // not about the mode being rejected outright.
    expect(checkFor({ ...body, refreshRunId: "run-9" }, "app-mode-declared").status).toBe("pass");
  });

  it("still accepts legacy-pg-only, which has no refresh run by contract", () => {
    const body = { ok: true, commit: COMMIT, mode: "legacy-pg-only", answering: "disabled" };
    expect(checkFor(body, "app-mode-declared").status).toBe("pass");
  });

  /**
   * The measured table from `activation-revision3-closure.md`. The previous round fixed the
   * FAILURES it named and left the ACCOMPANYING PASSES — three checks reading the same body and
   * each deciding separately, so an operator saw "this answer is not about your deployment" on one
   * line and "your deployment declares copy-ready with answering disabled" on the next two.
   *
   * Asserted as: no dependent verdict may pass for any of these responses.
   */
  const DEPENDENT = ["app-health-bound", "app-mode-declared", "app-no-model-spend"];
  const MISLEADING: [string, Record<string, unknown>][] = [
    ["a wrong commit", { ok: true, commit: "d".repeat(40), mode: "copy-ready", refreshRunId: "run-9", answering: "disabled" }],
    ["ok:false with no run", { ok: false, commit: COMMIT, mode: "copy-ready", answering: "disabled" }],
    ["ok:true, copy-ready, no run", { ok: true, commit: COMMIT, mode: "copy-ready", answering: "disabled" }],
    ["an unsupported mode", { ok: true, commit: COMMIT, mode: "whatever", refreshRunId: "run-9", answering: "disabled" }],
    ["no commit at all", { ok: true, mode: "copy-ready", refreshRunId: "run-9", answering: "disabled" }],
  ];

  for (const [label, body] of MISLEADING) {
    it(`reports NO passing verdict for ${label}`, () => {
      for (const id of DEPENDENT) {
        expect(checkFor(body, id).status, `${id} passed on ${label}`).not.toBe("pass");
      }
      // Every dependent verdict gives the SAME reason, so the report cannot contradict itself.
      const reasons = new Set(DEPENDENT.map((id) => checkFor(body, id).detail.replace(/^not measured: /, "")));
      expect(reasons.size, "the three verdicts disagreed about why").toBe(1);
    });
  }

  it("passes all three for a fully serving answer — the positive control", () => {
    // Otherwise the block above is satisfied by a build that never passes anything.
    const body = { ok: true, commit: COMMIT, mode: "copy-ready", refreshRunId: "run-9", answering: "disabled" };
    for (const id of DEPENDENT) expect(checkFor(body, id).status, id).toBe("pass");
  });

  it("carries the binding refusal into the dependent verdicts, without presenting a token", () => {
    // A refusal that happened BEFORE any request must still explain the mode and answering lines.
    const facts = {
      topology: { document: JSON.parse(readFileSync(TOPOLOGY_FILE, "utf8")), measuredFrom: "read-back" },
      healthBinding: { bound: false, origin: null, kind: "contradiction", refusal: "the measured deployment is FAILED, not SUCCESS, so nothing is serving this identity" },
      appHealth: null,
    };
    for (const id of DEPENDENT) {
      const verdict = evaluateActivation(facts).checks.find((c) => c.id === id)!;
      expect(verdict.status, id).toBe("fail");
      expect(verdict.detail, id).toMatch(/no health token was presented/);
    }
  });
});

/**
 * The second accepted correction. The evaluator correctly rejects missing, malformed and
 * incomparable entries — but a complete set of LOCAL process credentials plus an ordinary
 * opposite-environment JSON file still reported `credential-separation: pass`. Neither the local
 * runner's deployed identity nor the remote document's provenance was ever established, so what
 * passed was "this file says they differ", reported as "they differ".
 *
 * "They are identical" is worth acting on from any source — no forgery volunteers that. "They
 * differ" is exactly what a forged, stale or simply wrong file also says, so it may only be read as
 * LIVE separation when the document carries authenticated, environment-bound provenance.
 */
describe("live credential separation is not established by a local document", () => {
  const fingerprintSet = (fill: string) => Object.fromEntries(REQUIRED_CREDENTIAL_CLASSES.map((credentialClass: string) => [
    credentialClass,
    { version: FINGERPRINT_VERSION, keyId: "example-key", keyConfirmation: Buffer.alloc(32, "k").toString("base64url"), credentialClass, mac: Buffer.alloc(32, fill).toString("base64url") },
  ]));
  const topology = () => ({ document: JSON.parse(readFileSync(TOPOLOGY_FILE, "utf8")), measuredFrom: "read-back" });
  /**
   * H1: the signed production measurement's SUBJECTS are now a condition of this check too, so the
   * helper supplies a bound one by default. Environment-bound provenance says which environment a
   * fingerprint came from; it does not say which SERVICES in it, and a correctly scoped, correctly
   * signed fingerprint from a DIFFERENT production app was certifying separation for the app this
   * consumer actually pinned. The `subjects` override is how the cases below vary that one term.
   */
  const BOUND_SUBJECTS = { bound: true, mismatches: [], unmeasured: [] };
  const separation = (credentialFingerprints: Record<string, unknown>, productionSubjects: unknown = BOUND_SUBJECTS) =>
    evaluateActivation({ topology: topology(), credentialFingerprints, productionSubjects }).checks.find((c) => c.id === "credential-separation")!;

  it("reports UNVERIFIED for an unauthenticated document, however complete it is", () => {
    const verdict = separation({ local: fingerprintSet("a"), remote: fingerprintSet("b") });
    expect(verdict.status).toBe("unverified");
    expect(verdict.detail).toMatch(/local diagnostic/);
    expect(verdict.detail).toMatch(/no authenticated, environment-bound provenance/);
  });

  const LOCAL = { authenticated: true, environmentId: "env-staging" };
  const REMOTE = { authenticated: true, environmentId: "env-production" };

  it("reports UNVERIFIED when provenance is unauthenticated or names the wrong environment", () => {
    // Provenance that is not BOUND to its own environment is provenance for something else.
    for (const [localProvenance, remoteProvenance] of [
      [LOCAL, { authenticated: true, environmentId: "env-staging" }],
      [LOCAL, { authenticated: false, environmentId: "env-production" }],
      [LOCAL, { environmentId: "env-production" }],
      [{ authenticated: true, environmentId: "env-production" }, REMOTE],
      [{ authenticated: false, environmentId: "env-staging" }, REMOTE],
    ]) {
      expect(separation({ local: fingerprintSet("a"), remote: fingerprintSet("b"), localProvenance, remoteProvenance }).status,
        JSON.stringify({ localProvenance, remoteProvenance })).toBe("unverified");
    }
  });

  it("refuses REMOTE-ONLY provenance: the local half is still an unauthenticated env read", () => {
    // The reproduced case. Authenticated provenance for the remote FILE says where that file came
    // from; the local fingerprints are this process reading `AUTH_SECRET` out of its own
    // environment, which is an assertion about a runner, not evidence about deployed staging.
    const verdict = separation({ local: fingerprintSet("a"), remote: fingerprintSet("b"), remoteProvenance: REMOTE });
    expect(verdict.status).toBe("unverified");
    expect(verdict.detail).toMatch(/the local deployed credentials carry no authenticated, environment-bound provenance/);
    // …and the mirror image, so the rule is symmetric rather than a patch aimed at one side.
    expect(separation({ local: fingerprintSet("a"), remote: fingerprintSet("b"), localProvenance: LOCAL }).detail)
      .toMatch(/the opposite-environment document carry no authenticated/);
  });

  it("passes ONLY on authenticated, environment-bound provenance for BOTH sides — the positive control", () => {
    // Without this the check could be refusing unconditionally, which proves nothing about the
    // condition it claims to test.
    const verdict = separation({
      local: fingerprintSet("a"), remote: fingerprintSet("b"),
      localProvenance: LOCAL, remoteProvenance: REMOTE,
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.detail).toMatch(/bound to env-staging locally and env-production remotely/);
  });

  it("refuses when the signed production measurement is about OTHER production services", () => {
    // One term changed from the passing control above: provenance is still authenticated and bound
    // to the right environments, and the fingerprints still differ. What is missing is that the
    // remote measurement is about the production app/Postgres/Neo4j this consumer pinned — so
    // "these credentials are separate" would be a claim about services nobody asked about.
    const both = { local: fingerprintSet("a"), remote: fingerprintSet("b"), localProvenance: LOCAL, remoteProvenance: REMOTE };
    const mismatched = separation(both, { bound: false, mismatches: ["the measurement describes a different application service than the one pinned here"], unmeasured: [] });
    expect(mismatched.status).toBe("unverified");
    expect(mismatched.detail).toMatch(/subject identities/);

    // …and an ABSENT binding is refused the same way: this path did not run, so nothing established
    // it. `null`, not `undefined` — the helper's default argument would otherwise supply a bound
    // one and this case would silently assert the passing control a second time.
    expect(separation(both, null).status).toBe("unverified");
  });

  it("still FAILS on a shared credential, whatever the provenance", () => {
    // The asymmetry, stated: an unauthenticated document claiming identity is still worth acting on.
    expect(separation({ local: fingerprintSet("a"), remote: fingerprintSet("a") }).status).toBe("fail");
  });

  it("gives the real acquisition no way to produce that provenance", async () => {
    // Why the real command cannot certify live separation: the field is null BY CONSTRUCTION, not
    // merely unset in a fixture.
    // The opposite-environment document is built at runtime from the same synthetic comparison key
    // configured below, so all three classes stay COMPARABLE — which is what makes the unverified
    // verdict below about missing provenance rather than about an unusable document. See
    // test/helpers/activation-remote-fingerprints.ts for why it is no longer a tracked JSON file.
    const remote = writeSyntheticRemoteFingerprints({ keyId: SYNTHETIC_COMPARISON_KEY_ID });
    try {
      const measured = await readActivationFacts({
        STAGING_COMPARISON_KEY_BASE64: SYNTHETIC_COMPARISON_KEY_BASE64,
        STAGING_COMPARISON_KEY_ID: SYNTHETIC_COMPARISON_KEY_ID,
        OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE: remote.file,
        AUTH_SECRET: "local-auth-secret", SECRETS_KEY: "local-secrets-key",
        NEO4J_USER: "neo4j", NEO4J_PASSWORD: "local-neo4j-password",
      } as NodeJS.ProcessEnv, { fetchImpl: vi.fn() as unknown as typeof fetch });
      expect(measured.credentialFingerprints).not.toBeNull();
      // POSITIVE CONTROL for the generated document: every required class is comparable, so the
      // unverified verdict cannot be coming from an incomparable-fingerprint path.
      for (const credentialClass of REQUIRED_CREDENTIAL_CLASSES) {
        expect(fingerprintsComparable(
          measured.credentialFingerprints.local[credentialClass],
          measured.credentialFingerprints.remote[credentialClass],
        ), credentialClass).toBe(true);
      }
      expect(measured.credentialFingerprints.remoteProvenance).toBeNull();
      expect(measured.credentialFingerprints.localProvenance).toBeNull();
      expect(evaluateActivation({ ...measured, topology: topology() }).checks
        .find((c) => c.id === "credential-separation")!.status).toBe("unverified");
    } finally { remote.cleanup(); }
  });
});
