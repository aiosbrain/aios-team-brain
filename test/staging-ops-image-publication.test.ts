/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_MEDIA_TYPES,
  EXPECTED_WORKFLOW_REF,
  IMAGE,
  PACKAGE_METADATA_URL,
  REPOSITORY,
  assertDigestFormat,
  checkoutFailures,
  classifyPackageMetadata,
  confirmRegistryManifest,
  deliveryReport,
  dispatchContextFailures,
  existingRecord,
  failureRecordStatus,
  immutableReference,
  postpushDecision,
  prepushDecision,
  publicationTag,
  readPackageMetadata,
  redactionFailures,
  runRecordFailure,
  runReportDelivery,
  runVerifyPublication,
  validateReceipt,
} from "../scripts/staging-ops/image-publication.mjs";

const SHA = "d74fe08bad532e48d6d91199093189960033f77f";
const OTHER_SHA = "c5a13844d6ff0280f447137c668924dc59a71c32";

const trustedContext = (over: Record<string, unknown> = {}) => ({
  repository: REPOSITORY,
  eventName: "workflow_dispatch",
  ref: "refs/heads/staging",
  sha: SHA,
  workflowSha: SHA,
  workflowRef: EXPECTED_WORKFLOW_REF,
  ...over,
});

/** A real manifest is bytes; its digest is the sha256 OF those bytes. Fixtures must respect that. */
function manifest(mediaType: string | undefined, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ schemaVersion: 2, ...(mediaType ? { mediaType } : {}), ...extra });
  return { bytes: body, digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}

describe("OP-01 — only one dispatch context may publish", () => {
  it("accepts the one trusted context", () => {
    expect(dispatchContextFailures(trustedContext())).toEqual([]);
  });

  // ONE CONDITION PER FIXTURE. A fixture that trips two terms proves only whichever is checked
  // first, so each of these is the trusted context with EXACTLY one thing wrong.
  it.each([
    ["a fork or any other repository", { repository: "attacker/aios-team-brain" }],
    ["a non-dispatch event", { eventName: "push" }],
    ["a ref that is not staging", { ref: "refs/heads/main" }],
    ["a tag ref", { ref: "refs/tags/v1.0.0" }],
    ["a short sha", { sha: "d74fe08", workflowSha: "d74fe08" }],
    ["a non-hex sha", { sha: "z".repeat(40), workflowSha: "z".repeat(40) }],
    ["an absent sha", { sha: undefined, workflowSha: undefined }],
    ["a workflow definition from a DIFFERENT commit than the source", { workflowSha: OTHER_SHA }],
    ["an absent workflow sha", { workflowSha: undefined }],
    ["a workflow ref from another branch", { workflowRef: `${REPOSITORY}/.github/workflows/staging-ops-image.yml@refs/heads/attacker` }],
    ["a workflow ref naming another file", { workflowRef: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/staging` }],
    ["an absent workflow ref", { workflowRef: undefined }],
  ])("refuses %s", (_label, over) => {
    expect(dispatchContextFailures(trustedContext(over as Record<string, unknown>))).not.toEqual([]);
  });

  it("reports EVERY reason, not just the first, so a misconfigured dispatch is fixed in one pass", () => {
    const failures = dispatchContextFailures({ repository: "x/y", eventName: "push", ref: "refs/heads/main", sha: "nope" });
    expect(failures.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses an empty context outright rather than defaulting to trust", () => {
    expect(dispatchContextFailures()).not.toEqual([]);
    expect(dispatchContextFailures({})).not.toEqual([]);
  });
});

describe("OP-01 — the checkout is measured, not assumed", () => {
  it("accepts a HEAD equal to the dispatch commit", () => {
    expect(checkoutFailures(SHA, SHA)).toEqual([]);
  });

  it.each([
    ["a different commit — the moving-branch failure this exists to catch", OTHER_SHA],
    ["an abbreviated HEAD", SHA.slice(0, 7)],
    ["an empty HEAD", ""],
    ["an absent HEAD", undefined],
  ])("refuses %s", (_label, head) => {
    expect(checkoutFailures(SHA, head as string)).not.toEqual([]);
  });
});

describe("OP-04 — the digest is a registry digest, and the registry proves it", () => {
  it.each([
    ["an empty digest", ""],
    ["an absent digest", undefined],
    ["a bare hex string with no algorithm", "a".repeat(64)],
    ["a truncated digest", `sha256:${"a".repeat(63)}`],
    ["an over-long digest", `sha256:${"a".repeat(65)}`],
    ["uppercase hex", `sha256:${"A".repeat(64)}`],
    ["a local docker image ID shape", "sha256:not-a-hex-digest"],
  ])("refuses %s", (_label, digest) => {
    expect(() => assertDigestFormat(digest as string)).toThrow();
  });

  it("composes the fixed by-digest reference from a well-formed digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(immutableReference(digest)).toBe(`${IMAGE}@${digest}`);
  });

  it("confirms a docker schema2 image manifest whose bytes hash to the published digest", () => {
    const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
    expect(confirmRegistryManifest(m.digest, m.bytes)).toMatchObject({
      digest: m.digest,
      mediaType: ACCEPTED_MEDIA_TYPES[0],
      reference: `${IMAGE}@${m.digest}`,
    });
  });

  it("confirms an OCI image manifest too", () => {
    const m = manifest(ACCEPTED_MEDIA_TYPES[1]);
    expect(confirmRegistryManifest(m.digest, m.bytes).mediaType).toBe(ACCEPTED_MEDIA_TYPES[1]);
  });

  /**
   * THE POINT OF THE WHOLE HELPER. `docker/build-push-action` also exposes `imageid` — the local
   * image CONFIG digest. It is a perfectly well-formed `sha256:<64-hex>`, so no format check can
   * tell it from the manifest digest. What tells them apart is that the registry's bytes at the
   * by-digest reference do not hash to it.
   */
  it("refuses a config/imageid digest, which is well-formed but names nothing in the registry", () => {
    const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
    const imageid = `sha256:${createHash("sha256").update("the local image config").digest("hex")}`;
    expect(imageid).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => confirmRegistryManifest(imageid, m.bytes)).toThrow(/hashes to .*not the published digest/);
  });

  it("refuses a manifest whose bytes were altered after the digest was taken", () => {
    const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
    expect(() => confirmRegistryManifest(m.digest, `${m.bytes} `)).toThrow(/hashes to/);
  });

  it("refuses an empty readback — no bytes is not a confirmation", () => {
    expect(() => confirmRegistryManifest(`sha256:${"a".repeat(64)}`, "")).toThrow(/no manifest bytes/);
  });

  it("refuses a readback that is not JSON, even when it hashes correctly", () => {
    const body = "<html>not a manifest</html>";
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    expect(() => confirmRegistryManifest(digest, body)).toThrow(/not parseable JSON/);
  });

  it.each([
    ["a docker manifest LIST", "application/vnd.docker.distribution.manifest.list.v2+json"],
    ["an OCI image INDEX — what an attestation-carrying build produces", "application/vnd.oci.image.index.v1+json"],
    ["an unrelated descriptor", "application/vnd.oci.artifact.manifest.v1+json"],
  ])("refuses %s instead of guessing which child is the artifact", (_label, mediaType) => {
    const m = manifest(mediaType);
    expect(() => confirmRegistryManifest(m.digest, m.bytes)).toThrow(/image manifest/);
  });

  it("refuses a readback with NO top-level mediaType rather than inferring it from the config", () => {
    const m = manifest(undefined, { config: { mediaType: "application/vnd.oci.image.config.v1+json" } });
    expect(() => confirmRegistryManifest(m.digest, m.bytes)).toThrow(/no top-level mediaType/);
  });
});

describe("OP-06 — package metadata, with a 404 that stays ambiguous", () => {
  const priv = { visibility: "private", repository: { full_name: REPOSITORY } };

  it("confirms a private package linked to this repository", () => {
    expect(classifyPackageMetadata({ status: 200, body: priv })).toMatchObject({ outcome: "confirmed" });
  });

  it.each([
    ["a public package", { status: 200, body: { ...priv, visibility: "public" } }],
    ["an internal package", { status: 200, body: { ...priv, visibility: "internal" } }],
    ["absent visibility", { status: 200, body: { repository: { full_name: REPOSITORY } } }],
    ["linkage to another repository", { status: 200, body: { ...priv, repository: { full_name: "aiosbrain/other" } } }],
    ["null linkage", { status: 200, body: { ...priv, repository: null } }],
    ["absent linkage", { status: 200, body: { visibility: "private" } }],
    ["an unauthenticated read", { status: 401 }],
    ["a forbidden read", { status: 403 }],
    ["an unexpected 400", { status: 400 }],
    ["an absent status", {}],
  ])("refuses %s", (_label, response) => {
    expect(classifyPackageMetadata(response as any).outcome).toBe("refused");
  });

  it.each([
    ["rate limiting", 429],
    ["a bad gateway", 502],
    ["a server error", 500],
  ])("treats %s as transient, not as an answer", (_label, status) => {
    expect(classifyPackageMetadata({ status }).outcome).toBe("transient");
  });

  it("calls a 404 ABSENT-OR-INVISIBLE and never 'proven new'", () => {
    const classified = classifyPackageMetadata({ status: 404 });
    expect(classified.outcome).toBe("ambiguous");
    expect(classified.reason).toMatch(/absent OR invisible/);
    // The wording is load-bearing: a 404 read as "the package is new" is the false claim this
    // classification exists to prevent, so the reason states the negative explicitly.
    expect(classified.reason).toMatch(/not proof/);
  });

  it("lets a 404 proceed to ONE bounded push before the push, carrying the ambiguity", () => {
    expect(prepushDecision(classifyPackageMetadata({ status: 404 }))).toMatchObject({ proceed: true, status: "ambiguous-404" });
  });

  it.each([
    ["a public package", 200, { ...priv, visibility: "public" }],
    ["a forbidden read", 403, undefined],
  ])("stops before any push on %s", (_label, status, body) => {
    expect(prepushDecision(classifyPackageMetadata({ status, body })).proceed).toBe(false);
  });

  it("verifies publication only on a measured private+linked package", () => {
    expect(postpushDecision(classifyPackageMetadata({ status: 200, body: priv })).publicationVerified).toBe(true);
  });

  /** The asymmetry IS the contract: the same 404 that was tolerable before the push is not after it. */
  it.each([
    ["a 404 after the push", 404, undefined],
    ["a public package after the push", 200, { ...priv, visibility: "public" }],
    ["missing linkage after the push", 200, { visibility: "private" }],
    ["a forbidden read after the push", 403, undefined],
  ])("reports published-unverified for %s", (_label, status, body) => {
    const decision = postpushDecision(classifyPackageMetadata({ status, body }));
    expect(decision).toMatchObject({ publicationVerified: false, status: "published-unverified" });
  });

  it("retries only transient answers, and gives up bounded", async () => {
    const seen: number[] = [];
    let call = 0;
    const fetchImpl = async () => { seen.push(++call); return { status: 503, json: async () => ({}) }; };
    const classified = await readPackageMetadata({ token: "t", fetchImpl: fetchImpl as any, attempts: 3, sleep: async () => {} });
    expect(seen).toEqual([1, 2, 3]);
    expect(classified.outcome).toBe("refused");
  });

  it("does NOT retry a 403 — an answer is not a flake", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { status: 403, json: async () => ({}) }; };
    expect((await readPackageMetadata({ token: "t", fetchImpl: fetchImpl as any, sleep: async () => {} })).outcome).toBe("refused");
    expect(calls).toBe(1);
  });

  it("recovers when a transient answer is followed by a real one", async () => {
    const answers = [{ status: 500 }, { status: 200, body: priv }];
    const fetchImpl = async () => {
      const next = answers.shift()!;
      return { status: next.status, json: async () => (next as any).body };
    };
    expect((await readPackageMetadata({ token: "t", fetchImpl: fetchImpl as any, sleep: async () => {} })).outcome).toBe("confirmed");
  });

  it("reads the ONE fixed organization endpoint, with the token in the header", async () => {
    let url: string | undefined;
    let headers: Record<string, string> | undefined;
    const fetchImpl = async (u: string, init: any) => { url = u; headers = init.headers; return { status: 200, json: async () => priv }; };
    await readPackageMetadata({ token: "secret-token", fetchImpl: fetchImpl as any });
    expect(url).toBe(PACKAGE_METADATA_URL);
    expect(url).toBe("https://api.github.com/orgs/aiosbrain/packages/container/aios-staging-ops");
    expect(headers?.authorization).toBe("Bearer secret-token");
  });

  it("refuses to read with no token rather than probing anonymously", async () => {
    await expect(readPackageMetadata({ token: "" } as any)).rejects.toThrow(/no token/);
  });

  it("treats a transport error as transient, not as a 404", async () => {
    const fetchImpl = async () => { throw new Error("ECONNRESET"); };
    const classified = await readPackageMetadata({ token: "t", fetchImpl: fetchImpl as any, attempts: 2, sleep: async () => {} });
    expect(classified.outcome).toBe("refused");
    expect(classified.reason).toMatch(/ECONNRESET/);
  });
});

describe("OP-05 — the receipt, and what it must never carry", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const receipt = () => ({
    status: "published",
    repository: REPOSITORY,
    sourceSha: SHA,
    workflowRef: EXPECTED_WORKFLOW_REF,
    workflowSha: SHA,
    runId: "42",
    runAttempt: "1",
    runUrl: "https://github.com/aiosbrain/aios-team-brain/actions/runs/42/attempts/1",
    platform: "linux/amd64",
    dockerfile: "docker/staging-ops.Dockerfile",
    package: IMAGE,
    tag: publicationTag({ sha: SHA, runId: "42", runAttempt: "1" }),
    digest,
    reference: `${IMAGE}@${digest}`,
    mediaType: ACCEPTED_MEDIA_TYPES[0],
    readbackStatus: "confirmed",
    packageVisibility: "private",
    packageLinkage: REPOSITORY,
    publishedAt: "2026-09-09T00:00:00.000Z",
  });

  it("accepts a complete, confirmed receipt", () => {
    expect(validateReceipt(receipt())).toEqual([]);
  });

  it.each([
    "status", "repository", "sourceSha", "workflowRef", "workflowSha", "runId", "runAttempt", "runUrl",
    "platform", "dockerfile", "package", "tag", "digest", "reference", "mediaType", "readbackStatus",
    "packageVisibility", "packageLinkage", "publishedAt",
  ])("refuses a receipt missing %s", (field) => {
    const r: any = receipt();
    delete r[field];
    expect(validateReceipt(r)).not.toEqual([]);
  });

  it.each([
    ["an unconfirmed readback", { readbackStatus: "unconfirmed" }],
    ["a malformed digest", { digest: "sha256:short" }],
    ["a reference that does not match the digest", { reference: `${IMAGE}@sha256:${"c".repeat(64)}` }],
    ["a reference to another package", { reference: `ghcr.io/aiosbrain/something-else@${digest}` }],
    ["an index media type", { mediaType: "application/vnd.oci.image.index.v1+json" }],
    ["a public package", { packageVisibility: "public" }],
    ["linkage to another repository", { packageLinkage: "aiosbrain/other" }],
  ])("refuses a success receipt claiming %s", (_label, over) => {
    expect(validateReceipt({ ...receipt(), ...over })).not.toEqual([]);
  });

  it("does not demand confirmed evidence from a receipt that does NOT claim publication", () => {
    // A partial/failed record must still be emittable — that is the honest-failure path.
    const failed = { ...receipt(), status: "partially-published", mediaType: "unconfirmed", readbackStatus: "unconfirmed", packageVisibility: "unmeasured", packageLinkage: "unmeasured" };
    expect(validateReceipt(failed)).toEqual([]);
  });

  it.each([
    ["a token field", { token: "x" }],
    ["a nested secret", { build: { registrySecret: "x" } }],
    ["a docker auth config", { dockerconfigjson: "{}" }],
    ["an authorization header", { authorization: "Bearer x" }],
    ["a password", { password: "hunter2" }],
  ])("refuses %s by field name", (_label, over) => {
    expect(redactionFailures({ ...receipt(), ...over })).not.toEqual([]);
  });

  it.each([
    ["a classic PAT", "ghp_0123456789abcdefghijklmnopqrstuvwx"],
    ["an Actions token", "ghs_0123456789abcdefghijklmnopqrstuvwx"],
    ["a fine-grained PAT", "github_pat_11ABCDEFG0abcdefghijklmnop"],
  ])("refuses %s hiding under an innocent field name", (_label, value) => {
    expect(redactionFailures({ ...receipt(), note: value })).not.toEqual([]);
  });

  it("is not vacuous: the real receipt shape carries no credential", () => {
    expect(redactionFailures(receipt())).toEqual([]);
  });
});

describe("OP-04 — the tag cannot collide across runs", () => {
  it("names the source commit, the run and the attempt", () => {
    expect(publicationTag({ sha: SHA, runId: "42", runAttempt: "2" })).toBe(`sha-${SHA}-run-42.2`);
  });

  it("gives a re-run of the SAME commit a different tag, so nothing is overwritten", () => {
    const first = publicationTag({ sha: SHA, runId: "42", runAttempt: "1" });
    const retry = publicationTag({ sha: SHA, runId: "42", runAttempt: "2" });
    const later = publicationTag({ sha: SHA, runId: "43", runAttempt: "1" });
    expect(new Set([first, retry, later]).size).toBe(3);
  });

  it("is a legal docker tag", () => {
    expect(publicationTag({ sha: SHA, runId: "1", runAttempt: "1" })).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
  });

  it.each([
    ["a short sha", { sha: "d74fe08", runId: "1", runAttempt: "1" }],
    ["an absent sha", { runId: "1", runAttempt: "1" }],
    ["a non-numeric run id", { sha: SHA, runId: "$(id)", runAttempt: "1" }],
    ["an absent attempt", { sha: SHA, runId: "1" }],
  ])("refuses to build a tag from %s", (_label, input) => {
    expect(() => publicationTag(input as any)).toThrow();
  });
});

describe("OP-05 — a failed run claims only what the build step actually did", () => {
  const digest = `sha256:${"d".repeat(64)}`;

  it("calls a failure AFTER a successful push partially published", () => {
    expect(failureRecordStatus({ digest, buildOutcome: "success" })).toBe("partially-published");
  });

  /**
   * The mutant this replaces. Keying on the digest alone read a malformed digest output as "nothing
   * was published" — on a run where the push had already succeeded, which is the single claim that
   * is definitely false. The build step's own outcome is the fact that decides it.
   */
  it("still says partially-published when the push succeeded but the digest output was unusable", () => {
    expect(failureRecordStatus({ digest: undefined, buildOutcome: "success" })).toBe("partially-published");
  });

  it.each([
    ["the push itself failed", "failure"],
    ["the build never ran — an earlier step refused", ""],
    ["the build step was skipped", "skipped"],
    ["no outcome was reported", undefined],
  ])("claims no publication when %s", (_label, buildOutcome) => {
    expect(failureRecordStatus({ digest: undefined, buildOutcome })).toBe("failed");
  });
});

/**
 * OP-05's OTHER half — "a pushed image followed by receipt/upload failure is reported as partially
 * published". Registry publication and evidence delivery are DIFFERENT FACTS, and this decision is
 * the only place that reports both: what the run measured about the registry, and whether the
 * evidence of it actually got out.
 */
describe("OP-05 — evidence delivery is accounted for separately from registry publication", () => {
  const digest = `sha256:${"f".repeat(64)}`;
  const published = { status: "published", digest };
  const outcomes = (over: Record<string, unknown> = {}) => ({
    buildOutcome: "success",
    verifyOutcome: "success",
    uploadOutcome: "success",
    record: published,
    ...over,
  });

  it("says nothing at all when the build succeeded and BOTH evidence steps did too", () => {
    expect(deliveryReport(outcomes()).partial).toBe(false);
  });

  // ONE CONDITION PER FIXTURE: each of these is the all-success case with exactly one step failed.
  it.each([
    ["the receipt emission failed", { verifyOutcome: "failure" }],
    ["the receipt emission was cancelled", { verifyOutcome: "cancelled" }],
    ["the artifact upload failed", { uploadOutcome: "failure" }],
    ["the artifact upload never reported an outcome", { uploadOutcome: undefined }],
  ])("reports partially-published when %s", (_label, over) => {
    expect(deliveryReport(outcomes(over))).toMatchObject({
      partial: true,
      outcome: "partially-published",
      registryPublication: "confirmed",
      evidenceDelivery: "incomplete",
    });
  });

  /**
   * The direction that would be a LIE. Without a successful push there is no publication to call
   * partial — this is keyed on the build step's own outcome for the same reason
   * `failureRecordStatus` is.
   */
  it.each([
    ["the push itself failed", "failure"],
    ["the build never ran", ""],
    ["the build step was skipped", "skipped"],
    ["no outcome was reported", undefined],
  ])("asserts no publication at all when %s, even with both evidence steps failed", (_label, buildOutcome) => {
    const report = deliveryReport({ buildOutcome, verifyOutcome: "failure", uploadOutcome: "failure", record: { status: "failed" } });
    expect(report.partial).toBe(false);
    expect(report).not.toHaveProperty("registryPublication");
  });

  /** `confirmed` is the one status that MEASURED both the manifest and the package. Nothing else. */
  it.each([
    ["a measured published-unverified record keeps its stronger distinction", { status: "published-unverified", digest }],
    ["a coarse partially-published record", { status: "partially-published", digest: "unconfirmed" }],
    ["a failed record", { status: "failed", digest: "unconfirmed" }],
    ["no record on disk at all", undefined],
    ["a record with no status", { digest }],
    ["a published record that names no well-formed digest — nothing to confirm", { status: "published" }],
    ["a published record whose digest is malformed", { status: "published", digest: "sha256:nope" }],
  ])("reports registry publication as UNVERIFIED for %s", (_label, record) => {
    const report = deliveryReport(outcomes({ uploadOutcome: "failure", record }));
    expect(report.registryPublication).toBe("unverified");
    expect(report.message).toContain("registry publication: unverified");
    expect(report.message).not.toContain("registry publication: confirmed");
  });

  it("names the confirmed by-digest reference, and `unconfirmed` when no digest was recorded", () => {
    expect(deliveryReport(outcomes({ uploadOutcome: "failure" })).reference).toBe(`${IMAGE}@${digest}`);
    expect(deliveryReport(outcomes({ uploadOutcome: "failure", record: { status: "published" } })).reference).toBe("unconfirmed");
    // A malformed digest in the record names nothing in the registry and must not be echoed as if
    // it did — the same refusal `assertDigestFormat` makes everywhere else.
    expect(deliveryReport(outcomes({ uploadOutcome: "failure", record: { status: "published", digest: "sha256:nope" } })).reference).toBe("unconfirmed");
  });

  it("states the two facts separately and rules out an automatic repair", () => {
    const report = deliveryReport(outcomes({ uploadOutcome: "failure" }));
    expect(report.message).toContain("workflow outcome: partially-published");
    expect(report.message).toContain("registry publication: confirmed");
    expect(report.message).toContain("evidence delivery: incomplete");
    expect(report.message).toMatch(/nothing is deleted, rolled back or re-published/);
    expect(report.message).toMatch(/NEW run-attempt tag/);
    // It names which delivery step failed, so an operator is not left guessing which half is missing.
    expect(report.message).toContain("receipt artifact upload");
  });
});

describe("OP-05 — a measured record is never overwritten by a coarser one", () => {
  it("reports an existing record's status", () => {
    const read = () => JSON.stringify({ status: "published-unverified" });
    expect(existingRecord({ RECEIPT_PATH: "r.json" }, read as any)).toBe("published-unverified");
  });

  it.each([
    ["no file at all", () => { throw new Error("ENOENT"); }],
    ["an unparseable file", () => "not json"],
    ["a file with no status", () => JSON.stringify({ digest: "x" })],
  ])("answers 'none' for %s, so the failure record still gets written", (_label, read) => {
    expect(existingRecord({ RECEIPT_PATH: "r.json" }, read as any)).toBeUndefined();
  });
});

/**
 * THE COMMANDS THEMSELVES — `runVerifyPublication`, `runRecordFailure` and `runReportDelivery` are
 * the exact function bodies the workflow's two record-writing steps and its post-upload reporting
 * step execute; the CLI below them only prints.
 *
 * WHY THIS TIER EXISTS SEPARATELY FROM EVERYTHING ABOVE. Every decision above is pure and green in
 * isolation, and stays green while the COMPOSITION is wrong: swap the emit past the
 * published-unverified throw and the run still fails for the right reason, still refuses the right
 * things — and silently loses the only record of a push that really happened. Order and wiring are
 * only observable by running the composition, so these tests run it, with the world (registry
 * inspection, metadata transport, receipt file/summary, clock) injected and NOTHING re-implemented.
 * A duplicate pure receipt-builder here would prove only that the duplicate agrees with itself.
 */
describe("the publisher's record-writing and reporting commands, composed", () => {
  const RECEIPT = "staging-ops-image-receipt.json";
  const SUMMARY = "step-summary.md";
  const AT = "2026-09-09T00:00:00.000Z";
  const linked = { visibility: "private", repository: { full_name: REPOSITORY } };

  /** A receipt file is a file. Nothing here touches the real one, and no test writes to disk. */
  function memoryFs(seed: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(seed));
    return {
      files,
      record: () => JSON.parse(files.get(RECEIPT) ?? "null"),
      write: (path: string, contents: string) => { files.set(path, contents); },
      append: (path: string, contents: string) => { files.set(path, (files.get(path) ?? "") + contents); },
      read: (path: string) => {
        if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return files.get(path)!;
      },
    };
  }

  const runEnv = (over: Record<string, unknown> = {}) => ({
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_SHA: SHA,
    GITHUB_WORKFLOW_REF: EXPECTED_WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_TOKEN: "job-token",
    RECEIPT_PATH: RECEIPT,
    GITHUB_STEP_SUMMARY: SUMMARY,
    IMAGE_TAG: publicationTag({ sha: SHA, runId: "42", runAttempt: "1" }),
    ...over,
  }) as any;

  /**
   * Only effects are substituted. `inspectManifest` stands in for `docker buildx imagetools inspect
   * --raw` and `fetchImpl` for the one metadata endpoint, so `confirmRegistryManifest`,
   * `classifyPackageMetadata`, `postpushDecision`, `validateReceipt` and `emit` are the real ones,
   * called in the real order by the real command.
   */
  function effects(fs: ReturnType<typeof memoryFs>, opts: {
    manifest?: string | (() => string);
    metadata?: { status: number; body?: unknown };
    inspected?: string[];
    logged?: string[];
  } = {}) {
    return {
      inspectManifest: (reference: string) => {
        opts.inspected?.push(reference);
        const bytes = opts.manifest;
        if (bytes === undefined) throw new Error("the registry readback was not stubbed for this case");
        return typeof bytes === "function" ? bytes() : bytes;
      },
      fetchImpl: async () => ({
        status: opts.metadata?.status ?? 500,
        json: async () => opts.metadata?.body,
      }),
      sleep: async () => {},
      write: fs.write,
      append: fs.append,
      read: fs.read,
      log: (text: string) => { opts.logged?.push(text); },
      now: () => new Date(AT),
    } as any;
  }

  /** The transport that IS the failure on one of the two paths the delivery report exists for. */
  const throwingAppend = () => { throw new Error("simulated summary-write failure"); };

  describe("verify-publication", () => {
    it("writes a valid published receipt from a CONFIRMED raw descriptor and private linked metadata", async () => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const fs = memoryFs();
      const inspected: string[] = [];
      const receipt = await runVerifyPublication(
        runEnv({ IMAGE_DIGEST: m.digest }),
        effects(fs, { manifest: m.bytes, metadata: { status: 200, body: linked }, inspected }),
      );

      // The registry was asked about the EXACT by-digest reference, not a tag and not a local image.
      expect(inspected).toEqual([`${IMAGE}@${m.digest}`]);
      // …and the record on disk is the record, not just the return value.
      const written = fs.record();
      expect(written).toEqual(receipt);
      expect(written).toMatchObject({
        status: "published",
        digest: m.digest,
        reference: `${IMAGE}@${m.digest}`,
        mediaType: ACCEPTED_MEDIA_TYPES[0],
        readbackStatus: "confirmed",
        packageVisibility: "private",
        packageLinkage: REPOSITORY,
        sourceSha: SHA,
        workflowRef: EXPECTED_WORKFLOW_REF,
        platform: "linux/amd64",
        publishedAt: AT,
      });
      // Validated by the SAME validator the success path gates on, and carrying no credential.
      expect(validateReceipt(written)).toEqual([]);
      expect(redactionFailures(written)).toEqual([]);
      expect(fs.files.get(SUMMARY)).toContain(m.digest);
    });

    /**
     * THE ORDERING PIN. At this point the image IS in the registry and its manifest and package
     * metadata have both been measured. Emitting after the throw would fail the run for the right
     * reason while discarding that evidence — and `record-failure` would then write a coarser
     * record that knows none of it. Awaiting the rejection FIRST and finding the record already
     * written is what makes the swapped order red.
     */
    const unverified: Array<{ label: string; status: number; body?: unknown; visibility: string; linkage: string }> = [
      { label: "a package that is not private", status: 200, body: { ...linked, visibility: "public" }, visibility: "public", linkage: REPOSITORY },
      { label: "a package linked to another repository", status: 200, body: { visibility: "private", repository: { full_name: "aiosbrain/other" } }, visibility: "private", linkage: "aiosbrain/other" },
      { label: "metadata that is unavailable (404 absent-or-invisible)", status: 404, visibility: "unmeasured", linkage: "unmeasured" },
      { label: "metadata that is forbidden", status: 403, visibility: "unmeasured", linkage: "unmeasured" },
    ];

    it.each(unverified)("emits the MEASURED published-unverified record BEFORE rejecting on $label", async ({ status, body, visibility, linkage }) => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[1]);
      const fs = memoryFs();
      await expect(runVerifyPublication(
        runEnv({ IMAGE_DIGEST: m.digest }),
        effects(fs, { manifest: m.bytes, metadata: { status, body } }),
      )).rejects.toThrow(/published-unverified/);

      const written = fs.record();
      expect(written, "the run rejected without leaving any record of what was published").not.toBeNull();
      expect(written).toMatchObject({
        status: "published-unverified",
        // The digest and the confirmed descriptor survive: this is the evidence that would be lost.
        digest: m.digest,
        reference: `${IMAGE}@${m.digest}`,
        mediaType: ACCEPTED_MEDIA_TYPES[1],
        readbackStatus: "confirmed",
        // L3 — a field named for a MEASUREMENT holds the measurement or the word `unmeasured`.
        // Never the publication status, which has its own field, nor the reason, which is the note.
        packageVisibility: visibility,
        packageLinkage: linkage,
      });
      expect(written.packageVisibility).not.toBe("published-unverified");
      expect(written.packageLinkage).not.toBe("published-unverified");
      expect(typeof written.note).toBe("string");
      expect(written.note).not.toBe("");
      expect(redactionFailures(written)).toEqual([]);
      // The summary is the operator-visible half of the same record, and is written on this path too.
      expect(fs.files.get(SUMMARY)).toContain("published-unverified");
    });

    it("keeps the 404's ambiguity in the note rather than turning it into a visibility value", async () => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const fs = memoryFs();
      await expect(runVerifyPublication(
        runEnv({ IMAGE_DIGEST: m.digest }),
        effects(fs, { manifest: m.bytes, metadata: { status: 404 } }),
      )).rejects.toThrow();
      expect(fs.record().note).toMatch(/absent OR invisible/);
    });

    /** A readback that failed or disagreed is not evidence, so no success record may exist at all. */
    const badReadbacks: Array<{ label: string; bytes: () => string }> = [
      { label: "bytes that hash to a different digest", bytes: () => JSON.stringify({ schemaVersion: 2, mediaType: ACCEPTED_MEDIA_TYPES[0], tampered: true }) },
      { label: "an index descriptor instead of an image manifest", bytes: () => manifest("application/vnd.oci.image.index.v1+json").bytes },
      { label: "an empty readback", bytes: () => "" },
      { label: "a registry read that failed outright", bytes: () => { throw new Error("imagetools inspect: manifest unknown"); } },
    ];

    it.each(badReadbacks)("cannot produce a success receipt from $label", async ({ bytes }) => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const fs = memoryFs();
      await expect(runVerifyPublication(
        runEnv({ IMAGE_DIGEST: m.digest }),
        // Metadata that WOULD confirm, so the only thing standing between this run and a success
        // receipt is the readback.
        effects(fs, { manifest: bytes, metadata: { status: 200, body: linked } }),
      )).rejects.toThrow();
      expect(fs.files.has(RECEIPT), "a failed readback still wrote a receipt").toBe(false);
      expect(fs.files.has(SUMMARY)).toBe(false);
    });

    it.each([
      ["an absent build digest output", undefined],
      ["an empty build digest output", ""],
      ["a malformed digest", "sha256:nope"],
    ])("refuses %s before it asks the registry anything", async (_label, digest) => {
      const fs = memoryFs();
      const inspected: string[] = [];
      await expect(runVerifyPublication(
        runEnv({ IMAGE_DIGEST: digest }),
        effects(fs, { manifest: "unused", metadata: { status: 200, body: linked }, inspected }),
      )).rejects.toThrow(/registry digest/);
      expect(inspected).toEqual([]);
      expect(fs.files.has(RECEIPT)).toBe(false);
    });
  });

  describe("record-failure", () => {
    it("leaves a measured published-unverified record from the SAME run exactly as it found it", async () => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const fs = memoryFs();
      const env = runEnv({ IMAGE_DIGEST: m.digest });
      await expect(runVerifyPublication(env, effects(fs, { manifest: m.bytes, metadata: { status: 404 } }))).rejects.toThrow();
      const measured = fs.files.get(RECEIPT)!;

      // …which is exactly what the workflow does next: `if: failure()` fires on the very failure the
      // measured record describes.
      const outcome = runRecordFailure(
        { ...env, BUILD_OUTCOME: "success" },
        effects(fs, { metadata: { status: 404 } }),
      );
      expect(outcome).toMatchObject({ preserved: true, status: "published-unverified" });
      // Byte-identical: not merely "still published-unverified", which a rewrite could also satisfy.
      expect(fs.files.get(RECEIPT)).toBe(measured);
      expect(JSON.parse(measured).mediaType).toBe(ACCEPTED_MEDIA_TYPES[0]);
    });

    const partials: Array<{ label: string; digest?: string; recorded: string }> = [
      { label: "an absent digest output", recorded: "unconfirmed" },
      { label: "a malformed digest output", digest: "sha256:not-hex", recorded: "unconfirmed" },
      { label: "a well-formed but unconfirmed digest", digest: `sha256:${"e".repeat(64)}`, recorded: `sha256:${"e".repeat(64)}` },
    ];

    it.each(partials)("records a build-success run as PARTIALLY published with $label", ({ digest, recorded }) => {
      const fs = memoryFs();
      const outcome = runRecordFailure(
        runEnv({ BUILD_OUTCOME: "success", IMAGE_DIGEST: digest }),
        effects(fs, {}),
      );
      expect(outcome.preserved).toBe(false);
      const written = fs.record();
      // The push SUCCEEDED. Reading a missing digest as "nothing was published" would report the one
      // thing that is definitely false — the digest names the artifact, it does not decide the claim.
      expect(written).toMatchObject({
        status: "partially-published",
        digest: recorded,
        readbackStatus: "unconfirmed",
        packageVisibility: "unmeasured",
        packageLinkage: "unmeasured",
        publishedAt: AT,
      });
      expect(written.note).toMatch(/does not roll this back/);
      expect(validateReceipt(written)).toEqual([]);
      expect(fs.files.get(SUMMARY)).toContain("partially-published");
    });

    it.each([
      ["the push itself failed", "failure"],
      ["the build step never ran", ""],
      ["the build step was skipped", "skipped"],
    ])("claims no publication when %s", (_label, buildOutcome) => {
      const fs = memoryFs();
      expect(runRecordFailure(runEnv({ BUILD_OUTCOME: buildOutcome }), effects(fs, {})).status).toBe("failed");
      expect(fs.record()).toMatchObject({ status: "failed", digest: "unconfirmed", reference: "unconfirmed" });
      expect(fs.record().note).toMatch(/nothing is claimed to have been published/);
    });

    it("still writes when an earlier record is unreadable, rather than assuming one exists", () => {
      const fs = memoryFs({ [RECEIPT]: "half-written garbage" });
      expect(runRecordFailure(runEnv({ BUILD_OUTCOME: "failure" }), effects(fs, {})).preserved).toBe(false);
      expect(fs.record()).toMatchObject({ status: "failed" });
    });
  });

  /**
   * THE STEP AFTER THE UPLOAD. Both cases below start from a run that really did publish and really
   * did measure it — the receipt on disk is TRUE — and then lose the evidence on its way out. What
   * is under test is that the partial-publication account appears WITHOUT the measured record being
   * rewritten, demoted, or deleted, and that it survives the summary being the broken transport.
   */
  describe("report-delivery", () => {
    /** A run that really did publish and really did measure it: the receipt on disk is TRUE. */
    async function publishedRun(fs: ReturnType<typeof memoryFs>) {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const env = runEnv({ IMAGE_DIGEST: m.digest });
      const receipt = await runVerifyPublication(env, effects(fs, { manifest: m.bytes, metadata: { status: 200, body: linked } }));
      expect(receipt.status).toBe("published");
      return { m, env };
    }

    /** TRIGGER A — verified publication, then the artifact upload fails. */
    it("reports partially-published when the UPLOAD failed after a confirmed publication", async () => {
      const fs = memoryFs();
      const { m, env } = await publishedRun(fs);
      const measured = fs.files.get(RECEIPT)!;
      const summaryBefore = fs.files.get(SUMMARY)!;
      const logged: string[] = [];

      const report = runReportDelivery(
        { ...env, BUILD_OUTCOME: "success", VERIFY_OUTCOME: "success", UPLOAD_OUTCOME: "failure" },
        effects(fs, { logged }),
      );

      expect(report).toMatchObject({
        partial: true,
        outcome: "partially-published",
        registryPublication: "confirmed",
        evidenceDelivery: "incomplete",
        recordStatus: "published",
        reference: `${IMAGE}@${m.digest}`,
      });
      const printed = logged.join("");
      expect(printed).toContain("workflow outcome: partially-published");
      expect(printed).toContain(`registry publication: confirmed — ${IMAGE}@${m.digest}`);
      expect(printed).toContain("evidence delivery: incomplete");
      expect(printed).toContain("receipt artifact upload");
      // The measured receipt is the record; a delivery failure afterwards changes nothing about what
      // is in the registry. Byte-identical, not merely "still says published".
      expect(fs.files.get(RECEIPT)).toBe(measured);
      // Best effort, and the append worked here: the summary GAINS the account and loses nothing.
      expect(fs.files.get(SUMMARY)!.startsWith(summaryBefore)).toBe(true);
      expect(fs.files.get(SUMMARY)).toContain("partially published");
    });

    /** TRIGGER B — the receipt JSON is written, and the SUMMARY append is what throws. */
    it("reports partially-published over the job log when the SUMMARY is the failed transport", async () => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[0]);
      const fs = memoryFs();
      const env = runEnv({ IMAGE_DIGEST: m.digest });
      await expect(runVerifyPublication(
        env,
        { ...effects(fs, { manifest: m.bytes, metadata: { status: 200, body: linked } }), append: throwingAppend },
      )).rejects.toThrow(/simulated summary-write failure/);

      // The JSON receipt reached disk before the summary threw, and what it says is TRUE.
      const measured = fs.files.get(RECEIPT)!;
      expect(JSON.parse(measured).status).toBe("published");
      // `record-failure` then preserves it — correctly, and that is exactly why it cannot be the
      // step that supplies the partial account.
      expect(runRecordFailure({ ...env, BUILD_OUTCOME: "success" }, effects(fs, {}))).toMatchObject({
        preserved: true,
        status: "published",
      });

      const logged: string[] = [];
      const report = runReportDelivery(
        { ...env, BUILD_OUTCOME: "success", VERIFY_OUTCOME: "failure", UPLOAD_OUTCOME: "success" },
        { ...effects(fs, { logged }), append: throwingAppend },
      );

      expect(report).toMatchObject({ partial: true, registryPublication: "confirmed", evidenceDelivery: "incomplete" });
      const printed = logged.join("");
      expect(printed).toContain("workflow outcome: partially-published");
      expect(printed).toContain("receipt emission");
      // The console fallback is REQUIRED here: the summary is the surface that just failed twice.
      expect(printed).toMatch(/job summary could not be appended/);
      expect(fs.files.get(RECEIPT)).toBe(measured);
    });

    it("does not throw when the summary append fails, so the run stays red for its ORIGINAL reason", async () => {
      const fs = memoryFs();
      const { env } = await publishedRun(fs);
      expect(() => runReportDelivery(
        { ...env, BUILD_OUTCOME: "success", VERIFY_OUTCOME: "success", UPLOAD_OUTCOME: "failure" },
        { ...effects(fs, {}), append: throwingAppend },
      )).not.toThrow();
    });

    /** A measured `published-unverified` is a STRONGER distinction than "unverified", and survives. */
    it("preserves published-unverified rather than promoting it to a confirmed publication", async () => {
      const m = manifest(ACCEPTED_MEDIA_TYPES[1]);
      const fs = memoryFs();
      const env = runEnv({ IMAGE_DIGEST: m.digest });
      await expect(runVerifyPublication(env, effects(fs, { manifest: m.bytes, metadata: { status: 404 } }))).rejects.toThrow();
      const measured = fs.files.get(RECEIPT)!;
      const logged: string[] = [];

      const report = runReportDelivery(
        { ...env, BUILD_OUTCOME: "success", VERIFY_OUTCOME: "failure", UPLOAD_OUTCOME: "failure" },
        effects(fs, { logged }),
      );

      expect(report).toMatchObject({
        partial: true,
        registryPublication: "unverified",
        recordStatus: "published-unverified",
      });
      const printed = logged.join("");
      expect(printed).toContain("registry publication: unverified");
      expect(printed).not.toContain("registry publication: confirmed");
      // Neither rewritten nor demoted: the record still carries the confirmed manifest it measured.
      expect(fs.files.get(RECEIPT)).toBe(measured);
      expect(JSON.parse(measured)).toMatchObject({
        status: "published-unverified",
        mediaType: ACCEPTED_MEDIA_TYPES[1],
        readbackStatus: "confirmed",
      });
    });

    it("stays completely quiet on the all-success path", async () => {
      const fs = memoryFs();
      const { env } = await publishedRun(fs);
      const measured = fs.files.get(RECEIPT)!;
      const summaryBefore = fs.files.get(SUMMARY)!;
      const logged: string[] = [];

      const report = runReportDelivery(
        { ...env, BUILD_OUTCOME: "success", VERIFY_OUTCOME: "success", UPLOAD_OUTCOME: "success" },
        effects(fs, { logged }),
      );

      expect(report.partial).toBe(false);
      expect(logged, "the success path printed a partial-publication warning").toEqual([]);
      expect(fs.files.get(SUMMARY)).toBe(summaryBefore);
      expect(fs.files.get(RECEIPT)).toBe(measured);
    });

    it.each([
      ["the push itself failed", "failure"],
      ["the build step never ran", ""],
      ["the build step was skipped", "skipped"],
    ])("does not assert any publication when %s, even with both evidence steps failed", (_label, buildOutcome) => {
      const fs = memoryFs();
      const env = runEnv({ BUILD_OUTCOME: buildOutcome });
      expect(runRecordFailure(env, effects(fs, {})).status).toBe("failed");
      const logged: string[] = [];

      const report = runReportDelivery(
        { ...env, VERIFY_OUTCOME: "failure", UPLOAD_OUTCOME: "failure" },
        effects(fs, { logged }),
      );

      expect(report.partial).toBe(false);
      expect(logged.join("")).not.toContain("partially-published");
      expect(fs.record()).toMatchObject({ status: "failed" });
    });

    /** It is a REPORT. The only file-writing effect it may reach is the best-effort summary append. */
    it("never writes the receipt file, on any path", async () => {
      const fs = memoryFs();
      const { env } = await publishedRun(fs);
      const write = () => { throw new Error("report-delivery wrote a file"); };
      for (const outcomes of [
        { VERIFY_OUTCOME: "success", UPLOAD_OUTCOME: "failure" },
        { VERIFY_OUTCOME: "failure", UPLOAD_OUTCOME: "success" },
        { VERIFY_OUTCOME: "success", UPLOAD_OUTCOME: "success" },
      ]) {
        expect(() => runReportDelivery(
          { ...env, BUILD_OUTCOME: "success", ...outcomes },
          { ...effects(fs, {}), write },
        )).not.toThrow();
      }
    });
  });
});
