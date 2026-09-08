#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";
import { candidateValidationVerdict } from "./release-policy.mjs";
import { releaseCandidateVerdict } from "../release-candidate-verdict.mjs";
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

export function createApiClient({ token, baseUrl = "https://api.github.com", fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("GitHub API timeout must be an integer between 1 and 60000ms");
  }
  return async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Railway's `staticUrl` is a BARE HOSTNAME (`aios-staging.up.railway.app`), not a URL, so
 * `new URL(staticUrl)` throws. Normalise to an https origin, and refuse anything that is not a
 * plain host — a value carrying a scheme, credentials, a port or a path is not the deployment
 * domain this evidence is supposed to bind.
 */
export function normalizeDeploymentOrigin(staticUrl) {
  const raw = String(staticUrl ?? "").trim();
  if (!raw) return null;
  if (/^https:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return url.username || url.password || (url.pathname !== "/" && url.pathname !== "") ? null : url.origin;
    } catch { return null; }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw)) return null;
  return `https://${raw.toLowerCase()}`;
}

/**
 * The PRIVILEGED staging health contract: the staging-only token header authorises the bounded
 * internal checks and the mode/run identity the candidate verdict binds to.
 */
export async function probePinnedHealth({ origin, token, fetchImpl = fetch }) {
  if (!token || typeof token !== "string" || !token.trim()) {
    // Without this, an unset variable is stringified into the header as the literal "undefined",
    // which the app reads as a PRESENTED token and answers 401 — a configuration mistake wearing
    // the costume of an authentication failure.
    throw new Error("a staging health token is required for the privileged staging health probe");
  }
  return probeHealthOrigin({ origin, headers: { "x-aios-staging-health-token": token }, fetchImpl, label: "staging" });
}

/**
 * The PRODUCTION health contract is a DIFFERENT contract: the ordinary unauthenticated endpoint,
 * which answers 200 `{ ok, commit }` after its bounded Postgres probe.
 *
 * Production has no `STAGING_HEALTH_TOKEN` — it is a staging environment secret — so sending a
 * staging-shaped header there cannot authenticate anything. It can only turn a healthy production
 * deployment into a 401 and, through it, report a good release as
 * `promoted-but-deployment-failed`.
 */
export async function probeProductionHealth({ origin, fetchImpl = fetch }) {
  return probeHealthOrigin({ origin, headers: {}, fetchImpl, label: "production" });
}

async function probeHealthOrigin({ origin, headers, fetchImpl, label }) {
  const base = new URL(origin);
  const url = new URL("/api/health", base);
  const response = await fetchImpl(url, { redirect: "manual", headers, signal: AbortSignal.timeout(10_000) });
  if (response.status >= 300 && response.status < 400) throw new Error(`${label} health redirected; off-origin redirects are refused`);
  if (response.url && new URL(response.url).origin !== base.origin) throw new Error(`${label} health final origin changed`);
  const body = await response.json().catch(() => ({}));
  return { ...body, status: response.status, origin: base.origin, finalOrigin: response.url ? new URL(response.url).origin : base.origin };
}

export const RAILWAY_DEPLOYMENT_QUERY = `query StagingCandidateDeployment($id: String!) {
  deployment(id: $id) { id status staticUrl environmentId serviceId meta }
}`;

/**
 * M3: a deployment ID alone does not identify a STAGING deployment. Without asserting the
 * environment and service, a deployment of some other service that happens to carry the same commit
 * satisfies "Railway reports a successful deployment of this commit" — which is precisely the
 * binding AC-02 exists to make.
 */
/**
 * M2: `Project-Access-Token`, not `Authorization: Bearer`.
 *
 * `token` here is `RAILWAY_STAGING_READ_TOKEN`, which `config/staging-ops/importer.example.env`
 * documents as an ENVIRONMENT-SCOPED PROJECT token — the same kind `RailwayMaintenance` and
 * `activation-preflight` use, and both authenticate it with this header. A project token presented
 * as a Bearer account credential fails to authenticate, and the resulting error reads as "the
 * platform is configured differently than you think" rather than "this client sent the wrong
 * header". `readLatestProductionDeployment` below is deliberately NOT changed: it consumes the
 * distinct `RAILWAY_PRODUCTION_READ_TOKEN`, whose kind is separately documented, and changing its
 * authentication without defining that secret's contract would be a guess.
 */
export async function readRailwayDeployment({ deploymentId, token, environmentId, serviceId, fetchImpl = fetch }) {
  if (!environmentId || !serviceId) throw new Error("pinned staging environment and service IDs are required to bind candidate deployment evidence");
  const response = await fetchImpl("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    redirect: "error",
    headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: RAILWAY_DEPLOYMENT_QUERY, variables: { id: deploymentId } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Railway deployment read failed (${response.status})`);
  const d = body.data?.deployment;
  if (!d || d.id !== deploymentId) throw new Error("Railway returned an unknown deployment");
  if (d.environmentId !== environmentId) throw new Error("candidate deployment belongs to a different Railway environment");
  if (d.serviceId !== serviceId) throw new Error("candidate deployment belongs to a different Railway service");
  return { id: d.id, status: d.status, url: normalizeDeploymentOrigin(d.staticUrl), commitSha: d.meta?.commitHash ?? d.meta?.repoCommit ?? null };
}

export const RAILWAY_PRODUCTION_DEPLOYMENTS_QUERY = `query ProductionDeployments($environmentId: String!, $serviceId: String!) {
  deployments(first: 10, input: { environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { id status staticUrl environmentId serviceId meta } }
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
  // Same binding as the candidate read: an observation is about THIS service in THIS environment.
  if (node.environmentId !== environmentId || node.serviceId !== serviceId) throw new Error("Railway returned a production deployment outside the pinned environment/service");
  return { id: node.id, status: node.status, url: normalizeDeploymentOrigin(node.staticUrl), commitSha: node.meta?.commitHash ?? node.meta?.repoCommit ?? null };
}

export async function observeProductionDeployment({ expectedSha, readLatest, probeHealth, timeoutMs = 10 * 60_000, intervalMs = 5_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60 * 60_000) throw new Error("production deployment observation timeout must be 0..3600000ms");
  const deadline = now() + timeoutMs;
  let last = null;
  let observationError = null;
  for (;;) {
    try {
      last = await readLatest();
      observationError = null;
    } catch (error) {
      // Main may already have advanced. A Railway read failure is therefore an observation gap,
      // never a generic refusal and never a reason to retry the push.
      observationError = error instanceof Error ? error.message : String(error);
      const current = now();
      if (current >= deadline) break;
      await sleep(Math.min(intervalMs, Math.max(0, deadline - current)));
      continue;
    }
    if (last?.commitSha === expectedSha && last.status === "SUCCESS") {
      // A probe that cannot be performed at all (no verifiable domain, transport refusal) is
      // reported as UNVERIFIED, not as a failed deployment and never as a reason to touch main.
      const health = await Promise.resolve(probeHealth(last)).catch((error) => ({ status: 0, error: error instanceof Error ? error.message : String(error) }));
      if (health?.status === 200 && health?.ok === true && health?.commit === expectedSha) return { status: "verified", deployment: last, health };
      if (health?.status === 0) return { status: "promoted-but-deployment-unverified", deployment: last, health };
      if (health?.status >= 400) return { status: "promoted-but-deployment-failed", deployment: last, health };
    }
    if (last?.commitSha === expectedSha && new Set(["FAILED", "CRASHED", "REMOVED"]).has(last.status)) {
      return { status: "promoted-but-deployment-failed", deployment: last };
    }
    const current = now();
    if (current >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - current)));
  }
  return { status: "promoted-but-deployment-unverified", deployment: last, observationError };
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

  const [pkg, mainCompare, stagingCompare, checks, deployment] = await Promise.all([
    githubRequest("GET", `/repos/${repository}/contents/package.json?ref=${commitSha}`),
    githubRequest("GET", `/repos/${repository}/compare/main...${commitSha}`),
    githubRequest("GET", `/repos/${repository}/compare/${commitSha}...staging`),
    githubRequest("GET", `/repos/${repository}/commits/${commitSha}/check-runs?per_page=100`),
    railwayRead(deploymentId),
  ]);

  // BIND FIRST, THEN AUTHENTICATE. The health probe carries the privileged staging token, so the
  // domain it is sent to has to be the one Railway reports for the pinned environment/service —
  // measured here, before the request exists. It used to sit in the `Promise.all` above alongside
  // the deployment read, which meant the token went to whatever origin the environment claimed and
  // the binding was checked afterwards: too late to be a control, since the credential had already
  // been presented to an unbound host. `probeHealth` is therefore CALLED WITH the measured origin
  // rather than reading a configured one.
  const deploymentOrigin = deployment.url;
  if (!deploymentOrigin) {
    throw new Error("Railway reported no deployment domain for the candidate; the promotion evidence is UNMEASURED and cannot be substituted by a configured value");
  }
  const health = await healthProbe(deploymentOrigin);
  if (health?.origin && health.origin !== deploymentOrigin) {
    // A probe implementation that ignored its bound argument would otherwise degrade to a `healthOk:
    // false` verdict, which reads as "staging is unhealthy" rather than "this evidence is about a
    // different host".
    throw new Error(`staging health was probed at ${health.origin}, which is not the measured deployment domain ${deploymentOrigin}`);
  }

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
  // M3: an ABSENT deployment domain is not evidence that the deployment serves the origin we
  // probed. Substituting the supplied origin turned this check into self-attestation — the probe
  // proving the value we already told it. Absent means either an independently verified domain
  // (supplied and matching) or a refusal.
  // ...and an operator-configured repository variable is not that verification either. The
  // `STAGING_VERIFIED_DOMAIN` fallback was named "independently verified" but was a value someone
  // typed into `vars.*`: it proves the operator's belief, not the deployment's domain, and it sat
  // on the ONE path where the substitution's whole purpose was to avoid trusting an unmeasured
  // origin. An absent domain is now UNMEASURED, and unmeasured refuses — above, before the probe.
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
  try {
    await request("PATCH", `/repos/${repository}/git/refs/heads/main`, { sha: candidateSha, force: false });
    return { status: "promoted", sha: candidateSha, confirmation: "patch-response" };
  } catch (error) {
    // The request may have reached GitHub even when its response did not reach us. Re-read once;
    // never issue a second PATCH against an ambiguous outcome.
    const detail = error instanceof Error ? error.message : String(error);
    try {
      const observed = await request("GET", `/repos/${repository}/git/ref/heads/main`);
      const observedSha = observed?.object?.sha ?? null;
      if (observedSha === candidateSha) {
        return { status: "promoted", sha: candidateSha, confirmation: "read-back-after-ambiguous-patch", patchError: detail.slice(0, 200) };
      }
      return { status: "promotion-outcome-ambiguous", sha: null, expectedSha: candidateSha, observedMain: observedSha, patchError: detail.slice(0, 200) };
    } catch (readError) {
      return {
        status: "promotion-outcome-ambiguous", sha: null, expectedSha: candidateSha, observedMain: null,
        patchError: detail.slice(0, 200), readBackError: String(readError instanceof Error ? readError.message : readError).slice(0, 200),
      };
    }
  }
}

/** Audit files contain identities and verdicts only; tokens and provider response bodies never enter. */
export function writeAudit(path, audit) {
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
}

// The workflow is the supported entrypoint. The shell intentionally refuses an incomplete local
// invocation instead of discovering ambient credentials or guessing deployment identity.
export async function runReleaseController(env = process.env, operations = {}) {
  const action = env.RELEASE_ACTION;
  if (!['validate', 'promote', 'emergency'].includes(action)) throw new Error("RELEASE_ACTION must be validate, promote, or emergency");
  const required = ["GITHUB_REPOSITORY", "GITHUB_SHA", "RELEASE_AUDIT_PATH"];
  for (const name of required) if (!env[name]?.trim()) throw new Error(`${name} is required`);

  const readToken = env.GITHUB_TOKEN;
  if (!readToken) throw new Error("read-only GITHUB_TOKEN is required");
  const makeApiClient = operations.createApiClient ?? createApiClient;
  const githubRead = operations.githubRead ?? makeApiClient({ token: readToken });
  let facts;
  let authorization;
  if (action === "emergency") {
    const target = env.RELEASE_EMERGENCY_SHA;
    if (!/^[0-9a-f]{40}$/i.test(String(target))) throw new Error("RELEASE_EMERGENCY_SHA must be a full commit SHA");
    const mainRef = await githubRead("GET", `/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`);
    const comparison = await githubRead("GET", `/repos/${env.GITHUB_REPOSITORY}/compare/${mainRef.object.sha}...${target}`);
    facts = {
      incidentUrl: env.RELEASE_INCIDENT_URL,
      reason: env.RELEASE_NOTES,
      authorizedBy: env.GITHUB_ACTOR,
      mainIsAncestor: compareProvesAncestor(comparison),
      commitSha: target,
      expectedMain: mainRef.object.sha,
      notes: env.RELEASE_NOTES,
    };
    authorization = emergencyVerdict(facts);
  } else {
    const producerIds = JSON.parse(env.RELEASE_PRODUCER_IDS_JSON ?? "{}");
    const measured = await (operations.measureCandidate ?? measureCandidate)({
      githubRequest: githubRead,
      railwayRead: (id) => readRailwayDeployment({
        deploymentId: id,
        token: env.RAILWAY_STAGING_READ_TOKEN,
        environmentId: env.RAILWAY_STAGING_ENVIRONMENT_ID,
        serviceId: env.RAILWAY_STAGING_APP_SERVICE_ID,
      }),
      // Bound to the MEASURED deployment domain. A configured `STAGING_ORIGIN` is an operator's
      // assertion, so it may only agree or refuse — never redirect the token somewhere else.
      healthProbe: (boundOrigin) => {
        const configured = normalizeDeploymentOrigin(env.STAGING_ORIGIN);
        if (configured && configured !== boundOrigin) {
          throw new Error(`configured STAGING_ORIGIN ${configured} is not the measured deployment domain ${boundOrigin}; refusing to present the staging health token`);
        }
        return probePinnedHealth({ origin: boundOrigin, token: env.STAGING_HEALTH_TOKEN });
      },
      repository: env.GITHUB_REPOSITORY,
      tagName: env.RELEASE_TAG,
      deploymentId: env.RELEASE_DEPLOYMENT_ID,
      requestedMode: env.RELEASE_MODE,
      notes: env.RELEASE_NOTES,
      copyModeActivated: env.STAGING_COPY_MODE_ACTIVATED === "true",
      producerIds,
    });
    facts = measured.facts;
    authorization = measured.verdict;
  }
  const audit = {
    version: 1,
    action,
    actor: env.GITHUB_ACTOR ?? "unknown",
    workflowRun: env.GITHUB_RUN_ID ?? null,
    dispatchSha: env.GITHUB_SHA,
    attemptedAt: (operations.now ?? (() => new Date()))().toISOString(),
    facts: {
      incidentUrl: facts.incidentUrl ?? null,
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
  const auditWriter = operations.writeAudit ?? writeAudit;
  const finishAudit = (verdict, { errors = [], result = null } = {}) => auditWriter(env.RELEASE_AUDIT_PATH, {
    ...audit, verdict, errors, ...(result ? { result } : {}), completedAt: (operations.now ?? (() => new Date()))().toISOString(),
  });
  auditWriter(env.RELEASE_AUDIT_PATH, { ...audit, verdict: authorization.ok ? "authorized" : "refused", errors: authorization.errors });
  if (!authorization.ok) throw new Error(authorization.errors.join("; "));

  const emergency = action === "emergency";
  let mutation = { status: "validated", sha: facts.commitSha };
  let phase = "installation-token";
  let updateConfirmed = false;
  let finalized = false;
  try {
    const token = await (operations.createInstallationToken ?? createInstallationToken)({
      appId: env[emergency ? "EMERGENCY_APP_ID" : "RELEASE_APP_ID"],
      installationId: env[emergency ? "EMERGENCY_APP_INSTALLATION_ID" : "RELEASE_APP_INSTALLATION_ID"],
      privateKey: env[emergency ? "EMERGENCY_APP_PRIVATE_KEY" : "RELEASE_APP_PRIVATE_KEY"],
    });
    const appRequest = operations.appRequest ?? makeApiClient({ token });
    if (!emergency) {
      phase = "candidate-check";
      await (operations.publishCandidateCheck ?? publishCandidateCheck)({
        request: appRequest,
        repository: env.GITHUB_REPOSITORY,
        candidateSha: facts.commitSha,
        dispatchSha: env.GITHUB_SHA,
        conclusion: "success",
        summary: `Validated ${facts.tagName} on deployment ${facts.deploymentId} in ${facts.requestedMode} mode; refresh ${facts.healthRunId ?? "not performed (legacy)"}.`,
      });
    }
    if (action === "promote" || action === "emergency") {
      const expectedMain = facts.expectedMain;
      if (!expectedMain) throw new Error("validated expected main SHA is missing; refusing a fresh-main substitution");
      phase = "main-update";
      mutation = await (operations.updateMainNonForce ?? updateMainNonForce)({ request: appRequest, repository: env.GITHUB_REPOSITORY, expectedMain, candidateSha: facts.commitSha });
      if (mutation.status === "promotion-outcome-ambiguous") {
        finishAudit(mutation.status, { result: mutation }); finalized = true;
        throw new Error(mutation.status);
      }
      updateConfirmed = mutation.status === "promoted" || mutation.status === "already-promoted";
      if (mutation.status === "promoted") {
        phase = "production-observation";
        mutation.production = await (operations.observeProductionDeployment ?? observeProductionDeployment)({
          expectedSha: facts.commitSha,
          readLatest: operations.readLatestProductionDeployment ?? (() => readLatestProductionDeployment({
            environmentId: env.RAILWAY_PRODUCTION_ENVIRONMENT_ID,
            serviceId: env.RAILWAY_PRODUCTION_APP_SERVICE_ID,
            token: env.RAILWAY_PRODUCTION_READ_TOKEN,
          })),
          probeHealth: operations.probeProductionHealth ?? ((deployment) => {
            if (!deployment.url) throw new Error("Railway reported no production deployment domain; the observation is UNMEASURED and no configured value may stand in for it");
            return probeProductionHealth({ origin: deployment.url });
          }),
          timeoutMs: Number(env.PRODUCTION_DEPLOY_TIMEOUT_MS ?? 600_000),
        });
        if (mutation.production.status !== "verified") {
          finishAudit(mutation.production.status, { result: mutation }); finalized = true;
          throw new Error(mutation.production.status);
        }
      }
    }
    finishAudit("completed", { result: mutation }); finalized = true;
    return mutation;
  } catch (error) {
    if (!finalized) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      if (updateConfirmed) {
        const result = { ...mutation, production: mutation.production ?? { status: "promoted-but-deployment-unverified", observationError: message } };
        finishAudit("promoted-but-deployment-unverified", { errors: [message], result });
      } else {
        finishAudit("refused", { errors: [message], result: { status: "refused", phase, updateAttempted: phase === "main-update" } });
      }
    }
    throw error;
  }
}

if (process.argv.includes("--run")) {
  runReleaseController().catch((error) => {
    console.error(`release controller refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
