#!/usr/bin/env node
/**
 * The CALLABLE, READ-ONLY activation verifier (H2).
 *
 * What was here before was `assertStagingTopology` — a pure function that validates a facts
 * document someone hands it, with no production caller. That is a validator, not a verifier: it
 * tells you whether a JSON file is internally consistent, and a JSON file can say anything. This
 * module is the other half: it MEASURES the facts from the providers, then evaluates them.
 *
 * Three rules it exists to enforce, each of which had been violated somewhere:
 *
 *  1. **An unmeasured check is `UNVERIFIED`, never a pass.** Every check emits a status; there is
 *     no path where a missing measurement is silently skipped. `UNVERIFIED` is a distinct overall
 *     verdict from `NOT ACTIVATED`: the first means "we could not look", the second means "we
 *     looked and it is wrong", and collapsing them is how an unactivated system starts describing
 *     itself as ready.
 *  2. **An operator's assertion is not evidence.** Claims (`ACTIVATION_*` variables, a checkbox in
 *     a runbook, a repository variable named `..._VERIFIED_DOMAIN`) are RECORDED for the audit and
 *     can only ever downgrade a verdict. No claim satisfies a check.
 *  3. **It reads. It never writes.** Only the read-only documents in `READ_ONLY_OPERATIONS` may be
 *     issued, and `assertReadOnlyDocument` refuses anything else before it reaches the network.
 *     Nothing here deploys, restarts, sets a variable or touches a database.
 *
 * Redaction: this module handles credential-bearing configuration and emits NO variable VALUES.
 * It reports shapes, presence, digests and HMAC fingerprints only.
 */

import { readFileSync } from "node:fs";
import { assertStagingTopology } from "./config.mjs";
import { credentialFingerprint, fingerprintsEqual } from "./credential-fingerprint.mjs";

export const ACTIVATION_STATUS = Object.freeze({
  ACTIVATED: "ACTIVATED",
  NOT_ACTIVATED: "NOT ACTIVATED",
  UNVERIFIED: "UNVERIFIED",
});

const PASS = "pass";
const FAIL = "fail";
const UNVERIFIED = "unverified";

/** Every check this verifier can report, in reporting order. A check is never omitted. */
export const ACTIVATION_CHECKS = Object.freeze([
  "topology-identity",
  "token-environment-scope",
  "runner-image-pinned",
  "runner-autodeploy-disabled",
  "app-deployment-measured",
  "app-mode-declared",
  "app-no-model-spend",
  "graphiti-no-provider-credentials",
  "credential-separation",
  "schedules-disabled",
]);

/**
 * The ONLY GraphQL operations this verifier may issue. Enforced before the request, not by
 * convention: a verifier that can mutate is a deployment tool that has not admitted it yet.
 */
export const READ_ONLY_OPERATIONS = Object.freeze([
  "ActivationProjectToken",
  "ActivationServiceInstance",
  "ActivationDeployments",
]);

const MUTATION = /\bmutation\b/i;

export function assertReadOnlyDocument(document) {
  const text = String(document ?? "");
  if (MUTATION.test(text)) throw new Error("activation preflight refused a mutating GraphQL document");
  const name = /\bquery\s+([A-Za-z0-9_]+)/.exec(text)?.[1];
  if (!name || !READ_ONLY_OPERATIONS.includes(name)) {
    throw new Error(`activation preflight refused an unlisted GraphQL document (${name ?? "anonymous"})`);
  }
  return name;
}

export const ACTIVATION_DOCUMENTS = Object.freeze({
  projectToken: `query ActivationProjectToken { projectToken { projectId environmentId } }`,
  serviceInstance: `query ActivationServiceInstance($projectId: String!, $environmentId: String!, $serviceId: String!) {
    serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { serviceId source { image repo } }
    serviceInstanceAutoDeployStatus(environmentId: $environmentId, projectId: $projectId, serviceId: $serviceId) { enabled }
  }`,
  deployments: `query ActivationDeployments($environmentId: String!, $serviceId: String!) {
    deployments(first: 5, input: { environmentId: $environmentId, serviceId: $serviceId }) {
      edges { node { id status staticUrl environmentId serviceId meta } }
    }
  }`,
});

const check = (id, status, detail) => ({ id, status, detail });

/** `null`/`undefined` measurement ⇒ unverified, with the reason the operator can act on. */
const unmeasured = (id, reason) => check(id, UNVERIFIED, `not measured: ${reason}`);

const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/i;

/**
 * Evaluate MEASURED facts. Pure: no I/O, no clock, no environment reads — everything it judges was
 * measured by {@link readActivationFacts} (or by a test's fixture) and handed in.
 *
 * @param {object} facts
 * @returns {{ status: string, checks: {id: string, status: string, detail: string}[], claims: object }}
 */
export function evaluateActivation(facts = {}) {
  const checks = [];

  // 1. The pinned identities, branches, internal hosts and variable REFERENCE shapes. Same rules as
  //    the pure validator — but only over a document whose provenance is recorded, because a
  //    hand-written topology file proves nothing about the platform.
  if (!facts.topology) checks.push(unmeasured("topology-identity", "no measured topology document was supplied"));
  else if (!facts.topology.measuredFrom) {
    checks.push(check("topology-identity", UNVERIFIED, "topology document records no provenance; a hand-written document is a claim"));
  } else {
    try {
      assertStagingTopology(facts.topology.document);
      checks.push(check("topology-identity", PASS, `pinned identities consistent (measured from ${facts.topology.measuredFrom})`));
    } catch (error) {
      checks.push(check("topology-identity", FAIL, String(error instanceof Error ? error.message : error)));
    }
  }

  // 2. Token scope, read BACK from the provider. This is the check that makes the rest meaningful:
  //    it proves each token can only see the environment it is supposed to, so a "staging" fact
  //    measured with a production-scoped token cannot masquerade as staging evidence.
  const tokens = facts.tokens ?? {};
  const sides = [["staging", tokens.staging], ["production", tokens.production]];
  const missingToken = sides.filter(([, scope]) => !scope).map(([side]) => side);
  if (missingToken.length) {
    checks.push(unmeasured("token-environment-scope", `no project-token read-back for ${missingToken.join(" and ")}`));
  } else {
    const errors = [];
    // A side with no pinned identity is an ABSENT COMPARISON, not a wrong one. Reporting it as a
    // failure would send an operator hunting a misconfiguration that does not exist — the missing
    // thing is the topology document, which has its own unverified check above.
    const uncomparable = [];
    for (const [side, scope] of sides) {
      const expected = facts.topology?.document?.[side];
      if (!expected) { uncomparable.push(side); continue; }
      if (scope.projectId !== expected.projectId) errors.push(`${side} token is scoped to a different project`);
      if (scope.environmentId !== expected.environmentId) errors.push(`${side} token is scoped to a different environment`);
    }
    // Distinct tokens for distinct environments: one token that sees both sides is not isolation,
    // whatever the pinned IDs say. This one needs no pinned identity to judge, so it is checked
    // even when the comparison above cannot run.
    if (tokens.staging.environmentId === tokens.production.environmentId) {
      errors.push("one token is scoped to both environments");
    }
    checks.push(errors.length
      ? check("token-environment-scope", FAIL, errors.join("; "))
      : uncomparable.length
        ? unmeasured("token-environment-scope", `no pinned identity to compare the ${uncomparable.join(" and ")} token against`)
        : check("token-environment-scope", PASS, "each project token reads back its own pinned project/environment"));
  }

  // 3/4. The two ops runners: an immutable pinned image and NO automatic deploy trigger. A runner
  //      that redeploys on a branch push is a moving target holding both databases' credentials.
  const runners = facts.runners ?? null;
  if (!runners || Object.keys(runners).length === 0) {
    checks.push(unmeasured("runner-image-pinned", "no serviceInstance read-back for the exporter/importer runners"));
    checks.push(unmeasured("runner-autodeploy-disabled", "no serviceInstance read-back for the exporter/importer runners"));
  } else {
    const imageErrors = [];
    const autoErrors = [];
    for (const [name, runner] of Object.entries(runners)) {
      if (!IMAGE_DIGEST.test(String(runner?.image ?? ""))) imageErrors.push(`${name} is not pinned to an immutable image digest`);
      if (runner?.repo) imageErrors.push(`${name} has a repository source`);
      if (runner?.autoDeploy == null) autoErrors.push(`${name} autodeploy status was not reported`);
      else if (runner.autoDeploy !== false) autoErrors.push(`${name} has automatic deployments enabled`);
    }
    checks.push(imageErrors.length ? check("runner-image-pinned", FAIL, imageErrors.join("; ")) : check("runner-image-pinned", PASS, "both runners are pinned to immutable image digests with no repository source"));
    checks.push(autoErrors.length ? check("runner-autodeploy-disabled", FAIL, autoErrors.join("; ")) : check("runner-autodeploy-disabled", PASS, "automatic deployments are disabled on both runners"));
  }

  // 5. The staging app's deployment, bound to the pinned instance, with a MEASURED domain. An
  //    absent domain is unverified — never a configured value standing in for it.
  const deployment = facts.appDeployment ?? null;
  const pinnedStaging = facts.topology?.document?.staging;
  if (!deployment) checks.push(unmeasured("app-deployment-measured", "no deployment read-back for the staging app service"));
  else if (!deployment.url) checks.push(check("app-deployment-measured", UNVERIFIED, "the provider reported no deployment domain; no configured value may stand in for it"));
  // Without the pinned identity there is nothing to bind the observation TO, and an unbound
  // deployment observation is exactly the M3 defect — a deployment ID does not identify a staging
  // deployment. Unverified, not a pass.
  else if (!pinnedStaging) checks.push(unmeasured("app-deployment-measured", "no pinned staging app identity to bind the observed deployment to"));
  else if (deployment.environmentId !== pinnedStaging.environmentId || deployment.serviceId !== pinnedStaging.appServiceId) {
    checks.push(check("app-deployment-measured", FAIL, "the observed deployment belongs to a different environment or service than the pinned staging app"));
  } else checks.push(check("app-deployment-measured", PASS, `staging app deployment ${deployment.id} measured at its own domain`));

  // 6/7. What the APP says about itself, over its own privileged health contract — the one place
  //      the app's runtime posture is observable without reading its variables.
  const health = facts.appHealth ?? null;
  if (!health) {
    checks.push(unmeasured("app-mode-declared", "the privileged staging health probe was not performed"));
    checks.push(unmeasured("app-no-model-spend", "the privileged staging health probe was not performed"));
  } else if (health.status === 401) {
    checks.push(check("app-mode-declared", FAIL, "the staging health token was rejected by the deployment"));
    checks.push(unmeasured("app-no-model-spend", "the health probe could not authenticate"));
  } else if (health.status !== 200 && health.status !== 202) {
    checks.push(check("app-mode-declared", FAIL, `the staging health probe answered ${health.status}`));
    checks.push(unmeasured("app-no-model-spend", "the health probe did not answer"));
  } else {
    const mode = health.body?.mode;
    checks.push(mode === "copy-ready" || mode === "legacy-pg-only"
      ? check("app-mode-declared", PASS, `the deployment declares mode ${mode}`)
      : check("app-mode-declared", FAIL, `the deployment declares no supported staging mode (${String(mode ?? "absent")})`));

    // The honest reading of the OPTIONAL budgeted interactive mode: `unsupported-budgeted-mode`
    // means an operator asked for it and did not get it. That is not a spend risk — no call is
    // made either way — but reporting it as a plain `disabled` would leave them believing their
    // configuration took effect, so it is surfaced as its own outcome.
    const answering = health.body?.answering;
    if (answering === undefined) checks.push(check("app-no-model-spend", UNVERIFIED, "the deployment reports no answering posture; it predates the field"));
    else if (answering === "disabled") checks.push(check("app-no-model-spend", PASS, "model-backed answering is disabled on the deployment"));
    else if (answering === "unsupported-budgeted-mode") {
      checks.push(check("app-no-model-spend", FAIL, "staging-budgeted-interactive-query-unsupported: the deployment is configured to opt into budgeted interactive answering, which this build does not implement — no budget is enforced anywhere, so the configuration authorises nothing and must be removed"));
    } else checks.push(check("app-no-model-spend", FAIL, `the deployment reports answering posture ${String(answering)}`));
  }

  // 8. The sidecar's provider credentials. NOT measurable by this build: it would need an
  //    environment-scoped variable read, which is provider surface this verifier deliberately does
  //    not carry. Named as a software gap, not quietly passed.
  checks.push(facts.graphitiProviderCredentials === undefined
    ? unmeasured("graphiti-no-provider-credentials", "this verifier performs no variable read; confirm the sidecar's provider variables during activation and record the evidence")
    : facts.graphitiProviderCredentials.length === 0
      ? check("graphiti-no-provider-credentials", PASS, "the sidecar holds no provider credential variables")
      : check("graphiti-no-provider-credentials", FAIL, `the sidecar holds provider credential variables: ${facts.graphitiProviderCredentials.join(", ")}`));

  // 9. Staging and production must not share a credential. Compared by HMAC fingerprint, so no
  //    value is read, transported or printed.
  const separation = facts.credentialFingerprints ?? null;
  if (!separation?.local || !separation?.remote) {
    checks.push(unmeasured("credential-separation", "no fingerprint document from the opposite environment to compare against"));
  } else {
    const shared = Object.keys(separation.local).filter((name) => fingerprintsEqual(separation.local[name], separation.remote[name]));
    checks.push(shared.length
      ? check("credential-separation", FAIL, `staging and production share credentials: ${shared.join(", ")}`)
      : check("credential-separation", PASS, `${Object.keys(separation.local).length} credential class(es) differ across environments`));
  }

  // 10. The schedules contract ships disabled. Activation flips it deliberately, elsewhere.
  checks.push(facts.schedules == null
    ? unmeasured("schedules-disabled", "the schedules contract was not read")
    : facts.schedules.activated === false
      ? check("schedules-disabled", PASS, "the schedule contract is disabled, as shipped")
      : check("schedules-disabled", FAIL, "the schedule contract declares itself activated"));

  const status = checks.some((c) => c.status === FAIL)
    ? ACTIVATION_STATUS.NOT_ACTIVATED
    : checks.some((c) => c.status === UNVERIFIED)
      ? ACTIVATION_STATUS.UNVERIFIED
      : ACTIVATION_STATUS.ACTIVATED;

  return { status, checks, claims: facts.operatorClaims ?? {} };
}

/**
 * Fail the caller unless activation is fully verified.
 *
 * `UNVERIFIED` refuses just as `NOT ACTIVATED` does — the difference is what the operator must do
 * next, not whether they may proceed.
 */
export function assertActivated(result) {
  if (result.status === ACTIVATION_STATUS.ACTIVATED) return result;
  const lines = result.checks.filter((c) => c.status !== PASS).map((c) => `- ${c.id} [${c.status}]: ${c.detail}`);
  throw new Error(`staging activation is ${result.status}:\n${lines.join("\n")}`);
}

// ── Measurement ────────────────────────────────────────────────────────────────────────────────

async function railwayQuery({ document, variables, token, fetchImpl, apiUrl = "https://backboard.railway.com/graphql/v2" }) {
  assertReadOnlyDocument(document);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  // The status and the operation name are safe to report; the body may echo configuration, so it
  // never reaches the message.
  if (!response.ok || body?.errors?.length) throw new Error(`activation read failed (${response.status})`);
  return body?.data ?? null;
}

/** One measurement that may legitimately be unavailable: absence becomes `null`, never a throw. */
async function measure(label, read, notes) {
  try { return await read(); }
  catch (error) { notes.push(`${label}: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`); return null; }
}

/**
 * Acquire the facts, read-only. Every measurement is independently optional: a missing credential
 * yields `null` for that fact and an `UNVERIFIED` check, which is the whole point — a verifier that
 * throws on the first missing input reports nothing about the rest.
 */
export async function readActivationFacts(env = process.env, { fetchImpl = fetch } = {}) {
  const notes = [];
  const topologyFile = env.STAGING_TOPOLOGY_FILE;
  const topology = topologyFile
    ? await measure("topology", async () => ({
        document: JSON.parse(readFileSync(topologyFile, "utf8")),
        // Provenance is required by the evaluator: a document with no recorded measurement is a
        // claim, and this field is where that distinction is kept honest.
        measuredFrom: env.STAGING_TOPOLOGY_MEASURED_FROM ?? null,
      }), notes)
    : null;

  const token = (side) => (side === "staging" ? env.RAILWAY_STAGING_READ_TOKEN : env.RAILWAY_PRODUCTION_READ_TOKEN);
  const tokens = {};
  for (const side of ["staging", "production"]) {
    tokens[side] = token(side)
      ? await measure(`${side} project token`, async () => {
          const data = await railwayQuery({ document: ACTIVATION_DOCUMENTS.projectToken, variables: {}, token: token(side), fetchImpl });
          return data?.projectToken ?? null;
        }, notes)
      : null;
    if (!token(side)) notes.push(`${side} project token: no read token supplied`);
  }

  const runnerSpecs = [
    ["exporter", "production", env.PRODUCTION_EXPORTER_SERVICE_ID, topology?.document?.production],
    ["importer", "staging", env.STAGING_IMPORTER_SERVICE_ID, topology?.document?.staging],
  ];
  const runners = {};
  for (const [name, side, serviceId, pinned] of runnerSpecs) {
    if (!serviceId || !pinned?.projectId || !pinned?.environmentId || !token(side)) {
      notes.push(`${name} runner: pinned service/environment identity or read token missing`);
      continue;
    }
    const measured = await measure(`${name} runner`, async () => {
      const data = await railwayQuery({
        document: ACTIVATION_DOCUMENTS.serviceInstance,
        variables: { projectId: pinned.projectId, environmentId: pinned.environmentId, serviceId },
        token: token(side), fetchImpl,
      });
      return {
        image: data?.serviceInstance?.source?.image ?? null,
        repo: data?.serviceInstance?.source?.repo ?? null,
        autoDeploy: data?.serviceInstanceAutoDeployStatus?.enabled ?? null,
      };
    }, notes);
    if (measured) runners[name] = measured;
  }

  const stagingPin = topology?.document?.staging;
  const appDeployment = stagingPin?.appServiceId && token("staging")
    ? await measure("staging app deployment", async () => {
        const data = await railwayQuery({
          document: ACTIVATION_DOCUMENTS.deployments,
          variables: { environmentId: stagingPin.environmentId, serviceId: stagingPin.appServiceId },
          token: token("staging"), fetchImpl,
        });
        const node = data?.deployments?.edges?.[0]?.node;
        if (!node?.id) return null;
        const raw = String(node.staticUrl ?? "").trim();
        return {
          id: node.id, status: node.status, environmentId: node.environmentId, serviceId: node.serviceId,
          // Bare hostname → https origin. Absent stays absent: see `app-deployment-measured`.
          url: raw && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw) ? `https://${raw.toLowerCase()}` : null,
        };
      }, notes)
    : null;

  const appHealth = env.STAGING_ORIGIN && env.STAGING_HEALTH_TOKEN
    ? await measure("staging health", async () => {
        const response = await fetchImpl(new URL("/api/health", env.STAGING_ORIGIN), {
          redirect: "manual",
          headers: { "x-aios-staging-health-token": env.STAGING_HEALTH_TOKEN },
          signal: AbortSignal.timeout(15_000),
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      }, notes)
    : null;
  if (!env.STAGING_ORIGIN || !env.STAGING_HEALTH_TOKEN) notes.push("staging health: origin or token not supplied");

  let credentialFingerprints = null;
  if (env.STAGING_COMPARISON_KEY_BASE64 && env.STAGING_COMPARISON_KEY_ID && env.OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE) {
    credentialFingerprints = await measure("credential separation", async () => {
      const comparisonKey = Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64");
      const local = Object.fromEntries([
        ["auth-secret", env.AUTH_SECRET], ["secrets-key", env.SECRETS_KEY],
        ["neo4j-credential", `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`],
      ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: env.STAGING_COMPARISON_KEY_ID })]));
      return { local, remote: JSON.parse(readFileSync(env.OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE, "utf8")) };
    }, notes);
  } else notes.push("credential separation: comparison key or opposite-environment fingerprint document not supplied");

  const schedules = env.STAGING_SCHEDULES_FILE
    ? await measure("schedules", async () => JSON.parse(readFileSync(env.STAGING_SCHEDULES_FILE, "utf8")), notes)
    : null;
  if (!env.STAGING_SCHEDULES_FILE) notes.push("schedules: contract file not supplied");

  // RECORDED, never evidence. An operator asserting a thing is a fact about the operator.
  const operatorClaims = Object.fromEntries(
    Object.keys(env).filter((name) => name.startsWith("ACTIVATION_CLAIM_")).map((name) => [name, "claimed (not evidence)"])
  );

  return { topology, tokens, runners, appDeployment, appHealth, credentialFingerprints, schedules, operatorClaims, notes };
}

/** Human-readable, redacted. No variable values, no tokens, no connection strings. */
export function formatActivationReport(result, notes = []) {
  const lines = [`staging activation: ${result.status}`];
  for (const c of result.checks) lines.push(`  [${c.status.toUpperCase().padEnd(10)}] ${c.id} — ${c.detail}`);
  if (Object.keys(result.claims).length) {
    lines.push("  operator claims recorded (NOT evidence): " + Object.keys(result.claims).join(", "));
  }
  if (notes.length) lines.push(...notes.map((note) => `  note: ${note}`));
  return lines.join("\n");
}

export async function runActivationPreflight(env = process.env, options = {}) {
  const facts = await readActivationFacts(env, options);
  const result = evaluateActivation(facts);
  return { ...result, notes: facts.notes, report: formatActivationReport(result, facts.notes) };
}
