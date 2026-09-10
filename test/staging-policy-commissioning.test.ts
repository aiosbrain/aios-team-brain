import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  assertPublisherContext, assertResponseBinding, assertRoleBinding, assertRunContext, assessEvidence,
  awaitManifestFromRef, buildChallenge, buildGovernedSnapshot, buildResponse, buildActorMatrix,
  buildGraphPlan, openWitnessSession, publishWitnessResponse, readWitnessEnvelopeFromEvent,
  serializeDispatchEnvelope, validateGovernedSnapshot,
  challengeArtifactName, classifyCaseOutcome,
  collectSentinels, comparePermissions, createRedactor, deriveCaseVerdict, derivedContextNames,
  derivedRef, derivedRefs, derivedRulesetName, evaluateDisposableCompatibility, evidenceSlug,
  assertPlannedPolicyApplies, assertSyntheticPullTarget, governedFingerprint, invertDisposable,
  evidenceFileName, main, mintActorCredential, mintAppJwt, parseArgs, projectGovernedRuleset, readAllPages,
  readApplicableBranchRulesets, readEvidenceFile, readSingleEntryZip, recomputeCheckState,
  responseArtifactName, runCaseStage, runCloudTestsPhase, runFixtureChecks,
  runHumanTestsPhase, runIntentPhase, runNormalCheckPublication, runPhase, runRehearsalStage,
  runWitnessPublisherJob, serveWitnessItem, transformToDisposable, unresolvedCreateIntents,
  validateEnvironmentControl, validateEvidenceBinding, verifyWitnessedPolicy, writeEvidenceFile,
} from "../scripts/staging-ops/policy-commissioning.mjs";
import { buildMainRulesets, REQUIRED_MAIN_CONTEXTS } from "../scripts/staging-ops/main-policy.mjs";
import {
  acquireJournalLock, journalPath, openJournal, readJournal, readLockOwner, recoverJournalLock,
} from "../scripts/staging-ops/commissioning-journal.mjs";

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
const STAGING_SHA = "c".repeat(40);
const PRODUCER_IDS = Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context, index) => [context, 900 + index]));
const SENTINEL_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsentinelKEYMATERIAL0123456789\n-----END RSA PRIVATE KEY-----";

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
type ApprovalEntry = { state: string; user: { login: string; type: string }; environments: { name: string }[] };
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
type ProviderResponse = { status: number; diagnostic: { status?: number; category: string; ruleIds: string[]; policyDenial: boolean } };

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
  const refs = new Map<string, string>([["refs/heads/main", MAIN_SHA], ["refs/heads/staging", STAGING_SHA]]);
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
  const approve = (job: string, login = OWNER_LOGIN, type = "User", id = OWNER_USER_ID) => {
    approvals.push({ state: "approved", user: { login, type, id }, environments: [{ name: JOB_ENVIRONMENTS[job] }] });
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
    if (rel === "") return json(200, { id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY });
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
        return json(200, { total_count: rows.length, jobs: rows });
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
      return json(200, { merged: true });
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

async function intentAndSetup(github: ReturnType<typeof createFakeGitHub>) {
  const intent = await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: INTENT_ENV() });
  const setup = await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
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
async function serveOne(github: ReturnType<typeof createFakeGitHub>, item: { role: string; caseId: string; ordinal: number; direction: "pre" | "post" }, overrides: Record<string, unknown> = {}) {
  const session = await openWitnessSession({
    runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
    deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl },
  });
  try {
    return await serveWitnessItem({
      request: session.request, requestArchive: session.requestArchive, ctx: session.ctx, journal: session.journal,
      item, operator: session.operator, domain: session.domain, setupBindings: session.setupBindings,
      now: () => new Date(), sleep: async () => {}, intervalMs: 1, ...overrides,
    });
  } finally { session.lock.release(); }
}

/** Run one case end to end: prepare → upload → serve → execute → upload → serve → finalize. */
async function runCase(github: ReturnType<typeof createFakeGitHub>, role: "normal" | "emergency", caseId: string) {
  const ordinal = CLOUD_CASE_SEQUENCE[role].indexOf(caseId) + 1;
  const env = cloudEnv(role, { ...(role === "normal" ? NORMAL_JOB_ENV : EMERGENCY_JOB_ENV), COMMISSIONING_EVIDENCE_DIR: evidenceDir });
  const deps = { ...cloudDeps(github), archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 };
  await runCaseStage({ stage: "prepare", caseId, env, deps });
  publishChallenge(github, role, ordinal, "pre");
  await serveOne(github, { role, caseId, ordinal, direction: "pre" });
  await runCaseStage({ stage: "await-and-execute", caseId, env, deps });
  publishChallenge(github, role, ordinal, "post");
  await serveOne(github, { role, caseId, ordinal, direction: "post" });
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
async function runRoleCases(github: ReturnType<typeof createFakeGitHub>, role: "normal" | "emergency") {
  const results = [];
  for (const caseId of CLOUD_CASE_SEQUENCE[role]) results.push(await runCase(github, role, caseId));
  return results;
}

/** The whole reviewed order: intent → setup → fixture → normal → human → emergency → cleanup. */
async function commissionEverything(github: ReturnType<typeof createFakeGitHub>) {
  await intentAndSetup(github);
  const fixture = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
  // What GitHub and the human do, in the order they do it: the fixture finishing is what lets
  // `normal` be created at all, and only then can anyone approve it.
  github.createNormalJob();
  github.approve("normal");
  await runNormalCheckPublication({
    env: cloudEnv("normal", { ...NORMAL_JOB_ENV, COMMISSIONING_EVIDENCE_DIR: evidenceDir }),
    deps: cloudDeps(github),
  });
  await runRoleCases(github, "normal");
  github.finish("normal");
  const normal = await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) });
  const human = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
  github.approve("emergency");
  await runRoleCases(github, "emergency");
  github.finish("emergency");
  const emergency = await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) });
  // The local witness process's own summary. Every response is already published, so this RECONCILES
  // all 22 rather than dispatching again — which is the property that makes a restarted witness safe.
  const witness = await runPhase({
    phase: "witness", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV,
    deps: { spawnImpl: github.spawnImpl, archiveTransport: github.archiveImpl, sleep: async () => {}, intervalMs: 1 },
  });
  return { fixture, normal, human, emergency, witness };
}

/**
 * Build a complete, VALID PC-06 environment-controls packet: one bound proof per control per
 * protected environment, each naming a retained artifact whose SHA-256 is recomputed from disk by
 * `assessEvidence`. This is what "not a boolean" costs, and it is the whole point — the packet cannot
 * be satisfied by typing a word.
 */
const environmentControls = (dir: string, mutate: (controls: Record<string, Record<string, unknown>>) => void = () => {}) => {
  const controls: Record<string, Record<string, unknown>> = {};
  const schemas = ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { sources: string[]; expected: unknown; run_bound: boolean }>;
  for (const key of ENVIRONMENT_CONTROL_KEYS as string[]) {
    controls[key] = {};
    for (const [index, spec] of (PROTECTED_JOBS as { environment: string }[]).entries()) {
      const schema = schemas[key];
      const name = `env-${key}-${spec.environment}.json`;
      // The artifact must be ABOUT this control on this environment, with this measurement: reusing
      // one file across controls or environments is a refusal, which is the F2 correction.
      const bytes = Buffer.from(`${JSON.stringify({ control: key, environment: spec.environment, measured: schema.expected }, null, 2)}\n`, "utf8");
      writeFileSync(path.join(dir, name), bytes);
      controls[key][spec.environment] = {
        status: "verified", source: schema.sources[0],
        environment_name: spec.environment, environment_id: 4400 + index,
        expected: schema.expected, measured: schema.expected,
        // Inside the run's window — the journal's first record is stamped by the run itself, so a
        // date far in the future is the safe side of the staleness check for a fixture.
        measured_at: "2099-01-01T00:00:00.000Z",
        ...(schema.run_bound ? { run_id: RUN_ID, attempt: ATTEMPT } : {}),
        artifact: name, artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
  }
  mutate(controls);
  return writeEvidenceFile(dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
    schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls,
  });
};

/** Deterministic, instant timing for the fixture's bounded wait — no real clock, no real sleep. */
const WAIT = { intervalMs: 1, deadlineMs: 1_000, now: () => 0, sleep: async () => {} };

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
    await expect(readApplicableBranchRulesets({ request, branch: "aios-policy-commissioning/run-9001-2-normal" }))
      .rejects.toThrow(/exceeded 20 pages/);
    expect(page).toBe(20);
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

  it("treats a transport failure, a 404 and a bare credential rejection as INCONCLUSIVE, never as enforcement", () => {
    for (const [label, response] of [
      ["a transport timeout", { status: 0, diagnostic: { status: 0, category: "transport-timeout", ruleIds: [], policyDenial: false } }],
      ["a transport failure", { status: 0, diagnostic: { status: 0, category: "transport-unavailable", ruleIds: [], policyDenial: false } }],
      ["a 404", { status: 404, diagnostic: { status: 404, category: "not-found", ruleIds: [], policyDenial: false } }],
      ["a 401", { status: 401, diagnostic: { status: 401, category: "unauthorized", ruleIds: [], policyDenial: false } }],
      ["a rate limit", { status: 403, diagnostic: { status: 403, category: "rate-limited", ruleIds: [], policyDenial: false } }],
    ] as [string, ProviderResponse][]) {
      const verdict = classifyCaseOutcome({
        expected: "denied", response, ...readback(sha("a"), sha("a")), requestedSha: sha("b"), operation: "update",
      });
      // Each of these is equally consistent with the policy simply not existing.
      expect(verdict.outcome, label).toBe("inconclusive");
      expect(verdict.halt, label).toBe(false);
    }
  });

  it("HALTS on an unexpected success or an unexpected mutation, rather than continuing with a proven over-privileged token", () => {
    const success = classifyCaseOutcome({
      expected: "denied", response: { status: 200, diagnostic: { policyDenial: false, category: "ok", ruleIds: [] } },
      ...readback(sha("a"), sha("b")), requestedSha: sha("b"), operation: "update",
    });
    expect(success).toMatchObject({ outcome: "unexpected-success", halt: true });
    // The ref moved despite a refusal: worse than either, and it must stop the actor immediately.
    const mutated = classifyCaseOutcome({
      expected: "denied", response: { status: 422, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: [] } },
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

  it("confirms an AMBIGUOUS response by ONE readback and never retries the mutation", () => {
    const requested = sha("b");
    const verdict = classifyCaseOutcome({
      expected: "accepted", response: { status: 0, diagnostic: { category: "transport-timeout", policyDenial: false, ruleIds: [] } },
      ...readback(sha("a"), requested), requestedSha: requested, operation: "update",
    });
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.reason).toMatch(/not retried/);
    // And when the readback does NOT show the requested commit, it stays inconclusive — a repeat of
    // the mutation is exactly what must not happen next.
    expect(classifyCaseOutcome({
      expected: "accepted", response: { status: 0, diagnostic: { category: "transport-timeout", policyDenial: false, ruleIds: [] } },
      ...readback(sha("a"), sha("a")), requestedSha: requested, operation: "update",
    }).outcome).toBe("inconclusive");
  });

  it("refuses a reported success whose independent readback disagrees", () => {
    expect(classifyCaseOutcome({
      expected: "accepted", response: { status: 200, diagnostic: { category: "ok", policyDenial: false, ruleIds: [] } },
      ...readback(sha("a"), sha("z")), requestedSha: sha("b"), operation: "update",
    })).toMatchObject({ outcome: "unexpected-mutation", halt: true });
  });

  it("requires the PR merge denial to be the WRITER rule, not an incidental red check", () => {
    const base = { expected: "denied" as const, ...readback(sha("a"), sha("a")), requestedSha: sha("b"), operation: "merge" as const, requiresRuleId: "protected-ref-update-restricted" };
    // A merge refused because unrelated CI is red says nothing about who may write to the ref.
    expect(classifyCaseOutcome({ ...base, response: { status: 405, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: ["required-status-checks"] } } }))
      .toMatchObject({ outcome: "inconclusive" });
    expect(classifyCaseOutcome({ ...base, response: { status: 405, diagnostic: { policyDenial: true, category: "policy-denial", ruleIds: ["protected-ref-update-restricted"] } } }))
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
      expect(approvals.environments[spec.environment].reviewers).toEqual([{ login: OWNER_LOGIN, id: OWNER_USER_ID, type: "User", is_dispatcher: false }]);
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
    const proof = artifactFor("proof.json", { control: key, environment, measured: expected });
    const context = { dir: evidenceDir, key, environment, runId: RUN_ID, attempt: ATTEMPT, window: { start: "2026-01-01T00:00:00.000Z" } };
    const good = {
      status: "verified", source: "provider-api", environment_name: environment, environment_id: 4401,
      expected, measured: expected, measured_at: "2026-09-10T09:00:00.000Z", ...proof,
    };
    expect(validateEnvironmentControl(good, context)).toBeNull();

    const falseProof = artifactFor("false-proof.json", { control: key, environment, measured: { prevent_self_review: false } });
    const otherControlProof = artifactFor("other-control.json", { control: "administrators_cannot_bypass", environment, measured: expected });
    const otherEnvProof = artifactFor("other-env.json", { control: key, environment: "staging-emergency", measured: expected });
    const cases: [string, Record<string, unknown>, RegExp][] = [
      // THE REVIEWED PACKET: a measurement that says the control is OFF, dated years ago.
      ["the reviewed hostile record: a FALSE measurement", { ...good, measured: { prevent_self_review: false }, ...falseProof }, /not the required outcome/],
      ["a historical capture time", { ...good, measured_at: "2020-01-01T00:00:00.000Z" }, /before this run's window opened/],
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
    const uiProof = artifactFor("ui-proof.json", { control: uiOnly, environment, measured: uiExpected });
    const uiRecord = { ...good, expected: uiExpected, measured: uiExpected, ...uiProof };
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-api" }, { ...context, key: uiOnly })).toMatch(/does not accept/);
    expect(validateEnvironmentControl({ ...uiRecord, source: "provider-ui" }, { ...context, key: uiOnly })).toBeNull();
    // A run-bound negative case must name the attempt it was produced in.
    const bound = "self_review_refused";
    const boundExpected = (ENVIRONMENT_CONTROL_SCHEMAS as Record<string, { expected: unknown }>)[bound].expected;
    const boundProof = artifactFor("bound-proof.json", { control: bound, environment, measured: boundExpected });
    const boundRecord = { ...good, expected: boundExpected, measured: boundExpected, ...boundProof, run_id: RUN_ID, attempt: ATTEMPT };
    expect(validateEnvironmentControl(boundRecord, { ...context, key: bound })).toBeNull();
    expect(validateEnvironmentControl({ ...boundRecord, attempt: "9" }, { ...context, key: bound })).toMatch(/names a different attempt/);
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
    const declared = ALLOWED_OPERATIONS.map((operation) => operation.id);
    // An allowlisted operation nothing ever issues is either dead surface or an untested path. Both
    // are worth naming out loud rather than leaving in a list nobody re-reads.
    expect(declared.filter((id) => !exercised.has(id)).sort()).toEqual([...errorPathOnly].sort());
    expect(new Set(declared).size, "duplicate operation id").toBe(declared.length);
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
    const checkState = (expectation: string) => ({
      expectation, measured: true, present: 0, producers: [NORMAL_APP],
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
      http_status: 422, diagnostic: { status: 422, category: "repository-rule-violation", ruleIds: ["repository-rule-violation"], policyDenial: true },
      check_state: checkState(kase.checks),
    };
    expect(deriveCaseVerdict(sound, kase, context)).toEqual([]);

    // ── THE TWO REVIEWED NO-OPS ──────────────────────────────────────────────────────────────────
    const green = buildActorMatrix().find((entry) => entry.id === "normal-update-all-green")!;
    const noopAccept = {
      case: green.id, actor: "normal", operation: "update", force: false, expected: "accepted", ref,
      outcome: "accepted", passed: true, before_sha: graph.A, requested_sha: graph.A, after_sha: graph.A,
      http_status: 200, diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false },
      check_state: checkState(green.checks),
    };
    expect(deriveCaseVerdict(noopAccept, green, context).join("; "))
      .toMatch(/requests the commit the ref is already at, which is a no-op/);
    const rewind = buildActorMatrix().find((entry) => entry.id === "normal-force-rewind")!;
    const noopForce = {
      case: rewind.id, actor: "normal", operation: "force", force: true, expected: "denied", ref,
      outcome: "denied", passed: true, before_sha: graph.N4, after_sha: graph.N4, requested_sha: graph.N4,
      http_status: 422, diagnostic: { status: 422, category: "non-fast-forward-rejected", ruleIds: ["non-fast-forward-rejected"], policyDenial: true },
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
      ["a denial that is not a client refusal", { http_status: 200 }, /not a client refusal/],
      ["a before SHA that is not its graph node", { before_sha: graph.B }, /not the journaled synthetic node A/],
      ["a requested SHA that is not its graph node", { requested_sha: graph.N2 }, /not the journaled synthetic node N1/],
      ["an unmeasured check state", { check_state: { expectation: kase.checks, measured: false } }, /check state was measured/],
      // The declared expectation is RECOMPUTED from the per-context rows: `measured: true` beside a
      // contradictory measurement was previously sufficient.
      ["a check measurement that contradicts its own expectation", { check_state: { ...checkState(kase.checks), contexts: checkState("all-green-expected-producer").contexts } }, /requires to be absent as present/],
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
      .rejects.toThrow(/exceeded 20 pages/);
    expect(page).toBe(20);
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
    const response = {
      schema_version: 1, kind: "commissioning-witness-response",
      challenge_nonce: "a".repeat(64), challenge_digest: "b".repeat(64),
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:00.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: { padding: "x".repeat(80_000) },
    };
    expect(() => serializeDispatchEnvelope({ response })).toThrow(/beyond this harness's 60000-byte bound/);
    const small = { ...response, observation: { padding: "x" } };
    const envelope = serializeDispatchEnvelope({ response: small });
    expect(envelope.bytes).toBeLessThan(60_000);
    // The bound is measured on the WHOLE serialized body, not on the inner witness string.
    expect(envelope.serialized.length).toBeGreaterThan(envelope.witness.length);
    expect(() => serializeDispatchEnvelope({ response: small, mode: "commission" })).toThrow(/runs only in policy-witness mode/);
  });

  it("refuses a response whose nonce, binding, ordering or expiry does not hold", () => {
    const created = "2026-09-10T09:00:00.000Z";
    const binding = {
      domain: "commission", repository: COMMISSIONING_REPOSITORY, repository_id: REPOSITORY_ID,
      source_mode: "commission", original_run_id: RUN_ID, original_attempt: ATTEMPT,
      workflow_path: COMMISSIONING_WORKFLOW_PATH, source_sha: WORKFLOW_SHA,
      role: "normal", job_id: "normal", case_id: "normal-update-missing-check", case_ordinal: 1,
      direction: "pre", target_ref: derivedRef(RUN_ID, ATTEMPT, "normal"),
      intended_app_id: NORMAL_APP, intended_installation_id: "5001",
      manifest_sha256: "c".repeat(64), graph_sha256: "d".repeat(64),
    };
    const nonce = "e".repeat(64);
    const challenge = buildChallenge({ binding, nonce, createdAt: created, extra: { before_sha: sha("A"), requested_sha: sha("N1") } });
    const digest = createHash("sha256").update("challenge-bytes").digest("hex");
    const observation = { started_at: created, completed_at: created, span_ms: 0, governed_rulesets: [], classic_protection: { present: false, status: 404 } };
    const identity = { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" };
    const response = buildResponse({ challenge, challengeDigest: digest, observation, witnessIdentity: identity, createdAt: created });
    expect(assertResponseBinding(response, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: "2026-09-10T09:01:00.000Z" })).toBe(true);

    // A NONCE this job never created — the replay of a valid response to another challenge.
    expect(() => assertResponseBinding({ ...response, challenge_nonce: "f".repeat(64) }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/answers a nonce this job did not create/);
    // Challenge BYTES this job never published.
    expect(() => assertResponseBinding({ ...response, challenge_digest: "0".repeat(64) }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/answers challenge bytes this job did not publish/);
    // Every binding field, one at a time.
    for (const [field, value] of [
      ["case_id", "normal-delete"], ["direction", "post"], ["role", "emergency"],
      ["source_sha", sha("moved")], ["original_attempt", "9"], ["intended_app_id", EMERGENCY_APP],
      ["manifest_sha256", "9".repeat(64)], ["graph_sha256", "9".repeat(64)], ["job_id", "emergency"],
      ["source_mode", "transport-rehearsal"], ["domain", "rehearsal"],
    ] as [string, unknown][]) {
      expect(() => assertResponseBinding({ ...response, [field]: value }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }), field)
        .toThrow(new RegExp(`response's ${field} is not the value this job derived`));
    }
    // CLOCK ORDER: a response created before the challenge it answers is impossible, and impossible
    // is a refusal rather than a tolerance to widen. No positive skew allowance exists.
    expect(() => assertResponseBinding({ ...response, created_at: "2026-09-10T08:59:00.000Z" }, { challenge, challengeDigest: digest, expectedBinding: binding, receivedAt: created }))
      .toThrow(/predates the challenge it answers/);
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
      challenge_nonce: "a".repeat(64), challenge_digest: "b".repeat(64),
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:00.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: { inert: true },
    };
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
    const result = publishWitnessResponse({
      response: { ...ok, repository: COMMISSIONING_REPOSITORY, workflow_path: COMMISSIONING_WORKFLOW_PATH, source_sha: WORKFLOW_SHA, original_run_id: RUN_ID, original_attempt: ATTEMPT, role: "normal", case_ordinal: 1, direction: "pre", case_id: "x", domain: "commission" },
      envelope, publisherRunId: "77001",
      expected: { repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA },
      writeEntry: (name, bytes) => { written.push({ name, bytes }); return `/tmp/${name}`; },
    });
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe("witness.json");
    expect(written[0].bytes.toString("utf8")).toBe(envelope);
    expect(result.entry_digest).toBe(createHash("sha256").update(Buffer.from(envelope, "utf8")).digest("hex"));
    expect(result.note).toMatch(/does not attest that the measurement inside is true/);
    // A source that is not the one this publisher ran is refused before a byte is written.
    expect(() => publishWitnessResponse({
      response: { ...ok, repository: COMMISSIONING_REPOSITORY, workflow_path: COMMISSIONING_WORKFLOW_PATH, source_sha: sha("moved"), original_run_id: RUN_ID, original_attempt: ATTEMPT, role: "normal", case_ordinal: 1, direction: "pre", case_id: "x", domain: "commission" },
      envelope, publisherRunId: "77001",
      expected: { repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: WORKFLOW_SHA },
      writeEntry: () => "/tmp/x",
    })).toThrow(/immutable source is not the source this publisher ran/);
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
      challenge_expires_at: "2026-09-10T09:03:00.000Z", created_at: "2026-09-10T09:00:00.000Z",
      witness_identity: { login: OWNER_LOGIN, user_id: OWNER_USER_ID, type: "User" },
      observation: { started_at: "2026-09-10T09:00:00.000Z", completed_at: "2026-09-10T09:00:01.000Z", span_ms: 1000, governed_rulesets: [], classic_protection: { present: false, status: 404 } },
    };
    const envelope = JSON.stringify(response);
    const eventPath = path.join(evidenceDir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: { mode: "policy-witness", witness_envelope: envelope } }));
    const outputPath = path.join(evidenceDir, "step-output.txt");
    writeFileSync(outputPath, "");
    // The publisher run: the authorized local identity, attempt 1, the reviewed workflow, the source
    // it checked out. `77500` is registered as a publisher run so the fake answers for it.
    github.publishWitness(envelope);
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
    const published = await runWitnessPublisherJob(env, { fetchImpl: github.fetchImpl });
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
    await expect(runWitnessPublisherJob({ ...env, GITHUB_JOB: "normal" }, { fetchImpl: github.fetchImpl }))
      .rejects.toThrow(/runs only in the policy-witness job/);
    await expect(runWitnessPublisherJob({ ...env, COMMISSIONING_MODE: "commission" }, { fetchImpl: github.fetchImpl }))
      .rejects.toThrow(/runs only in policy-witness mode/);
    await expect(runWitnessPublisherJob({ ...env, GITHUB_RUN_ATTEMPT: "2" }, { fetchImpl: github.fetchImpl }))
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
        now: () => new Date(), sleep: async () => {}, intervalMs: 1,
      });
    } finally { witnessSession.lock.release(); }
    const consumed = await runRehearsalStage({ stage: "consume", env: rehearsalEnv, deps });
    expect(consumed.status).toBe("rehearsed");
    expect(consumed.note).toMatch(/NO enforcement verdict, NO policy measurement and NO actor authority/);
    expect(consumed.domain).toBe("rehearsal");
    // The rehearsal's response is an INERT observation, so no actor could reason about it as policy.
    const response = JSON.parse(readSingleEntryZip([...github.artifacts.values()].find((a) => a.name.startsWith("commissioning-witness-88001"))!.zip).bytes.toString("utf8"));
    expect(response.observation.inert).toBe(true);
    expect(response.observation.governed_rulesets).toBeUndefined();
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
