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
 *
 * ⚠️ WHAT ITS BEST OUTCOME MEANS, AND WHAT IT DOES NOT. Its schedule check passes only when the
 * shipped schedules contract FILE is disabled, so an all-green run cannot possibly mean "the weekly
 * automation is running" — it used to say `ACTIVATED`, which reads as exactly that. The best verdict
 * is therefore `READY TO ACTIVATE`: every control this build can measure was measured and is
 * correct. It does NOT add "and the system is still inert": that is a statement about live platform
 * schedules, and a file in this repository is not a measurement of them. Live activation is a later,
 * deliberate act with its own evidence.
 *
 * It is also PARTIAL by construction, and says which parts. The sidecar's provider variables, the
 * app's outbound configuration, live schedule state, branch/reference configuration and the remote
 * environment's credential provenance are not measurable through the read-only surface it carries;
 * each reports `UNVERIFIED` with the reason. Missing operator credentials (an activation
 * prerequisite) and an absent executable measurement (a limitation of this software) are named
 * distinctly, because only one of them can be fixed by supplying a token.
 */

import { readFileSync } from "node:fs";
import { assertStagingTopology } from "./config.mjs";
import {
  credentialFingerprint,
  fingerprintsComparable,
  fingerprintsEqual,
  REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES,
} from "./credential-fingerprint.mjs";
import { collectActivationEnvironment, expectedImageDigest, IMAGE_CONTENT_DIGEST, pinsFromEnvironment, readVerifiedActivationEvidence } from "./activation-evidence.mjs";
import { CONTRIBUTION_BASE } from "../branches.mjs";

export const ACTIVATION_STATUS = Object.freeze({
  /** Every measurable control this build can measure is measured and correct. Nothing more. */
  READY: "READY TO ACTIVATE",
  NOT_ACTIVATED: "NOT ACTIVATED",
  UNVERIFIED: "UNVERIFIED",
});

/** The credential classes the separation check requires; a missing one is incomparable, not distinct. */
export const REQUIRED_CREDENTIAL_CLASSES = REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES;

/** Railway deployment statuses that mean "this deployment is the one currently serving". */
const SERVING_STATUS = "SUCCESS";
const DEAD_STATUSES = new Set(["FAILED", "CRASHED", "REMOVED", "REMOVING", "SKIPPED"]);

const PASS = "pass";
const FAIL = "fail";
const UNVERIFIED = "unverified";

/** Every check this verifier can report, in reporting order. A check is never omitted. */
export const ACTIVATION_CHECKS = Object.freeze([
  "topology-identity",
  "token-environment-scope",
  "production-subject-identity",
  "runner-image-pinned",
  "runner-autodeploy-disabled",
  "app-deployment-measured",
  "app-health-bound",
  "app-mode-declared",
  "app-no-model-spend",
  "graphiti-no-provider-credentials",
  "credential-separation",
  // Deliberately NOT called `schedules-disabled`: this reads the shipped contract FILE. It is a
  // local configuration check and is not evidence about any live schedule on the platform.
  "schedules-disabled-in-contract-file",
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

/**
 * H1: BIND THE SIGNED PRODUCTION MEASUREMENT TO THE CONSUMER'S OWN PRODUCTION PINS.
 *
 * A signature proves WHO supplied an observation. It does not prove the observation is ABOUT the
 * subject this consumer expects. The exporter validates its own topology document and publishes
 * valid, fresh, purpose- and audience-bound evidence about the production app/Postgres/Neo4j it is
 * configured with; the importer holds an INDEPENDENT topology document naming the production
 * services it expects. Nothing compared the two. Measured against the real exporter → real importer
 * path with the exporter's evidence bytes left completely unchanged, altering only one consumer pin
 * at a time, all three of `appServiceId`, `postgresServiceId` and `neo4jServiceId` produced
 * `READY TO ACTIVATE` with `topology-identity: pass` — i.e. the verifier certified the consumer's
 * expected production identities, and their credential separation, from measurements of DIFFERENT
 * services. No forged signature, tampered envelope or cross-role token was required; ordinary
 * configuration drift (a replaced service, a corrected pin) is the whole trigger.
 *
 * The envelope verifier already binds project/environment SCOPE. Scope is not subject: the measured
 * instance identity is the (project, environment, service) tuple, so two different services in the
 * SAME production environment satisfy every scope check there is.
 *
 * Fails closed in both directions that matter: a subject that differs is a `mismatch` (FAIL), and a
 * subject or a pin that is ABSENT is `unmeasured` (UNVERIFIED) — never a pass. This binds the
 * identities the consumer actually supplies as expectations; it invents no new pins. Production
 * Graphiti is deliberately absent from this list because the evidence schema requires
 * `production.graphiti === null` — there is no production Graphiti measurement to bind. The
 * production RUNNER (exporter) subject is bound separately, by the runner checks.
 *
 * @param {Record<string, any> | null} production the signed `evidence.production` measurement
 * @param {Record<string, any> | null} pinned the consumer topology's `production` side
 */
export function bindMeasuredSubjects(measured, pinned) {
  const mismatches = [];
  const unmeasured = [];
  if (!measured) return { bound: false, mismatches, unmeasured: ["environment measurement to bind"] };
  if (!pinned) return { bound: false, mismatches, unmeasured: ["pinned identities to compare the measurement against"] };
  const subjects = [
    ["application service", measured.app?.serviceId, pinned.appServiceId],
    ["Postgres service", measured.resources?.postgres?.serviceId, pinned.postgresServiceId],
    ["Neo4j service", measured.resources?.neo4j?.serviceId, pinned.neo4jServiceId],
    // The already-required scope, re-bound HERE so this one check is a complete statement about
    // whose environment the measurement describes.
    ["project", measured.scope?.projectId, pinned.projectId],
    ["environment", measured.scope?.environmentId, pinned.environmentId],
  ];
  for (const [label, measured, pin] of subjects) {
    const measuredText = typeof measured === "string" ? measured.trim() : "";
    const pinText = typeof pin === "string" ? pin.trim() : "";
    if (!measuredText) { unmeasured.push(`${label} identity in the measurement`); continue; }
    if (!pinText) { unmeasured.push(`${label} pin in the consumer topology`); continue; }
    if (measuredText !== pinText) mismatches.push(`the measurement describes a different ${label} than the one pinned here`);
  }
  return { bound: mismatches.length === 0 && unmeasured.length === 0, mismatches, unmeasured };
}

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
const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * IS THIS HEALTH ANSWER EVIDENCE ABOUT THE OBSERVED DEPLOYMENT, OR IS IT JUST A RESPONSE?
 *
 * One predicate, because three checks read the same body and each used to decide separately —
 * which is how the measured table happened:
 *
 *   | response                          | binding | mode | answering |
 *   | wrong commit                      |  fail   | PASS |   PASS    |
 *   | ok:false, no run                  |  fail   | fail |   PASS    |
 *   | ok:true, copy-ready, no run       |  PASS   | fail |   PASS    |
 *
 * Every bold verdict there is a statement about a deployment whose answer had already been shown
 * not to describe it. An overall refusal does not cure that: an operator reads the individual lines.
 *
 * So a verdict about what the app SAYS is only available once the answer is tied to the observed
 * deployment (origin, `ok`, commit) AND satisfies the mode/run contract it claims. `usable: false`
 * carries the reason and its severity, and every dependent check reports that instead of its own
 * opinion.
 *
 * @returns {{usable: boolean, status?: string, reason?: string, mode?: string, refreshRunId?: string|null}}
 */
export function healthAnswerContract({ binding = null, health = null, deployment = null } = {}) {
  const refuse = (status, reason) => ({ usable: false, status, reason });
  if (!binding) return refuse(UNVERIFIED, "this acquisition recorded no binding decision, so no answer can be tied to a deployment");
  if (!binding.bound) {
    return binding.kind === "contradiction"
      ? refuse(FAIL, `${binding.refusal}; no health token was presented`)
      : refuse(UNVERIFIED, `${binding.refusal}; no health token was presented`);
  }
  if (!health) return refuse(UNVERIFIED, "no privileged health answer from the measured domain");
  if (health.origin && health.origin !== binding.origin) return refuse(FAIL, "the health answer is about a different origin than the measured deployment domain");
  if (health.status === 401) return refuse(FAIL, "the staging health token was rejected by the deployment");
  if (health.status !== 200 && health.status !== 202) return refuse(UNVERIFIED, `no usable health answer (the probe answered ${health.status})`);

  const body = health.body ?? {};
  if (body.ok !== true) return refuse(FAIL, `the bound deployment answered ${health.status} but reports ok=${String(body.ok ?? "absent")}; it is not serving this identity`);
  const served = body.commit ?? null;
  if (!served || !deployment?.commitSha) return refuse(UNVERIFIED, "the deployment or the health answer reports no commit, so the answer cannot be tied to the observed deployment");
  if (served !== deployment.commitSha) return refuse(FAIL, "the deployment serving the measured domain reports a different commit than the observed deployment");

  const mode = body.mode;
  const refreshRunId = body.refreshRunId ?? null;
  if (mode !== "copy-ready" && mode !== "legacy-pg-only") return refuse(FAIL, `the deployment declares no supported staging mode (${String(mode ?? "absent")})`);
  // `legacy-pg-only` has no refresh run by contract; `copy-ready` without one names a dataset that
  // was never installed.
  if (mode === "copy-ready" && !refreshRunId) return refuse(FAIL, "the deployment declares copy-ready but reports no refresh run, so no copied dataset is identified");
  return { usable: true, mode, refreshRunId };
}

/**
 * MAY THE PRIVILEGED STAGING HEALTH TOKEN BE PRESENTED AT ALL?
 *
 * The measured defect: a provider-returned hostname was enough. Independent mocked acquisitions
 * sent ONE health-token request each for a wrong-scope token, an absent scope, a wrong service, a
 * wrong environment, a `FAILED` deployment, a `BUILDING` deployment and a missing commit — and
 * several of those then reported `app-health-bound: pass`, because the answer that came back was
 * treated as evidence about an identity nothing had established.
 *
 * So the whole identity is decided BEFORE the request, and every clause is a refusal: the token's
 * own measured scope must be the pinned staging project/environment, the deployment must be the
 * pinned environment/service, serving, and carry a valid commit; the destination must be the domain
 * the provider reported for THAT deployment; and a configured `STAGING_ORIGIN`, when supplied, must
 * be a usable origin that agrees with it — an unparseable one is refused rather than ignored, which
 * is what previously let a malformed value normalise to `null` and vanish from the comparison.
 *
 * `kind` separates a CONTRADICTION (something was measured and disagrees — a failure) from an
 * ABSENCE (a prerequisite was never supplied — unverified). Both send zero requests.
 *
 * @returns {{bound: boolean, origin: string|null, refusal: string|null, kind: "contradiction"|"absence"|null}}
 */
export function healthProbeBinding({ env = {}, pin = null, tokenScope = null, deployment = null } = {}) {
  const absent = (refusal) => ({ bound: false, origin: null, refusal, kind: "absence" });
  const contradiction = (refusal) => ({ bound: false, origin: null, refusal, kind: "contradiction" });

  if (!env.STAGING_HEALTH_TOKEN) return absent("prerequisite missing — no staging health token supplied");
  if (!pin?.projectId || !pin?.environmentId || !pin?.appServiceId) return absent("no pinned staging project/environment/app-service identity to bind a probe to");
  if (!tokenScope?.projectId || !tokenScope?.environmentId) return absent("the staging read token's own project/environment scope was not measured");
  if (tokenScope.projectId !== pin.projectId || tokenScope.environmentId !== pin.environmentId) {
    return contradiction("the staging read token is scoped to a different project/environment than the pinned staging identity");
  }
  if (!deployment) return absent("no staging app deployment was measured");
  if (!deployment.environmentId || !deployment.serviceId) return absent("the measured deployment reports no environment/service identity");
  if (deployment.environmentId !== pin.environmentId || deployment.serviceId !== pin.appServiceId) {
    return contradiction("the measured deployment belongs to a different environment/service than the pinned staging app");
  }
  if (deployment.status !== SERVING_STATUS) {
    return contradiction(`the measured deployment is ${String(deployment.status ?? "of unreported status")}, not ${SERVING_STATUS}, so nothing is serving this identity`);
  }
  if (!FULL_SHA.test(String(deployment.commitSha ?? ""))) return absent("the measured deployment reports no valid commit identity to tie an answer to");
  if (!deployment.url) return absent("no measured deployment domain to bind the probe to");

  const supplied = String(env.STAGING_ORIGIN ?? "").trim();
  const configuredOrigin = normalizeOrigin(supplied);
  if (supplied && !configuredOrigin) return contradiction("STAGING_ORIGIN was supplied but is not a usable deployment origin");
  if (configuredOrigin && configuredOrigin !== deployment.url) return contradiction("the configured STAGING_ORIGIN is not the measured deployment domain");
  return { bound: true, origin: deployment.url, refusal: null, kind: null };
}

/**
 * Evaluate MEASURED facts. Pure: no I/O, no clock, no environment reads — everything it judges was
 * measured by {@link readActivationFacts} (or by a test's fixture) and handed in.
 *
 * @param {object} facts
 * @returns {{ status: string, checks: {id: string, status: string, detail: string}[], claims: object }}
 */
export function evaluateActivation(facts = {}) {
  const checks = [];

  // 1. The pinned identities, branches, internal hosts and variable REFERENCE shapes.
  //
  //    ⚠️ THE TOPOLOGY FILE IS A DOCUMENT OF EXPECTED PINS — a set of claims — and it stays one no
  //    matter what is written in it. This check previously passed on `assertStagingTopology` plus a
  //    non-empty `STAGING_TOPOLOGY_MEASURED_FROM` string, i.e. on the operator having typed a
  //    provenance LABEL. A label is not a measurement, so the document is now corroborated against
  //    what the providers actually returned: both project tokens' own project/environment scope, and
  //    the observed staging app deployment's environment/service. Facts the file asserts that
  //    nothing here reads — branch/reference configuration, internal hostnames — remain UNVERIFIED
  //    and are named as such.
  const tokensForTopology = facts.tokens ?? {};
  if (!facts.topology) checks.push(unmeasured("topology-identity", "no topology document was supplied"));
  else {
    let consistent = true;
    try {
      assertStagingTopology(facts.topology.document);
    } catch (error) {
      consistent = false;
      checks.push(check("topology-identity", FAIL, String(error instanceof Error ? error.message : error)));
    }
    if (consistent) {
      const doc = facts.topology.document ?? {};
      const mismatches = [];
      const uncorroborated = [];
      for (const side of ["staging", "production"]) {
        const scope = tokensForTopology[side];
        const pinned = doc[side];
        if (!pinned) { uncorroborated.push(`${side} pins`); continue; }
        if (!scope) { uncorroborated.push(`${side} project-token read-back`); continue; }
        if (scope.projectId !== pinned.projectId || scope.environmentId !== pinned.environmentId) {
          mismatches.push(`${side} pinned project/environment is not what its project token reads back`);
        }
      }
      const deployment = facts.appDeployment ?? null;
      if (!deployment) uncorroborated.push("staging app deployment read-back");
      else if (doc.staging && (deployment.environmentId !== doc.staging.environmentId || deployment.serviceId !== doc.staging.appServiceId)) {
        mismatches.push("the observed staging app deployment is not the pinned environment/service");
      }
      const acquired = facts.topology.acquisition;
      if (acquired) {
        const expected = facts.topology.document;
        if (acquired.github?.fullName !== acquired.repository || acquired.github?.defaultBranch !== "staging" || acquired.contributionBranch !== "staging") mismatches.push("authenticated repository metadata or the shipped contribution branch is not staging");
        for (const [side, measured] of [["staging", acquired.staging], ["production", acquired.production]]) {
          const pin = expected[side];
          if (!measured || measured.app.source.branch !== pin.appSourceBranch || measured.app.source.repository !== acquired.repository) mismatches.push(`${side} application source branch/repository does not match its provider read-back`);
          if (!measured || measured.app.postgresHost !== pin.postgresHost || measured.app.neo4jHost !== pin.neo4jHost) mismatches.push(`${side} internal database hosts do not match their private-endpoint read-backs`);
          for (const name of ["DATABASE_URL", "NEO4J_URL"]) if (!measured?.app?.references?.[name]) mismatches.push(`${side} ${name} has no verified service reference`);
          // H1: this sentence says "pinned identities ... are corroborated". Until now it compared
          // branches, hosts and reference shapes and NOT the service identities those facts are
          // about, so an acquisition describing other services in the correct environment produced
          // exactly this pass. The `production` half is the load-bearing one — its measurement is
          // supplied by the exporter, not collected here — but both sides are bound, because a
          // claim of corroborated identity should not be true only by construction on one side.
          const subjectBinding = bindMeasuredSubjects(measured ?? null, pin);
          for (const mismatch of subjectBinding.mismatches) mismatches.push(`${side}: ${mismatch}`);
          for (const missing of subjectBinding.unmeasured) mismatches.push(`${side} has no ${missing}`);
        }
      } else {
        uncorroborated.push("authenticated branch/reference/internal-host acquisition");
      }
      checks.push(mismatches.length
        ? check("topology-identity", FAIL, mismatches.join("; "))
        : uncorroborated.length
          ? check("topology-identity", UNVERIFIED, `the document is internally consistent but UNCORROBORATED: no ${uncorroborated.join(", no ")}. Branch/reference and internal-host pins are not read by this verifier at all${facts.topology.measuredFrom ? `; the recorded provenance "${facts.topology.measuredFrom}" is an operator label, not a measurement` : ""}`)
          : check("topology-identity", PASS, "pinned identities, repository branches, service references and private internal hosts are corroborated by authenticated provider acquisition"));
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

  // 2b. WHOSE PRODUCTION IS THIS EVIDENCE ABOUT? See `bindMeasuredSubjects`. The check above
  //     proves each TOKEN is scoped where it should be; this one proves the signed production
  //     measurement describes the production SERVICES this consumer pinned, rather than some other
  //     services in the same correctly scoped production environment.
  const subjects = facts.productionSubjects ?? null;
  checks.push(!subjects
    ? unmeasured("production-subject-identity", "no signed production measurement bound to this consumer's production pins; the fully acquired evidence path did not run")
    : subjects.mismatches.length
      ? check("production-subject-identity", FAIL, subjects.mismatches.join("; "))
      : subjects.unmeasured.length
        ? unmeasured("production-subject-identity", subjects.unmeasured.join("; no "))
        : check("production-subject-identity", PASS, "the signed production measurement is about the production application, Postgres and Neo4j services pinned by this consumer, in its pinned production project/environment"));

  // 3/4. The two ops runners: an immutable pinned image and NO automatic deploy trigger. A runner
  //      that redeploys on a branch push is a moving target holding both databases' credentials.
  //      BOTH runners, named individually. `Object.keys(runners).length === 0` let ONE successful
  //      measurement satisfy a check whose text says "both": the exporter could be unmeasurable and
  //      the importer alone would carry the pass. A missing runner is now UNVERIFIED by name, a
  //      missing autodeploy READING is UNVERIFIED (only a measured `true` is a failure), and the
  //      returned `serviceId` is validated rather than discarded — a read-back about a different
  //      service is evidence about that service.
  const runners = facts.runners ?? {};
  const imageErrors = [];
  const autoErrors = [];
  const imageUnmeasured = [];
  const autoUnmeasured = [];
  for (const name of ["exporter", "importer"]) {
    const runner = runners[name] ?? null;
    if (!runner) {
      imageUnmeasured.push(`${name} serviceInstance read-back`);
      autoUnmeasured.push(`${name} autodeploy read-back`);
      continue;
    }
    if (runner.expectedServiceId && runner.serviceId !== runner.expectedServiceId) {
      imageErrors.push(`${name} read-back is for a different service than the one requested`);
    } else if (!runner.serviceId) {
      imageUnmeasured.push(`${name} service identity in the read-back`);
    }
    if (!IMAGE_DIGEST.test(String(runner.image ?? ""))) imageErrors.push(`${name} is not pinned to an immutable image digest`);
    else if (runner.expectedImage && runner.image !== runner.expectedImage) imageErrors.push(`${name} is CONFIGURED with a different immutable artifact than the pinned one`);
    else if (!runner.expectedImage) imageUnmeasured.push(`${name} expected image digest (its immutability is measured; its IDENTITY is not pinned to compare against)`);
    else {
      // THE ARTIFACT ACTUALLY RUNNING, not the one configured. The two lines above compare
      // `serviceInstance.source.image` — service CONFIGURATION, which Railway's staged changes can
      // legitimately advance without redeploying, so it is not evidence about the running
      // deployment. `imageDigest` is measured from the pinned active deployment's own authenticated
      // metadata. The comparison is against THIS CONSUMER's expected reference: for the exporter
      // that measurement is supplied by the signer, and a signer's choice of expected image is not
      // a substitute for the consumer's own expectation.
      const measured = String(runner.imageDigest ?? "").toLowerCase();
      const expected = expectedImageDigest(runner.expectedImage);
      if (!expected) imageUnmeasured.push(`${name} expected artifact digest (its pinned reference carries no sha256 digest to compare against)`);
      else if (!IMAGE_CONTENT_DIGEST.test(measured)) {
        imageUnmeasured.push(`${name} active artifact digest — the deployment reported none, or a malformed one, so what it is RUNNING is unverified (its configured reference is not evidence of this)`);
      } else if (measured !== expected) imageErrors.push(`${name}'s pinned active deployment is RUNNING a different artifact (${measured.slice(0, 19)}…) than its pinned immutable reference`);
    }
    if (runner.repo) imageErrors.push(`${name} has a repository source`);
    if (runner.autoDeploy == null) autoUnmeasured.push(`${name} autodeploy status (the provider reported none)`);
    else if (runner.autoDeploy !== false) autoErrors.push(`${name} has automatic deployments enabled`);
  }
  checks.push(imageErrors.length
    ? check("runner-image-pinned", FAIL, imageErrors.join("; "))
    : imageUnmeasured.length
      ? unmeasured("runner-image-pinned", imageUnmeasured.join("; no "))
      : check("runner-image-pinned", PASS, "both runners are configured with, AND their pinned active deployments report running, the pinned immutable artifact, with no repository source"));
  checks.push(autoErrors.length
    ? check("runner-autodeploy-disabled", FAIL, autoErrors.join("; "))
    : autoUnmeasured.length
      ? unmeasured("runner-autodeploy-disabled", autoUnmeasured.join("; no "))
      : check("runner-autodeploy-disabled", PASS, "automatic deployments are disabled on both runners"));

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
  }
  // The newest deployment edge is not necessarily a SERVING one: it may be building, or it may have
  // failed. Reading its domain and calling that "the deployment's identity" skips the question.
  else if (DEAD_STATUSES.has(String(deployment.status))) {
    checks.push(check("app-deployment-measured", FAIL, `the newest staging app deployment is ${deployment.status}, so nothing is serving this identity`));
  } else if (deployment.status !== SERVING_STATUS) {
    checks.push(check("app-deployment-measured", UNVERIFIED, `the newest staging app deployment is ${String(deployment.status ?? "of unreported status")}, not a completed one; re-run once it settles`));
  } else checks.push(check("app-deployment-measured", PASS, `staging app deployment ${deployment.id} is serving at its own measured domain`));

  // 6. THE BINDING, kept as its own check because it is the one that decides whether a privileged
  //    token may be presented at all. The acquisition used to probe whatever `STAGING_ORIGIN` named,
  //    whenever an origin and a token both existed, and nothing ever compared that host to the
  //    deployment — so the staging health token could be sent to an arbitrary configured domain and
  //    that domain's own answer became the evidence. Now: no measured domain ⇒ no request; a
  //    configured origin that disagrees ⇒ no request; and an answer that is about another origin, or
  //    about a different commit than the deployment Railway reported, is a refusal rather than a
  //    health verdict.
  const health = facts.appHealth ?? null;
  const binding = facts.healthBinding ?? null;
  const contract = healthAnswerContract({ binding, health, deployment });
  checks.push(contract.usable
    ? check("app-health-bound", PASS, `the health answer came from the measured deployment domain, reports ok, carries the observed deployment's commit, and serves mode ${contract.mode}${contract.refreshRunId ? ` refresh run ${contract.refreshRunId}` : ""}`)
    : contract.status === FAIL
      ? check("app-health-bound", FAIL, contract.reason)
      : unmeasured("app-health-bound", contract.reason));

  // 7/8. What the APP says about itself, over its own privileged health contract — the one place
  //      the app's runtime posture is observable without reading its variables. Note the scope:
  //      `answering: "disabled"` is the deployment's REPORTED answering posture, and nothing more.
  //      It is not proof of the whole no-spend policy: graph extraction, embeddings, image and
  //      outbound-connector posture are separate controls with their own evidence.
  // BOTH of these are statements about what the app SAYS, so neither is available until the answer
  // has been shown to describe the observed deployment. A wrong-commit response used to produce a
  // failing binding and a PASSING declared mode and answering posture — three lines an operator
  // reads independently, two of them about a deployment the first line said this was not.
  if (!contract.usable) {
    const dependent = contract.status === FAIL
      ? (id) => check(id, FAIL, contract.reason)
      : (id) => unmeasured(id, contract.reason);
    checks.push(dependent("app-mode-declared"));
    checks.push(dependent("app-no-model-spend"));
  } else {
    checks.push(check("app-mode-declared", PASS, `the deployment declares mode ${contract.mode}${contract.refreshRunId ? ` serving refresh run ${contract.refreshRunId}` : ""}`));

    // The honest reading of the OPTIONAL budgeted interactive mode: `unsupported-budgeted-mode`
    // means an operator asked for it and did not get it. That is not a spend risk — no call is
    // made either way — but reporting it as a plain `disabled` would leave them believing their
    // configuration took effect, so it is surfaced as its own outcome.
    const answering = health.body?.answering;
    if (answering === undefined) checks.push(check("app-no-model-spend", UNVERIFIED, "the deployment reports no answering posture; it predates the field"));
    else if (answering === "disabled") checks.push(check("app-no-model-spend", PASS, "the deployment REPORTS model-backed answering as disabled; this one field is evidence about answering posture only, not about graph extraction, embedding, image or outbound-connector policy"));
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
  //     MISSING AND MALFORMED ARE INCOMPARABLE, NOT DIFFERENT. `fingerprintsEqual` answers `false`
  //     for an absent remote key, a mismatched keyId, a wrong version or a malformed MAC — and the
  //     previous loop read every one of those falses as "this credential differs", so an empty or
  //     forged opposite-environment document passed the check that exists to catch a shared secret.
  //     Every required class must now be present and comparable on BOTH sides, minted under the SAME
  //     comparison key, before any comparison counts. (What this can never establish is the remote
  //     document's provenance: it is a JSON file, and this build has no authenticated channel for
  //     one, which is why a passing check says "as recorded in the supplied document".)
  const separation = facts.credentialFingerprints ?? null;
  if (!separation?.local || !separation?.remote) {
    checks.push(unmeasured("credential-separation", "no fingerprint document from the opposite environment to compare against"));
  } else {
    const incomparable = [];
    const shared = [];
    for (const credentialClass of REQUIRED_CREDENTIAL_CLASSES) {
      const local = separation.local[credentialClass];
      const remote = separation.remote[credentialClass];
      if (!fingerprintsComparable(local, remote)) {
        incomparable.push(`${credentialClass} (${!local ? "no local fingerprint" : !remote ? "absent from the opposite-environment document" : "different comparison key, class or malformed MAC"})`);
        continue;
      }
      if (fingerprintsEqual(local, remote)) shared.push(credentialClass);
    }
    // A SHARED CREDENTIAL IS STILL A FAILURE — an unauthenticated document that says "identical" is
    // telling us something no forgery would volunteer. The reverse is NOT symmetric: "they differ"
    // is exactly what a forged, stale or simply wrong file would also say. So a difference may only
    // be reported as LIVE separation when the opposite side's document carries authenticated,
    // environment-bound provenance; otherwise it is a local document diagnostic and the live
    // property is UNVERIFIED. It used to PASS regardless, with the qualifier ("as recorded in the
    // supplied document") carried in the sentence and lost in the verdict — so a complete set of
    // local credentials plus an ordinary opposite-environment JSON file certified separation.
    // `readActivationFacts` sets this provenance to `null` by construction: this build has no
    // authenticated channel for such a document, which is a named software gap, not a passing check.
    // BOTH SIDES, not one. Authenticated provenance for the REMOTE document says where that file
    // came from; it says nothing about whose credentials the local half fingerprinted. This process
    // reads `AUTH_SECRET` and friends out of its own environment — which is an assertion about a
    // runner, not evidence about the deployed staging environment — so remote-only provenance was
    // still "an unauthenticated local value differs from an authenticated remote one", reported as
    // live separation. Each side must carry authenticated evidence bound to ITS OWN environment.
    const expectedRemoteEnvironment = facts.topology?.document?.production?.environmentId ?? null;
    const expectedLocalEnvironment = facts.topology?.document?.staging?.environmentId ?? null;
    const boundTo = (provenance, environmentId) =>
      provenance?.authenticated === true && Boolean(environmentId) && provenance.environmentId === environmentId;
    const remoteBound = boundTo(separation.remoteProvenance, expectedRemoteEnvironment);
    const localBound = boundTo(separation.localProvenance, expectedLocalEnvironment);
    // H1 GATE. Environment-bound provenance answers "which environment did this fingerprint come
    // from"; it does NOT answer "which SERVICES in that environment". A remote fingerprint taken
    // from a different production app — correctly scoped, correctly signed — would otherwise
    // certify separation for the app this consumer actually pinned, which is the exact claim this
    // check exists to make. Separation may only be reported as established once the signed
    // measurement is bound to the pinned production subjects.
    const subjectsBound = facts.productionSubjects?.bound === true;
    const unbound = [
      !localBound && "the local deployed credentials",
      !remoteBound && "the opposite-environment document",
      !subjectsBound && "the signed production measurement's subject identities (see production-subject-identity)",
    ].filter(Boolean);
    checks.push(shared.length
      ? check("credential-separation", FAIL, `staging and production share credentials: ${shared.join(", ")}`)
      : incomparable.length
        ? unmeasured("credential-separation", `comparable fingerprints for ${incomparable.join("; ")}`)
        : localBound && remoteBound && subjectsBound
          ? check("credential-separation", PASS, `all ${REQUIRED_CREDENTIAL_CLASSES.length} required credential classes differ, with authenticated provenance bound to ${expectedLocalEnvironment} locally and ${expectedRemoteEnvironment} remotely, and the remote measurement bound to the pinned production subjects`)
          : unmeasured("credential-separation", `live credential separation: all ${REQUIRED_CREDENTIAL_CLASSES.length} required classes differ as recorded, but ${unbound.join(" and ")} carry no authenticated, environment-bound provenance — this is a local diagnostic and the live property is unverified`));
  }

  // 11. The SHIPPED CONTRACT FILE says the schedules are disabled. This is a local configuration
  //     check: it reads a file in this repository, not the platform, so it can never be evidence
  //     that no schedule is live. Activation flips the real thing deliberately, elsewhere.
  checks.push(facts.schedules == null
    ? unmeasured("schedules-disabled-in-contract-file", "the shipped schedules contract file was not read")
    : facts.schedules.activated === false
      ? check("schedules-disabled-in-contract-file", PASS, "the shipped contract file declares the schedules disabled; this is a local configuration check and is not evidence about live platform schedules")
      : check("schedules-disabled-in-contract-file", FAIL, "the shipped contract file declares itself activated"));

  const status = checks.some((c) => c.status === FAIL)
    ? ACTIVATION_STATUS.NOT_ACTIVATED
    : checks.some((c) => c.status === UNVERIFIED)
      ? ACTIVATION_STATUS.UNVERIFIED
      // Not "ACTIVATED": the best this command can certify is that the measurable controls are
      // correct. It cannot add "and the system is still inert" — the schedule check reads a file in
      // this repository, and a local contract file is not a measurement of live platform schedules.
      : ACTIVATION_STATUS.READY;

  return { status, checks, claims: facts.operatorClaims ?? {} };
}

/**
 * Fail the caller unless every measurable control passed.
 *
 * `UNVERIFIED` refuses just as `NOT ACTIVATED` does — the difference is what the operator must do
 * next, not whether they may proceed. A pass means READY TO ACTIVATE, never "activated": see the
 * module header.
 */
export function assertActivationPreflightReady(result) {
  if (result.status === ACTIVATION_STATUS.READY) return result;
  const lines = result.checks.filter((c) => c.status !== PASS).map((c) => `- ${c.id} [${c.status}]: ${c.detail}`);
  throw new Error(`staging activation preflight is ${result.status}:\n${lines.join("\n")}`);
}

// ── Measurement ────────────────────────────────────────────────────────────────────────────────

/**
 * The tokens this verifier is given are ENVIRONMENT-SCOPED PROJECT tokens — the same kind
 * `RailwayMaintenance` uses, and they authenticate with `Project-Access-Token`, not with an
 * `Authorization: Bearer` account credential. Sending the wrong header produced an authentication
 * failure that read as "the platform is configured differently than you think", which is a much more
 * alarming and much less true conclusion than "this client sent the wrong header".
 */
async function railwayQuery({ document, variables, token, fetchImpl, apiUrl = "https://backboard.railway.com/graphql/v2" }) {
  assertReadOnlyDocument(document);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "error",
    headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  // The status and the operation name are safe to report; the body may echo configuration, so it
  // never reaches the message.
  if (!response.ok || body?.errors?.length) throw new Error(`activation read failed (${response.status})`);
  return body?.data ?? null;
}

/**
 * An operator-configured origin, reduced to the same shape a measured `staticUrl` produces so the
 * two are comparable. Anything carrying credentials, a port, a path or a non-https scheme is not a
 * deployment domain and normalises to `null` — which refuses rather than matching loosely.
 */
function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.port) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin.toLowerCase();
  } catch { return null; }
}

/** One measurement that may legitimately be unavailable: absence becomes `null`, never a throw. */
async function measure(label, read, notes) {
  try { return await read(); }
  catch (error) { notes.push(`${label}: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`); return null; }
}

async function githubRepository(env, fetchImpl) {
  if (!env.STAGING_GITHUB_READ_TOKEN || !env.GITHUB_REPOSITORY) throw new Error("authenticated repository metadata prerequisites are missing");
  const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}`, {
    redirect: "error", headers: { Authorization: `Bearer ${env.STAGING_GITHUB_READ_TOKEN}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.full_name !== env.GITHUB_REPOSITORY || body?.default_branch !== "staging") throw new Error(`repository metadata read failed (${response.status})`);
  return { fullName: body.full_name, defaultBranch: body.default_branch };
}

async function readFullyAcquiredActivationFacts(env, { fetchImpl, evidenceStore, now, budget }, topology, notes) {
  budget?.assert("signed production activation evidence read");
  const remoteEvidence = await readVerifiedActivationEvidence({ env, store: evidenceStore, now });
  const production = remoteEvidence.production;
  // H1: THE CONSUMER'S OWN ADMISSION DECISION, made here — at the boundary where the signed
  // production measurement first becomes a readiness fact — and never delegated to the producer's
  // validation of its own topology document. Computed BEFORE the production measurement is assigned
  // to `runners`, `credentialFingerprints` or the topology acquisition below, so every downstream
  // consumer of those facts is downstream of this binding too. It cannot silently disappear: absent
  // subjects and absent pins land in `unmeasured` and the check reports UNVERIFIED, which refuses
  // just as a FAIL does.
  const productionSubjects = bindMeasuredSubjects(production, topology.document?.production ?? null);
  const staging = await collectActivationEnvironment({
    pins: pinsFromEnvironment(env, topology.document.staging, "staging"), token: env.RAILWAY_STAGING_READ_TOKEN,
    comparisonKey: Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64"), comparisonKeyId: env.STAGING_COMPARISON_KEY_ID,
    includeGraphiti: true, fetchImpl, budget,
  });
  budget?.assert("staging deployment and repository reads");
  const [deploymentData, github] = await Promise.all([
    railwayQuery({ document: ACTIVATION_DOCUMENTS.deployments, variables: { environmentId: topology.document.staging.environmentId, serviceId: topology.document.staging.appServiceId }, token: env.RAILWAY_STAGING_READ_TOKEN, fetchImpl }),
    githubRepository(env, fetchImpl),
  ]);
  const nodes = (deploymentData?.deployments?.edges ?? []).map((edge) => edge.node);
  const node = nodes.find((candidate) => candidate.id === staging.app.deploymentId);
  let appDeployment = null;
  if (node && node.status === "SUCCESS" && node.environmentId === staging.scope.environmentId && node.serviceId === staging.app.serviceId) {
    const commitSha = node.meta?.commitHash ?? node.meta?.repoCommit ?? null;
    const raw = String(node.staticUrl ?? "").trim();
    if (commitSha === staging.app.commitSha) appDeployment = { id: node.id, status: node.status, environmentId: node.environmentId, serviceId: node.serviceId,
      commitSha, url: raw && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw) ? `https://${raw.toLowerCase()}` : null };
  }
  if (!appDeployment) notes.push("staging app deployment: deployment-domain read-back did not match the deployment-bound configuration acquisition");
  const healthBinding = healthProbeBinding({ env, pin: topology.document.staging, tokenScope: staging.scope, deployment: appDeployment });
  let appHealth = null;
  if (healthBinding.bound) {
    appHealth = await measure("staging health", async () => {
      const response = await fetchImpl(new URL("/api/health", healthBinding.origin), { redirect: "manual", headers: { "x-aios-staging-health-token": env.STAGING_HEALTH_TOKEN }, signal: AbortSignal.timeout(15_000) });
      if (response.status >= 300 && response.status < 400) throw new Error("staging health redirected; off-origin redirects are refused");
      if (response.url && new URL(response.url).origin !== healthBinding.origin) throw new Error("staging health final origin changed");
      return { status: response.status, origin: healthBinding.origin, body: await response.json().catch(() => ({})) };
    }, notes);
  } else notes.push(`staging health: ${healthBinding.refusal}; no health token was presented`);
  const schedules = env.STAGING_SCHEDULES_FILE ? await measure("schedules", async () => JSON.parse(readFileSync(env.STAGING_SCHEDULES_FILE, "utf8")), notes) : null;
  const operatorClaims = Object.fromEntries(Object.keys(env).filter((name) => name.startsWith("ACTIVATION_CLAIM_")).map((name) => [name, "claimed (not evidence)"]));
  return {
    topology: { ...topology, acquisition: { staging, production, github, repository: env.GITHUB_REPOSITORY, contributionBranch: CONTRIBUTION_BASE } },
    tokens: { staging: staging.scope, production: production.scope },
    productionSubjects,
    runners: {
      importer: { ...staging.runner, expectedServiceId: env.STAGING_IMPORTER_SERVICE_ID, expectedImage: env.STAGING_IMPORTER_IMAGE_DIGEST },
      exporter: { ...production.runner, expectedServiceId: env.PRODUCTION_EXPORTER_SERVICE_ID, expectedImage: env.PRODUCTION_EXPORTER_IMAGE_DIGEST },
    },
    appDeployment, appHealth, healthBinding,
    graphitiProviderCredentials: staging.graphitiProviderCredentials,
    credentialFingerprints: {
      local: staging.credentialFingerprints, remote: production.credentialFingerprints,
      localProvenance: { authenticated: true, environmentId: staging.scope.environmentId, deploymentId: staging.app.deploymentId, snapshotId: staging.app.snapshotId },
      remoteProvenance: { authenticated: true, environmentId: production.scope.environmentId, deploymentId: production.app.deploymentId, snapshotId: production.app.snapshotId, evidenceId: remoteEvidence.evidenceId },
    },
    schedules, operatorClaims, notes,
  };
}

/**
 * Acquire the facts, read-only. Every measurement is independently optional: a missing credential
 * yields `null` for that fact and an `UNVERIFIED` check, which is the whole point — a verifier that
 * throws on the first missing input reports nothing about the rest.
 */
export async function readActivationFacts(env = process.env, { fetchImpl = fetch, evidenceStore, now = Date.now(), budget = null } = {}) {
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

  if (topology && env.ACTIVATION_EVIDENCE_OBJECT_ID) {
    return readFullyAcquiredActivationFacts(env, { fetchImpl, evidenceStore, now, budget }, topology, notes);
  }

  // The importer never receives or uses a production provider credential. Production facts arrive
  // only through a fresh purpose-bound exporter signature in the supported path above.
  const token = (side) => (side === "staging" ? env.RAILWAY_STAGING_READ_TOKEN : null);
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
    ["exporter", "production", env.PRODUCTION_EXPORTER_SERVICE_ID, topology?.document?.production, env.PRODUCTION_EXPORTER_IMAGE_DIGEST],
    ["importer", "staging", env.STAGING_IMPORTER_SERVICE_ID, topology?.document?.staging, env.STAGING_IMPORTER_IMAGE_DIGEST],
  ];
  const runners = {};
  for (const [name, side, serviceId, pinned, expectedImage] of runnerSpecs) {
    if (!serviceId || !pinned?.projectId || !pinned?.environmentId || !token(side)) {
      // An operator PREREQUISITE (supply the pinned identity / the read token), distinct from the
      // capability gaps noted elsewhere — the two are fixed by different people.
      notes.push(`${name} runner: prerequisite missing — pinned service/environment identity or read token not supplied`);
      continue;
    }
    const measured = await measure(`${name} runner`, async () => {
      const data = await railwayQuery({
        document: ACTIVATION_DOCUMENTS.serviceInstance,
        variables: { projectId: pinned.projectId, environmentId: pinned.environmentId, serviceId },
        token: token(side), fetchImpl,
      });
      return {
        // Kept, not discarded: a read-back is evidence about the service it names.
        serviceId: data?.serviceInstance?.serviceId ?? null,
        expectedServiceId: serviceId,
        image: data?.serviceInstance?.source?.image ?? null,
        expectedImage: expectedImage?.trim() || null,
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
          commitSha: node.meta?.commitHash ?? node.meta?.repoCommit ?? null,
          // Bare hostname → https origin. Absent stays absent: see `app-deployment-measured`.
          url: raw && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw) ? `https://${raw.toLowerCase()}` : null,
        };
      }, notes)
    : null;

  // ESTABLISH THE IDENTITY, THEN AUTHENTICATE TO IT — never the other way round. `healthProbeBinding`
  // decides the whole question (token scope, pinned environment/service, serving status, commit,
  // domain, configured-origin agreement) before a single privileged byte leaves this process, so an
  // unbound or unidentified target produces ZERO requests rather than one whose answer is then read
  // as evidence about the identity it was never checked against.
  const healthBinding = healthProbeBinding({ env, pin: stagingPin, tokenScope: tokens.staging, deployment: appDeployment });
  let appHealth = null;
  if (!healthBinding.bound) {
    notes.push(`staging health: ${healthBinding.refusal}; no health token was presented`);
  } else {
    const boundOrigin = healthBinding.origin;
    appHealth = await measure("staging health", async () => {
      const response = await fetchImpl(new URL("/api/health", boundOrigin), {
        redirect: "manual",
        headers: { "x-aios-staging-health-token": env.STAGING_HEALTH_TOKEN },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400) throw new Error("staging health redirected; off-origin redirects are refused");
      if (response.url && new URL(response.url).origin !== boundOrigin) throw new Error("staging health final origin changed");
      return { status: response.status, origin: boundOrigin, body: await response.json().catch(() => ({})) };
    }, notes);
  }

  let credentialFingerprints = null;
  if (env.STAGING_COMPARISON_KEY_BASE64 && env.STAGING_COMPARISON_KEY_ID && env.OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE) {
    credentialFingerprints = await measure("credential separation", async () => {
      const comparisonKey = Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64");
      // Only credentials this process ACTUALLY HOLDS are fingerprinted. Template-joining absent
      // values produced the string "undefined\0undefined", which is a perfectly good HMAC input and
      // therefore a fingerprint that differs from production's — "we hold no Neo4j credential"
      // masquerading as "our Neo4j credential is distinct". A missing class is simply absent, and
      // the evaluator reports it as incomparable.
      const inputs = [
        ["auth-secret", env.AUTH_SECRET],
        ["secrets-key", env.SECRETS_KEY],
        ["neo4j-credential", env.NEO4J_USER && env.NEO4J_PASSWORD ? `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}` : null],
      ].filter(([credentialClass, value]) => {
        if (typeof value === "string" && value.length) return true;
        notes.push(`credential separation: prerequisite missing — this runner holds no ${credentialClass} to fingerprint`);
        return false;
      });
      const local = Object.fromEntries(inputs.map(([credentialClass, value]) => [
        credentialClass,
        credentialFingerprint({ credentialClass, value, comparisonKey, keyId: env.STAGING_COMPARISON_KEY_ID }),
      ]));
      // The opposite side arrives as a plain JSON document read off local disk. This build has no
      // authenticated, environment-bound channel for one, so its PROVENANCE is `null` BY
      // CONSTRUCTION — stated as a fact rather than left implicit, because the evaluator's verdict
      // now turns on it: without provenance a difference is a local diagnostic, not live credential
      // separation. Supplying provenance is a software gap to close, not a variable to set.
      // Both provenances are `null` BY CONSTRUCTION. The remote side arrives as plain JSON over no
      // authenticated channel; the LOCAL side is this process reading its own environment, which
      // establishes what a runner holds and not what the deployed staging environment holds. Filling
      // either is a software gap to close, not a variable to set.
      return {
        local,
        remote: JSON.parse(readFileSync(env.OPPOSITE_ENVIRONMENT_FINGERPRINTS_FILE, "utf8")),
        localProvenance: null,
        remoteProvenance: null,
      };
    }, notes);
  } else notes.push("credential separation: prerequisite missing — comparison key or opposite-environment fingerprint document not supplied");

  const schedules = env.STAGING_SCHEDULES_FILE
    ? await measure("schedules", async () => JSON.parse(readFileSync(env.STAGING_SCHEDULES_FILE, "utf8")), notes)
    : null;
  if (!env.STAGING_SCHEDULES_FILE) notes.push("schedules: contract file not supplied");

  // RECORDED, never evidence. An operator asserting a thing is a fact about the operator.
  const operatorClaims = Object.fromEntries(
    Object.keys(env).filter((name) => name.startsWith("ACTIVATION_CLAIM_")).map((name) => [name, "claimed (not evidence)"])
  );

  return { topology, tokens, runners, appDeployment, appHealth, healthBinding, credentialFingerprints, schedules, operatorClaims, notes };
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
