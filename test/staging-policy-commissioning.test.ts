import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATIONS, ALLOWED_REQUEST_SCOPES, COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH,
  CLOUD_CASE_SEQUENCE, ENVIRONMENT_CONTROL_KEYS, ENVIRONMENT_CONTROL_SCHEMAS, OWNER_LOGIN,
  OWNER_USER_ID, PROTECTED_JOBS, REQUIRED_WITNESS_PUBLICATIONS, RESULT_SCHEMA_VERSION,
  ROLE_APP_PERMISSIONS, ROLE_BINDINGS,
  assertAllowedRequest, assertCasePrecondition, assertDerivedRef, assertManifestBinding,
  assertChallengeShape, assertObservationProximity, assertPublisherArtifactProvenance,
  assertPublisherContext, assertResponseBinding, assertResponseShape, assertRoleBinding, assertRunContext, assessEvidence,
  awaitManifestFromRef, buildChallenge, buildGovernedSnapshot, buildResponse, buildActorMatrix,
  buildGraphPlan, openWitnessSession, publishWitnessResponse, readWitnessEnvelopeFromEvent,
  serializeDispatchEnvelope, validateGovernedSnapshot,
  challengeArtifactName, classifyCaseOutcome,
  canonicalHash, collectSentinels, comparePermissions, createRedactor, deriveCaseVerdict, derivedContextNames,
  derivedRef, derivedRefs, derivedRulesetName, evaluateDisposableCompatibility, evidenceSlug,
  assertNoCollision, assertPlannedPolicyApplies, assertSyntheticPullTarget, evaluateCheckState,
  governedFingerprint, invertDisposable, runActorCase, runActorCases, resolvePublishedResponse,
  assessHumanCaseJournal, cloudCasesIssuedAfterHalt, mutationRequestClass,
  createArchiveTransport, evidenceFileName, main, MAX_JOB_MINUTES, mintActorCredential, mintAppJwt,
  parseArgs, projectGovernedRuleset, readAllPages,
  positiveProviderId, readApplicableBranchRulesets, readEvidenceFile, readSingleEntryZip,
  recomputeCheckState, reconcileCreateIntents,
  responseArtifactName, runCaseStage, runCloudTestsPhase, runFixtureChecks,
  runHumanTestsPhase, runIntentPhase, runNormalCheckPublication, runPhase, runRehearsalStage,
  beginWitnessItem, runWitnessPublisherJob, serveWitnessItem, transformToDisposable, unresolvedCreateIntents,
  INTENT_JOB_NAME, intentArtifactEntry, intentArtifactName, derivedRulesetNames, pollWitnessPublication,
  validateEnvironmentControl, validateEvidenceBinding, verifyWitnessedPolicy, writeEvidenceFile,
  completedJsonResponse, conformResponse, createLocalGhTransport, createTokenTransport,
  incompleteResponse, responseEvidence,
} from "../scripts/staging-ops/policy-commissioning.mjs";
import { buildMainRulesets, REQUIRED_MAIN_CONTEXTS } from "../scripts/staging-ops/main-policy.mjs";
import {
  acquireJournalLock, journalPath, openJournal, readJournal, readLockOwner, recordWitnessEventOnce,
  recoverJournalLock, reduceResourceLifecycles, resourceLifecycleKey,
} from "../scripts/staging-ops/commissioning-journal.mjs";
import { openCaseStateStore } from "../scripts/staging-ops/commissioning-case.mjs";
import {
  WITNESS_MAX_PAGES, WITNESS_PAGE_SIZE,
} from "../scripts/staging-ops/commissioning-witness.mjs";

/**
 * AIO-1124 — the commissioning runner's own tests.
 *
 * These are SPEC-DERIVED, not characterization. The provider fixture below is a model of the
 * GitHub behaviour the harness claims to measure — rulesets, bypass actors, required checks with a
 * producer identity, fast-forward semantics — and the interesting assertions are the ones where a
 * naive implementation would report a pass: a denial that was really a bad credential, a force
 * flag on a fast-forward, an inherited org ruleset nobody resolved, a green check from the wrong
 * producer, an evidence file that exists but records nothing.
 *
 * NOTHING here is evidence that the live policy enforces anything. A green run of this file means
 * the runner's logic is right; the actor matrix is only real when the reviewed workflow has been
 * dispatched against provisioned Apps and protected environments, which is a separate gate.
 */

const RUN_ID = "9001";
const ATTEMPT = "2";
const REPOSITORY_ID = 55501;
const NORMAL_APP = 111;
const EMERGENCY_APP = 222;
const ACTIONS_APP = 15368;
const WORKFLOW_SHA = "a".repeat(40);
const MAIN_SHA = "b".repeat(40);
/**
 * THE LIVE STAGING HEAD *IS* THE IMMUTABLE SOURCE THIS ATTEMPT RAN (F3).
 *
 * This fixture used to put staging at `cccc…` while the trusted workflow SHA was `aaaa…` — two
 * different commits — and a complete run over those mismatched values returned no blockers at all,
 * because nothing compared them. That is not a modelling detail: a commissioning run dispatched
 * from `staging` checks out the head of `staging`, so the two being equal is the ordinary state,
 * and the whole point of the source-continuity check is that they must still be equal at each
 * boundary. The fixture now models the true relationship, and `stagingSha` below moves the LIVE
 * REF — which is what a source move actually is, rather than editing a challenge's declared string.
 */
const STAGING_SHA = WORKFLOW_SHA;
const MOVED_STAGING_SHA = "c".repeat(40);
const PRODUCER_IDS = Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context, index) => [context, 900 + index]));
/**
 * A clearly synthetic, private-key-SHAPED sentinel for the redaction assertions. It is assembled from
 * parts so the source holds no static private-key block for a secret scanner to match; the runtime
 * value is the same PEM-shaped string, and its body is an obvious non-key marker.
 */
const SENTINEL_PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
const SENTINEL_KEY = [`-----BEGIN ${SENTINEL_PEM_LABEL}-----`, "MIIEsentinelKEYMATERIAL0123456789", `-----END ${SENTINEL_PEM_LABEL}-----`].join("\n");

const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

/** The two identities the transport distinguishes: the human operator and the dispatcher App. */
const OWNER_IDENTITY = { login: OWNER_LOGIN, id: OWNER_USER_ID, type: "User" };
const DISPATCHER_IDENTITY = { login: "aios-commissioning-dispatcher[bot]", id: 987654, type: "Bot" };

/**
 * A minimal ZIP writer, so the suite can hand the runner a REAL archive.
 *
 * Written here rather than mocked away because {@link readSingleEntryZip} is a security boundary: the
 * archive-attack cases below (two entries, a symlink entry, a traversal name, a bad CRC, a zip64 size
 * marker) can only be tested against bytes. `method` covers both accepted compressions — store and
 * deflate — because a reader that only ever saw one of them would be half-tested.
 */
function buildZip(entryName: string, content: Buffer, method: 0 | 8 = 0, overrides: {
  entries?: { name: string; content: Buffer }[]; crc?: number; uncompressedSize?: number;
  externalAttributes?: number; totalEntries?: number; comment?: Buffer;
} = {}): Buffer {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value >>> 0;
    }
    return table;
  })();
  const crc32 = (buffer: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries = overrides.entries ?? [{ name: entryName, content }];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = method === 8 ? deflateRawSync(entry.content) : entry.content;
    const crc = overrides.crc ?? crc32(entry.content);
    const uncompressed = overrides.uncompressedSize ?? entry.content.length;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((overrides.externalAttributes ?? (0o100644 << 16)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local, raw);
    centrals.push(central);
    offset += local.length + raw.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const comment = overrides.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(overrides.totalEntries ?? entries.length, 8);
  eocd.writeUInt16LE(overrides.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

type Actor = { kind: string; appId: number | null };
const ACTORS: Record<string, Actor> = {
  local: { kind: "human", appId: null },
  fixture: { kind: "actions", appId: ACTIONS_APP },
  intent: { kind: "actions", appId: ACTIONS_APP },
  normal: { kind: "normal", appId: NORMAL_APP },
  emergency: { kind: "emergency", appId: EMERGENCY_APP },
};

/**
 * The shapes these tests actually read.
 *
 * They are written out rather than left as `any` because two of the bugs found while building this
 * file were type-shaped: a parents list walked as `string[]` when it holds `{ sha }[]`, which made
 * every fast-forward look divergent, and an evidence field read off the wrong key. `unknown` with a
 * cast at the point of use says where the assumption is; `any` hides that it was made at all.
 */
type Rule = {
  type: string;
  parameters?: {
    strict_required_status_checks_policy?: boolean;
    do_not_enforce_on_create?: boolean;
    required_status_checks?: { context: string; integration_id: number }[];
  };
};
type BypassActor = { actor_type?: string; actor_id?: number; bypass_mode?: string };
type Ruleset = {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude?: string[] } };
  bypass_actors?: BypassActor[];
  rules?: Rule[];
};
type CheckRun = { name: string; status: string; conclusion: string; app: { id: number | null } };
type StoredCommit = { sha: string; message: string; tree: { sha: string }; parents: { sha: string }[] };
type StoredTree = { sha: string; tree: { path: string; mode: string; type: string; sha: string }[]; truncated: boolean };
type StoredBlob = { sha: string; encoding: string; content: string };
type StoredPull = {
  number: number;
  state: string;
  title?: string;
  base: { ref: string; repo: { full_name: string } };
  head: { ref: string; repo: { full_name: string }; sha: string };
};
type ApprovalEntry = {
  state: string; user: { login: string; type: string };
  comment?: string; created_at?: string; updated_at?: string;
  environments: { name: string }[];
};
type ApplicableRule = { type: string; ruleset_id?: number; ruleset_source_type?: string; ruleset_source?: string };
type Permissions = Record<string, string>;

/**
 * What the provider reports for each role's App and installation — the subject of PC-04's grant
 * gate. Held here (not derived from the runner's own closed set) so a test can present grants that
 * DISAGREE with what the harness requires, which is the only way that gate is falsifiable.
 */
const APP_METADATA: Record<string, { id: number; slug: string; permissions: Permissions; installationId: string }> = {
  normal: { id: NORMAL_APP, slug: "aios-release", permissions: { checks: "write", contents: "write", metadata: "read" }, installationId: "5001" },
  emergency: { id: EMERGENCY_APP, slug: "aios-emergency", permissions: { contents: "write", metadata: "read" }, installationId: "5002" },
};
const INSTALLATION_ROLES: Record<string, string> = { 5001: "normal", 5002: "emergency" };
/** The `phase` each evidence file must declare — used to build deliberately malformed packets. */
const EVIDENCE_PHASES: Record<string, string> = {
  intent: "intent", setup: "setup", fixture: "fixture-checks", human: "human-tests",
  normal: "normal-tests", emergency: "emergency-tests", approvals: "approvals",
  environment: "environment-controls", cleanup: "cleanup",
};

/**
 * The union of every request body this fake is asked to handle. Optional throughout: each endpoint
 * branch reads only the fields its own request sends.
 */
interface RequestBody {
  tree?: { path: string; mode: string; type: string; content: string }[];
  base_tree?: unknown;
  message?: string;
  parents?: string[];
  ref?: string;
  sha?: string;
  force?: boolean;
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  base?: string;
  head?: string;
  title?: string;
  body?: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: BypassActor[];
  rules?: Rule[];
  output?: unknown;
}

/** One recorded actor case, as `runActorCase` writes it into an evidence file. */
type CaseRecord = {
  case: string;
  actor: string;
  outcome: string;
  passed: boolean;
  expected?: string;
  before_sha?: string;
  requested_sha?: string;
  after_sha?: string;
  http_status?: number;
  diagnostic?: { status: number; category: string; ruleIds: string[]; policyDenial: boolean };
  check_state?: { expectation: string; measured: boolean; producers?: number[]; present?: number };
  reason?: string | null;
};

/** One transport response, as the guarded request returns it to a case. */
type ProviderResponse = {
  status: number; diagnostic: { status?: number; category: string; ruleIds: string[]; policyDenial: boolean };
  complete?: boolean; incomplete?: string | null; measured_status?: number | null;
};

/**
 * A fake provider answer, put on the wire the way a real transport completes it. Raw test transports
 * go through the REAL completion owner rather than stamping `complete: true` by hand, so a fixture
 * cannot describe a response the contract would never have produced.
 */
const wire = (result: { status: number; body: unknown }) =>
  completedJsonResponse(result.status, Buffer.from(result.body === null || result.body === undefined ? "" : JSON.stringify(result.body), "utf8"));
const lostResponse = () => incompleteResponse("transport-timeout");

/** One blocker from {@link assessEvidence}. */
type Blocker = { gate: string; kind: string; detail: string };

/** One verified record from the append-only journal. */
type JournalRecord = { seq: number; type: string; digest: string; previous: string; source: string; data: Record<string, unknown> };

/** One structural difference, as `describeDifferences` reports it. */
type Difference = { ruleset?: string; path: string; kind: string };

/** A fake child process. `EventEmitter` plus exactly the three streams `runGhProcess` touches. */
type FakeChild = EventEmitter & { pid: number; kill: () => void; stdout: PassThrough; stderr: PassThrough; stdin: Writable };

const JOB_NAMES: Record<string, string> = Object.fromEntries(
  (PROTECTED_JOBS as { id: string; name: string }[]).map((spec) => [spec.id, spec.name]),
);
const JOB_ENVIRONMENTS: Record<string, string> = Object.fromEntries(
  (PROTECTED_JOBS as { id: string; environment: string }[]).map((spec) => [spec.id, spec.environment]),
);

interface FakeOptions {
  /** Rewrite a ruleset on the way OUT, to model provider normalisation or an alien field. */
  rulesetReadback?: (ruleset: Ruleset) => Ruleset;
  /** Extra rulesets the provider reports as applicable to a derived branch. */
  extraApplicable?: ApplicableRule[];
  /** Force `/rules/branches/*` to a status, to model an unreadable measurement. */
  rulesStatus?: number;
  /** Force BOTH protected jobs present with this status, to model an approval that came too early. */
  jobStatus?: string;
  mainProtection?: unknown | null;
  /**
   * Seed {@link createFakeGitHub}'s mutable `faults`. They are mutable because WHEN a read fails
   * matters: an unreadable approval history refuses at `setup` (which must prove the pre-approval
   * snapshot) and is merely unverified at `collect`, and only a fault you can switch on mid-run can
   * tell those two apart.
   */
  approvalsStatus?: number;
  jobsStatus?: number;
  /** The credential-free intent job's own state in the original run. */
  intentJobStatus?: string;
  intentJobConclusion?: string;
  /**
   * Rule types the provider silently fails to enforce, while still REPORTING the ruleset as
   * applicable. This is the only honest way to model an over-privileged actor: deleting the ruleset
   * would be refused earlier by `assertPlannedPolicyInForce`, which is itself the guard that stops
   * an acceptance on an unprotected branch from being recorded as a bypass.
   */
  ignoreRuleTypes?: string[];
  /** Override the permissions the provider reports for a role's App and installation. */
  appPermissions?: Record<string, Permissions>;
  /** Override the installation's repository selection or suspension, per role. */
  installationOverrides?: Record<string, Record<string, unknown>>;
  /** The local `gh` identity `/user` reports — the only way the F6 wrong-admin case is falsifiable. */
  operatorLogin?: string;
  operatorId?: number;
  operatorType?: string;
  operatorPermission?: string;
  /** The identities the provider reports for the SOURCE run, which is where the dispatcher is read. */
  runActor?: { login: string; id: number; type: string };
  runTriggeringActor?: { login: string; id: number; type: string };
  /** Swallow the witness dispatch, to model a publication that never happens. */
  suppressPublisher?: boolean;
  /** Which accepted ZIP compression the publisher's artifact uses. */
  zipMethod?: 0 | 8;
  /**
   * The repository's MEASURED default branch, and a live move of the `staging` ref (F3).
   *
   * These are the two facts the shared source-continuity check reads, and they are options rather
   * than constants because moving the LIVE REF is the only honest way to test a source move: the
   * previous "MOVED source" case edited a challenge's declared SHA string, which is a
   * caller-supplied field and moves nothing.
   */
  defaultBranch?: string;
  stagingSha?: string;
}

/**
 * A model of the provider, not a recording of it. Ruleset evaluation below is written from the
 * documented semantics of `non_fast_forward`, `deletion`, `update`, `pull_request` and
 * `required_status_checks` (+ `strict`), including Integration bypass actors — which is what makes
 * a test that expects `emergency` to be accepted and `normal` to be refused a real test.
 */
function createFakeGitHub(options: FakeOptions = {}) {
  const commits = new Map<string, StoredCommit>();
  const trees = new Map<string, StoredTree>();
  const blobs = new Map<string, StoredBlob>();
  const refs = new Map<string, string>([["refs/heads/main", MAIN_SHA], ["refs/heads/staging", options.stagingSha ?? STAGING_SHA]]);
  const rulesets = new Map<number, Ruleset>();
  const checks = new Map<string, CheckRun[]>();
  const pulls = new Map<number, StoredPull>();
  const calls: { actor: string; method: string; path: string }[] = [];
  /**
   * The run's jobs, as GitHub would report them AT SETUP TIME.
   *
   * `emergency` needs only `intent`, so it exists and is parked. `normal` needs `fixture`, and the
   * fixture is waiting for local setup — so GitHub has NOT CREATED IT YET and it is absent from this
   * map entirely. That asymmetry is the real semantics the runner has to cope with, so the fake
   * models it rather than presenting two tidy `waiting` rows.
   */
  const jobState = new Map<string, { status: string; conclusion: string | null }>([
    ["emergency", { status: "waiting", conclusion: null }],
  ]);
  /** Empty until a human approves. Nothing in the harness may add to this. */
  const approvals: ApprovalEntry[] = [];
  const faults = { approvals: options.approvalsStatus ?? 0, jobs: options.jobsStatus ?? 0 };

  /**
   * The witness transport's state: artifacts, the publisher runs that own them, and every dispatch
   * body the local witness sent. Modelled, because the actor's whole provenance check is about the
   * OWNING RUN's actor, attempt, path, head SHA and job set — a stubbed "here is your response" would
   * skip precisely the part that matters.
   */
  const artifacts = new Map<number, { id: number; name: string; runId: number; zip: Buffer }>();
  const publisherRuns = new Map<number, Record<string, unknown>>();
  const rehearsalRuns = new Map<number, Record<string, unknown>>();
  const dispatches: unknown[] = [];
  let nextArtifact = 6100;
  let nextRun = 77000;

  /** Register an artifact as though an upload step had published it. */
  const addArtifact = (name: string, entryName: string, bytes: Buffer, runId: number, method: 0 | 8 = 0) => {
    const id = (nextArtifact += 1);
    artifacts.set(id, { id, name, runId, zip: buildZip(entryName, bytes, method) });
    return id;
  };

  /** What the `policy-witness` job does when the local witness dispatches: republish the bytes. */
  const publishWitness = (envelope: string) => {
    let response: { original_run_id: string; original_attempt: string; role: string; case_ordinal: number; direction: string; challenge_nonce: string };
    try { response = JSON.parse(envelope); } catch { return null; }
    const runId = (nextRun += 1);
    publisherRuns.set(runId, {
      id: runId, head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
      head_branch: "staging", run_attempt: 1, status: "completed", conclusion: "success",
      actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
    });
    const name = responseArtifactName({
      runId: response.original_run_id, attempt: response.original_attempt, role: response.role,
      ordinal: response.case_ordinal, direction: response.direction, nonce: response.challenge_nonce,
    });
    return addArtifact(name, "witness.json", Buffer.from(envelope, "utf8"), runId, options.zipMethod ?? 0);
  };

  /** The bounded BINARY transport the runner uses for an artifact archive. */
  const archiveImpl = async (method: string, requestPath: string) => {
    calls.push({ actor: "archive", method, path: requestPath.split("?")[0] });
    const id = Number(/\/actions\/artifacts\/(\d+)\/zip$/.exec(requestPath.split("?")[0])?.[1]);
    const entry = artifacts.get(id);
    if (!entry) return { status: 404, bytes: null, diagnostic: { status: 404, category: "not-found", ruleIds: [], policyDenial: false } };
    return { status: 200, bytes: entry.zip, diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false } };
  };
  /**
   * What a human approval does: records a review, and lets the parked job START.
   *
   * `in_progress`, not `completed` — the distinction is load-bearing for the F1 transport. The local
   * witness serves a response only to a job that is ACTUALLY RUNNING this attempt, so a fake that
   * jumped straight to `completed` would make every witness service refuse for the right reason at
   * the wrong time. {@link finish} is the separate event of the job ending.
   */
  const approve = (job: string, login = OWNER_LOGIN, type = "User", id = OWNER_USER_ID, approvedAt = new Date().toISOString()) => {
    // GitHub's deployment-approval object carries its own timestamp. The harness used to drop it,
    // so an approval could not be placed in time at all — which is why a future one was invisible.
    approvals.push({ state: "approved", user: { login, type, id }, comment: "", created_at: approvedAt, updated_at: approvedAt, environments: [{ name: JOB_ENVIRONMENTS[job] }] });
    jobState.set(job, { status: "in_progress", conclusion: null });
  };
  const finish = (job: string, conclusion = "success") => jobState.set(job, { status: "completed", conclusion });
  /** What the fixture finishing does: GitHub can finally create `normal`, parked for its human. */
  const createNormalJob = () => jobState.set("normal", { status: "waiting", conclusion: null });
  let nextId = 7000;
  let nextPull = 41;

  const ancestors = (start: string): Set<string> => {
    const out = new Set<string>();
    const walk = (current: string) => {
      // `parents` is stored in the provider's own shape — `[{ sha }]`, not `[sha]`. Walking it as
      // though it held strings makes this set full of objects, `has(sha)` always false, and every
      // fast-forward look like a divergent update. The `isFastForward` assertions below are the
      // positive controls that keep that from passing quietly.
      for (const parent of (commits.get(current)?.parents ?? []).map((entry) => String(entry?.sha ?? entry))) {
        if (out.has(parent)) continue;
        out.add(parent);
        walk(parent);
      }
    };
    walk(start);
    return out;
  };
  const isFastForward = (from: string, to: string) => from === to || ancestors(to).has(from);
  const applicable = (ref: string) => [...rulesets.values()].filter((ruleset) =>
    (ruleset.conditions?.ref_name?.include ?? []).includes(ref));

  /** Returns a denial message, or null when every applicable rule permits the operation. */
  function evaluate(ref: string, operation: "update" | "delete" | "merge", actor: Actor, requested: string | null) {
    const current = refs.get(ref)!;
    // GitHub reports EVERY violation, not the first. That matters here: the pull-request merge case
    // has to be able to tell a writer-policy refusal apart from an incidental red check.
    const violations: string[] = [];
    for (const ruleset of applicable(ref)) {
      if (ruleset.enforcement !== "active") continue;
      const bypassed = (ruleset.bypass_actors ?? []).some((entry) =>
        entry.actor_type === "Integration" && entry.actor_id === actor.appId);
      if (bypassed) continue;
      for (const rule of ruleset.rules ?? []) {
        if ((options.ignoreRuleTypes ?? []).includes(rule.type)) continue;
        if (rule.type === "deletion" && operation === "delete") violations.push("Cannot delete this protected ref");
        if (rule.type === "non_fast_forward" && operation !== "delete" && requested && !isFastForward(current, requested)) {
          violations.push("Cannot force-push to this protected ref");
        }
        if (rule.type === "update" && operation !== "delete") violations.push("Cannot update this protected ref");
        if (rule.type === "pull_request" && operation === "update") violations.push("Changes must be made through a pull request");
        if (rule.type === "required_status_checks" && operation !== "delete" && requested) {
          const parameters = rule.parameters ?? {};
          if (parameters.strict_required_status_checks_policy && !isFastForward(current, requested)) {
            violations.push("required status check policy is strict and the branch is out of date");
          }
          for (const required of parameters.required_status_checks ?? []) {
            const run = (checks.get(requested) ?? []).find((entry) =>
              entry.name === required.context && entry.app.id === required.integration_id);
            if (!run || run.status !== "completed" || run.conclusion !== "success") {
              violations.push("a required status check has not succeeded");
              break;
            }
          }
        }
      }
    }
    return violations.length ? `Repository rule violations found\n\n- ${violations.join("\n- ")}` : null;
  }

  function handle(actorName: string, method: string, rawPath: string, body?: RequestBody) {
    const actor = ACTORS[actorName];
    const [pathname] = rawPath.split("?");
    calls.push({ actor: actorName, method, path: pathname });
    const rel = pathname.startsWith(`/repos/${COMMISSIONING_REPOSITORY}`) ? pathname.slice(`/repos/${COMMISSIONING_REPOSITORY}`.length) : null;
    const json = (status: number, value: unknown) => ({ status, body: value });

    // The ONE authorized operator, by numeric ID as well as login (F6). `OWNER_USER_ID` is imported
    // from the runner rather than retyped, so a change to the authorized identity is a red test here
    // rather than a fixture that quietly disagrees with the code.
    if (pathname === "/user") return json(200, { login: options.operatorLogin ?? OWNER_LOGIN, type: options.operatorType ?? "User", id: options.operatorId ?? OWNER_USER_ID });
    if (pathname === "/installation/repositories") {
      // EXACTLY the documented shape: `total_count` + `repositories`. No `repository_selection` —
      // that field lives on the installation, and asking this endpoint for it was the bug.
      return json(200, { total_count: 1, repositories: [{ id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY }] });
    }
    // The App JWT's two read endpoints. The credential decides which App answers, exactly as the
    // provider's JWT-issuer validation does.
    if (pathname === "/app") {
      const meta = APP_METADATA[actorName];
      if (!meta) return json(401, { message: "Bad credentials" });
      return json(200, { id: meta.id, slug: meta.slug, permissions: options.appPermissions?.[actorName] ?? meta.permissions });
    }
    const installationMatch = /^\/app\/installations\/(\d+)$/.exec(pathname);
    if (installationMatch) {
      const role = INSTALLATION_ROLES[installationMatch[1]];
      const meta = APP_METADATA[role ?? ""];
      if (!meta || role !== actorName) return json(404, { message: "Not Found" });
      return json(200, {
        id: Number(installationMatch[1]), app_id: meta.id, account: { login: "aiosbrain", type: "Organization" },
        permissions: options.appPermissions?.[actorName] ?? meta.permissions,
        repository_selection: "selected", suspended_at: null,
        ...(options.installationOverrides?.[actorName] ?? {}),
      });
    }
    // `default_branch` is part of the repository identity the shared source-continuity check reads
    // (F3): the canonical states GitHub reports `staging` as the default branch, and a repository
    // whose default branch moved is not the configuration this attempt was reviewed against.
    if (rel === "") return json(200, { id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY, default_branch: options.defaultBranch ?? "staging" });
    if (rel?.startsWith("/collaborators/") && rel.endsWith("/permission")) return json(200, { permission: options.operatorPermission ?? "admin" });

    // ── the witness transport's provider surface (F1) ───────────────────────────────────────────
    if (rel === "/actions/artifacts" && method === "GET") {
      const wanted = new URLSearchParams(rawPath.split("?")[1] ?? "").get("name");
      const rows = [...artifacts.values()].filter((entry) => !wanted || entry.name === wanted)
        .map((entry) => ({ id: entry.id, name: entry.name, expired: false, workflow_run: { id: entry.runId } }));
      return json(200, { total_count: rows.length, artifacts: rows });
    }
    const artifactMatch = /^\/actions\/artifacts\/(\d+)$/.exec(rel ?? "");
    if (artifactMatch) {
      const entry = artifacts.get(Number(artifactMatch[1]));
      return entry ? json(200, { id: entry.id, name: entry.name, expired: false, workflow_run: { id: entry.runId } }) : json(404, { message: "Not Found" });
    }
    if (rel === `/actions/workflows/release-policy-commissioning.yml/dispatches` && method === "POST") {
      // What a witness dispatch DOES: it creates a `policy-witness` run whose one publisher job
      // republishes the envelope bytes as a single-entry artifact. Modelled rather than stubbed,
      // because the actor then verifies that run's actor, attempt, path, head SHA and job set.
      dispatches.push(structuredClone(body));
      if (!options.suppressPublisher) publishWitness(String(body?.inputs?.witness_envelope ?? ""));
      return json(204, null);
    }
    if (rel === `/actions/workflows/release-policy-commissioning.yml/runs` && method === "GET") {
      return json(200, { total_count: publisherRuns.size, workflow_runs: [...publisherRuns.values()] });
    }
    if (rel?.startsWith("/actions/runs/")) {
      if (rel.endsWith("/jobs")) {
        if (faults.jobs) return json(faults.jobs, { message: "Not Found" });
        const runMatch = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(rel);
        const runId = runMatch ? Number(runMatch[1]) : Number(RUN_ID);
        if (publisherRuns.has(runId)) {
          return json(200, { total_count: 2, jobs: [
            { id: runId * 10 + 1, name: "Local policy witness publisher (no secrets)", status: "completed", conclusion: "success", run_attempt: 1 },
            { id: runId * 10 + 2, name: "Normal App actor tests (protected)", status: "completed", conclusion: "skipped", run_attempt: 1 },
          ] });
        }
        if (rehearsalRuns.has(runId)) {
          return json(200, { total_count: 1, jobs: [{ id: runId * 10 + 1, name: "Transport rehearsal (inert, no secrets)", status: "in_progress", conclusion: null, run_attempt: 1 }] });
        }
        const rows = options.jobStatus
          ? Object.keys(JOB_NAMES).map((id) => ({ id: 900 + Object.keys(JOB_NAMES).indexOf(id), name: JOB_NAMES[id], status: options.jobStatus, conclusion: null, run_attempt: Number(ATTEMPT) }))
          : [...jobState.entries()].map(([id, value]) => ({ id: 900 + Object.keys(JOB_NAMES).indexOf(id), name: JOB_NAMES[id], status: value.status, conclusion: value.conclusion, run_attempt: Number(ATTEMPT) }));
        // The credential-free intent job, which really is in this run and really does finish first:
        // the publisher binds its intent artifact to THIS job's success in THIS attempt.
        const withIntent = [
          { id: 890, name: INTENT_JOB_NAME, status: options.intentJobStatus ?? "completed", conclusion: options.intentJobConclusion ?? "success", run_attempt: Number(ATTEMPT) },
          ...rows,
        ];
        return json(200, { total_count: withIntent.length, jobs: withIntent });
      }
      if (rel.endsWith("/approvals")) {
        if (faults.approvals) return json(faults.approvals, { message: "Not Found" });
        return json(200, structuredClone(approvals));
      }
      const attemptMatch = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(rel);
      const runId = attemptMatch ? Number(attemptMatch[1]) : Number(RUN_ID);
      if (publisherRuns.has(runId)) return json(200, publisherRuns.get(runId));
      if (rehearsalRuns.has(runId)) return json(200, rehearsalRuns.get(runId));
      return json(200, {
        id: runId, head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
        head_branch: "staging", run_attempt: Number(attemptMatch ? attemptMatch[2] : ATTEMPT),
        status: "in_progress", conclusion: null,
        actor: options.runActor ?? DISPATCHER_IDENTITY,
        triggering_actor: options.runTriggeringActor ?? options.runActor ?? DISPATCHER_IDENTITY,
      });
    }
    if (rel === "/branches/main/protection") {
      return options.mainProtection ? json(200, options.mainProtection) : json(404, { message: "Branch not protected" });
    }
    if (rel?.startsWith("/branches/") && rel.endsWith("/protection")) return json(404, { message: "Branch not protected" });
    if (rel === "/rules/branches/main") return json(200, []);
    if (rel?.startsWith("/rules/branches/")) {
      if (options.rulesStatus) return json(options.rulesStatus, { message: "Not Found" });
      const branch = decodeURIComponent(rel.slice("/rules/branches/".length));
      const entries = applicable(`refs/heads/${branch}`).flatMap((ruleset) =>
        (ruleset.rules ?? []).map((rule) => ({ type: rule.type, ruleset_id: ruleset.id, ruleset_source_type: "Repository", ruleset_source: COMMISSIONING_REPOSITORY })));
      return json(200, [...entries, ...(options.extraApplicable ?? [])]);
    }
    if (rel === "/rulesets" && method === "GET") {
      return json(200, [...rulesets.values()].map((ruleset) => ({ id: ruleset.id, name: ruleset.name, target: ruleset.target, enforcement: ruleset.enforcement })));
    }
    if (rel === "/rulesets" && method === "POST") {
      const id = (nextId += 1);
      const stored = { ...structuredClone(body), id, target: body.target ?? "branch", source_type: "Repository", source: COMMISSIONING_REPOSITORY };
      rulesets.set(id, stored);
      return json(201, { id });
    }
    const rulesetMatch = /^\/rulesets\/(\d+)$/.exec(rel ?? "");
    if (rulesetMatch) {
      const id = Number(rulesetMatch[1]);
      if (method === "DELETE") { rulesets.delete(id); return json(204, null); }
      const found = rulesets.get(id);
      if (!found) return json(404, { message: "Not Found" });
      return json(200, options.rulesetReadback ? options.rulesetReadback(structuredClone(found)) : structuredClone(found));
    }
    if (rel === "/git/trees" && method === "POST") {
      const entries = (body?.tree ?? []).map((entry) => {
        const blobSha = sha(`blob:${entry.path}:${entry.content}`);
        blobs.set(blobSha, { sha: blobSha, encoding: "base64", content: Buffer.from(entry.content, "utf8").toString("base64") });
        return { path: entry.path, mode: entry.mode, type: entry.type, sha: blobSha };
      });
      const treeSha = sha(`tree:${JSON.stringify(entries)}`);
      trees.set(treeSha, { sha: treeSha, tree: entries, truncated: false });
      return json(201, { sha: treeSha });
    }
    if (rel === "/git/commits" && method === "POST") {
      const commitSha = sha(`commit:${body.message}:${body.tree}:${JSON.stringify(body.parents)}`);
      commits.set(commitSha, { sha: commitSha, message: body.message, tree: { sha: body.tree }, parents: (body.parents ?? []).map((p: string) => ({ sha: p })) });
      return json(201, { sha: commitSha });
    }
    const commitMatch = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rel ?? "");
    if (commitMatch) {
      const found = commits.get(commitMatch[1]);
      if (!found) return json(404, { message: "Not Found" });
      return json(200, { ...found, parents: found.parents });
    }
    const treeMatch = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rel ?? "");
    if (treeMatch) {
      const found = trees.get(treeMatch[1]);
      return found ? json(200, found) : json(404, { message: "Not Found" });
    }
    const blobMatch = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rel ?? "");
    if (blobMatch) {
      const found = blobs.get(blobMatch[1]);
      return found ? json(200, found) : json(404, { message: "Not Found" });
    }
    if (rel === "/git/refs" && method === "POST") {
      if (refs.has(body.ref)) return json(422, { message: "Reference already exists" });
      refs.set(body.ref, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    const refMatch = /^\/git\/refs?\/heads\/(.+)$/.exec(rel ?? "");
    if (refMatch) {
      const ref = `refs/heads/${refMatch[1]}`;
      if (method === "GET") {
        const found = refs.get(ref);
        return found ? json(200, { ref, object: { sha: found, type: "commit" } }) : json(404, { message: "Not Found" });
      }
      if (!refs.has(ref)) return json(404, { message: "Not Found" });
      if (method === "DELETE") {
        const denial = evaluate(ref, "delete", actor, null);
        if (denial) return json(422, { message: denial });
        refs.delete(ref);
        return json(204, null);
      }
      const denial = evaluate(ref, "update", actor, body.sha);
      if (denial) return json(422, { message: denial });
      if (!body.force && !isFastForward(refs.get(ref)!, body.sha)) return json(422, { message: "Update is not a fast forward" });
      refs.set(ref, body.sha);
      return json(200, { ref, object: { sha: body.sha } });
    }
    if (rel === "/check-runs" && method === "POST") {
      const list = checks.get(body.head_sha) ?? [];
      list.push({ name: body.name, status: body.status, conclusion: body.conclusion, app: { id: actor.appId } });
      checks.set(body.head_sha, list);
      return json(201, { id: (nextId += 1), name: body.name, app: { id: actor.appId } });
    }
    const checkRunsMatch = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rel ?? "");
    if (checkRunsMatch) return json(200, { check_runs: checks.get(checkRunsMatch[1]) ?? [] });
    if (rel === "/pulls" && method === "GET") {
      // The bounded reconciliation read (F5): this run's own derived head, and nothing else.
      const head = new URLSearchParams(rawPath.split("?")[1] ?? "").get("head") ?? "";
      const branch = head.split(":")[1] ?? "";
      return json(200, [...pulls.values()].filter((pull) => pull.head.ref === branch));
    }
    if (rel === "/pulls" && method === "POST") {
      const number = (nextPull += 1);
      pulls.set(number, {
        number, state: "open", title: body?.title,
        base: { ref: String(body?.base), repo: { full_name: COMMISSIONING_REPOSITORY } },
        head: { ref: String(body?.head), repo: { full_name: COMMISSIONING_REPOSITORY }, sha: refs.get(`refs/heads/${String(body?.head)}`)! },
      });
      return json(201, pulls.get(number));
    }
    const pullMatch = /^\/pulls\/(\d+)(\/merge)?$/.exec(rel ?? "");
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      const pull = pulls.get(number);
      if (!pull) return json(404, { message: "Not Found" });
      if (method === "GET") return json(200, pull);
      if (method === "PATCH") { pull.state = body.state; return json(200, pull); }
      const base = `refs/heads/${pull.base.ref}`;
      const headSha = refs.get(`refs/heads/${pull.head.ref}`)!;
      // The documented head-SHA condition: a mismatch is a 409 and no merge happens.
      if (body?.sha !== undefined && String(body.sha) !== headSha) {
        return json(409, { message: "Head branch was modified. Review and try the merge again." });
      }
      const denial = evaluate(base, "merge", actor, headSha);
      if (denial) return json(405, { message: denial });
      refs.set(base, headSha);
      return json(200, { sha: headSha, merged: true, message: "Pull Request successfully merged" });
    }
    return json(404, { message: "Not Found" });
  }

  const tokenActor = (token: string) => token.replace(/-(token|jwt)$/, "");

  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const token = String((init.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer\s+/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const result = handle(tokenActor(token), String(init.method ?? "GET"), `${url.pathname}${url.search}`, body);
    return new Response(result.body === null ? "" : JSON.stringify(result.body), { status: result.status });
  }) as unknown as typeof fetch;

  /** A fake `gh`. It asserts the REAL argv shape and reads the body from stdin, never from argv. */
  const spawnImpl = (command: string, args: string[]) => {
    expect(command).toBe("gh");
    expect(args[0]).toBe("api");
    expect(args).toContain("-i");
    const method = args[args.indexOf("--method") + 1];
    const requestPath = args.find((arg, index) => arg.startsWith("/") && args[index - 1] !== "-H")!;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Buffer[] = [];
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.kill = () => {};
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = new Writable({ write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); } });
    child.stdin.on("finish", () => {
      const raw = Buffer.concat(received).toString("utf8");
      // Every argv word must be free of the request body: argv is world-readable.
      expect(args.join(" ")).not.toContain("\"sha\"");
      const parsed = raw ? JSON.parse(raw) : undefined;
      const result = handle("local", method, requestPath, parsed);
      const payload = result.body === null ? "" : JSON.stringify(result.body);
      stdout.on("end", () => child.emit("close", result.status >= 400 ? 1 : 0));
      stdout.end(`HTTP/2.0 ${result.status} Status\r\nContent-Type: application/json\r\n\r\n${payload}`);
    });
    return child;
  };

  return {
    fetchImpl, spawnImpl, refs, rulesets, checks, commits, pulls, calls, handle, isFastForward,
    approvals, jobState, approve, finish, createNormalJob, faults,
    artifacts, publisherRuns, rehearsalRuns, dispatches, addArtifact, publishWitness, archiveImpl,
    registerRehearsalRun: (runId: number) => rehearsalRuns.set(runId, {
      id: runId, head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
      head_branch: "staging", run_attempt: 1, status: "in_progress", conclusion: null,
      actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
    }),
  };
}

let evidenceDir = "";
const created: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  evidenceDir = mkdtempSync(path.join(tmpdir(), "aio1124-"));
  created.push(evidenceDir);
  /**
   * NO PROVIDER CALL MAY LEAVE THIS SUITE.
   *
   * Every phase takes its transport by injection, but "takes it by injection" is a property of the
   * call sites, and a call site that forgot would silently fall back to the module default and hit
   * `api.github.com` — from a test run, with whatever ambient credential the shell has. The failure
   * mode is not a red test; it is a real request. So the real `fetch` is removed for the duration,
   * and any attempt to use it is a loud test failure naming the target.
   */
  globalThis.fetch = ((input: unknown) => {
    throw new Error(`the commissioning suite attempted a real network request to ${String(input)}`);
  }) as unknown as typeof fetch;
});

describe("RIR residual resource lifetime and offline authority regressions", () => {
  const cliResult = async (phase: string, deps: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = LOCAL_ENV) => {
    let raw = "";
    const exit = await main(
      [phase, "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir],
      env,
      { ...deps, write: (text: string) => { raw += text; } },
    );
    return { exit, payload: JSON.parse(raw) };
  };

  it("RIR2 · persistent foreign collision is rechecked on retry and both setup attempts issue zero mutations", async () => {
    const github = createFakeGitHub();
    const desired = transformToDisposable(
      buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS }),
      { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP },
    )[0];
    github.rulesets.set(999999, { ...desired, id: 999999 });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });

    const firstStart = github.calls.length;
    const first = await cliResult("setup", localDeps(github));
    const firstWrites = github.calls.slice(firstStart).filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method));
    const secondStart = github.calls.length;
    const second = await cliResult("setup", localDeps(github));
    const secondWrites = github.calls.slice(secondStart).filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method));

    expect(first.exit).not.toBe(0);
    expect(second.exit).not.toBe(0);
    expect(first.payload.errors.join(" ")).toMatch(/already exists outside an active exact journaled lifetime/);
    expect(second.payload.errors.join(" ")).toMatch(/already exists outside an active exact journaled lifetime/);
    expect(firstWrites).toEqual([]);
    expect(secondWrites).toEqual([]);
    expect(github.rulesets.get(999999)).toEqual(expect.objectContaining({ id: 999999, name: desired.name }));
  });

  it("RIR2 · an intent alone cannot adopt a matching foreign ruleset, while ambiguous-result recovery remains covered", async () => {
    const github = createFakeGitHub();
    const desired = transformToDisposable(
      buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS }),
      { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP },
    )[0];
    github.rulesets.set(999999, { ...desired, id: 999999 });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    await cliResult("setup", localDeps(github));

    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
      journal.append("mutation-intent", {
        kind: "ruleset", actor: "normal", name: desired.name,
        target_ref: desired.conditions.ref_name.include[0], hash: canonicalHash(desired),
      });
    } finally {
      lock.release();
    }

    const before = github.calls.length;
    const retried = await cliResult("setup", localDeps(github));
    const writes = github.calls.slice(before).filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method));
    expect(retried.exit).not.toBe(0);
    expect(writes).toEqual([]);
    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    expect(records).toContainEqual(expect.objectContaining({
      type: "reconciliation",
      data: expect.objectContaining({ outcome: "ownership-unprovable", measured_at_stage: "intent-only-reconciliation" }),
    }));
    expect(records.some((record) => record.type === "resource-created" && record.data.id === 999999)).toBe(false);
  });

  it("RIR1 · confirmed removal retires a ref lifetime, so same-name same-SHA recreation is never deleted", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const ref = derivedRef(RUN_ID, ATTEMPT, "normal");
    const originalSha = github.refs.get(ref)!;
    const first = await cliResult("cleanup", localDeps(github));
    expect(first.exit).toBe(0);
    expect(github.refs.has(ref)).toBe(false);
    const terminalBefore = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }))
      .resources.reduce((count, entry) => count + entry.terminalEvents.length, 0);

    github.refs.set(ref, originalSha);
    const before = github.calls.length;
    const second = await cliResult("cleanup", localDeps(github));
    const deletes = github.calls.slice(before).filter((call) => call.method === "DELETE");
    expect(second.exit).not.toBe(0);
    expect(deletes).toEqual([]);
    expect(github.refs.get(ref)).toBe(originalSha);
    expect(second.payload.errors.join(" ")).toMatch(/remain|fingerprint|retired/i);
    const terminalAfter = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }))
      .resources.reduce((count, entry) => count + entry.terminalEvents.length, 0);
    expect(terminalAfter).toBe(terminalBefore);
  });

  it("RIR1 · an unresolved cleanup intent is read back and safely retried for the same active lifetime", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    const refIdentity = records.find((record) => record.type === "resource-created" && record.data.kind === "ref")!.data;
    const lifecycleKey = resourceLifecycleKey(refIdentity)!;
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
      journal.append("cleanup-intent", {
        kind: "ref", ref: refIdentity.ref, sha: github.refs.get(String(refIdentity.ref)), lifecycle_key: lifecycleKey,
      });
    } finally {
      lock.release();
    }

    const result = await cliResult("cleanup", localDeps(github));
    expect(result.exit).toBe(0);
    expect(github.refs.has(String(refIdentity.ref))).toBe(false);
    const history = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }));
    expect(history.errors).toEqual([]);
    expect(history.resources.find((entry) => entry.key === lifecycleKey)).toMatchObject({ state: "retired", pendingCleanup: null });
  });

  it("RIR3 · final assessment requires retained cleanup transitions and latest closure, not a derived summary", async () => {
    const { clock } = await coherentPacket();
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers).toEqual([]);
    const journalFile = journalPath(evidenceDir, RUN_ID, ATTEMPT);
    const lines = readFileSync(journalFile, "utf8").trimEnd().split("\n");
    const firstCleanup = lines.findIndex((line) => JSON.parse(line).type === "cleanup-intent");
    expect(firstCleanup).toBeGreaterThan(0);
    writeFileSync(journalFile, `${lines.slice(0, firstCleanup).join("\n")}\n`);

    const assessment = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now });
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ gate: "PC-07", kind: "unverified" }));
    const cli = await cliResult("check-evidence", { now: clock.now });
    expect(cli.exit).toBe(3);
  });

  it("RIR4 · retained response observations are authoritative and copied timing cannot move a mutation earlier", async () => {
    const { clock } = await coherentPacket();
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers).toEqual([]);
    const slug = evidenceSlug(RUN_ID, ATTEMPT, "normal");
    const packet = readEvidenceFile(evidenceDir, slug);
    const record = packet.cases[0];
    for (const key of ["started_at", "completed_at"]) {
      record.witness.pre_observation[key] = new Date(Date.parse(record.witness.pre_observation[key]) - 100_000).toISOString();
    }
    record.mutation_started_at = new Date(Date.parse(record.mutation_started_at) - 100_000).toISOString();
    writeEvidenceFile(evidenceDir, slug, packet);

    const blockers = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers;
    expect(blockers.some((entry) => /copied pre observation|mutated before the pre-witness observation/.test(entry.detail))).toBe(true);
  });

  it("RLR1 · a durable reappearance after closure invalidates the earlier cleanup even if interrupted", async () => {
    const { github, clock } = await coherentPacket();
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers).toEqual([]);
    const ref = derivedRef(RUN_ID, ATTEMPT, "normal");
    const owned = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-created" && record.data.kind === "ref" && record.data.ref === ref)!;
    github.refs.set(ref, String(owned.data.sha));
    const before = github.calls.length;
    const transport = async (method: string, endpoint: string, body: unknown) => {
      const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
      if (records.some((record) => record.data?.outcome === "retired-resource-reappeared")) {
        throw new Error("interrupted after durable reappearance");
      }
      return wire(github.handle("local", method, endpoint, body));
    };
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport, now: clock.now } })).rejects.toThrow("interrupted after durable reappearance");
    expect(github.calls.slice(before).filter((call) => call.method === "DELETE")).toEqual([]);
    expect(github.refs.get(ref)).toBe(owned.data.sha);
    const history = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }));
    expect(history.errors).toEqual([]);
    expect(history.resources.find((entry) => entry.key === resourceLifecycleKey(owned.data))?.state).toBe("retired-reappeared");
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers)
      .toContainEqual(expect.objectContaining({ gate: "PC-07", kind: "unverified" }));
    const check = await cliResult("check-evidence", { now: clock.now });
    expect(check.exit).toBe(3);
  });

  it("RLR2 · transient recovery failure then definitive ruleset absence resolves its original intent", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const owned = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-created" && record.data.kind === "ruleset")!.data;
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    let intentSeq: number;
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
      intentSeq = journal.append("cleanup-intent", { kind: "ruleset", id: owned.id, name: owned.name,
        lifecycle_key: resourceLifecycleKey(owned) }).seq;
    } finally { lock.release(); }
    github.rulesets.delete(Number(owned.id));
    let reads = 0;
    const transport = async (method: string, endpoint: string, body: unknown) => {
      if (method === "GET" && endpoint === `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}` && ++reads === 1) {
        return wire({ status: 503, body: { message: "temporary unavailable" } });
      }
      return wire(github.handle("local", method, endpoint, body));
    };
    const first = await cliResult("cleanup", { transport });
    expect(first.exit).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(2);
    const history = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }));
    expect(history.errors).toEqual([]);
    expect(history.resources.find((entry) => entry.key === resourceLifecycleKey(owned))?.pendingCleanup).toBeNull();
    expect((readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-retired" && record.data.id === owned.id)?.data.cleanup_intent_seq).toBe(intentSeq);
    expect((await cliResult("cleanup", { transport })).exit).toBe(0);
  });

  it("RLR2 · transient recovery failure then confirmed PR closure resolves its original intent", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const owned = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-created" && record.data.kind === "pull-request")!.data;
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    let intentSeq: number;
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
      intentSeq = journal.append("cleanup-intent", { kind: "pull-request", number: owned.number,
        lifecycle_key: resourceLifecycleKey(owned) }).seq;
    } finally { lock.release(); }
    github.pulls.get(Number(owned.number))!.state = "closed";
    let reads = 0;
    const transport = async (method: string, endpoint: string, body: unknown) => {
      if (method === "GET" && endpoint === `/repos/${COMMISSIONING_REPOSITORY}/pulls/${owned.number}` && ++reads === 1) {
        return wire({ status: 503, body: { message: "temporary unavailable" } });
      }
      return wire(github.handle("local", method, endpoint, body));
    };
    expect((await cliResult("cleanup", { transport })).exit).toBe(0);
    const history = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }));
    expect(history.errors).toEqual([]);
    expect(history.resources.find((entry) => entry.key === resourceLifecycleKey(owned))?.pendingCleanup).toBeNull();
    expect((readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-retired" && record.data.number === owned.number)?.data.cleanup_intent_seq).toBe(intentSeq);
  });

  it("RLR3 · mutation one millisecond before authenticated pre-response receipt is rejected", async () => {
    const { clock } = await coherentPacket();
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers).toEqual([]);
    const slug = evidenceSlug(RUN_ID, ATTEMPT, "normal");
    const packet = readEvidenceFile(evidenceDir, slug);
    const record = packet.cases[0];
    const receipt = Date.parse(record.witness.pre_received_at);
    const observed = Date.parse(record.witness.pre_response.observation.completed_at);
    expect(receipt).toBeGreaterThan(observed);
    record.mutation_started_at = new Date(receipt - 1).toISOString();
    record.witness.pre_to_mutation_ms = receipt - 1 - observed;
    writeEvidenceFile(evidenceDir, slug, packet);
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, now: clock.now }).blockers)
      .toContainEqual(expect.objectContaining({ detail: expect.stringMatching(/mutated before the authenticated pre-response/) }));
    expect((await cliResult("check-evidence", { now: clock.now })).exit).toBe(1);
  });

  it("CA1 · setup refuses a durably reappeared retired PR-head ref before any write", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const ref = derivedRef(RUN_ID, ATTEMPT, "pr-head");
    const original = github.refs.get(ref)!;
    const firstTransport = async (method: string, endpoint: string, body: unknown) => {
      if (method === "DELETE" && endpoint.includes("/rulesets/")) {
        return wire({ status: 403, body: { message: "forbidden" } });
      }
      const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
      if (records.some((record) => record.type === "cleanup-result" && record.data.kind === "ref"
        && record.data.ref === ref && record.data.removed === true)) {
        throw new Error("stop after exact ref retirement");
      }
      return wire(github.handle("local", method, endpoint, body));
    };
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: firstTransport } })).rejects.toThrow("stop after exact ref retirement");
    expect(github.refs.has(ref)).toBe(false);

    github.refs.set(ref, original);
    const secondTransport = async (method: string, endpoint: string, body: unknown) => {
      if (method === "DELETE" && endpoint.includes("/rulesets/")) {
        return wire({ status: 403, body: { message: "forbidden" } });
      }
      const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
      if (records.some((record) => record.data?.outcome === "retired-resource-reappeared")) {
        throw new Error("stop after durable reappearance");
      }
      return wire(github.handle("local", method, endpoint, body));
    };
    const beforeSecond = github.calls.length;
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: secondTransport } })).rejects.toThrow("stop after durable reappearance");
    expect(github.refs.get(ref)).toBe(original);
    expect(github.calls.slice(beforeSecond).some((call) => call.method === "DELETE" && call.path.endsWith(`/heads/${ref.split("/").at(-1)}`))).toBe(false);

    const history = reduceResourceLifecycles(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }));
    expect(history.errors).toEqual([]);
    expect(history.resources.find((entry) => entry.identity.ref === ref)?.state).toBe("retired-reappeared");
    const beforeSetup = github.calls.length;
    const setup = await cliResult("setup", localDeps(github));
    expect(setup.exit).not.toBe(0);
    expect(setup.payload.errors.join(" ")).toMatch(/outside an active exact journaled lifetime/);
    expect(github.calls.slice(beforeSetup).filter((call) => ["POST", "PATCH", "DELETE", "PUT"].includes(call.method))).toEqual([]);
    expect(github.refs.get(ref)).toBe(original);
  });

  it("CA1 · a reappeared retired lifetime cannot accept a fresh cleanup intent", () => {
    const identity = { kind: "ref", ref: derivedRef(RUN_ID, ATTEMPT, "pr-head"), sha: "a".repeat(40) };
    const lifecycleKey = resourceLifecycleKey(identity)!;
    const event = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, kind: "resource", data });
    const prefix = [
      event(1, "resource-created", identity),
      event(2, "cleanup-intent", { ...identity, lifecycle_key: lifecycleKey }),
      event(3, "cleanup-result", { ...identity, lifecycle_key: lifecycleKey, removed: true, readback_absent: true, readback_sha: null }),
      event(4, "reconciliation", { ...identity, lifecycle_key: lifecycleKey, outcome: "retired-resource-reappeared", readback_sha: identity.sha }),
    ];
    expect(reduceResourceLifecycles(prefix).resources[0]).toMatchObject({ state: "retired-reappeared", pendingCleanup: null });
    const refused = reduceResourceLifecycles([...prefix, event(5, "cleanup-intent", { ...identity, lifecycle_key: lifecycleKey })]);
    expect(refused.errors).toContainEqual(expect.stringMatching(/tries to mutate retired lifetime/));
    expect(refused.resources[0]).toMatchObject({ state: "retired-reappeared", pendingCleanup: null });
    const absent = reduceResourceLifecycles([...prefix, event(5, "resource-retired", {
      ...identity, lifecycle_key: lifecycleKey, reason: "confirmed-absent", readback_absent: true, readback_sha: null,
    })]);
    expect(absent.errors).toEqual([]);
    expect(absent.resources[0]).toMatchObject({ state: "retired", pendingCleanup: null });
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cloudEnv = (job: string, extra: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: COMMISSIONING_REPOSITORY,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/staging",
  GITHUB_SHA: WORKFLOW_SHA,
  GITHUB_WORKFLOW_REF: `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@refs/heads/staging`,
  GITHUB_RUN_ID: RUN_ID,
  GITHUB_RUN_ATTEMPT: ATTEMPT,
  GITHUB_JOB: job,
  GITHUB_ACTOR: DISPATCHER_IDENTITY.login,
  GITHUB_TOKEN: "fixture-token",
  // The runner's own mode admission, independent of the workflow's `if:`.
  COMMISSIONING_MODE: "commission",
  // Platform-injected, and the only identity fact the credential-free intent phase can cross-check
  // without a provider call.
  GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
  COMMISSIONING_REPOSITORY_ID: String(REPOSITORY_ID),
  COMMISSIONING_NORMAL_APP_ID: String(NORMAL_APP),
  COMMISSIONING_EMERGENCY_APP_ID: String(EMERGENCY_APP),
  // The PLANNED installations, from nonsecret commissioning configuration. The protected jobs'
  // own `*_INSTALLATION_ID` values must equal these before any credential is exchanged.
  COMMISSIONING_NORMAL_INSTALLATION_ID: "5001",
  COMMISSIONING_EMERGENCY_INSTALLATION_ID: "5002",
  COMMISSIONING_PRODUCER_IDS_JSON: JSON.stringify(PRODUCER_IDS),
  ...extra,
}) as unknown as NodeJS.ProcessEnv;

const LOCAL_ENV = { COMMISSIONING_PRODUCER_IDS_JSON: JSON.stringify(PRODUCER_IDS) } as unknown as NodeJS.ProcessEnv;

const NORMAL_JOB_ENV = { RELEASE_APP_ID: String(NORMAL_APP), RELEASE_APP_INSTALLATION_ID: "5001", RELEASE_APP_PRIVATE_KEY: SENTINEL_KEY };
const EMERGENCY_JOB_ENV = { EMERGENCY_APP_ID: String(EMERGENCY_APP), EMERGENCY_APP_INSTALLATION_ID: "5002", EMERGENCY_APP_PRIVATE_KEY: SENTINEL_KEY };

const mintToken = async ({ appId }: { appId: string }) => (Number(appId) === NORMAL_APP ? "normal-token" : "emergency-token");
/**
 * A stubbed App JWT. The real `mintAppJwt` signs with `jose` and is exercised directly in its own
 * case below; here the point is the credential's IDENTITY, which the fake resolves the same way
 * GitHub resolves a JWT issuer.
 */
const mintAppJwtStub = async ({ appId }: { appId: string }) => (Number(appId) === NORMAL_APP ? "normal-jwt" : "emergency-jwt");

const localDeps = (github: ReturnType<typeof createFakeGitHub>) => ({ spawnImpl: github.spawnImpl });
const cloudDeps = (github: ReturnType<typeof createFakeGitHub>) => ({
  fetchImpl: github.fetchImpl, createInstallationToken: mintToken, mintAppJwt: mintAppJwtStub,
});

/**
 * The intent job as the workflow actually runs it: NO `GITHUB_TOKEN`, and no transport passed in.
 * If the phase ever reached the provider again this would throw rather than quietly pass.
 */
const INTENT_ENV = () => {
  const env = { ...cloudEnv("intent") } as Record<string, string>;
  delete env.GITHUB_TOKEN;
  return env as unknown as NodeJS.ProcessEnv;
};

async function intentAndSetup(github: ReturnType<typeof createFakeGitHub>, clock?: () => Date) {
  const intent = await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
  const setup = await runPhase({
    phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
    deps: clock ? { ...localDeps(github), now: clock } : localDeps(github),
  });
  return { intent, setup };
}

/**
 * ── THE STAGED ACTOR FLOW, AS THE WORKFLOW RUNS IT ────────────────────────────────────────────────
 *
 * Each case is five steps, two of which are `actions/upload-artifact`. The runner owns three; the
 * suite plays the other two — {@link publishChallenge} is the upload step, and the local witness is
 * driven item-by-item with {@link serveWitnessItem} so the test does not have to run a blocking
 * process concurrently with the job it is serving. `runWitnessPhase` is exercised separately, against
 * a source run whose challenges are all already published.
 */
const cloudDir = (name: "challenges" | "state") => path.join(evidenceDir, name);

/** The upload step: take the challenge file the stage wrote and register it as an artifact. */
const publishChallenge = (github: ReturnType<typeof createFakeGitHub>, role: string, ordinal: number, direction: "pre" | "post") => {
  const name = challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role, ordinal, direction });
  const bytes = readFileSync(path.join(cloudDir("challenges"), `${name}.json`));
  return github.addArtifact(name, `${name}.json`, bytes, Number(RUN_ID));
};

/** The local witness, serving exactly one work item — the read-only half of the transport. */
async function serveOne(github: ReturnType<typeof createFakeGitHub>, item: { role: string; caseId: string; ordinal: number; direction: "pre" | "post" }, overrides: Record<string, unknown> = {}, clock?: () => Date) {
  const session = await openWitnessSession({
    runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
    deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl, ...(clock ? { now: clock } : {}) },
  });
  try {
    return await serveWitnessItem({
      request: session.request, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
      item, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      now: clock ?? (() => new Date()), sleep: async () => {}, intervalMs: 1, ...overrides,
    });
  } finally { session.lock.release(); }
}

/**
 * Register the ORIGINAL run's credential-free intent artifact, exactly as its upload step does.
 *
 * The publisher reads this to learn the run's planned App identities before it validates a governed
 * projection, so a fixture that omits it is a fixture in which the publisher cannot do its job.
 */
async function publishIntentArtifact(github: ReturnType<typeof createFakeGitHub>) {
  let intent = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "intent"));
  if (!intent) {
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    intent = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "intent"));
  }
  return github.addArtifact(
    intentArtifactName(RUN_ID, ATTEMPT), intentArtifactEntry(RUN_ID, ATTEMPT),
    Buffer.from(`${JSON.stringify(intent)}\n`, "utf8"), Number(RUN_ID),
  );
}

/** Run one case end to end: prepare → upload → serve → execute → upload → serve → finalize. */
async function runCase(github: ReturnType<typeof createFakeGitHub>, role: "normal" | "emergency", caseId: string, clock?: () => Date) {
  const ordinal = CLOUD_CASE_SEQUENCE[role].indexOf(caseId) + 1;
  const env = cloudEnv(role, { ...(role === "normal" ? NORMAL_JOB_ENV : EMERGENCY_JOB_ENV), COMMISSIONING_EVIDENCE_DIR: evidenceDir });
  const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1, ...(clock ? { now: clock } : {}) };
  await runCaseStage({ stage: "prepare", caseId, env, deps });
  publishChallenge(github, role, ordinal, "pre");
  await serveOne(github, { role, caseId, ordinal, direction: "pre" }, {}, clock);
  await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
  publishChallenge(github, role, ordinal, "post");
  await serveOne(github, { role, caseId, ordinal, direction: "post" }, {}, clock);
  return runCaseStage({ stage: "await-and-finalize", caseId, env, deps });
}

/**
 * Every case a role owns, stopping at the first that refuses — which is what the workflow does, since
 * a failing step ends the job's remaining steps. The finalizer then still runs under `if: always()`.
 */
async function runRoleCasesUntilRefusal(github: ReturnType<typeof createFakeGitHub>, role: "normal" | "emergency") {
  for (const caseId of CLOUD_CASE_SEQUENCE[role]) {
    try { await runCase(github, role, caseId); }
    catch (error) { return { stoppedAt: caseId, error: error as Error }; }
  }
  return { stoppedAt: null, error: null };
}

/** Every case a role owns, in its closed sequence order. */
async function runRoleCases(github: ReturnType<typeof createFakeGitHub>, role: "normal" | "emergency", clock?: () => Date) {
  const results = [];
  for (const caseId of CLOUD_CASE_SEQUENCE[role]) results.push(await runCase(github, role, caseId, clock));
  return results;
}

/** The whole reviewed order: intent → setup → fixture → normal → human → emergency → cleanup. */
async function commissionEverything(github: ReturnType<typeof createFakeGitHub>, options: { now?: () => Date } = {}) {
  const clock = options.now;
  const withClock = <T extends Record<string, unknown>>(deps: T) => (clock ? { ...deps, now: clock } : deps);
  await intentAndSetup(github, clock);
  const fixture = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
  // What GitHub and the human do, in the order they do it: the fixture finishing is what lets
  // `normal` be created at all, and only then can anyone approve it.
  github.createNormalJob();
  github.approve("normal", OWNER_LOGIN, "User", OWNER_USER_ID, clock ? clock().toISOString() : undefined);
  await runNormalCheckPublication({
    env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }),
    deps: withClock(cloudDeps(github)),
  });
  await runRoleCases(github, "normal", clock);
  github.finish("normal");
  const normal = await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: withClock(cloudDeps(github)) });
  const human = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: withClock(localDeps(github)) });
  github.approve("emergency", OWNER_LOGIN, "User", OWNER_USER_ID, clock ? clock().toISOString() : undefined);
  await runRoleCases(github, "emergency", clock);
  github.finish("emergency");
  const emergency = await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: withClock(cloudDeps(github)) });
  // The local witness process's own summary. Every response is already published, so this RECONCILES
  // all 22 rather than dispatching again — which is the property that makes a restarted witness safe.
  const witness = await runPhase({
    phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
    deps: withClock({ spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 }),
  });
  return { fixture, normal, human, emergency, witness };
}

/**
 * Build a complete, VALID PC-06 environment-controls packet: one bound proof per control per
 * protected environment, each naming a retained artifact whose SHA-256 is recomputed from disk by
 * `assessEvidence`. This is what "not a boolean" costs, and it is the whole point — the packet cannot
 * be satisfied by typing a word.
 */
const environmentControls = (
  dir: string,
  mutate: (controls: Record<string, Record<string, unknown>>) => void = () => {},
  options: { measuredAt?: string } = {},
) => {
  /**
   * A COHERENT capture time, not a year that has not happened.
   *
   * This fixture used to stamp every control `2099-01-01`, and the packet passed — which is the
   * defect the retained reviewer baseline demonstrates, not a property to preserve. A control
   * captured after the run it describes is exactly as unmoored as one captured before it.
   */
  const measuredAt = options.measuredAt ?? new Date().toISOString();
  const controls: Record<string, Record<string, unknown>> = {};
  const schemas = ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { sources: string[]; expected: unknown; run_bound: boolean }>;
  for (const key of ENVIRONMENT_CONTROL_KEYS as string[]) {
    controls[key] = {};
    for (const [index, spec] of (PROTECTED_JOBS as { environment: string }[]).entries()) {
      const schema = schemas[key];
      const name = `env-${key}-${spec.environment}.json`;
      // The artifact must be ABOUT this control on this environment, with this measurement: reusing
      // one file across controls or environments is a refusal, which is the F2 correction. And it
      // carries its OWN provenance — source, numeric environment ID, capture time and (for a run-bound
      // control) run/attempt — which the wrapper may only repeat (R3).
      const provenance = {
        environment_id: 4400 + index, source: schema.sources[0], measured_at: measuredAt,
        ...(schema.run_bound ? { run_id: RUN_ID, attempt: ATTEMPT } : {}),
      };
      const bytes = Buffer.from(`${JSON.stringify({ control: key, environment: spec.environment, measured: schema.expected, ...provenance }, null, 2)}\n`, "utf8");
      writeFileSync(path.join(dir, name), bytes);
      controls[key][spec.environment] = {
        status: "verified", environment_name: spec.environment,
        expected: schema.expected, measured: schema.expected, ...provenance,
        artifact: name, artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
  }
  mutate(controls);
  return writeEvidenceFile(dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
    schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls,
  });
};

/** A monotonic clock: fixed origin, small tick, so every bound in the harness stays satisfiable. */
function createTestClock(origin = "2026-09-10T09:00:00.000Z", tickMs = 10) {
  let value = Date.parse(origin);
  return {
    now: () => new Date((value += tickMs)),
    /** The clock's CURRENT instant, without advancing it — for stamping evidence coherently. */
    peek: () => new Date(value).toISOString(),
    after: (ms: number) => new Date(value + ms).toISOString(),
  };
}

/**
 * The corrected valid packet: every phase, the controls and the approval share ONE clock, and the
 * controls are captured DURING the run rather than in a year that has not happened.
 */
async function coherentPacket() {
  const clock = createTestClock();
  const github = createFakeGitHub();
  await commissionEverything(github, { now: clock.now });
  await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { ...localDeps(github), now: clock.now } }).catch(() => {});
  await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { ...localDeps(github), now: clock.now } });
  // Captured inside the run's own window, which is what "this run's evidence" means.
  environmentControls(evidenceDir, () => {}, { measuredAt: clock.peek() });
  return { github, clock };
}

/** Deterministic, instant timing for the fixture's bounded wait — no real clock, no real sleep. */
const WAIT = { intervalMs: 1, deadlineMs: 1_000, now: () => 0, sleep: async () => {} };

/**
 * ── A CURRENT, VALID GOVERNED OBSERVATION, AND ITS ONE-INVARIANT MUTATIONS (F2/F11) ──────────────
 *
 * The witness schema is CLOSED now, so a test that hands the validator a three-field object is
 * testing the closed key set rather than the invariant it names. Every negative case below
 * therefore starts from THIS — a packet that passes — and changes exactly one thing.
 *
 * `padding` exists for the envelope-bound case: it produces a response that is schema-valid and
 * too large, which is the only way to prove the bound is measured on the serialized envelope
 * rather than on whatever happened to be malformed.
 */
/** The complete closed binding a challenge and its response must agree about, exactly. */
const WITNESS_BINDING = {
  domain: "commission", repository: COMMISSIONING_REPOSITORY, repository_id: REPOSITORY_ID,
  source_mode: "commission", original_run_id: RUN_ID, original_attempt: ATTEMPT,
  workflow_path: COMMISSIONING_WORKFLOW_PATH, source_sha: WORKFLOW_SHA,
  role: "normal", job_id: "normal", case_id: "normal-update-missing-check", case_ordinal: 1,
  direction: "pre", target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"),
  intended_app_id: NORMAL_APP, intended_installation_id: "5001",
  manifest_sha256: "c".repeat(64), graph_sha256: "d".repeat(64),
};

/**
 * Recompute a governed observation's OWN losslessness digest.
 *
 * `validObservation` carries a placeholder, which is fine for the shape-only callers it was written
 * for. Any caller that reaches {@link validateGovernedSnapshot} needs the real thing, or it refuses
 * on the digest before reaching the invariant under test — and a negative case that trips two rules
 * proves neither.
 */
const withGovernedDigest = (observation: Record<string, unknown>) => {
  const rulesets = observation.governed_rulesets as { governed: unknown }[];
  observation.projected_governed_digest = canonicalHash(rulesets.map((entry) => entry.governed));
  return observation;
};

/** The closed vocabulary the publisher derives from the run's authenticated intent. */
const plannedVocabulary = (role: "normal" | "emergency" = "normal") => ({
  rulesetNames: new Set(Object.values(derivedRulesetNames(RUN_ID, ATTEMPT)[role] ?? [])),
  refPatterns: new Set([derivedRef(RUN_ID, ATTEMPT, role)]),
  contexts: new Set(derivedContextNames(RUN_ID, ATTEMPT)),
  producerIds: new Set([NORMAL_APP]),
  bypassAppIds: new Set([NORMAL_APP, EMERGENCY_APP]),
  sources: new Set([COMMISSIONING_REPOSITORY, COMMISSIONING_REPOSITORY.split("/")[0]]),
});

const validObservation = (overrides: Record<string, unknown> = {}, padding = 0) => {
  const started = "2026-09-10T09:00:00.000Z";
  const governed = [{
    id: 7001, source_type: "Repository", source: COMMISSIONING_REPOSITORY,
    governed: {
      name: derivedRulesetName(RUN_ID, ATTEMPT, "normal", "main-integrity"),
      target: "branch", enforcement: "active",
      conditions: { ref_name: { include: [derivedRef(RUN_ID, ATTEMPT, "normal")], exclude: [] } },
      bypass_actors: [], rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    },
  }];
  const padded = padding
    ? [...governed, ...Array.from({ length: padding }, () => structuredClone(governed[0]))]
    : governed;
  return {
    started_at: started, completed_at: started, span_ms: 0,
    applicability_pages: 1, source_identities: [COMMISSIONING_REPOSITORY],
    classic_protection: { present: false, status: 404 },
    governed_rulesets: padded,
    raw_governed_digest: "a".repeat(64), projected_governed_digest: "b".repeat(64),
    ...overrides,
  };
};

// ── PC-01 ─────────────────────────────────────────────────────────────────────

describe("PC-01 fixed targets and request-boundary allowlists refuse before credentials or network", () => {
  const ctx = { role: "local", runId: RUN_ID, attempt: ATTEMPT, graphShas: new Set([sha("x")]), contextNames: new Set(derivedContextNames(RUN_ID, ATTEMPT)), rulesetIds: new Set([7001]), rulesetNames: new Set([derivedRulesetName(RUN_ID, ATTEMPT, "normal", "main-integrity")]), pullNumber: 42 };

  it.each([
    ["refs/heads/main", "the production branch"],
    ["refs/heads/staging", "the dispatch branch"],
    ["refs/tags/v1.2.3", "a tag"],
    ["refs/heads/aios-policy-commissioning/run-9001-2-../../main", "a traversal"],
    ["refs/heads/aios-policy-commissioning/run-9001-2-*", "a wildcard"],
    ["refs%2Fheads%2Fmain", "a percent-encoded target"],
    ["refs/heads/aios-policy-commissioning/run-9001-2-ma%2569n", "a double-encoded target"],
    ["refs/heads/aios-policy-commissioning/run-9002-2-normal", "another run's ref"],
    ["refs/heads/aios-policy-commissioning/run-9001-2-admin", "an unknown actor suffix"],
  ])("refuses %s (%s)", (ref) => {
    expect(() => assertDerivedRef(ref, { runId: RUN_ID, attempt: ATTEMPT })).toThrow();
  });

  it("accepts exactly the four derived refs and nothing else", () => {
    const refs = derivedRefs(RUN_ID, ATTEMPT);
    expect(Object.keys(refs).sort()).toEqual(["emergency", "human", "normal", "pr-head"]);
    for (const ref of Object.values(refs)) expect(assertDerivedRef(ref, { runId: RUN_ID, attempt: ATTEMPT })).toBe(ref);
  });

  it("refuses an endpoint outside the allowlist, an absolute URL, and an unlisted query parameter", () => {
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/git/tags`, body: {} }, ctx)).toThrow(/outside its allowlist/);
    expect(() => assertAllowedRequest({ method: "GET", path: "https://evil.example/repos", body: undefined }, ctx)).toThrow();
    expect(() => assertAllowedRequest({ method: "GET", path: `/repos/${COMMISSIONING_REPOSITORY}/rulesets?callback=x`, body: undefined }, ctx)).toThrow(/query parameter/);
  });

  it("refuses a PATCH of main even though PATCH of a derived ref is allowed", () => {
    const derived = derivedRef(RUN_ID, ATTEMPT, "normal").slice("refs/heads/".length);
    expect(assertAllowedRequest({ method: "PATCH", path: `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${derived}`, body: { sha: sha("x"), force: false } }, ctx)).toBe("update-derived-ref");
    expect(() => assertAllowedRequest({ method: "PATCH", path: `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/main`, body: { sha: sha("x"), force: false } }, ctx)).toThrow();
  });

  it("refuses a ruleset deletion for an ID this run never journaled — an injected ID cannot be laundered through the helper", () => {
    expect(assertAllowedRequest({ method: "DELETE", path: `/repos/${COMMISSIONING_REPOSITORY}/rulesets/7001`, body: undefined }, ctx)).toBe("delete-disposable-ruleset");
    expect(() => assertAllowedRequest({ method: "DELETE", path: `/repos/${COMMISSIONING_REPOSITORY}/rulesets/22363258`, body: undefined }, ctx)).toThrow(/journaled/);
  });

  it("refuses a check-run on an unverified commit, a real production context name, and a synthetic tree carrying a workflow", () => {
    const context = derivedContextNames(RUN_ID, ATTEMPT)[0];
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/check-runs`, body: { name: context, head_sha: MAIN_SHA, conclusion: "success" } }, { ...ctx, role: "normal" })).toThrow(/verified synthetic commit/);
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/check-runs`, body: { name: "Brain unit tests (vitest)", head_sha: sha("x"), conclusion: "success" } }, { ...ctx, role: "normal" })).toThrow(/TEST-ONLY/);
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/git/trees`, body: { tree: [{ path: ".github/workflows/x.yml", mode: "100644", type: "blob", content: "" }] } }, ctx)).toThrow(/may not contain/);
  });

  it("scopes each operation to a role: the emergency job cannot publish a check and no job can read main's protection", () => {
    const emergency = { ...ctx, role: "emergency" };
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/check-runs`, body: { name: derivedContextNames(RUN_ID, ATTEMPT)[0], head_sha: sha("x"), conclusion: "success" } }, emergency)).toThrow(/may not issue/);
    expect(() => assertAllowedRequest({ method: "GET", path: `/repos/${COMMISSIONING_REPOSITORY}/branches/main/protection`, body: undefined }, emergency)).toThrow(/may not issue/);
  });

  /**
   * The literal, non-negotiable prefix an operation can match.
   *
   * `String(regexp)` is NOT this: `new RegExp("/repos/a/b")` stringifies with its slashes escaped
   * (`/\/repos\/a\/b/`), so a substring test for `a/b` against it is always false and a guard
   * written that way is green no matter what the table says. Read `source`, unescape the slashes,
   * and stop at the first metacharacter — what is left is the fixed text every matching path starts
   * with.
   */
  const literalPrefix = (operation: { path?: string; pattern?: RegExp }): string => {
    if (operation.path) return operation.path;
    const source = operation.pattern!.source.replace(/^\^/, "").replace(/\\\//g, "/");
    return source.split(/[([{.*+?^$|\\]/)[0];
  };

  it("every declared operation is anchored inside one of the four fixed API scopes", () => {
    expect(ALLOWED_OPERATIONS.length).toBeGreaterThan(20);
    for (const operation of ALLOWED_OPERATIONS) {
      const prefix = literalPrefix(operation);
      // Scope-or-child, never scope-as-substring: `/repos/aiosbrain/aios-team-brain-elsewhere`
      // starts with the fixed repository's path and is a DIFFERENT repository.
      const scoped = ALLOWED_REQUEST_SCOPES.some((scope: string) => prefix === scope || prefix.startsWith(`${scope}/`));
      expect(scoped, `operation ${operation.id} is anchored at ${JSON.stringify(prefix)}`).toBe(true);
      // An unanchored pattern would match the prefix ANYWHERE in the path, so the fixed scope in
      // front of it would guarantee nothing at all.
      if (operation.pattern) expect(operation.pattern.source.startsWith("^"), `operation ${operation.id} pattern is unanchored`).toBe(true);
    }
    // The `intent` role holds no credential and must therefore be able to issue NOTHING.
    expect(ALLOWED_OPERATIONS.filter((operation) => operation.roles.includes("intent"))).toEqual([]);
  });

  it("refuses every request aimed at another repository, owner or organisation — by measurement, not by spelling", () => {
    const derived = derivedRef(RUN_ID, ATTEMPT, "normal").slice("refs/heads/".length);
    // Each of these is a real operation's path with ONLY the scope swapped, so a boundary that
    // accepted any of them would be one that reads the repository from the request.
    const foreign = [
      `/repos/other-owner/aios-team-brain/git/refs/heads/${derived}`,
      `/repos/aiosbrain/aios-team-brain-elsewhere/git/refs/heads/${derived}`,
      `/repos/aiosbrain/other-repo/rulesets/7001`,
      `/repos/aiosbrain/aios-team-brain/../other-repo/git/refs/heads/${derived}`,
      "/repos/aiosbrain/aios-team-brain.wiki/rulesets",
      "/orgs/other-org/rulesets/7001",
      "/orgs/aiosbrain-evil/rulesets/7001",
      // The App scope: the endpoints are fixed and installation-bound, and there is no `/apps/…`
      // route in the allowlist at all.
      "/apps/other-app",
      "/app/hook/config",
      "/user/repos",
      "/installation/repositories/other",
      "//api.evil.example/repos/aiosbrain/aios-team-brain",
      "https://api.evil.example/repos/aiosbrain/aios-team-brain",
    ];
    for (const requestPath of foreign) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        expect(
          () => assertAllowedRequest({ method, path: requestPath, body: undefined }, ctx),
          `${method} ${requestPath}`,
        ).toThrow();
      }
    }
    // NON-VACUITY: the same sweep run over the CORRECT scope must be admitted, or the loop above
    // would pass just as well against a boundary that refused everything.
    expect(assertAllowedRequest({ method: "GET", path: `/repos/${COMMISSIONING_REPOSITORY}/rulesets`, body: undefined }, ctx)).toBe("list-repository-rulesets");
  });

  it("exits 2 on an unknown flag WITHOUT reaching a transport", async () => {
    let touched = 0;
    const code = await main(
      ["setup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir, "--repo", "other/repo"],
      LOCAL_ENV,
      { write: () => {}, spawnImpl: () => { touched += 1; throw new Error("unreachable"); } },
    );
    expect(code).toBe(2);
    expect(touched).toBe(0);
  });

  it("rejects a non-decimal run ID, a relative evidence directory and a duplicated flag", () => {
    expect(() => parseArgs(["setup", "--run-id", "0x10", "--attempt", "1", "--evidence-dir", "/tmp/x"])).toThrow(/positive decimal/);
    expect(() => parseArgs(["setup", "--run-id", "1", "--attempt", "1", "--evidence-dir", "relative"])).toThrow(/absolute/);
    expect(() => parseArgs(["setup", "--run-id", "1", "--run-id", "2", "--attempt", "1", "--evidence-dir", "/tmp/x"])).toThrow(/more than once/);
    expect(() => parseArgs(["promote", "--run-id", "1", "--attempt", "1", "--evidence-dir", "/tmp/x"])).toThrow(/usage/);
  });
});

// ── PC-02 / PC-03 ─────────────────────────────────────────────────────────────

describe("PC-02/PC-03 immutable run identity, ordered bootstrap and the credential-free producer", () => {
  it("records the intent with derived names and refuses a run whose identity does not match the platform's", async () => {
    const github = createFakeGitHub();
    const result = await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) });
    expect(result.status).toBe("recorded");
    const intent = readEvidenceFile(evidenceDir, `${RUN_ID}-${ATTEMPT}-intent`);
    expect(intent.derived_refs.normal).toBe(`refs/heads/aios-policy-commissioning/run-${RUN_ID}-${ATTEMPT}-normal`);
    expect(intent.dispatcher).toBe("aios-commissioning-dispatcher[bot]");
    // The dispatcher is never the approval evidence.
    expect(intent.dispatcher_is_human).toBeNull();
    await expect(runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { GITHUB_RUN_ID: "9999", GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) }))
      .rejects.toThrow(/GITHUB_RUN_ID/);
  });

  it.each([
    ["GITHUB_REPOSITORY", "someone/else"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_WORKFLOW_REF", `${COMMISSIONING_REPOSITORY}/.github/workflows/other.yml@refs/heads/staging`],
    ["GITHUB_JOB", "some-other-job"],
  ])("refuses a job whose %s is not the reviewed commissioning context", async (name, value) => {
    const github = createFakeGitHub();
    await expect(runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { [name]: value, GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) })).rejects.toThrow();
  });

  it("refuses to run the fixture producer outside its own job, and publishes ONLY the wrong-producer commit", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await expect(runFixtureChecks(cloudEnv("normal", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl })).rejects.toThrow(/fixture job/);
    const result = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl });
    expect(result.status).toBe("published");
    expect(result.measured_producer_app_ids).toEqual([ACTIONS_APP]);
    expect(new Set((result.published as { node: string }[]).map((entry) => entry.node))).toEqual(new Set(["N3"]));
    expect(result.published).toHaveLength(REQUIRED_MAIN_CONTEXTS.length);
  });

  it("refuses a protected job that can see BOTH release keys, or whose App ID is not the configured identity", async () => {
    const github = createFakeGitHub();
    const ctx = { runId: RUN_ID, attempt: ATTEMPT, repositoryId: REPOSITORY_ID, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS };
    // The credential admission checks run BEFORE any request — so they are exercised where they
    // live, at the just-in-time mint, rather than through a whole phase that would reach the
    // provider first.
    await expect(mintActorCredential({
      role: "normal", ctx, redact: createRedactor(), deps: cloudDeps(github),
      env: cloudEnv("normal", { ...NORMAL_JOB_ENV, EMERGENCY_APP_PRIVATE_KEY: SENTINEL_KEY }),
    })).rejects.toThrow(/must not share a job/);
    await expect(mintActorCredential({
      role: "normal", ctx, redact: createRedactor(), deps: cloudDeps(github),
      env: cloudEnv("normal", { ...NORMAL_JOB_ENV, RELEASE_APP_ID: "999" }),
    })).rejects.toThrow(/not the identity/);
    // And a NON-actor role can never exchange an App credential at all: the refusal is a property of
    // the closed role table, not of a conditional at the call site (F7).
    for (const role of ["intent", "fixture", "witness-publisher", "rehearsal"]) {
      await expect(mintActorCredential({ role, ctx, redact: createRedactor(), deps: cloudDeps(github), env: cloudEnv("normal", NORMAL_JOB_ENV) }))
        .rejects.toThrow(/not an actor role/);
    }
  });

  it("refuses to start when a protected job has already left the waiting state", async () => {
    const github = createFakeGitHub({ jobStatus: "in_progress" });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/already left the waiting state/);
  });

  it("refuses a collision rather than adopting or deleting a resource it did not create", async () => {
    const github = createFakeGitHub();
    github.refs.set(derivedRef(RUN_ID, ATTEMPT, "human"), MAIN_SHA);
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/refuses to adopt or delete/);
    expect(github.refs.get(derivedRef(RUN_ID, ATTEMPT, "human"))).toBe(MAIN_SHA);
  });

  it("binds the manifest to the job's own trusted context and refuses one that disagrees", () => {
    const good = { schema_version: 1, repository: COMMISSIONING_REPOSITORY, run_id: RUN_ID, attempt: ATTEMPT, workflow_path: COMMISSIONING_WORKFLOW_PATH, workflow_sha: WORKFLOW_SHA, repository_id: REPOSITORY_ID, normal_app_id: NORMAL_APP, emergency_app_id: EMERGENCY_APP, refs: derivedRefs(RUN_ID, ATTEMPT), test_contexts: derivedContextNames(RUN_ID, ATTEMPT), graph: {} };
    const ctx = { workflowSha: WORKFLOW_SHA, repositoryId: REPOSITORY_ID, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP };
    expect(assertManifestBinding(good, { runId: RUN_ID, attempt: ATTEMPT, context: ctx, manifestCommitSha: sha("p") })).toBe(true);
    expect(() => assertManifestBinding({ ...good, workflow_sha: "f".repeat(40) }, { runId: RUN_ID, attempt: ATTEMPT, context: ctx, manifestCommitSha: sha("p") })).toThrow(/immutable workflow SHA/);
    expect(() => assertManifestBinding({ ...good, run_id: "9002" }, { runId: RUN_ID, attempt: ATTEMPT, context: ctx, manifestCommitSha: sha("p") })).toThrow(/run ID/);
    expect(() => assertManifestBinding({ ...good, graph: { A: { sha: sha("p") } } }, { runId: RUN_ID, attempt: ATTEMPT, context: ctx, manifestCommitSha: sha("p") })).toThrow(/its own commit/);
  });

  it("builds a synthetic graph of inert marker commits with the declared parents and no workflow file", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const setup = readEvidenceFile(evidenceDir, `${RUN_ID}-${ATTEMPT}-setup`);
    for (const node of buildGraphPlan(RUN_ID, ATTEMPT)) {
      const commit = github.commits.get(setup.synthetic_graph[node.key]);
      expect(commit!.parents.map((parent) => parent.sha)).toEqual(node.parents.map((key: string) => setup.synthetic_graph[key]));
      expect(commit.message).toMatch(/^AIO-1124 synthetic commissioning/);
    }
    // The graph's whole purpose is that some of these relationships hold and others do not, so both
    // directions are asserted: a helper that answered `false` to everything would satisfy the
    // divergence check alone, and every force case downstream would then be measuring nothing.
    expect(github.isFastForward(setup.synthetic_graph.A, setup.synthetic_graph.C)).toBe(true);
    expect(github.isFastForward(setup.synthetic_graph.A, setup.synthetic_graph.N4)).toBe(true);
    // D is genuinely unrelated: no shared ancestor with the human ref's head. B is a strict
    // ANCESTOR of C, so a human rewind to it is a real rewind rather than a no-op.
    expect(github.isFastForward(setup.synthetic_graph.C, setup.synthetic_graph.D)).toBe(false);
    expect(github.isFastForward(setup.synthetic_graph.C, setup.synthetic_graph.B)).toBe(false);
  });
});

// ── PC-04 ─────────────────────────────────────────────────────────────────────

describe("PC-04 the disposable transformation is closed and invertible, and applicability is MEASURED", () => {
  const production = () => buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS });
  const ctx = { runId: RUN_ID, attempt: ATTEMPT, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS };
  const expected = { normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS };

  it("round-trips byte-for-byte through the transformation and its inverse, for every actor", () => {
    for (const actor of ["normal", "emergency", "human"]) {
      const disposable = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor, normalAppId: NORMAL_APP });
      const back = disposable.map((ruleset) => invertDisposable(ruleset, { runId: RUN_ID, attempt: ATTEMPT, actor, producerIds: PRODUCER_IDS, normalAppId: NORMAL_APP }));
      // Byte-for-byte, not "semantically equal": a transformation that changed field ORDER would
      // make every later canonical hash comparison a comparison of the transformation's artefacts.
      expect(JSON.stringify(back)).toBe(JSON.stringify(production()));
    }
  });

  it("changes ONLY the four declared things — not enforcement, strictness, bypass actors or the rule set", () => {
    const disposable = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP });
    for (const [index, ruleset] of disposable.entries()) {
      const source = production()[index];
      expect(ruleset.name).not.toBe(source.name);
      expect(ruleset.conditions.ref_name.include).toEqual([derivedRef(RUN_ID, ATTEMPT, "normal")]);
      // Everything the policy MEANS travels unchanged. A semantic difference introduced here would
      // make the whole live measurement a statement about a policy nobody runs.
      expect(ruleset.target).toBe(source.target);
      expect(ruleset.enforcement).toBe("active");
      expect(ruleset.bypass_actors).toEqual(source.bypass_actors);
      expect(ruleset.rules.map((rule: Rule) => rule.type)).toEqual(source.rules.map((rule: Rule) => rule.type));
      const strict = (list: Rule[]) => list.find((rule) => rule.type === "required_status_checks")?.parameters?.strict_required_status_checks_policy;
      expect(strict(ruleset.rules)).toBe(strict(source.rules));
      for (const rule of ruleset.rules) {
        for (const check of rule.parameters?.required_status_checks ?? []) {
          // TEST-ONLY, carrying run/attempt and the ORIGINAL ordinal. A real context name published
          // on a synthetic commit would be indistinguishable downstream from the real lane's verdict.
          expect(check.context).toMatch(/^TEST-ONLY commissioning 9001-2 context \d+$/);
          expect(REQUIRED_MAIN_CONTEXTS).not.toContain(check.context);
          expect(check.integration_id).toBe(NORMAL_APP);
        }
      }
    }
  });

  it("refuses to invert a ruleset whose contexts or producer were not the ones it transformed to", () => {
    const [first] = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP })
      .filter((ruleset: Ruleset) => (ruleset.rules ?? []).some((rule) => rule.type === "required_status_checks"));
    const tampered = structuredClone(first);
    const rule = (tampered.rules ?? []).find((entry: Rule) => entry.type === "required_status_checks")!;
    rule.parameters.required_status_checks[0].integration_id = ACTIONS_APP;
    expect(() => invertDisposable(tampered, { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", producerIds: PRODUCER_IDS, normalAppId: NORMAL_APP }))
      .toThrow(/unexpected producer/);
  });

  it("reports measurement-incomplete — never a mismatch — when applicability was not measured", () => {
    const verdict = evaluateDisposableCompatibility({
      measuredRulesets: transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP }),
      applicabilityMeasured: false, actor: "normal", ctx, classicProtection: null, expected,
    });
    // "We could not look" is not a statement about the policy, and must not be reported as one.
    expect(verdict.verdict).toBe("measurement-incomplete");
    expect(verdict.differences).toEqual([]);
  });

  it("evaluates an INHERITED organisation ruleset rather than dropping it as harmless", () => {
    const inherited = {
      id: 900, name: "org-wide-pr-requirement", target: "branch", enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      bypass_actors: [], rules: [{ type: "pull_request", parameters: {} }],
    };
    const verdict = evaluateDisposableCompatibility({
      measuredRulesets: [...transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP }), inherited],
      applicabilityMeasured: true, actor: "normal", ctx, classicProtection: null, expected,
    });
    expect(verdict.verdict).toBe("mismatch");
    expect(verdict.foreign).toEqual(["org-wide-pr-requirement"]);
    expect(verdict.verifierErrors.join(" ")).toMatch(/unsupported restrictions/);
  });

  it("names a provider-NORMALIZATION gap inside a governed rule, without loosening the verifier to swallow it", () => {
    // The real case, not a synthetic one: `buildMainRulesets` sends `{ type: "non_fast_forward" }`
    // with no `parameters`, and GitHub echoes rules back with defaults EXPANDED. That difference is
    // inside a governed key, so the production verifier's raw-JSON comparison rejects it.
    //
    // The honest report is therefore `mismatch` + gap `provider-normalization`, which tells root
    // which of the two corrections applies. Reporting `compatible` would be this harness deciding
    // on its own that a difference it does not understand is cosmetic — and it would be doing so
    // inside the very comparison that is supposed to gate a production policy change.
    const normalized = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP })
      .map((ruleset: Ruleset) => ({
        ...structuredClone(ruleset),
        rules: (ruleset.rules ?? []).map((rule) => ({ ...structuredClone(rule), parameters: rule.parameters ?? {} })),
      }));
    const verdict = evaluateDisposableCompatibility({
      measuredRulesets: normalized, applicabilityMeasured: true, actor: "normal", ctx, classicProtection: null, expected,
    });
    expect(verdict.verdict).toBe("mismatch");
    expect(verdict.gap).toBe("provider-normalization");
    expect((verdict.differences as Difference[]).some((entry) => entry.kind === "added" && entry.path.startsWith("rules"))).toBe(true);
    // A SEMANTIC difference must NOT be labelled the same way, or the label carries no information
    // and root cannot tell a verifier-normalisation fix from a real policy divergence.
    const weakened = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP })
      .map((ruleset: Ruleset) => ({ ...structuredClone(ruleset), bypass_actors: [] }));
    expect(evaluateDisposableCompatibility({ measuredRulesets: weakened, applicabilityMeasured: true, actor: "normal", ctx, classicProtection: null, expected }).gap).toBe("semantic");
  });

  it("does not call a faithful echo a mismatch merely because the provider added its own metadata", () => {
    // The mirror image of the test above, and the reason it has to be a separate case: `id`,
    // `created_at` and `source` are provider bookkeeping OUTSIDE the five governed keys. Treating
    // them as differences would make every real run report a mismatch, and the verdict would stop
    // meaning anything long before anyone read it.
    const echoed = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP })
      .map((ruleset: Ruleset, index: number) => ({ ...structuredClone(ruleset), id: 7000 + index, created_at: "2026-09-10T00:00:00Z", source_type: "Repository", source: COMMISSIONING_REPOSITORY }));
    expect(evaluateDisposableCompatibility({ measuredRulesets: echoed, applicabilityMeasured: true, actor: "normal", ctx, classicProtection: null, expected }).verdict).toBe("compatible");
  });

  it("evaluates the tested scope's REAL classic protection rather than assuming there is none", () => {
    const faithful = transformToDisposable(production(), { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP });
    const base = { measuredRulesets: faithful, applicabilityMeasured: true, actor: "normal", ctx, expected };
    expect(evaluateDisposableCompatibility({ ...base, classicProtection: null }).verdict).toBe("compatible");
    // A classic protection on the same scope conflicts with the App bypasses the rulesets rely on.
    // Passing `null` unconditionally would have hidden exactly this.
    const conflicted = evaluateDisposableCompatibility({ ...base, classicProtection: { allow_force_pushes: { enabled: true } } });
    expect(conflicted.verdict).toBe("mismatch");
    expect(conflicted.verifierErrors.join(" ")).toMatch(/force pushes/);
  });

  it("reports the disposable policy as compatible when the provider echoes it faithfully", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    for (const actor of ["normal", "emergency", "human"]) {
      expect(setup.compatibility[actor].verdict, `${actor} compatibility`).toBe("compatible");
      expect(setup.compatibility[actor].applicable_rule_count).toBeGreaterThan(0);
    }
  });

  it("refuses a setup whose applicability read is unreadable, an unsupported source, or an unidentifiable rule", async () => {
    for (const [label, options] of [
      ["unreadable", { rulesStatus: 403 }],
      ["an organisation-sourced rule this build cannot resolve", { extraApplicable: [{ type: "deletion", ruleset_id: 91, ruleset_source_type: "Enterprise", ruleset_source: "acme" }] }],
      ["a rule with no ruleset identity", { extraApplicable: [{ type: "deletion", ruleset_source_type: "Repository" }] }],
    ] as [string, FakeOptions][]) {
      const dir = mkdtempSync(path.join(tmpdir(), "aio1124-"));
      created.push(dir);
      const github = createFakeGitHub(options);
      await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: INTENT_ENV() });
      await expect(
        runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: LOCAL_ENV, deps: localDeps(github) }),
        `applicability ${label}`,
      ).rejects.toThrow(/could not be measured|cannot be measured/);
    }
  });

  it("stops at MAX_PAGES rather than reporting a partial applicability read as complete", async () => {
    let page = 0;
    const request = Object.assign(async () => {
      page += 1;
      // 100 rows every time: a provider that never signals the last page must exhaust the bound and
      // refuse, not silently return the first 2000 rules as though they were all of them.
      return { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ type: "deletion", ruleset_id: page * 1000 + index, ruleset_source_type: "Repository" })) };
    }, { issued: [] as string[] });
    // THE CANONICAL CEILING IS 10 PAGES OF 100 (F15). This build permitted 20 and this test
    // blessed 20 — a limit that differs from the accepted contract is a second contract, not a
    // safety bound. The value is imported rather than retyped so the two cannot drift again.
    await expect(readApplicableBranchRulesets({ request, branch: "aios-policy-commissioning/run-9001-2-normal" }))
      .rejects.toThrow(new RegExp(`exceeded ${WITNESS_MAX_PAGES} pages`));
    expect(page).toBe(WITNESS_MAX_PAGES);
  });

  it("measures the App's ACTUAL grants with the App JWT and refuses an unexpected set BEFORE any write", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    // The normal role's FIRST credentialed step, which is also its installation-level positive
    // control: the grant reads happen inside it, before the check publication it performs.
    const liveness = await runNormalCheckPublication({
      env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }),
      deps: cloudDeps(github),
    });
    expect(liveness.status).toBe("published");
    const grants = liveness.grants;
    // MEASURED, from the endpoints that document each field — not a placeholder string, and not
    // `repository_selection` scraped off an endpoint that never returns it.
    expect(grants).toMatchObject({
      measured: true, app_id: NORMAL_APP, installation_app_id: NORMAL_APP, installation_id: "5001",
      repository_selection: "selected", suspended: false,
      installation_permissions: { checks: "write", contents: "write", metadata: "read" },
    });
    // And it happened BEFORE the first write: the grant reads precede the check publication.
    const order = github.calls.filter((call) => call.actor === "normal").map((call) => `${call.method} ${call.path}`);
    const firstWrite = order.findIndex((entry) => entry.startsWith("POST") || entry.startsWith("PATCH") || entry.startsWith("PUT") || entry.startsWith("DELETE"));
    expect(order.indexOf("GET /app")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("GET /app")).toBeLessThan(firstWrite);
    expect(order.indexOf("GET /app/installations/5001")).toBeLessThan(firstWrite);
  });

  it("refuses each way an App's installation can be wrong, and refuses it before exercising the credential", async () => {
    const cases: [string, FakeOptions, RegExp][] = [
      // An extra grant is the dangerous one: an over-granted release identity turns an acceptance in
      // the matrix into a statement about the grant rather than about the policy.
      ["an extra grant", { appPermissions: { normal: { checks: "write", contents: "write", metadata: "read", administration: "write" } } }, /unexpected: administration/],
      ["a missing grant", { appPermissions: { normal: { contents: "write", metadata: "read" } } }, /missing: checks/],
      ["a grant at the wrong level", { appPermissions: { normal: { checks: "read", contents: "write", metadata: "read" } } }, /wrong level: checks=read/],
      ["an org-wide installation", { installationOverrides: { normal: { repository_selection: "all" } } }, /not limited to selected repositories/],
      ["a suspended installation", { installationOverrides: { normal: { suspended_at: "2026-09-01T00:00:00Z" } } }, /suspended/],
      ["an installation belonging to another App", { installationOverrides: { normal: { app_id: 999 } } }, /belongs to App 999/],
    ];
    for (const [label, options, expected] of cases) {
      const dir = mkdtempSync(path.join(tmpdir(), "aio1124-"));
      created.push(dir);
      const github = createFakeGitHub(options);
      await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: INTENT_ENV() });
      await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: LOCAL_ENV, deps: localDeps(github) });
      await expect(
        runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: dir }), deps: cloudDeps(github) }),
        label,
      ).rejects.toThrow(expected);
      // NOTHING was written with the App credential: no check minted, no ref moved.
      expect(github.calls.filter((call) => call.actor === "normal" && call.method !== "GET"), label).toEqual([]);
    }
  });

  it("binds the installation TOKEN to its one repository, using only what that endpoint documents", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    for (const [label, body] of [
      ["reaching a second repository", { total_count: 2, repositories: [{ id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY }, { id: 999, full_name: "aiosbrain/other" }] }],
      ["reaching a different repository", { total_count: 1, repositories: [{ id: 999, full_name: "aiosbrain/other" }] }],
      ["reporting a mismatched full name", { total_count: 1, repositories: [{ id: REPOSITORY_ID, full_name: "aiosbrain/other" }] }],
      ["returning an undocumented shape", { total_count: 1 }],
    ] as [string, unknown][]) {
      const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/installation/repositories") return new Response(JSON.stringify(body), { status: 200 });
        return github.fetchImpl(input as string, init);
      }) as unknown as typeof fetch;
      await expect(
        runNormalCheckPublication({
          env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }),
          deps: { fetchImpl, createInstallationToken: mintToken, mintAppJwt: mintAppJwtStub },
        }),
        label,
      ).rejects.toThrow(/installation token|documented shape/);
    }
  });

  it("compares a permission set closed in BOTH directions", () => {
    const expected = ROLE_APP_PERMISSIONS.normal;
    expect(comparePermissions({ checks: "write", contents: "write", metadata: "read" }, expected)).toMatchObject({ ok: true });
    // The three ways a grant set can be wrong, each reported separately — an "unexpected" grant is a
    // different provisioning error from a "missing" one, and the operator fixes them differently.
    expect(comparePermissions({ checks: "write", contents: "write", metadata: "read", administration: "write" }, expected))
      .toMatchObject({ ok: false, unexpected: ["administration"], missing: [], wrongLevel: [] });
    expect(comparePermissions({ contents: "write", metadata: "read" }, expected))
      .toMatchObject({ ok: false, unexpected: [], missing: ["checks"], wrongLevel: [] });
    expect(comparePermissions({ checks: "read", contents: "write", metadata: "read" }, expected))
      .toMatchObject({ ok: false, unexpected: [], missing: [], wrongLevel: ["checks=read (expected write)"] });
    // Absent, or not an object at all, is not an empty grant set.
    expect(comparePermissions(undefined, expected)).toMatchObject({ ok: false, missing: ["checks", "contents", "metadata"] });
    expect(comparePermissions([], expected).ok).toBe(false);
    // The emergency App must NOT hold `checks: write`: the identity that can mint a required check
    // must not also be the one whose bypass makes that check irrelevant.
    expect(ROLE_APP_PERMISSIONS.emergency).not.toHaveProperty("checks");
    expect(comparePermissions({ checks: "write", contents: "write", metadata: "read" }, ROLE_APP_PERMISSIONS.emergency))
      .toMatchObject({ ok: false, unexpected: ["checks"] });
  });

  it("refuses to read an installation other than the one the job holds credentials for", () => {
    const ctx = { role: "normal", runId: RUN_ID, attempt: ATTEMPT, installationId: "5001", graphShas: new Set<string>(), contextNames: new Set<string>(), rulesetIds: new Set<number>(), rulesetNames: new Set<string>() };
    expect(assertAllowedRequest({ method: "GET", path: "/app/installations/5001", body: undefined }, ctx)).toBe("read-app-installation");
    // Any other installation of the same App would be on a repository outside this run's scope.
    expect(() => assertAllowedRequest({ method: "GET", path: "/app/installations/5002", body: undefined }, ctx)).toThrow(/only the installation this job holds/);
    expect(() => assertAllowedRequest({ method: "GET", path: "/app/installations/5001", body: undefined }, { ...ctx, installationId: undefined })).toThrow(/own measured installation ID/);
    // The local operator has no App identity at all.
    expect(() => assertAllowedRequest({ method: "GET", path: "/app", body: undefined }, { ...ctx, role: "local" })).toThrow(/may not issue read-app/);
  });

  it("signs a real App JWT bound to the App as issuer, and never lets it or the token reach an artifact", async () => {
    const { generateKeyPair, exportPKCS8, jwtVerify } = await import("jose");
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwt = await mintAppJwt({ appId: String(NORMAL_APP), privateKey: await exportPKCS8(privateKey) });
    const { payload } = await jwtVerify(jwt, publicKey);
    // The issuer IS the identity claim: a token only verifies against the App's public key if the
    // private key in this job belongs to that App.
    expect(payload.iss).toBe(String(NORMAL_APP));
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(120);
    expect(() => mintAppJwt({ appId: "0", privateKey: "x" })).rejects.toThrow(/positive decimal App ID/);
    // A learned secret: the redactor is told the JWT and the token the moment each is minted.
    const redact = createRedactor([]);
    redact.add(jwt);
    expect(redact(`Authorization: Bearer ${jwt}`)).not.toContain(jwt.slice(0, 24));
  });
});

// ── PC-05 ─────────────────────────────────────────────────────────────────────

describe("PC-05 the actor matrix: every required case, and no outcome that flatters the result", () => {
  const readback = (beforeSha: string, afterSha: string) => ({ beforeSha, afterSha });

  it("records the EXPECTED provider outcome for every required case, across all three actors", async () => {
    const github = createFakeGitHub();
    const { normal, human, emergency } = await commissionEverything(github);
    expect([normal.status, human.status, emergency.status]).toEqual(["passed", "passed", "passed"]);
    const records = new Map<string, CaseRecord>();
    for (const key of ["human", "normal", "emergency"]) {
      for (const record of readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, key)).cases as CaseRecord[]) records.set(record.case, record);
    }
    // Every case the spec requires, accounted for — not "the ones the run happened to reach".
    expect([...records.keys()].sort()).toEqual(buildActorMatrix().map((kase) => kase.id).sort());
    for (const kase of buildActorMatrix()) {
      const record = records.get(kase.id);
      expect(record.outcome, `case ${kase.id}`).toBe(kase.expected);
      expect(record.passed, `case ${kase.id} passed`).toBe(true);
      // An ACCEPTANCE is only ever the independent readback showing the exact requested descendant.
      if (kase.expected === "accepted") expect(record.after_sha).toBe(record.requested_sha);
      // A DENIAL is only ever a policy refusal AND an unchanged ref.
      if (kase.expected === "denied") {
        expect(record.after_sha).toBe(record.before_sha);
        expect(record.diagnostic.policyDenial).toBe(true);
      }
    }
    // The two acceptances are the liveness proof: without them every denial could be a token that
    // never worked, and the whole matrix would be unfalsifiable.
    expect([...records.values()].filter((record) => record.outcome === "accepted").map((record) => record.case).sort())
      .toEqual(["emergency-update-no-checks", "normal-update-all-green"]);
  });

  it("isolates missing, red and wrong-producer check states per commit, so no case can be masked", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    const normal = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    const byCase = new Map((normal.cases as CaseRecord[]).map((record) => [record.case, record]));
    // Each of these ran against its OWN commit, with its declared check state MEASURED in place
    // before the mutation. If they shared a commit, the green case's checks would satisfy the
    // missing-check case and every denial after it would prove nothing.
    const targets = ["normal-update-missing-check", "normal-update-failed-check", "normal-update-wrong-producer", "normal-update-all-green"]
      .map((id) => byCase.get(id)!.requested_sha);
    expect(new Set(targets).size).toBe(4);
    expect(byCase.get("normal-update-missing-check")!.check_state!.measured).toBe(true);
    // The wrong-producer case is only a producer test if the EXPECTED producer did not also publish.
    const wrongProducer = byCase.get("normal-update-wrong-producer")!.check_state!;
    expect(wrongProducer.producers).toEqual([ACTIONS_APP]);
    expect(wrongProducer.producers).not.toContain(NORMAL_APP);
  });

  it("refuses to MEASURE a case whose declared check state is not actually in place", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    // The fixture never ran, so the wrong-producer commit carries no checks at all. A denial here
    // would be a denial for the wrong reason, and recording it would be recording a fiction.
    github.createNormalJob();
    github.approve("normal");
    await expect(runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) }))
      .rejects.toThrow(/could not be measured|not yet in place/);
  });

  it("treats a transport failure, a 5xx, a 404 and a bare credential rejection as INCONCLUSIVE, never as enforcement", () => {
    for (const [label, response, ambiguous] of [
      ["a transport timeout", { status: 0, diagnostic: { status: 0, category: "transport-timeout", ruleIds: [], policyDenial: false } }, true],
      ["a transport failure", { status: 0, diagnostic: { status: 0, category: "transport-unavailable", ruleIds: [], policyDenial: false } }, true],
      ...[500, 502, 503, 504, 408].map((status) => [`a ${status}`, { status, diagnostic: { status, category: "unclassified", ruleIds: [], policyDenial: false } }, true]),
      ["a 404", { status: 404, diagnostic: { status: 404, category: "not-found", ruleIds: [], policyDenial: false } }, false],
      ["a 401", { status: 401, diagnostic: { status: 401, category: "unauthorized", ruleIds: [], policyDenial: false } }, false],
      ["a rate limit", { status: 403, diagnostic: { status: 403, category: "rate-limited", ruleIds: [], policyDenial: false } }, false],
    ] as [string, ProviderResponse, boolean][]) {
      const verdict = classifyCaseOutcome({
        expected: "denied", response: { ...response, complete: response.status !== 0 }, ...readback(sha("a"), sha("a")), requestedSha: sha("b"), operation: "update",
      });
      // Each of these is equally consistent with the policy simply not existing.
      expect(verdict.outcome, label).toBe("inconclusive");
      // A MEASURED refusal leaves the ref's state known, so later cases may run. A request with no
      // decisive outcome (no response, a 5xx, a 408) is an AMBIGUOUS mutation, and that stops
      // further actor mutations (R1, limitation 5).
      expect(verdict.halt, label).toBe(ambiguous);
    }
  });

  it("HALTS on an unexpected success or an unexpected mutation, rather than continuing with a proven over-privileged token", () => {
    const success = classifyCaseOutcome({
      expected: "denied", response: { status: 200, complete: true, diagnostic: { policyDenial: false, category: "ok", ruleIds: [] } },
      ...readback(sha("a"), sha("b")), requestedSha: sha("b"), operation: "update",
    });
    expect(success).toMatchObject({ outcome: "unexpected-success", halt: true });
    // The ref moved despite a refusal: worse than either, and it must stop the actor immediately.
    const mutated = classifyCaseOutcome({
      expected: "denied", response: { status: 422, complete: true, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: [] } },
      ...readback(sha("a"), sha("b")), requestedSha: sha("b"), operation: "update",
    });
    expect(mutated).toMatchObject({ outcome: "unexpected-mutation", halt: true });
  });

  it("stops an actor's remaining cases once it has done something the policy must forbid", async () => {
    // A provider that reports `non_fast_forward` as applicable but does not enforce it. The
    // emergency App's force-rewind therefore SUCCEEDS — the one outcome that means the credential in
    // this job is more powerful than the policy says, so no further case may be attempted with it.
    const github = createFakeGitHub({ ignoreRuleTypes: ["non_fast_forward"] });
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    const stopped = await runRoleCasesUntilRefusal(github, "emergency");
    expect(stopped.stoppedAt, String(stopped.error?.message)).toBe("emergency-force-rewind");
    expect(stopped.error!.message).toMatch(/unexpected-success|must refuse/);
    github.finish("emergency");
    await expect(runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) }))
      .rejects.toThrow(/did not record their expected provider outcome/);
    const evidence = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "emergency"));
    expect(evidence.halted_after).toBe("emergency-force-rewind");
    const byCase = new Map((evidence.cases as CaseRecord[]).map((record) => [record.case, record]));
    expect(byCase.get("emergency-force-rewind")!.outcome).toBe("unexpected-success");
    // Every later case is ACCOUNTED FOR as `not-run` rather than dropped — an omitted case would
    // read as a matrix that simply had fewer entries — and none of them was actually attempted.
    for (const id of ["emergency-force-divergent", "emergency-delete"]) {
      expect(byCase.get(id)!.outcome, id).toBe("not-run");
      expect(byCase.get(id)!.passed, id).toBe(false);
    }
    const emergencyBranch = derivedRef(RUN_ID, ATTEMPT, "emergency").slice("refs/heads/".length);
    expect(github.calls.filter((call) => call.method === "DELETE" && call.path.endsWith(emergencyBranch))).toEqual([]);
    // And the ref still exists, because nothing tried to remove it after the halt.
    expect(github.refs.has(derivedRef(RUN_ID, ATTEMPT, "emergency"))).toBe(true);
  });

  it.each([0, 500, 502, 503, 504, 408])("R1 · an AMBIGUOUS mutation (status %i) is inconclusive and HALTS, even when its one readback shows the requested commit", (status) => {
    /**
     * Canonical: "An ambiguous mutation ... stops further actor mutations. Never resume/retry that
     * mutation." This test used to assert the opposite — status 0 plus a matching readback was an
     * `accepted`, non-halting outcome, so the next actor case started. The readback is retained as
     * reconciliation evidence; it cannot prove that THIS request moved the ref.
     */
    const requested = sha("b");
    // A COMPLETE 5xx/408 is still ambiguous by its status; status 0 never completed at all.
    const timeout = { status, complete: status !== 0, diagnostic: { category: status === 0 ? "transport-timeout" : "unclassified", policyDenial: false, ruleIds: [] } };
    // A 5xx body that happens to carry rule wording is still not a measured refusal: the diagnostic
    // cannot turn a request of unknown fate into enforcement evidence.
    const rulish = { status, complete: status !== 0, diagnostic: { category: "protected-ref-update-restricted", policyDenial: true, ruleIds: ["protected-ref-update-restricted"] } };
    for (const [label, response, after, expected, operation] of [
      ["accepted, readback shows the requested commit", timeout, requested, "accepted", "update"],
      ["accepted, readback unchanged", timeout, sha("a"), "accepted", "update"],
      ["denied, readback unchanged", timeout, sha("a"), "denied", "update"],
      ["denied, rule-worded body, readback unchanged", rulish, sha("a"), "denied", "force"],
      ["denied delete, rule-worded body, readback unchanged", rulish, sha("a"), "denied", "delete"],
    ] as const) {
      const verdict = classifyCaseOutcome({ expected, response, ...readback(sha("a"), after), requestedSha: requested, operation, requiresRuleId: "protected-ref-update-restricted" });
      expect(verdict, label).toMatchObject({ outcome: "inconclusive", halt: true, ambiguous: true });
      expect(verdict.reason, label).toMatch(/never retried, and no further actor mutation runs/);
    }
    expect(mutationRequestClass(status, true)).toBe("ambiguous");
    // A MOVED ref on a case that must be denied stays the stronger, already-halting finding.
    expect(classifyCaseOutcome({ expected: "denied", response: timeout, ...readback(sha("a"), requested), requestedSha: requested, operation: "update" }))
      .toMatchObject({ outcome: "unexpected-mutation", halt: true });
    // A response that never arrived at all is the same ambiguous request.
    expect(classifyCaseOutcome({ expected: "accepted", response: undefined, ...readback(sha("a"), requested), requestedSha: requested, operation: "update" }))
      .toMatchObject({ outcome: "inconclusive", halt: true });
    // A MEASURED acceptance and a MEASURED policy refusal are unchanged.
    expect(classifyCaseOutcome({ expected: "accepted", response: { status: 200, complete: true, diagnostic: { category: "ok", policyDenial: false, ruleIds: [] } }, ...readback(sha("a"), requested), requestedSha: requested, operation: "update" }))
      .toMatchObject({ outcome: "accepted", halt: false });
    expect(classifyCaseOutcome({ expected: "denied", response: { ...rulish, status: 422, complete: true }, ...readback(sha("a"), sha("a")), requestedSha: requested, operation: "force", requiresRuleId: "protected-ref-update-restricted" }))
      .toMatchObject({ outcome: "denied", halt: false });
  });

  it.each([0, 502, 503, 408])("R1 · the offline verdict refuses an acceptance or denial recorded at status %i, whatever outcome or class the record asserts", (status) => {
    const graph = Object.fromEntries(buildGraphPlan(RUN_ID, ATTEMPT).map((node, index) => [node.key, sha(`node-${index}`)]));
    for (const caseId of ["emergency-update-no-checks", "normal-update-all-green"]) {
      const kase = buildActorMatrix().find((entry) => entry.id === caseId)!;
      const record = {
        case: kase.id, actor: kase.actor, operation: kase.operation, ref: derivedRef(RUN_ID, ATTEMPT, kase.ref), force: kase.force,
        expected: kase.expected, before_sha: graph[kase.from], requested_sha: graph[kase.to!], after_sha: graph[kase.to!],
        http_status: status, diagnostic: { status, category: status === 0 ? "transport-timeout" : "unclassified", ruleIds: [], policyDenial: false },
        outcome: "accepted", passed: true, check_state: { expectation: kase.checks, measured: false },
      };
      const problems = deriveCaseVerdict(record, kase, { runId: RUN_ID, attempt: ATTEMPT, graph, normalAppId: NORMAL_APP });
      expect(problems.some((why: string) => new RegExp(`acceptance at HTTP ${status}, which is not a measured provider acceptance`).test(why)), caseId).toBe(true);
      // An asserted `accepted` class beside the status is refused as well.
      const asserted = deriveCaseVerdict({ ...record, request_class: "accepted" }, kase, { runId: RUN_ID, attempt: ATTEMPT, graph, normalAppId: NORMAL_APP });
      expect(asserted.some((why: string) => /labels its request "accepted", but HTTP .* is ambiguous/.test(why)), caseId).toBe(true);
    }
    // A DENIAL at the same status with a rule-worded diagnostic and an unchanged ref.
    const kase = buildActorMatrix().find((entry) => entry.id === "emergency-force-rewind")!;
    const denial = {
      case: kase.id, actor: kase.actor, operation: kase.operation, ref: derivedRef(RUN_ID, ATTEMPT, kase.ref), force: kase.force,
      expected: kase.expected, before_sha: graph[kase.from], requested_sha: graph[kase.to!], after_sha: graph[kase.from],
      http_status: status, diagnostic: { status, category: "non-fast-forward-rejected", ruleIds: ["non-fast-forward-rejected"], policyDenial: true },
      outcome: "denied", passed: true, check_state: { expectation: kase.checks, measured: false },
    };
    expect(deriveCaseVerdict(denial, kase, { runId: RUN_ID, attempt: ATTEMPT, graph, normalAppId: NORMAL_APP }).join("\n"))
      .toMatch(new RegExp(`denial at HTTP ${status}, which is not a measured provider refusal`));
  });

  it("the offline assessor refuses a cloud case issued after an ambiguous or halting one, whatever that later case records", () => {
    const record = (caseId: string, outcome: string, httpStatus?: number) => ({ case: caseId, outcome, ...(httpStatus === undefined ? {} : { http_status: httpStatus, response_complete: httpStatus !== 0 }) });
    const [first, second, third] = CLOUD_CASE_SEQUENCE.emergency;
    for (const [label, halting] of [
      ["a 503", record(first, "inconclusive", 503)],
      ["a lost response", record(first, "inconclusive", 0)],
      ["a used marker that never finalized", record(first, "inconclusive")],
      ["an unexpected mutation", record(first, "unexpected-mutation", 422)],
    ] as const) {
      const problems = cloudCasesIssuedAfterHalt({ emergency: { cases: [halting, record(second, "denied", 422), record(third, "not-run")] } });
      expect(problems, label).toHaveLength(1);
      expect(problems[0], label).toMatch(new RegExp(`case ${second} records denied after ${first} had stopped further emergency mutations`));
    }
    // A measured, non-halting refusal does not stop the later cases, and `not-run` successors are the correct record.
    expect(cloudCasesIssuedAfterHalt({ emergency: { cases: [record(first, "unexpected-denial", 403), record(second, "denied", 422)] } })).toEqual([]);
    expect(cloudCasesIssuedAfterHalt({ emergency: { cases: [record(first, "inconclusive", 503), record(second, "not-run"), record(third, "not-run")] } })).toEqual([]);
  });

  /**
   * Both expected-accepted cases, each with a response that decides nothing — LOST (status 0) or a
   * 503 — once with the mutation having actually landed (readback = requested) and once without
   * (readback unchanged); plus an expected-denied force case answered by a 5xx over an unchanged ref.
   * In every variant the case finalizes as a halt and the next case in the closed sequence refuses at
   * `prepare` — before a witness, a credential or a request.
   */
  const stagedAmbiguous = [
    ...(["emergency", "normal"] as const).flatMap((role) => [0, 503].flatMap((status) => [true, false].map((landed) =>
      [role, role === "normal" ? "normal-update-all-green" : "emergency-update-no-checks", status, landed] as const))),
    ["emergency", "emergency-force-rewind", 502, false] as const,
    ["emergency", "emergency-force-rewind", 503, false] as const,
  ];
  it.each(stagedAmbiguous)("R1 · a staged ambiguous mutation halts its actor: %s %s at status %i (landed: %s), the next case cannot even prepare", async (role, caseId, status, landed) => {
    const label = `${role} / ${caseId} / ${status} / ${landed ? "landed" : "not landed"}`;
    rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    const env = cloudEnv(role, { ...(role === "normal" ? NORMAL_JOB_ENV : EMERGENCY_JOB_ENV), COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    if (role === "normal") {
      github.createNormalJob();
      github.approve("normal");
      await runNormalCheckPublication({ env, deps: cloudDeps(github) });
    } else {
      github.approve("emergency");
    }
    const ordinal = CLOUD_CASE_SEQUENCE[role].indexOf(caseId) + 1;
    for (const earlier of CLOUD_CASE_SEQUENCE[role].slice(0, ordinal - 1)) await runCase(github, role, earlier);
    const branch = derivedRef(RUN_ID, ATTEMPT, role).replace("refs/heads/", "");
    let mutations = 0;
    const lossy = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "PATCH" && requestPath.endsWith(branch)) {
        mutations += 1;
        if (landed) github.handle(role, method, requestPath, body as never);
        return status === 0 ? lostResponse() : wire({ status, body: { message: "Service Unavailable" } });
      }
      return wire(github.handle(role, method, requestPath, body as never));
    };
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1, appTransport: lossy };
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, role, ordinal, "pre");
    await serveOne(github, { role, caseId, ordinal, direction: "pre" });
    await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
    publishChallenge(github, role, ordinal, "post");
    await serveOne(github, { role, caseId, ordinal, direction: "post" });
    await expect(runCaseStage({ stage: "await-and-finalize", caseId, env, deps }), label)
      .rejects.toThrow(/recorded inconclusive: .*no further actor mutation runs/);
    expect(mutations, label).toBe(1);
    const state = JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-${role}-${String(ordinal).padStart(2, "0")}.json`), "utf8"));
    expect(state, label).toMatchObject({ status: "finalized", halt: true });
    expect(state.record, label).toMatchObject({ outcome: "inconclusive", passed: false, request_class: "ambiguous" });
    expect(state.record.after_sha === state.record.requested_sha, label).toBe(landed);
    // The post challenge carries the DERIVED class, and the witness refuses one relabelled beside its status.
    const postChallenge = JSON.parse(readFileSync(path.join(cloudDir("challenges"), `${challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role, ordinal, direction: "post" })}.json`), "utf8"));
    expect(postChallenge, label).toMatchObject({ request_class: "ambiguous", request_status: status });
    for (const laundered of ["accepted", "refused"]) {
      expect(() => assertChallengeShape({ ...postChallenge, request_class: laundered }), `${label} / ${laundered}`).toThrow(/labels request status .* but that status is ambiguous/);
    }
    // The NEXT case refuses before anything else happens.
    const next = CLOUD_CASE_SEQUENCE[role][ordinal];
    const before = github.calls.length;
    await expect(runCaseStage({ stage: "prepare", caseId: next, env, deps }), label).rejects.toThrow(/halted this actor/);
    expect(github.calls.slice(before).filter((call) => ["PATCH", "DELETE", "PUT", "POST"].includes(call.method)), label).toEqual([]);
    expect(existsSync(path.join(cloudDir("challenges"), `${challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role, ordinal: ordinal + 1, direction: "pre" })}.json`)), label).toBe(false);
  });

  it("refuses a reported success whose independent readback disagrees", () => {
    expect(classifyCaseOutcome({
      expected: "accepted", response: { status: 200, complete: true, diagnostic: { category: "ok", policyDenial: false, ruleIds: [] } },
      ...readback(sha("a"), sha("z")), requestedSha: sha("b"), operation: "update",
    })).toMatchObject({ outcome: "unexpected-mutation", halt: true });
  });

  it("requires the PR merge denial to be the WRITER rule, not an incidental red check", () => {
    const base = { expected: "denied" as const, ...readback(sha("a"), sha("a")), requestedSha: sha("b"), operation: "merge" as const, requiresRuleId: "protected-ref-update-restricted" };
    // A merge refused because unrelated CI is red says nothing about who may write to the ref.
    expect(classifyCaseOutcome({ ...base, response: { status: 405, complete: true, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: ["required-status-checks"] } } }))
      .toMatchObject({ outcome: "inconclusive" });
    expect(classifyCaseOutcome({ ...base, response: { status: 405, complete: true, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: ["protected-ref-update-restricted"] } } }))
      .toMatchObject({ outcome: "denied" });
  });

  it("refuses to measure a force case that is really a fast-forward wearing a force flag", () => {
    const graphShas = Object.fromEntries(buildGraphPlan(RUN_ID, ATTEMPT).map((node) => [node.key, sha(node.key)]));
    // A → C is a descendant relationship, so `non_fast_forward` would not refuse it: a case built
    // this way records an ACCEPTANCE and proves nothing whatever about force.
    expect(() => assertCasePrecondition(
      { id: "trap", actor: "normal", ref: "normal", operation: "force", force: true, from: "A", to: "C", expected: "denied", checks: "irrelevant" },
      { beforeSha: graphShas.A, graphShas },
    )).toThrow(/ordinary fast-forward wearing a force flag/);
    // Forcing a ref to where it already is is the same trap in its purest form.
    expect(() => assertCasePrecondition(
      { id: "trap", actor: "normal", ref: "normal", operation: "force", force: true, from: "A", to: "A", expected: "denied", checks: "irrelevant" },
      { beforeSha: graphShas.A, graphShas },
    )).toThrow(/where it already is/);
    // Every force case in the real matrix must survive its own precondition.
    for (const kase of buildActorMatrix().filter((entry) => entry.operation === "force")) {
      expect(() => assertCasePrecondition(kase, { beforeSha: graphShas[kase.from], graphShas }), kase.id).not.toThrow();
    }
  });

  it("reports a ref that is not where the plan says as INTERRUPTED, not as a failure of the policy", () => {
    const graphShas = Object.fromEntries(buildGraphPlan(RUN_ID, ATTEMPT).map((node) => [node.key, sha(node.key)]));
    const kase = buildActorMatrix().find((entry) => entry.id === "normal-update-missing-check")!;
    // Somebody else moved it. That is a statement about the run, not about the subject.
    expect(() => assertCasePrecondition(kase, { beforeSha: sha("elsewhere"), graphShas })).toThrow(/interrupted rather than failed/);
  });

  it("refuses to merge or close any pull request but this run's own", () => {
    const ctx = { role: "local", runId: RUN_ID, attempt: ATTEMPT, graphShas: new Set<string>(), contextNames: new Set<string>(), rulesetIds: new Set<number>(), rulesetNames: new Set<string>(), pullNumber: 42 };
    expect(() => assertAllowedRequest({ method: "PUT", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/43/merge`, body: {} }, ctx)).toThrow(/own synthetic pull request/);
    expect(() => assertAllowedRequest({ method: "PATCH", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/43`, body: { state: "closed" } }, ctx)).toThrow(/own synthetic pull request/);
    // And the one it does own may only be CLOSED — never reopened, retitled or retargeted.
    expect(() => assertAllowedRequest({ method: "PATCH", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/42`, body: { state: "open" } }, ctx)).toThrow(/may only be closed/);
    expect(() => assertAllowedRequest({ method: "PATCH", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/42`, body: { state: "closed", base: "main" } }, ctx)).toThrow(/may only be closed/);
  });

  it("creates the synthetic pull request between two DERIVED refs, labelled, with no work-sync trailer", () => {
    const ctx = { role: "local", runId: RUN_ID, attempt: ATTEMPT, graphShas: new Set<string>(), contextNames: new Set<string>(), rulesetIds: new Set<number>(), rulesetNames: new Set<string>(), pullNumber: null };
    const derived = (suffix: string) => derivedRef(RUN_ID, ATTEMPT, suffix).slice("refs/heads/".length);
    const good = { base: derived("human"), head: derived("pr-head"), title: "AIO-1124 synthetic commissioning pull request", body: "Disposable." };
    expect(assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls`, body: good }, ctx)).toBe("create-synthetic-pull");
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls`, body: { ...good, base: "main" } }, ctx)).toThrow();
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls`, body: { ...good, title: "chore: tidy up" } }, ctx)).toThrow(/label itself/);
    // A work-sync trailer would file this disposable experiment against a real task, and — worse —
    // could close somebody else's ticket when the PR was closed.
    expect(() => assertAllowedRequest({ method: "POST", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls`, body: { ...good, body: "AIOS-Work: AIO-1124" } }, ctx)).toThrow(/work-sync trailer/);
  });
});

// ── PC-06 ─────────────────────────────────────────────────────────────────────

describe("PC-06 protected-environment controls: the approval is read where it can exist, and never invented", () => {
  it("refuses a setup whose protected environment was ALREADY approved before the plan existed", async () => {
    const github = createFakeGitHub();
    github.approve("emergency");
    // The approval cannot have been given against a test plan that did not exist yet, so the run is
    // not a run whose human gate means anything.
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/already approved before setup published the plan|already left the waiting state/);
  });

  it("refuses at SETUP when the pre-approval snapshot cannot be measured at all", async () => {
    const github = createFakeGitHub({ approvalsStatus: 403 });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    // Without this snapshot there is no way to show the later approval postdated the plan, so the
    // run must not proceed to create anything.
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/pre-approval history could not be measured/);
    expect(github.refs.has(derivedRef(RUN_ID, ATTEMPT, "normal"))).toBe(false);
  });

  it("records the pre-approval snapshot as EMPTY, and the protected jobs as parked or not yet created", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    expect(setup.approval_history_before_approval).toMatchObject({ measured: true, entries: [] });
    // `normal` needs the fixture, which is waiting for this very phase, so GitHub has not created
    // it. `emergency` needs only `intent`, so it exists and is parked. Both are legal; they are
    // different facts and the evidence keeps them apart.
    expect(setup.protected_jobs_at_setup).toEqual({ normal: "uncreated", emergency: "waiting" });
  });

  it("collects the ACTUAL later approval, with its reviewer, and binds it to the completed jobs", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    const approvals = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals"));
    for (const spec of PROTECTED_JOBS as { environment: string }[]) {
      expect(approvals.environments[spec.environment]).toMatchObject({ approved: true, approval_measured: true, job_status: "completed" });
      // `approved_at` is the provider's own approval timestamp, which this summary used to DROP —
      // so an approval could not be placed in time at all and a future one was invisible.
      expect(approvals.environments[spec.environment].reviewers)
        .toEqual([{ login: OWNER_LOGIN, id: OWNER_USER_ID, type: "User", approved_at: expect.any(String), is_dispatcher: false }]);
    }
    // The dispatcher is recorded and is explicitly NOT the approver. GITHUB_ACTOR may be a bot.
    // The dispatcher is MEASURED from the provider's own run metadata (F6), not read out of the
    // intent artifact's `GITHUB_ACTOR` — and the declared value is kept beside it, labelled, so the
    // two can be compared rather than conflated.
    expect(approvals.measured_dispatcher).toEqual(DISPATCHER_IDENTITY);
    expect(approvals.declared_dispatcher).toBe(DISPATCHER_IDENTITY.login);
    expect(approvals.declared_dispatcher_matches_measured).toBe(true);
    expect(approvals.run_measured).toBe(true);
    expect(approvals.dispatcher_is_the_approver).toBe(false);
  });

  it("reports an approval by the DISPATCHER as a self-review failure, not as independent approval", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    // The same identity that dispatched the run approving its own protected job. The run happened;
    // it is simply not the two-identity evidence PC-06 asks for.
    github.approve("normal", DISPATCHER_IDENTITY.login, DISPATCHER_IDENTITY.type, DISPATCHER_IDENTITY.id);
    github.approve("emergency");
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    environmentControls(evidenceDir);
    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const selfReview = (blockers as Blocker[]).filter((entry) => entry.kind === "failed" && /self-review/.test(entry.detail));
    // TWO distinct signals, and both are reported: the identity comparison this gate RE-DERIVES from
    // the measured dispatcher, and the record's own `is_dispatcher` claim. The first is the one that
    // matters — a packet controls the boolean but not the provider's run metadata — and the second
    // is kept because a file that admits a self-review should not be quietly agreed with either.
    expect(selfReview.map((entry) => entry.gate)).toEqual(["PC-06", "PC-06"]);
    expect(selfReview.some((entry) => /measured dispatcher itself/.test(entry.detail))).toBe(true);
    expect(selfReview.some((entry) => /own record marks its approver/.test(entry.detail))).toBe(true);
    // And the bot reviewer is ALSO a failure in its own right (F6): a bot approval is not the human
    // gate PC-06 asks for, and the previous build accepted any plain login including a `[bot]` one.
    const nonHuman = (blockers as Blocker[]).filter((entry) => entry.kind === "failed" && /non-User reviewer|configured human reviewer/.test(entry.detail));
    expect(nonHuman.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps an UNMEASURABLE approval history distinct from a refused one", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    // Break the read only now: setup legitimately REFUSES when it cannot measure the pre-approval
    // snapshot, so seeding this fault from the start would test a different thing entirely.
    github.faults.approvals = 403;
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    const approvals = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals"));
    for (const spec of PROTECTED_JOBS as { environment: string }[]) {
      // NOT `approved: false`. "We could not look" is a different fact and must not be written down
      // as a decision nobody made.
      expect(approvals.environments[spec.environment]).toMatchObject({ approval_measured: false, approved: null });
      expect(approvals.environments[spec.environment].approval_measurement_reason).toMatch(/could not be measured/);
    }
    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect((blockers as Blocker[]).filter((entry) => entry.gate === "PC-06" && entry.kind === "unverified").length).toBeGreaterThan(0);
    expect((blockers as Blocker[]).filter((entry) => entry.gate === "PC-06" && entry.kind === "failed")).toEqual([]);
  });

  it("blocks on EACH control for EACH environment, and refuses a boolean, prose, or an unbound digest", () => {
    // Nothing supplied at all.
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .some((entry: Blocker) => entry.gate === "PC-06" && /environment-controls evidence file is absent/.test(entry.detail))).toBe(true);

    const controlBlockers = () => assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .filter((entry: Blocker) => entry.gate === "PC-06" && /protected-environment control/.test(entry.detail));

    // A single blanket boolean — the shape the previous checker accepted outright.
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
      verified: true, controls: {},
    });
    expect(controlBlockers()).toHaveLength(ENVIRONMENT_CONTROL_KEYS.length);

    // Prose in place of proof: a status word and a sentence, per environment.
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
      controls: Object.fromEntries((ENVIRONMENT_CONTROL_KEYS as string[]).map((key) => [key, Object.fromEntries(
        (PROTECTED_JOBS as { environment: string }[]).map((spec) => [spec.environment, { status: "verified", evidence: "checked it in the UI" }]),
      )])),
    });
    // Every one of the twelve is refused: no source, no timestamp, no artifact, no digest.
    expect(controlBlockers()).toHaveLength(ENVIRONMENT_CONTROL_KEYS.length * PROTECTED_JOBS.length);

    // A complete packet passes — and each proof is a file this checker re-hashed off disk.
    environmentControls(evidenceDir);
    expect(controlBlockers()).toEqual([]);

    // The realistic honest gap: no second reviewer identity exists, so that ONE control stays
    // unverified for both environments and still blocks.
    environmentControls(evidenceDir, (controls) => {
      for (const spec of PROTECTED_JOBS as { environment: string }[]) {
        controls.unauthorized_reviewer_refused[spec.environment] = { status: "unverified", note: "no second reviewer identity is available" };
      }
    });
    expect(controlBlockers().map((entry: Blocker) => entry.detail)).toEqual([
      expect.stringContaining("unauthorized_reviewer_refused for staging-release is unverified"),
      expect.stringContaining("unauthorized_reviewer_refused for staging-emergency is unverified"),
    ]);

    // One environment covered and the other not: they are configured separately, and one being
    // right says nothing about the other.
    environmentControls(evidenceDir, (controls) => { delete controls.prevent_self_review_enabled["staging-emergency"]; });
    expect(controlBlockers().map((entry: Blocker) => entry.detail))
      .toEqual([expect.stringContaining("prevent_self_review_enabled for staging-emergency is absent")]);

    // A digest that does not match the artifact on disk, and an artifact that is not there at all.
    environmentControls(evidenceDir, (controls) => {
      (controls.administrators_cannot_bypass["staging-release"] as Record<string, unknown>).artifact_sha256 = "f".repeat(64);
      (controls.administrators_cannot_bypass["staging-emergency"] as Record<string, unknown>).artifact = "not-retained.json";
    });
    expect(controlBlockers().map((entry: Blocker) => entry.detail)).toEqual([
      expect.stringContaining("digest does not match"),
      expect.stringContaining("not in the evidence directory"),
    ]);

    // A control outside the closed list is INVALID, not extra credit.
    environmentControls(evidenceDir, (controls) => { controls.made_up_control = { "staging-release": { status: "verified" } }; });
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .some((entry: Blocker) => entry.kind === "invalid" && /outside the closed PC-06 list/.test(entry.detail))).toBe(true);
  });

  /**
   * F2 · one control record, against ITS OWN closed schema.
   *
   * The independent review executed the previous validator against a record whose observation was
   * `{"prevent_self_review": false}`, timestamped 2020, with one artifact reused for every control in
   * both environments — and it returned `null` (accepted). Every one of those is a refusal here, and
   * the first case below is that exact packet.
   */
  it("validates one control record against its own closed schema, so a FALSE or reused observation is refused", () => {
    const key = "prevent_self_review_enabled";
    const environment = "staging-release";
    const expected = (ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { expected: unknown }>)[key].expected;
    const artifactFor = (name: string, body: unknown) => {
      const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
      writeFileSync(path.join(evidenceDir, name), bytes);
      return { artifact: name, artifact_sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    // The observation's own provenance (R3): the wrapper below may only repeat it.
    const provenance = { environment_id: 4401, source: "provider-api", measured_at: "2026-09-10T09:00:00.000Z" };
    const proof = artifactFor("proof.json", { control: key, environment, measured: expected, ...provenance });
    const context = { dir: evidenceDir, key, environment, runId: RUN_ID, attempt: ATTEMPT, window: { start: "2026-01-01T00:00:00.000Z" } };
    const good = {
      status: "verified", environment_name: environment, ...provenance,
      expected, measured: expected, ...proof,
    };
    expect(validateEnvironmentControl(good, context)).toBeNull();

    const falseProof = artifactFor("false-proof.json", { control: key, environment, measured: { prevent_self_review: false }, ...provenance });
    const otherControlProof = artifactFor("other-control.json", { control: "administrators_cannot_bypass", environment, measured: expected, ...provenance });
    const otherEnvProof = artifactFor("other-env.json", { control: key, environment: "staging-emergency", measured: expected, ...provenance });
    const staleProof = artifactFor("stale-proof.json", { control: key, environment, measured: expected, ...provenance, measured_at: "2020-01-01T00:00:00.000Z" });
    const cases: [string, Record<string, unknown>, RegExp][] = [
      // THE REVIEWED PACKET: a measurement that says the control is OFF, dated years ago.
      ["the reviewed hostile record: a FALSE measurement", { ...good, measured: { prevent_self_review: false }, ...falseProof }, /not the required outcome/],
      ["a historical capture time", { ...good, measured_at: "2020-01-01T00:00:00.000Z", ...staleProof }, /before this run's window opened/],
      // R3: a fresh outer timestamp around a stale observation is a restamp, not a capture time.
      ["a fresh wrapper time around a stale observation", { ...good, ...staleProof }, /an outer timestamp cannot restamp an observation/],
      ["an artifact recording a DIFFERENT control", { ...good, ...otherControlProof }, /artifact recording the control/],
      ["an artifact recording a DIFFERENT environment", { ...good, ...otherEnvProof }, /artifact recording environment/],
      ["a swapped environment name", { ...good, environment_name: "staging-emergency" }, /measured on environment/],
      ["no numeric environment ID", { ...good, environment_id: undefined }, /no numeric environment ID/],
      ["its own weaker expectation", { ...good, expected: { prevent_self_review: false } }, /expected control outcome that is not the one this build requires/],
      ["no measurement at all", { ...good, measured: undefined }, /no measured control value/],
      ["a boolean instead of a record", { status: true }, /is /],
      ["an unverified status", { ...good, status: "unverified" }, /is unverified/],
      ["an unknown source", { ...good, source: "i-checked" }, /this control does not accept/],
      ["no timestamp", { ...good, measured_at: "whenever" }, /no parseable measured_at/],
      ["a path instead of a basename", { ...good, artifact: "../elsewhere.json" }, /plain retained artifact file/],
      ["a short digest", { ...good, artifact_sha256: "abc" }, /no SHA-256 digest/],
    ];
    for (const [label, record, expectedReason] of cases) {
      expect(validateEnvironmentControl(record, context), label).toMatch(expectedReason);
    }
    // An unknown control key is refused by name rather than validated against nothing.
    expect(validateEnvironmentControl(good, { ...context, key: "make-it-up" })).toMatch(/outside the closed PC-06 list/);
    // `administrators_cannot_bypass` is UI-ONLY: the environments API does not return that field, so
    // an API-sourced claim about it would be a claim about something nobody read.
    const uiOnly = "administrators_cannot_bypass";
    const uiExpected = (ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { expected: unknown }>)[uiOnly].expected;
    const uiProof = artifactFor("ui-proof.json", { control: uiOnly, environment, measured: uiExpected, ...provenance, source: "provider-ui" });
    const uiRecord = { ...good, expected: uiExpected, measured: uiExpected, ...uiProof };
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-api" }, { ...context, key: uiOnly })).toMatch(/does not accept/);
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-ui" }, { ...context, key: uiOnly })).toBeNull();
    // R3 for the UI-only control: its UI source is the OBSERVATION's own fact. An API-sourced artifact
    // cannot be relabelled UI by its wrapper, and a UI capture with no capture time is refused.
    const uiFromApi = artifactFor("ui-from-api.json", { control: uiOnly, environment, measured: uiExpected, ...provenance });
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-ui", ...uiFromApi }, { ...context, key: uiOnly })).toMatch(/source "provider-api", which this control does not accept/);
    const uiUntimed = artifactFor("ui-untimed.json", { control: uiOnly, environment, measured: uiExpected, environment_id: 4401, source: "provider-ui" });
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-ui", ...uiUntimed }, { ...context, key: uiOnly })).toMatch(/does not record its own measured_at/);
    // A run-bound negative case must name the attempt it was produced in.
    const bound = "self_review_refused";
    const boundExpected = (ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { expected: unknown }>)[bound].expected;
    const boundProof = artifactFor("bound-proof.json", { control: bound, environment, measured: boundExpected, ...provenance, run_id: RUN_ID, attempt: ATTEMPT });
    const boundRecord = { ...good, expected: boundExpected, measured: boundExpected, ...boundProof, run_id: RUN_ID, attempt: ATTEMPT };
    expect(validateEnvironmentControl(boundRecord, { ...context, key: bound })).toBeNull();
    expect(validateEnvironmentControl({ ...boundRecord, attempt: "9" }, { ...context, key: bound })).toMatch(/names a different attempt/);
  });

  /**
   * R3 · the retained observation owns its provenance; a wrapper cannot restamp it.
   *
   * The independent review's exact probe: a stale observation from another run, attempt, numeric
   * environment, source and year, inside a wrapper carrying fresh values for every one of them, with
   * the artifact digest honestly matching the stale bytes. It was accepted (`null`). Then the same
   * mismatch one field at a time, and the same observation with each provenance field ABSENT — for
   * every control's own closed schema.
   */
  it("refuses a stale or cross-run PC-06 observation restamped by a fresh wrapper, and one missing its own provenance", () => {
    const retain = (name: string, body: unknown) => {
      const bytes = Buffer.from(JSON.stringify(body), "utf8");
      writeFileSync(path.join(evidenceDir, name), bytes);
      return { artifact: name, artifact_sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const window = { start: "2026-09-21T00:00:00.000Z", end: "2026-09-21T02:00:00.000Z" };
    const environment = "staging-release";

    // THE EXACT REVIEW PROBE.
    const probeKey = "self_review_refused";
    const probeMeasured = (ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { expected: unknown }>)[probeKey].expected;
    const stale = retain("stale.json", {
      control: probeKey, environment, measured: probeMeasured,
      environment_id: "999", run_id: "1", attempt: "1", source: "provider-ui", measured_at: "2020-01-01T00:00:00.000Z",
    });
    expect(validateEnvironmentControl({
      status: "verified", source: "provider-api", environment_name: environment, environment_id: "123",
      expected: probeMeasured, measured: probeMeasured, measured_at: "2026-09-21T01:00:00.000Z",
      run_id: "9001", attempt: "2", ...stale,
    }, { dir: evidenceDir, key: probeKey, environment, runId: "9001", attempt: "2", window })).not.toBeNull();

    const schemas = ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { sources: string[]; expected: unknown; run_bound: boolean }>;
    for (const key of ENVIRONMENT_CONTROL_KEYS as string[]) {
      const schema = schemas[key];
      const own: Record<string, unknown> = {
        environment_id: "4401", source: schema.sources[schema.sources.length - 1], measured_at: "2026-09-21T01:00:00.000Z",
        ...(schema.run_bound ? { run_id: "9001", attempt: "2" } : {}),
      };
      const context = { dir: evidenceDir, key, environment, runId: "9001", attempt: "2", window };
      const wrapper = (body: Record<string, unknown>) => ({
        status: "verified", environment_name: environment, expected: schema.expected, measured: schema.expected, ...own,
        ...retain(`${key}-${Object.keys(body).length}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 8)}.json`, body),
      });
      const valid = { control: key, environment, measured: schema.expected, ...own };
      expect(validateEnvironmentControl(wrapper(valid), context), `${key}: a coherent observation`).toBeNull();

      // Each provenance field CONTRADICTED by the retained bytes.
      const contradictions: [string, unknown][] = [
        ["environment_id", "999"],
        ["measured_at", "2020-01-01T00:00:00.000Z"],
        ["measured_at", "2026-09-21T01:00:00.001Z"],
        ...(schema.sources.length > 1 ? [["source", schema.sources[0]] as [string, unknown]] : []),
        ...(schema.run_bound ? [["run_id", "1"], ["attempt", "1"]] as [string, unknown][] : []),
      ];
      for (const [field, value] of contradictions) {
        expect(validateEnvironmentControl(wrapper({ ...valid, [field]: value }), context), `${key}: contradicted ${field}`).not.toBeNull();
      }
      // Each provenance field ABSENT from the retained bytes: the wrapper cannot supply it.
      for (const field of Object.keys(own)) {
        const { [field]: _dropped, ...without } = valid;
        expect(validateEnvironmentControl(wrapper(without), context), `${key}: absent ${field}`).toMatch(new RegExp(`does not record its own ${field}`));
      }
      // A field outside the control's closed observation schema.
      expect(validateEnvironmentControl(wrapper({ ...valid, note: "trust me" }), context), `${key}: open schema`).toMatch(/outside this control's closed observation schema/);
      if (!schema.run_bound) {
        expect(validateEnvironmentControl(wrapper({ ...valid, run_id: "9001" }), context), `${key}: run field on an unbound control`).toMatch(/closed observation schema/);
      }
    }
  });

  it("cannot reach a full PASS while PC-06 is unverified, even with the whole actor matrix green", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    // Everything this harness can produce is now present and green. The environment negative
    // controls are the one thing it structurally cannot produce, so the verdict must NOT be a pass.
    const before = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect((before.blockers as Blocker[]).every((entry) => entry.gate === "PC-06")).toBe(true);
    expect(before.blockers.length).toBeGreaterThan(0);
    const code = await main(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], LOCAL_ENV, { write: () => {} });
    expect(code).toBe(3);
    // With the accepted, artifact-bound provider evidence for those controls attached — and ONLY
    // then — it passes.
    environmentControls(evidenceDir);
    const after = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect(after.blockers).toEqual([]);
  });
});

// ── PC-07 ─────────────────────────────────────────────────────────────────────

describe("PC-07 journal durability, cleanup ownership and the leakage boundary", () => {
  it("writes an append-only chained journal that refuses to continue once its chain is broken", () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    journal.append("run-opened", { operator_login: "johnellison" });
    journal.append("mutation-intent", { kind: "ref", ref: derivedRef(RUN_ID, ATTEMPT, "normal") });
    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect((records as JournalRecord[]).map((record) => record.seq)).toEqual([1, 2]);
    // Every record commits to the one before it, so a deleted or edited record cannot be hidden.
    expect(records[1].previous).toBe(records[0].digest);
    expect(statSync(journalPath(evidenceDir, RUN_ID, ATTEMPT)).mode & 0o777).toBe(0o600);
    lock.release();

    // Tamper with a historical record, which is exactly what an append-only chain exists to catch.
    const file = journalPath(evidenceDir, RUN_ID, ATTEMPT);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const edited = JSON.parse(lines[0]);
    edited.data.operator_login = "someone-else";
    writeFileSync(file, `${[JSON.stringify(edited), lines[1]].join("\n")}\n`);
    expect(() => readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT })).toThrow();
    // And a broken chain must block every later phase, not just the reader.
    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect((blockers as Blocker[]).some((entry) => entry.gate === "PC-07" && entry.kind === "failed" && /chain does not verify/.test(entry.detail))).toBe(true);
  });

  it("refuses a truncated journal rather than continuing from whatever survived", () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    journal.append("run-opened", { operator_login: "johnellison" });
    journal.append("mutation-intent", { kind: "ref" });
    lock.release();
    const file = journalPath(evidenceDir, RUN_ID, ATTEMPT);
    const complete = readFileSync(file, "utf8");
    // A crash mid-write: the last line is half a record.
    writeFileSync(file, complete.slice(0, complete.length - 12));
    expect(() => readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT })).toThrow();
  });

  it("lets exactly one writer hold the run-scoped lock, and does not free a stale one on elapsed time alone", async () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect(() => acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT })).toThrow();
    // Two concurrent setup or cleanup writers must not both pass.
    const owner = readLockOwner(evidenceDir, RUN_ID, ATTEMPT);
    expect(owner).toMatchObject({ pid: process.pid });
    expect(String(owner!.nonce ?? "").length).toBeGreaterThan(8);
    // The journal needs a first record before recovery can reason about the last mutation.
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    journal.append("mutation-intent", { kind: "ref", ref: derivedRef(RUN_ID, ATTEMPT, "normal") });

    // Recovery requires POSITIVE evidence the original owner is gone AND a reconciled readback of
    // its last mutation. Age is not evidence: a long-running setup is indistinguishable from a dead
    // one by clock alone, and stealing its lock is how two writers end up in the same journal.
    await expect(recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT,
      ownerGone: false, reconcile: async () => ({ reconciled: true }),
    })).rejects.toThrow(/elapsed time is not that verification/);
    // Nor is an owner that is gone enough on its own: an unreconciled last mutation means nobody
    // knows whether it reached the provider, and adopting it would be inventing the answer.
    await expect(recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT,
      ownerGone: true, reconcile: async () => ({ reconciled: false }),
    })).rejects.toThrow(/could not be reconciled by provider readback/);
    // Both proofs present: the recovery is itself journaled, as an event rather than a rewrite.
    const recovered = await recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT,
      ownerGone: true, reconcile: async (intent: { ref?: string } | null) => ({ reconciled: true, readback: { ref: intent?.ref ?? null, present: false } }),
    });
    expect(recovered.unresolvedIntent).toMatchObject({ kind: "ref" });
    const chain = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect(chain.at(-1)).toMatchObject({ type: "recovery" });
    // Appended, never rewritten: the original intent is still record 1.
    expect((chain as JournalRecord[]).map((record) => record.seq)).toEqual([1, 2]);
    expect(chain[0]).toMatchObject({ type: "mutation-intent" });
    recovered.lock.release();
  });

  it("refuses to journal a value that looks like a credential", () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    // The journal is mode 0600 and local-only, but "local-only" has been the last line of defence
    // for a file that later got attached to a ticket. It refuses the shape outright.
    expect(() => journal.append("mutation-intent", { kind: "ref", note: SENTINEL_KEY })).toThrow();
    expect(() => journal.append("mutation-intent", { kind: "ref", note: `ghs_${"a".repeat(36)}` })).toThrow();
    lock.release();
  });

  it("resumes a partial setup from its verified journal instead of recreating anything", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    let failAfter = 6;
    const flaky = ((command: string, args: string[]) => {
      // Kill the operator's transport partway through creating the synthetic graph — as a `gh` that
      // produced no HTTP status line, which is the shape that must NOT be read as a provider 0.
      if (args.includes("--method") && args[args.indexOf("--method") + 1] === "POST" && failAfter-- <= 0) {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = new EventEmitter() as FakeChild;
        child.pid = 4242;
        child.kill = () => {};
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        child.stdin.on("finish", () => {
          stdout.on("end", () => child.emit("close", 1));
          stdout.end("gh: could not reach the API");
        });
        return child;
      }
      return github.spawnImpl(command, args);
    }) as unknown as typeof github.spawnImpl;
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl: flaky } })).rejects.toThrow();
    const partial = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const createdCommits = (partial as JournalRecord[]).filter((record) => record.type === "resource-created" && record.data?.kind === "commit");
    expect(createdCommits.length).toBeGreaterThan(0);
    expect(createdCommits.length).toBeLessThan(buildGraphPlan(RUN_ID, ATTEMPT).length);
    const before = github.commits.size;
    // The resumed run must ADOPT the journaled commits (after reading each one back) rather than
    // create a second copy of the graph — a silent recreate is how two half-runs end up sharing a
    // ref namespace and neither journal describing what is actually there.
    const resumed = await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    expect(resumed.status).toBe("prepared");
    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    for (const record of createdCommits) expect(setup.synthetic_graph[record.data.node]).toBe(record.data.sha);
    expect(github.commits.size).toBe(before + (buildGraphPlan(RUN_ID, ATTEMPT).length - createdCommits.length));
  });

  it("refuses to clean a resource whose fingerprint no longer matches what it journaled", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    // Somebody retargeted one of our rulesets. Deleting it now would be deleting a rule that is no
    // longer the one we created, on a target we never chose.
    const ours = [...github.rulesets.values()].find((ruleset) => ruleset.name.includes("-human-main-integrity"))!;
    ours.conditions.ref_name.include = ["refs/heads/main"];
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/did not match their journaled fingerprint/);
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    expect(cleanup.outcomes).toContainEqual(expect.objectContaining({ kind: "ruleset", name: ours.name, result: "refused-ownership-mismatch" }));
    // Refused, not deleted — and the ruleset is still there for a human to look at.
    expect(github.rulesets.has(ours.id)).toBe(true);
  });

  it("refuses to delete a derived ref that now carries content this run did not create", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const ref = derivedRef(RUN_ID, ATTEMPT, "human");
    github.refs.set(ref, sha("somebody-elses-commit"));
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/could not be removed|did not match/);
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    expect(cleanup.outcomes).toContainEqual(expect.objectContaining({ kind: "ref", ref, result: "refused-unowned-content" }));
    expect(github.refs.get(ref)).toBe(sha("somebody-elses-commit"));
  });

  it("removes every owned resource, closes its own pull request, and proves production unchanged", async () => {
    const github = createFakeGitHub();
    const rulesetsBefore = new Set(github.rulesets.keys());
    await commissionEverything(github);
    const cleaned = await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    expect(cleaned.status).toBe("cleaned");
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    expect(cleanup.production_drift).toEqual([]);
    expect(cleanup.refusals).toBe(0);
    expect(new Set(github.rulesets.keys())).toEqual(rulesetsBefore);
    for (const suffix of ["normal", "emergency", "human", "pr-head"]) {
      expect(github.refs.has(derivedRef(RUN_ID, ATTEMPT, suffix)), suffix).toBe(false);
    }
    expect([...github.pulls.values()].every((pull) => pull.state === "closed")).toBe(true);
    // Production is untouched: the two refs it never wrote to are exactly where it found them.
    expect(github.refs.get("refs/heads/main")).toBe(MAIN_SHA);
    expect(github.refs.get("refs/heads/staging")).toBe(STAGING_SHA);
  });

  it("calls a run INTERRUPTED — not failed, and never rolled back — when production moves underneath it", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const moved = sha("a legitimate merge to staging");
    github.refs.set("refs/heads/staging", moved);
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/interrupted and needs root reconciliation/);
    // Somebody else's change. Reverting it would be this harness overwriting real work to make its
    // own report clean.
    expect(github.refs.get("refs/heads/staging")).toBe(moved);
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    expect(cleanup.production_drift).toContain("staging_sha");
  });

  it("keeps a private key out of every evidence file and every emitted line, even when the provider fails", async () => {
    const github = createFakeGitHub();
    const env = { ...LOCAL_ENV, RELEASE_APP_PRIVATE_KEY: SENTINEL_KEY, GITHUB_TOKEN: `ghs_${"z".repeat(36)}` } as unknown as NodeJS.ProcessEnv;
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    // A subprocess that dies writing the key to stderr, which is the path that actually leaks: the
    // harness never chose to print it, `gh` did.
    const leaky = ((command: string, args: string[]) => {
      const child = github.spawnImpl(command, args) as FakeChild;
      child.stderr.write(`gh: request failed with ${SENTINEL_KEY}\n`);
      return child;
    }) as unknown as typeof github.spawnImpl;
    const lines: string[] = [];
    await main(["setup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], env, {
      spawnImpl: leaky, write: (text: string) => lines.push(text),
    });
    const emitted = lines.join("");
    expect(emitted).not.toContain(SENTINEL_KEY);
    expect(emitted).not.toContain("sentinelKEYMATERIAL");
    expect(emitted).not.toContain("ghs_zzz");
    for (const key of ["intent", "setup"]) {
      const raw = JSON.stringify(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, key)) ?? {});
      expect(raw, key).not.toContain("sentinelKEYMATERIAL");
      expect(raw, key).not.toContain("ghs_zzz");
    }
    // NON-VACUITY: the sentinel really was in scope, and the redactor really is what removed it.
    expect(collectSentinels(env)).toContain(SENTINEL_KEY);
    expect(createRedactor(collectSentinels(env))(SENTINEL_KEY)).not.toContain("sentinelKEYMATERIAL");
  });

  it("writes every evidence file 0600 and refuses to write one through a symlink", () => {
    const target = path.join(evidenceDir, "elsewhere.json");
    symlinkSync(target, path.join(evidenceDir, `commissioning-${RUN_ID}-${ATTEMPT}-collect.json`));
    expect(() => writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "collect"), { schema_version: 1 })).toThrow(/symlink/);
    const written = writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"), { schema_version: 1 });
    expect(statSync(written).mode & 0o777).toBe(0o600);
    // A name is DERIVED, never supplied: a caller-chosen name is a caller-chosen path.
    expect(() => writeEvidenceFile(evidenceDir, "../escape", {})).toThrow(/derived, never supplied/);
  });

  it("discards a mis-bound evidence file rather than letting it contribute a passing gate", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    // Another run's green normal-tests packet, dropped into this run's directory. It is worse than
    // an absent file: absence blocks loudly, whereas this would contribute PASSING PC-05 cases
    // measured against a different subject.
    const genuine = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"), { ...genuine, run_id: "8000" });
    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    expect((blockers as Blocker[]).some((entry) => entry.kind === "invalid" && /normal-tests evidence file belongs to run/.test(entry.detail))).toBe(true);
    // And the coverage it was carrying is reported LOST, rather than the packet quietly assessing
    // fewer cases than the matrix has.
    expect((blockers as Blocker[]).some((entry) => entry.gate === "PC-05" && /normal case\(s\) have no usable recorded outcome/.test(entry.detail))).toBe(true);
    // The same file with a doctored schema version, or the wrong phase, is refused the same way.
    for (const override of [{ schema_version: 2 }, { phase: "emergency-tests" }]) {
      writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"), { ...genuine, ...override });
      expect(validateEvidenceBinding({ ...genuine, ...override }, { runId: RUN_ID, attempt: ATTEMPT, phase: "normal-tests" })).toBeTruthy();
    }
  });
});

// ── PC-08 ─────────────────────────────────────────────────────────────────────

describe("PC-08 the closed CLI contract: one status word and one exit code per outcome", () => {
  it("exposes exactly the eight spec'd phases and exactly three flags", () => {
    for (const phase of ["intent", "setup", "human-tests", "normal-tests", "emergency-tests", "collect", "cleanup", "check-evidence"]) {
      expect(() => parseArgs([phase, "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", "/tmp/x"]), phase).not.toThrow();
    }
    // No ref, repo, URL, endpoint or actor override exists to be typed.
    for (const flag of ["--ref", "--repo", "--repository", "--endpoint", "--actor", "--ruleset", "--url", "--dry-run"]) {
      expect(() => parseArgs(["setup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", "/tmp/x", flag, "x"]), flag).toThrow(/unknown argument/);
    }
    expect(() => parseArgs(["fixture", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", "/tmp/x"])).toThrow(/usage/);
  });

  it("returns 2 for an invalid invocation, 3 for missing evidence, and 0 only for an affirmative success", async () => {
    const github = createFakeGitHub();
    const emitted: string[] = [];
    const write = (text: string) => emitted.push(text);
    const run = (argv: string[], env = LOCAL_ENV, deps: Record<string, unknown> = {}) =>
      main(argv, env, { spawnImpl: github.spawnImpl, write, ...deps });

    // 2 — the invocation is wrong, and nothing was measured.
    expect(await run(["setup", "--run-id", "0", "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(2);
    expect(await run(["setup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", "relative/path"])).toBe(2);
    // 3 — nothing has run yet, so every gate is unverified. NOT 1: there is no measured failure.
    expect(await run(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(3);
    const incomplete = JSON.parse(emitted.at(-1)!);
    expect(incomplete).toMatchObject({ schema_version: 1, run_id: RUN_ID, attempt: ATTEMPT, phase: "check-evidence", status: "incomplete" });
    expect(incomplete.blockers.length).toBeGreaterThan(0);

    // 0 with `prepared` — and `setup` never reports a global pass.
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    expect(await run(["setup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "setup", status: "prepared" });

    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    await runRoleCases(github, "normal");
    github.finish("normal");
    await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) });
    expect(await run(["human-tests", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "human-tests", status: "passed" });
    github.approve("emergency");
    await runRoleCases(github, "emergency");
    github.finish("emergency");
    await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) });
    // The local witness. In a real run it is ONE long-running process started before the first
    // approval, serving all 22 responses and polling for work it has not seen yet; here every
    // response is already published, so the same phase RECONCILES them without dispatching again.
    // Its exit 0 means "all assigned responses published and reconciled" — never a global pass.
    expect(await run(["witness", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir],
      LOCAL_ENV, { archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 })).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "witness", status: "published", publications: REQUIRED_WITNESS_PUBLICATIONS });

    // `collect` BEFORE cleanup gathers what exists and still reports incomplete.
    expect(await run(["collect", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(3);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "collect", status: "incomplete" });
    expect(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals")).environments["staging-release"].approved).toBe(true);

    expect(await run(["cleanup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "cleanup", status: "cleaned" });

    // Still 3: the PC-06 environment controls are the one thing this harness cannot produce.
    expect(await run(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(3);
    environmentControls(evidenceDir);
    expect(await run(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    const final = JSON.parse(emitted.at(-1)!);
    expect(final).toMatchObject({ phase: "check-evidence", status: "passed" });
    // Even a complete packet says out loud that it is not authorization to change main.
    expect(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "check-evidence")).note).toMatch(/not authorization to change main policy/i);
  });

  it("returns 1 — a measured failure — when a case records the wrong provider outcome", async () => {
    const github = createFakeGitHub({ ignoreRuleTypes: ["update", "pull_request", "required_status_checks"] });
    await intentAndSetup(github);
    const code = await main(["human-tests", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], LOCAL_ENV, {
      spawnImpl: github.spawnImpl, write: () => {},
    });
    // The human/admin was ALLOWED to move a protected ref. That is a statement about the subject,
    // so it is exit 1, not exit 3.
    expect(code).toBe(1);
  });

  it("waits a BOUNDED time for local setup, then refuses — and never retries a manifest it has refused", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    let slept = 0;
    // Four sleeps, not five: the wait refuses rather than sleeping PAST its own deadline, so the
    // last interval that would have overshot is never taken.
    const timing = { intervalMs: 15_000, deadlineMs: 60_000, sleep: async () => { slept += 1; }, now: () => slept * 15_000 };
    // Local setup has not published the manifest ref. The fixture must refuse with its evidence
    // intact rather than hang until the job timeout kills the `always()` upload.
    await expect(runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: timing }))
      .rejects.toThrow(/did not publish the commissioning manifest within 60000ms/);
    expect(slept).toBe(4);

    // Once it exists, the same wait returns on its first poll.
    await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    slept = 0;
    const published = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: timing });
    expect(published.status).toBe("published");
    expect(published.manifest_wait).toMatchObject({ polls: 1 });
    expect(slept).toBe(0);
  });

  it("does not poll a manifest it has already refused on its merits", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    let polls = 0;
    const request = Object.assign(async (method: string, requestPath: string, body?: unknown) => {
      polls += 1;
      const url = new URL(`https://api.github.com${requestPath}`);
      const result = github.handle("fixture", method, `${url.pathname}${url.search}`, body);
      return { ...result, diagnostic: { status: result.status, category: "ok", ruleIds: [], policyDenial: false } };
    }, { issued: [] as string[] });
    // A manifest that disagrees with the job's own trusted run metadata is a REFUSAL, not a "not
    // yet": re-reading it would only wait for somebody to fix a ref this job already rejected.
    await expect(awaitManifestFromRef({
      request, runId: RUN_ID, attempt: ATTEMPT,
      context: { runId: RUN_ID, attempt: ATTEMPT, workflowSha: sha("a different workflow"), repositoryId: REPOSITORY_ID, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP },
      intervalMs: 1, deadlineMs: 10_000, now: () => 0, sleep: async () => { throw new Error("must not sleep"); },
    })).rejects.toThrow(/disagrees with this job's trusted/);
    const after = polls;
    expect(after).toBeLessThan(10);
  });
});

describe("the request allowlist has no dead surface", () => {
  it("exercises every declared operation during one full commissioning run, bar the ones it names", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });

    // Match each recorded call the way the boundary does — first operation whose method and
    // anchored path/pattern accept it — so this measures the SAME dispatch the guard performs.
    const exercised = new Set<string>();
    for (const call of github.calls) {
      const matched = ALLOWED_OPERATIONS.find((operation) =>
        operation.method === call.method && (operation.path ? operation.path === call.path : operation.pattern.test(call.path)));
      if (matched) exercised.add(matched.id);
    }
    /**
     * The one operation a clean run never issues, and why it is still in the allowlist: an
     * organisation-sourced ruleset only becomes applicable when somebody adds one, and PC-04 requires
     * an inherited rule to be RESOLVED and evaluated rather than inferred from our own names. Its
     * behaviour is covered by the PC-04 inherited-ruleset case above.
     */
    const errorPathOnly = [
      "read-organization-ruleset",
      /**
       * RECONCILIATION-ONLY: it is issued when a synthetic pull-request create response was LOST, so
       * a clean run never reaches it. Its behaviour — and the exact-query guard that stops it from
       * becoming a way to enumerate the repository's pull requests — is covered by the F5
       * response-lost case below.
       */
      "list-synthetic-pulls-by-head",
    ];
    // The staged off-branch probe's rows belong to the `probe` role alone and are exercised by ITS
    // lifecycle, with the same dead-surface guard, in test/staging-offbranch-probe.test.ts.
    const declared = ALLOWED_OPERATIONS
      .filter((operation) => !(operation.roles.length === 1 && operation.roles[0] === "probe"))
      .map((operation) => operation.id);
    // An allowlisted operation nothing ever issues is either dead surface or an untested path. Both
    // are worth naming out loud rather than leaving in a list nobody re-reads.
    expect(declared.filter((id) => !exercised.has(id)).sort()).toEqual([...errorPathOnly].sort());
    const all = ALLOWED_OPERATIONS.map((operation) => operation.id);
    expect(new Set(all).size, "duplicate operation id").toBe(all.length);
  });
});

// ── Astra correction pass 1: one regression per reviewed finding ───────────────

describe("correction pass 1 — the reviewed findings, each with the defect it would have allowed", () => {
  it("F1 · re-reads the pull request's target immediately before the merge, and refuses a retarget", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    const pull = github.pulls.get(setup.synthetic_pull_request.number)!;
    // The exact defect: setup verified this pull request's base at creation, and something has
    // retargeted it since. Merging now would put a REAL merge into `staging` under the local admin
    // credential — and the case's own readback looks at the untouched disposable ref, so it would
    // have recorded a clean policy denial for a merge that actually landed somewhere else.
    pull.base = { ref: "staging", repo: { full_name: COMMISSIONING_REPOSITORY } };
    await expect(runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow();
    // NOTHING was merged, and staging is exactly where it started.
    expect(github.calls.some((call) => call.method === "PUT" && /\/merge$/.test(call.path))).toBe(false);
    expect(github.refs.get("refs/heads/staging")).toBe(STAGING_SHA);
    const evidence = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"));
    const merge = evidence.cases.find((record: CaseRecord) => record.case === "human-pull-request-merge");
    expect(merge.outcome).toBe("inconclusive");
    expect(merge.reason).toMatch(/retargeted|refuses to merge against a target it did not measure/);
  });

  it("F1 · refuses a cross-repository, closed, or moved-head pull request, and conditions the merge on the head SHA", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    const number = setup.synthetic_pull_request.number;
    const graphShas = setup.synthetic_graph;
    const request = Object.assign(async (method: string, requestPath: string, body?: unknown) => {
      const url = new URL(`https://api.github.com${requestPath}`);
      const result = github.handle("local", method, `${url.pathname}${url.search}`, body as RequestBody);
      return { ...result, diagnostic: { status: result.status, category: "ok", ruleIds: [], policyDenial: false } };
    }, { issued: [] as string[] });
    const ctx = { runId: RUN_ID, attempt: ATTEMPT };
    const journaled = { number, base: setup.synthetic_pull_request.base, head: setup.synthetic_pull_request.head };
    const pull = github.pulls.get(number)!;
    const original = structuredClone(pull);

    // The clean case reports the exact head SHA the merge will be conditioned on.
    await expect(assertSyntheticPullTarget({ request, ctx, pull: journaled, graphShas }))
      .resolves.toMatchObject({ number, head_sha: graphShas.P });

    const perturbations: [string, () => void, RegExp][] = [
      ["a cross-repository head", () => { pull.head = { ...original.head, repo: { full_name: "someone/fork" } }; }, /has its head in/],
      ["a cross-repository base", () => { pull.base = { ...original.base, repo: { full_name: "someone/fork" } }; }, /has its base in/],
      ["a closed pull request", () => { pull.state = "closed"; }, /is closed rather than open/],
      ["a head that has moved off the synthetic commit", () => { pull.head = { ...original.head, sha: sha("something else") }; }, /not the synthetic commit this run created/],
    ];
    for (const [label, perturb, expected] of perturbations) {
      Object.assign(pull, structuredClone(original));
      perturb();
      await expect(assertSyntheticPullTarget({ request, ctx, pull: journaled, graphShas }), label).rejects.toThrow(expected);
    }

    // The request boundary independently requires the head-SHA condition and nothing else, so the
    // provider gets its own chance to refuse if the head moves in the gap.
    const guardCtx = { role: "local", runId: RUN_ID, attempt: ATTEMPT, graphShas: new Set([graphShas.P]), contextNames: new Set<string>(), rulesetIds: new Set<number>(), rulesetNames: new Set<string>(), pullNumber: number };
    expect(assertAllowedRequest({ method: "PUT", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/${number}/merge`, body: { sha: graphShas.P } }, guardCtx)).toBe("merge-synthetic-pull");
    expect(() => assertAllowedRequest({ method: "PUT", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/${number}/merge`, body: {} }, guardCtx)).toThrow(/exactly the measured head SHA/);
    expect(() => assertAllowedRequest({ method: "PUT", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/${number}/merge`, body: { sha: sha("elsewhere") } }, guardCtx)).toThrow(/a commit this run created/);
    expect(() => assertAllowedRequest({ method: "PUT", path: `/repos/${COMMISSIONING_REPOSITORY}/pulls/${number}/merge`, body: { sha: graphShas.P, merge_method: "squash" } }, guardCtx)).toThrow(/exactly the measured head SHA/);
  });

  it("F3 · returns blockers for the adversarial packet that previously assessed clean", () => {
    // This is the exact shape the reviewer executed against the old checker, which returned ZERO
    // blockers: a wrong-run intent, empty objects for the actor and cleanup files, no compatibility
    // entries, every case ID pooled into the human file as a bare `passed: true`, and a boolean for
    // the environment controls.
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "intent"), { schema_version: 1, phase: "intent", run_id: "8000", attempt: ATTEMPT, workflow_sha: WORKFLOW_SHA, provider_measured: false });
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"), { schema_version: 1, phase: "setup", run_id: RUN_ID, attempt: ATTEMPT, compatibility: {} });
    for (const key of ["fixture", "normal", "emergency", "cleanup"]) {
      writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, key), { schema_version: 1, phase: EVIDENCE_PHASES[key], run_id: RUN_ID, attempt: ATTEMPT });
    }
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"), {
      schema_version: 1, phase: "human-tests", run_id: RUN_ID, attempt: ATTEMPT, workflow_sha: WORKFLOW_SHA,
      actor: { kind: "human-admin" },
      cases: buildActorMatrix().map((kase) => ({ case: kase.id, passed: true })),
    });
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), { schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls: {}, verified: true });

    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const details = (blockers as Blocker[]).map((entry) => entry.detail).join(" | ");
    expect(blockers.length).toBeGreaterThan(0);
    // Each hole the reviewer named, now its own blocker.
    expect(details).toMatch(/intent evidence file belongs to run "8000"/);
    expect(details).toMatch(/setup evidence file is missing the required field/);
    expect(details).toMatch(/fixture-checks evidence file is missing the required field/);
    expect(details).toMatch(/normal-tests evidence file is missing the required field/);
    expect(details).toMatch(/cleanup evidence file is missing the required field/);
    // The pooled bare records: a `passed: true` for another actor's case is not that case's outcome.
    expect(details).toMatch(/normal case\(s\) have no usable recorded outcome/);
    expect(details).toMatch(/emergency case\(s\) have no usable recorded outcome/);
    expect(details).toMatch(/human-force-rewind claims actor/);
    // And the boolean.
    expect(details).toMatch(/protected-environment control required_reviewer_is_owner has no per-environment records/);
  });

  /**
   * F3 · a case verdict is DERIVED from the frozen graph, not read off the record.
   *
   * The independent review executed the previous version of this gate against records for
   * `normal-update-all-green` and `normal-force-rewind` with `before == requested == after` — a no-op
   * recorded as a permitted write, and a force flag on a ref that never moved recorded as a denied
   * non-fast-forward — and it returned NO problems for either. Both are the first two cases below.
   */
  it("F3 · derives every case verdict from the frozen graph, and rejects no-op positives and force no-ops", () => {
    // The graph, keyed the way the verified journal records it, so the identities in a record can be
    // bound to a node rather than merely to a well-formed SHA.
    const graph = Object.fromEntries(buildGraphPlan(RUN_ID, ATTEMPT).map((node) => [node.key, sha(node.key)]));
    const contexts = derivedContextNames(RUN_ID, ATTEMPT);
    const last = contexts.length - 1;
    /** A per-context measurement matching a declared expectation, as `assertCheckState` records it. */
    // `head_sha` is part of the measurement, not decoration: a per-context check state is only
    // about this case if it was taken on the commit this case requested, and the synthetic nodes
    // deliberately carry DIFFERENT check states — which is what makes the missing, red and
    // wrong-producer cases separable at all.
    const checkState = (expectation: string, headSha: string) => ({
      expectation, measured: true, present: 0, producers: [NORMAL_APP], head_sha: headSha,
      contexts: contexts.map((name, ordinal) => {
        const absent = expectation === "one-required-check-absent" && ordinal === last;
        const failed = expectation === "one-required-check-failed" && ordinal === last;
        if (expectation === "none" || absent) return { ordinal, name, present: false, status: null, conclusion: null, app_id: null };
        return {
          ordinal, name, present: true, status: "completed",
          conclusion: failed ? "failure" : "success",
          app_id: expectation === "all-green-wrong-producer" ? ACTIONS_APP : NORMAL_APP,
        };
      }),
    });
    const context = { runId: RUN_ID, attempt: ATTEMPT, graph, normalAppId: NORMAL_APP };
    const kase = buildActorMatrix().find((entry) => entry.id === "normal-update-missing-check")!;
    const ref = derivedRef(RUN_ID, ATTEMPT, "normal");
    const sound = {
      case: kase.id, actor: "normal", operation: "update", force: false, expected: "denied", ref,
      outcome: "denied", passed: true, before_sha: graph.A, after_sha: graph.A, requested_sha: graph.N1,
      http_status: 422, response_complete: true, diagnostic: { status: 422, category: "repository-rule-violation", ruleIds: ["repository-rule-violation"], policyDenial: true },
      check_state: checkState(kase.checks, graph[kase.to]),
    };
    expect(deriveCaseVerdict(sound, kase, context)).toEqual([]);

    // ── THE TWO REVIEWED NO-OPS ──────────────────────────────────────────────────────────────────
    const green = buildActorMatrix().find((entry) => entry.id === "normal-update-all-green")!;
    const noopAccept = {
      case: green.id, actor: "normal", operation: "update", force: false, expected: "accepted", ref,
      outcome: "accepted", passed: true, before_sha: graph.A, requested_sha: graph.A, after_sha: graph.A,
      http_status: 200, response_complete: true, diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false },
      check_state: checkState(green.checks, graph[green.to]),
    };
    expect(deriveCaseVerdict(noopAccept, green, context).join("; "))
      .toMatch(/requests the commit the ref is already at, which is a no-op/);
    const rewind = buildActorMatrix().find((entry) => entry.id === "normal-force-rewind")!;
    const noopForce = {
      case: rewind.id, actor: "normal", operation: "force", force: true, expected: "denied", ref,
      outcome: "denied", passed: true, before_sha: graph.N4, after_sha: graph.N4, requested_sha: graph.N4,
      http_status: 422, response_complete: true, diagnostic: { status: 422, category: "non-fast-forward-rejected", ruleIds: ["non-fast-forward-rejected"], policyDenial: true },
      check_state: { expectation: "irrelevant", measured: false },
    };
    expect(deriveCaseVerdict(noopForce, rewind, context).join("; "))
      .toMatch(/no-op rather than a measurement|neither a real rewind nor a divergent commit/);
    // A record that cannot be bound to a graph at all is unverifiable, not acceptable.
    expect(deriveCaseVerdict(sound, kase, { runId: RUN_ID, attempt: ATTEMPT, graph: null }).join("; "))
      .toMatch(/cannot be bound to this run's synthetic graph/);

    // The bare claim is checked WHOLE, not merged over a sound record: `{case, passed: true}` is
    // exactly the shape the adversarial packet used, and merging it over good fields would test
    // nothing.
    expect(deriveCaseVerdict({ case: kase.id, passed: true }, kase, context).join("; "))
      .toMatch(/records the unknown outcome/);
    const perturbations: [string, Record<string, unknown>, RegExp][] = [
      ["another actor's case", { actor: "human" }, /claims actor "human"/],
      ["a ref this run did not derive", { ref: "refs/heads/main" }, /did not derive/],
      // The diagnostic BOOLEAN is no longer consulted: the category is re-classified against this
      // build's closed table, so flipping the flag changes nothing and inventing a category refuses.
      ["a fabricated diagnostic category", { diagnostic: { ...sound.diagnostic, category: "totally-denied", ruleIds: ["totally-denied"] } }, /not one this build classifies/],
      ["a non-policy diagnostic dressed as a policy denial", { diagnostic: { status: 403, category: "credential-failure", ruleIds: ["credential-failure"], policyDenial: true } }, /not attributable to a policy rule/],
      ["a denial on a ref that moved", { after_sha: graph.N1 }, /denial on a ref that moved/],
      ["a denial that is not a client refusal", { http_status: 200 }, /not a measured provider refusal/],
      // R02-1: a refusal status whose response the transport never measured as complete.
      ["a denial whose response did not complete", { response_complete: false }, /not a measured provider refusal/],
      ["a denial that states no response completion at all", { response_complete: undefined }, /not a measured provider refusal/],
      ["a before SHA that is not its graph node", { before_sha: graph.B }, /not the journaled synthetic node A/],
      ["a requested SHA that is not its graph node", { requested_sha: graph.N2 }, /not the journaled synthetic node N1/],
      ["an unmeasured check state", { check_state: { expectation: kase.checks, measured: false } }, /check state was measured/],
      // The declared expectation is RECOMPUTED from the per-context rows: `measured: true` beside a
      // contradictory measurement was previously sufficient.
      ["a check measurement that contradicts its own expectation", { check_state: { ...checkState(kase.checks, graph[kase.to]), contexts: checkState("all-green-expected-producer", graph[kase.to]).contexts } }, /requires to be absent as present/],
      ["a `passed` that disagrees with its own outcome", { passed: false }, /says passed=false for outcome denied/],
      ["an acceptance with no matching readback", { outcome: "accepted", passed: false, expected: "denied" }, /recorded accepted/],
    ];
    for (const [label, override, expected] of perturbations) {
      const problems = deriveCaseVerdict({ ...sound, ...override }, kase, context);
      expect(problems.join("; "), label).toMatch(expected);
    }
    // The acceptance invariant, on the case that is actually an acceptance and actually moves.
    const accepted = { ...noopAccept, requested_sha: graph.N4, after_sha: graph.N4 };
    expect(deriveCaseVerdict(accepted, green, context)).toEqual([]);
    expect(deriveCaseVerdict({ ...accepted, after_sha: graph.A }, green, context).join("; "))
      .toMatch(/readback is not the requested commit/);
    // A real rewind and a real divergent force both pass; the graph decides which is which.
    const realRewind = { ...noopForce, before_sha: graph.N4, requested_sha: graph.A, after_sha: graph.N4 };
    expect(deriveCaseVerdict(realRewind, rewind, context)).toEqual([]);
    const divergent = buildActorMatrix().find((entry) => entry.id === "normal-force-divergent")!;
    expect(deriveCaseVerdict({ ...realRewind, case: divergent.id, requested_sha: graph.D }, divergent, context)).toEqual([]);
  });

  /** F3 · the per-context recomputation, on its own, for every declared expectation. */
  it("F3 · recomputes each declared check expectation from its own per-context measurement", () => {
    const contexts = derivedContextNames(RUN_ID, ATTEMPT);
    const last = contexts.length - 1;
    const rows = (mutate: (row: Record<string, unknown>, ordinal: number) => Record<string, unknown>) =>
      contexts.map((name, ordinal) => mutate({ ordinal, name, present: true, status: "completed", conclusion: "success", app_id: NORMAL_APP }, ordinal));
    const base = { runId: RUN_ID, attempt: ATTEMPT, normalAppId: NORMAL_APP };
    const state = (expectation: string, contextRows: unknown[]) => ({ expectation, measured: true, contexts: contextRows });

    expect(recomputeCheckState(state("all-green-expected-producer", rows((row) => row)), { ...base, expectation: "all-green-expected-producer" })).toEqual([]);
    expect(recomputeCheckState(state("all-green-wrong-producer", rows((row) => ({ ...row, app_id: ACTIONS_APP }))), { ...base, expectation: "all-green-wrong-producer" })).toEqual([]);
    expect(recomputeCheckState(state("none", rows((row) => ({ ...row, present: false, status: null, conclusion: null, app_id: null }))), { ...base, expectation: "none" })).toEqual([]);
    expect(recomputeCheckState(
      state("one-required-check-absent", rows((row, ordinal) => (ordinal === last ? { ...row, present: false, status: null, conclusion: null, app_id: null } : row))),
      { ...base, expectation: "one-required-check-absent" },
    )).toEqual([]);
    expect(recomputeCheckState(
      state("one-required-check-failed", rows((row, ordinal) => (ordinal === last ? { ...row, conclusion: "failure" } : row))),
      { ...base, expectation: "one-required-check-failed" },
    )).toEqual([]);
    // The wrong-producer control must NOT also carry the expected producer, or a denial would not
    // isolate the producer mismatch.
    expect(recomputeCheckState(state("all-green-wrong-producer", rows((row, ordinal) => ({ ...row, app_id: ordinal === 0 ? NORMAL_APP : ACTIONS_APP }))), { ...base, expectation: "all-green-wrong-producer" }).join("; "))
      .toMatch(/expected producer also published|would not isolate/);
    // Arbitrary measured fields are not evidence: a state with no per-context rows cannot support any
    // expectation, however confidently it declares `measured: true`.
    expect(recomputeCheckState({ expectation: "all-green-expected-producer", measured: true, present: 12, producers: [NORMAL_APP] }, { ...base, expectation: "all-green-expected-producer" }).join("; "))
      .toMatch(/no per-context check measurement/);
    expect(recomputeCheckState({ expectation: "none", measured: true, contexts: [] }, { ...base, expectation: "irrelevant" }).join("; "))
      .toMatch(/measured check state for a case whose checks are irrelevant/);
  });

  it("F3 · requires cleanup to cover every resource the verified journal records this run creating", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers).toEqual([]);

    const genuine = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    // An `outcomes: []` used to satisfy every leftover check by having nothing to object to. The
    // coverage is now computed from the journal, so an empty list is a gap the journal names.
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"), { ...genuine, outcomes: [] });
    const emptied = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];
    expect(emptied.some((entry) => /journaled resource\(s\) have no cleanup outcome/.test(entry.detail))).toBe(true);

    // A dropped ref, and an invented outcome for a resource the journal never records.
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"), {
      ...genuine,
      outcomes: [...genuine.outcomes.filter((entry: { kind: string }) => entry.kind !== "ref"), { kind: "ruleset", id: 999999, name: "not-ours", result: "removed" }],
    });
    const tampered = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];
    expect(tampered.some((entry) => /have no cleanup outcome \(ref:/.test(entry.detail))).toBe(true);
    expect(tampered.some((entry) => entry.kind === "invalid" && /the journal does not record this run creating/.test(entry.detail))).toBe(true);
  });

  it("F4 · refuses to delete a ruleset whose governed BODY changed, at the same ID, name and target", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const ours = [...github.rulesets.values()].find((ruleset) => ruleset.name.includes("-human-main-integrity"))!;
    const fingerprintBefore = governedFingerprint(ours);
    // Same ID, same name, same single derived target — and its rules have been emptied. The old
    // ownership check compared exactly the three things that did NOT change, and deleted it.
    ours.rules = [];
    expect(governedFingerprint(ours)).not.toBe(fingerprintBefore);
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/did not match their journaled fingerprint/);
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    expect(cleanup.outcomes).toContainEqual(expect.objectContaining({ kind: "ruleset", id: ours.id, result: "refused-ownership-mismatch" }));
    expect(github.rulesets.has(ours.id)).toBe(true);
  });

  it("F4 · fingerprints only the governed fields, so provider bookkeeping is not a false mismatch", () => {
    const [ruleset] = transformToDisposable(
      buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS }),
      { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP },
    );
    const base = governedFingerprint(ruleset);
    // `id`, `created_at` and `source` are the provider's own bookkeeping: counting them would make
    // every readback a mismatch, and the check would be discarded within a day.
    expect(governedFingerprint({ ...ruleset, id: 7001, created_at: "2026-09-10T00:00:00Z", source: COMMISSIONING_REPOSITORY })).toBe(base);
    // Each governed field, on the other hand, must move it.
    for (const mutation of [
      { enforcement: "evaluate" },
      { bypass_actors: [{ actor_type: "Integration", actor_id: 4242, bypass_mode: "always" }] },
      { rules: [] },
      { conditions: { ref_name: { include: [derivedRef(RUN_ID, ATTEMPT, "normal")], exclude: ["x"] } } },
      { name: "renamed" },
      { target: "tag" },
    ]) {
      expect(governedFingerprint({ ...ruleset, ...mutation }), JSON.stringify(mutation)).not.toBe(base);
    }
  });

  it("F4 · refuses to adopt a journaled ruleset on resume if its body changed", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const ours = [...github.rulesets.values()].find((ruleset) => ruleset.name.includes("-normal-main-integrity"))!;
    ours.bypass_actors = [{ actor_type: "Integration", actor_id: 4242, bypass_mode: "always" }];
    // A resumed setup must not treat "same ID, same name" as "the policy I created".
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/has been modified since this run created it/);
  });

  it("F6 · serialises concurrent stale-lock recoveries and never removes a new owner's lock", async () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    journal.append("mutation-intent", { kind: "ref", ref: derivedRef(RUN_ID, ATTEMPT, "normal") });
    const originalNonce = readLockOwner(evidenceDir, RUN_ID, ATTEMPT)!.nonce;

    // Two recoveries in flight at once, both having read the same stale owner. Previously both
    // unlinked the pathname after their awaits, so the second deleted the lock the first had just
    // acquired — and two writers proceeded believing they owned the run.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, ownerGone: true,
      reconcile: async () => { await gate; return { reconciled: true }; },
    });
    // The second one cannot even start: recoveries are serialised by their own lock.
    await expect(recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, ownerGone: true, reconcile: async () => ({ reconciled: true }),
    })).rejects.toThrow(/already in flight/);
    release!();
    const recovered = await slow;
    expect(readLockOwner(evidenceDir, RUN_ID, ATTEMPT)!.nonce).not.toBe(originalNonce);

    // And the identity check at replacement: a recovery that reconciled against a lock which has
    // since been replaced refuses rather than unlinking the live owner's file.
    const liveNonce = readLockOwner(evidenceDir, RUN_ID, ATTEMPT)!.nonce;
    await expect(recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, ownerGone: true,
      reconcile: async () => {
        // Simulate the window: the lock is replaced while this recovery is awaiting its readback.
        recovered.lock.release();
        acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
        return { reconciled: true };
      },
    })).rejects.toThrow(/replaced while this recovery was reconciling/);
    expect(readLockOwner(evidenceDir, RUN_ID, ATTEMPT)!.nonce).not.toBe(liveNonce);
  });

  it("F6 · reconciles an interrupted CLEANUP, not only an interrupted mutation", async () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
    journal.append("mutation-intent", { kind: "ref", ref: derivedRef(RUN_ID, ATTEMPT, "normal") });
    journal.append("mutation-result", { kind: "ref", status: 201 });
    // The crash that matters most: a DELETE was intended and nobody knows whether it happened.
    // Looking only at `mutation-*` events reported "nothing unresolved" and moved on.
    journal.append("cleanup-intent", { kind: "ruleset", id: 7001, name: "commissioning-9001-2-human-main-integrity" });

    let handed: Record<string, unknown> | null = null;
    const recovered = await recoverJournalLock({
      dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, ownerGone: true,
      reconcile: async (intent: Record<string, unknown> | null) => { handed = intent; return { reconciled: true, readback: { present: false } }; },
    });
    expect(handed).toMatchObject({ kind_of_intent: "cleanup-intent", kind: "ruleset", id: 7001 });
    expect(recovered.unresolvedIntentType).toBe("cleanup-intent");
    expect(readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).at(-1))
      .toMatchObject({ type: "recovery", data: { unresolved_intent_type: "cleanup-intent" } });
    recovered.lock.release();
  });

  it("F7 · measures main AND staging, resolved to complete definitions, over complete pagination", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const baseline = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup")).production_baseline;
    // Staging is the dispatch branch and the contribution base. Measuring only main and then
    // reporting "production unchanged" would be a claim about half of production.
    expect(Object.keys(baseline).sort()).toEqual([
      "main_applicable_rulesets_hash", "main_classic_protection_hash", "main_classic_protection_present", "main_sha",
      "repository_ruleset_inventory_hash", "staging_applicable_rulesets_hash", "staging_classic_protection_hash",
      "staging_classic_protection_present", "staging_sha", "tag_ruleset_hashes",
    ]);
    expect(baseline.staging_sha).toBe(STAGING_SHA);
    // A change to staging's protection is drift, exactly as a change to main's would be.
    github.refs.set("refs/heads/main", sha("someone released"));
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/interrupted and needs root reconciliation/);
    expect(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup")).production_drift).toContain("main_sha");
  });

  it("F7 · treats a page that is exactly full with no following page as INCOMPLETE, not as the whole list", async () => {
    let page = 0;
    const full = Object.assign(async () => {
      page += 1;
      return { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ id: page * 1000 + index })) };
    }, { issued: [] as string[] });
    await expect(readAllPages({ request: full, endpoint: "/repos/x/y/rulesets", label: "the inventory" }))
      .rejects.toThrow(new RegExp(`exceeded ${WITNESS_MAX_PAGES} pages`));
    expect(page).toBe(WITNESS_MAX_PAGES);
    // A short page terminates; a page that is exactly full does not, because those two are
    // indistinguishable from the outside and only one of them is safe to assume.
    let calls = 0;
    const short = Object.assign(async () => { calls += 1; return { status: 200, body: [{ id: 1 }] }; }, { issued: [] as string[] });
    await expect(readAllPages({ request: short, endpoint: "/repos/x/y/rulesets", label: "the inventory" })).resolves.toHaveLength(1);
    expect(calls).toBe(1);
    const broken = Object.assign(async () => ({ status: 403, body: null }), { issued: [] as string[] });
    await expect(readAllPages({ request: broken, endpoint: "/repos/x/y/rulesets", label: "the inventory" }))
      .rejects.toThrow(/could not be measured \(403\)/);
  });

  it("F8 · binds the policy in force by BODY, and refuses a same-named ruleset whose rules were rewritten", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    // Same name, same target, still active — and its required checks have been removed after the
    // human approved the plan. A names-and-enforcement comparison accepts this, and the acceptance
    // that follows is then a statement about a policy nobody reviewed.
    const evidenceRuleset = [...github.rulesets.values()].find((ruleset) => ruleset.name.includes("-normal-main-release-evidence"))!;
    const rule = evidenceRuleset.rules!.find((entry) => entry.type === "required_status_checks")!;
    rule.parameters!.strict_required_status_checks_policy = false;
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const writesBefore = github.calls.filter((call) => call.actor === "normal" && call.method !== "GET").length;
    await expect(runCase(github, "normal", "normal-update-missing-check"))
      .rejects.toThrow(/not the reviewed disposable policy/);
    // And it refused BEFORE the mutation: the App credential made no write beyond the earlier
    // installation-level positive control, so the ONE thing this case could have done, it did not.
    expect(github.calls.filter((call) => call.actor === "normal" && call.method !== "GET").length).toBe(writesBefore);
  });

  it("F8 · refuses a manifest whose declared plan is not the one the job derives, and records what it measured", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    await runCase(github, "normal", "normal-update-missing-check");
    // The case verdict lives in the job's PRIVATE per-case state, not in a published artifact.
    const policy = JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-normal-01.json`), "utf8")).record.policy_in_force;
    // The verdict now comes from the WITNESS's complete governed measurement, run through the
    // unchanged production verifier — not from a body the read-only cloud token could not see.
    expect(policy.verdict).toBe("compatible");
    expect(policy.governed_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.classic_protection).toEqual({ present: false, status: 404 });
    // And the claim is stated at its true strength, every time it is recorded.
    expect(policy.guarantee).toMatch(/NOT an atomic policy-at-mutation proof/);
    // An additional effective rule is preserved and named rather than dropped as "not ours".
    expect(policy.foreign).toEqual([]);

    // A manifest that declares a plan this job does not derive is refused, whichever path reads it.
    const manifest = { policy_plan: { normal: [{ name: "commissioning-9001-2-normal-main-integrity", target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"), hash: "0".repeat(64) }] } };
    const ctx = { runId: RUN_ID, attempt: ATTEMPT, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS };
    const request = Object.assign(async () => ({ status: 200, body: [] }), { issued: [] as string[] });
    await expect(assertPlannedPolicyApplies({ request, ctx, actor: "normal", manifest }))
      .rejects.toThrow(/not the one this job derives from its own measured identities/);
    expect(() => verifyWitnessedPolicy({ ctx, actor: "normal", manifest, snapshot: { inert: true } }))
      .toThrow(/not the one this job derives from its own measured identities/);
  });
});

describe("the final evidence check against a hostile packet", () => {
  const write = (key: string, payload: unknown) => {
    const target = path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key));
    writeFileSync(target, typeof payload === "string" ? payload : `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  };

  it("refuses malformed, non-object and truncated evidence rather than reading fields out of it", () => {
    for (const [label, payload] of [
      ["a JSON array", []],
      ["a bare string", JSON.stringify("passed")],
      ["a number", "7"],
      ["truncated JSON", '{"schema_version": 1, "phase": "setup"'],
      ["an empty file", ""],
    ] as [string, unknown][]) {
      write("setup", payload);
      const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
      // Either unreadable (absent) or not-an-object (invalid) — never a file whose fields are read.
      expect((blockers as Blocker[]).some((entry) => /setup evidence file (is absent|is not a JSON object)/.test(entry.detail)), label).toBe(true);
    }
  });

  it("refuses a future schema version instead of best-effort reading it", () => {
    write("cleanup", { schema_version: 2, phase: "cleanup", run_id: RUN_ID, attempt: ATTEMPT, outcomes: [], refusals: 0 });
    expect((assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[])
      .some((entry) => entry.kind === "invalid" && /cleanup evidence file declares schema version 2/.test(entry.detail))).toBe(true);
  });

  it("refuses a packet whose files disagree about the immutable workflow SHA they were produced against", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    const genuine = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"));
    // A human-tests file from a different dispatch of the same run number. Every identity field
    // matches; only the source it was produced against does not.
    write("human", { ...genuine, workflow_sha: sha("a different dispatch") });
    expect((assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[])
      .some((entry) => entry.kind === "invalid" && /human-tests evidence file was produced against workflow SHA/.test(entry.detail))).toBe(true);
  });

  it("exits 1 on a hostile packet with a measured contradiction, and 3 when it is merely sparse", async () => {
    const emitted: string[] = [];
    const run = () => main(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], LOCAL_ENV, { write: (text: string) => emitted.push(text) });

    // Sparse: nothing has run. Every gate is unverified, and there is no measured failure to report.
    expect(await run()).toBe(3);
    expect(JSON.parse(emitted.at(-1)!).status).toBe("incomplete");

    // Now a real run, then one contradiction planted in it: a case record whose own outcome says the
    // human/admin was ALLOWED to move a protected ref.
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    expect(await run()).toBe(0);

    const genuine = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"));
    write("human", {
      ...genuine,
      cases: (genuine.cases as CaseRecord[]).map((record) => (record.case === "human-force-rewind"
        ? { ...record, outcome: "unexpected-success", passed: false }
        : record)),
    });
    // A measured statement about the subject: exit 1, not 3.
    expect(await run()).toBe(1);
    const failure = JSON.parse(emitted.at(-1)!);
    expect(failure.status).toBe("failed");
    expect(JSON.stringify(failure.blockers)).toMatch(/human-force-rewind recorded unexpected-success/);
  });
});

// ── correction pass 2 ─────────────────────────────────────────────────────────

/**
 * The seven findings of the exact full-diff review, each with the DEFECT IT DEMONSTRATED.
 *
 * Every case in this block was executed against the previous build and ACCEPTED. They are written
 * from the reproductions the review retained — `AIO-1124-full-diff-astra-repro.json` and
 * `AIO-1124-full-diff-astra-hostile-packet-result.json` — so a regression restores a documented
 * failure rather than an imagined one.
 *
 * Nothing here is evidence that the live policy enforces anything: these are the harness's own
 * invariants, and the actor matrix is only real once the reviewed workflow has been dispatched
 * against provisioned Apps and protected environments.
 */
describe("correction pass 2 — F1: the local witness transport and its refusals", () => {
  const zipOf = (name: string, body: unknown, method: 0 | 8 = 0) =>
    buildZip(name, Buffer.from(`${JSON.stringify(body)}\n`, "utf8"), method);

  it("reads a single-entry archive of EITHER accepted compression, and refuses every archive attack", () => {
    const payload = { kind: "commissioning-witness-response" };
    for (const method of [0, 8] as const) {
      const entry = readSingleEntryZip(zipOf("witness.json", payload, method));
      expect(JSON.parse(entry.bytes.toString("utf8"))).toEqual(payload);
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    const attacks: [string, Buffer, RegExp][] = [
      // TWO ENTRIES: which one did the publisher mean? The reviewed wiring uploads exactly one.
      ["a second entry", buildZip("witness.json", bytes, 0, { entries: [{ name: "witness.json", content: bytes }, { name: "extra.json", content: bytes }] }), /declares 2 entries/],
      ["a nested archive under the expected name", buildZip("witness.zip", bytes), /single entry is "witness.zip"/],
      ["a traversal path", buildZip("../../witness.json", bytes), /single entry is "\.\.\/\.\.\/witness\.json"/],
      ["an absolute path", buildZip("/etc/witness.json", bytes), /single entry is "\/etc\/witness\.json"/],
      // A SYMLINK entry is a pointer at the runner's filesystem rather than a document.
      ["a symlink entry", buildZip("witness.json", bytes, 0, { externalAttributes: (0o120777 << 16) >>> 0 }), /symbolic link/],
      ["a CRC that does not match the bytes", buildZip("witness.json", bytes, 0, { crc: 12345 }), /CRC does not match/],
      ["a zip64 size marker", buildZip("witness.json", bytes, 0, { uncompressedSize: 0xffffffff }), /zip64 sizes/],
      ["an entry beyond the size bound", buildZip("witness.json", Buffer.alloc(70_000, 0x41)), /beyond the 60000-byte bound/],
      ["an archive comment, which turns the EOCD scan into a search over attacker bytes", buildZip("witness.json", bytes, 0, { comment: Buffer.from("pad") }), /no end-of-central-directory record/],
      ["an entry count that disagrees with the directory", buildZip("witness.json", bytes, 0, { totalEntries: 2 }), /declares 2 entries/],
      ["an empty archive", Buffer.alloc(0), /it is empty/],
      ["an archive beyond the transport bound", Buffer.alloc(200_000, 0x50), /beyond the 131072-byte bound/],
    ];
    for (const [label, archive, expected] of attacks) {
      expect(() => readSingleEntryZip(archive), label).toThrow(expected);
    }
  });

  it("refuses to publish anything outside the CLOSED governed projection", () => {
    const runId = RUN_ID;
    const attempt = ATTEMPT;
    const target = derivedRef(runId, attempt, "normal");
    const contexts = derivedContextNames(runId, attempt);
    const allowed = {
      rulesetNames: new Set([derivedRulesetName(runId, attempt, "normal", "main-release-writer")]),
      refPatterns: new Set([target]),
      contexts: new Set(contexts),
      producerIds: new Set([NORMAL_APP, ...Object.values(PRODUCER_IDS)]),
      bypassAppIds: new Set([NORMAL_APP, EMERGENCY_APP]),
      sources: new Set([COMMISSIONING_REPOSITORY, "aiosbrain"]),
    };
    const sound = {
      id: 7001, source_type: "Repository", source: COMMISSIONING_REPOSITORY,
      name: derivedRulesetName(runId, attempt, "normal", "main-release-writer"),
      target: "branch", enforcement: "active",
      conditions: { ref_name: { include: [target], exclude: [] } },
      bypass_actors: [{ actor_type: "Integration", actor_id: NORMAL_APP, bypass_mode: "always" }],
      rules: [{ type: "update" }, { type: "pull_request" }],
    };
    expect(projectGovernedRuleset(sound, allowed).governed.name).toBe(sound.name);
    // The provider EXPANDS defaults, and the projection must carry them rather than trim them — the
    // resulting difference is reported as a `provider-normalization` gap, not hidden.
    expect(projectGovernedRuleset({ ...sound, rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: true } }] }, allowed)
      .governed.rules[0].parameters).toEqual({ update_allows_fetch_and_merge: true });

    const refusals: [string, Record<string, unknown>, RegExp][] = [
      ["an unrecognised top-level field", { ...sound, mystery: 1 }, /unrecognised field\(s\) mystery/],
      ["a ruleset name this run did not generate", { ...sound, name: "someone-elses-policy" }, /is not one of the names this run generated/],
      ["an ungoverned condition key", { ...sound, conditions: { ref_name: sound.conditions.ref_name, repository_name: { include: ["*"] } } }, /ungoverned condition key/],
      ["a ref pattern this run did not derive", { ...sound, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } } }, /ref pattern "refs\/heads\/main"/],
      ["an ungoverned rule type", { ...sound, rules: [{ type: "code_scanning" }] }, /ungoverned rule type "code_scanning"/],
      ["an ungoverned rule parameter", { ...sound, rules: [{ type: "update", parameters: { allow_everything: true } }] }, /ungoverned parameter "allow_everything"/],
      // A TEAM or ADMIN bypass is not publishable, and is not silently dropped: it stops the run.
      ["a non-App bypass identity", { ...sound, bypass_actors: [{ actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" }] }, /grants a OrganizationAdmin bypass/],
      ["an unplanned App bypass", { ...sound, bypass_actors: [{ actor_type: "Integration", actor_id: 999, bypass_mode: "always" }] }, /bypass to App 999/],
      ["a required context this run did not generate", { ...sound, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Deploy", integration_id: NORMAL_APP }] } }] }, /requires the context "Deploy"/],
      ["a producer that is not a measured identity", { ...sound, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: contexts[0], integration_id: 4242 }] } }] }, /check from producer 4242/],
      ["an unknown enforcement value", { ...sound, enforcement: "advisory" }, /unknown enforcement "advisory"/],
      ["a source this run never approved", { ...sound, source: "someone/else" }, /names the source "someone\/else"/],
    ];
    for (const [label, ruleset, expected] of refusals) {
      expect(() => projectGovernedRuleset(ruleset, allowed), label).toThrow(expected);
    }
    // A NON-EMPTY classic protection is not projectable at all: only a measured 404 may be published,
    // so a protected branch stops the run BEFORE any witness dispatch rather than being summarised.
    expect(() => buildGovernedSnapshot({
      rulesets: [sound], classicStatus: 200, classicBody: { required_status_checks: {} }, allowed,
      startedAt: "2026-09-10T09:00:00.000Z", completedAt: "2026-09-10T09:00:01.000Z", pages: 1, sourceIdentities: [],
    })).toThrow(/only a measured no-classic-protection 404 representation is publishable/);
    // And a local read that took too long is not contemporaneous.
    expect(() => buildGovernedSnapshot({
      rulesets: [sound], classicStatus: 404, classicBody: null, allowed,
      startedAt: "2026-09-10T09:00:00.000Z", completedAt: "2026-09-10T09:00:30.000Z", pages: 1, sourceIdentities: [],
    })).toThrow(/beyond the 15000ms contemporaneity bound/);
  });

  it("refuses a witness snapshot that is a verdict, a digest, or an inert rehearsal observation", () => {
    const ctx = { runId: RUN_ID, attempt: ATTEMPT, repositoryId: REPOSITORY_ID, normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS };
    const production = buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds: PRODUCER_IDS });
    const derived = transformToDisposable(production, { runId: RUN_ID, attempt: ATTEMPT, actor: "normal", normalAppId: NORMAL_APP });
    const manifest = { policy_plan: { normal: derived.map((r) => ({ name: r.name, target_ref: r.conditions.ref_name.include[0], hash: createHash("sha256").update(JSON.stringify(r)).digest("hex") })) } };
    // The manifest must agree with the job's own derivation; build it the way the runner does.
    const plan = { policy_plan: { normal: derived.map((r) => ({ name: r.name, target_ref: r.conditions.ref_name.include[0], hash: "" })) } };
    void manifest; void plan;
    for (const [label, snapshot, expected] of [
      ["a bare success boolean", { ok: true }, /carries no complete governed ruleset set/],
      ["a digest with no governed set", { projected_governed_digest: "a".repeat(64), classic_protection: { present: false, status: 404 } }, /carries no complete governed ruleset set/],
      ["an inert rehearsal observation", { inert: true }, /inert rehearsal observation/],
      ["a snapshot with no measured classic representation", { governed_rulesets: [{ governed: {} }] }, /does not carry the measured no-classic-protection representation/],
    ] as [string, unknown, RegExp][]) {
      expect(() => validateGovernedSnapshot(snapshot, {
        rulesetNames: new Set(), refPatterns: new Set(), contexts: new Set(),
        producerIds: new Set(), bypassAppIds: new Set(), sources: new Set(),
      }), label).toThrow(expected);
    }
    void ctx;
  });

  it("bounds the dispatch envelope AFTER serialization, including its JSON overhead", () => {
    // A SCHEMA-VALID response, oversized by its governed set — the bound has to be about the
    // SERIALIZED SIZE, so the packet must be otherwise acceptable or the refusal proves nothing.
    const small = {
      schema_version: 1, kind: "commissioning-witness-response",
      ...WITNESS_BINDING,
      challenge_nonce: "a".repeat(64), challenge_digest: "b".repeat(64),
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:00.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: validObservation(),
    };
    const response = { ...small, observation: validObservation({ applicability_pages: 10 }, 400) };
    expect(() => serializeDispatchEnvelope({ response })).toThrow(/beyond this harness's 60000-byte bound/);
    const envelope = serializeDispatchEnvelope({ response: small });
    expect(envelope.bytes).toBeLessThan(60_000);
    // The bound is measured on the WHOLE serialized body, not on the inner witness string.
    expect(envelope.serialized.length).toBeGreaterThan(envelope.witness.length);
    expect(() => serializeDispatchEnvelope({ response: small, mode: "commission" })).toThrow(/runs only in policy-witness mode/);
  });

  it("refuses a response whose nonce, binding, ordering or expiry does not hold", () => {
    const created = "2026-09-10T09:00:00.000Z";
    const binding = { ...WITNESS_BINDING };
    const nonce = "e".repeat(64);
    const challenge = buildChallenge({ binding, nonce, createdAt: created, extra: { before_sha: sha("A"), requested_sha: sha("N1") } });
    const digest = createHash("sha256").update("challenge-bytes").digest("hex");
    const observation = validObservation();
    const identity = { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" };
    const response = buildResponse({ challenge, challengeDigest: digest, observation, witnessIdentity: identity, createdAt: created });
    expect(assertResponseBinding(response, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: "2026-09-10T09:01:00.000Z" })).toBe(true);

    // A NONCE this job never created — the replay of a valid response to another challenge.
    expect(() => assertResponseBinding({ ...response, challenge_nonce: "f".repeat(64) }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/answers a nonce this job did not create/);
    // Challenge BYTES this job never published.
    expect(() => assertResponseBinding({ ...response, challenge_digest: "0".repeat(64) }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/answers challenge bytes this job did not publish/);
    // Every alternative remains internally shape-valid, so this exercises challenge binding rather
    // than passing because a dependent fixed field was left inconsistent.
    for (const [label, mutate] of [
      ["case", (value: Record<string, unknown>) => ({ ...value, case_id: "normal-delete", case_ordinal: 7 })],
      ["direction", (value: Record<string, unknown>) => ({ ...value, direction: "post" })],
      ["role", (value: Record<string, unknown>) => ({
        ...value, role: "emergency", job_id: "emergency", case_id: "emergency-update-no-checks",
        case_ordinal: 1, target_ref: derivedRef(RUN_ID, ATTEMPT, "emergency"), intended_app_id: EMERGENCY_APP,
      })],
      ["source", (value: Record<string, unknown>) => ({ ...value, source_sha: sha("moved") })],
      ["attempt", (value: Record<string, unknown>) => ({ ...value, original_attempt: "9", target_ref: derivedRef(RUN_ID, "9", "normal") })],
      ["App", (value: Record<string, unknown>) => ({ ...value, intended_app_id: EMERGENCY_APP })],
      ["manifest", (value: Record<string, unknown>) => ({ ...value, manifest_sha256: "9".repeat(64) })],
      ["graph", (value: Record<string, unknown>) => ({ ...value, graph_sha256: "9".repeat(64) })],
    ] as [string, (value: Record<string, unknown>) => Record<string, unknown>][]) {
      expect(() => assertResponseBinding(mutate(response), { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }), label)
        .toThrow(/not the value this job derived/);
    }
    // Role/job/mode/domain combinations outside the fixed table are shape failures in their own right.
    expect(() => assertResponseShape({ ...response, job_id: "emergency" })).toThrow(/fixed job/);
    expect(() => assertResponseShape({ ...response, source_mode: "transport-rehearsal" })).toThrow(/commission mode/);
    expect(() => assertResponseShape({ ...response, domain: "rehearsal" })).toThrow(/rehearsal response/);
    // CLOCK ORDER: a response created before the challenge it answers is impossible, and impossible
    // is a refusal rather than a tolerance to widen. No positive skew allowance exists.
    // ONE invariant: the response is created before the challenge, and its observation moves with
    // it so the (separate, also correct) "observation after its own response" rule is not what
    // fires. A negative case that trips two rules proves neither.
    expect(() => assertResponseBinding({
      ...response, created_at: "2026-09-10T08:59:00.000Z",
      observation: validObservation({ started_at: "2026-09-10T08:58:00.000Z", completed_at: "2026-09-10T08:58:00.000Z" }),
    }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/predates the challenge it answers/);
    // R4 · the complete causal order, one invariant per case, with NO tolerance in either direction.
    const at = (iso: string) => ({ started_at: iso, completed_at: iso, span_ms: 0 });
    const receipt = { challenge, challengeDigest: digest, expectedBinding: binding };
    // 1 ms before the challenge: the +1 ms allowance is gone.
    expect(() => assertResponseBinding({ ...response, created_at: "2026-09-10T08:59:59.999Z", observation: validObservation(at("2026-09-10T08:59:59.999Z")) }, { ...receipt, receivedAt: created }))
      .toThrow(/predates the challenge it answers/);
    // The review's probe: an OLD observation answering a NEW challenge (observed 00:59:40–45 for a
    // challenge created at 01:00:00), with every other ordering satisfied.
    expect(() => assertResponseBinding({
      ...response, created_at: "2026-09-10T09:00:10.000Z",
      observation: validObservation({ started_at: "2026-09-10T08:59:40.000Z", completed_at: "2026-09-10T08:59:45.000Z", span_ms: 5000 }),
    }, { ...receipt, receivedAt: "2026-09-10T09:00:20.000Z" })).toThrow(/observation started before the challenge it answers was created/);
    // ...and the same by ONE millisecond.
    expect(() => assertResponseBinding({ ...response, observation: validObservation({ started_at: "2026-09-10T08:59:59.999Z", completed_at: "2026-09-10T09:00:00.000Z", span_ms: 1 }) }, { ...receipt, receivedAt: created }))
      .toThrow(/observation started before the challenge/);
    // A response created AFTER the instant it was received (the probe's 01:00:10 vs 01:00:05), and by 1 ms.
    expect(() => assertResponseBinding({ ...response, created_at: "2026-09-10T09:00:10.000Z" }, { ...receipt, receivedAt: "2026-09-10T09:00:05.000Z" }))
      .toThrow(/creation time after the instant it was received/);
    expect(() => assertResponseBinding({ ...response, created_at: "2026-09-10T09:00:05.001Z" }, { ...receipt, receivedAt: "2026-09-10T09:00:05.000Z" }))
      .toThrow(/creation time after the instant it was received/);
    // An observation that COMPLETED after the response reporting it was created (shape half).
    expect(() => assertResponseBinding({ ...response, observation: validObservation({ started_at: created, completed_at: "2026-09-10T09:00:00.001Z", span_ms: 1 }) }, { ...receipt, receivedAt: "2026-09-10T09:00:01.000Z" }))
      .toThrow(/completed after the response reporting it was created/);
    // A CHANGED canonical echoed expiry is some other challenge's lifetime.
    for (const echoed of ["2026-09-10T09:03:00.001Z", "2026-09-10T09:02:59.999Z"]) {
      expect(() => assertResponseBinding({ ...response, challenge_expires_at: echoed }, { ...receipt, receivedAt: created }), echoed)
        .toThrow(/echoes a challenge expiry that is not the exact expiry/);
    }
    expect(() => assertResponseShape({ ...response, challenge_expires_at: "2026-09-10T10:03:00.000+01:00" }))
      .toThrow(/canonical challenge expiry/);
    // The boundaries themselves are inclusive: every instant equal is a valid, if tight, ordering.
    expect(assertResponseBinding(response, { ...receipt, receivedAt: String(challenge.expires_at) })).toBe(true);
    expect(() => assertResponseBinding(response, { ...receipt, receivedAt: new Date(Date.parse(String(challenge.expires_at)) + 1).toISOString() }))
      .toThrow(/after its 180000ms challenge expiry/);
    // QUEUE EXPIRY: arriving late is INCOMPLETE, and the expiry is never extended.
    expect(() => assertResponseBinding(response, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: "2026-09-10T09:05:00.000Z" }))
      .toThrow(/after its 180000ms challenge expiry/);
    // A response that does not name the one authorized measuring identity is unusable.
    expect(() => assertResponseBinding({ ...response, witness_identity: { login: "someone", user_id: 1, type: "User" } }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/one authorized local measuring identity/);
    // A challenge whose lifetime is not the FIXED TTL is an extension by another name.
    expect(() => assertChallengeShape({ ...challenge, expires_at: "2026-09-10T09:30:00.000Z" }))
      .toThrow(/lifetime is not the fixed 180000ms/);
    // The 90-second sequencing bounds, both directions.
    expect(() => assertObservationProximity({ observedAt: created, actedAt: "2026-09-10T09:05:00.000Z", label: "the mutation" }))
      .toThrow(/beyond the 90000ms bound/);
    expect(() => assertObservationProximity({ observedAt: created, actedAt: "2026-09-10T08:59:00.000Z", label: "the mutation" }))
      .toThrow(/before the observation it depends on/);
  });

  it("refuses a publisher run that is a rerun, a wrong actor, a wrong job or not exclusively the publisher", () => {
    const expected = { repository: COMMISSIONING_REPOSITORY, dispatchRef: "refs/heads/staging", workflowPath: COMMISSIONING_WORKFLOW_PATH };
    const env = {
      GITHUB_REPOSITORY: COMMISSIONING_REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/staging", GITHUB_JOB: "policy-witness", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: WORKFLOW_SHA, GITHUB_RUN_ID: "77001",
      GITHUB_WORKFLOW_REF: `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@refs/heads/staging`,
    };
    const run = { actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY, event: "workflow_dispatch", path: COMMISSIONING_WORKFLOW_PATH, head_sha: WORKFLOW_SHA, run_attempt: 1 };
    expect(assertPublisherContext({ env, run, expected }).sourceSha).toBe(WORKFLOW_SHA);
    // `actor` AND `triggering_actor`, because a re-run keeps the first and changes the second.
    expect(() => assertPublisherContext({ env, run: { ...run, triggering_actor: DISPATCHER_IDENTITY }, expected })).toThrow(/measured triggering_actor is not the one authorized/);
    expect(() => assertPublisherContext({ env, run: { ...run, actor: DISPATCHER_IDENTITY }, expected })).toThrow(/measured actor is not the one authorized/);
    expect(() => assertPublisherContext({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, run, expected })).toThrow(/it is a re-run/);
    expect(() => assertPublisherContext({ env: { ...env, GITHUB_JOB: "normal" }, run, expected })).toThrow(/not the fixed policy-witness job/);
    expect(() => assertPublisherContext({ env, run: { ...run, head_sha: sha("other") }, expected })).toThrow(/not the immutable source it checked out/);

    const artifact = { id: 6101, name: "commissioning-witness-9001-2-normal-01-pre-abc", workflow_run: { id: 77001 }, expired: false };
    const publisherRun = { id: 77001, ...run, status: "completed", conclusion: "success" };
    const jobsOk = [{ id: 1, conclusion: "success" }, { id: 2, conclusion: "skipped" }];
    const provenance = assertPublisherArtifactProvenance({ artifact, run: publisherRun, jobs: jobsOk, expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA } });
    // Job IDs are reported for CORRELATION, and the evidence says so rather than implying provenance.
    expect(provenance.provenance_basis).toMatch(/reviewed-immutable-workflow-exclusive-upload-wiring/);
    expect(() => assertPublisherArtifactProvenance({ artifact, run: { ...publisherRun, run_attempt: 2 }, jobs: jobsOk, expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA } }))
      .toThrow(/publisher run is a re-run/);
    expect(() => assertPublisherArtifactProvenance({ artifact, run: { ...publisherRun, conclusion: "failure" }, jobs: jobsOk, expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA } }))
      .toThrow(/pinned to a SUCCESSFUL publisher run/);
    // EXCLUSIVITY: exactly one job may execute in a witness-mode run.
    expect(() => assertPublisherArtifactProvenance({ artifact, run: publisherRun, jobs: [{ id: 1, conclusion: "success" }, { id: 2, conclusion: "success" }], expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA } }))
      .toThrow(/executed 2 jobs; exactly one publisher job/);
    expect(() => assertPublisherArtifactProvenance({ artifact, run: publisherRun, jobs: jobsOk, expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: sha("moved") } }))
      .toThrow(/did not run the immutable source this attempt is bound to/);
    expect(() => assertPublisherArtifactProvenance({ artifact: { ...artifact, expired: true }, run: publisherRun, jobs: jobsOk, expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA } }))
      .toThrow(/has expired/);
  });

  it("the publisher reads its envelope as DATA and refuses a wrong mode, a bad payload or an oversize one", () => {
    const ok = {
      schema_version: 1, kind: "commissioning-witness-response",
      ...WITNESS_BINDING,
      challenge_nonce: "a".repeat(64), challenge_digest: "b".repeat(64),
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:00.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: withGovernedDigest(validObservation() as Record<string, unknown>),
    };
    /**
     * THE CLOSED PUBLICATION VOCABULARY (F11). An envelope carrying an unknown top-level property,
     * or an observation carrying an arbitrary provider field, previously survived shape validation
     * AND dispatch serialization and was republished verbatim as an artifact. The markers here are
     * harmless; the point is the missing boundary, not a leak that has already happened.
     */
    const eventOf = (inputs: unknown) => JSON.stringify({ inputs });
    expect(() => readWitnessEnvelopeFromEvent(eventOf({ mode: "policy-witness", witness_envelope: JSON.stringify({ ...ok, unknown_top_level: "marker" }) })))
      .toThrow(/carries the field\(s\) unknown_top_level, which are outside its closed schema/);
    expect(() => readWitnessEnvelopeFromEvent(eventOf({ mode: "policy-witness", witness_envelope: JSON.stringify({ ...ok, observation: validObservation({ arbitrary_provider_field: "marker" }) }) })))
      .toThrow(/the witness observation carries the field\(s\) arbitrary_provider_field/);
    const event = (inputs: unknown) => JSON.stringify({ inputs });
    expect(readWitnessEnvelopeFromEvent(event({ mode: "policy-witness", witness_envelope: JSON.stringify(ok) })).response.kind).toBe("commissioning-witness-response");
    expect(() => readWitnessEnvelopeFromEvent(event({ mode: "commission", witness_envelope: JSON.stringify(ok) }))).toThrow(/mode is not policy-witness/);
    expect(() => readWitnessEnvelopeFromEvent(event({ mode: "policy-witness", witness_envelope: "" }))).toThrow(/no witness envelope string/);
    expect(() => readWitnessEnvelopeFromEvent(event({ mode: "policy-witness", witness_envelope: "not json" }))).toThrow(/not valid JSON/);
    expect(() => readWitnessEnvelopeFromEvent(event({ mode: "policy-witness", witness_envelope: "x".repeat(70_000) }))).toThrow(/exceeds the bounded dispatch size/);
    expect(() => readWitnessEnvelopeFromEvent("not json")).toThrow(/event payload is not valid JSON/);
    expect(() => readWitnessEnvelopeFromEvent(JSON.stringify({}))).toThrow(/no inputs object/);
    // The publisher writes the EXACT received bytes: the digest both sides cross-check is of these.
    const written: { name: string; bytes: Buffer }[] = [];
    const envelope = JSON.stringify(ok);
    // The ORIGINAL RUN the envelope names, as the provider reports it (F11). The publisher read
    // only its OWN run before, so the subject inside the envelope was taken entirely on trust.
    const originalRun = {
      id: Number(RUN_ID), path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
      head_sha: WORKFLOW_SHA, head_branch: "staging", run_attempt: Number(ATTEMPT),
      actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
    };
    const publisherExpected = {
      repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH,
      sourceSha: WORKFLOW_SHA, dispatchBranch: "staging", binding: WITNESS_BINDING,
    };
    const result = publishWitnessResponse({
      response: ok, envelope, publisherRunId: "77001", originalRun, expected: publisherExpected,
      allowed: plannedVocabulary(),
      writeEntry: (name, bytes) => { written.push({ name, bytes }); return `/tmp/${name}`; },
    });
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe("witness.json");
    /**
     * The original run's DISPATCHER is measured and RECORDED, not constrained to be John.
     *
     * PC-02 has the optional dispatcher App trigger the commissioning run so that John can approve
     * the protected environments without self-reviewing, and PC-06 then requires the reviewer to
     * be distinct from the measured dispatcher. A publisher that demanded John as the original
     * actor would make that design unsatisfiable — so this asserts the identity travels into the
     * evidence, which is what the self-review comparison needs, rather than gating on it.
     */
    expect(result.original_subject.original_dispatcher).toEqual(OWNER_IDENTITY);
    expect(result.original_subject.original_subject_measured).toBe(true);
    expect(written[0].bytes.toString("utf8")).toBe(envelope);
    expect(result.entry_digest).toBe(createHash("sha256").update(Buffer.from(envelope, "utf8")).digest("hex"));
    expect(result.note).toMatch(/does not attest that the measurement inside is true/);
    // A source that is not the one this publisher ran is refused before a byte is written.
    expect(() => publishWitnessResponse({
      response: { ...ok, source_sha: sha("moved") }, envelope, publisherRunId: "77001",
      originalRun, expected: publisherExpected, writeEntry: () => "/tmp/x",
    })).toThrow(/immutable source is not the source this publisher ran/);
    // THE ORIGINAL SUBJECT, one invariant at a time (F11): a run the provider says is a different
    // workflow, a different source, a different attempt, or somebody else's.
    for (const [label, run, expectedError] of [
      ["another workflow", { ...originalRun, path: ".github/workflows/other.yml" }, /original run is not the reviewed commissioning workflow/],
      ["another source", { ...originalRun, head_sha: sha("another tree") }, /original run did not run the immutable source this publisher ran/],
      ["another attempt", { ...originalRun, run_attempt: 9 }, /original attempt is not the attempt the provider records/],
      ["an off-branch dispatch", { ...originalRun, head_branch: "main" }, /original run was not dispatched from the fixed staging branch/],
    ] as [string, Record<string, unknown>, RegExp][]) {
      expect(() => publishWitnessResponse({
        response: ok, envelope, publisherRunId: "77001", originalRun: run,
        expected: publisherExpected, writeEntry: () => "/tmp/x",
      }), label).toThrow(expectedError);
    }
  });

  it("the publisher JOB validates its own run, writes the exact bytes, and names its own artifact", async () => {
    const github = createFakeGitHub();
    const response = {
      schema_version: 1, kind: "commissioning-witness-response",
      domain: "commission", repository: COMMISSIONING_REPOSITORY, repository_id: REPOSITORY_ID,
      source_mode: "commission", original_run_id: RUN_ID, original_attempt: ATTEMPT,
      workflow_path: COMMISSIONING_WORKFLOW_PATH, source_sha: WORKFLOW_SHA,
      role: "normal", job_id: "normal", case_id: CLOUD_CASE_SEQUENCE.normal[0], case_ordinal: 1,
      direction: "pre", target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"),
      intended_app_id: NORMAL_APP, intended_installation_id: "5001",
      manifest_sha256: "c".repeat(64), graph_sha256: "d".repeat(64),
      challenge_nonce: "e".repeat(64), challenge_digest: "f".repeat(64),
      // Created once its observation COMPLETED (R4): a response cannot report a measurement it had
      // not finished. This fixture used to be created one second before its own observation ended.
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:01.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: withGovernedDigest(validObservation({ completed_at: "2026-09-10T09:00:01.000Z", span_ms: 1000 }) as Record<string, unknown>),
    };
    const envelope = JSON.stringify(response);
    const eventPath = path.join(evidenceDir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: { mode: "policy-witness", witness_envelope: envelope } }));
    const outputPath = path.join(evidenceDir, "step-output.txt");
    writeFileSync(outputPath, "");
    // The publisher run: the authorized local identity, attempt 1, the reviewed workflow, the source
    // it checked out. `77500` is registered as a publisher run so the fake answers for it.
    github.publishWitness(envelope);
    await publishIntentArtifact(github);
    const publisherRunId = [...github.publisherRuns.keys()][0];
    const env = {
      GITHUB_REPOSITORY: COMMISSIONING_REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/staging", GITHUB_SHA: WORKFLOW_SHA, GITHUB_JOB: "policy-witness",
      GITHUB_WORKFLOW_REF: `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@refs/heads/staging`,
      GITHUB_RUN_ID: String(publisherRunId), GITHUB_RUN_ATTEMPT: "1",
      GITHUB_TOKEN: "publisher-token", COMMISSIONING_MODE: "policy-witness",
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID), COMMISSIONING_REPOSITORY_ID: String(REPOSITORY_ID),
      COMMISSIONING_EVIDENCE_DIR: evidenceDir, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
    } as unknown as NodeJS.ProcessEnv;
    const published = await runWitnessPublisherJob(env, { fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl });
    expect(published.status).toBe("published");
    expect(published.entry).toBe("witness.json");
    // The EXACT received bytes: the digest both the actor and the local witness cross-check is of
    // these, so a publisher that pretty-printed or reordered would break the binding it carries.
    expect(readFileSync(path.join(evidenceDir, "witness", "witness.json"), "utf8")).toBe(envelope);
    expect(published.entry_digest).toBe(createHash("sha256").update(Buffer.from(envelope, "utf8")).digest("hex"));
    // The artifact NAME is derived here and handed to the fixed upload step as a step output.
    expect(published.artifact_name).toBe(responseArtifactName({
      runId: RUN_ID, attempt: ATTEMPT, role: "normal", ordinal: 1, direction: "pre", nonce: response.challenge_nonce,
    }));
    expect(readFileSync(outputPath, "utf8")).toBe(`artifact_name=${published.artifact_name}\n`);
    // It holds no App secret, and it is refused outside its own job and mode.
    await expect(runWitnessPublisherJob({ ...env, GITHUB_JOB: "normal" }, { fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl }))
      .rejects.toThrow(/runs only in the policy-witness job/);
    await expect(runWitnessPublisherJob({ ...env, COMMISSIONING_MODE: "commission" }, { fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl }))
      .rejects.toThrow(/runs only in policy-witness mode/);
    await expect(runWitnessPublisherJob({ ...env, GITHUB_RUN_ATTEMPT: "2" }, { fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl }))
      .rejects.toThrow(/it is a re-run/);
  });

  it("refuses a DUPLICATE witness publication rather than selecting between two", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, "normal", 1, "pre");
    const served = await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    // A SECOND artifact under the same derived name. `never select the latest by name` means this is
    // a refusal, not a tie-break — and the duplicate is what a republished nonce would look like.
    const original = github.artifacts.get(served.artifact_id)!;
    github.addArtifact(original.name, "witness.json", Buffer.from(JSON.stringify({ duplicate: true }), "utf8"), 77999);
    await expect(runCaseStage({ stage: "await-and-execute", caseId, env, deps }))
      .rejects.toThrow(/2 artifacts are named .*commissioning never selects between duplicate/);
  });

  it("consumes a witness nonce ONCE, durably, so a replay is refused rather than believed", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, "normal", 1, "pre");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
    // The pre nonce is consumed. Re-running the execute stage is refused by the state machine before
    // anything else — a second mutation after an ambiguous one is exactly what must never happen.
    await expect(runCaseStage({ stage: "await-and-execute", caseId, env, deps }))
      .rejects.toThrow(/expected prepare state, found "await-and-execute"/);
    const state = JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-normal-01.json`), "utf8"));
    expect(state.mutation_used).toBe(true);
    expect(state.consumed).toHaveLength(1);
    // NEITHER the nonce nor any credential is serialized into the challenge or the state's evidence.
    expect(JSON.stringify(state)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(state)).not.toContain("normal-token");
  });

  it("refuses to finalize a case whose COMPLETE governed policy changed across its mutation window", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, "normal", 1, "pre");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
    // The bypass matrix is edited between the mutation and the POST observation. The pre/post pair is
    // exactly what this bounds — and the boundary is stated, not overclaimed: a change that was made
    // and REVERTED inside the window is outside the guarantee, which is why the evidence says so.
    const writer = [...github.rulesets.values()].find((ruleset) => ruleset.name.includes("-normal-main-release-writer"))!;
    writer.bypass_actors = [{ actor_type: "Integration", actor_id: EMERGENCY_APP, bypass_mode: "always" }];
    publishChallenge(github, "normal", 1, "post");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "post" });
    await expect(runCaseStage({ stage: "await-and-finalize", caseId, env, deps }))
      .rejects.toThrow(/changed across case .* mutation window|not the reviewed disposable policy/);
  });

  it("the local witness refuses a challenge from a MOVED source, another run, or an expired window", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    // The domain is stated here rather than probed: this case examines the CHALLENGE checks, and the
    // probe's own "no challenge yet" behaviour — which is retryable, because the witness is started
    // before the first case publishes — is exercised by the `witness` CLI case instead.
    const session = await openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl, domain: "commission" },
    });
    try {
      const item = { role: "normal", caseId: CLOUD_CASE_SEQUENCE.normal[0], ordinal: 1, direction: "pre" as const };
      const name = challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role: item.role, ordinal: item.ordinal, direction: item.direction });
      const sound = {
        schema_version: 1, kind: "commissioning-witness-challenge", domain: "commission",
        repository: COMMISSIONING_REPOSITORY, repository_id: REPOSITORY_ID, source_mode: "commission",
        original_run_id: RUN_ID, original_attempt: ATTEMPT, workflow_path: COMMISSIONING_WORKFLOW_PATH,
        source_sha: WORKFLOW_SHA, role: item.role, job_id: "normal", case_id: item.caseId, case_ordinal: 1,
        direction: "pre", target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"),
        intended_app_id: NORMAL_APP, intended_installation_id: "5001",
        manifest_sha256: session.setupBindings.manifest_sha256, graph_sha256: session.setupBindings.graph_sha256,
        nonce: "a".repeat(64),
        created_at: new Date(Date.now()).toISOString(), expires_at: new Date(Date.now() + 180_000).toISOString(),
      };
      const serve = (challenge: unknown) => {
        for (const id of [...github.artifacts.keys()]) github.artifacts.delete(id);
        github.addArtifact(name, `${name}.json`, Buffer.from(`${JSON.stringify(challenge)}\n`, "utf8"), Number(RUN_ID));
        return serveWitnessItem({
          request: session.request, requestArchive: session.requestArchive, ctx: session.ctx,
          journal: session.journal, item, operator: session.operator, domain: "commission",
          setupBindings: session.setupBindings, now: () => new Date(), sleep: async () => {}, intervalMs: 1,
        });
      };
      // SOURCE MOVEMENT interrupts the attempt: the challenge was created against a different tree.
      await expect(serve({ ...sound, source_sha: sha("moved") })).rejects.toThrow(/created against a different immutable source/);
      await expect(serve({ ...sound, original_run_id: "9999" })).rejects.toThrow(/names a different original run/);
      await expect(serve({ ...sound, case_id: "normal-delete" })).rejects.toThrow(/does not describe the work item this witness expected/);
      await expect(serve({ ...sound, manifest_sha256: "0".repeat(64) })).rejects.toThrow(/names a manifest this run did not publish/);
      await expect(serve({ ...sound, graph_sha256: "0".repeat(64) })).rejects.toThrow(/names a synthetic graph this run did not create/);
      await expect(serve({ ...sound, domain: "rehearsal", source_mode: "transport-rehearsal", target_ref: "rehearsal", manifest_sha256: null, graph_sha256: null }))
        .rejects.toThrow(/declares domain "rehearsal"/);
      // An EXPIRED challenge is never served late, and the expiry is never extended.
      const stale = { ...sound, created_at: new Date(Date.now() - 400_000).toISOString(), expires_at: new Date(Date.now() - 220_000).toISOString() };
      await expect(serve(stale)).rejects.toThrow(/expired before this witness could serve it/);
      // And a challenge artifact owned by ANOTHER run cannot be adopted.
      for (const id of [...github.artifacts.keys()]) github.artifacts.delete(id);
      github.addArtifact(name, `${name}.json`, Buffer.from(`${JSON.stringify(sound)}\n`, "utf8"), 424242);
      await expect(serveWitnessItem({
        request: session.request, requestArchive: session.requestArchive, ctx: session.ctx,
        journal: session.journal, item, operator: session.operator, domain: "commission",
        setupBindings: session.setupBindings, now: () => new Date(), sleep: async () => {}, intervalMs: 1,
      })).rejects.toThrow(/belongs to run 424242, not the source run this witness serves/);
    } finally {
      session.lock.release();
    }
  });

  it("the inert rehearsal shares the transport and can satisfy NO actor case", async () => {
    const github = createFakeGitHub();
    const rehearsalEnv = {
      GITHUB_REPOSITORY: COMMISSIONING_REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/staging", GITHUB_SHA: WORKFLOW_SHA,
      GITHUB_WORKFLOW_REF: `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@refs/heads/staging`,
      GITHUB_RUN_ID: "88001", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "transport-rehearsal",
      GITHUB_TOKEN: "rehearsal-token", COMMISSIONING_MODE: "transport-rehearsal",
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID), COMMISSIONING_REPOSITORY_ID: String(REPOSITORY_ID),
      COMMISSIONING_EVIDENCE_DIR: evidenceDir,
    } as unknown as NodeJS.ProcessEnv;
    github.registerRehearsalRun(88001);
    const deps = { fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    // NO synthetic graph, NO derived ref, NO resource journal — the rehearsal runs before any of
    // them exist, which is the whole reason it can measure the transport before an approval.
    const prepared = await runRehearsalStage({ stage: "challenge", env: rehearsalEnv, deps });
    expect(prepared.status).toBe("prepared");
    const challengeName = `commissioning-challenge-88001-1-rehearsal-00-pre`;
    const bytes = readFileSync(path.join(evidenceDir, "challenges", `${challengeName}.json`));
    const challenge = JSON.parse(bytes.toString("utf8"));
    expect(challenge.domain).toBe("rehearsal");
    expect(challenge.target_ref).toBe("rehearsal");
    expect(challenge.manifest_sha256).toBeNull();
    expect(challenge.graph_sha256).toBeNull();
    github.addArtifact(challengeName, `${challengeName}.json`, bytes, 88001);
    let clockMs = Date.parse(challenge.created_at) + 1_000;
    const advancingNow = () => new Date(clockMs++);
    // The local witness serves it with an INERT observation: no policy read at all.
    const witnessSession = await openWitnessSession({
      runId: "88001", attempt: "1", evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
    });
    expect(witnessSession.domain).toBe("rehearsal");
    try {
      await serveWitnessItem({
        request: witnessSession.request, requestArchive: witnessSession.requestArchive, ctx: witnessSession.ctx,
        journal: witnessSession.journal, item: { role: "rehearsal", caseId: "transport-rehearsal", ordinal: 0, direction: "pre" },
        operator: witnessSession.operator, domain: "rehearsal", setupBindings: witnessSession.setupBindings,
        now: advancingNow, sleep: async () => {}, intervalMs: 1,
      });
    } finally { witnessSession.lock.release(); }
    const consumed = await runRehearsalStage({ stage: "consume", env: rehearsalEnv, deps: { ...deps, now: advancingNow } });
    expect(consumed.status).toBe("rehearsed");
    expect(consumed.note).toMatch(/NO enforcement verdict, NO policy measurement and NO actor authority/);
    expect(consumed.domain).toBe("rehearsal");
    // The rehearsal's response is an INERT observation, so no actor could reason about it as policy.
    const response = JSON.parse(readSingleEntryZip([...github.artifacts.values()].find((a) => a.name.startsWith("commissioning-witness-88001"))!.zip).bytes.toString("utf8"));
    expect(response.observation.inert).toBe(true);
    expect(response.observation.started_at).toBe(response.observation.completed_at);
    expect(response.observation.span_ms).toBe(0);
    expect(response.observation.governed_rulesets).toBeUndefined();
    const mismatched = structuredClone(response);
    mismatched.observation.completed_at = new Date(Date.parse(mismatched.observation.started_at) + 1).toISOString();
    mismatched.created_at = mismatched.observation.completed_at;
    expect(() => assertResponseShape(mismatched, { domain: "rehearsal" }))
      .toThrow(/span does not describe its own measurement window/);
    expect(() => validateGovernedSnapshot(response.observation, {
      rulesetNames: new Set(), refPatterns: new Set(), contexts: new Set(),
      producerIds: new Set(), bypassAppIds: new Set(), sources: new Set(),
    })).toThrow(/inert rehearsal observation and carries no policy measurement/);
    // And the rehearsal job may hold no App key, by its own admission check.
    await expect(runRehearsalStage({ stage: "challenge", env: { ...rehearsalEnv, RELEASE_APP_PRIVATE_KEY: SENTINEL_KEY }, deps }))
      .rejects.toThrow(/no-secrets job by design/);
  });

  it("tolerates being STARTED BEFORE the work exists, which is the reviewed order", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    // The reviewed sequence is "start the separate local witness process, THEN explicit protected
    // human approvals and actor phases". So at start-up there is no challenge and no domain to
    // probe — and that must be a poll, not a refusal, or the process could never be started on time.
    const deps = { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1, processDeadlineMs: 5 };
    await expect(runPhase({ phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps }))
      .rejects.toThrow(/ceiling before the source run published any challenge/);
    // …and once the first challenge exists, the same phase proceeds. (It then waits for the rest,
    // which the ceiling bounds — the point here is that the START is not the refusal.)
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    await runCaseStage({
      stage: "prepare", caseId: CLOUD_CASE_SEQUENCE.normal[0],
      env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }),
      deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 },
    });
    publishChallenge(github, "normal", 1, "pre");
    await expect(runPhase({ phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps }))
      .rejects.toThrow(/ceiling after serving \d+ of 22 responses/);
  });

  it("records an INTERRUPTED case as inconclusive, and never as a matrix with fewer entries", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, "normal", 1, "pre");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
    // The mutation HAPPENED and the post witness never arrived — a runner killed between steps 3 and
    // 5. The finalizer must report that case as INCONCLUSIVE with its mutation recorded as used, and
    // every later case as `not-run`, rather than shipping a shorter matrix.
    github.finish("normal");
    await expect(runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) }))
      .rejects.toThrow(/could not be measured|did not record their expected provider outcome/);
    const evidence = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    const byCase = new Map((evidence.cases as CaseRecord[]).map((record) => [record.case, record]));
    expect(byCase.size).toBe(CLOUD_CASE_SEQUENCE.normal.length);
    expect(byCase.get(caseId)!.outcome).toBe("inconclusive");
    expect(byCase.get(caseId)!.reason).toMatch(/stopped at stage await-and-execute/);
    for (const later of CLOUD_CASE_SEQUENCE.normal.slice(1)) {
      expect(byCase.get(later)!.outcome, later).toBe("not-run");
    }
    // And the offline gate refuses the packet rather than counting six clean cases.
    environmentControls(evidenceDir);
    const blockers = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];
    // The interrupted file carries no policy measurement to bind its cases to, so it is REJECTED as
    // a whole — and the rejection and the consequent loss of case coverage are reported as two
    // different facts, which is what a reader needs: "the file was refused" and "these cases are
    // therefore unmeasured" are not the same statement.
    expect(blockers.some((entry) => entry.kind === "invalid"
      && /normal-tests evidence file is missing the required field\(s\).*policy_in_force/.test(entry.detail)), JSON.stringify(blockers, null, 2)).toBe(true);
    expect(blockers.some((entry) => entry.gate === "PC-05"
      && /normal case\(s\) have no usable recorded outcome/.test(entry.detail))).toBe(true);
  });

  it("cannot be read as an ATOMIC policy-at-mutation proof, and refuses a packet that claims one", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers).toEqual([]);
    const normal = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    // The bound is CARRIED, in the evidence, on every policy measurement — so a reader cannot
    // upgrade a bounded pre/post measurement under administrative quiescence into an atomic one.
    expect(normal.policy_in_force.guarantee).toMatch(/bounded-contemporaneous-pre-post-measurement-under-administrative-quiescence/);
    expect(normal.policy_in_force.guarantee).toMatch(/NOT an atomic policy-at-mutation proof/);
    for (const record of normal.cases as { witness?: { guarantee?: string } }[]) {
      expect(record.witness?.guarantee).toMatch(/NOT an atomic policy-at-mutation proof/);
    }
    const witness = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "witness-process"));
    expect(witness.guarantee).toMatch(/NOT an atomic policy-at-mutation proof/);
    expect(witness.note).toMatch(/NOT a global PASS/);
    // A packet that DROPS the bound — or restates it as an atomicity claim — is refused.
    const target = path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, "normal"));
    for (const guarantee of [undefined, "atomic policy-at-mutation proof"]) {
      writeFileSync(target, `${JSON.stringify({ ...normal, policy_in_force: { ...normal.policy_in_force, guarantee } }, null, 2)}\n`, { mode: 0o600 });
      expect((assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[])
        .some((entry) => /does not carry the bounded pre\/post guarantee/.test(entry.detail)), String(guarantee)).toBe(true);
    }
  });

  it("keeps every credential out of the challenge, the dispatch envelope and the case state", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    // The sentinel private key, the installation tokens and the App JWTs must appear in NOTHING the
    // transport writes down — the challenge files, the dispatch envelopes, the case state or the
    // published evidence. The transport is a publication path, so this is its leakage boundary.
    const secrets = [SENTINEL_KEY, "normal-token", "emergency-token", "normal-jwt", "emergency-jwt"];
    const surfaces: [string, string][] = [
      ["the dispatch envelopes", JSON.stringify(github.dispatches)],
      ["the published artifacts", [...github.artifacts.values()].map((a) => a.zip.toString("latin1")).join("")],
      ["the case state", readdirSync(cloudDir("state")).map((name) => readFileSync(path.join(cloudDir("state"), name), "utf8")).join("")],
      ["the challenge files", readdirSync(cloudDir("challenges")).map((name) => readFileSync(path.join(cloudDir("challenges"), name), "utf8")).join("")],
    ];
    for (const [label, text] of surfaces) {
      for (const secret of secrets) expect(text, `${label} leaked ${secret.slice(0, 12)}`).not.toContain(secret);
    }
  });
});

describe("correction pass 2 — F4/F5/F6/F7: the retained hostile packet and the identity gates", () => {
  const write = (key: string, payload: unknown) => {
    const target = path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key));
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  };

  /**
   * F4 · THE RETAINED HOSTILE PACKET.
   *
   * Every required key present, every substantive value contradicting it. The independent review
   * executed this exact combination against the previous `assessEvidence` and it returned
   * `blockers: []` — recorded in `AIO-1124-full-diff-astra-hostile-packet-result.json`. Each of the
   * eight conditions below is now a named blocker.
   */
  it("F4 · returns a blocker for EVERY condition of the reviewed hostile packet", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    // The packet is clean first, so every blocker below is attributable to exactly one perturbation.
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers).toEqual([]);

    const setup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup"));
    const normal = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    const emergency = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "emergency"));
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    const approvals = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals"));

    // 1. All case SHAs equal: a no-op recorded as a permitted write, and a force on a ref that never
    //    moved recorded as a denied non-fast-forward.
    write("normal", {
      ...normal,
      cases: (normal.cases as CaseRecord[]).map((record) => ({
        ...record, before_sha: sha("A"), requested_sha: sha("A"), after_sha: sha("A"),
      })),
    });
    // 2. The SAME App ID for both actors, and neither the one the immutable intent configured.
    write("emergency", { ...emergency, actor: { ...emergency.actor, app_id: 9999, grants: { ...emergency.actor.grants, app_id: 9999, installation_app_id: 9999 } } });
    // 3. `policy_in_force.verdict: mismatch` — a field the previous gate never read at all.
    write("normal", {
      ...readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal")),
      policy_in_force: { ...normal.policy_in_force, verdict: "mismatch", gap: "semantic" },
    });
    // 4. No published checks, so the installation-level positive control is unestablished.
    write("normal", { ...readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal")), check_publication: { count: 0, measured_producer_app_ids: [], nodes: [], published: [] } });
    // 5. No graph or ruleset resources reported by setup, and an invalid manifest digest.
    write("setup", { ...setup, synthetic_graph: {}, disposable_rulesets: { normal: [], emergency: [], human: [] }, manifest_sha256: "not-a-digest" });
    // 6. A bot approver with a failed job conclusion.
    write("approvals", {
      ...approvals,
      environments: Object.fromEntries(Object.entries(approvals.environments as Record<string, Record<string, unknown>>).map(([name, value]) => [name, {
        ...value, reviewers: [{ login: "some-bot[bot]", id: 5, type: "Bot", is_dispatcher: false }], job_conclusion: "failure",
      }])),
    });
    // 7. Main SHA drift paired with an EMPTY `production_drift`.
    write("cleanup", { ...cleanup, production_baseline_after: { ...cleanup.production_baseline_after, main_sha: sha("moved main") }, production_drift: [] });
    // 8. Every environment control observed FALSE, with one stale artifact reused throughout.
    const staleBytes = Buffer.from(`${JSON.stringify({ control: "any", environment: "any", measured: false }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(evidenceDir, "stale.json"), staleBytes);
    environmentControls(evidenceDir, (controls) => {
      for (const key of Object.keys(controls)) {
        for (const environment of Object.keys(controls[key])) {
          controls[key][environment] = {
            status: "verified", source: "provider-api", environment_name: environment, environment_id: 1,
            expected: { any: false }, measured: { any: false }, measured_at: "2020-01-01T00:00:00.000Z",
            artifact: "stale.json", artifact_sha256: createHash("sha256").update(staleBytes).digest("hex"),
          };
        }
      }
    });

    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const detail = (blockers as Blocker[]).map((entry) => `${entry.gate} ${entry.kind}: ${entry.detail}`).join("\n");
    // NOT merely non-empty: each of the eight conditions must be NAMED, so a single catch-all
    // blocker cannot stand in for eight distinct failures.
    for (const [condition, expected] of [
      ["no-op case identities", /no-op rather than a measurement|not the journaled synthetic node/],
      ["the same App for both actors", /measured App 9999, not the/],
      ["a mismatched policy in force", /recorded as "mismatch"/],
      ["no published TEST-ONLY checks", /records no published checks|positive-write liveness/],
      ["setup resources that the journal contradicts", /synthetic graph is not the one the verified journal records/],
      ["a manifest digest that is not a digest", /carries no manifest digest/],
      ["a bot approver", /non-User reviewer|configured human reviewer/],
      ["a failed protected job", /concluded "failure"/],
      ["drift with an empty drift list", /recomputing the cleanup baselines shows production moved/],
      ["environment controls measured false", /not the required outcome|expected control outcome that is not the one this build requires/],
    ] as [string, RegExp][]) {
      expect(detail, `the hostile packet's "${condition}" is not reported`).toMatch(expected);
    }
    // And the packet is a MEASURED failure, not merely incomplete.
    expect((blockers as Blocker[]).some((entry) => entry.kind === "failed")).toBe(true);
  });

  /**
   * F5 · a create whose response is LOST is journaled, reconciled, and never repeated.
   *
   * The review's reproduction created rulesets 701 AND 702 across a retry while journaling only 702,
   * leaving 701 unaccountable to cleanup. Here the same interruption yields ONE ruleset, journaled
   * with its exact ID, and a resume that reconciles rather than re-POSTs.
   */
  it("F5 · journals a created ruleset's identity BEFORE the readback that can fail, and never re-POSTs", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    // The exact reviewed interruption: POST 201, then the ownership readback fails.
    let failReadback = true;
    const spawnImpl = ((command: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const requestPath = args.find((arg, index) => arg.startsWith("/") && args[index - 1] !== "-H")!;
      if (failReadback && method === "GET" && /\/rulesets\/\d+$/.test(requestPath)) {
        const fake = new EventEmitter() as FakeChild;
        fake.pid = 1; fake.kill = () => {};
        fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
        fake.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
        fake.stdin.on("finish", () => {
          fake.stdout.on("end", () => fake.emit("close", 1));
          fake.stdout.end("HTTP/2.0 503 Service Unavailable\r\n\r\n{}");
        });
        return fake;
      }
      return github.spawnImpl(command, args);
    }) as typeof github.spawnImpl;

    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl } }))
      .rejects.toThrow(/could not be read back after creation \(503\); it is journaled as owned/);
    const afterFailure = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    const created = afterFailure.filter((record) => record.type === "resource-created" && record.data.kind === "ruleset");
    // THE CORRECTION: the created ruleset's ID is on disk, fsynced, before the readback ran.
    expect(created).toHaveLength(1);
    expect(Number(created[0].data.id)).toBeGreaterThan(0);
    expect(afterFailure.some((record) => record.type === "mutation-result" && record.data.kind === "ruleset" && Number(record.data.id) > 0)).toBe(true);
    const rulesetsAfterFailure = github.rulesets.size;

    // The resume ADOPTS that exact ID rather than creating a second ruleset under the same name.
    failReadback = false;
    const resumed = await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl } });
    expect(resumed.status).toBe("prepared");
    const names = [...github.rulesets.values()].map((ruleset) => ruleset.name);
    expect(new Set(names).size, "a name was created twice").toBe(names.length);
    expect(github.rulesets.size).toBeGreaterThanOrEqual(rulesetsAfterFailure);
    // Every journaled ruleset now has a measured provider-shape fingerprint, whatever stage measured it.
    const journal = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    const owned = journal.filter((r) => r.type === "resource-created" && r.data.kind === "ruleset").map((r) => String(r.data.name));
    const fingerprinted = journal.filter((r) => r.type === "resource-fingerprinted").map((r) => String(r.data.key));
    for (const name of owned) expect(fingerprinted, `${name} has no measured fingerprint`).toContain(name);
    // And nothing is left unresolved.
    expect(unresolvedCreateIntents(journal).filter((entry) => entry.state === "response-lost")).toEqual([]);
  });

  it("F6 · refuses any local identity but the one authorized operator, before creating anything", async () => {
    for (const [label, options, expected] of [
      ["a different admin", { operatorLogin: "someone-else", operatorId: 424242 }, /commissioning runs only as the one authorized operator/],
      ["the right login with the wrong numeric ID", { operatorId: 999 }, /commissioning runs only as the one authorized operator/],
      ["an organization identity", { operatorType: "Organization" }, /not the User this harness names/],
      ["an identity without repository admin", { operatorPermission: "write" }, /does not hold repository admin/],
    ] as [string, FakeOptions, RegExp][]) {
      const dir = mkdtempSync(path.join(tmpdir(), "aio1124-"));
      created.push(dir);
      const github = createFakeGitHub(options);
      await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: INTENT_ENV() });
      await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir: dir, env: LOCAL_ENV, deps: localDeps(github) }), label)
        .rejects.toThrow(expected);
      // NOTHING was created with the unauthorized identity.
      expect(github.rulesets.size, label).toBe(0);
      expect([...github.refs.keys()].filter((ref) => ref.includes("aios-policy-commissioning")), label).toEqual([]);
    }
  });

  it("F6 · refuses an actor packet whose App identities are the same, or not the intent's", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers).toEqual([]);
    const intent = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "intent"));
    // The intent naming ONE App as both identities is a failure in its own right.
    write("intent", { ...intent, emergency_app_id: intent.normal_app_id });
    expect((assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[])
      .some((entry) => /the SAME App as both the normal and the emergency identity/.test(entry.detail))).toBe(true);
    write("intent", intent);
    // Two actor files agreeing with themselves about the SAME unrelated App — the packet the review
    // executed — is now two blockers: neither matches the intent, and they are not distinct.
    for (const role of ["normal", "emergency"]) {
      const file = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, role));
      write(role, { ...file, actor: { ...file.actor, app_id: 9999, grants: { ...file.actor.grants, app_id: 9999, installation_app_id: 9999 } } });
    }
    const blockers = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];
    expect(blockers.filter((entry) => /measured App 9999, not the/.test(entry.detail))).toHaveLength(2);
    expect(blockers.some((entry) => /both actor files measured App 9999/.test(entry.detail))).toBe(true);
  });

  it("F7 · validates the COMPLETE role/job binding for both protected roles, before any credential", () => {
    // The reviewed defect: `PHASE_JOBS` was keyed by the phase word while the call site looked it up
    // by the role word, so BOTH lookups returned `undefined` and the guard was written
    // `if (expectedJob)`. Every role now resolves, and an unknown one refuses rather than skipping.
    for (const role of Object.keys(ROLE_BINDINGS)) {
      const binding = assertRoleBinding(role);
      expect(binding.job, `role ${role} job`).toBeTruthy();
      expect(binding.mode, `role ${role} mode`).toBeTruthy();
    }
    expect(() => assertRoleBinding("promote")).toThrow(/no role binding for "promote"/);
    expect(() => assertRoleBinding(undefined)).toThrow(/no role binding for "undefined"/);
    // BOTH protected roles, under the wrong job and under no job at all.
    for (const role of ["normal", "emergency"]) {
      const wrongJob = role === "normal" ? "emergency" : "normal";
      expect(() => assertRunContext(cloudEnv(wrongJob), { runId: RUN_ID, attempt: ATTEMPT, role }), `${role} under ${wrongJob}`)
        .toThrow(new RegExp(`the ${role} role runs only in the ${role} job`));
      const noJob = { ...cloudEnv(role) } as Record<string, string>;
      delete noJob.GITHUB_JOB;
      expect(() => assertRunContext(noJob as unknown as NodeJS.ProcessEnv, { runId: RUN_ID, attempt: ATTEMPT, role }), `${role} with no job`)
        .toThrow(/GITHUB_JOB is required/);
    }
    // The two non-actor transport jobs are bound to their own job IDs and their own modes, and
    // neither may be reached in commissioning mode.
    expect(() => assertRunContext(cloudEnv("policy-witness"), { runId: RUN_ID, attempt: ATTEMPT, role: "witness-publisher" }))
      .toThrow(/runs only in policy-witness mode/);
    expect(() => assertRunContext(cloudEnv("normal"), { runId: RUN_ID, attempt: ATTEMPT, role: "rehearsal" }))
      .toThrow(/the rehearsal role runs only in the transport-rehearsal job/);
    // An unknown or empty MODE is admitted by no role.
    for (const mode of ["", "promote", "COMMISSION"]) {
      expect(() => assertRunContext(cloudEnv("intent", { COMMISSIONING_MODE: mode }), { runId: RUN_ID, attempt: ATTEMPT, role: "intent" }), `mode ${JSON.stringify(mode)}`)
        .toThrow(/COMMISSIONING_MODE is required|refuses the unknown mode/);
    }
  });
});

// ── correction pass 3 ──────────────────────────────────────────────────────────
//
// The fifteen findings of the independent full-diff review at e6f0dd57, each with the concrete
// defect it allowed. Every negative case below starts from a CURRENT VALID PACKET or a current
// working flow and changes exactly one substantive invariant, because a case that trips two rules
// proves neither — and because "green modeled tests do not supersede these reproductions" is only
// true of tests that would have gone red.
//
// Nothing here asserts a helper's boolean. Each case asserts the OUTCOME an operator would see: a
// refusal before a mutation, a blocker in the authoritative assessment, a resource still present,
// a dispatch that did not happen twice.

describe("correction pass 3 — F1/F15: the publisher's import closure and the canonical ceilings", () => {
  /**
   * A clean copy of the EXACT working-tree source with NO `node_modules` anywhere above it.
   *
   * `mkdtemp` under the OS temp root matters: Node resolves packages by walking UP from the module,
   * so a scratch directory inside the repository would find the repository's own `node_modules` and
   * the test would prove nothing at all.
   */
  const cleanArchive = () => {
    const root = mkdtempSync(path.join(tmpdir(), "aio1124-clean-"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    cpSync(path.join(process.cwd(), "scripts"), path.join(root, "scripts"), { recursive: true });
    cpSync(path.join(process.cwd(), "package.json"), path.join(root, "package.json"));
    created.push(root);
    expect(readdirSync(root)).not.toContain("node_modules");
    return root;
  };
  /** The workflow's own Node, when the acceptance run provides it; otherwise this runtime. */
  const nodeBinary = process.env.AIOS_COMMISSIONING_NODE20 ?? process.execPath;

  it("F1 · runs the ACTUAL fixed publisher command from a clean archive with no node_modules", () => {
    const root = cleanArchive();
    /**
     * THE EXACT COMMAND THE WORKFLOW RUNS, byte for byte from the YAML's `policy-witness` step.
     *
     * The defect this reproduces: `policy-commissioning.mjs` statically imported
     * `release-controller.mjs`, which eagerly imports `jose`. The publisher deliberately performs
     * NO npm installation, so in a clean archive its fixed command exited 1 with
     * `ERR_MODULE_NOT_FOUND: Cannot find package 'jose'` at module load — before admission, before
     * envelope validation, before it could refuse honestly about anything. That blocked every
     * witness publication, including the prerequisite transport rehearsal's response.
     *
     * A string assertion that the workflow contains no `npm ci` does not establish this property;
     * only running the command in an environment with no packages does.
     */
    const command = 'import { runWitnessPublisherJob } from "./scripts/staging-ops/policy-commissioning.mjs"; await runWitnessPublisherJob(process.env);';
    const result = spawnSync(nodeBinary, ["--input-type=module", "-e", command], {
      cwd: root, encoding: "utf8",
      // No GITHUB_* at all: the process must reach its own ADMISSION refusal, which is only
      // possible if the module loaded.
      env: { PATH: process.env.PATH ?? "", HOME: root },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output, "the publisher still cannot load without its packages").not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(output, "the publisher still resolves jose at module load").not.toMatch(/Cannot find package 'jose'/);
    // It got far enough to REFUSE for a reason about its OWN ADMISSION — a run identity it does
    // not have — which is only reachable once the module and its whole import closure loaded.
    expect(output).toMatch(/UsageError|GITHUB_REPOSITORY is required|must be a positive decimal/);
  });

  it("F1 · every dependency-free module and the runner itself load with no packages present", () => {
    const root = cleanArchive();
    for (const entrypoint of [
      "policy-commissioning.mjs", "commissioning-journal.mjs", "commissioning-case.mjs", "commissioning-witness.mjs",
    ]) {
      const result = spawnSync(nodeBinary, ["--input-type=module", "-e", `await import("./scripts/staging-ops/${entrypoint}");`], {
        cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root },
      });
      expect(`${result.stdout ?? ""}${result.stderr ?? ""}`, entrypoint).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(result.status, entrypoint).toBe(0);
    }
  });

  it("F15 · uses the canonical 10×100 pagination and the 30-minute job bound from one definition", () => {
    expect(WITNESS_MAX_PAGES).toBe(10);
    expect(WITNESS_PAGE_SIZE).toBe(100);
    expect(MAX_JOB_MINUTES).toBe(30);
  });

  it("F15 · aborts an archive DURING receipt when Content-Length is absent or understates it", async () => {
    /**
     * The defect: the transport checked a DECLARED length and then buffered the entire body with
     * `arrayBuffer()` before measuring it. A missing or understated `Content-Length` therefore
     * meant the 128-KiB bound was enforced only after the bytes had already been received — which
     * is not a bound during receipt, and the declared value is exactly what a broken or hostile
     * sender controls.
     */
    const oversize = Buffer.alloc(200 * 1024, 0x41);
    const streamOf = (bytes: Buffer, chunk = 16 * 1024) => {
      let offset = 0;
      let cancelled = false;
      const reader = {
        read: async () => {
          if (cancelled || offset >= bytes.length) return { done: true, value: undefined };
          const slice = bytes.subarray(offset, offset + chunk);
          offset += chunk;
          return { done: false, value: slice };
        },
        cancel: async () => { cancelled = true; },
      };
      return { body: { getReader: () => reader }, read: () => offset };
    };
    for (const [label, headers] of [
      ["an absent Content-Length", new Map<string, string>()],
      ["an understated Content-Length", new Map([["content-length", "10"]])],
    ] as [string, Map<string, string>][]) {
      const stream = streamOf(oversize);
      const fetchImpl = (async () => ({
        ok: true, status: 200,
        headers: { get: (name: string) => headers.get(name) ?? null },
        ...stream,
      })) as unknown as typeof fetch;
      const transport = createArchiveTransport({ token: "t", fetchImpl });
      await expect(transport("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts/1/zip`), label)
        .rejects.toThrow(/exceeded the 131072-byte bound while being received/);
      // ABORTED, not drained: the read stopped inside the bound rather than after the whole body.
      expect(stream.read(), label).toBeLessThanOrEqual(128 * 1024 + 16 * 1024);
    }
  });
});

describe("correction pass 3 — F2: the authoritative assessor reconstructs the packet, it does not read it", () => {
  const evidenceFile = (key: string) => path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key));
  const write = (key: string, payload: unknown) =>
    writeFileSync(evidenceFile(key), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const blockersOf = () => assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];

  /** The complete, currently-passing packet every mutation below starts from. */
  async function validPacket() {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    return github;
  }

  it("F2 · blocks each independent corruption of a packet that currently passes", async () => {
    await validPacket();
    // THE POSITIVE BASELINE. Every case below is a regression against THIS, not a sparse packet
    // that was already invalid for some other reason.
    expect(blockersOf(), "the corrected packet does not pass").toEqual([]);

    const genuine = {
      normal: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal")),
      emergency: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "emergency")),
      witness: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "witness-process")),
    };
    const witnessJournal = path.join(evidenceDir, `commissioning-${RUN_ID}-${ATTEMPT}.witness.jsonl`);
    const witnessJournalBytes = readFileSync(witnessJournal);
    const restore = () => {
      write("normal", genuine.normal);
      write("emergency", genuine.emergency);
      write("witness-process", genuine.witness);
      writeFileSync(witnessJournal, witnessJournalBytes, { mode: 0o600 });
    };
    /** Apply ONE mutation to a copy of the genuine normal-actor file. */
    const mutateNormalCases = (mutate: (record: Record<string, unknown>) => Record<string, unknown>) =>
      write("normal", { ...genuine.normal, cases: (genuine.normal.cases as Record<string, unknown>[]).map(mutate) });

    const cases: [string, () => void, RegExp][] = [
      // Each of these returned `blockers: []` against the previous build, independently.
      ["an unrelated manifest digest", () => write("normal", { ...genuine.normal, manifest_sha256: "9".repeat(64) }),
        /manifest digest that is not the one this run's setup published/],
      ["an unrelated graph digest", () => write("normal", { ...genuine.normal, graph_sha256: "9".repeat(64) }),
        /graph digest does not describe the synthetic graph the verified journal records/],
      ["an installation proof naming repository 1 with total_count 999", () => mutateNormalCases((record) => ({
        ...record,
        token_proof: {
          ...(record.token_proof as Record<string, unknown>),
          installation: { total_count: 999, repository_id: 1, repository_full_name: COMMISSIONING_REPOSITORY },
        },
      })), /names repository 1, not the one this run's immutable intent configured/],
      ["every per-case token proof deleted", () => mutateNormalCases(({ token_proof: _dropped, ...rest }) => rest),
        /records no token proof/],
      ["every per-case policy verdict set to mismatch", () => mutateNormalCases((record) => ({
        ...record,
        policy_in_force: { ...(record.policy_in_force as Record<string, unknown>), verdict: "mismatch" },
      })), /post-mutation policy is recorded as "mismatch"/],
      ["pre/post artifact identities replaced and entry digests removed", () => mutateNormalCases((record) => {
        const witness = { ...(record.witness as Record<string, unknown>) };
        witness.pre_artifact = { artifact_id: 424242 };
        witness.post_artifact = { artifact_id: 424243 };
        delete witness.pre_entry_digest;
        delete witness.post_entry_digest;
        return { ...record, witness };
      }), /carries no pre_entry_digest|artifact is not the one the verified witness journal reconciled/],
      ["both measured timing intervals set to null", () => mutateNormalCases((record) => ({
        ...record,
        witness: { ...(record.witness as Record<string, unknown>), pre_to_mutation_ms: null, readback_to_post_ms: null },
      })), /is null rather than an actual measured interval; an absent timing is not a zero one/],
      ["invented publication case IDs with no publisher run identities", () => write("witness-process", {
        ...genuine.witness,
        publications: (genuine.witness.publications as Record<string, unknown>[]).map((entry, index) => ({
          ...entry, case_id: `invented-case-${index}`, publisher_run_id: null,
        })),
      }), /publication\(s\) for case\/direction pairs outside this run's closed set/],
      ["the entire separate witness journal removed", () => { rmSync(witnessJournal, { force: true }); },
        /separate witness journal is absent or empty/],
    ];

    for (const [label, mutate, expected] of cases) {
      restore();
      expect(blockersOf(), `${label}: the restored packet should pass`).toEqual([]);
      mutate();
      const blockers = blockersOf();
      expect(blockers.length, `${label} produced NO blocker`).toBeGreaterThan(0);
      expect(blockers.map((entry) => entry.detail).join("\n"), label).toMatch(expected);
    }
    restore();
    expect(blockersOf()).toEqual([]);
  });

  it("F2 · re-runs the same governed validators on the retained observation rather than reading its verdict", async () => {
    await validPacket();
    const genuine = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    // The retained bounded projection is present, per case AND per direction — not collapsed into
    // the first record, which is what left later cases outside substantive assessment.
    for (const record of genuine.cases as Record<string, unknown>[]) {
      const witness = record.witness as Record<string, unknown>;
      expect(Array.isArray((witness.pre_observation as Record<string, unknown>)?.governed_rulesets), String(record.case)).toBe(true);
      expect(Array.isArray((witness.post_observation as Record<string, unknown>)?.governed_rulesets), String(record.case)).toBe(true);
    }
    // A retained observation whose governed body is NOT the intended disposable policy is a
    // measured failure, however correctly it is digested and however green its own verdict reads.
    write("normal", {
      ...genuine,
      cases: (genuine.cases as Record<string, unknown>[]).map((record) => {
        const witness = { ...(record.witness as Record<string, unknown>) };
        const observation = structuredClone(witness.pre_observation) as Record<string, unknown>;
        const rulesets = observation.governed_rulesets as { governed: { rules: unknown[] } }[];
        // The reviewed policy with its rules removed: same names, same targets, no enforcement.
        // The projection's OWN losslessness digest is recomputed so that it still holds — otherwise
        // this case would trip the digest rule instead of the one it is about, and a negative case
        // that trips two rules proves neither.
        for (const entry of rulesets) entry.governed.rules = [];
        observation.projected_governed_digest = canonicalHash(rulesets.map((entry) => entry.governed));
        witness.pre_observation = observation;
        return { ...record, witness };
      }),
    });
    expect(blockersOf().map((entry) => entry.detail).join("\n"))
      .toMatch(/pre witness observation measured a .* rules that is not the intended disposable policy/);
  });
});

describe("correction pass 3 — F3/F4: live source continuity, and freshness at the actual mutation start", () => {
  const normalEnv = () => cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });

  /** Everything up to and including the first case's served pre-witness. */
  async function readyToExecute(github: ReturnType<typeof createFakeGitHub>) {
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: normalEnv(), deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    await runCaseStage({ stage: "prepare", caseId, env: normalEnv(), deps });
    publishChallenge(github, "normal", 1, "pre");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    return { caseId, deps };
  }

  it("F3 · refuses a run whose LIVE staging head is not the immutable source it claims to have run", async () => {
    // The provider fixture the previous build passed on: staging at one commit, the trusted
    // workflow SHA at another. Nothing compared them, so a complete run returned no blockers.
    const github = createFakeGitHub({ stagingSha: MOVED_STAGING_SHA });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/live staging head .* is no longer the immutable trusted source/);
    // Nothing was created: the refusal is before any disposable resource exists.
    expect(github.rulesets.size).toBe(0);
  });

  it("F3 · refuses a repository whose MEASURED default branch is not staging", async () => {
    const github = createFakeGitHub({ defaultBranch: "main" });
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }))
      .rejects.toThrow(/measured the default branch "main", not staging/);
  });

  it("F3 · interrupts at RESPONSE CONSUMPTION when the source moves after the witness measured it", async () => {
    const github = createFakeGitHub();
    const { caseId, deps } = await readyToExecute(github);
    // A REAL move of the live ref — not an edited challenge string, which is a caller-supplied
    // field and moves nothing. The response is already published and still binds perfectly.
    github.refs.set("refs/heads/staging", sha("a legitimate merge to staging"));
    await expect(runCaseStage({ stage: "await-and-execute", caseId, env: normalEnv(), deps }))
      .rejects.toThrow(/live staging head .* is no longer the immutable trusted source/);
    // NO MUTATION was issued: the interruption precedes the credential and the request.
    const derived = derivedRef(RUN_ID, ATTEMPT, "normal");
    expect(github.calls.filter((call) => ["PATCH", "DELETE"].includes(call.method) && call.path.endsWith(derived.replace("refs/heads/", "")))).toEqual([]);
  });

  it("F3 · interrupts the LOCAL WITNESS before it dispatches a measurement of a moved source", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    const emergencyEnv = cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const caseId = CLOUD_CASE_SEQUENCE.emergency[0];
    await runCaseStage({ stage: "prepare", caseId, env: emergencyEnv, deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl } });
    publishChallenge(github, "emergency", 1, "pre");
    github.refs.set("refs/heads/staging", sha("a legitimate merge to staging"));
    await expect(serveOne(github, { role: "emergency", caseId, ordinal: 1, direction: "pre" }))
      .rejects.toThrow(/live staging head .* is no longer the immutable trusted source/);
    expect(github.dispatches).toHaveLength(0);
  });

  it("F4 · checks freshness at the ACTUAL request start, after JWT reads, exchange and scoped reads", async () => {
    /**
     * The defect, precisely: `mutationStartedAt` and the 90-second observation-to-mutation bound
     * were captured BEFORE the App JWT identity reads, the token exchange and two scoped token
     * reads — three network round trips. A clock advancing 100 seconds inside the mocked exchange
     * alone still returned `status: executed` and issued the emergency PATCH, with the recorded
     * mutation time 100 seconds before the actual request.
     *
     * Each variant below advances the clock during exactly ONE of those operations.
     */
    for (const variant of ["jwt-read", "token-exchange", "scoped-read"] as const) {
      rmSync(evidenceDir, { recursive: true, force: true });
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      const github = createFakeGitHub();
      const { caseId } = await readyToExecute(github);
      let clock = Date.now();
      const advance = () => { clock += 100_000; };
      const rawTransport = (actor: string) => async (method: string, requestPath: string, body?: unknown) => {
        if (variant === "scoped-read") advance();
        return wire(github.handle(actor, method, requestPath, body as never));
      };
      const deps = {
        fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1,
        now: () => new Date(clock),
        mintAppJwt: async () => { if (variant === "jwt-read") advance(); return "normal-jwt"; },
        createInstallationToken: async () => { if (variant === "token-exchange") advance(); return "normal-token"; },
        appTransport: rawTransport("normal"),
      };
      const before = github.calls.length;
      await expect(runCaseStage({ stage: "await-and-execute", caseId, env: normalEnv(), deps }), variant)
        .rejects.toThrow(/beyond the 90000ms bound|expired before the mutation could start/);
      // ZERO MUTATIONS. The bound was exceeded, so nothing may leave the process.
      const derivedBranch = derivedRef(RUN_ID, ATTEMPT, "normal").replace("refs/heads/", "");
      expect(github.calls.slice(before).filter((call) => ["PATCH", "DELETE"].includes(call.method) && call.path.endsWith(derivedBranch)), variant).toEqual([]);
      // And the durable used marker was never written, so nothing is left ambiguous.
      const state = JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-normal-01.json`), "utf8"));
      expect(state.mutation_used, variant).not.toBe(true);
    }
  });

  it("R4 · judges a witness response's expiry at its ACTUAL receipt, after the archive download, where no mutation-start backstop exists", async () => {
    /**
     * The receipt instant was sampled BEFORE the resolver's lookup, run/job reads and archive
     * download, so a post response whose download began before expiry and finished after it was
     * consumed as fresh. The pre direction is incidentally backstopped by the mutation-start expiry
     * check; the POST direction is not — so this drives the finalizer, and the clock advances ONLY
     * inside the response archive download.
     */
    const github = createFakeGitHub();
    const { caseId, deps } = await readyToExecute(github);
    await runCaseStage({ stage: "await-and-execute", caseId, env: normalEnv(), deps });
    publishChallenge(github, "normal", 1, "post");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "post" });
    let clock = Date.now();
    let downloads = 0;
    const lateArchive = async (method: string, requestPath: string) => {
      const result = await github.archiveImpl(method, requestPath);
      downloads += 1;
      clock += 200_000; // beyond the 180 s lifetime, spent entirely inside acquisition
      return result;
    };
    await expect(runCaseStage({
      stage: "await-and-finalize", caseId, env: normalEnv(),
      deps: { ...deps, archiveTransport: lateArchive, now: () => new Date(clock) },
    })).rejects.toThrow(/arrived after its 180000ms challenge expiry/);
    expect(downloads).toBeGreaterThan(0);
    // Not finalized, and not quietly retried: the case stays at its executed stage.
    const state = JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-normal-01.json`), "utf8"));
    expect(state.status).not.toBe("finalized");
    expect((state.consumed ?? []).filter((entry: { direction: string }) => entry.direction === "post")).toEqual([]);
    // A caller cannot bring a pre-sampled receipt instant back in.
    await expect(resolvePublishedResponse({
      request: async () => { throw new Error("no request may be issued"); }, requestArchive: async () => { throw new Error("no download"); },
      ctx: {}, binding: {}, challenge: { nonce: "e".repeat(64) }, challengeDigest: "d".repeat(64),
      receivedAt: new Date().toISOString(), receiptClock: () => new Date().toISOString(),
    })).rejects.toThrow(/read by the resolver after acquisition, never supplied in advance/);
  });
});

describe("correction pass 3 — F5/F6: the ready-work scheduler and pending-dispatch reconciliation", () => {
  /** Setup, fixture, and the emergency role approved and running — normal deliberately absent. */
  async function emergencyFirst(github: ReturnType<typeof createFakeGitHub>) {
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    const env = cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    const caseId = CLOUD_CASE_SEQUENCE.emergency[0];
    await runCaseStage({ stage: "prepare", caseId, env, deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl } });
    publishChallenge(github, "emergency", 1, "pre");
    return caseId;
  }

  const witnessDeps = (github: ReturnType<typeof createFakeGitHub>, clock: { value: number }) => ({
    spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl,
    now: () => new Date(clock.value), sleep: async () => { clock.value += 5_000; },
    intervalMs: 5_000, processDeadlineMs: 120_000,
  });

  it("F5 · serves an independently approved emergency job instead of starving it behind normal", async () => {
    /**
     * The reproduction: the work plan listed all fourteen NORMAL responses before any of the eight
     * emergency ones, and the process BLOCKED on each missing item until its overall ceiling. So
     * approving emergency first — which the workflow explicitly allows, since emergency needs only
     * `intent` — published a valid expiring challenge that the witness never looked at, and it
     * died of its own 180-second lifetime with ZERO dispatches and zero of 22 served.
     */
    const github = createFakeGitHub();
    await emergencyFirst(github);
    const clock = { value: Date.now() };
    await expect(runPhase({
      phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: witnessDeps(github, clock),
    })).rejects.toThrow(/ceiling after serving 1 of 22 responses/);
    // THE PROPERTY: emergency's ready work was served while normal had published nothing at all.
    expect(github.dispatches, "the emergency challenge was never served").toHaveLength(1);
    const journal = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" }) as JournalRecord[];
    const reconciled = journal.filter((record) => record.type === "response-reconciled");
    expect(reconciled).toHaveLength(1);
    expect(String(reconciled[0].data.role)).toBe("emergency");
  });

  it("F5 · serves BOTH roles when their challenges arrive interleaved, in each role's own order", async () => {
    const github = createFakeGitHub();
    await emergencyFirst(github);
    // Normal arrives second — the REVERSE of the plan order — and must also be served.
    github.createNormalJob();
    github.approve("normal");
    const normalEnv = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    await runNormalCheckPublication({ env: normalEnv, deps: cloudDeps(github) });
    await runCaseStage({ stage: "prepare", caseId: CLOUD_CASE_SEQUENCE.normal[0], env: normalEnv, deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl } });
    publishChallenge(github, "normal", 1, "pre");

    const clock = { value: Date.now() };
    await expect(runPhase({
      phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: witnessDeps(github, clock),
    })).rejects.toThrow(/ceiling after serving 2 of 22 responses/);
    const journal = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" }) as JournalRecord[];
    const roles = journal.filter((record) => record.type === "response-reconciled").map((record) => String(record.data.role));
    expect(roles.sort()).toEqual(["emergency", "normal"]);
    // PER-ROLE ORDER is untouched: each role's first case, in its own closed sequence, and nothing
    // later served before it.
    const cases = journal.filter((record) => record.type === "response-reconciled").map((record) => String(record.data.case_id));
    expect(cases).toContain(CLOUD_CASE_SEQUENCE.emergency[0]);
    expect(cases).toContain(CLOUD_CASE_SEQUENCE.normal[0]);
  });

  it("F6 · never re-dispatches a nonce whose first dispatch is still pending, across a restart", async () => {
    /**
     * The reproduction: the restart path only asked whether the expected ARTIFACT existed. It never
     * consulted the durable `dispatch-intent`/`dispatch-result` records — so a first dispatch that
     * WAS accepted, whose process then died before the upload landed, left no artifact to find and
     * the restart created a new observation and POSTed the same challenge again: one dispatch
     * before the simulated crash, two after reopening the same journal.
     */
    const github = createFakeGitHub({ suppressPublisher: true });
    const caseId = await emergencyFirst(github);
    const item = { role: "emergency", caseId, ordinal: 1, direction: "pre" as const };
    const open = () => openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
    });

    const first = await open();
    const begun = await beginWitnessItem({
      request: first.request, requestArchive: first.requestArchive, ctx: first.ctx, journal: first.journal,
      item, operator: first.operator, domain: first.domain, setupBindings: first.setupBindings,
    });
    expect(begun.state).toBe("pending");
    expect(github.dispatches).toHaveLength(1);
    first.lock.release();

    // THE CRASH AND RESTART: a new process, the same durable journal, the same live challenge.
    const restarted = await open();
    const again = await beginWitnessItem({
      request: restarted.request, requestArchive: restarted.requestArchive, ctx: restarted.ctx, journal: restarted.journal,
      item, operator: restarted.operator, domain: restarted.domain, setupBindings: restarted.setupBindings,
    });
    expect(again.state, "a pending dispatch was treated as absent").toBe("pending");
    expect(github.dispatches, "the same nonce was dispatched twice").toHaveLength(1);
    expect(again.recoveredPendingDispatchSeq).toBeGreaterThan(0);

    // THE DELAYED UPLOAD finally lands. The restart reconciles it — still without re-dispatching.
    const envelope = String((github.dispatches[0] as { inputs: { witness_envelope: string } }).inputs.witness_envelope);
    github.publishWitness(envelope);
    const reconciledRun = await beginWitnessItem({
      request: restarted.request, requestArchive: restarted.requestArchive, ctx: restarted.ctx, journal: restarted.journal,
      item, operator: restarted.operator, domain: restarted.domain, setupBindings: restarted.setupBindings,
    });
    expect(reconciledRun.state).toBe("reconciled");
    expect(github.dispatches).toHaveLength(1);
    // Reconciled through the CONSUMER's rules: a provider artifact ID and the exact entry digest,
    // not a listing row under a matching name.
    expect(Number(reconciledRun.reconciled.artifact_id)).toBeGreaterThan(0);
    expect(String(reconciledRun.reconciled.entry_digest)).toMatch(/^[0-9a-f]{64}$/);
    restarted.lock.release();
  });

  it.each([502, 503])("F6 · a witness dispatch answered %i is pending and never re-dispatched, not a refusal", async (status) => {
    // A 5xx can follow a dispatch the scheduler accepted, exactly like a lost response.
    const github = createFakeGitHub({ suppressPublisher: true });
    const caseId = await emergencyFirst(github);
    const item = { role: "emergency", caseId, ordinal: 1, direction: "pre" as const };
    const session = await openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
    });
    try {
      const failing = async (method: string, requestPath: string, body?: unknown) => {
        const response = await session.request(method, requestPath, body as never);
        return requestPath.endsWith("/dispatches") ? (status === 0 ? lostResponse() : wire({ status, body: { message: "Server Error" } })) : response;
      };
      const begin = () => beginWitnessItem({
        request: failing, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
        item, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      });
      expect((await begin()).state).toBe("pending");
      expect((await begin()).state).toBe("pending");
      expect(github.dispatches).toHaveLength(1);
      const results = (session.journal.read() as JournalRecord[]).filter((record) => record.type === "dispatch-result");
      expect(results.map((record) => record.data)).toEqual([expect.objectContaining({ status, ambiguous: true })]);
    } finally {
      session.lock.release();
    }
  });

  it("F6 · refuses an artifact published under the expected name whose bytes do not bind", async () => {
    const github = createFakeGitHub({ suppressPublisher: true });
    const caseId = await emergencyFirst(github);
    const item = { role: "emergency", caseId, ordinal: 1, direction: "pre" as const };
    const session = await openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
    });
    try {
      await beginWitnessItem({
        request: session.request, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
        item, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      });
      // Somebody publishes SOMETHING under the exact expected name. The name-only reconciliation
      // this replaces would have returned it as a publication without reading a byte of it.
      const envelope = JSON.parse(String((github.dispatches[0] as { inputs: { witness_envelope: string } }).inputs.witness_envelope));
      const name = responseArtifactName({
        runId: RUN_ID, attempt: ATTEMPT, role: "emergency", ordinal: 1, direction: "pre", nonce: envelope.challenge_nonce,
      });
      const publisherRunId = [...github.publisherRuns.keys()][0] ?? 79001;
      github.publisherRuns.set(publisherRunId, {
        id: publisherRunId, head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
        head_branch: "staging", run_attempt: 1, status: "completed", conclusion: "success",
        actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
      });
      github.addArtifact(name, "witness.json", Buffer.from(JSON.stringify({ ...envelope, challenge_digest: "0".repeat(64) }), "utf8"), publisherRunId);
      await expect(beginWitnessItem({
        request: session.request, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
        item, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      })).rejects.toThrow(/answers challenge bytes this job did not publish/);
    } finally { session.lock.release(); }
  });
});

describe("correction pass 3 — F7/F8/F9: durable identity, provable ownership and who may delete", () => {
  const openResourceJournal = () => {
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    return { lock, journal: openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock }) };
  };
  const recordingRequest = (answers: (method: string, path: string) => { status: number; body: unknown }) => {
    const calls: string[] = [];
    const request = Object.assign(async (method: string, requestPath: string) => {
      calls.push(`${method} ${requestPath}`);
      return { ...answers(method, requestPath), diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false }, operation: "stub" };
    }, { issued: [] as string[] });
    return { request, calls };
  };
  const CTX = { runId: RUN_ID, attempt: ATTEMPT };

  it("F7 · never turns an absent provider identity into zero", () => {
    // `Number(null)` is 0 and `Number.isInteger(0)` is true, which is how a create with no identity
    // became "identity 0" — a forbidden `/rulesets/0` request and an owned pull request number 0.
    for (const value of [null, undefined, 0, "0", -1, 1.5, "1e3", "", "abc", {}, []]) {
      expect(positiveProviderId(value as never), JSON.stringify(value ?? null)).toBeNull();
    }
    expect(positiveProviderId(7001)).toBe(7001);
    expect(positiveProviderId("7001")).toBe(7001);
  });

  it("F7 · distinguishes a refused create from an ambiguous one and from a lost response", () => {
    const intent = (kind: string, data: Record<string, unknown>) => ({ seq: 1, type: "mutation-intent", data: { kind, ...data } });
    const result = (kind: string, data: Record<string, unknown>) => ({ seq: 2, type: "mutation-result", data: { kind, ...data } });
    const name = derivedRulesetName(RUN_ID, ATTEMPT, "normal", "main-integrity");
    const states = (records: unknown[]) => (unresolvedCreateIntents(records as never) as { state: string; unresolved: boolean }[])[0];

    // A response with NO usable identity at a 2xx: something may exist and nobody can name it.
    expect(states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status: 201, id: null })]).state).toBe("response-ambiguous");
    // A MEASURED refusal: nothing was created, and that is settled rather than outstanding.
    const refused = states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status: 422, response_complete: true, id: null })]);
    expect(refused.state).toBe("refused");
    expect(refused.unresolved).toBe(false);
    // R02-1: the same 422 whose response the transport did NOT measure as complete (or a legacy
    // result that states no completion) is not a refusal — the create may have been committed.
    for (const completion of [{ response_complete: false }, {}]) {
      const unfinished = states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status: 422, ...completion, id: null })]);
      expect(unfinished, JSON.stringify(completion)).toMatchObject({ state: "response-ambiguous", unresolved: true });
    }
    // And a ref create's 201 is only `identified` by its name when it completed.
    const refName = derivedRef(RUN_ID, ATTEMPT, "normal");
    expect(states([intent("ref", { suffix: "normal", ref: refName }), result("ref", { key: "normal", suffix: "normal", ref: refName, status: 201, response_complete: true })]).state).toBe("identified");
    expect(states([intent("ref", { suffix: "normal", ref: refName }), result("ref", { key: "normal", suffix: "normal", ref: refName, status: 201, response_complete: false })]).state).toBe("response-ambiguous");
    // A transport failure at status 0, a 5xx or a 408 is ambiguous, not refused: a 503 can follow a
    // committed create, so recreating would duplicate it.
    for (const status of [0, 500, 502, 503, 504, 408]) {
      const ambiguous = states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status, response_complete: status !== 0, id: null })]);
      expect(ambiguous, String(status)).toMatchObject({ state: "response-ambiguous", unresolved: true });
    }
    // No result at all.
    expect(states([intent("ruleset", { name })]).state).toBe("response-lost");
    // A POSITIVE identity is adoptable; a zero one never was an identity.
    expect(states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status: 201, id: 7009 })]).state).toBe("identified");
    expect(states([intent("ruleset", { name }), result("ruleset", { key: `ruleset:${name}`, name, status: 201, id: 0 })]).state).toBe("response-ambiguous");
  });

  it("F7 · reconciles a lost ruleset create by READING the provider, never by requesting ruleset 0", async () => {
    const { lock, journal } = openResourceJournal();
    try {
      const name = derivedRulesetName(RUN_ID, ATTEMPT, "normal", "main-integrity");
      journal.append("mutation-intent", { kind: "ruleset", actor: "normal", name, target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"), hash: "0".repeat(64) });
      journal.append("mutation-result", { kind: "ruleset", key: `ruleset:${name}`, name, status: 0, id: null });
      const { request, calls } = recordingRequest((_method, requestPath) =>
        (requestPath.startsWith(`/repos/${COMMISSIONING_REPOSITORY}/rulesets?`) ? { status: 200, body: [] } : { status: 404, body: null }));
      const outcomes = await reconcileCreateIntents({ request, ctx: CTX, journal });
      expect(outcomes[0].outcome).toBe("absent");
      // THE DEFECT: `/rulesets/0`, issued with no provider read behind it.
      expect(calls.filter((call) => /\/rulesets\/0(\?|$)/.test(call))).toEqual([]);
      expect(calls.some((call) => call.includes("/rulesets?per_page=100&page=1"))).toBe(true);
      // A SECOND pass replays the recorded reconciliation rather than repeating it — the key the
      // reconciliation is written under is the key it is looked up by, which it was not.
      const replayed = await reconcileCreateIntents({ request, ctx: CTX, journal });
      expect((replayed[0] as { replayed?: boolean }).replayed).toBe(true);
    } finally { lock.release(); }
  });

  it("F7 · reconciles a lost pull-request create by listing this run's own head, never by journaling number 0", async () => {
    const { lock, journal } = openResourceJournal();
    try {
      const head = derivedRef(RUN_ID, ATTEMPT, "pr-head").replace("refs/heads/", "");
      const base = derivedRef(RUN_ID, ATTEMPT, "human").replace("refs/heads/", "");
      journal.append("mutation-intent", { kind: "pull-request", base, head });
      journal.append("mutation-result", { kind: "pull-request", key: head, base, head, status: 0, number: null });
      const { request, calls } = recordingRequest(() => ({ status: 200, body: [] }));
      const outcomes = await reconcileCreateIntents({ request, ctx: CTX, journal });
      expect(outcomes[0].outcome).toBe("absent");
      // A PROVIDER CALL happened, which is exactly what the zero-identity path skipped.
      expect(calls.some((call) => call.includes("/pulls?per_page=100&page=1&state=all&head="))).toBe(true);
      const created = (journal.read() as JournalRecord[]).filter((record) => record.type === "resource-created");
      expect(created, "an owned pull request number zero was journaled").toEqual([]);
    } finally { lock.release(); }
  });

  it("F8 · refuses to delete a ruleset whose first fingerprint was never measured and whose body changed", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    // The exact durable state the reproduction uses: a 201 followed by a failed ownership readback,
    // so the resource is owned, named, and has NO measured fingerprint.
    let failReadback = true;
    const spawnImpl = ((command: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const requestPath = args.find((arg, index) => arg.startsWith("/") && args[index - 1] !== "-H")!;
      if (failReadback && method === "GET" && /\/rulesets\/\d+$/.test(requestPath)) {
        const fake = new EventEmitter() as FakeChild;
        fake.pid = 1; fake.kill = () => {};
        fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
        fake.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
        fake.stdin.on("finish", () => {
          fake.stdout.on("end", () => fake.emit("close", 1));
          fake.stdout.end("HTTP/2.0 503 Service Unavailable\r\n\r\n{}");
        });
        return fake;
      }
      return github.spawnImpl(command, args);
    }) as typeof github.spawnImpl;
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl } }))
      .rejects.toThrow(/could not be read back after creation \(503\)/);
    failReadback = false;

    // SOMEBODY EDITS IT. Same ID, same name, same single include ref — and no rules at all.
    const owned = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .find((record) => record.type === "resource-created" && record.data.kind === "ruleset")!;
    const changedId = Number(owned.data.id);
    github.rulesets.get(changedId)!.rules = [];

    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl } }))
      .rejects.toThrow(/could not be removed or did not match their journaled fingerprint/);
    // THE PROPERTY: the changed ruleset is STILL THERE. A later refusal about unrelated drift does
    // not undo an unsafe deletion, so the deletion must not happen at all.
    expect(github.rulesets.has(changedId), "a changed, never-fingerprinted ruleset was deleted").toBe(true);
    const cleanup = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "cleanup"));
    const outcome = (cleanup.outcomes as { id: number; result: string; ownership_gap?: boolean }[]).find((entry) => entry.id === changedId);
    expect(outcome?.result).toBe("refused-ownership-mismatch");
    expect(outcome?.ownership_gap).toBe(true);
    // The gap is recorded in the chain for root, not merely reported in a file.
    expect((readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .some((record) => record.type === "reconciliation" && record.data.outcome === "ownership-unprovable")).toBe(true);
  });

  it("F9 · refuses cleanup run by a DIFFERENT repository administrator, before any delete", async () => {
    const github = createFakeGitHub();
    await commissionEverything(github);
    // The credential is swapped between setup and cleanup. The previous build returned `cleaned`,
    // issued thirteen DELETEs, and never read `/user` at all.
    const spawnImpl = ((command: string, args: string[]) => {
      const requestPath = args.find((arg, index) => arg.startsWith("/") && args[index - 1] !== "-H")!;
      if (requestPath === "/user") {
        const fake = new EventEmitter() as FakeChild;
        fake.pid = 1; fake.kill = () => {};
        fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
        fake.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
        fake.stdin.on("finish", () => {
          fake.stdout.on("end", () => fake.emit("close", 0));
          fake.stdout.end(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ login: "another-admin", id: 424242, type: "User" })}`);
        });
        return fake;
      }
      return github.spawnImpl(command, args);
    }) as typeof github.spawnImpl;
    const before = github.calls.filter((call) => call.method === "DELETE").length;
    await expect(runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl } }))
      .rejects.toThrow(/commissioning runs only as the one authorized operator johnellison/);
    expect(github.calls.filter((call) => call.method === "DELETE").length, "a different admin deleted resources").toBe(before);
  });
});

describe("correction pass 3 — F10/F11/F12/F13/F14: pending publishers, closed admission and the alternate paths", () => {
  const provenanceExpected = { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA };
  const artifact = { id: 6101, name: "commissioning-witness-x", expired: false, workflow_run: { id: 77001 } };
  const publisherRun = {
    id: 77001, actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY, event: "workflow_dispatch",
    path: COMMISSIONING_WORKFLOW_PATH, head_sha: WORKFLOW_SHA, run_attempt: 1,
    status: "completed", conclusion: "success",
  };
  const jobsOk = [{ id: 1, conclusion: "success" }, { id: 2, conclusion: "skipped" }];

  it("F10 · treats a correctly bound NONTERMINAL publisher as pending, and a failed one as a refusal", () => {
    /**
     * An upload necessarily happens BEFORE the job and run that produced it can finish, so an
     * artifact visible while its own valid publisher is `in_progress` is the ordinary case. This
     * threw `WitnessIncomplete` WITHOUT the retryable marker, so the bounded waiter aborted
     * immediately — with zero sleeps, on a run that was about to succeed.
     */
    const pending = () => assertPublisherArtifactProvenance({
      artifact, run: { ...publisherRun, status: "in_progress", conclusion: null }, jobs: jobsOk, expected: provenanceExpected,
    });
    expect(pending).toThrow(/correctly bound but has not finished, so this publication is PENDING/);
    try { pending(); } catch (error) { expect((error as { detail?: { retryable?: boolean } }).detail?.retryable).toBe(true); }
    // A TERMINAL failure is refused immediately: there is nothing to wait for.
    const failed = () => assertPublisherArtifactProvenance({
      artifact, run: { ...publisherRun, conclusion: "failure" }, jobs: jobsOk, expected: provenanceExpected,
    });
    expect(failed).toThrow(/completed as "failure"; a publication is pinned to a SUCCESSFUL publisher run/);
    try { failed(); } catch (error) { expect((error as { detail?: { retryable?: boolean } }).detail?.retryable).not.toBe(true); }
    // A WRONG-SOURCE publisher is refused outright even while running: waiting for a run that can
    // never be acceptable is only a slower refusal.
    const wrongSource = () => assertPublisherArtifactProvenance({
      artifact, run: { ...publisherRun, status: "in_progress", conclusion: null, head_sha: sha("moved") },
      jobs: jobsOk, expected: provenanceExpected,
    });
    expect(wrongSource).toThrow(/did not run the immutable source this attempt is bound to/);
    try { wrongSource(); } catch (error) { expect((error as { detail?: { retryable?: boolean } }).detail?.retryable).not.toBe(true); }
  });

  it("F10 · WAITS for an in-progress publisher and then consumes it, rather than aborting", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    await runNormalCheckPublication({ env, deps: cloudDeps(github) });
    const caseId = CLOUD_CASE_SEQUENCE.normal[0];
    await runCaseStage({ stage: "prepare", caseId, env, deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl } });
    publishChallenge(github, "normal", 1, "pre");
    await serveOne(github, { role: "normal", caseId, ordinal: 1, direction: "pre" });
    // The artifact is visible; its publisher run has NOT finished yet.
    const publisherRunId = [...github.publisherRuns.keys()].at(-1)!;
    const record = github.publisherRuns.get(publisherRunId)!;
    github.publisherRuns.set(publisherRunId, { ...record, status: "in_progress", conclusion: null });
    let sleeps = 0;
    const executed = await runCaseStage({
      stage: "await-and-execute", caseId, env,
      deps: {
        ...cloudDeps(github), archiveTransport: github.archiveImpl, intervalMs: 1,
        sleep: async () => { sleeps += 1; github.publisherRuns.set(publisherRunId, { ...record, status: "completed", conclusion: "success" }); },
      },
    });
    expect(executed.status).toBe("executed");
    expect(sleeps, "the waiter aborted instead of waiting for the publisher's terminal result").toBeGreaterThan(0);
  });

  it("F11 · the rehearsal requires ITS OWN named job, attempt 1 and the measured John", async () => {
    const rehearsalEnv = (overrides: Record<string, string> = {}) => ({
      GITHUB_REPOSITORY: COMMISSIONING_REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/staging", GITHUB_SHA: WORKFLOW_SHA,
      GITHUB_WORKFLOW_REF: `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@refs/heads/staging`,
      GITHUB_RUN_ID: "88001", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "transport-rehearsal",
      GITHUB_TOKEN: "rehearsal-token", COMMISSIONING_MODE: "transport-rehearsal",
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID), COMMISSIONING_REPOSITORY_ID: String(REPOSITORY_ID),
      COMMISSIONING_EVIDENCE_DIR: evidenceDir, ...overrides,
    } as unknown as NodeJS.ProcessEnv);
    const deps = (github: ReturnType<typeof createFakeGitHub>) => ({ fetchImpl: github.fetchImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 });

    // A rehearsal source run by `wrong-user` (#42) was PREPARED and ACCEPTED. It is inert and
    // produces no verdict — but it is still the measurement root asks for before staging protected
    // approvals, and evidence about somebody else's transport is not that measurement.
    const wrongActor = createFakeGitHub();
    wrongActor.registerRehearsalRun(88001);
    wrongActor.rehearsalRuns.set(88001, { ...wrongActor.rehearsalRuns.get(88001), actor: { login: "wrong-user", id: 42, type: "User" } });
    await expect(runRehearsalStage({ stage: "challenge", env: rehearsalEnv(), deps: deps(wrongActor) }))
      .rejects.toThrow(/rehearsal source run's measured actor is not the one authorized local identity/);

    // A RE-RUN. A rehearsal is measured on the first attempt, never on attempt 2.
    const rerun = createFakeGitHub();
    rerun.registerRehearsalRun(88002);
    rerun.rehearsalRuns.set(88002, { ...rerun.rehearsalRuns.get(88002), run_attempt: 2 });
    await expect(runRehearsalStage({ stage: "challenge", env: rehearsalEnv({ GITHUB_RUN_ID: "88002" }), deps: deps(rerun) }))
      .rejects.toThrow(/rehearsal source run is attempt 2/);
  });

  it("F12 · keeps the red, missing and wrong-producer check cases independently falsifiable", () => {
    const contexts = derivedContextNames(RUN_ID, ATTEMPT);
    const last = contexts.length - 1;
    const rows = (mutate: (row: Record<string, unknown>, ordinal: number) => Record<string, unknown>) =>
      contexts.map((name, ordinal) => mutate({ ordinal, name, present: true, status: "completed", conclusion: "success", app_id: NORMAL_APP, duplicates: 1 }, ordinal));
    const evaluate = (list: unknown[], expectation: string) =>
      evaluateCheckState(list as never, { runId: RUN_ID, attempt: ATTEMPT, expectation, normalAppId: NORMAL_APP });

    // The RED case, correctly produced by the EXPECTED producer: no problems.
    const genuineRed = rows((row, ordinal) => (ordinal === last ? { ...row, conclusion: "failure" } : row));
    expect(evaluate(genuineRed, "one-required-check-failed")).toEqual([]);
    /**
     * THE DEFECT: a failure from the WRONG producer satisfied `one-required-check-failed`, so the
     * denial that followed could equally be explained by the expected producer being ABSENT — which
     * is the separate missing-check case. Both runtime and offline evaluators had the omission,
     * because both had their own copy of the ladder.
     */
    const wrongProducerRed = rows((row, ordinal) => (ordinal === last ? { ...row, conclusion: "failure", app_id: ACTIONS_APP } : row));
    expect(evaluate(wrongProducerRed, "one-required-check-failed")).toContain(
      "did not measure the context the case requires to have failed as a completed failure FROM THE EXPECTED PRODUCER",
    );
    // The offline gate reaches the SAME verdict, because it is the same evaluator.
    expect(recomputeCheckState(
      { expectation: "one-required-check-failed", measured: true, contexts: wrongProducerRed },
      { runId: RUN_ID, attempt: ATTEMPT, expectation: "one-required-check-failed", normalAppId: NORMAL_APP },
    )).toContain("did not measure the context the case requires to have failed as a completed failure FROM THE EXPECTED PRODUCER");
    // A red that is not COMPLETED is not a completed failure either.
    expect(evaluate(rows((row, ordinal) => (ordinal === last ? { ...row, status: "in_progress", conclusion: "failure" } : row)), "one-required-check-failed").length).toBeGreaterThan(0);
    // A DUPLICATE listing makes the state depend on listing order, which is unmeasurable.
    expect(evaluate(rows((row, ordinal) => (ordinal === last ? { ...row, conclusion: "failure", duplicates: 2 } : row)), "one-required-check-failed"))
      .toContain(`measured 2 check runs for context ordinal ${last}; a duplicate listing makes the state ambiguous`);
  });

  it("F12 · refuses the red case at RUNTIME when the failure came from the wrong producer", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    const env = cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    await runNormalCheckPublication({ env, deps: cloudDeps(github) });
    await runCase(github, "normal", CLOUD_CASE_SEQUENCE.normal[0]);
    // The failing check on N2 is re-attributed to the GitHub Actions app, with everything else
    // green from the normal App — the shape the reproduction accepted as `one-required-check-failed`.
    for (const runs of github.checks.values()) {
      for (const run of runs) if (run.conclusion === "failure") run.app = { id: ACTIONS_APP };
    }
    await expect(runCaseStage({
      stage: "prepare", caseId: "normal-update-failed-check", env,
      deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl },
    })).rejects.toThrow(/FROM THE EXPECTED PRODUCER/);
  });

  it("F12 · binds a recorded check state to the EXACT commit the case requested", () => {
    /**
     * A per-context measurement is only about a case if it was taken on the commit that case
     * requested. The four `N*` synthetic nodes deliberately carry DIFFERENT check states — that is
     * what makes the missing, red and wrong-producer cases separable — so a green measurement of
     * some other node is a green measurement of the wrong subject.
     */
    const contexts = derivedContextNames(RUN_ID, ATTEMPT);
    const allGreen = contexts.map((name, ordinal) => ({ ordinal, name, present: true, status: "completed", conclusion: "success", app_id: NORMAL_APP, duplicates: 1 }));
    const requested = sha("N4");
    const state = { expectation: "all-green-expected-producer", measured: true, head_sha: requested, contexts: allGreen };
    expect(recomputeCheckState(state, { runId: RUN_ID, attempt: ATTEMPT, expectation: "all-green-expected-producer", normalAppId: NORMAL_APP, headSha: requested })).toEqual([]);
    expect(recomputeCheckState({ ...state, head_sha: sha("some other node") }, { runId: RUN_ID, attempt: ATTEMPT, expectation: "all-green-expected-producer", normalAppId: NORMAL_APP, headSha: requested }))
      .toContain(`records a check state measured on ${JSON.stringify(sha("some other node"))} rather than on the commit this case requested`);
    const { head_sha: _dropped, ...withoutCommit } = state;
    expect(recomputeCheckState(withoutCommit, { runId: RUN_ID, attempt: ATTEMPT, expectation: "all-green-expected-producer", normalAppId: NORMAL_APP, headSha: requested }))
      .toContain('records a check state measured on "no commit" rather than on the commit this case requested');
  });

  it("F13 · proves collision absence over the COMPLETE inventory, not over page one", async () => {
    const colliding = derivedRulesetName(RUN_ID, ATTEMPT, "normal", "main-integrity");
    const seen: string[] = [];
    const request = Object.assign(async (_method: string, requestPath: string) => {
      seen.push(requestPath);
      if (/\/git\/ref\/heads\//.test(requestPath)) return { status: 404, body: null };
      // `[?&]` matters: `/page=(\d+)/` alone matches inside `per_page=100` and reads every request
      // as page 100, which would make this stub answer page 2's body to page 1's request.
      const page = Number(/[?&]page=(\d+)/.exec(requestPath)?.[1] ?? 1);
      // A hundred unrelated rulesets on page 1, and the exact derived name on page 2.
      if (page === 1) return { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, name: `unrelated-${index}` })) };
      return { status: 200, body: [{ id: 2000, name: colliding }] };
    }, { issued: [] as string[] });
    await expect(assertNoCollision({ request, ctx: { runId: RUN_ID, attempt: ATTEMPT } }))
      .rejects.toThrow(new RegExp(`a ruleset named ${colliding} already exists`));
    expect(seen.some((requestPath) => /rulesets\?per_page=100&page=2/.test(requestPath)), "page 2 was never read").toBe(true);
  });

  it("F14 · refuses a CLOUD actor case on the direct path, and an unsuccessful predecessor", async () => {
    /**
     * The fixed CLI phases route a cloud case through the staged machinery — role/job admission, a
     * fresh witness, a just-in-time token with its own proof, a durable once-only marker. These
     * older exported functions still accepted a normal or emergency case and issued the mutation
     * with none of it: a direct exported emergency case returned `accepted` with ZERO witness
     * artifacts.
     */
    const request = Object.assign(async () => ({ status: 200, body: null }), { issued: [] as string[] });
    const ctx = { runId: RUN_ID, attempt: ATTEMPT, role: "local" };
    for (const kase of buildActorMatrix().filter((entry) => entry.actor !== "human")) {
      await expect(runActorCase({ request, kase, ctx, graphShas: {}, journal: null }), kase.id)
        .rejects.toThrow(/may not execute directly: a cloud actor case runs only through the admitted staged path/);
    }
    for (const actor of ["normal", "emergency"]) {
      await expect(runActorCases({ request, actor, ctx, graphShas: {}, journal: null }), actor)
        .rejects.toThrow(/run only through the admitted staged cloud path/);
    }
    // The direct path remains the LEGITIMATE local-human one, and it refuses a cloud role context.
    const human = buildActorMatrix().find((entry) => entry.actor === "human")!;
    await expect(runActorCase({ request, kase: human, ctx: { ...ctx, role: "normal" }, graphShas: {}, journal: null }))
      .rejects.toThrow(/runs only in the verified local operator's process/);

    // A GENUINELY SUCCESSFUL predecessor. Finalization writes finalized state and THEN throws for
    // an inconclusive, non-halting verdict — so `finalized` plus "not halted" was satisfied by a
    // case that established nothing, and the next case ran against a ref state nobody had set.
    const store = openCaseStateStore({ dir: cloudDir("state"), runId: RUN_ID, attempt: ATTEMPT, role: "normal" });
    store.write(CLOUD_CASE_SEQUENCE.normal[0], {
      stage: "await-and-finalize", status: "finalized", halt: false,
      record: { case: CLOUD_CASE_SEQUENCE.normal[0], outcome: "inconclusive", passed: false },
    });
    expect(() => store.assertPriorCasesFinalized(CLOUD_CASE_SEQUENCE.normal[1]))
      .toThrow(/recorded "inconclusive" rather than its expected result/);
    store.write(CLOUD_CASE_SEQUENCE.normal[0], {
      stage: "await-and-finalize", status: "finalized", halt: false,
      record: { case: CLOUD_CASE_SEQUENCE.normal[0], outcome: "denied", passed: true },
    });
    expect(store.assertPriorCasesFinalized(CLOUD_CASE_SEQUENCE.normal[1])).toBe(true);
  });
});

/**
 * ── CORRECTION PASS 4 — the independently reproduced adoption / publication / assessment gaps ─────
 *
 * Every case here reproduces ONE defect the independent driver observed at `3c7d2819`, ISOLATED to a
 * single invariant. The driver's own scenarios deliberately combined several mutations at once, so
 * they proved that *something* in each group was unchecked without establishing which component was
 * accepted alone. These do establish that, and each one starts from a packet that PASSES.
 *
 * The accepted obligations they encode are in `AIO-1124-3c7d2819-ACCEPTED-caller-obligations.md`.
 * None of this is independent review, and none of it is evidence of live enforcement.
 */
describe("correction pass 4 — every first fingerprint proves the measured GET body", () => {
  /**
   * A transport that rewrites the provider's answer to a GET of one of THIS RUN'S rulesets.
   *
   * The mutation is applied to the readback only — the POST still succeeds and still returns its
   * identity — because "a successful 201 does not prove the later GET body" is precisely the claim.
   */
  const readbackTransport = (
    github: ReturnType<typeof createFakeGitHub>,
    mutate: (body: Record<string, unknown>) => Record<string, unknown> | null,
    options: { failFirstGet?: boolean; loseFirstPost?: boolean } = {},
  ) => {
    let failedOnce = false;
    let lostOnce = false;
    return async (method: string, url: string, body?: unknown) => {
      const rel = url.split("?")[0];
      if (options.loseFirstPost && method === "POST" && rel.endsWith("/rulesets") && !lostOnce) {
        lostOnce = true;
        // A transport timeout AFTER the provider committed: the ruleset exists, the response is gone.
        github.handle("local", method, url, body);
        return lostResponse();
      }
      const response = github.handle("local", method, url, body);
      if (method !== "GET" || !/\/rulesets\/\d+$/.test(rel) || response.status !== 200) return wire(response);
      if (!String((response.body as Record<string, unknown>)?.name ?? "").startsWith("commissioning-")) return wire(response);
      if (options.failFirstGet && !failedOnce) {
        failedOnce = true;
        return wire({ status: 503, body: { message: "Service Unavailable" } });
      }
      const mutated = mutate(structuredClone(response.body) as Record<string, unknown>);
      return wire(mutated === null ? response : { ...response, body: mutated });
    };
  };

  /** Empty a ruleset's rules — the driver's "changed body", reduced to one field. */
  const emptyRules = (only: string) => (rulesetBody: Record<string, unknown>) =>
    String(rulesetBody.name).includes(only) ? { ...rulesetBody, rules: [] } : null;

  /** Add ONE governed parameter to the `update` rule, at the given value. */
  const addUpdateParameter = (value: boolean) => (rulesetBody: Record<string, unknown>) => {
    if (!String(rulesetBody.name).includes("main-release-writer")) return null;
    const rules = (rulesetBody.rules as Record<string, unknown>[]).map((rule) =>
      rule.type === "update" ? { ...rule, parameters: { update_allows_fetch_and_merge: value } } : rule);
    return { ...rulesetBody, rules };
  };

  /** Reorder a ruleset body's KEYS without changing a single value. */
  const reorderKeys = (rulesetBody: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(rulesetBody).sort().reverse().map((key) => [key, rulesetBody[key]]));

  const setupWith = async (transport: unknown) => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const outcome = await runPhase({
      phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport },
    }).then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
    return { github, outcome };
  };

  const journalOf = () => readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
  const fingerprintedNames = () => journalOf()
    .filter((record) => record.type === "resource-fingerprinted")
    .map((record) => String((record.data as Record<string, unknown>).key));
  const ownershipGaps = () => journalOf()
    .filter((record) => record.type === "reconciliation" && String((record.data as Record<string, unknown>).outcome) === "ownership-unprovable");

  it("O1 · a successful 201 followed by a CHANGED 200 readback is not adopted", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const transport = readbackTransport(github, emptyRules("main-integrity"));
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport } }))
      .rejects.toThrow(/intended|ownership/i);
    // The identity is RETAINED — the resource exists and cleanup must be able to name it — but no
    // fingerprint was adopted from the body that could not be proved.
    expect(journalOf().some((record) => record.type === "resource-created"
      && (record.data as Record<string, unknown>).kind === "ruleset"), "the created ID must be retained").toBe(true);
    expect(fingerprintedNames().some((name) => name.includes("main-integrity")), "a changed body was fingerprinted").toBe(false);
    expect(ownershipGaps().length, "no ownership gap was journaled").toBeGreaterThan(0);
  });

  it("O2 · a successful 201 followed by a SEMANTIC ADDITION (update_allows_fetch_and_merge:true) is not adopted", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const transport = readbackTransport(github, addUpdateParameter(true));
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport } }))
      .rejects.toThrow(/intended|ownership|verifier/i);
    expect(fingerprintedNames().some((name) => name.includes("main-release-writer")), "a semantically-added parameter was adopted").toBe(false);
  });

  it("O3 · an added field AT ITS PROVIDER DEFAULT is refused and named as a gap, never silently adopted", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const transport = readbackTransport(github, addUpdateParameter(false));
    // PC-04: report the concrete provider-normalization gap; never loosen the verifier to absorb it.
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport } }))
      .rejects.toThrow(/intended|ownership|normalization|verifier/i);
    expect(fingerprintedNames().some((name) => name.includes("main-release-writer")), "an added default was adopted").toBe(false);
  });

  it("O4 · a successful 201, a 503 readback, then a CHANGED recovery GET is not adopted on resume", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    // First setup: the create is durable, the fingerprint readback fails.
    await expect(runPhase({
      phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: readbackTransport(github, () => null, { failFirstGet: true }) },
    })).rejects.toThrow();
    const created = journalOf().filter((record) => record.type === "resource-created"
      && (record.data as Record<string, unknown>).kind === "ruleset");
    expect(created.length, "the durable create must be retained across the failed readback").toBeGreaterThan(0);
    // The resume then measures a body that is NOT the intended one.
    await expect(runPhase({
      phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: readbackTransport(github, emptyRules("commissioning-")) },
    })).rejects.toThrow(/intended|ownership/i);
    expect(ownershipGaps().length, "the resume adopted an unproven body").toBeGreaterThan(0);
  });

  it("O5 · a LOST create response followed by a changed same-name ruleset is neither adopted nor deleted", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const transport = readbackTransport(github, () => null, { loseFirstPost: true });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport } }))
      .rejects.toThrow();
    // Somebody edits the created ruleset between the lost response and the cleanup.
    const orphan = [...github.rulesets.values()].find((entry) => String(entry.name).startsWith("commissioning-"))!;
    orphan.rules = [];
    const before = github.rulesets.size;
    await expect(runPhase({
      phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: readbackTransport(github, () => null) },
    })).rejects.toThrow();
    expect(github.rulesets.has(orphan.id), "cleanup deleted a ruleset whose body it could not prove").toBe(true);
    expect(github.rulesets.size).toBe(before);
  });

  it("O6 · a LOST create response followed by the UNCHANGED intended body is adopted and cleaned", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    const transport = readbackTransport(github, () => null, { loseFirstPost: true });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { transport } }))
      .rejects.toThrow();
    const orphan = [...github.rulesets.values()].find((entry) => String(entry.name).startsWith("commissioning-"))!;
    const cleanup = await runPhase({
      phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { transport: readbackTransport(github, () => null) },
    });
    // The POSITIVE counterpart: the refusal above is about the CHANGE, not about reconciliation.
    expect(cleanup.status).toBe("cleaned");
    expect(github.rulesets.has(orphan.id), "a provably owned resource was left behind").toBe(false);
  });

  it("O7 · a KEY-REORDERED readback is still the intended body and is adopted", async () => {
    const { outcome } = await setupWith(readbackTransport(createFakeGitHub(), reorderKeys));
    expect(outcome.ok ? outcome.value.status : (outcome.error as Error).message).toBe("prepared");
  });
});

describe("correction pass 4 — the actual publisher reads the authenticated intent before it writes bytes", () => {
  const PUBLISHER_RUN = "77001";
  const INTENT_ARTIFACT = `policy-commissioning-intent-${RUN_ID}-${ATTEMPT}`;
  const INTENT_ENTRY = `commissioning-${RUN_ID}-${ATTEMPT}-intent.json`;
  const INTENT_ARTIFACT_ID = 6501;

  /** The real credential-free intent this run would have published, produced by the real phase. */
  async function genuineIntent() {
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    return readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "intent")) as Record<string, unknown>;
  }

  /**
   * The publisher's provider surface: its own run, the ORIGINAL run and its jobs, the intent
   * artifact listing, and the repository/source reads it already makes. Nothing else exists.
   */
  const publisherTransport = (options: {
    intentArtifacts?: { id: number; name: string; expired?: boolean; workflow_run: { id: number } }[];
    intentJobConclusion?: string;
  } = {}) => async (method: string, url: string) => {
    const rel = url.split("?")[0].replace(`/repos/${COMMISSIONING_REPOSITORY}`, "");
    const ok = (body: unknown) => wire({ status: 200, body });
    if (rel === "") return ok({ id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY, default_branch: "staging" });
    if (rel === "/git/ref/heads/staging") return ok({ object: { sha: WORKFLOW_SHA } });
    if (rel === "/actions/artifacts") {
      const rows = options.intentArtifacts ?? [{ id: INTENT_ARTIFACT_ID, name: INTENT_ARTIFACT, expired: false, workflow_run: { id: Number(RUN_ID) } }];
      const wanted = new URLSearchParams(url.split("?")[1] ?? "").get("name");
      const matching = rows.filter((row) => !wanted || row.name === wanted);
      return ok({ total_count: matching.length, artifacts: matching });
    }
    const attempt = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(rel);
    if (attempt) {
      const self = attempt[1] === PUBLISHER_RUN;
      return ok({
        id: Number(attempt[1]), head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH,
        event: "workflow_dispatch", head_branch: "staging", run_attempt: self ? 1 : Number(ATTEMPT),
        actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY, status: "completed", conclusion: "success",
      });
    }
    if (/^\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(rel)) {
      const jobs = [
        { id: 9101, name: "Commissioning intent (credential-free)", status: "completed", conclusion: options.intentJobConclusion ?? "success", run_attempt: Number(ATTEMPT) },
        { id: 9102, name: "Normal App actor tests (protected)", status: "completed", conclusion: "success", run_attempt: Number(ATTEMPT) },
      ];
      return ok({ total_count: jobs.length, jobs });
    }
    return wire({ status: 404, body: { message: "Not Found" } });
  };

  const archiveOf = (bytes: Buffer | null) => async () => (bytes
    ? { status: 200, bytes, diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false } }
    : { status: 404, bytes: null, diagnostic: { status: 404, category: "not-found", ruleIds: [], policyDenial: false } });

  /** A closed observation with its real governed digest, suitable as a one-mutation baseline. */
  const soundObservation = () => {
    const observation = validObservation() as Record<string, unknown>;
    const rulesets = observation.governed_rulesets as { governed: unknown }[];
    observation.projected_governed_digest = canonicalHash(rulesets.map((entry) => entry.governed));
    return observation;
  };

  const publisherResponse = () => {
    const challenge = buildChallenge({
      binding: WITNESS_BINDING, nonce: "d".repeat(64), createdAt: "2026-09-10T09:00:00.000Z",
      extra: { before_sha: "1".repeat(40), requested_sha: "2".repeat(40) },
    });
    return buildResponse({
      challenge, challengeDigest: "f".repeat(64), observation: soundObservation(),
      witnessIdentity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      createdAt: "2026-09-10T09:00:00.000Z",
    }) as Record<string, unknown>;
  };

  const responseObservation = (response: Record<string, unknown>) =>
    response.observation as Record<string, unknown>;

  const responseRulesets = (response: Record<string, unknown>) =>
    responseObservation(response).governed_rulesets as Record<string, unknown>[];

  /** Run the ACTUAL publisher job over one observation, with one intent, and see what it writes. */
  async function publish(observation: Record<string, unknown>, options: {
    intent?: Record<string, unknown> | null;
    transport?: ReturnType<typeof publisherTransport>;
    mutateResponse?: (response: Record<string, unknown>) => void;
  } = {}) {
    const intent = options.intent === undefined ? await genuineIntent() : options.intent;
    const dir = mkdtempSync(path.join(tmpdir(), "aio1124-pub-"));
    created.push(dir);
    const response = publisherResponse();
    response.observation = observation;
    options.mutateResponse?.(response);
    const eventPath = path.join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: { mode: "policy-witness", witness_envelope: JSON.stringify(response) } }));
    const env = cloudEnv("policy-witness", {
      GITHUB_RUN_ID: PUBLISHER_RUN, GITHUB_RUN_ATTEMPT: "1", COMMISSIONING_MODE: "policy-witness",
      COMMISSIONING_EVIDENCE_DIR: dir, GITHUB_EVENT_PATH: eventPath,
    });
    const zip = intent ? buildZip(INTENT_ENTRY, Buffer.from(`${JSON.stringify(intent)}\n`, "utf8")) : null;
    const outcome = await runWitnessPublisherJob(env, {
      metadataTransport: options.transport ?? publisherTransport(),
      archiveTransport: archiveOf(zip),
    }).then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
    const written = path.join(dir, "witness", "witness.json");
    return { outcome, bytes: existsSync(written) ? readFileSync(written, "utf8") : null };
  }

  /**
   * A governed observation the closed projection really accepts, so each case changes ONE thing.
   *
   * `validObservation` carries a PLACEHOLDER `projected_governed_digest`, which is fine for the
   * shape-only callers it was written for and useless here: every case below would refuse on the
   * digest before reaching the invariant it is about. So the digest is computed for real, and each
   * mutation recomputes it — a negative case that trips two rules proves neither.
   */
  const withDigest = (observation: Record<string, unknown>) => {
    const rulesets = observation.governed_rulesets as { governed: unknown }[];
    observation.projected_governed_digest = canonicalHash(rulesets.map((entry) => entry.governed));
    return observation;
  };

  it("P1 · an UNKNOWN nested governed field is refused, and no bytes are written", async () => {
    const observation = soundObservation() as Record<string, unknown>;
    const rulesets = observation.governed_rulesets as { governed: Record<string, unknown> }[];
    rulesets[0].governed.unknown_secret = "SYNTHETIC-NESTED-DISCLOSURE";
    const { outcome, bytes } = await publish(withDigest(observation));
    expect(outcome.ok, "the publisher published an unknown nested governed field").toBe(false);
    expect(bytes, "bytes reached the artifact").toBeNull();
  });

  it.each([
    ["unknown governed wrapper field", (response: Record<string, unknown>) => { responseRulesets(response)[0].private_data = "SYNTHETIC-DISCLOSURE"; }],
    ["object ruleset identity", (response: Record<string, unknown>) => { responseRulesets(response)[0].id = { marker: "SYNTHETIC-DISCLOSURE" }; }],
    ["object applicability page count", (response: Record<string, unknown>) => { responseObservation(response).applicability_pages = { marker: "SYNTHETIC-DISCLOSURE" }; }],
    ["object intended App identity", (response: Record<string, unknown>) => { response.intended_app_id = { marker: "SYNTHETIC-DISCLOSURE" }; }],
    ["case outside the closed sequence", (response: Record<string, unknown>) => { response.case_id = "arbitrary-case"; }],
    ["non-digest manifest identity", (response: Record<string, unknown>) => { response.manifest_sha256 = "not-a-digest"; }],
    ["array challenge nonce scalar", (response: Record<string, unknown>) => { response.challenge_nonce = ["d".repeat(64)]; }],
    ["array challenge digest scalar", (response: Record<string, unknown>) => { response.challenge_digest = ["f".repeat(64)]; }],
    ["array raw governed digest scalar", (response: Record<string, unknown>) => { responseObservation(response).raw_governed_digest = ["a".repeat(64)]; }],
  ] as const)("publication boundary refuses %s through both the public helper and full publisher job", async (_label, mutate) => {
    const response = publisherResponse();
    mutate(response);
    const envelope = JSON.stringify(response);
    let helperWrote = false;
    const originalRun = {
      id: Number(RUN_ID), path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
      head_sha: WORKFLOW_SHA, head_branch: "staging", run_attempt: Number(ATTEMPT),
      actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
    };
    expect(() => publishWitnessResponse({
      response, envelope, publisherRunId: PUBLISHER_RUN, originalRun,
      expected: {
        repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH,
        sourceSha: WORKFLOW_SHA, dispatchBranch: "staging", binding: WITNESS_BINDING,
      },
      allowed: plannedVocabulary(),
      writeEntry: () => { helperWrote = true; return "unreachable"; },
    })).toThrow();
    expect(helperWrote, "the public helper wrote malformed bytes").toBe(false);

    const { outcome, bytes } = await publish(soundObservation(), { mutateResponse: mutate });
    expect(outcome.ok, "the full publisher job accepted malformed bytes").toBe(false);
    expect(bytes, "the full publisher job wrote witness bytes").toBeNull();
  });

  it("publication boundary refuses inherited rule and parameter names through both public paths", async () => {
    const originalRun = {
      id: Number(RUN_ID), path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch",
      head_sha: WORKFLOW_SHA, head_branch: "staging", run_attempt: Number(ATTEMPT),
      actor: OWNER_IDENTITY, triggering_actor: OWNER_IDENTITY,
    };
    const expected = {
      repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH,
      sourceSha: WORKFLOW_SHA, dispatchBranch: "staging", binding: WITNESS_BINDING,
    };
    const assertHelperRefuses = (response: Record<string, unknown>) => {
      let wrote = false;
      expect(() => publishWitnessResponse({
        response, envelope: JSON.stringify(response), publisherRunId: PUBLISHER_RUN, originalRun,
        expected, allowed: plannedVocabulary(), writeEntry: () => { wrote = true; return "unreachable"; },
      })).toThrow(/ungoverned rule type|ungoverned parameter/);
      expect(wrote, "the public helper wrote a prototype-key mutation").toBe(false);
    };

    for (const inherited of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
      const response = publisherResponse();
      const observation = responseObservation(response);
      const governed = responseRulesets(response)[0].governed as Record<string, unknown>;
      governed.rules = [{ type: inherited }];
      withDigest(observation);
      assertHelperRefuses(response);

      const { outcome, bytes } = await publish(soundObservation(), { mutateResponse: (candidate) => {
        const candidateObservation = responseObservation(candidate);
        const candidateGoverned = responseRulesets(candidate)[0].governed as Record<string, unknown>;
        candidateGoverned.rules = [{ type: inherited }];
        withDigest(candidateObservation);
      }});
      expect(outcome.ok, `the full publisher job accepted inherited rule type ${inherited}`).toBe(false);
      expect(bytes, `the full publisher job wrote inherited rule type ${inherited}`).toBeNull();
    }

    for (const inherited of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
      const response = publisherResponse();
      const observation = responseObservation(response);
      const governed = responseRulesets(response)[0].governed as Record<string, unknown>;
      governed.rules = [{ type: "update", parameters: { [inherited]: true } }];
      withDigest(observation);
      assertHelperRefuses(response);

      const { outcome, bytes } = await publish(soundObservation(), { mutateResponse: (candidate) => {
        const candidateObservation = responseObservation(candidate);
        const candidateGoverned = responseRulesets(candidate)[0].governed as Record<string, unknown>;
        candidateGoverned.rules = [{ type: "update", parameters: { [inherited]: true } }];
        withDigest(candidateObservation);
      }});
      expect(outcome.ok, `the full publisher job accepted inherited parameter ${inherited}`).toBe(false);
      expect(bytes, `the full publisher job wrote inherited parameter ${inherited}`).toBeNull();
    }

    const control = publisherResponse();
    let helperWrites = 0;
    expect(publishWitnessResponse({
      response: control, envelope: JSON.stringify(control), publisherRunId: PUBLISHER_RUN, originalRun,
      expected, allowed: plannedVocabulary(), writeEntry: () => { helperWrites += 1; return "/tmp/witness.json"; },
    }).status).toBe("published");
    expect(helperWrites).toBe(1);
    const fullControl = await publish(soundObservation());
    expect(fullControl.outcome.ok ? fullControl.outcome.value.status : fullControl.outcome.error.message).toBe("published");
    expect(fullControl.bytes).not.toBeNull();
  });

  it("P2 · an UNAPPROVED source identity is refused", async () => {
    const observation = soundObservation() as Record<string, unknown>;
    observation.source_identities = ["SYNTHETIC-UNAPPROVED-SOURCE"];
    const { outcome, bytes } = await publish(observation);
    expect(outcome.ok, "the publisher published an unapproved source identity").toBe(false);
    expect(bytes).toBeNull();
  });

  it("P3 · arbitrary CLASSIC protection data is refused", async () => {
    const observation = soundObservation() as Record<string, unknown>;
    observation.classic_protection = { present: false, status: 404, arbitrary: "SYNTHETIC-CLASSIC-DATA" };
    const { outcome, bytes } = await publish(observation);
    expect(outcome.ok, "the publisher published arbitrary classic protection data").toBe(false);
    expect(bytes).toBeNull();
  });

  it("P4 · a bypass App the AUTHENTICATED INTENT does not name is refused, however positive its ID", async () => {
    const observation = soundObservation() as Record<string, unknown>;
    const rulesets = observation.governed_rulesets as { governed: Record<string, unknown> }[];
    // A perfectly well-formed, positive, safe integer — and not one of this run's planned Apps.
    rulesets[0].governed.bypass_actors = [{ actor_type: "Integration", actor_id: 424242, bypass_mode: "always" }];
    const { outcome, bytes } = await publish(withDigest(observation));
    expect(outcome.ok, "an arbitrary positive App ID was accepted as a bypass identity").toBe(false);
    expect(bytes).toBeNull();
  });

  it("P5 · a sound observation with the planned identities IS published", async () => {
    const observation = soundObservation() as Record<string, unknown>;
    const rulesets = observation.governed_rulesets as { governed: Record<string, unknown> }[];
    rulesets[0].governed.bypass_actors = [{ actor_type: "Integration", actor_id: NORMAL_APP, bypass_mode: "always" }];
    const { outcome, bytes } = await publish(withDigest(observation));
    expect(outcome.ok ? outcome.value.status : (outcome.error as Error).message).toBe("published");
    expect(bytes, "a valid publication wrote nothing").not.toBeNull();
  });

  it("P6 · a MISSING intent artifact refuses; it never falls back to unvalidated publication", async () => {
    const { outcome, bytes } = await publish(soundObservation() as Record<string, unknown>, {
      transport: publisherTransport({ intentArtifacts: [] }),
    });
    expect(outcome.ok, "the publisher published without the authenticated intent").toBe(false);
    expect(bytes).toBeNull();
  });

  it("P7 · a DUPLICATE intent artifact under the exact name refuses rather than selecting one", async () => {
    const { outcome, bytes } = await publish(soundObservation() as Record<string, unknown>, {
      transport: publisherTransport({
        intentArtifacts: [
          { id: INTENT_ARTIFACT_ID, name: INTENT_ARTIFACT, expired: false, workflow_run: { id: Number(RUN_ID) } },
          { id: INTENT_ARTIFACT_ID + 1, name: INTENT_ARTIFACT, expired: false, workflow_run: { id: Number(RUN_ID) } },
        ],
      }),
    });
    expect(outcome.ok, "the publisher selected between duplicate intent artifacts").toBe(false);
    expect(bytes).toBeNull();
  });

  it("P8 · an intent job that did NOT succeed in the original attempt refuses", async () => {
    const { outcome, bytes } = await publish(soundObservation() as Record<string, unknown>, {
      transport: publisherTransport({ intentJobConclusion: "failure" }),
    });
    expect(outcome.ok, "the publisher trusted an intent artifact whose job failed").toBe(false);
    expect(bytes).toBeNull();
  });
});

describe("correction pass 4 — the final assessment reconstructs each case, and does not read it", () => {
  const evidenceFile = (key: string) => path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key));
  const write = (key: string, payload: unknown) =>
    writeFileSync(evidenceFile(key), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const blockersOf = () => assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];

  async function validPacket() {
    const github = createFakeGitHub();
    await commissionEverything(github);
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    environmentControls(evidenceDir);
    return github;
  }

  /**
   * ONE mutation at a time, always from a packet that passes.
   *
   * The independent driver bundled nine per-case mutations into a single scenario, so its zero-blocker
   * result proved only that the bundle was unchecked. Each row below is one field.
   */
  it("C · each per-case identity, provenance and timing corruption is a blocker on its own", async () => {
    await validPacket();
    expect(blockersOf(), "the packet under test does not pass to begin with").toEqual([]);

    const genuine = { normal: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal")) };
    const restore = () => write("normal", genuine.normal);
    const mutateCases = (mutate: (record: Record<string, unknown>) => Record<string, unknown>) =>
      write("normal", { ...genuine.normal, cases: (genuine.normal.cases as Record<string, unknown>[]).map((record) => mutate(structuredClone(record))) });
    const inWitness = (mutate: (witness: Record<string, unknown>) => void) => () => mutateCases((record) => {
      mutate(record.witness as Record<string, unknown>);
      return record;
    });

    const cases: [string, () => void, RegExp][] = [
      ["a mutation start time far in the future", () => mutateCases((record) => ({ ...record, mutation_started_at: "2099-01-01T00:00:00Z" })),
        /mutation|interval|timing|ordering|proximity/i],
      ["a readback time before the mutation", () => mutateCases((record) => ({ ...record, readback_at: "2000-01-01T00:00:00Z" })),
        /readback|interval|timing|ordering/i],
      ["a pre-challenge lifetime that is not this run's", inWitness((witness) => {
        witness.pre_challenge_created_at = "2000-01-01T00:00:00Z";
        witness.pre_challenge_expires_at = "2000-01-01T00:03:00Z";
      }), /challenge|expiry|lifetime|binding/i],
      ["a source that moved under the case", () => mutateCases((record) => ({
        ...record, source_continuity: { pre: { measured: true, moved: true }, post: { measured: true, moved: true } },
      })), /source|continuity|moved/i],
      ["the pre publisher run identity removed", inWitness((witness) => { delete witness.pre_publisher_run_id; }),
        /publisher run|provenance/i],
      ["the retained pre publisher provenance facts removed", inWitness((witness) => {
        // The corrected build reconstructs provenance from the retained artifact/run/jobs FACTS, so
        // this removes the evidence rather than the conclusion drawn from it.
        delete witness.pre_provenance_facts;
      }), /provenance|publisher/i],
      ["a scoped read that was refused", () => mutateCases((record) => ({
        ...record, token_proof: { ...(record.token_proof as Record<string, unknown>), scoped_read: { status: 403 } },
      })), /scoped read|scoped_read/i],
      ["an installation the plan does not name", () => mutateCases((record) => ({
        ...record, grants: { ...(record.grants as Record<string, unknown>), installation_id: "999999" },
      })), /installation/i],
      ["a grant whose installation App is not its App", () => mutateCases((record) => ({
        ...record, grants: { ...(record.grants as Record<string, unknown>), installation_app_id: 999999 },
      })), /installation|App/i],
      ["a case-level installation the plan does not name", () => mutateCases((record) => ({ ...record, installation_id: "888888" })),
        /installation/i],
      ["one extra governed update parameter, with its projection digest recomputed", () => mutateCases((record) => {
        const witness = record.witness as Record<string, unknown>;
        for (const direction of ["pre_observation", "post_observation"]) {
          const observation = witness[direction] as Record<string, unknown>;
          const rulesets = observation.governed_rulesets as { governed: { name: string; rules: Record<string, unknown>[] } }[];
          const writer = rulesets.find((entry) => entry.governed.name.endsWith("main-release-writer"));
          if (writer) writer.governed.rules[0].parameters = { update_allows_fetch_and_merge: true };
          observation.projected_governed_digest = canonicalHash(rulesets.map((entry) => entry.governed));
        }
        return record;
      }), /policy|verifier|governed|intended/i],
    ];

    const failures: string[] = [];
    for (const [label, mutate, expected] of cases) {
      restore();
      expect(blockersOf(), `${label}: the restored packet should pass`).toEqual([]);
      mutate();
      const blockers = blockersOf();
      if (!blockers.length) { failures.push(`${label}: NO blocker`); continue; }
      const detail = blockers.map((entry) => entry.detail).join("\n");
      if (!expected.test(detail)) failures.push(`${label}: blocked for the wrong reason — ${detail.slice(0, 200)}`);
    }
    restore();
    expect(blockersOf()).toEqual([]);
    expect(failures.join("\n") || "none").toBe("none");
  });

  it("S · each setup and journal corruption is a blocker on its own", async () => {
    await validPacket();
    expect(blockersOf(), "the packet under test does not pass to begin with").toEqual([]);

    const genuine = {
      setup: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "setup")),
      normal: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal")),
      emergency: readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "emergency")),
    };
    const witnessJournal = journalPath(evidenceDir, RUN_ID, ATTEMPT, "witness");
    const witnessBytes = readFileSync(witnessJournal);
    const restore = () => {
      write("setup", genuine.setup);
      write("normal", genuine.normal);
      write("emergency", genuine.emergency);
      writeFileSync(witnessJournal, witnessBytes, { mode: 0o600 });
    };

    /** Rebuild the witness chain so it VERIFIES, with exactly one property changed. */
    const rebuildWitnessJournal = (options: { source?: string; drop?: string[] }) => {
      const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
      rmSync(witnessJournal, { force: true });
      const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
      try {
        const journal = openJournal({
          dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness",
          source: options.source ?? WORKFLOW_SHA, lock,
        });
        for (const record of records) {
          if ((options.drop ?? []).includes(String(record.type))) continue;
          journal.append(String(record.type), record.data);
        }
      } finally { lock.release(); }
    };

    /** A fabricated manifest digest, propagated so cross-copy equality alone stays silent. */
    const fabricateManifestDigest = () => {
      const digest = "f".repeat(64);
      write("setup", { ...genuine.setup, manifest_sha256: digest });
      for (const role of ["normal", "emergency"] as const) {
        const file = structuredClone(genuine[role]) as Record<string, unknown>;
        file.manifest_sha256 = digest;
        file.cases = (file.cases as Record<string, unknown>[]).map((record) => ({ ...record, manifest_sha256: digest }));
        write(role, file);
      }
    };

    const cases: [string, () => void, RegExp][] = [
      ["a production policy hash that is not a digest at all", () => write("setup", { ...genuine.setup, production_policy_hash: "invalid" }),
        /production|policy hash|reconstruct/i],
      ["a fabricated manifest digest, consistently propagated", fabricateManifestDigest,
        /manifest|reconstruct/i],
      ["an intent re-measurement reduced to a boolean", () => write("setup", { ...genuine.setup, intent_remeasured: { confirmed: true } }),
        /re-measur|remeasur|intent/i],
      ["an empty protected-job snapshot", () => write("setup", { ...genuine.setup, protected_jobs_at_setup: {} }),
        /protected job/i],
      ["a witness chain rebuilt under a source this run never ran", () => rebuildWitnessJournal({ source: "e".repeat(40) }),
        /source/i],
      ["a witness chain with every dispatch record removed", () => rebuildWitnessJournal({ drop: ["dispatch-intent", "dispatch-result"] }),
        /dispatch/i],
    ];

    const failures: string[] = [];
    for (const [label, mutate, expected] of cases) {
      restore();
      expect(blockersOf(), `${label}: the restored packet should pass`).toEqual([]);
      mutate();
      const blockers = blockersOf();
      if (!blockers.length) { failures.push(`${label}: NO blocker`); continue; }
      const detail = blockers.map((entry) => entry.detail).join("\n");
      if (!expected.test(detail)) failures.push(`${label}: blocked for the wrong reason — ${detail.slice(0, 200)}`);
    }
    restore();
    expect(blockersOf()).toEqual([]);
    expect(failures.join("\n") || "none").toBe("none");
  });
});

/**
 * ── CORRECTION PASS 4 (clock) — the corrected baseline runs on a COHERENT clock ──────────────────
 *
 * The retained review driver stamped its "valid" environment controls **2099**, and the packet
 * passed. That is evidence of the unfixed candidate, not a corrected baseline: the canonical forbids
 * future and impossible ordering and forbids stale-or-false environment evidence, and a control
 * captured after the run it claims to describe is exactly as unmoored as one captured before it.
 *
 * So the valid packet below runs on an explicit, monotonic test clock with real phase, control and
 * approval times, and each refusal case moves ONE of those times out of coherence.
 */
describe("correction pass 4 — future and contradictory times are refused, on an explicit coherent clock", () => {
  const write = (key: string, payload: unknown) =>
    writeFileSync(path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key)), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const blockersOf = () => assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers as Blocker[];

  it("K0 · the coherent packet passes, and it does NOT rely on a future control date", async () => {
    const { clock } = await coherentPacket();
    expect(blockersOf(), "the coherent-clock packet does not pass").toEqual([]);
    const controls = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment")) as Record<string, unknown>;
    const stamps = Object.values(controls.controls as Record<string, Record<string, { measured_at: string }>>)
      .flatMap((perEnvironment) => Object.values(perEnvironment).map((record) => record.measured_at));
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect(Date.parse(stamp), `control stamped ${stamp} is not inside the run`).toBeLessThanOrEqual(Date.parse(clock.peek()) + 1000);
      expect(new Date(stamp).getUTCFullYear(), "a corrected baseline must not be dated in the future").toBeLessThan(2030);
    }
  });

  it("K1 · a control captured AFTER the run it describes is refused", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    // The reviewer's own 2099 stamp, isolated to exactly one control on one environment.
    const controls = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment")) as Record<string, unknown>;
    const map = controls.controls as Record<string, Record<string, Record<string, unknown>>>;
    const key = Object.keys(map)[0];
    const environment = Object.keys(map[key])[0];
    map[key][environment].measured_at = "2099-01-01T00:00:00.000Z";
    write("environment", controls);
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "a control dated 2099 produced no blocker").not.toBe("");
    expect(detail).toMatch(/after this run|future|window/i);
  });

  it("K2 · an approval recorded AFTER the run it approves is refused", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    const approvals = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals")) as Record<string, unknown>;
    const environments = approvals.environments as Record<string, { reviewers: Record<string, unknown>[] }>;
    for (const environment of Object.values(environments)) {
      for (const reviewer of environment.reviewers) reviewer.approved_at = "2099-01-01T00:00:00.000Z";
    }
    write("approvals", approvals);
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "an approval dated 2099 produced no blocker").not.toBe("");
    expect(detail).toMatch(/approval|approved_at|after this run|future|window/i);
  });

  it("K3 · a phase collected BEFORE the cases it reports on is a contradictory phase time", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    const approvals = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals")) as Record<string, unknown>;
    // `collect` runs AFTER the protected actor phases. A collection time that precedes the first
    // case's measured mutation describes an ordering that did not happen.
    approvals.collected_at = "2026-09-10T08:00:00.000Z";
    write("approvals", approvals);
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "a collection time before the cases produced no blocker").not.toBe("");
    expect(detail).toMatch(/collect|ordering|before|phase/i);
  });
});

/**
 * ── CORRECTION PASS 5 — the dispatch→bytes→entry→nonce join, and the once-only transition ────────
 *
 * Two obligations root attached to accepting the once-only transition:
 *
 *  1. The final assessment must independently JOIN the dispatch envelope digest to the ACTUAL
 *     retained response bytes, their entry digest, and the challenge nonce. Repeated hash
 *     declarations are not that join, and an unknown or changed byte stream must refuse even when
 *     the parsed response objects look equivalent.
 *  2. The retained historical `received_at` is REQUIRED. A response's CREATION and its RECEIPT are
 *     distinct measured events, so substituting one for the other is not a fallback — it is a
 *     different claim. A missing receipt is incomplete, and an already-valid historical packet must
 *     assess without consulting the wall clock.
 */
describe("correction pass 5 — the dispatch/bytes/receipt join and the once-only journal transition", () => {
  const write = (key: string, payload: unknown) =>
    writeFileSync(path.join(evidenceDir, evidenceFileName(RUN_ID, ATTEMPT, key)), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const blockersOf = (now?: () => Date) =>
    assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, ...(now ? { now } : {}) }).blockers as Blocker[];
  const witnessJournalPath = () => journalPath(evidenceDir, RUN_ID, ATTEMPT, "witness");

  /** Rebuild the witness chain so its hash links VERIFY, with one record's data rewritten. */
  const rebuildWitnessJournal = (mutate: (record: { type: string; data: Record<string, unknown> }) => { type: string; data: Record<string, unknown> } | null) => {
    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    rmSync(witnessJournalPath(), { force: true });
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness", source: WORKFLOW_SHA, lock });
      for (const record of records) {
        const next = mutate({ type: String(record.type), data: record.data as Record<string, unknown> });
        if (!next) continue;
        journal.append(next.type, next.data);
      }
    } finally { lock.release(); }
  };

  const firstNormalCase = () => CLOUD_CASE_SEQUENCE.normal[0];

  it("R1 · a case with NO retained receipt is incomplete; its creation time is not its receipt", async () => {
    await coherentPacket();
    expect(blockersOf(), "the coherent packet does not pass").toEqual([]);
    const normal = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    write("normal", {
      ...normal,
      cases: (normal.cases as Record<string, unknown>[]).map((record) => {
        const witness = { ...(record.witness as Record<string, unknown>) };
        delete witness.pre_received_at;
        return { ...record, witness };
      }),
    });
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "a missing receipt produced no blocker").not.toBe("");
    expect(detail).toMatch(/receipt|received_at/i);
  });

  it("R2 · a dispatch envelope digest that does not describe the published bytes refuses", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    // ONE invariant: the dispatch record's envelope digest, rebuilt into a correctly chained journal.
    rebuildWitnessJournal((record) => (record.type === "dispatch-intent" && String(record.data.case_id) === firstNormalCase()
      ? { ...record, data: { ...record.data, envelope_digest: "b".repeat(64) } }
      : record));
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "a wrong dispatch envelope digest produced no blocker").not.toBe("");
    expect(detail).toMatch(/dispatch|envelope/i);
  });

  it("R3 · retained response BYTES that do not hash to the entry digest refuse, however equivalent the object", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    const normal = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "normal"));
    write("normal", {
      ...normal,
      cases: (normal.cases as Record<string, unknown>[]).map((record) => {
        const witness = { ...(record.witness as Record<string, unknown>) };
        // Semantically identical, byte-different: the same response, pretty-printed. The object
        // "looks equivalent" and the bytes are not the ones the publisher published.
        if (witness.pre_response) witness.pre_response_bytes = JSON.stringify(witness.pre_response, null, 2);
        return { ...record, witness };
      }),
    });
    const detail = blockersOf().map((entry) => entry.detail).join("\n");
    expect(detail, "a changed byte stream produced no blocker").not.toBe("");
    expect(detail).toMatch(/bytes|digest/i);
  });

  it("R4 · an already-valid historical packet assesses without the wall clock, and late NEW consumption still refuses", async () => {
    const { github } = await coherentPacket();
    expect(blockersOf()).toEqual([]);
    // THE WALL CLOCK MOVES ON. A packet that was valid when it was produced stays valid: every
    // receipt, lifetime and ordering fact it is judged on is retained history, not "now".
    const muchLater = () => new Date(Date.parse("2027-01-01T00:00:00.000Z"));
    expect(blockersOf(muchLater), "a historical packet stopped assessing once the clock moved").toEqual([]);
    // But a NEW consumption after the original expiry is still refused — the expiry is never
    // extended, and being historical does not make a late measurement admissible.
    const ordinal = 1;
    const expired = createTestClock("2027-01-01T00:00:00.000Z");
    await expect(serveOne(
      github,
      { role: "normal", caseId: firstNormalCase(), ordinal, direction: "pre" },
      {}, expired.now,
    )).rejects.toThrow(/expired|expiry/i);
  });

  it("T1 · serving the SAME validated publication again returns the prior record and appends nothing", async () => {
    const { github } = await coherentPacket();
    const before = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    const countOf = (records: { type: string; data: Record<string, unknown> }[], type: string) => records.filter((record) =>
      String(record.type) === type && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre").length;
    expect(countOf(before as never, "challenge-observed")).toBe(1);
    expect(countOf(before as never, "response-reconciled")).toBe(1);
    const priorReconciled = (before as never as { type: string; data: Record<string, unknown> }[])
      .find((record) => String(record.type) === "response-reconciled" && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data;

    // THE ACTUAL FLOW, called again — a restarted witness serving an item it already served, WITHIN
    // the original challenge expiry. (Outside it the serve refuses, which R4 proves separately: the
    // expiry is never extended, and a replay does not earn one.)
    const name = challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role: "normal", ordinal: 1, direction: "pre" });
    const challenge = JSON.parse(readFileSync(path.join(cloudDir("challenges"), `${name}.json`), "utf8"));
    const insideExpiry = createTestClock(new Date(Date.parse(String(challenge.created_at)) + 1000).toISOString());
    const served = await serveOne(github, { role: "normal", caseId: firstNormalCase(), ordinal: 1, direction: "pre" }, {}, insideExpiry.now);
    // `serveWitnessItem` returns the reconciled RECORD itself — and on a replay it must be the one
    // already in the chain, unchanged.
    expect(served).toEqual(priorReconciled);

    const after = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    expect(countOf(after as never, "challenge-observed"), "a replay appended a second observation").toBe(1);
    expect(countOf(after as never, "response-reconciled"), "a replay appended a second reconciliation").toBe(1);
    // And the packet still passes: an idempotent replay changes no evidence.
    expect(blockersOf()).toEqual([]);
  });

  it("T2 · the poll path is idempotent for the same publication", async () => {
    const { github } = await coherentPacket();
    const session = await openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
    });
    try {
      const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
      const observed = records.find((record) => String(record.type) === "challenge-observed"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data as Record<string, unknown>;
      const reconciled = records.find((record) => String(record.type) === "response-reconciled"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data as Record<string, unknown>;
      // Rebuild the pending shape the poller is handed, from RETAINED facts only.
      const name = challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role: "normal", ordinal: 1, direction: "pre" });
      const challengeBytes = readFileSync(path.join(cloudDir("challenges"), `${name}.json`));
      const challenge = JSON.parse(challengeBytes.toString("utf8"));
      const pending = {
        challenge, challengeDigest: String(observed.challenge_digest),
        challengeBinding: Object.fromEntries(Object.keys(challenge).filter((key) => key !== "nonce" && key !== "created_at" && key !== "expires_at" && key !== "schema_version" && key !== "kind" && key !== "before_sha" && key !== "requested_sha").map((key) => [key, challenge[key]])),
        expectedName: String(reconciled.expected_artifact), envelopeDigest: reconciled.envelope_digest ?? null,
      };
      const polled = await pollWitnessPublication({
        request: session.request, requestArchive: session.requestArchive, ctx: session.ctx,
        journal: session.journal, item: { role: "normal", caseId: firstNormalCase(), ordinal: 1, direction: "pre" },
        pending, now: () => new Date(Date.parse(String(challenge.created_at)) + 1000),
      });
      expect(polled, "the poll returned nothing for a published response").not.toBeNull();
      expect(polled).toEqual(reconciled);
      const after = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
      expect(after.filter((record) => String(record.type) === "response-reconciled"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre").length,
      "the poll appended a second reconciliation").toBe(1);
    } finally { session.lock.release(); }
  });

  it("T3 · a CONFLICTING publication or observation under the same key refuses", async () => {
    await coherentPacket();
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness", source: WORKFLOW_SHA, lock });
      const existing = journal.read();
      const reconciled = existing.find((record) => String(record.type) === "response-reconciled"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data as Record<string, unknown>;
      const observed = existing.find((record) => String(record.type) === "challenge-observed"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data as Record<string, unknown>;
      // A DIFFERENT publication for the same case/direction: same key, other artifact and bytes.
      expect(() => recordWitnessEventOnce({
        journal, type: "response-reconciled",
        data: { ...reconciled, artifact_id: 999999, entry_digest: "c".repeat(64) },
      })).toThrow(/already holds a different response-reconciled.*conflicting/s);
      // A DIFFERENT challenge for the same case/direction.
      expect(() => recordWitnessEventOnce({
        journal, type: "challenge-observed",
        data: { ...observed, challenge_digest: "d".repeat(64) },
      })).toThrow(/already holds a different challenge-observed.*conflicting/s);
      // The identical validated record still replays without appending.
      const replay = recordWitnessEventOnce({ journal, type: "response-reconciled", data: reconciled });
      expect(replay.appended).toBe(false);
      expect(replay.record).toEqual(reconciled);
    } finally { lock.release(); }
  });

  it("T4 · a correctly chained DUPLICATE history refuses, and a missing event refuses", async () => {
    await coherentPacket();
    expect(blockersOf()).toEqual([]);
    // A genuinely duplicated event, in a chain whose hash links verify.
    rebuildWitnessJournal((record) => record);
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness" });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, kind: "witness", source: WORKFLOW_SHA, lock });
      const reconciled = journal.read().find((record) => String(record.type) === "response-reconciled"
        && String(record.data?.case_id) === firstNormalCase() && String(record.data?.direction) === "pre")!.data;
      // Appended DIRECTLY, bypassing the transition, exactly as a pre-correction producer would.
      journal.append("response-reconciled", reconciled);
    } finally { lock.release(); }
    const duplicated = blockersOf().map((entry) => entry.detail).join("\n");
    expect(duplicated).toMatch(/records 2 response-reconciled events/);

    // And a MISSING event, from the same coherent baseline.
    rebuildWitnessJournal((record) => (record.type === "dispatch-result" && String(record.data.case_id) === firstNormalCase()
      && String(record.data.direction) === "pre" ? null : record));
    const missing = blockersOf().map((entry) => entry.detail).join("\n");
    expect(missing).toMatch(/records no dispatch-result/);
  });
});

describe("R2 — a local human case is issued once, admitted from the verified journal, and joined to it offline", () => {
  const graph = Object.fromEntries(buildGraphPlan(RUN_ID, ATTEMPT).map((node, index) => [node.key, sha(`r2-node-${index}`)]));
  const ctx = { role: "local", runId: RUN_ID, attempt: ATTEMPT };
  const humanCases = () => buildActorMatrix().filter((kase) => kase.actor === "human");
  const ref = derivedRef(RUN_ID, ATTEMPT, "human");
  const timeout = { status: 0, category: "transport-timeout", ruleIds: [], policyDenial: false };
  const policyDenial = { status: 422, category: "policy-denial", ruleIds: ["protected-ref-update-restricted"], policyDenial: true };

  /** An in-memory stand-in for the verified chain: the same `{ type, data }` records, in order. */
  const memoryJournal = (events: { type: string; data: Record<string, unknown> }[] = []) => ({
    events,
    append: (type: string, data: Record<string, unknown>) => { events.push({ type, data: JSON.parse(JSON.stringify(data ?? null)) }); },
    read: () => events,
  });

  /** One complete, classifier-consistent denied history for a case — what a real settled case journals. */
  const settledDenial = (kase: ReturnType<typeof humanCases>[number]) => {
    const requested = kase.to ? graph[kase.to] : null;
    const intent = { case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force, before_sha: graph[kase.from], requested_sha: requested, expected: kase.expected, checks: kase.checks };
    const outcome = {
      case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force, expected: kase.expected,
      before_sha: graph[kase.from], requested_sha: requested, after_sha: graph[kase.from], http_status: 422,
      response_complete: true, response_incomplete: null, measured_status: 422, diagnostic: policyDenial,
      outcome: "denied", check_state: { expectation: kase.checks, measured: false }, passed: true, reason: null,
    };
    return [
      { type: "mutation-intent", data: intent },
      { type: "mutation-result", data: { case: kase.id, status: 422, response_complete: true, response_incomplete: null, measured_status: 422, diagnostic: policyDenial } },
      { type: "readback", data: { case: kase.id, ref, after_sha: graph[kase.from] } },
      { type: "case-outcome", data: outcome },
    ];
  };

  /** A provider stub: ref reads answer from `refSha`, every mutation is counted and answered by `mutate`. */
  const provider = (mutate: (method: string) => { status: number; diagnostic: unknown }, options: { failReadbackAfterMutation?: boolean } = {}) => {
    const calls: string[] = [];
    let mutated = false;
    const request = async (method: string, requestPath: string) => {
      calls.push(`${method} ${requestPath}`);
      if (method === "GET" && requestPath.includes("/git/ref/heads/")) {
        if (mutated && options.failReadbackAfterMutation) return { status: 503, body: null };
        return { status: 200, body: { object: { sha: graph.C } } };
      }
      if (["PATCH", "DELETE", "PUT"].includes(method)) {
        mutated = true;
        // A stub answer with a status line is a COMPLETED one unless it says otherwise; status 0 never completed.
        const answer = mutate(method);
        return { complete: answer.status !== 0, incomplete: answer.status === 0 ? "transport-timeout" : null, ...answer, body: null };
      }
      throw new Error(`unexpected request ${method} ${requestPath}`);
    };
    return { request, calls, mutations: () => calls.filter((call) => /^(PATCH|DELETE|PUT) /.test(call)) };
  };

  it("the review probe: a replayed case is refused from the journal before ANY request, so one timeout is one request", async () => {
    const kase = humanCases().find((entry) => entry.id === "human-force-rewind")!;
    const journal = memoryJournal();
    const stub = provider(() => ({ status: 0, diagnostic: timeout }));
    const first = await runActorCase({ request: stub.request, kase, ctx, graphShas: graph, journal });
    expect(first.halt).toBe(true);
    expect(first.record).toMatchObject({ outcome: "inconclusive", passed: false });
    const before = stub.calls.length;
    await expect(runActorCase({ request: stub.request, kase, ctx, graphShas: graph, journal }))
      .rejects.toThrow(/already has 4 journaled mutation event\(s\).*issued exactly once/);
    expect(stub.calls.length).toBe(before); // not even a GET
    expect(stub.mutations()).toHaveLength(1);
    expect(journal.events.filter((event) => event.type === "mutation-intent")).toHaveLength(1);
    // And a case cannot be admitted with no journal to admit it from.
    await expect(runActorCase({ request: stub.request, kase, ctx, graphShas: graph, journal: null }))
      .rejects.toThrow(/admitted only from the verified run\/attempt journal/);
  });

  it("a crash after the fsynced intent: the restarted phase issues NOTHING and stops every later case", async () => {
    const [first] = humanCases();
    const journal = memoryJournal([settledDenial(first)[0]]); // intent only — the process died after the fsync
    const stub = provider(() => { throw new Error("no mutation may be issued"); });
    const { records, halted } = await runActorCases({ request: stub.request, actor: "human", ctx, graphShas: graph, journal });
    expect(stub.calls).toEqual([]);
    expect(halted).toBe(first.id);
    expect(records[0]).toMatchObject({ case: first.id, outcome: "inconclusive", passed: false });
    expect(records[0].reason).toMatch(/never settled.*never retried/);
    for (const record of records.slice(1)) expect(record, record.case).toMatchObject({ outcome: "not-run", passed: false });
  });

  it("a readback that fails AFTER the mutation stops the later cases in this process and in every restart", async () => {
    const [one, two, three] = humanCases();
    const journal = memoryJournal([...settledDenial(one), ...settledDenial(two)]);
    const stub = provider(() => ({ status: 422, diagnostic: policyDenial }), { failReadbackAfterMutation: true });
    const first = await runActorCases({ request: stub.request, actor: "human", ctx, graphShas: graph, journal });
    // The two settled cases are taken from their history, never issued again.
    expect(first.records.slice(0, 2).map((record) => record.outcome)).toEqual(["denied", "denied"]);
    expect(first.records[2]).toMatchObject({ case: three.id, outcome: "inconclusive", passed: false });
    expect(first.records[2].reason).toMatch(/after its mutation intent was journaled/);
    expect(first.halted).toBe(three.id);
    for (const record of first.records.slice(3)) expect(record, record.case).toMatchObject({ outcome: "not-run" });
    expect(stub.mutations()).toHaveLength(1); // previously: the later cases each issued their own
    // Restart: the chain says the third case is unresolved, so nothing at all is issued.
    const restarted = provider(() => { throw new Error("no mutation may be issued"); });
    const again = await runActorCases({ request: restarted.request, actor: "human", ctx, graphShas: graph, journal });
    expect(restarted.calls).toEqual([]);
    expect(again.halted).toBe(three.id);
    expect(again.records.map((record) => record.outcome)).toEqual(["denied", "denied", "inconclusive", "not-run", "not-run", "not-run"]);
  });

  it.each([
    ["timed out", 0, timeout],
    ["503", 503, { status: 503, category: "unclassified", ruleIds: [], policyDenial: false }],
    ["502 with rule wording", 502, { ...policyDenial, status: 502 }],
    ["504", 504, { status: 504, category: "unclassified", ruleIds: [], policyDenial: false }],
  ] as const)("an ambiguous (%s) case halts, and a repeated phase re-reads its outcome instead of re-issuing it", async (_label, status, diagnostic) => {
    const [one, two, three, four] = humanCases();
    const journal = memoryJournal([...settledDenial(one), ...settledDenial(two)]);
    const stub = provider(() => ({ status, diagnostic }));
    const first = await runActorCases({ request: stub.request, actor: "human", ctx, graphShas: graph, journal });
    expect(first.records[2]).toMatchObject({ case: three.id, outcome: "inconclusive", passed: false });
    expect(first.halted).toBe(three.id);
    expect(first.records[3]).toMatchObject({ case: four.id, outcome: "not-run" });
    expect(stub.mutations()).toHaveLength(1);
    const repeat = provider(() => { throw new Error("no mutation may be issued"); });
    const second = await runActorCases({ request: repeat.request, actor: "human", ctx, graphShas: graph, journal });
    expect(repeat.calls).toEqual([]);
    expect(second.records.slice(0, 3)).toEqual(first.records.slice(0, 3));
    expect(second.halted).toBe(three.id);
    // Offline, the same history is a blocking settled case, and a later intent is a post-halt issue.
    const assessed = assessHumanCaseJournal(journal.events, { runId: RUN_ID, attempt: ATTEMPT });
    expect(assessed.cases[three.id]).toMatchObject({ state: "settled", blocking: true });
    const hidden = assessHumanCaseJournal([...journal.events, settledDenial(four)[0]], { runId: RUN_ID, attempt: ATTEMPT });
    expect(hidden.problems.join("\n")).toMatch(new RegExp(`${four.id} issued after ${three.id} \\(settled\\)`));
  });

  it("the offline history owner refuses duplicate, unresolved, out-of-order, rewritten, hidden and post-halt histories", () => {
    const [one, two, three] = humanCases();
    const assess = (events: { type: string; data: Record<string, unknown> }[]) => assessHumanCaseJournal(events, { runId: RUN_ID, attempt: ATTEMPT });
    const clean = assess([...settledDenial(one), ...settledDenial(two)]);
    expect(clean.problems).toEqual([]);
    expect(clean.cases[one.id]).toMatchObject({ state: "settled", blocking: false });
    expect(clean.cases[three.id]).toMatchObject({ state: "none", blocking: false });

    // A replay: the same case's complete sequence twice.
    expect(assess([...settledDenial(one), ...settledDenial(one)]).cases[one.id]).toMatchObject({ state: "invalid", blocking: true });
    // An intent with no settled sequence.
    expect(assess(settledDenial(one).slice(0, 2)).cases[one.id]).toMatchObject({ state: "unresolved", blocking: true });
    // Out of order.
    const [intent, result, read, outcome] = settledDenial(one);
    expect(assess([intent, read, result, outcome]).cases[one.id].state).toBe("invalid");
    // An outcome the history does not support: a denial recorded for a ref the readback shows moved.
    expect(assess([intent, result, { ...read, data: { ...read.data, after_sha: graph.B } }, outcome]).cases[one.id].state).toBe("invalid");
    // A hidden attempt: case-scoped history for something outside the closed human matrix.
    expect(assess([...settledDenial(one), { type: "mutation-intent", data: { ...intent.data, case: "normal-update-all-green" } }]).problems.join("\n"))
      .toMatch(/not a local human case/);
    // A case issued after another had already stopped further mutations.
    expect(assess([...settledDenial(one).slice(0, 1), ...settledDenial(two)]).problems.join("\n"))
      .toMatch(new RegExp(`${two.id} issued after ${one.id} \\(unresolved\\)`));
  });

  it("a repeated human-tests phase issues nothing new, and the final assessment joins every human case to its one history", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    github.approve("normal");
    await runNormalCheckPublication({ env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: cloudDeps(github) });
    const humanMutations = () => github.calls.filter((call) => ["PATCH", "DELETE", "PUT"].includes(call.method)
      && (call.path.endsWith(ref.replace("refs/heads/", "")) || /\/pulls\/\d+\/merge$/.test(call.path)));
    const first = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    expect(first).toMatchObject({ phase: "human-tests", status: "passed" });
    const issued = humanMutations().length;
    expect(issued).toBe(humanCases().length);
    const firstEvidence = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"));

    const second = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
    expect(second).toMatchObject({ phase: "human-tests", status: "passed" });
    expect(humanMutations()).toHaveLength(issued); // NOT doubled
    expect(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human")).cases).toEqual(firstEvidence.cases);
    const intents = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as { type: string; data: { case?: string } }[])
      .filter((record) => record.type === "mutation-intent" && record.data?.case);
    expect(intents.map((record) => record.data.case).sort()).toEqual(humanCases().map((kase) => kase.id).sort());

    const humanBlockers = () => assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .filter((entry: Blocker) => entry.gate === "PC-05" && /human-/.test(entry.detail));
    expect(humanBlockers()).toEqual([]);

    // A DERIVED file rewritten to disagree with the chain refuses.
    const rewritten = structuredClone(firstEvidence);
    rewritten.cases[0].reason = "rewritten after the fact";
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"), rewritten);
    expect(humanBlockers().map((entry: Blocker) => `${entry.kind} ${entry.detail}`).join("\n"))
      .toMatch(new RegExp(`invalid case ${humanCases()[0].id}'s recorded outcome is not the one its verified journal history holds`));
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"), firstEvidence);

    // A HIDDEN second attempt in the chain refuses even though the derived file shows one record.
    const lock = acquireJournalLock({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    try {
      const journal = openJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT, source: WORKFLOW_SHA, lock });
      journal.append("mutation-intent", intents[1].data);
    } finally { lock.release(); }
    expect(humanBlockers().map((entry: Blocker) => `${entry.kind} ${entry.detail}`).join("\n"))
      .toMatch(new RegExp(`invalid case ${String(intents[1].data.case)} was issued 2 times`));
  });
});

/**
 * ── R02 — THE COMPLETED-RESPONSE CONTRACT, THROUGH THE REAL ADAPTERS AND THE PUBLIC CALLERS ──────
 *
 * The independent review demonstrated six provider answers that the two REAL transports turned into
 * a decisive outcome: a body read that rejected, malformed JSON, an oversize body, a truncated body
 * followed by a failing `gh` exit, and a truncated refusal whose half-sentence was read as a policy
 * denial. Tests that inject an already-normalised status cannot see that class of defect — the bug
 * lived in the normalisation. So everything below drives `createTokenTransport` with a fetch double
 * and `createLocalGhTransport` with a `gh` double that emits raw process output, and then follows the
 * same bytes through the public phases, the staged finalizer and the CLI exit code.
 */
describe("R02 — an incomplete provider response is never decisive, from the adapter to the exit code", () => {
  const A = sha("r02-a"), B = sha("r02-b");
  const encode = (text: string) => new TextEncoder().encode(text);
  /** The review's own judgement: an acceptance whose independent readback matches. */
  const judge = (response: unknown, expected: "accepted" | "denied" = "accepted") => classifyCaseOutcome({
    expected, response: response as ProviderResponse, beforeSha: A, afterSha: expected === "accepted" ? B : A, requestedSha: B, operation: "update",
  });

  /** A fetch Response double whose body is a real stream, so the bound and the read failure are the adapter's. */
  const streamed = (status: number, chunks: (string | Uint8Array)[], options: { error?: boolean; headers?: Record<string, string> } = {}) => {
    const counter = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (counter.pulled < chunks.length) {
          const chunk = chunks[counter.pulled++];
          controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
          return;
        }
        if (options.error) controller.error(new Error("mock connection reset during response body"));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    return { counter, response: { status, ok: status >= 200 && status < 300, headers: new Headers(options.headers ?? {}), body } };
  };
  const tokenOver = (response: unknown, extra: Record<string, unknown> = {}) => createTokenTransport({
    token: "LOCAL-MOCK-NOT-A-CREDENTIAL", fetchImpl: (async () => response) as unknown as typeof fetch, ...extra,
  });

  /**
   * A `gh` double: ONE scripted request answers with raw process output (bytes and exit code), and
   * every other request is served by the fake provider exactly as the suite's normal `gh` does.
   */
  function scriptedGh(
    github: ReturnType<typeof createFakeGitHub>,
    script: (call: { method: string; path: string; body: unknown }) => { apply?: boolean; stdout: string | Buffer; code: number | null } | null,
  ) {
    const kills: string[] = [];
    const spawnImpl = ((_command: string, args: string[]) => {
      const method = args[args.indexOf("--method") + 1];
      const requestPath = args.find((arg, index) => arg.startsWith("/") && args[index - 1] !== "-H")!;
      const received: Buffer[] = [];
      const child = new EventEmitter() as FakeChild;
      child.pid = 4343;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let closed = false;
      const close = (code: number | null) => { if (!closed) { closed = true; child.emit("close", code); } };
      child.kill = () => { kills.push(`${method} ${requestPath}`); queueMicrotask(() => close(null)); };
      child.stdin = new Writable({ write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); } });
      child.stdin.on("finish", () => {
        const raw = Buffer.concat(received).toString("utf8");
        const body = raw ? JSON.parse(raw) : undefined;
        const scripted = script({ method, path: requestPath, body });
        if (!scripted) {
          const result = github.handle("local", method, requestPath, body as never);
          child.stdout.on("end", () => close(result.status >= 400 ? 1 : 0));
          child.stdout.end(`HTTP/2.0 ${result.status} Status\r\nContent-Type: application/json\r\n\r\n${result.body === null ? "" : JSON.stringify(result.body)}`);
          return;
        }
        if (scripted.apply) github.handle("local", method, requestPath, body as never);
        child.stdout.on("end", () => close(scripted.code));
        child.stdout.end(scripted.stdout);
      });
      return child;
    }) as unknown as ReturnType<typeof createFakeGitHub>["spawnImpl"];
    return { spawnImpl, kills };
  }
  const ghOnce = (stdout: string | Buffer, code: number | null) => {
    const github = createFakeGitHub();
    const scripted = scriptedGh(github, () => ({ stdout, code }));
    return { request: createLocalGhTransport({ env: {}, spawnImpl: scripted.spawnImpl as never }), kills: scripted.kills };
  };

  // ── the six reviewed adapter answers, exactly as the review's probe issued them ─────────────────
  it("R02-1 · the token transport: a rejected body read, malformed JSON and an oversize body are incomplete, never accepted", async () => {
    for (const [label, text, reason] of [
      ["body-read-failure", async () => { throw new Error("mock connection reset during response body"); }, "body-read-failed"],
      ["malformed-json", async () => "{\"object\":", "body-malformed"],
      ["oversize-json", async () => JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }), "body-oversize"],
    ] as const) {
      const response = await tokenOver({ status: 200, ok: true, text })("PATCH", "/local-mock", { sha: B, force: false });
      expect(response, label).toMatchObject({ status: 0, complete: false, incomplete: reason, measured_status: 200, body: null });
      expect(judge(response), label).toMatchObject({ outcome: "inconclusive", halt: true, ambiguous: true });
      expect(mutationRequestClass(response.status, response.complete), label).toBe("ambiguous");
    }
  });

  it("R02-1 · the local gh transport: malformed success, a success with a failing exit, and a truncated refusal are incomplete", async () => {
    for (const [label, status, body, code, expected, reason] of [
      ["malformed-success", 200, "{\"object\":", 0, "accepted", "body-malformed"],
      ["incomplete-process-success", 200, "{\"object\":", 1, "accepted", "process-incomplete"],
      ["malformed-policy-refusal", 422, "{\"message\":\"Cannot update this protected ref", 1, "denied", "body-malformed"],
    ] as const) {
      const { request } = ghOnce(`HTTP/2 ${status}\r\n\r\n${body}`, code);
      const response = await request("PATCH", "/local-mock", { sha: B, force: false });
      expect(response, label).toMatchObject({ status: 0, complete: false, incomplete: reason, measured_status: status, body: null });
      // The cut-off refusal text is never read as enforcement.
      expect(response.diagnostic, label).toMatchObject({ policyDenial: false, ruleIds: [] });
      expect(judge(response, expected), label).toMatchObject({ outcome: "inconclusive", halt: true, ambiguous: true });
    }
  });

  it("R02-1 · the token transport stops collecting at the bound instead of buffering first, and a failed stream read is not an empty body", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const oversize = streamed(200, Array.from({ length: 64 }, () => chunk));
    const response = await tokenOver(oversize.response)("PATCH", "/local-mock", { sha: B });
    expect(response).toMatchObject({ status: 0, complete: false, incomplete: "body-oversize", measured_status: 200 });
    // 1 MiB is 16 of these chunks: collection stopped just past it, far short of the 4 MiB offered.
    expect(oversize.counter.pulled).toBeLessThanOrEqual(18);
    // A smaller configured bound is honoured the same way.
    const small = streamed(200, ["{\"object\":{\"sha\":\"", "x".repeat(600), "\"}}"]);
    expect(await tokenOver(small.response, { maxBytes: 512 })("PATCH", "/local-mock", {})).toMatchObject({ complete: false, incomplete: "body-oversize" });
    expect(small.counter.pulled).toBe(2);
    // A declared length beyond the bound is refused before a single byte is read.
    const declared = streamed(200, ["{}"], { headers: { "content-length": String(8 * 1024 * 1024) } });
    expect(await tokenOver(declared.response)("PATCH", "/local-mock", {})).toMatchObject({ complete: false, incomplete: "body-oversize" });
    expect(declared.counter.pulled).toBe(0);
    // Part of a body, then a reset: the half that arrived is not the response.
    const reset = streamed(200, [`{"ref":"refs/heads/x","object":{"sha":"${B}"`], { error: true });
    expect(await tokenOver(reset.response)("PATCH", "/local-mock", {})).toMatchObject({ status: 0, complete: false, incomplete: "body-read-failed", measured_status: 200 });
    // A 200 with no body at all is a missing body, not a success.
    expect(await tokenOver(streamed(200, []).response)("PATCH", "/local-mock", {})).toMatchObject({ complete: false, incomplete: "body-missing" });
    // Invalid UTF-8 is not re-read through a replacement character into some other valid JSON.
    expect(await tokenOver(streamed(200, [new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]).response)("PATCH", "/local-mock", {}))
      .toMatchObject({ complete: false, incomplete: "body-encoding-invalid" });
  });

  it("R02-1 · the local gh transport: a cut-off head, invalid UTF-8, a signal exit and oversize output are incomplete; the bound kills the process", async () => {
    expect(await ghOnce("HTTP/2 200\r\ncontent-type: application/json", 0).request("PATCH", "/local-mock", {}))
      .toMatchObject({ status: 0, complete: false, incomplete: "headers-incomplete", measured_status: 200 });
    expect(await ghOnce(Buffer.concat([Buffer.from("HTTP/2 200\r\n\r\n{\"a\":\""), Buffer.from([0xff]), Buffer.from("\"}")]), 0).request("PATCH", "/local-mock", {}))
      .toMatchObject({ complete: false, incomplete: "body-encoding-invalid" });
    // A complete-looking refusal from a process killed by a signal did not finish.
    expect(await ghOnce("HTTP/2 422\r\n\r\n{\"message\":\"Cannot update this protected ref.\"}", null).request("PATCH", "/local-mock", {}))
      .toMatchObject({ complete: false, incomplete: "process-incomplete", measured_status: 422 });
    const oversize = ghOnce(`HTTP/2 200\r\n\r\n{"padding":"${"x".repeat(1024 * 1024 + 1)}"}`, 0);
    expect(await oversize.request("PATCH", "/local-mock", {})).toMatchObject({ status: 0, complete: false, incomplete: "body-oversize" });
    expect(oversize.kills).toHaveLength(1);
  });

  it("R02-1 · a COMPLETE answer is still decisive, and a legitimate empty 204 is complete — through both adapters", async () => {
    const refused = "{\"message\":\"Cannot update this protected ref.\",\"documentation_url\":\"https://docs.github.com\"}";
    for (const [label, response] of [
      ["token", await tokenOver(streamed(422, [refused]).response)("PATCH", "/local-mock", {})],
      ["gh", await ghOnce(`HTTP/2 422\r\n\r\n${refused}`, 1).request("PATCH", "/local-mock", {})],
    ] as const) {
      expect(response, label).toMatchObject({ status: 422, complete: true, incomplete: null, measured_status: 422 });
      expect(judge(response, "denied"), label).toMatchObject({ outcome: "denied", halt: false });
    }
    const updated = JSON.stringify({ ref: "refs/heads/x", object: { sha: B, type: "commit" }, url: "https://api.github.com/x" });
    for (const [label, response] of [
      ["token", await tokenOver(streamed(200, [updated]).response)("PATCH", "/local-mock", {})],
      ["gh", await ghOnce(`HTTP/2 200\r\n\r\n${updated}`, 0).request("PATCH", "/local-mock", {})],
    ] as const) {
      expect(response, label).toMatchObject({ status: 200, complete: true });
      // Validated, never rewritten: every field the provider returned is still on the body.
      expect(conformResponse("update-derived-ref", response), label).toMatchObject({ body: JSON.parse(updated), complete: true });
      expect(judge(response), label).toMatchObject({ outcome: "accepted", halt: false });
    }
    // An EMPTY 204 is a complete answer (fetch's own null body, and gh's empty body on exit 0).
    for (const [label, response] of [
      ["token", await tokenOver({ status: 204, ok: true, headers: new Headers(), body: null })("POST", "/local-mock", {})],
      ["gh", await ghOnce("HTTP/2 204\r\n\r\n", 0).request("POST", "/local-mock", {})],
    ] as const) {
      expect(response, label).toMatchObject({ status: 204, complete: true, incomplete: null, body: null });
      expect(conformResponse("dispatch-witness-workflow", response), label).toMatchObject({ status: 204, complete: true });
      expect(mutationRequestClass(response.status, response.complete), label).toBe("accepted");
    }
    // …but a 204 carrying bytes is not an empty 204, and a failed read is not an empty 204 either.
    expect(await ghOnce("HTTP/2 204\r\n\r\n{\"partial", 0).request("POST", "/local-mock", {})).toMatchObject({ complete: false, incomplete: "body-unexpected" });
    expect(await tokenOver(streamed(204, [], { error: true }).response)("POST", "/local-mock", {})).toMatchObject({ complete: false, incomplete: "body-read-failed" });
  });

  it("R02-1 · the guard holds each write to its endpoint's documented shape, and a result that states no completion is not a status to trust", () => {
    const done = (status: number, body: unknown) => completedJsonResponse(status, Buffer.from(body === null ? "" : JSON.stringify(body), "utf8"));
    // A 2xx in the wrong shape did not come from a completed request to this endpoint.
    expect(conformResponse("update-derived-ref", done(200, {}))).toMatchObject({ status: 0, complete: false, incomplete: "shape-invalid", measured_status: 200 });
    expect(conformResponse("dispatch-witness-workflow", done(200, { ok: true }))).toMatchObject({ complete: false, incomplete: "shape-invalid" });
    expect(conformResponse("create-disposable-ruleset", done(201, { name: "no-id" }))).toMatchObject({ complete: false, incomplete: "shape-invalid" });
    expect(conformResponse("delete-derived-ref", done(200, { ref: "x" }))).toMatchObject({ complete: false, incomplete: "shape-invalid" });
    // No stated completion: the status is exactly the part that cannot vouch for itself.
    expect(conformResponse("update-derived-ref", { status: 200, body: { object: { sha: B } } }))
      .toMatchObject({ status: 0, complete: false, incomplete: "completion-unstated", measured_status: 200 });
    // A create keeps every provenance field the provider returned.
    const created = done(201, { id: 7, name: "commissioning-x", source: COMMISSIONING_REPOSITORY, source_type: "Repository" });
    expect(conformResponse("create-disposable-ruleset", created).body).toEqual({ id: 7, name: "commissioning-x", source: COMMISSIONING_REPOSITORY, source_type: "Repository" });
    // Persisted evidence carries the completion facts beside the status.
    expect(responseEvidence(incompleteResponse("body-malformed", 422))).toEqual({ response_complete: false, response_incomplete: "body-malformed", measured_status: 422 });
    expect(responseEvidence({ status: 422 })).toEqual({ response_complete: false, response_incomplete: "completion-unstated", measured_status: null });
  });

  // ── the local human finalizer and the public CLI ────────────────────────────────────────────────
  const humanBranch = () => derivedRef(RUN_ID, ATTEMPT, "human").replace("refs/heads/", "");
  const isHumanMutation = (method: string, requestPath: string) => ["PATCH", "DELETE", "PUT"].includes(method)
    && (requestPath.endsWith(humanBranch()) || /\/pulls\/\d+\/merge$/.test(requestPath));
  const humanCli = (spawnImpl: unknown, write: (text: string) => void) =>
    main(["human-tests", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], LOCAL_ENV, { spawnImpl, write });

  it("R02-1/R02-2 · a truncated refusal to the FIRST human case halts the matrix, exits 3, issues no later mutation, and re-derives offline as unknown", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    let humanMutations = 0;
    const scripted = scriptedGh(github, ({ method, path: requestPath }) => {
      if (!isHumanMutation(method, requestPath)) return null;
      humanMutations += 1;
      // The provider refused (nothing moved), and the process died part-way through the refusal text.
      return { stdout: "HTTP/2.0 422 Unprocessable Entity\r\n\r\n{\"message\":\"Cannot update this protected ref", code: 1 };
    });
    const emitted: string[] = [];
    expect(await humanCli(scripted.spawnImpl, (text) => emitted.push(text))).toBe(3);
    const result = JSON.parse(emitted.at(-1)!);
    expect(result).toMatchObject({ phase: "human-tests", status: "incomplete" });
    expect(result.errors.join(" ")).toMatch(/stopped every later human-tests mutation, which is never retried/);
    expect(humanMutations).toBe(1);

    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    // Exactly one human mutation was ever issued. (Without the normal job's check publication the
    // two update cases stop at their unmet check precondition, before any request.)
    const intents = records.filter((record) => record.type === "mutation-intent" && record.data.actor === "human" && record.data.case);
    expect(intents).toHaveLength(1);
    const first = buildActorMatrix().find((kase) => kase.id === intents[0].data.case)!;
    const mutation = records.find((record) => record.type === "mutation-result" && record.data.case === first.id)!;
    expect(mutation.data).toMatchObject({ status: 0, response_complete: false, response_incomplete: "body-malformed", measured_status: 422 });
    expect(mutation.data.diagnostic).toMatchObject({ policyDenial: false });
    const evidence = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human"));
    expect(evidence.halted_after).toBe(first.id);
    const position = evidence.cases.findIndex((record: CaseRecord) => record.case === first.id);
    expect(evidence.cases[position]).toMatchObject({ case: first.id, outcome: "inconclusive", passed: false, response_complete: false, measured_status: 422 });
    expect(evidence.cases.slice(position + 1).every((record: CaseRecord) => record.outcome === "not-run")).toBe(true);
    // Nothing in this matrix is a measured failure: every failing case is inconclusive or not-run.
    expect(evidence.cases.every((record: CaseRecord) => ["inconclusive", "not-run"].includes(String(record.outcome)))).toBe(true);

    // A restarted phase admits from the journal: still exit 3, and still no further mutation.
    expect(await humanCli(scripted.spawnImpl, (text) => emitted.push(text))).toBe(3);
    expect(humanMutations).toBe(1);

    // OFFLINE: the journaled history re-derives as the unknown outcome it was, and blocks.
    const assessed = assessHumanCaseJournal(records, { runId: RUN_ID, attempt: ATTEMPT });
    expect(assessed.problems).toEqual([]);
    expect(assessed.blocking).toEqual([first.id]);
    expect(assessed.cases[first.id]).toMatchObject({ state: "settled", blocking: true, verdict: { outcome: "inconclusive", ambiguous: true } });
    // A status-only restamp of that result as a complete policy refusal cannot restore a denial:
    // with no completion fact it is still ambiguous, and it disagrees with the journaled outcome.
    const restamped = structuredClone(records).map((record) => (record.type === "mutation-result" && record.data.case === first.id
      ? { ...record, data: { case: first.id, status: 422, diagnostic: { status: 422, category: "protected-ref-update-restricted", ruleIds: ["protected-ref-update-restricted"], policyDenial: true } } }
      : record));
    const relabelled = assessHumanCaseJournal(restamped, { runId: RUN_ID, attempt: ATTEMPT }).cases[first.id];
    expect(relabelled.verdict?.outcome ?? relabelled.state).not.toBe("denied");
    expect(relabelled.blocking).toBe(true);
  });

  it("R02-2 · a MIXED human matrix keeps exit 1: an unattributable refusal beside a measured unexpected success is a failure", async () => {
    const github = createFakeGitHub({ ignoreRuleTypes: ["update", "pull_request", "required_status_checks"] });
    await intentAndSetup(github);
    let seen = 0;
    const scripted = scriptedGh(github, ({ method, path: requestPath }) => {
      if (!isHumanMutation(method, requestPath) || seen++ > 0) return null;
      // A complete 403 that is not a policy rule: inconclusive, and not halting.
      return { stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{\"message\":\"Resource not accessible by integration\"}", code: 1 };
    });
    const emitted: string[] = [];
    expect(await humanCli(scripted.spawnImpl, (text) => emitted.push(text))).toBe(1);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "human-tests", status: "failed" });
    const cases = readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "human")).cases as CaseRecord[];
    const outcomes = cases.map((record) => record.outcome);
    // The first ISSUED case is the complete 403 (inconclusive, non-halting); a later case is the
    // measured unexpected success that halts; anything after it never runs.
    const refused = cases.findIndex((record) => (record as { http_status?: number }).http_status === 403);
    expect(cases[refused]).toMatchObject({ outcome: "inconclusive", response_complete: true });
    const failure = outcomes.indexOf("unexpected-success");
    expect(failure).toBeGreaterThan(refused);
    expect(outcomes.slice(failure + 1).every((outcome) => outcome === "not-run")).toBe(true);
    expect(outcomes.filter((outcome) => outcome === "inconclusive").length).toBeGreaterThan(1);
  });

  // ── the staged cloud finalizers, through the real TOKEN adapter ─────────────────────────────────
  /** A fetch double over the fake provider: ONE scripted request lands (or not) and answers with raw bytes. */
  const cutFetch = (github: ReturnType<typeof createFakeGitHub>, script: (method: string, pathname: string) => { apply: boolean; response: () => unknown } | null) =>
    (async (input: unknown, init: RequestInit = {}) => {
      const scripted = script(String(init.method ?? "GET"), new URL(String(input)).pathname);
      if (!scripted) return github.fetchImpl(input as never, init);
      if (scripted.apply) await github.fetchImpl(input as never, init);
      return scripted.response();
    }) as unknown as typeof fetch;

  async function emergencyStage(github: ReturnType<typeof createFakeGitHub>, caseId: string, deps: Record<string, unknown>) {
    const ordinal = CLOUD_CASE_SEQUENCE.emergency.indexOf(caseId) + 1;
    const env = cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir });
    await runCaseStage({ stage: "prepare", caseId, env, deps });
    publishChallenge(github, "emergency", ordinal, "pre");
    await serveOne(github, { role: "emergency", caseId, ordinal, direction: "pre" });
    await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
    publishChallenge(github, "emergency", ordinal, "post");
    await serveOne(github, { role: "emergency", caseId, ordinal, direction: "post" });
    return runCaseStage({ stage: "await-and-finalize", caseId, env, deps }).then(() => null, (error: Error & { exitCode?: number }) => error);
  }
  const emergencyCli = (deps: Record<string, unknown>, write: (text: string) => void) =>
    main(["emergency-tests", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir], cloudEnv("emergency", EMERGENCY_JOB_ENV), { ...deps, write });
  const emergencyBranch = () => derivedRef(RUN_ID, ATTEMPT, "emergency").replace("refs/heads/", "");
  const stateOf = (ordinal: number) => JSON.parse(readFileSync(path.join(cloudDir("state"), `case-${RUN_ID}-${ATTEMPT}-emergency-${String(ordinal).padStart(2, "0")}.json`), "utf8"));

  it("R02-1/R02-2 · a staged acceptance whose body read fails after the write LANDED finalizes incomplete (exit 3), halts, and the finalizer exits 3", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    let mutations = 0;
    const fetchImpl = cutFetch(github, (method, pathname) => {
      if (method !== "PATCH" || !pathname.endsWith(emergencyBranch())) return null;
      mutations += 1;
      return { apply: true, response: () => streamed(200, [`{"ref":"refs/heads/${emergencyBranch()}","object":{"sha":"`], { error: true }).response };
    });
    const deps = { ...cloudDeps(github), fetchImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    const [first, second] = CLOUD_CASE_SEQUENCE.emergency;
    const error = await emergencyStage(github, first, deps);
    expect(error?.exitCode).toBe(3);
    expect(error?.message).toMatch(/recorded inconclusive: .*no further actor mutation runs/);
    expect(mutations).toBe(1);
    const state = stateOf(1);
    expect(state).toMatchObject({ status: "finalized", halt: true });
    expect(state.record).toMatchObject({
      outcome: "inconclusive", passed: false, request_class: "ambiguous",
      http_status: 0, response_complete: false, response_incomplete: "body-read-failed", measured_status: 200,
    });
    // It landed — the readback shows the requested commit — and that still does not make it accepted.
    expect(state.record.after_sha).toBe(state.record.requested_sha);
    const post = JSON.parse(readFileSync(path.join(cloudDir("challenges"), `${challengeArtifactName({ runId: RUN_ID, attempt: ATTEMPT, role: "emergency", ordinal: 1, direction: "post" })}.json`), "utf8"));
    expect(post).toMatchObject({ request_class: "ambiguous", request_status: 0, request_complete: false });
    // The class is derived from status AND completion: relabelling either decisive refuses.
    for (const laundered of ["accepted", "refused"]) {
      expect(() => assertChallengeShape({ ...post, request_class: laundered }), laundered).toThrow(/but that status is ambiguous/);
      expect(() => assertChallengeShape({ ...post, request_status: 200, request_class: laundered }), laundered).toThrow(/incomplete response.*but that status is ambiguous/);
    }
    // The durable halt: the next case refuses at prepare, before any request.
    const before = github.calls.length;
    await expect(runCaseStage({ stage: "prepare", caseId: second, env: cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps }))
      .rejects.toThrow(/halted this actor/);
    expect(github.calls.slice(before).filter((call) => ["PATCH", "DELETE", "PUT", "POST"].includes(call.method))).toEqual([]);
    // The public actor finalizer reports what was measured: nothing decisive failed, so exit 3.
    github.finish("emergency");
    const emitted: string[] = [];
    expect(await emergencyCli(cloudDeps(github), (text) => emitted.push(text))).toBe(3);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "emergency-tests", status: "incomplete" });
    expect(mutations).toBe(1);
  });

  it("R02-2 · a MIXED staged matrix keeps exit 1: a must-deny write that MOVED the ref is measured even though its answer was cut off", async () => {
    const github = createFakeGitHub({ ignoreRuleTypes: ["non_fast_forward", "update"] });
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    let mutations = 0;
    const fetchImpl = cutFetch(github, (method, pathname) => {
      if (method !== "PATCH" || !pathname.endsWith(emergencyBranch())) return null;
      mutations += 1;
      // The first (accepted) case is answered normally by the provider.
      if (mutations === 1) return null;
      // The force rewind the policy must refuse LANDED, and its answer was cut off mid-body.
      return { apply: true, response: () => streamed(200, [`{"ref":"refs/heads/${emergencyBranch()}","object":`], { error: true }).response };
    });
    const deps = { ...cloudDeps(github), fetchImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
    const [first, second, third] = CLOUD_CASE_SEQUENCE.emergency;
    expect(await emergencyStage(github, first, deps)).toBeNull();
    expect(stateOf(1).record).toMatchObject({ outcome: "accepted", passed: true, response_complete: true });
    const measured = await emergencyStage(github, second, deps);
    // The ref moved on a case that must be denied: that is measured, whatever the response said.
    expect(measured?.exitCode).toBe(1);
    expect(stateOf(2)).toMatchObject({ halt: true, record: { outcome: "unexpected-mutation", response_complete: false, response_incomplete: "body-read-failed", request_class: "ambiguous" } });
    await expect(runCaseStage({ stage: "prepare", caseId: third, env: cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps }))
      .rejects.toThrow(/halted this actor/);
    expect(mutations).toBe(2);
    github.finish("emergency");
    const emitted: string[] = [];
    // Measured failure beside not-run cases: exit 1, never laundered into "incomplete".
    expect(await emergencyCli(cloudDeps(github), (text) => emitted.push(text))).toBe(1);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "emergency-tests", status: "failed" });
  });

  // ── create and dispatch reconciliation, through the real gh adapter ─────────────────────────────
  it("R02-1 · a ruleset create that LANDED but whose answer was cut off is response-ambiguous, never refused, and is not created twice", async () => {
    const github = createFakeGitHub();
    await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
    let cut = false;
    const scripted = scriptedGh(github, ({ method, path: requestPath }) => {
      if (cut || method !== "POST" || !requestPath.endsWith("/rulesets")) return null;
      cut = true;
      return { apply: true, stdout: "HTTP/2.0 201 Created\r\n\r\n{\"id\":", code: 0 };
    });
    await expect(runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl: scripted.spawnImpl } })).rejects.toThrow();
    const records = readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[];
    const result = records.find((record) => record.type === "mutation-result" && record.data.kind === "ruleset")!;
    expect(result.data).toMatchObject({ status: 0, response_complete: false, response_incomplete: "body-malformed", measured_status: 201 });
    const pending = unresolvedCreateIntents(records).find((entry: { intent: { kind?: string } }) => entry.intent?.kind === "ruleset");
    expect(pending).toMatchObject({ state: "response-ambiguous", unresolved: true });
    // Whatever the resume does with it, the same name never exists twice.
    await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl: github.spawnImpl } }).catch(() => null);
    const names = [...github.rulesets.values()].map((ruleset) => ruleset.name);
    expect(new Set(names).size, "a ruleset name was created twice").toBe(names.length);
  });

  it("R02-1 · a cleanup DELETE whose 204 carried stray bytes journals the incomplete answer; removal is decided by readback alone", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    const scripted = scriptedGh(github, ({ method, path: requestPath }) => (method === "DELETE" && /\/git\/refs\/heads\//.test(requestPath)
      ? { apply: true, stdout: "HTTP/2.0 204 No Content\r\n\r\n{\"partial", code: 0 }
      : null));
    await runPhase({ phase: "cleanup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: { spawnImpl: scripted.spawnImpl } }).catch(() => null);
    const results = (readJournal({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }) as JournalRecord[])
      .filter((record) => record.type === "cleanup-result" && record.data.kind === "ref");
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.data).toMatchObject({ status: 0, response_complete: false, response_incomplete: "body-unexpected", measured_status: 204, removed: true });
    }
  });

  async function emergencyFirstPre(github: ReturnType<typeof createFakeGitHub>) {
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.approve("emergency");
    const caseId = CLOUD_CASE_SEQUENCE.emergency[0];
    await runCaseStage({ stage: "prepare", caseId, env: cloudEnv("emergency", { ...EMERGENCY_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }), deps: { ...cloudDeps(github), archiveTransport: github.archiveImpl } });
    publishChallenge(github, "emergency", 1, "pre");
    return caseId;
  }

  it.each([
    ["an empty 204 (complete)", { apply: true, stdout: "HTTP/2.0 204 No Content\r\n\r\n", code: 0 }, "pending", { ambiguous: false, response_complete: true }, 1],
    ["a 204 followed by stray bytes", { apply: true, stdout: "HTTP/2.0 204 No Content\r\n\r\n{\"partial", code: 0 }, "pending", { ambiguous: true, response_complete: false, response_incomplete: "body-unexpected" }, 1],
    ["a truncated refusal", { apply: false, stdout: "HTTP/2.0 422 Unprocessable Entity\r\n\r\n{\"message\":\"Workflow does not", code: 1 }, "pending", { ambiguous: true, response_complete: false, response_incomplete: "body-malformed" }, 0],
    ["a complete refusal", { apply: false, stdout: "HTTP/2.0 422 Unprocessable Entity\r\n\r\n{\"message\":\"Workflow does not have 'workflow_dispatch' trigger\"}", code: 1 }, "refused", { ambiguous: false, response_complete: true }, 0],
  ] as const)("R02-1 · a witness dispatch answered with %s", async (_label, answer, expected, fields, dispatched) => {
    const github = createFakeGitHub({ suppressPublisher: true });
    const caseId = await emergencyFirstPre(github);
    let issued = 0;
    const scripted = scriptedGh(github, ({ method, path: requestPath }) => {
      if (method !== "POST" || !requestPath.endsWith("/dispatches")) return null;
      issued += 1;
      return { ...answer };
    });
    const session = await openWitnessSession({
      runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
      deps: { spawnImpl: scripted.spawnImpl, archiveTransport: github.archiveImpl },
    });
    try {
      const begin = () => beginWitnessItem({
        request: session.request, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
        item: { role: "emergency", caseId, ordinal: 1, direction: "pre" }, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      });
      if (expected === "refused") {
        await expect(begin()).rejects.toThrow(/was refused \(422\)/);
      } else {
        expect((await begin()).state).toBe("pending");
        // Pending is reconciled by the exact artifact, never re-dispatched.
        expect((await begin()).state).toBe("pending");
      }
      expect(issued).toBe(1);
      expect(github.dispatches).toHaveLength(dispatched);
      const results = (session.journal.read() as JournalRecord[]).filter((record) => record.type === "dispatch-result");
      expect(results.map((record) => record.data)).toEqual([expect.objectContaining(fields)]);
    } finally {
      session.lock.release();
    }
  });
});
