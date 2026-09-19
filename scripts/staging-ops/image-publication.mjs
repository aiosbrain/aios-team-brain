#!/usr/bin/env node
/**
 * AIO-997 — the ops runner image publisher's evidence layer.
 *
 * WHAT THIS IS FOR. The workflow (`.github/workflows/staging-ops-image.yml`) publishes
 * `docker/staging-ops.Dockerfile` from ONE trusted source — the immutable `github.sha` of a manual
 * dispatch on `refs/heads/staging` — to a fixed private GHCR package, and emits a receipt naming the
 * registry digest. Everything in that sentence that can be WRONG rather than merely broken lives
 * here, as pure functions with tests, instead of as shell in a file no test tier can reach.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a registry abstraction, not a signing protocol, not a general
 * GitHub client. Fixed destination, fixed metadata endpoint, no source input, no dependencies.
 *
 * THE ONE PROPERTY WORTH READING TWICE (OP-04). `confirmRegistryManifest` does not accept a caller's
 * word that a digest was confirmed. A manifest's digest IS the sha256 of its own raw bytes, so this
 * recomputes it from the bytes the registry returned and compares. That is why a config digest (the
 * build action's `imageid`) cannot be laundered into a success receipt: it does not hash to the
 * manifest the registry serves at that reference.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isDirectEntry } from "./direct-entry.mjs";

// ---------------------------------------------------------------------------
// Fixed identity. No input selects any of this — that is the trust contract.
// ---------------------------------------------------------------------------
export const REPOSITORY = "aiosbrain/aios-team-brain";
export const OWNER = "aiosbrain";
export const PACKAGE = "aios-staging-ops";
export const REGISTRY = "ghcr.io";
export const IMAGE = `${REGISTRY}/${OWNER}/${PACKAGE}`;
export const SOURCE_REF = "refs/heads/staging";
export const WORKFLOW_PATH = ".github/workflows/staging-ops-image.yml";
export const EXPECTED_WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@${SOURCE_REF}`;
export const PLATFORM = "linux/amd64";
export const DOCKERFILE = "docker/staging-ops.Dockerfile";
export const PACKAGE_METADATA_URL = `https://api.github.com/orgs/${OWNER}/packages/container/${PACKAGE}`;

/**
 * A single-platform, attestation-free build publishes an image MANIFEST. An index/manifest list at
 * the top level means the build produced something other than what this publisher claims to publish
 * (multiarch, or an attestation descriptor), and the honest response is to refuse rather than to
 * pick a child and call it the artifact.
 */
export const ACCEPTED_MEDIA_TYPES = Object.freeze([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// OP-01 — dispatch context
// ---------------------------------------------------------------------------

/**
 * Every reason this dispatch context is not the one trusted context, as a LIST — an operator
 * fixing a misconfigured dispatch should see all of them, not the first one.
 */
export function dispatchContextFailures(ctx = {}) {
  const failures = [];
  const { repository, eventName, ref, sha, workflowSha, workflowRef } = ctx;
  if (repository !== REPOSITORY) failures.push(`repository is ${describe(repository)}, expected ${REPOSITORY}`);
  if (eventName !== "workflow_dispatch") failures.push(`event is ${describe(eventName)}, expected workflow_dispatch`);
  if (ref !== SOURCE_REF) failures.push(`ref is ${describe(ref)}, expected ${SOURCE_REF}`);
  if (!SHA40.test(String(sha ?? ""))) failures.push(`source sha ${describe(sha)} is not a full 40-hex commit`);
  if (!SHA40.test(String(workflowSha ?? ""))) failures.push(`workflow sha ${describe(workflowSha)} is not a full 40-hex commit`);
  // The workflow definition that is running must BE the commit being published. Otherwise the file
  // whose guards are being trusted is not the file that was reviewed at that commit.
  else if (workflowSha !== sha) failures.push(`workflow sha ${workflowSha} differs from source sha ${describe(sha)}`);
  if (workflowRef !== EXPECTED_WORKFLOW_REF) failures.push(`workflow ref is ${describe(workflowRef)}, expected ${EXPECTED_WORKFLOW_REF}`);
  return failures;
}

/**
 * OP-01's checkout assertion. `actions/checkout` is told `ref: github.sha`; this measures what
 * actually landed, because "we asked for the immutable SHA" and "we are standing on it" are
 * different claims and only the second one is evidence.
 */
export function checkoutFailures(expectedSha, headSha) {
  const failures = [];
  if (!SHA40.test(String(headSha ?? ""))) failures.push(`checked-out HEAD ${describe(headSha)} is not a full 40-hex commit`);
  else if (headSha !== expectedSha) failures.push(`checked-out HEAD ${headSha} is not the dispatch commit ${describe(expectedSha)}`);
  return failures;
}

function describe(value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (value === "") return "empty";
  return JSON.stringify(String(value));
}

// ---------------------------------------------------------------------------
// OP-04 — the digest, and the registry evidence for it
// ---------------------------------------------------------------------------

/** `sha256:` + 64 hex, and nothing else. An empty/missing build output is a failure, not a blank. */
export function assertDigestFormat(digest) {
  if (!DIGEST.test(String(digest ?? ""))) {
    throw new Error(`published digest ${describe(digest)} is not a sha256:<64-hex> registry digest`);
  }
  return String(digest);
}

export function immutableReference(digest) {
  return `${IMAGE}@${assertDigestFormat(digest)}`;
}

/**
 * The registry's own answer, recomputed. `rawManifest` is the exact bytes returned for the by-digest
 * reference (`docker buildx imagetools inspect --raw`).
 *
 * Returns the confirmed descriptor, or throws. There is no "confirmed" argument to pass in — the
 * only way to make this return is to hand it bytes that hash to the digest.
 */
export function confirmRegistryManifest(digest, rawManifest) {
  const claimed = assertDigestFormat(digest);
  const bytes = Buffer.isBuffer(rawManifest) ? rawManifest : Buffer.from(String(rawManifest ?? ""), "utf8");
  if (bytes.length === 0) throw new Error("registry readback returned no manifest bytes");
  const measured = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (measured !== claimed) {
    throw new Error(`registry readback hashes to ${measured}, not the published digest ${claimed}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("registry readback is not parseable JSON");
  }
  const mediaType = typeof parsed?.mediaType === "string" ? parsed.mediaType : undefined;
  if (!mediaType) {
    // Refuses instead of guessing from `config.mediaType`: OP-04 wants the TOP-LEVEL descriptor
    // inspected, and an absent one is an unexpected shape for this build, not a detail to infer past.
    throw new Error("registry readback declares no top-level mediaType; refusing to infer the descriptor shape");
  }
  if (!ACCEPTED_MEDIA_TYPES.includes(mediaType)) {
    throw new Error(
      `registry readback is ${mediaType}; a single-platform attestation-free build must publish an ` +
      `image manifest (${ACCEPTED_MEDIA_TYPES.join(" or ")})`
    );
  }
  return { digest: claimed, mediaType, reference: immutableReference(claimed) };
}

// ---------------------------------------------------------------------------
// OP-06 — package visibility and linkage, with an honest 404
// ---------------------------------------------------------------------------

/**
 * What ONE metadata response means, before deciding what to do about it. The classification is
 * phase-independent on purpose: a 404 means the same thing (absent OR invisible to this token) both
 * before and after a push — what CHANGES is whether that ambiguity is tolerable, and that decision
 * lives in the two functions below.
 */
export function classifyPackageMetadata(response = {}) {
  const { status, body } = response;
  if (status === 200) {
    const visibility = body?.visibility;
    const linkage = body?.repository?.full_name;
    if (visibility !== "private") return { outcome: "refused", reason: `package visibility is ${describe(visibility)}, expected private`, visibility, linkage };
    if (linkage !== REPOSITORY) return { outcome: "refused", reason: `package repository linkage is ${describe(linkage)}, expected ${REPOSITORY}`, visibility, linkage };
    return { outcome: "confirmed", reason: "private and linked to this repository", visibility, linkage };
  }
  if (status === 404) {
    return {
      outcome: "ambiguous",
      reason: "404 — the package is absent OR invisible to this token; this is not proof it does not exist",
    };
  }
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return { outcome: "transient", reason: `metadata endpoint returned ${status}` };
  }
  return { outcome: "refused", reason: `metadata endpoint returned ${describe(status)}` };
}

/** Before the push: confirmed proceeds, 404 proceeds WITH the ambiguity recorded, anything else stops. */
export function prepushDecision(classified) {
  if (classified.outcome === "confirmed") return { proceed: true, status: "confirmed", reason: classified.reason };
  if (classified.outcome === "ambiguous") return { proceed: true, status: "ambiguous-404", reason: classified.reason };
  return { proceed: false, status: "refused", reason: classified.reason };
}

/**
 * After the push: only a measured private+linked package supports a success receipt. Anything else
 * is `published-unverified` — the image IS in the registry and saying otherwise would be a lie; the
 * workflow fails, and nothing is deleted or made public to make the check pass.
 */
export function postpushDecision(classified) {
  if (classified.outcome === "confirmed") return { publicationVerified: true, status: "confirmed", reason: classified.reason };
  return { publicationVerified: false, status: "published-unverified", reason: classified.reason };
}

/**
 * The fixed metadata read. Bounded retries for transient statuses and transport errors only — a 403
 * is an answer, and retrying an answer is just a slower way to accept it.
 */
export async function readPackageMetadata({ token, fetchImpl = globalThis.fetch, attempts = 3, sleep = defaultSleep } = {}) {
  if (!token) throw new Error("no token available for the package metadata read");
  let last = { outcome: "transient", reason: "metadata endpoint was never reached" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let classified;
    try {
      const res = await fetchImpl(PACKAGE_METADATA_URL, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "aios-staging-ops-image-publisher",
        },
      });
      const body = res.status === 200 ? await res.json().catch(() => undefined) : undefined;
      classified = classifyPackageMetadata({ status: res.status, body });
    } catch (error) {
      classified = { outcome: "transient", reason: `metadata read failed: ${error?.message ?? "transport error"}` };
    }
    if (classified.outcome !== "transient") return classified;
    last = classified;
    if (attempt < attempts) await sleep(attempt);
  }
  return { outcome: "refused", reason: `${last.reason} (after ${attempts} attempts)` };
}

const defaultSleep = (attempt) => new Promise((resolve) => setTimeout(resolve, 1000 * attempt));

// ---------------------------------------------------------------------------
// OP-05 — the receipt
// ---------------------------------------------------------------------------

const RECEIPT_FIELDS = Object.freeze([
  "status", "repository", "sourceSha", "workflowRef", "workflowSha", "runId", "runAttempt", "runUrl",
  "platform", "dockerfile", "package", "tag", "digest", "reference", "mediaType", "readbackStatus",
  "packageVisibility", "packageLinkage", "publishedAt",
]);

/** Key names whose VALUE would be a credential. A receipt is traceability evidence, not a secret store. */
const FORBIDDEN_KEY = /token|secret|password|credential|authorization|dockerconfig/i;
/** Value shapes that are credentials regardless of the key they hide behind. */
const FORBIDDEN_VALUE = /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/;

/**
 * A receipt is only well-formed if every field is present AND the digest, reference and readback
 * agree. `mediaType`/`readbackStatus` cannot be set by a caller that never confirmed a manifest,
 * because the only producer of a confirmed descriptor is `confirmRegistryManifest`.
 */
export function validateReceipt(receipt) {
  const failures = [];
  for (const field of RECEIPT_FIELDS) {
    const value = receipt?.[field];
    if (value === undefined || value === null || value === "") failures.push(`receipt field ${field} is ${describe(value)}`);
  }
  if (receipt?.status === "published") {
    if (!DIGEST.test(String(receipt?.digest ?? ""))) failures.push(`receipt digest ${describe(receipt?.digest)} is malformed`);
    else if (receipt?.reference !== `${IMAGE}@${receipt.digest}`) failures.push(`receipt reference ${describe(receipt?.reference)} is not ${IMAGE}@${receipt.digest}`);
    if (!ACCEPTED_MEDIA_TYPES.includes(receipt?.mediaType)) failures.push(`receipt media type ${describe(receipt?.mediaType)} is not a confirmed image manifest`);
    if (receipt?.readbackStatus !== "confirmed") failures.push(`receipt readback status ${describe(receipt?.readbackStatus)} is not confirmed`);
    if (receipt?.packageVisibility !== "private") failures.push(`receipt package visibility ${describe(receipt?.packageVisibility)} is not private`);
    if (receipt?.packageLinkage !== REPOSITORY) failures.push(`receipt package linkage ${describe(receipt?.packageLinkage)} is not ${REPOSITORY}`);
  }
  failures.push(...redactionFailures(receipt));
  return failures;
}

/** Whatever else a receipt says, it must not carry a credential. Checked on every emitted record. */
export function redactionFailures(value, path = "receipt") {
  const failures = [];
  if (value === null || value === undefined) return failures;
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) failures.push(`${path} holds a credential-shaped value`);
    return failures;
  }
  if (typeof value !== "object") return failures;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) failures.push(`${path}.${key} is a credential-bearing field name`);
    failures.push(...redactionFailures(child, `${path}.${key}`));
  }
  return failures;
}

/**
 * What a FAILED run may honestly claim about the registry.
 *
 * Keyed on the build step's own outcome, not on whether a well-formed digest survived: a push that
 * SUCCEEDED and then produced an unusable digest output is still a push. Inferring "nothing was
 * published" from a malformed digest would report the one thing that is definitely false.
 *
 * Callers pass the digest alongside `buildOutcome` — it is deliberately NOT read here, and not
 * bound, so that nothing can drift back into keying the claim on it. The digest's job is naming
 * what is in the registry (`record-failure` writes it into the receipt), not deciding the status.
 */
export function failureRecordStatus({ buildOutcome }) {
  return buildOutcome === "success" ? "partially-published" : "failed";
}

/** The discoverable tag: source SHA plus run id/attempt, so a repeat build cannot overwrite an earlier run's tag. */
export function publicationTag({ sha, runId, runAttempt }) {
  if (!SHA40.test(String(sha ?? ""))) throw new Error(`cannot build a tag from source sha ${describe(sha)}`);
  if (!/^\d+$/.test(String(runId ?? "")) || !/^\d+$/.test(String(runAttempt ?? ""))) {
    throw new Error(`cannot build a tag from run ${describe(runId)} attempt ${describe(runAttempt)}`);
  }
  return `sha-${sha}-run-${runId}.${runAttempt}`;
}

// ---------------------------------------------------------------------------
// CLI — thin. Every decision above is a pure function; this only wires them to the runner.
// ---------------------------------------------------------------------------

function envContext(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  };
}

function headSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function inspectManifest(reference) {
  return execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", reference], { maxBuffer: 8 * 1024 * 1024 });
}

function emit(receipt, { env = process.env, write = writeFileSync, append = appendFileSync } = {}) {
  const leaks = redactionFailures(receipt);
  if (leaks.length) throw new Error(`refusing to write a receipt that carries credentials:\n${leaks.join("\n")}`);
  const path = env.RECEIPT_PATH || "staging-ops-image-receipt.json";
  write(path, `${JSON.stringify(receipt, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(receipt).map(([k, v]) => `| ${k} | ${String(v)} |`).join("\n");
    append(env.GITHUB_STEP_SUMMARY, `## Staging ops image publication\n\n| field | value |\n| --- | --- |\n${rows}\n`);
  }
  return path;
}

/** The record this run has already written, parsed — or nothing, for any unreadable/absent file. */
export function readPublicationRecord(env = process.env, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(env.RECEIPT_PATH || "staging-ops-image-receipt.json", "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Has a measured record already been written for this run? Any unreadable/absent file answers no. */
export function existingRecord(env = process.env, read = readFileSync) {
  const status = readPublicationRecord(env, read)?.status;
  return typeof status === "string" ? status : undefined;
}

function baseRecord(env, now = () => new Date()) {
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    platform: PLATFORM,
    dockerfile: DOCKERFILE,
    package: IMAGE,
    publishedAt: now().toISOString(),
  };
}

/**
 * The ONLY seam between the two record-writing commands and the world: registry inspection, the
 * metadata transport, the receipt file/summary, and the clock. Every default is the real effect, so
 * the CLI path below is unchanged by the existence of this function — a test substitutes an effect,
 * never a decision. Deliberately not a container or a resolver registry: a fixed set of named
 * defaults, resolved once, because the composition and ORDER of the commands is the thing under
 * test and a test that rebuilds either of them proves nothing about what the runner executes.
 */
function resolveEffects(operations = {}) {
  return {
    inspectManifest: operations.inspectManifest ?? inspectManifest,
    fetchImpl: operations.fetchImpl ?? globalThis.fetch,
    sleep: operations.sleep,
    write: operations.write ?? writeFileSync,
    append: operations.append ?? appendFileSync,
    read: operations.read ?? readFileSync,
    // The JOB LOG — the one delivery surface that is not the artifact upload and not the step
    // summary, i.e. the only one still standing when either of those is what failed.
    log: operations.log ?? ((text) => process.stdout.write(text)),
    now: operations.now ?? (() => new Date()),
  };
}

/**
 * OP-04/OP-05/OP-06, composed — the exact body the `verify-publication` step runs.
 *
 * THE ORDER IS THE CONTRACT. On the published-unverified path the record is EMITTED BEFORE the
 * throw, because at that point the image is already in the registry and the measurement of its
 * manifest and its package metadata has already happened. Throwing first would fail the run while
 * discarding the only evidence of what was published — and `record-failure` would then write a
 * coarser record that knows none of it.
 */
export async function runVerifyPublication(env = process.env, operations = {}) {
  const fx = resolveEffects(operations);
  const digest = assertDigestFormat(env.IMAGE_DIGEST);
  const reference = immutableReference(digest);
  const descriptor = confirmRegistryManifest(digest, fx.inspectManifest(reference));
  const classified = await readPackageMetadata({ token: env.GITHUB_TOKEN, fetchImpl: fx.fetchImpl, sleep: fx.sleep });
  const decision = postpushDecision(classified);
  const receipt = {
    ...baseRecord(env, fx.now),
    status: decision.publicationVerified ? "published" : "published-unverified",
    tag: env.IMAGE_TAG,
    digest: descriptor.digest,
    reference: descriptor.reference,
    mediaType: descriptor.mediaType,
    readbackStatus: "confirmed",
    // A field named for a MEASUREMENT holds the measurement or the word `unmeasured` — never the
    // publication status, which has its own field, nor the reason, which is the note. A 404 measured
    // no visibility and no linkage; writing "published-unverified" into `packageVisibility` would
    // put a verdict where a fact belongs and read as a visibility value that does not exist.
    packageVisibility: classified.visibility ?? "unmeasured",
    packageLinkage: classified.linkage ?? "unmeasured",
    note: decision.reason,
  };
  const failures = validateReceipt(receipt);
  if (decision.publicationVerified && failures.length) {
    throw new Error(`receipt is not well-formed:\n- ${failures.join("\n- ")}`);
  }
  emit(receipt, { env, write: fx.write, append: fx.append });
  if (!decision.publicationVerified) {
    throw new Error(
      `published-unverified: ${reference} IS in the registry, but its privacy/linkage could not be ` +
      `established (${decision.reason}). Not deleted, not made public, not reported as "no write".`
    );
  }
  return receipt;
}

/**
 * OP-05's honest failure, composed — the exact body the `record-failure` step runs.
 *
 * Reached via `if: failure()` after EVERY failure, including one that already wrote a MEASURED
 * record (the published-unverified path measured the manifest AND the metadata answer). Overwriting
 * that with this coarser one would destroy evidence in order to say something weaker, so the
 * existing record wins.
 */
export function runRecordFailure(env = process.env, operations = {}) {
  const fx = resolveEffects(operations);
  const preserved = existingRecord(env, fx.read);
  if (preserved) return { preserved: true, status: preserved };
  const digest = DIGEST.test(String(env.IMAGE_DIGEST ?? "")) ? String(env.IMAGE_DIGEST) : undefined;
  const status = failureRecordStatus({ digest, buildOutcome: env.BUILD_OUTCOME });
  const receipt = {
    ...baseRecord(env, fx.now),
    status,
    tag: env.IMAGE_TAG || "unknown",
    digest: digest ?? "unconfirmed",
    reference: digest ? `${IMAGE}@${digest}` : "unconfirmed",
    mediaType: "unconfirmed",
    readbackStatus: "unconfirmed",
    packageVisibility: "unmeasured",
    packageLinkage: "unmeasured",
    note: status === "partially-published"
      ? "the push SUCCEEDED and a later step failed; a retry publishes a NEW run-attempt tag and does not roll this back"
      : "the build/push step did not succeed; nothing is claimed to have been published",
  };
  emit(receipt, { env, write: fx.write, append: fx.append });
  return { preserved: false, status, receipt };
}

// ---------------------------------------------------------------------------
// OP-05 — evidence delivery, accounted for AFTER the upload
// ---------------------------------------------------------------------------

/**
 * OP-05's other half: "a pushed image followed by receipt/upload failure is reported as PARTIALLY
 * PUBLISHED."
 *
 * REGISTRY PUBLICATION AND EVIDENCE DELIVERY ARE DIFFERENT FACTS, and this is the only place that
 * says both. `record-failure` runs BEFORE the upload, so an upload that fails after a verified run
 * leaves the job red with a receipt that says `published` and nothing anywhere saying the evidence
 * never arrived. Likewise a receipt file that was written and then failed to reach the step summary.
 *
 * What it does NOT do: it never writes, re-writes or demotes the measured receipt. That record was
 * measured — the manifest was recomputed from registry bytes and the package metadata was read — and
 * a delivery failure afterwards changes nothing about what is in the registry. The correction owed
 * here is an account of the DELIVERY, not an edit to the measurement.
 */
export function deliveryReport({ buildOutcome, verifyOutcome, uploadOutcome, record } = {}) {
  const incomplete = [];
  if (verifyOutcome !== "success") incomplete.push(`receipt emission (verify-publication outcome ${describe(verifyOutcome)})`);
  if (uploadOutcome !== "success") incomplete.push(`receipt artifact upload (outcome ${describe(uploadOutcome)})`);
  // Keyed on the BUILD STEP's own outcome, exactly as `failureRecordStatus` is: without a successful
  // push there is no publication to call partial, and claiming one would be the false direction.
  if (buildOutcome !== "success" || incomplete.length === 0) return { partial: false, incomplete };

  const recordStatus = typeof record?.status === "string" && record.status !== "" ? record.status : "absent";
  const digest = DIGEST.test(String(record?.digest ?? "")) ? String(record.digest) : undefined;
  const reference = digest ? `${IMAGE}@${digest}` : "unconfirmed";
  // `confirmed` is the ONE receipt status that means the manifest was recomputed from registry bytes
  // AND the package measured private and linked — and it must still NAME what was published, or
  // there is nothing to confirm. Every other status, including the deliberately stronger
  // `published-unverified`, is reported as `unverified`, which is what is actually known.
  const registryPublication = recordStatus === "published" && digest ? "confirmed" : "unverified";
  const lines = [
    "workflow outcome: partially-published",
    registryPublication === "confirmed"
      ? `registry publication: confirmed — ${reference} (measured receipt status: ${recordStatus})`
      : `registry publication: unverified — the build/push step succeeded, so an image may be in the registry; ` +
        `it was not confirmed here (measured receipt status: ${recordStatus}, digest: ${reference})`,
    `evidence delivery: incomplete — ${incomplete.join("; ")}`,
    "the registry is not touched by this report: nothing is deleted, rolled back or re-published " +
    "automatically, and a coordinator retry publishes a NEW run-attempt tag.",
    "the measured receipt is left exactly as it was written; this is the delivery account the run " +
    "could not deliver, not a correction to it.",
  ];
  return {
    partial: true,
    outcome: "partially-published",
    registryPublication,
    evidenceDelivery: "incomplete",
    recordStatus,
    reference,
    incomplete,
    lines,
    message: [
      `::warning::staging ops publisher: partially-published — registry publication ${registryPublication}, evidence delivery incomplete`,
      ...lines,
    ].join("\n"),
  };
}

/**
 * The exact body the post-upload `report-delivery` step runs.
 *
 * THE JOB LOG IS THE REQUIRED SURFACE and the summary is best effort, because on one of the two
 * paths this exists for the summary append IS the transport that failed. It cannot throw: the run is
 * already red for the original reason, and that reason must stay the loudest thing in it.
 */
export function runReportDelivery(env = process.env, operations = {}) {
  const fx = resolveEffects(operations);
  const report = deliveryReport({
    buildOutcome: env.BUILD_OUTCOME,
    verifyOutcome: env.VERIFY_OUTCOME,
    uploadOutcome: env.UPLOAD_OUTCOME,
    record: readPublicationRecord(env, fx.read),
  });
  if (!report.partial) return report;
  fx.log(`${report.message}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fx.append(
        env.GITHUB_STEP_SUMMARY,
        `\n## Staging ops image publication — partially published\n\n${report.lines.map((l) => `- ${l}`).join("\n")}\n`,
      );
    } catch (error) {
      fx.log(`(the job summary could not be appended: ${error?.message ?? "unknown error"}; the warning above is the record)\n`);
    }
  }
  return report;
}

async function main(argv, env) {
  const command = argv[2];

  if (command === "verify-context") {
    const failures = [...dispatchContextFailures(envContext(env)), ...checkoutFailures(env.GITHUB_SHA, headSha())];
    if (failures.length) throw new Error(`refusing an untrusted publisher context:\n- ${failures.join("\n- ")}`);
    process.stdout.write(`context verified: ${REPOSITORY}@${env.GITHUB_SHA} on ${SOURCE_REF}\n`);
    return;
  }

  if (command === "precheck-package") {
    const classified = await readPackageMetadata({ token: env.GITHUB_TOKEN });
    const decision = prepushDecision(classified);
    process.stdout.write(`package precheck: ${decision.status} — ${decision.reason}\n`);
    if (!decision.proceed) throw new Error(`refusing to push: ${decision.reason}`);
    return;
  }

  if (command === "verify-publication") {
    const receipt = await runVerifyPublication(env);
    process.stdout.write(`published ${receipt.reference} (${receipt.mediaType})\n`);
    return;
  }

  if (command === "record-failure") {
    const outcome = runRecordFailure(env);
    process.stdout.write(outcome.preserved
      ? `a measured publication record already exists (${outcome.status}); leaving it untouched\n`
      : `recorded ${outcome.status}\n`);
    return;
  }

  if (command === "report-delivery") {
    const report = runReportDelivery(env);
    if (!report.partial) {
      process.stdout.write("no partial publication to report: the push did not succeed, or the receipt was delivered\n");
    }
    return;
  }

  throw new Error(
    `unknown command ${describe(command)}; expected verify-context | precheck-package | verify-publication | ` +
    `record-failure | report-delivery`
  );
}

/* c8 ignore start — the CLI edge; every decision it reaches is unit-tested above. */
if (isDirectEntry(import.meta.url)) {
  main(process.argv, process.env).catch((error) => {
    process.stderr.write(`staging ops image publisher refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
