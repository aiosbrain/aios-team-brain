import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATIONS, COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH,
  assertAllowedRequest, assertCasePrecondition, assertDerivedRef, assertManifestBinding,
  assessEvidence, buildActorMatrix, buildGraphPlan, canonicalHash, classifyCaseOutcome,
  classifyDiagnostic, collectSentinels, createGuardedRequest, createLocalGhTransport,
  createRedactor, derivedContextNames, derivedRef, derivedRefs, derivedRulesetName,
  evaluateDisposableCompatibility, invertDisposable, main, parseArgs, parseGhResponse,
  readApplicableBranchRulesets, readEvidenceFile, runCloudTestsPhase, runFixtureChecks,
  runHumanTestsPhase, runIntentPhase, runPhase, transformToDisposable,
} from "../scripts/staging-ops/policy-commissioning.mjs";
import { buildMainRulesets, REQUIRED_MAIN_CONTEXTS } from "../scripts/staging-ops/main-policy.mjs";
import {
  acquireJournalLock, journalPath, openJournal, readJournal, writeJournalSnapshot,
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

interface FakeOptions {
  /** Rewrite a ruleset on the way OUT, to model provider normalisation or an alien field. */
  rulesetReadback?: (ruleset: any) => any;
  /** Extra rulesets the provider reports as applicable to a derived branch. */
  extraApplicable?: any[];
  /** Force `/rules/branches/*` to a status, to model an unreadable measurement. */
  rulesStatus?: number;
  approvals?: unknown[] | null;
  jobStatus?: string;
  mainProtection?: unknown | null;
}

/**
 * A model of the provider, not a recording of it. Ruleset evaluation below is written from the
 * documented semantics of `non_fast_forward`, `deletion`, `update`, `pull_request` and
 * `required_status_checks` (+ `strict`), including Integration bypass actors — which is what makes
 * a test that expects `emergency` to be accepted and `normal` to be refused a real test.
 */
function createFakeGitHub(options: FakeOptions = {}) {
  const commits = new Map<string, any>();
  const trees = new Map<string, any>();
  const blobs = new Map<string, any>();
  const refs = new Map<string, string>([["refs/heads/main", MAIN_SHA], ["refs/heads/staging", STAGING_SHA]]);
  const rulesets = new Map<number, any>();
  const checks = new Map<string, any[]>();
  const pulls = new Map<number, any>();
  const calls: { actor: string; method: string; path: string }[] = [];
  let nextId = 7000;
  let nextPull = 41;

  const ancestors = (start: string): Set<string> => {
    const out = new Set<string>();
    const walk = (current: string) => {
      for (const parent of commits.get(current)?.parents ?? []) {
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
      const bypassed = (ruleset.bypass_actors ?? []).some((entry: any) =>
        entry.actor_type === "Integration" && entry.actor_id === actor.appId);
      if (bypassed) continue;
      for (const rule of ruleset.rules ?? []) {
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

  function handle(actorName: string, method: string, rawPath: string, body: any) {
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
        return json(200, { jobs: [{ name: "normal", status: options.jobStatus ?? "waiting" }, { name: "emergency", status: options.jobStatus ?? "waiting" }] });
      }
      if (rel.endsWith("/approvals")) {
        return json(200, options.approvals === undefined
          ? [{ state: "approved", user: { login: "johnellison", type: "User" }, environments: [{ name: "staging-release" }, { name: "staging-emergency" }] }]
          : options.approvals);
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
        (ruleset.rules ?? []).map((rule: any) => ({ type: rule.type, ruleset_id: ruleset.id, ruleset_source_type: "Repository", ruleset_source: COMMISSIONING_REPOSITORY })));
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
      const entries = body.tree.map((entry: any) => {
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
    const child = new EventEmitter() as any;
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

  return { fetchImpl, spawnImpl, refs, rulesets, checks, commits, pulls, calls, handle, isFastForward };
}

let evidenceDir = "";
const created: string[] = [];

beforeEach(() => {
  evidenceDir = mkdtempSync(path.join(tmpdir(), "aio1124-"));
  created.push(evidenceDir);
});
afterEach(() => {
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

async function intentAndSetup(github: ReturnType<typeof createFakeGitHub>) {
  const intent = await runIntentPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("intent", { GITHUB_TOKEN: "intent-token" }), deps: cloudDeps(github) });
  const setup = await runPhase({ phase: "setup", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
  return { intent, setup };
}

/** The whole reviewed order: intent → setup → fixture → normal → human → emergency → cleanup. */
async function commissionEverything(github: ReturnType<typeof createFakeGitHub>) {
  await intentAndSetup(github);
  const fixture = await runFixtureChecks(cloudEnv("fixture", { COMMISSIONING_EVIDENCE_DIR: evidenceDir }), { fetchImpl: github.fetchImpl });
  const normal = await runCloudTestsPhase({ role: "normal", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("normal", NORMAL_JOB_ENV), deps: cloudDeps(github) });
  const human = await runHumanTestsPhase({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: LOCAL_ENV, deps: localDeps(github) });
  const emergency = await runCloudTestsPhase({ role: "emergency", runId: RUN_ID, attempt: ATTEMPT, evidenceDir, env: cloudEnv("emergency", EMERGENCY_JOB_ENV), deps: cloudDeps(github) });
  return { fixture, normal, human, emergency };
}

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

  it("declares no operation that can reach a repository other than the fixed one", () => {
    for (const operation of ALLOWED_OPERATIONS) {
      const spelling = operation.path ?? String(operation.pattern);
      expect(spelling.includes(COMMISSIONING_REPOSITORY) || spelling.startsWith("/user") || spelling.startsWith("/installation") || spelling.includes("/orgs/aiosbrain/")).toBe(true);
    }
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
    expect(new Set(result.published.map((entry: any) => entry.node))).toEqual(new Set(["N3"]));
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
      expect(commit.parents.map((parent: any) => parent.sha)).toEqual(node.parents.map((key: string) => setup.synthetic_graph[key]));
      expect(commit.message).toMatch(/^AIO-1124 synthetic commissioning/);
    }
    // D is genuinely unrelated: no shared ancestor with the human ref's head.
    expect(github.isFastForward(setup.synthetic_graph.C, setup.synthetic_graph.D)).toBe(false);
  });
});
