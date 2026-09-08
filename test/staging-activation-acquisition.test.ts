import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runExporter } from "../scripts/staging-ops/exporter.mjs";
import { runActivationPreflight } from "../scripts/staging-ops/activation-preflight.mjs";
import { runImporter } from "../scripts/staging-ops/importer.mjs";
import { createActivationEvidenceEnvelope } from "../scripts/staging-ops/activation-evidence.mjs";

const TOPOLOGY_FILE = new URL("./fixtures/activation-topology.json", import.meta.url).pathname;
const SCHEDULES_FILE = new URL("../config/staging-ops/schedules.json", import.meta.url).pathname;
const signing = generateKeyPairSync("ed25519");
const comparisonKey = Buffer.alloc(32, 19);
const image = `registry.example/ops@sha256:${"a".repeat(64)}`;
const commit = "c".repeat(40);
const canary = "canary-provider-secret-never-leaves-collector";

function memoryTransport() {
  const objects = new Map<string, Buffer>();
  return {
    publisher: { putImmutable: vi.fn(async (id: string, bytes: Buffer) => { objects.set(id, Buffer.from(bytes)); }) },
    reader: { read: vi.fn(async (id: string) => Buffer.from(objects.get(id)!)) },
    objects,
  };
}

function exporterEnv() {
  return {
    STAGING_OPS_ROLE: "exporter", STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    RAILWAY_ENVIRONMENT_ID: "env-production", PRODUCTION_EXPORT_ENVIRONMENT_ID: "env-production",
    DATABASE_URL: "postgres://reader@postgres.railway.internal/brain", NEO4J_URL: "bolt://neo4j.railway.internal:7687",
    STAGING_TOPOLOGY_FILE: TOPOLOGY_FILE, GITHUB_REPOSITORY: "org/repo",
    PRODUCTION_APP_DEPLOYMENT_ID: "prod-app-dep", PRODUCTION_EXPORTER_SERVICE_ID: "svc-exporter",
    PRODUCTION_POSTGRES_DEPLOYMENT_ID: "production-postgres-dep", PRODUCTION_NEO4J_DEPLOYMENT_ID: "production-neo4j-dep",
    PRODUCTION_EXPORTER_DEPLOYMENT_ID: "prod-exporter-dep", PRODUCTION_EXPORTER_IMAGE_DIGEST: image,
    RAILWAY_PRODUCTION_ACTIVATION_READ_TOKEN: "production-token", STAGING_COMPARISON_KEY_BASE64: comparisonKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "ops-v2",
    EXPORTER_SIGNING_PRIVATE_KEY: signing.privateKey,
  } as unknown as NodeJS.ProcessEnv;
}

function importerEnv(objectId: string, overrides: Record<string, unknown> = {}) {
  return {
    STAGING_TOPOLOGY_FILE: TOPOLOGY_FILE, STAGING_SCHEDULES_FILE: SCHEDULES_FILE,
    RAILWAY_PROJECT_ID: "project-a", STAGING_OPS_ENVIRONMENT_ID: "env-staging",
    PRODUCTION_PROJECT_ID: "project-a", PRODUCTION_ENVIRONMENT_ID: "env-production",
    STAGING_APP_DEPLOYMENT_ID: "staging-app-dep", STAGING_GRAPHITI_DEPLOYMENT_ID: "staging-graphiti-dep",
    STAGING_POSTGRES_DEPLOYMENT_ID: "staging-postgres-dep", STAGING_NEO4J_DEPLOYMENT_ID: "staging-neo4j-dep",
    STAGING_IMPORTER_SERVICE_ID: "svc-importer", STAGING_IMPORTER_DEPLOYMENT_ID: "staging-importer-dep", STAGING_IMPORTER_IMAGE_DIGEST: image,
    PRODUCTION_EXPORTER_SERVICE_ID: "svc-exporter", PRODUCTION_EXPORTER_IMAGE_DIGEST: image,
    RAILWAY_STAGING_READ_TOKEN: "staging-token", STAGING_GITHUB_READ_TOKEN: "github-token", GITHUB_REPOSITORY: "org/repo",
    STAGING_COMPARISON_KEY_BASE64: comparisonKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "ops-v2",
    STAGING_HEALTH_TOKEN: "health-token", STAGING_ORIGIN: "https://staging.example.com",
    ACTIVATION_EVIDENCE_OBJECT_ID: objectId, EXPORTER_SIGNING_PUBLIC_KEY: signing.publicKey,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

/** The digest the pinned immutable reference `image` names, and what a correct runner must report. */
const imageDigest = `sha256:${"a".repeat(64)}`;

type FixtureOptions = {
  productionSecrets?: string; stagingSecrets?: string; productionBranch?: string;
  stagingReference?: string; graphitiKey?: string; sealedProduction?: boolean; snapshotUnbound?: boolean;
  providerError?: boolean; currentDrift?: boolean; runnerAutoDeploy?: boolean; runnerImage?: string;
  /**
   * What the pinned active RUNNER deployment reports it is running. `undefined` keeps the correct
   * digest; `null` models metadata that carries no image identity at all. Independent of
   * `runnerImage`, which is service CONFIGURATION — separating the two is the whole point of the
   * measurement, so the fixture has to be able to disagree with itself.
   */
  runnerDeploymentDigest?: string | null;
};

function providerFixture(options: FixtureOptions = {}) {
  const requests: { token: string | null; query: string; url: string; body: string }[] = [];
  const secrets = (side: "production" | "staging") => {
    const prefix = side === "production" ? (options.productionSecrets ?? "prod") : (options.stagingSecrets ?? "staging");
    return {
      AUTH_SECRET: options.sealedProduction && side === "production" ? null : `${prefix}-auth`, SECRETS_KEY: `${prefix}-secrets`,
      NEO4J_USER: "neo4j", NEO4J_PASSWORD: `${prefix}-neo4j`,
      DATABASE_URL: "postgres://app:password@postgres.railway.internal/brain",
      NEO4J_URL: "bolt://neo4j.railway.internal:7687", NEO4J_DATABASE: "neo4j", EXTRA_PROVIDER_SECRET: canary,
    };
  };
  const fetchImpl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input); const token = (init.headers as Record<string, string> | undefined)?.["Project-Access-Token"] ?? null;
    const bodyText = String(init.body ?? ""); requests.push({ token, query: bodyText, url, body: bodyText });
    if (url.startsWith("https://api.github.com/")) return Response.json({ full_name: "org/repo", default_branch: "staging" });
    if (url.endsWith("/api/health")) return Response.json({ ok: true, commit, mode: "copy-ready", refreshRunId: "run-9", answering: "disabled" });
    const { query, variables } = JSON.parse(bodyText); const side = token === "production-token" ? "production" : "staging";
    if (options.providerError && side === "production" && query.includes("ActivationServiceVariables")) return Response.json({ errors: [{ message: canary }] });
    if (query.includes("ActivationProjectToken")) return Response.json({ data: { projectToken: { projectId: "project-a", environmentId: side === "production" ? "env-production" : "env-staging" } } });
    if (query.includes("ActivationServiceConfiguration")) {
      const serviceId = variables.serviceId; const envId = side === "production" ? "env-production" : "env-staging";
      const role = serviceId === "service-app" ? "app" : serviceId === "svc-exporter" ? "exporter" : serviceId === "svc-importer" ? "importer" : serviceId === "service-graphiti" ? "graphiti" : serviceId === "service-postgres" ? "postgres" : "neo4j";
      const deploymentId = role === "app" ? `${side === "production" ? "prod" : "staging"}-app-dep`
        : role === "exporter" ? "prod-exporter-dep" : role === "importer" ? "staging-importer-dep" : role === "graphiti" ? "staging-graphiti-dep" : `${side}-${role}-dep`;
      const trigger = role === "app" ? [{ node: { id: `${side}-trigger`, projectId: "project-a", environmentId: envId, serviceId, branch: side === "production" ? (options.productionBranch ?? "main") : "staging", repository: "org/repo", provider: "github" } }] : [];
      const isRunner = role === "exporter" || role === "importer";
      // Railway's real deployment metadata for a registry-image deployment carries `imageDigest`
      // (observed live, and registry-correlated). Only a RUNNER has one here; the app is repo-built.
      const deploymentMeta: Record<string, unknown> = { commitHash: role === "app" ? commit : null };
      if (isRunner && options.runnerDeploymentDigest !== null) deploymentMeta.imageDigest = options.runnerDeploymentDigest ?? imageDigest;
      return Response.json({ data: {
        serviceInstance: { id: `${envId}:${serviceId}`, environmentId: envId, serviceId, serviceName: role === "postgres" ? "Postgres" : role === "neo4j" ? "neo4j" : role,
          updatedAt: "2026-09-08T00:00:00Z", source: role === "exporter" || role === "importer" ? { image: options.runnerImage ?? image, repo: null } : { image: null, repo: role === "app" ? "org/repo" : null },
          activeDeployments: [{ id: deploymentId, projectId: "project-a", environmentId: envId, serviceId, status: "SUCCESS", snapshotId: `${deploymentId}-snapshot`, meta: deploymentMeta }],
          service: { repoTriggers: { edges: trigger, pageInfo: { hasNextPage: false, endCursor: null } } } },
        serviceInstanceAutoDeployStatus: { enabled: (role === "exporter" || role === "importer") && options.runnerAutoDeploy ? true : false },
      } });
    }
    if (query.includes("ActivationServiceVariables")) {
      if (variables.serviceId === "service-graphiti") {
        const map = options.graphitiKey ? { [options.graphitiKey]: null } : {};
        return Response.json({ data: { unrendered: map, rendered: map } });
      }
      const rendered = secrets(side); if (options.currentDrift) rendered.AUTH_SECRET = `${rendered.AUTH_SECRET}-drift`;
      return Response.json({ data: { rendered, unrendered: {
        ...secrets(side), DATABASE_URL: options.stagingReference && side === "staging" ? options.stagingReference : "${{Postgres.DATABASE_URL}}",
        NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687",
      } } });
    }
    if (query.includes("ActivationDeploymentSnapshot")) {
      const graphiti = String(variables.deploymentId).includes("graphiti");
      const deploymentSide = String(variables.deploymentId).startsWith("prod") ? "production" : "staging";
      return Response.json({ data: { deploymentSnapshot: { id: options.snapshotUnbound ? "wrong-snapshot" : `${variables.deploymentId}-snapshot`, variables: graphiti ? (options.graphitiKey ? { [options.graphitiKey]: null } : {}) : secrets(deploymentSide) } } });
    }
    if (query.includes("ActivationPrivateNetworks")) return Response.json({ data: { privateNetworks: [{ publicId: `${side}-network`, projectId: "project-a", environmentId: side === "production" ? "env-production" : "env-staging", dnsName: "private", deletedAt: null }] } });
    if (query.includes("ActivationPrivateEndpoint")) return Response.json({ data: { privateNetworkEndpoint: { serviceInstanceId: `${side === "production" ? "env-production" : "env-staging"}:${variables.serviceId}`, dnsName: variables.serviceId === "service-postgres" ? "postgres.railway.internal" : "neo4j.railway.internal", newDnsName: null, deletedAt: null, syncStatus: "SUCCESS" } } });
    if (query.includes("ActivationDeployments")) return Response.json({ data: { deployments: { edges: [{ node: { id: "staging-app-dep", status: "SUCCESS", staticUrl: "staging.example.com", environmentId: "env-staging", serviceId: "service-app", meta: { commitHash: commit } } }] } } });
    throw new Error(`unhandled fixture query ${query}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

async function publish(options: FixtureOptions = {}) {
  const transport = memoryTransport(); const fixture = providerFixture(options);
  const result = await runExporter(exporterEnv(), { fetchImpl: fixture.fetchImpl, store: transport.publisher }, ["activation-evidence"]);
  return { transport, fixture, result };
}

describe("H5 role-isolated activation evidence acquisition", () => {
  it("reaches READY through the real exporter action and importer preflight without production access", async () => {
    const { transport, fixture, result } = await publish();
    const beforeImporter = fixture.requests.length;
    const entrypoint = await runImporter(importerEnv(result.objectId), ["activation-preflight"], { activationOptions: { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader } });
    const activation = await runActivationPreflight(importerEnv(result.objectId), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader });
    expect(entrypoint.status).toBe("READY TO ACTIVATE");
    expect(activation.status).toBe("READY TO ACTIVATE");
    expect(activation.checks.every((check) => check.status === "pass")).toBe(true);
    const importerRequests = fixture.requests.slice(beforeImporter);
    expect(importerRequests.filter((request) => request.token && request.token !== "staging-token")).toEqual([]);
    expect(JSON.stringify([...transport.objects.values()].map((bytes) => bytes.toString("utf8")))).not.toContain(canary);
    expect(JSON.stringify(activation)).not.toContain(canary);
    expect(JSON.stringify(fixture.requests)).not.toContain(canary);
    expect(Object.keys(process.env)).not.toContain("EXTRA_PROVIDER_SECRET");
    expect(fixture.requests.some((request) => /openai|anthropic|chat\/completions/i.test(request.url))).toBe(false);
  });

  it.each([
    ["sealed production required value", { sealedProduction: true }, /missing, sealed/],
    ["wrong production source branch", { productionBranch: "staging" }, /repository trigger/],
    ["wrong staging reference target", { stagingReference: "${{Other.DATABASE_URL}}" }, /wrong pinned service/],
    ["unbound deployment snapshot", { snapshotUnbound: true }, /snapshot is missing or unbound/],
    ["current configuration drift", { currentDrift: true }, /differs from the pinned deployment snapshot/],
    ["runner autodeploy", { runnerAutoDeploy: true }, /automatic deployments/],
    ["runner image mismatch", { runnerImage: `registry.example/other@sha256:${"b".repeat(64)}` }, /pinned immutable artifact/],
    ["provider key present with sealed-null semantics", { graphitiKey: "OPENAI_API_KEY" }, /NOT ACTIVATED/],
  ] as const)("refuses %s", async (_label, options, message) => {
    if ("graphitiKey" in options) {
      const { transport, result } = await publish(options);
      const activation = await runActivationPreflight(importerEnv(result.objectId), { fetchImpl: providerFixture(options).fetchImpl, evidenceStore: transport.reader });
      expect(activation.status).toBe("NOT ACTIVATED"); expect(activation.report).toMatch(message);
    } else if ("stagingReference" in options) {
      const { transport, result } = await publish();
      await expect(runActivationPreflight(importerEnv(result.objectId), { fetchImpl: providerFixture(options).fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(message);
    } else await expect(publish(options)).rejects.toThrow(message);
  });

  it("refuses equal deployed credentials and same-ID comparison-key material skew", async () => {
    const equal = await publish({ productionSecrets: "same" });
    const equalResult = await runActivationPreflight(importerEnv(equal.result.objectId), { fetchImpl: providerFixture({ stagingSecrets: "same" }).fetchImpl, evidenceStore: equal.transport.reader });
    expect(equalResult.status).toBe("NOT ACTIVATED");

    const skew = await publish();
    const skewResult = await runActivationPreflight(importerEnv(skew.result.objectId, { STAGING_COMPARISON_KEY_BASE64: Buffer.alloc(32, 20).toString("base64") }), { fetchImpl: providerFixture().fetchImpl, evidenceStore: skew.transport.reader });
    expect(skewResult.status).toBe("UNVERIFIED");
    expect(skewResult.report).toMatch(/comparison key/);
  });

  it("redacts provider errors and refuses tampered immutable evidence", async () => {
    await expect(publish({ providerError: true })).rejects.toThrow(/provider read failed/);
    await expect(publish({ providerError: true })).rejects.not.toThrow(new RegExp(canary));
    const { transport, fixture, result } = await publish();
    const bytes = transport.objects.get(result.objectId)!; const changed = Buffer.from(bytes); changed[changed.length - 4] ^= 1;
    transport.objects.set(result.objectId, changed);
    await expect(runActivationPreflight(importerEnv(result.objectId), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(/immutable object identity|valid JSON/);
  });

  it("refuses wrong signer, purpose, audience, missing proof and stale signed evidence", async () => {
    const { transport, fixture, result } = await publish();
    const original = JSON.parse(transport.objects.get(result.objectId)!.toString("utf8"));
    const put = (envelope: unknown) => {
      const bytes = Buffer.from(JSON.stringify(envelope)); const digest = createHash("sha256").update(bytes).digest("hex");
      const id = `activation-test--${digest}`; transport.objects.set(id, bytes); return id;
    };

    const wrongSigner = generateKeyPairSync("ed25519");
    const wronglySigned = createActivationEvidenceEnvelope({ production: original.evidence.production, audience: original.evidence.audience, privateKey: wrongSigner.privateKey });
    await expect(runActivationPreflight(importerEnv(put(wronglySigned)), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(/signature/);

    const wrongAudience = createActivationEvidenceEnvelope({ production: original.evidence.production, audience: { projectId: "project-a", environmentId: "elsewhere" }, privateKey: signing.privateKey });
    await expect(runActivationPreflight(importerEnv(put(wrongAudience)), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(/audience/);

    const wrongPurpose = structuredClone(original); wrongPurpose.evidence.purpose = "data-bundle";
    await expect(runActivationPreflight(importerEnv(put(wrongPurpose)), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(/purpose/);

    const missing = structuredClone(original); delete missing.evidence.production.credentialFingerprints["auth-secret"];
    await expect(runActivationPreflight(importerEnv(put(missing)), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader })).rejects.toThrow(/credential fingerprints/);

    await expect(runActivationPreflight(importerEnv(result.objectId), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader, now: Date.parse(original.evidence.expiresAt) + 1 })).rejects.toThrow(/stale/);
  });
});

/**
 * H1. A signature proves WHO supplied an observation; it does not prove the observation is ABOUT
 * the subject this consumer expects. The exporter validates its OWN topology document; the importer
 * holds an independent one. Nothing compared the two, so ordinary configuration drift — a replaced
 * service, a corrected pin — produced `READY TO ACTIVATE` and `topology-identity: pass` from
 * measurements of DIFFERENT production services, while also certifying their credential separation.
 *
 * These cases reproduce that exactly: the real exporter publishes ONCE, its evidence bytes are held
 * completely unchanged, and only one consumer production pin moves per case. No forged signature,
 * altered envelope, schema bypass or cross-role token is involved — nor needed.
 */
describe("H1 signed production evidence is bound to the consumer's own production pins", () => {
  const baseTopology = JSON.parse(readFileSync(TOPOLOGY_FILE, "utf8"));

  /** A consumer topology with exactly one production pin changed, written to its own temp file. */
  function consumerTopology(change: Record<string, string> = {}) {
    const document = { ...baseTopology, production: { ...baseTopology.production, ...change } };
    const directory = mkdtempSync(path.join(tmpdir(), "aios-activation-topology-"));
    const file = path.join(directory, "topology.json");
    writeFileSync(file, JSON.stringify(document), "utf8");
    return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  }

  it("still reaches READY when nothing moved — the positive control this comparison is measured against", async () => {
    const { transport, fixture, result } = await publish();
    const topology = consumerTopology();
    try {
      const activation = await runActivationPreflight(importerEnv(result.objectId, { STAGING_TOPOLOGY_FILE: topology.file }),
        { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader });
      expect(activation.status).toBe("READY TO ACTIVATE");
      expect(activation.checks.find((c) => c.id === "production-subject-identity")!.status).toBe("pass");
    } finally { topology.cleanup(); }
  });

  it.each([
    ["appServiceId", { appServiceId: "some-other-production-app" }],
    ["postgresServiceId", { postgresServiceId: "some-other-production-postgres" }],
    ["neo4jServiceId", { neo4jServiceId: "some-other-production-neo4j" }],
  ] as const)("refuses before READY when the consumer's production %s is not what the evidence measured", async (_pin, change) => {
    const { transport, fixture, result } = await publish();
    const originalBytes = Buffer.from(transport.objects.get(result.objectId)!);
    const topology = consumerTopology(change);
    const beforeImporter = fixture.requests.length;
    try {
      // Through the REAL importer entrypoint, not only the pure evaluator: `runImporter`'s
      // activation action is where the READY verdict was actually reached.
      await expect(runImporter(importerEnv(result.objectId, { STAGING_TOPOLOGY_FILE: topology.file }), ["activation-preflight"],
        { activationOptions: { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader } }))
        .rejects.toThrow(/staging activation preflight is NOT ACTIVATED/);
      // Role isolation is preserved by the refusal: the importer reached this verdict without ever
      // presenting a production provider credential.
      expect(fixture.requests.slice(beforeImporter).filter((request) => request.token && request.token !== "staging-token")).toEqual([]);

      const activation = await runActivationPreflight(importerEnv(result.objectId, { STAGING_TOPOLOGY_FILE: topology.file }),
        { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader });
      expect(activation.status).not.toBe("READY TO ACTIVATE");
      expect(activation.checks.find((c) => c.id === "production-subject-identity")!.status).toBe("fail");
      // …and separation must NOT still be described as established for the pinned subjects. This is
      // the second half of the defect: a correctly scoped, correctly signed fingerprint from a
      // DIFFERENT production app was certifying separation for the app actually pinned here.
      expect(activation.checks.find((c) => c.id === "credential-separation")!.status).not.toBe("pass");
      // The exporter's object was never touched — the refusal is the consumer's own decision about
      // a completely unchanged, validly signed, unexpired production measurement.
      expect(transport.objects.get(result.objectId)!.equals(originalBytes)).toBe(true);
    } finally { topology.cleanup(); }
  });

  it("treats an ABSENT production pin as unmeasured rather than as a pass", async () => {
    const { transport, fixture, result } = await publish();
    const topology = consumerTopology({ postgresServiceId: "" });
    try {
      const activation = await runActivationPreflight(importerEnv(result.objectId, { STAGING_TOPOLOGY_FILE: topology.file }),
        { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader });
      expect(activation.status).not.toBe("READY TO ACTIVATE");
      expect(activation.checks.find((c) => c.id === "production-subject-identity")!.status).not.toBe("pass");
      expect(activation.checks.find((c) => c.id === "credential-separation")!.status).not.toBe("pass");
    } finally { topology.cleanup(); }
  });
});

/**
 * The active runner artifact. `serviceInstance.source.image` is service CONFIGURATION, and Railway
 * documents staged changes that can be committed WITHOUT triggering a redeploy — so a correct
 * configured reference plus a correct pinned active deployment ID still says nothing about which
 * artifact that deployment is executing. The authenticated deployment's own `meta.imageDigest` is
 * the observed field that does; missing or malformed metadata is UNVERIFIED, not a pass.
 */
describe("the runner image measurement is about the artifact actually running", () => {
  it("refuses when configuration is exactly the pin but the active deployment runs another artifact", async () => {
    const wrong = `sha256:${"b".repeat(64)}`;
    // Producer side: the exporter must not sign a measurement it cannot stand behind.
    await expect(publish({ runnerDeploymentDigest: wrong })).rejects.toThrow(/different artifact than its pinned immutable image/);

    // Consumer side, through unchanged valid signed evidence: the importer's OWN runner disagrees.
    const { transport, result } = await publish();
    const activation = await runActivationPreflight(importerEnv(result.objectId),
      { fetchImpl: providerFixture({ runnerDeploymentDigest: wrong }).fetchImpl, evidenceStore: transport.reader });
    expect(activation.status).toBe("NOT ACTIVATED");
    expect(activation.checks.find((check) => check.id === "runner-image-pinned")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/RUNNING a different artifact/),
    });
  });

  it("reports UNVERIFIED — never READY — when the deployment carries no usable image identity", async () => {
    await expect(publish({ runnerDeploymentDigest: null })).rejects.toThrow(/no well-formed active image digest/);
    await expect(publish({ runnerDeploymentDigest: "not-a-digest" })).rejects.toThrow(/no well-formed active image digest/);
  });

  it("rejects a legacy envelope that predates the measurement instead of defaulting it to success", async () => {
    const { transport, fixture, result } = await publish();
    const original = JSON.parse(transport.objects.get(result.objectId)!.toString("utf8"));
    const legacy = structuredClone(original);
    delete legacy.evidence.production.runner.imageDigest;
    const bytes = Buffer.from(JSON.stringify(legacy));
    const id = `activation-legacy--${createHash("sha256").update(bytes).digest("hex")}`;
    transport.objects.set(id, bytes);
    await expect(runActivationPreflight(importerEnv(id), { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader }))
      .rejects.toThrow(/runner measurement has unsupported or missing fields/);
  });

  it("refuses when the CONSUMER's expected exporter image differs from the signed measurement", async () => {
    // The signer's own expectation is not a substitute for this consumer's. Unchanged valid
    // evidence, one changed consumer expectation.
    const { transport, fixture, result } = await publish();
    const activation = await runActivationPreflight(
      importerEnv(result.objectId, { PRODUCTION_EXPORTER_IMAGE_DIGEST: `registry.example/ops@sha256:${"c".repeat(64)}` }),
      { fetchImpl: fixture.fetchImpl, evidenceStore: transport.reader });
    expect(activation.status).toBe("NOT ACTIVATED");
    expect(activation.checks.find((c) => c.id === "runner-image-pinned")!.status).toBe("fail");
  });
});
