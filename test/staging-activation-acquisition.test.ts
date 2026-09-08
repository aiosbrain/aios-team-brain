import { createHash, generateKeyPairSync } from "node:crypto";
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

type FixtureOptions = {
  productionSecrets?: string; stagingSecrets?: string; productionBranch?: string;
  stagingReference?: string; graphitiKey?: string; sealedProduction?: boolean; snapshotUnbound?: boolean;
  providerError?: boolean; currentDrift?: boolean; runnerAutoDeploy?: boolean; runnerImage?: string;
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
      return Response.json({ data: {
        serviceInstance: { id: `${envId}:${serviceId}`, environmentId: envId, serviceId, serviceName: role === "postgres" ? "Postgres" : role === "neo4j" ? "neo4j" : role,
          updatedAt: "2026-09-08T00:00:00Z", source: role === "exporter" || role === "importer" ? { image: options.runnerImage ?? image, repo: null } : { image: null, repo: role === "app" ? "org/repo" : null },
          activeDeployments: [{ id: deploymentId, projectId: "project-a", environmentId: envId, serviceId, status: "SUCCESS", snapshotId: `${deploymentId}-snapshot`, meta: { commitHash: role === "app" ? commit : null } }],
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
