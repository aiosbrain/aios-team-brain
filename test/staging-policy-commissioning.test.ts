import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATIONS, ALLOWED_REQUEST_SCOPES, COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH,
  ENVIRONMENT_CONTROL_KEYS, PROTECTED_JOBS, RESULT_SCHEMA_VERSION,
  assertAllowedRequest, assertCasePrecondition, assertDerivedRef, assertManifestBinding,
  assessEvidence, awaitManifestFromRef, buildActorMatrix, buildGraphPlan, classifyCaseOutcome,
  collectSentinels, createRedactor, derivedContextNames, derivedRef, derivedRefs,
  derivedRulesetName, evaluateDisposableCompatibility, evidenceSlug, invertDisposable, main,
  parseArgs, readApplicableBranchRulesets, readEvidenceFile, runCloudTestsPhase, runFixtureChecks,
  runHumanTestsPhase, runIntentPhase, runPhase, transformToDisposable, validateEvidenceBinding,
  writeEvidenceFile,
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
type StoredPull = { number: number; state: string; base: { ref: string }; head: { ref: string }; title?: string };
type ApprovalEntry = { state: string; user: { login: string; type: string }; environments: { name: string }[] };
type ApplicableRule = { type: string; ruleset_id?: number; ruleset_source_type?: string; ruleset_source?: string };

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
  /** What a human approval does: records a review, and lets the parked job run to completion. */
  const approve = (job: string, login = "johnellison", type = "User") => {
    approvals.push({ state: "approved", user: { login, type }, environments: [{ name: JOB_ENVIRONMENTS[job] }] });
    jobState.set(job, { status: "completed", conclusion: "success" });
  };
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

    if (pathname === "/user") return json(200, { login: "johnellison", type: "User", id: 4242 });
    if (pathname === "/installation/repositories") {
      return json(200, { total_count: 1, repository_selection: "selected", repositories: [{ id: REPOSITORY_ID }] });
    }
    if (rel === "") return json(200, { id: REPOSITORY_ID, full_name: COMMISSIONING_REPOSITORY });
    if (rel === "/collaborators/johnellison/permission") return json(200, { permission: "admin" });
    if (rel?.startsWith("/actions/runs/")) {
      if (rel.endsWith("/jobs")) {
        if (faults.jobs) return json(faults.jobs, { message: "Not Found" });
        const rows = options.jobStatus
          ? Object.keys(JOB_NAMES).map((id) => ({ name: JOB_NAMES[id], status: options.jobStatus, conclusion: null }))
          : [...jobState.entries()].map(([id, value]) => ({ name: JOB_NAMES[id], status: value.status, conclusion: value.conclusion }));
        return json(200, { total_count: rows.length, jobs: rows });
      }
      if (rel.endsWith("/approvals")) {
        if (faults.approvals) return json(faults.approvals, { message: "Not Found" });
        return json(200, structuredClone(approvals));
      }
      return json(200, { head_sha: WORKFLOW_SHA, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch", head_branch: "staging" });
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
    if (rel === "/pulls" && method === "POST") {
      const number = (nextPull += 1);
      pulls.set(number, { number, state: "open", base: { ref: body.base }, head: { ref: body.head }, title: body.title });
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
      const denial = evaluate(base, "merge", actor, refs.get(`refs/heads/${pull.head.ref}`)!);
      if (denial) return json(405, { message: denial });
      refs.set(base, refs.get(`refs/heads/${pull.head.ref}`)!);
      return json(200, { merged: true });
    }
    return json(404, { message: "Not Found" });
  }

  const tokenActor = (token: string) => token.replace(/-token$/, "");

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
    approvals, jobState, approve, createNormalJob, faults,
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
  GITHUB_ACTOR: "aios-commissioning-dispatcher[bot]",
  GITHUB_TOKEN: "fixture-token",
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

const localDeps = (github: ReturnType<typeof createFakeGitHub>) => ({ spawnImpl: github.spawnImpl });
const cloudDeps = (github: ReturnType<typeof createFakeGitHub>) => ({ fetchImpl: github.fetchImpl, createInstallationToken: mintToken });

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

/** The whole reviewed order: intent → setup → fixture → normal → human → emergency → cleanup. */
async function commissionEverything(github: ReturnType<typeof createFakeGitHub>) {
  await intentAndSetup(github);
  const fixture = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
  // What GitHub and the human do, in the order they do it: the fixture finishing is what lets
  // `normal` be created at all, and only then can anyone approve it.
  github.createNormalJob();
  github.approve("normal");
  const normal = await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) });
  const human = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
  github.approve("emergency");
  const emergency = await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) });
  return { fixture, normal, human, emergency };
}

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
    await intentAndSetup(github);
    await expect(runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", { ...NORMAL_JOB_ENV, EMERGENCY_APP_PRIVATE_KEY: SENTINEL_KEY }), deps: cloudDeps(github) }))
      .rejects.toThrow(/must not share a job/);
    await expect(runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", { ...NORMAL_JOB_ENV, RELEASE_APP_ID: "999" }), deps: cloudDeps(github) }))
      .rejects.toThrow(/not the identity/);
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

  it("refuses an installation that is not scoped to exactly this repository", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    for (const [label, body] of [
      ["installed org-wide", { total_count: 1, repository_selection: "all", repositories: [{ id: REPOSITORY_ID }] }],
      ["covering a second repository", { total_count: 2, repository_selection: "selected", repositories: [{ id: REPOSITORY_ID }, { id: 999 }] }],
      ["scoped to a different repository", { total_count: 1, repository_selection: "selected", repositories: [{ id: 999 }] }],
    ] as [string, unknown][]) {
      const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/installation/repositories") return new Response(JSON.stringify(body), { status: 200 });
        return github.fetchImpl(input as string, init);
      }) as unknown as typeof fetch;
      await expect(
        runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: { fetchImpl, createInstallationToken: mintToken } }),
        `installation ${label}`,
      ).rejects.toThrow(/installation/);
    }
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
  const controlsFile = (dir: string, overrides: Record<string, unknown> = {}) => writeEvidenceFile(dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
    schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
    controls: Object.fromEntries(ENVIRONMENT_CONTROL_KEYS.map((key: string) => [key, { status: "verified", evidence: `provider readback ${key}` }])),
    ...overrides,
  });

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
      expect(approvals.environments[spec.environment].reviewers).toEqual([{ login: "johnellison", type: "User", is_dispatcher: false }]);
    }
    // The dispatcher is recorded and is explicitly NOT the approver. GITHUB_ACTOR may be a bot.
    expect(approvals.dispatcher).toBe("aios-commissioning-dispatcher[bot]");
    expect(approvals.dispatcher_is_the_approver).toBe(false);
  });

  it("reports an approval by the DISPATCHER as a self-review failure, not as independent approval", async () => {
    const github = createFakeGitHub();
    await intentAndSetup(github);
    await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl, wait: WAIT });
    github.createNormalJob();
    // The same identity that dispatched the run approving its own protected job. The run happened;
    // it is simply not the two-identity evidence PC-06 asks for.
    github.approve("normal", "aios-commissioning-dispatcher[bot]", "Bot");
    github.approve("emergency");
    await runPhase({ phase: "collect", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) }).catch(() => {});
    controlsFile(evidenceDir);
    const { blockers } = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT });
    const selfReview = (blockers as Blocker[]).filter((entry) => entry.kind === "failed" && /self-review/.test(entry.detail));
    expect(selfReview).toHaveLength(1);
    expect(selfReview[0].gate).toBe("PC-06");
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

  it("blocks on EACH named environment control, and cannot be satisfied by one blanket flag", () => {
    // Every control absent.
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .some((entry: Blocker) => entry.gate === "PC-06" && /environment-controls evidence file is absent/.test(entry.detail))).toBe(true);
    // A file that asserts the controls with a single true flag and no per-control evidence.
    controlsFile(evidenceDir, { controls: {}, verified: true });
    const blanket = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .filter((entry: Blocker) => entry.gate === "PC-06" && /control .* is absent/.test(entry.detail));
    expect(blanket).toHaveLength(ENVIRONMENT_CONTROL_KEYS.length);
    // The realistic case: the unauthorized-reviewer control cannot be produced without a second
    // identity, so it stays unverified — and it alone still blocks.
    controlsFile(evidenceDir, {
      controls: {
        ...Object.fromEntries(ENVIRONMENT_CONTROL_KEYS.map((key: string) => [key, { status: "verified", evidence: "provider readback" }])),
        unauthorized_reviewer_refused: { status: "unverified", evidence: "no second reviewer identity is available" },
      },
    });
    const remaining = assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .filter((entry: Blocker) => entry.gate === "PC-06" && /unauthorized_reviewer_refused/.test(entry.detail));
    expect(remaining).toHaveLength(1);
    // A `verified` claim with no evidence reference is not a verification either.
    controlsFile(evidenceDir, {
      controls: Object.fromEntries(ENVIRONMENT_CONTROL_KEYS.map((key: string) => [key, { status: "verified", evidence: "" }])),
    });
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .filter((entry: Blocker) => /marked verified with no evidence reference/.test(entry.detail))).toHaveLength(ENVIRONMENT_CONTROL_KEYS.length);
    // A control outside the closed list is INVALID, not extra credit.
    controlsFile(evidenceDir, { controls: { made_up_control: { status: "verified", evidence: "x" } } });
    expect(assessEvidence({ dir: evidenceDir, runId: RUN_ID, attempt: ATTEMPT }).blockers
      .some((entry: Blocker) => entry.kind === "invalid" && /outside the closed PC-06 list/.test(entry.detail))).toBe(true);
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
    // With the accepted provider evidence for those controls attached, and ONLY then, it passes.
    controlsFile(evidenceDir);
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
    expect((blockers as Blocker[]).some((entry) => entry.gate === "PC-05" && /has no recorded outcome/.test(entry.detail))).toBe(true);
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
    await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) });
    expect(await run(["human-tests", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "human-tests", status: "passed" });
    github.approve("emergency");
    await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) });

    // `collect` BEFORE cleanup gathers what exists and still reports incomplete.
    expect(await run(["collect", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(3);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "collect", status: "incomplete" });
    expect(readEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "approvals")).environments["staging-release"].approved).toBe(true);

    expect(await run(["cleanup", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(0);
    expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ phase: "cleanup", status: "cleaned" });

    // Still 3: the PC-06 environment controls are the one thing this harness cannot produce.
    expect(await run(["check-evidence", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", evidenceDir])).toBe(3);
    writeEvidenceFile(evidenceDir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: RESULT_SCHEMA_VERSION, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
      controls: Object.fromEntries(ENVIRONMENT_CONTROL_KEYS.map((key: string) => [key, { status: "verified", evidence: "provider readback, docs/OPS.md §12" }])),
    });
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
    const errorPathOnly = ["read-organization-ruleset"];
    const declared = ALLOWED_OPERATIONS.map((operation) => operation.id);
    // An allowlisted operation nothing ever issues is either dead surface or an untested path. Both
    // are worth naming out loud rather than leaving in a list nobody re-reads.
    expect(declared.filter((id) => !exercised.has(id)).sort()).toEqual([...errorPathOnly].sort());
    expect(new Set(declared).size, "duplicate operation id").toBe(declared.length);
  });
});
