#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";
import { candidateValidationVerdict } from "./release-policy.mjs";
import { releaseCandidateVerdict } from "../release-candidate-guard.mjs";
import { REQUIRED_MAIN_CONTEXTS } from "./main-policy.mjs";

const PREVALIDATION_CONTEXTS = REQUIRED_MAIN_CONTEXTS.filter((name) => name !== "Staging candidate validation");

export function emergencyVerdict({ incidentUrl, reason, authorizedBy, mainIsAncestor }) {
  const errors = [];
  try {
    const url = new URL(String(incidentUrl ?? ""));
    if (url.protocol !== "https:") errors.push("incident URL must use https");
  } catch {
    errors.push("incident or issue URL is required");
  }
  if (String(reason ?? "").trim().length < 12) errors.push("a concrete emergency reason is required");
  if (!String(authorizedBy ?? "").trim()) errors.push("human authorization identity is required");
  if (mainIsAncestor !== true) errors.push("emergency update must be a non-force descendant of main");
  return { ok: errors.length === 0, errors };
}

export async function publishCandidateCheck({ request, repository, candidateSha, dispatchSha, conclusion, summary }) {
  if (!candidateSha || candidateSha === dispatchSha) {
    // Equality is not universally invalid (dispatching immediately at the candidate is legitimate),
    // so only absence is refused. The explicit body binding below is the actual invariant.
    if (!candidateSha) throw new Error("candidate SHA is required for validation check publication");
  }
  return request("POST", `/repos/${repository}/check-runs`, {
    name: "Staging candidate validation",
    head_sha: candidateSha,
    status: "completed",
    conclusion,
    output: { title: "Staging candidate validation", summary },
  });
}

export function createApiClient({ token, baseUrl = "https://api.github.com", fetchImpl = fetch }) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${parsed?.message ?? "redacted response"}`);
    return parsed;
  };
}

export async function createInstallationToken({ appId, installationId, privateKey, fetchImpl = fetch }) {
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(String(appId))
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
  const api = createApiClient({ token: jwt, fetchImpl });
  const result = await api("POST", `/app/installations/${installationId}/access_tokens`, {});
  if (!result?.token) throw new Error("GitHub App token exchange returned no token");
  return result.token;
}

export async function probePinnedHealth({ origin, token, fetchImpl = fetch }) {
  const base = new URL(origin);
  const url = new URL("/api/health", base);
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: { "x-aios-staging-health-token": token },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("staging health redirected; off-origin redirects are refused");
  if (response.url && new URL(response.url).origin !== base.origin) throw new Error("staging health final origin changed");
  const body = await response.json().catch(() => ({}));
  return { ...body, status: response.status, origin: base.origin, finalOrigin: response.url ? new URL(response.url).origin : base.origin };
}

export const RAILWAY_DEPLOYMENT_QUERY = `query StagingCandidateDeployment($id: String!) {
  deployment(id: $id) { id status staticUrl meta }
}`;

export async function readRailwayDeployment({ deploymentId, token, fetchImpl = fetch }) {
  const response = await fetchImpl("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: RAILWAY_DEPLOYMENT_QUERY, variables: { id: deploymentId } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Railway deployment read failed (${response.status})`);
  const d = body.data?.deployment;
  if (!d || d.id !== deploymentId) throw new Error("Railway returned an unknown deployment");
  return { id: d.id, status: d.status, url: d.staticUrl ?? null, commitSha: d.meta?.commitHash ?? d.meta?.repoCommit ?? null };
}

export const RAILWAY_PRODUCTION_DEPLOYMENTS_QUERY = `query ProductionDeployments($environmentId: String!, $serviceId: String!) {
  deployments(first: 10, input: { environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { id status staticUrl meta } }
  }
}`;

export async function readLatestProductionDeployment({ environmentId, serviceId, token, fetchImpl = fetch }) {
  const response = await fetchImpl("https://backboard.railway.com/graphql/v2", {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: RAILWAY_PRODUCTION_DEPLOYMENTS_QUERY, variables: { environmentId, serviceId } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Railway production deployment read failed (${response.status})`);
  const node = body.data?.deployments?.edges?.[0]?.node;
  if (!node?.id) return null;
  return { id: node.id, status: node.status, url: node.staticUrl ?? null, commitSha: node.meta?.commitHash ?? node.meta?.repoCommit ?? null };
}

export async function observeProductionDeployment({ expectedSha, readLatest, probeHealth, timeoutMs = 10 * 60_000, intervalMs = 5_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() <= deadline) {
    last = await readLatest();
    if (last?.commitSha === expectedSha && last.status === "SUCCESS") {
      const health = await probeHealth(last);
      if (health?.status === 200 && health?.ok === true && health?.commit === expectedSha) return { status: "verified", deployment: last, health };
      if (health?.status >= 400) return { status: "promoted-but-deployment-failed", deployment: last, health };
    }
    if (last?.commitSha === expectedSha && new Set(["FAILED", "CRASHED", "REMOVED"]).has(last.status)) {
      return { status: "promoted-but-deployment-failed", deployment: last };
    }
    if (now() < deadline) await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return { status: "promoted-but-deployment-unverified", deployment: last };
}

function decodePackageVersion(file) {
  if (!file?.content || file.encoding !== "base64") return null;
  try {
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version ?? null;
  } catch {
    return null;
  }
}

function compareProvesAncestor(comparison) {
  return comparison?.status === "ahead" || comparison?.status === "identical";
}

/** Measure every release fact from provider APIs without checking out or executing candidate code. */
export async function measureCandidate({
  githubRequest,
  railwayRead,
  healthProbe,
  repository,
  tagName,
  deploymentId,
  requestedMode,
  notes,
  copyModeActivated,
  producerIds,
}) {
  const encodedTag = encodeURIComponent(tagName);
  const firstRef = await githubRequest("GET", `/repos/${repository}/git/ref/tags/${encodedTag}`);
  if (firstRef?.object?.type !== "tag") throw new Error("release tag is not annotated");
  const tagObject = await githubRequest("GET", `/repos/${repository}/git/tags/${firstRef.object.sha}`);
  if (tagObject?.object?.type !== "commit" || !tagObject.object.sha) throw new Error("annotated tag does not point to a commit");
  const commitSha = tagObject.object.sha;

  const [pkg, mainCompare, stagingCompare, checks, deployment, health] = await Promise.all([
    githubRequest("GET", `/repos/${repository}/contents/package.json?ref=${commitSha}`),
    githubRequest("GET", `/repos/${repository}/compare/main...${commitSha}`),
    githubRequest("GET", `/repos/${repository}/compare/${commitSha}...staging`),
    githubRequest("GET", `/repos/${repository}/commits/${commitSha}/check-runs?per_page=100`),
    railwayRead(deploymentId),
    healthProbe(),
  ]);

  const successful = [];
  const producerErrors = [];
  for (const context of PREVALIDATION_CONTEXTS) {
    const runs = (checks?.check_runs ?? []).filter((run) => run.name === context);
    const good = runs.find((run) => run.status === "completed" && run.conclusion === "success");
    const expectedProducer = Number(producerIds?.[context]);
    if (!Number.isInteger(expectedProducer) || expectedProducer <= 0) {
      producerErrors.push(`missing producer integration ID for ${context}`);
    } else if (good && Number(good.app?.id) !== expectedProducer) {
      producerErrors.push(`${context} succeeded from integration ${good.app?.id ?? "unknown"}, expected ${expectedProducer}`);
    } else if (good) {
      successful.push(context);
    }
  }

  const existing = releaseCandidateVerdict({
    tagName,
    tagObjectType: firstRef.object.type,
    taggedTreeVersion: decodePackageVersion(pkg),
    mainIsAncestor: compareProvesAncestor(mainCompare),
    reachableFromIntegration: compareProvesAncestor(stagingCompare),
  });

  const finalRef = await githubRequest("GET", `/repos/${repository}/git/ref/tags/${encodedTag}`);
  const origin = new URL(health.origin);
  const deploymentOrigin = deployment.url ? new URL(deployment.url).origin : origin.origin;
  const facts = {
    tagName,
    tagObjectType: firstRef.object.type,
    eventTagObjectSha: firstRef.object.sha,
    resolvedTagObjectSha: finalRef?.object?.sha,
    commitSha,
    expectedMain: mainCompare?.base_commit?.sha ?? null,
    tagCommitSha: tagObject.object.sha,
    requiredChecks: PREVALIDATION_CONTEXTS,
    successfulChecks: successful,
    deploymentId: deployment.id,
    deploymentCommitSha: deployment.commitSha,
    deploymentStatus: deployment.status,
    healthOrigin: origin.origin,
    healthFinalOrigin: health.finalOrigin,
    healthCommitSha: health.commit,
    healthMode: health.mode,
    healthRunId: health.refreshRunId ?? null,
    healthOk: health.status === 200 && health.ok === true && deploymentOrigin === origin.origin,
    requestedMode,
    copyModeActivated,
    notes,
  };
  const policy = candidateValidationVerdict(facts);
  return {
    facts,
    verdict: {
      ok: existing.verdict === "PASS" && producerErrors.length === 0 && policy.ok,
      errors: [...existing.failures, ...producerErrors, ...policy.errors],
      mode: policy.verdict,
    },
  };
}

export async function updateMainNonForce({ request, repository, expectedMain, candidateSha }) {
  const ref = await request("GET", `/repos/${repository}/git/ref/heads/main`);
  const actual = ref?.object?.sha;
  if (!actual) throw new Error("main ref lookup returned no SHA");
  if (actual !== expectedMain) throw new Error(`main advanced after validation: expected ${expectedMain}, observed ${actual}`);
  if (actual === candidateSha) return { status: "already-promoted", sha: candidateSha };
  const compare = await request("GET", `/repos/${repository}/compare/${actual}...${candidateSha}`);
  if (!compareProvesAncestor(compare)) throw new Error("candidate is not a fast-forward of current main");
  await request("PATCH", `/repos/${repository}/git/refs/heads/main`, { sha: candidateSha, force: false });
  return { status: "promoted", sha: candidateSha };
}

/** Audit files contain identities and verdicts only; tokens and provider response bodies never enter. */
export function writeAudit(path, audit) {
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
}

// The workflow is the supported entrypoint. The shell intentionally refuses an incomplete local
// invocation instead of discovering ambient credentials or guessing deployment identity.
async function main() {
  const action = process.env.RELEASE_ACTION;
  if (!['validate', 'promote', 'emergency'].includes(action)) throw new Error("RELEASE_ACTION must be validate, promote, or emergency");
  const required = ["GITHUB_REPOSITORY", "GITHUB_SHA", "RELEASE_AUDIT_PATH"];
  for (const name of required) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

  const readToken = process.env.GITHUB_TOKEN;
  if (!readToken) throw new Error("read-only GITHUB_TOKEN is required");
  const githubRead = createApiClient({ token: readToken });
  let facts;
  let authorization;
  if (action === "emergency") {
    const target = process.env.RELEASE_EMERGENCY_SHA;
    if (!/^[0-9a-f]{40}$/i.test(String(target))) throw new Error("RELEASE_EMERGENCY_SHA must be a full commit SHA");
    const mainRef = await githubRead("GET", `/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`);
    const comparison = await githubRead("GET", `/repos/${process.env.GITHUB_REPOSITORY}/compare/${mainRef.object.sha}...${target}`);
    facts = {
      incidentUrl: process.env.RELEASE_INCIDENT_URL,
      reason: process.env.RELEASE_NOTES,
      authorizedBy: process.env.GITHUB_ACTOR,
      mainIsAncestor: compareProvesAncestor(comparison),
      commitSha: target,
      expectedMain: mainRef.object.sha,
      notes: process.env.RELEASE_NOTES,
    };
    authorization = emergencyVerdict(facts);
  } else {
    const producerIds = JSON.parse(process.env.RELEASE_PRODUCER_IDS_JSON ?? "{}");
    const measured = await measureCandidate({
      githubRequest: githubRead,
      railwayRead: (id) => readRailwayDeployment({ deploymentId: id, token: process.env.RAILWAY_STAGING_READ_TOKEN }),
      healthProbe: () => probePinnedHealth({ origin: process.env.STAGING_ORIGIN, token: process.env.STAGING_HEALTH_TOKEN }),
      repository: process.env.GITHUB_REPOSITORY,
      tagName: process.env.RELEASE_TAG,
      deploymentId: process.env.RELEASE_DEPLOYMENT_ID,
      requestedMode: process.env.RELEASE_MODE,
      notes: process.env.RELEASE_NOTES,
      copyModeActivated: process.env.STAGING_COPY_MODE_ACTIVATED === "true",
      producerIds,
    });
    facts = measured.facts;
    authorization = measured.verdict;
  }
  const audit = {
    version: 1,
    action,
    actor: process.env.GITHUB_ACTOR ?? "unknown",
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    dispatchSha: process.env.GITHUB_SHA,
    attemptedAt: new Date().toISOString(),
    facts: {
      tagName: facts.tagName,
      tagObjectSha: facts.resolvedTagObjectSha,
      commitSha: facts.commitSha,
      deploymentId: facts.deploymentId,
      deploymentUrl: facts.healthOrigin,
      mode: facts.requestedMode,
      refreshRunId: facts.healthRunId ?? null,
      notes: facts.notes,
    },
  };
  writeAudit(process.env.RELEASE_AUDIT_PATH, { ...audit, verdict: authorization.ok ? "authorized" : "refused", errors: authorization.errors });
  if (!authorization.ok) throw new Error(authorization.errors.join("; "));

  const emergency = action === "emergency";
  const token = await createInstallationToken({
    appId: process.env[emergency ? "EMERGENCY_APP_ID" : "RELEASE_APP_ID"],
    installationId: process.env[emergency ? "EMERGENCY_APP_INSTALLATION_ID" : "RELEASE_APP_INSTALLATION_ID"],
    privateKey: process.env[emergency ? "EMERGENCY_APP_PRIVATE_KEY" : "RELEASE_APP_PRIVATE_KEY"],
  });
  const appRequest = createApiClient({ token });
  let mutation = { status: "validated", sha: facts.commitSha };
  if (!emergency) {
    await publishCandidateCheck({
      request: appRequest,
      repository: process.env.GITHUB_REPOSITORY,
      candidateSha: facts.commitSha,
      dispatchSha: process.env.GITHUB_SHA,
      conclusion: "success",
      summary: `Validated ${facts.tagName} on deployment ${facts.deploymentId} in ${facts.requestedMode} mode; refresh ${facts.healthRunId ?? "not performed (legacy)"}.`,
    });
  }
  if (action === "promote" || action === "emergency") {
    const expectedMain = facts.expectedMain;
    if (!expectedMain) throw new Error("validated expected main SHA is missing; refusing a fresh-main substitution");
    mutation = await updateMainNonForce({ request: appRequest, repository: process.env.GITHUB_REPOSITORY, expectedMain, candidateSha: facts.commitSha });
    if (mutation.status === "promoted" && !emergency) {
      mutation.production = await observeProductionDeployment({
        expectedSha: facts.commitSha,
        readLatest: () => readLatestProductionDeployment({
          environmentId: process.env.RAILWAY_PRODUCTION_ENVIRONMENT_ID,
          serviceId: process.env.RAILWAY_PRODUCTION_APP_SERVICE_ID,
          token: process.env.RAILWAY_PRODUCTION_READ_TOKEN,
        }),
        probeHealth: (deployment) => probePinnedHealth({ origin: deployment.url ?? process.env.PRODUCTION_ORIGIN, token: process.env.PRODUCTION_HEALTH_TOKEN }),
        timeoutMs: Number(process.env.PRODUCTION_DEPLOY_TIMEOUT_MS ?? 600_000),
      });
      if (mutation.production.status !== "verified") {
        writeAudit(process.env.RELEASE_AUDIT_PATH, { ...audit, verdict: mutation.production.status, errors: [], result: mutation, completedAt: new Date().toISOString() });
        throw new Error(mutation.production.status);
      }
    }
  }
  writeAudit(process.env.RELEASE_AUDIT_PATH, { ...audit, verdict: "completed", errors: [], result: mutation, completedAt: new Date().toISOString() });
}

if (process.argv.includes("--run")) {
  main().catch((error) => {
    console.error(`release controller refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
