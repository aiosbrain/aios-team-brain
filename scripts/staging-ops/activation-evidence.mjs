import { createHash, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { canonicalJson } from "./bundle-crypto.mjs";
import { credentialFingerprint, fingerprintWellFormed, REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES } from "./credential-fingerprint.mjs";
import { keyMaterial } from "./key-material.mjs";
import { canonicalObjectId, createPrivateStore, parseCanonicalObjectId } from "./object-store.mjs";
import { readFile } from "node:fs/promises";

export const ACTIVATION_EVIDENCE_PURPOSE = "activation-evidence-v1";
export const ACTIVATION_EVIDENCE_SCHEMA_VERSION = 1;
export const ACTIVATION_EVIDENCE_MAX_BYTES = 128 * 1024;
export const ACTIVATION_EVIDENCE_MAX_TTL_MS = 15 * 60 * 1000;
export const ACTIVATION_EVIDENCE_CLOCK_SKEW_MS = 60 * 1000;
const SIGNING_DOMAIN = Buffer.from("aios-staging-activation-evidence\0v1\0", "utf8");
const GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const INTERNAL = /(?:^|\.)railway\.internal$/i;
const REFERENCE = /\$\{\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}/g;
const PROVIDER_KEYS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AZURE_OPENAI_API_KEY",
  "COHERE_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "VOYAGE_API_KEY",
  "VOYAGEAI_API_KEY", "GROQ_API_KEY", "LLM_API_KEY", "EMBEDDER_API_KEY", "MODEL_API_KEY",
]);

export const ACTIVATION_ACQUISITION_DOCUMENTS = Object.freeze({
  projectToken: `query ActivationProjectToken { projectToken { projectId environmentId } }`,
  serviceConfiguration: `query ActivationServiceConfiguration($projectId: String!, $environmentId: String!, $serviceId: String!, $after: String) {
    serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
      id environmentId serviceId serviceName updatedAt source { image repo }
      activeDeployments { id projectId environmentId serviceId status snapshotId meta }
      service { repoTriggers(first: 100, after: $after) { edges { node { id projectId environmentId serviceId branch repository provider } } pageInfo { hasNextPage endCursor } } }
    }
    serviceInstanceAutoDeployStatus(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { enabled }
  }`,
  variables: `query ActivationServiceVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
    unrendered: variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
    rendered: variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }`,
  snapshot: `query ActivationDeploymentSnapshot($deploymentId: String!) { deploymentSnapshot(deploymentId: $deploymentId) { id variables } }`,
  privateNetworks: `query ActivationPrivateNetworks($environmentId: String!) { privateNetworks(environmentId: $environmentId) { publicId projectId environmentId dnsName deletedAt } }`,
  privateEndpoint: `query ActivationPrivateEndpoint($privateNetworkId: String!, $environmentId: String!, $serviceId: String!) {
    privateNetworkEndpoint(privateNetworkId: $privateNetworkId, environmentId: $environmentId, serviceId: $serviceId) { serviceInstanceId dnsName newDnsName deletedAt syncStatus }
  }`,
});

const ALLOWED_OPERATIONS = new Set(Object.values(ACTIVATION_ACQUISITION_DOCUMENTS).map((document) => /\bquery\s+(\w+)/.exec(document)[1]));

export function assertActivationAcquisitionDocument(document) {
  const text = String(document ?? "");
  if (/\bmutation\b/i.test(text)) throw new Error("activation acquisition refused a mutating provider document");
  const operation = /\bquery\s+(\w+)/.exec(text)?.[1];
  if (!operation || !ALLOWED_OPERATIONS.has(operation) || !Object.values(ACTIVATION_ACQUISITION_DOCUMENTS).includes(text)) {
    throw new Error("activation acquisition refused anything except its exact fixed provider documents");
  }
  return operation;
}

async function responseObject(response) {
  let body;
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text) > ACTIVATION_EVIDENCE_MAX_BYTES * 8) throw new Error("activation provider response exceeded its fixed bound");
    try { body = JSON.parse(text); } catch { body = null; }
  } else {
    body = await response.json().catch(() => null);
    if (Buffer.byteLength(JSON.stringify(body ?? null)) > ACTIVATION_EVIDENCE_MAX_BYTES * 8) throw new Error("activation provider response exceeded its fixed bound");
  }
  return body;
}

export async function activationRailwayQuery({ document, variables, token, fetchImpl = fetch, apiUrl = GRAPHQL_URL, budget = null }) {
  assertActivationAcquisitionDocument(document);
  const response = await fetchImpl(apiUrl, {
    method: "POST", redirect: "error",
    headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }), signal: AbortSignal.timeout(budget?.remaining(15_000, "activation provider request") ?? 15_000),
  });
  const body = await responseObject(response);
  // Provider bodies can echo arbitrary variable values. Never copy them into diagnostics.
  if (!response.ok || body?.errors?.length || !body?.data) throw new Error(`activation provider read failed (${response.status})`);
  return body.data;
}

function fixedEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8"); const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function requireValue(map, name) {
  if (!map || !Object.hasOwn(map, name) || typeof map[name] !== "string" || !map[name] || map[name].includes("${{")) {
    throw new Error(`deployment snapshot has missing, sealed, unresolved or unbound ${name}`);
  }
  return map[name];
}

function parseUrl(value, label) {
  try {
    const url = new URL(value);
    if (!url.hostname) throw new Error();
    return url;
  } catch { throw new Error(`${label} is not a bound URL in the deployment snapshot`); }
}

export function describeServiceReference(value, expectedServiceName, expectedVariable) {
  const text = String(value ?? "");
  const matches = [...text.matchAll(REFERENCE)];
  const stripped = text.replace(REFERENCE, "REFERENCE");
  if (matches.length !== 1 || stripped.includes("${{") || /[{}$]/.test(stripped)) throw new Error(`${expectedVariable} is not one bounded Railway service reference`);
  const [, serviceName, variableName] = matches[0];
  if (serviceName !== expectedServiceName || variableName !== expectedVariable) throw new Error(`${expectedVariable} reference targets the wrong pinned service or variable`);
  return { kind: "railway-service-reference", serviceName, variableName };
}

async function readServiceConfiguration({ pins, serviceId, token, fetchImpl, budget = null }) {
  let after = null; const triggers = []; let first = null;
  for (let page = 0; page < 5; page += 1) {
    const data = await activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.serviceConfiguration,
      variables: { projectId: pins.projectId, environmentId: pins.environmentId, serviceId, after }, token, fetchImpl, budget });
    const instance = data.serviceInstance;
    if (!instance || instance.serviceId !== serviceId || instance.environmentId !== pins.environmentId) throw new Error("provider service read-back does not match its pinned instance");
    if (first && (first.id !== instance.id || first.updatedAt !== instance.updatedAt)) throw new Error("provider service configuration drifted during acquisition");
    first ??= instance;
    triggers.push(...(instance.service?.repoTriggers?.edges ?? []).map((edge) => edge.node));
    const pageInfo = instance.service?.repoTriggers?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) return { instance: first, autoDeploy: data.serviceInstanceAutoDeployStatus?.enabled, triggers };
    if (!pageInfo.endCursor) throw new Error("provider trigger pagination returned no cursor");
    after = pageInfo.endCursor;
  }
  throw new Error("provider trigger pagination exceeded its fixed bound");
}

function servingDeployment(configuration, pins, role) {
  const deployments = configuration.instance.activeDeployments ?? [];
  const serving = deployments.filter((deployment) => deployment.status === "SUCCESS");
  if (serving.length !== 1) throw new Error(`${role} has no unambiguous successful active deployment`);
  const deployment = serving[0];
  const expectedId = pins[`${role}DeploymentId`];
  if (!expectedId || deployment.id !== expectedId || deployment.projectId !== pins.projectId || deployment.environmentId !== pins.environmentId || deployment.serviceId !== pins[`${role}ServiceId`]) {
    throw new Error(`${role} deployment does not match its pinned project/environment/service/deployment identity`);
  }
  if (!deployment.snapshotId) throw new Error(`${role} deployment has no bound configuration snapshot`);
  return deployment;
}

async function readVariableSnapshot({ pins, serviceId, deployment, token, fetchImpl, budget = null }) {
  const [maps, snapshotData] = await Promise.all([
    activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.variables, variables: { projectId: pins.projectId, environmentId: pins.environmentId, serviceId }, token, fetchImpl, budget }),
    activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.snapshot, variables: { deploymentId: deployment.id }, token, fetchImpl, budget }),
  ]);
  const snapshot = snapshotData.deploymentSnapshot;
  if (!snapshot || snapshot.id !== deployment.snapshotId || !snapshot.variables || !maps?.rendered || !maps?.unrendered) throw new Error("deployment configuration snapshot is missing or unbound");
  return { current: maps.rendered, unrendered: maps.unrendered, deployed: snapshot.variables };
}

async function endpointFor({ pins, service, network, token, fetchImpl, budget = null }) {
  const data = await activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.privateEndpoint,
    variables: { privateNetworkId: network.publicId, environmentId: pins.environmentId, serviceId: service.instance.serviceId }, token, fetchImpl, budget });
  const endpoint = data.privateNetworkEndpoint;
  if (!endpoint || endpoint.serviceInstanceId !== service.instance.id || endpoint.deletedAt || endpoint.newDnsName || endpoint.syncStatus !== "SUCCESS" || !INTERNAL.test(String(endpoint.dnsName ?? ""))) {
    throw new Error("private endpoint is missing, pending, deleted or not bound to the pinned service instance");
  }
  return endpoint.dnsName.toLowerCase();
}

/** A well-formed OCI content digest. Nothing else is accepted as an artifact identity. */
export const IMAGE_CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The digest an immutable `repo/name@sha256:…` reference pins, or `null` if the reference is not
 * digest-pinned. Deliberately NOT a tag resolver: resolving a tag at activation measures the
 * registry today, not the artifact this deployment was created from.
 */
export function expectedImageDigest(image) {
  const suffix = /@(sha256:[0-9a-f]{64})$/i.exec(String(image ?? ""))?.[1];
  return suffix ? suffix.toLowerCase() : null;
}

/**
 * Measure the artifact the runner is ACTUALLY RUNNING, not merely the one it is configured with.
 *
 * `serviceInstance.source.image` is SERVICE CONFIGURATION. Railway documents staged changes that
 * can be committed without triggering a redeploy, so configuration need not describe the deployment
 * currently serving — and pinning the deployment ID proves the deployment is the expected one, not
 * which image it runs. The authenticated deployment node's `meta.imageDigest` is the one field
 * observed to carry a deployment-associated artifact identity: read live from two Railway
 * environments, and independently correlated against the public registry (a `neo4j:5.26.2`
 * deployment's `meta.imageDigest` equalled that tag's `Docker-Content-Digest` exactly).
 *
 * ⚠️ THE LIMITS OF THAT EVIDENCE, stated because they bound what this check may claim.
 * `Deployment.meta` is an opaque scalar in Railway's public schema with no documented members, so
 * this is a PROVIDER-OBSERVED contract, not a formal guarantee — and the observed value identified
 * the source INDEX digest, not the architecture-specific child actually executed. An index digest
 * is a legitimate immutable pin and is what a `@sha256:` reference names, which is why it is
 * compared against the reference's own suffix. Real digest-pinned runner commissioning remains an
 * activation prerequisite; a fixture pass is not a live provider contract.
 *
 * Fails closed both ways: missing, null or malformed metadata refuses (it is not evidence), and a
 * well-formed DIFFERENT digest refuses (it is evidence of the wrong artifact). There is no fallback
 * to `meta.image`, to the configured reference, or to a freshly resolved tag.
 */
function assertRunner(configuration, pins, role, deployment) {
  const expectedImage = pins[`${role}Image`];
  if (!expectedImage || configuration.instance.source?.image !== expectedImage || !/@sha256:[0-9a-f]{64}$/i.test(expectedImage)) throw new Error(`${role} runner image is not the pinned immutable artifact`);
  if (configuration.instance.source?.repo || configuration.autoDeploy !== false) throw new Error(`${role} runner has a repository source or automatic deployments enabled`);
  const local = configuration.triggers.filter((trigger) => trigger.projectId === pins.projectId && trigger.environmentId === pins.environmentId && trigger.serviceId === pins[`${role}ServiceId`]);
  if (local.length) throw new Error(`${role} runner has a repository deploy trigger`);
  const measured = String(deployment?.meta?.imageDigest ?? "").toLowerCase();
  if (!IMAGE_CONTENT_DIGEST.test(measured)) throw new Error(`${role} runner deployment reports no well-formed active image digest, so its running artifact is UNVERIFIED`);
  if (measured !== expectedImageDigest(expectedImage)) throw new Error(`${role} runner deployment is running a different artifact than its pinned immutable image`);
  return measured;
}

function assertAppTrigger(configuration, pins) {
  const local = configuration.triggers.filter((trigger) => trigger.projectId === pins.projectId && trigger.environmentId === pins.environmentId && trigger.serviceId === pins.appServiceId);
  if (local.length !== 1 || local[0].branch !== pins.appBranch || local[0].repository !== pins.repository) throw new Error("application repository trigger does not match the pinned repository and source branch");
  return { repository: local[0].repository, branch: local[0].branch, provider: local[0].provider ?? null };
}

/** Fixed, role-local provider acquisition. Raw variable maps never leave this function. */
export async function collectActivationEnvironment({ pins, token, comparisonKey, comparisonKeyId, includeGraphiti = false, fetchImpl = fetch, budget = null }) {
  budget?.assert(`${pins.runnerRole} activation token scope read`);
  const scope = await activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.projectToken, variables: {}, token, fetchImpl, budget }).then((data) => data.projectToken);
  if (!scope || scope.projectId !== pins.projectId || scope.environmentId !== pins.environmentId) throw new Error("activation token scope does not match the pinned project/environment");

  const roles = ["app", pins.runnerRole, "postgres", "neo4j", ...(includeGraphiti ? ["graphiti"] : [])];
  budget?.assert(`${pins.runnerRole} activation service reads`);
  const configurations = Object.fromEntries(await Promise.all(roles.map(async (role) => [role, await readServiceConfiguration({ pins, serviceId: pins[`${role}ServiceId`], token, fetchImpl, budget })])));
  const appDeployment = servingDeployment(configurations.app, pins, "app");
  const runnerDeployment = servingDeployment(configurations[pins.runnerRole], pins, pins.runnerRole);
  const postgresDeployment = servingDeployment(configurations.postgres, pins, "postgres");
  const neo4jDeployment = servingDeployment(configurations.neo4j, pins, "neo4j");
  const graphitiDeployment = includeGraphiti ? servingDeployment(configurations.graphiti, pins, "graphiti") : null;
  const runnerImageDigest = assertRunner(configurations[pins.runnerRole], pins, pins.runnerRole, runnerDeployment);
  const source = assertAppTrigger(configurations.app, pins);

  budget?.assert(`${pins.runnerRole} activation network reads`);
  const networks = await activationRailwayQuery({ document: ACTIVATION_ACQUISITION_DOCUMENTS.privateNetworks, variables: { environmentId: pins.environmentId }, token, fetchImpl, budget });
  const exactNetworks = (networks.privateNetworks ?? []).filter((network) => !network.deletedAt && network.projectId === pins.projectId && network.environmentId === pins.environmentId);
  if (exactNetworks.length !== 1) throw new Error("activation acquisition found no unambiguous pinned private network");
  budget?.assert(`${pins.runnerRole} activation snapshot reads`);
  const acquired = await Promise.all([
    endpointFor({ pins, service: configurations.postgres, network: exactNetworks[0], token, fetchImpl, budget }),
    endpointFor({ pins, service: configurations.neo4j, network: exactNetworks[0], token, fetchImpl, budget }),
    readVariableSnapshot({ pins, serviceId: pins.appServiceId, deployment: appDeployment, token, fetchImpl, budget }),
    includeGraphiti ? readVariableSnapshot({ pins, serviceId: pins.graphitiServiceId, deployment: graphitiDeployment, token, fetchImpl, budget }) : null,
  ]);
  const [postgresHost, neo4jHost] = acquired;
  let appVariables = acquired[2];
  let graphitiVariables = acquired[3];
  let deployed = null;
  try {

  const subjects = ["AUTH_SECRET", "SECRETS_KEY", "NEO4J_USER", "NEO4J_PASSWORD", "DATABASE_URL", "NEO4J_URL", "NEO4J_DATABASE"];
  deployed = Object.fromEntries(subjects.map((name) => [name, requireValue(appVariables.deployed, name)]));
  for (const name of subjects) {
    const current = requireValue(appVariables.current, name);
    if (!fixedEqual(current, deployed[name])) throw new Error(`current rendered ${name} differs from the pinned deployment snapshot`);
  }
  const databaseUrl = parseUrl(deployed.DATABASE_URL, "DATABASE_URL");
  const neo4jUrl = parseUrl(deployed.NEO4J_URL, "NEO4J_URL");
  if (databaseUrl.hostname.toLowerCase() !== postgresHost || neo4jUrl.hostname.toLowerCase() !== neo4jHost) throw new Error("deployed application database host does not match its pinned private endpoint");
  if (pins.postgresHost !== postgresHost || pins.neo4jHost !== neo4jHost) throw new Error("measured private endpoint does not match the topology pin");
  const references = {
    DATABASE_URL: describeServiceReference(appVariables.unrendered.DATABASE_URL, configurations.postgres.instance.serviceName, "DATABASE_URL"),
    NEO4J_URL: describeServiceReference(appVariables.unrendered.NEO4J_URL, configurations.neo4j.instance.serviceName, "RAILWAY_PRIVATE_DOMAIN"),
  };

  const credentialFingerprints = Object.fromEntries([
    ["auth-secret", deployed.AUTH_SECRET], ["secrets-key", deployed.SECRETS_KEY], ["neo4j-credential", `${deployed.NEO4J_USER}\0${deployed.NEO4J_PASSWORD}`],
  ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: comparisonKeyId })]));

  const graphitiProviderCredentials = [];
  if (graphitiVariables) {
    for (const name of PROVIDER_KEYS) {
      if (Object.hasOwn(graphitiVariables.current, name) || Object.hasOwn(graphitiVariables.deployed, name) || Object.hasOwn(graphitiVariables.unrendered, name)) graphitiProviderCredentials.push(name);
    }
  }

  // Re-read identities/config timestamps after the value-bearing responses. This is observation,
  // not a provider transaction; any drift refuses rather than certifying a mixed-time snapshot.
  budget?.assert(`${pins.runnerRole} activation drift reads`);
  for (const role of ["app", pins.runnerRole, ...(includeGraphiti ? ["graphiti"] : [])]) {
    const again = await readServiceConfiguration({ pins, serviceId: pins[`${role}ServiceId`], token, fetchImpl, budget });
    if (again.instance.id !== configurations[role].instance.id || again.instance.updatedAt !== configurations[role].instance.updatedAt ||
        JSON.stringify(again.instance.activeDeployments) !== JSON.stringify(configurations[role].instance.activeDeployments)) throw new Error(`${role} deployment/configuration drifted during activation acquisition`);
  }

  return {
    scope, app: { serviceId: pins.appServiceId, deploymentId: appDeployment.id, snapshotId: appDeployment.snapshotId,
      commitSha: appDeployment.meta?.commitHash ?? appDeployment.meta?.repoCommit ?? null, source, references,
      postgresHost, neo4jHost, neo4jDatabase: deployed.NEO4J_DATABASE },
    // `image` is the CONFIGURED reference; `imageDigest` is the artifact the pinned active
    // deployment reports running. They are carried separately and deliberately: renaming
    // configuration as runtime evidence is the thing this measurement exists to stop.
    runner: { serviceId: pins[`${pins.runnerRole}ServiceId`], deploymentId: runnerDeployment.id, snapshotId: runnerDeployment.snapshotId,
      image: configurations[pins.runnerRole].instance.source.image, imageDigest: runnerImageDigest, repo: null, autoDeploy: false },
    resources: {
      postgres: { serviceId: pins.postgresServiceId, instanceId: configurations.postgres.instance.id, deploymentId: postgresDeployment.id, snapshotId: postgresDeployment.snapshotId, host: postgresHost },
      neo4j: { serviceId: pins.neo4jServiceId, instanceId: configurations.neo4j.instance.id, deploymentId: neo4jDeployment.id, snapshotId: neo4jDeployment.snapshotId, host: neo4jHost, database: deployed.NEO4J_DATABASE },
    },
    credentialFingerprints, graphitiProviderCredentials,
    graphiti: graphitiDeployment ? { serviceId: pins.graphitiServiceId, deploymentId: graphitiDeployment.id, snapshotId: graphitiDeployment.snapshotId } : null,
  };
  } finally {
    // JavaScript strings cannot be securely erased, but keeping the value-bearing response maps
    // reachable after reduction would be avoidable exposure. No raw map crosses this boundary.
    appVariables = null; graphitiVariables = null; deployed = null; acquired[2] = null; acquired[3] = null;
  }
}

function signedEvidenceBytes(evidence) {
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(canonicalJson(evidence), "utf8")]);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new Error(`${label} has unsupported or missing fields`);
}

export function validateActivationEvidence(evidence) {
  exactKeys(evidence, ["schemaVersion", "purpose", "evidenceId", "issuedAt", "expiresAt", "issuer", "audience", "production"], "activation evidence");
  if (evidence.schemaVersion !== ACTIVATION_EVIDENCE_SCHEMA_VERSION || evidence.purpose !== ACTIVATION_EVIDENCE_PURPOSE) throw new Error("activation evidence has the wrong schema or purpose");
  if (!/^[0-9a-f-]{36}$/i.test(String(evidence.evidenceId ?? ""))) throw new Error("activation evidence ID is invalid");
  exactKeys(evidence.issuer, ["role", "projectId", "environmentId"], "activation evidence issuer");
  exactKeys(evidence.audience, ["projectId", "environmentId"], "activation evidence audience");
  if (evidence.issuer.role !== "production-exporter") throw new Error("activation evidence issuer role is invalid");
  exactKeys(evidence.production, ["scope", "app", "runner", "resources", "credentialFingerprints", "graphitiProviderCredentials", "graphiti"], "production activation measurement");
  exactKeys(evidence.production.scope, ["projectId", "environmentId"], "production scope");
  exactKeys(evidence.production.app, ["serviceId", "deploymentId", "snapshotId", "commitSha", "source", "references", "postgresHost", "neo4jHost", "neo4jDatabase"], "production application measurement");
  exactKeys(evidence.production.app.source, ["repository", "branch", "provider"], "production source measurement");
  exactKeys(evidence.production.app.references, ["DATABASE_URL", "NEO4J_URL"], "production reference measurement");
  for (const reference of Object.values(evidence.production.app.references)) exactKeys(reference, ["kind", "serviceName", "variableName"], "production reference descriptor");
  // `imageDigest` is REQUIRED, so an envelope produced before this measurement existed is rejected
  // rather than given an implicit success default. `exactKeys` refuses both absence and extras.
  exactKeys(evidence.production.runner, ["serviceId", "deploymentId", "snapshotId", "image", "imageDigest", "repo", "autoDeploy"], "production runner measurement");
  if (!IMAGE_CONTENT_DIGEST.test(String(evidence.production.runner.imageDigest ?? ""))) throw new Error("production runner measurement has no well-formed active image digest");
  if (evidence.production.runner.imageDigest !== expectedImageDigest(evidence.production.runner.image)) throw new Error("production runner measurement's active image digest does not match its own configured immutable reference");
  exactKeys(evidence.production.resources, ["postgres", "neo4j"], "production resource measurements");
  exactKeys(evidence.production.resources.postgres, ["serviceId", "instanceId", "deploymentId", "snapshotId", "host"], "production Postgres measurement");
  exactKeys(evidence.production.resources.neo4j, ["serviceId", "instanceId", "deploymentId", "snapshotId", "host", "database"], "production Neo4j measurement");
  exactKeys(evidence.production.credentialFingerprints, REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES, "production credential fingerprints");
  for (const credentialClass of REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES) {
    const fingerprint = evidence.production.credentialFingerprints[credentialClass];
    exactKeys(fingerprint, ["version", "keyId", "keyConfirmation", "credentialClass", "mac"], `${credentialClass} fingerprint`);
    if (!fingerprintWellFormed(fingerprint) || fingerprint.credentialClass !== credentialClass) throw new Error(`activation evidence lacks a valid ${credentialClass} fingerprint`);
  }
  if (!Array.isArray(evidence.production.graphitiProviderCredentials) || evidence.production.graphiti !== null) throw new Error("production activation evidence has an unsupported Graphiti measurement");
  return true;
}

export function createActivationEvidenceEnvelope({ production, audience, privateKey, now = Date.now(), ttlMs = ACTIVATION_EVIDENCE_MAX_TTL_MS }) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > ACTIVATION_EVIDENCE_MAX_TTL_MS) throw new Error("activation evidence TTL exceeds its fixed bound");
  const evidence = { schemaVersion: 1, purpose: ACTIVATION_EVIDENCE_PURPOSE, evidenceId: randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    issuer: { role: "production-exporter", ...production.scope }, audience, production };
  validateActivationEvidence(evidence);
  return { evidence, signature: sign(null, signedEvidenceBytes(evidence), privateKey).toString("base64") };
}

export function openActivationEvidenceEnvelope({ bytes, publicKey, expectedAudience, expectedProduction, now = Date.now() }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > ACTIVATION_EVIDENCE_MAX_BYTES) throw new Error("activation evidence exceeds its fixed maximum size");
  let envelope; try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("activation evidence is not valid JSON"); }
  exactKeys(envelope, ["evidence", "signature"], "activation evidence envelope");
  validateActivationEvidence(envelope.evidence);
  const signature = Buffer.from(String(envelope.signature ?? ""), "base64");
  if (signature.length !== 64 || !verify(null, signedEvidenceBytes(envelope.evidence), publicKey, signature)) throw new Error("activation evidence signature verification failed");
  const issued = Date.parse(envelope.evidence.issuedAt); const expires = Date.parse(envelope.evidence.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > ACTIVATION_EVIDENCE_MAX_TTL_MS || issued > now + ACTIVATION_EVIDENCE_CLOCK_SKEW_MS || expires < now) throw new Error("activation evidence is stale, future-issued or has an invalid lifetime");
  for (const [label, actual, expected] of [["audience", envelope.evidence.audience, expectedAudience], ["production", envelope.evidence.issuer, { role: "production-exporter", ...expectedProduction }]]) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`activation evidence ${label} identity does not match its pin`);
  }
  return envelope.evidence;
}

export async function publishActivationEvidence({ env = process.env, fetchImpl = fetch, store, budget = null }) {
  budget?.assert("production activation topology read");
  const topology = JSON.parse(await readFile(env.STAGING_TOPOLOGY_FILE, "utf8"));
  const productionPins = pinsFromEnvironment(env, topology.production, "production");
  const production = await collectActivationEnvironment({ pins: productionPins, token: env.RAILWAY_PRODUCTION_ACTIVATION_READ_TOKEN,
    comparisonKey: Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64"), comparisonKeyId: env.STAGING_COMPARISON_KEY_ID, fetchImpl, budget });
  budget?.assert("activation evidence signing");
  const envelope = createActivationEvidenceEnvelope({ production, audience: { projectId: topology.staging.projectId, environmentId: topology.staging.environmentId }, privateKey: keyMaterial(env, "EXPORTER_SIGNING_PRIVATE_KEY") });
  const bytes = Buffer.from(JSON.stringify(envelope)); const digest = createHash("sha256").update(bytes).digest("hex");
  const objectId = canonicalObjectId(`activation-${envelope.evidence.evidenceId}`, digest);
  budget?.assert("activation evidence immutable publication");
  await (store ?? createPrivateStore({ env, scope: "source", role: "publisher" })).putImmutable(objectId, bytes);
  budget?.assert("activation evidence publication completion");
  return { status: "activation-evidence-published", objectId, sha256: digest, evidenceId: envelope.evidence.evidenceId, expiresAt: envelope.evidence.expiresAt };
}

export async function readVerifiedActivationEvidence({ env = process.env, store, now = Date.now() }) {
  const objectId = env.ACTIVATION_EVIDENCE_OBJECT_ID;
  const identity = parseCanonicalObjectId(objectId);
  const bytes = await (store ?? createPrivateStore({ env, scope: "source", role: "source-reader" })).read(objectId);
  if (createHash("sha256").update(bytes).digest("hex") !== identity.digest) throw new Error("activation evidence bytes differ from their immutable object identity");
  return openActivationEvidenceEnvelope({ bytes, publicKey: keyMaterial(env, "EXPORTER_SIGNING_PUBLIC_KEY"), now,
    expectedAudience: { projectId: env.RAILWAY_PROJECT_ID, environmentId: env.STAGING_OPS_ENVIRONMENT_ID },
    expectedProduction: { projectId: env.PRODUCTION_PROJECT_ID, environmentId: env.PRODUCTION_ENVIRONMENT_ID } });
}

export function pinsFromEnvironment(env, topologySide, side) {
  const production = side === "production";
  const runnerRole = production ? "exporter" : "importer";
  return {
    projectId: topologySide.projectId, environmentId: topologySide.environmentId,
    appServiceId: topologySide.appServiceId, appDeploymentId: env[`${production ? "PRODUCTION" : "STAGING"}_APP_DEPLOYMENT_ID`],
    appBranch: topologySide.appSourceBranch, repository: env.GITHUB_REPOSITORY,
    postgresServiceId: topologySide.postgresServiceId, postgresHost: topologySide.postgresHost,
    postgresDeploymentId: env[`${production ? "PRODUCTION" : "STAGING"}_POSTGRES_DEPLOYMENT_ID`],
    neo4jServiceId: topologySide.neo4jServiceId, neo4jHost: topologySide.neo4jHost,
    neo4jDeploymentId: env[`${production ? "PRODUCTION" : "STAGING"}_NEO4J_DEPLOYMENT_ID`],
    graphitiServiceId: topologySide.graphitiServiceId, graphitiDeploymentId: env.STAGING_GRAPHITI_DEPLOYMENT_ID,
    runnerRole,
    [`${runnerRole}ServiceId`]: env[production ? "PRODUCTION_EXPORTER_SERVICE_ID" : "STAGING_IMPORTER_SERVICE_ID"],
    [`${runnerRole}DeploymentId`]: env[production ? "PRODUCTION_EXPORTER_DEPLOYMENT_ID" : "STAGING_IMPORTER_DEPLOYMENT_ID"],
    [`${runnerRole}Image`]: env[production ? "PRODUCTION_EXPORTER_IMAGE_DIGEST" : "STAGING_IMPORTER_IMAGE_DIGEST"],
  };
}
