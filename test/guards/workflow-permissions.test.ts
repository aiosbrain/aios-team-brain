import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * RELPTR-3, Decision 5 — the workflow token's write grants are CONFIGURATION, not law, so they get a
 * guard. Spec: `docs/design/release-pointer-cutover-guard.md` (criteria 9, 10).
 *
 * WHY THIS EXISTS. The release-candidate gate's safety rests on a fact about this repository: no
 * automation can mint a required context on a commit the gate never examined. That is true today
 * because the repo default is `default_workflow_permissions: "read"` and every workflow is read-only —
 * and it is ONE pull request away from being false, because a `pull_request` run executes the PR's OWN
 * copy of the workflow. Three routes, all found by pre-code or code review:
 *
 *   1. `contents: write`  → push or delete `refs/tags/*` during the PR's own run.
 *   2. `statuses: write`  → POST a commit status named `Release candidate gate` onto ANY SHA. This is
 *                           not theoretical: it is exactly how `nda-gate.yml` satisfies its own
 *                           required context today, verified on PR #663's head. Same namespace as a
 *                           required check, arbitrary SHA.
 *   3. `checks: write`    → the same, through the checks API.
 *
 * A guard cannot PREVENT any of these; it turns a silent capability grant into a red diff.
 *
 * WHY IT PARSES YAML RATHER THAN MATCHING TEXT. The first version used regexes and both reviewers
 * broke it the same way: `contents: write # for tag push` (a trailing comment — and a comment on a
 * permission line is THIS REPO'S OWN IDIOM, see `nda-gate.yml`), `contents: "write"` (quoted), and
 * `permissions: { contents: write }` (flow mapping) are all valid YAML that the anchors missed. A
 * guard that cannot express the shape it is guarding against is decoration.
 *
 * SCOPE LIMIT, STATED. This reads `GITHUB_TOKEN` permissions only. Credentials supplied through
 * repository SECRETS (a PAT, a deploy key) are outside it, and nothing here claims otherwise.
 */

const WORKFLOWS = join(__dirname, "..", "..", ".github", "workflows");
const files = () => readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
/** A parsed workflow. Deliberately loose — this guard inspects arbitrary YAML, including shapes that
 *  are not valid workflows, because the shapes it must CATCH are the ones nobody would write on purpose. */
type Job = {
  permissions?: unknown;
  name?: unknown;
  if?: unknown;
  steps?: unknown;
  environment?: unknown;
  secrets?: unknown;
};
type Workflow = { on?: unknown; permissions?: unknown; env?: unknown; jobs?: Record<string, Job> };
const load = (f: string) => parseYaml(readFileSync(join(WORKFLOWS, f), "utf8")) as Workflow;

type Grant = { scope: string; value: string; where: string };

/**
 * Every write grant a workflow requests, at the workflow level AND per job.
 * `permissions: write-all` is normalised to the scope `*`, because it includes every scope below.
 */
export function writeGrants(doc: Workflow): Grant[] {
  const out: Grant[] = [];
  const collect = (perms: unknown, where: string) => {
    if (perms == null) return;
    if (typeof perms === "string") {
      if (perms.trim() === "write-all") out.push({ scope: "*", value: "write-all", where });
      return;
    }
    if (typeof perms !== "object") return;
    for (const [scope, value] of Object.entries(perms as Record<string, unknown>)) {
      if (String(value).trim() === "write") out.push({ scope, value: "write", where });
    }
  };
  collect(doc?.permissions, "workflow");
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    collect(job?.permissions, `job:${jobId}`);
  }
  return out;
}

/** Scopes that let a workflow mint a required context or move a ref. Each traces to a real route. */
const FORGING_SCOPES = new Set(["contents", "statuses", "checks", "*"]);

/** The ONE workflow allowed a forging scope, and exactly which. Anything else is a new capability. */
const ALLOWLIST: Record<string, Set<string>> = {
  // Publishes its trusted verdict onto the validated PR head — the whole point of the NDA gate.
  "nda-gate.yml": new Set(["statuses"]),
};

/**
 * The exemption is CONDITIONAL on the shape that makes it safe, not on the filename.
 *
 * Codex, round 2, and this one mattered: keying the allowlist on the basename alone meant a
 * same-repository pull request could EDIT `nda-gate.yml` — keep `pull_request_target`, ADD
 * `pull_request`, and add a job that POSTs `state=success, context='Release candidate gate'` onto any
 * sha — and the guard would pass, because the basename was retained. `nda-gate.test.ts` does not close
 * it either: it asserts `pull_request_target:` is PRESENT and never that `pull_request:` is absent.
 *
 * What makes nda-gate's grant safe is that it runs the BASE copy of the workflow
 * (`pull_request_target`), never a PR's own edited copy. So that is what is checked. A file that gains
 * an untrusted trigger loses the exemption and reddens.
 */
export function allowlistApplies(file: string, doc: Workflow): boolean {
  if (!(file in ALLOWLIST)) return false;
  const triggers = Object.keys((doc as { on?: Record<string, unknown> })?.on ?? {});
  // The line is drawn at WHOSE COPY of the workflow runs, not at "which triggers look scary".
  // `pull_request` runs the PULL REQUEST'S OWN edited copy, before any merge — that is the route.
  // `workflow_call` can be invoked BY such a workflow, inheriting the grant, so it is on the list too.
  // `pull_request_target` and `push` run the base/pushed-ref copy, which a pull request cannot edit;
  // nda-gate legitimately declares both. (Narrowed after an over-broad first attempt that included
  // `push` and would have reddened the real file for a reason I could not defend.)
  const prControlled = ["pull_request", "workflow_call"];
  return triggers.includes("pull_request_target") && !prControlled.some((t) => triggers.includes(t));
}

/**
 * AIO-1124 — the ONE job-level exception: the commissioning fixture's `checks: write`.
 *
 * WHY IT IS NEEDED. `release-policy-commissioning.yml` exercises the release Apps against real ruleset
 * enforcement on disposable refs, and its actor matrix needs a SECOND independent measured producer of
 * check runs (the GitHub Actions app) to have any wrong-producer control case at all. Minting a
 * TEST-ONLY check name on a journalled synthetic commit requires `checks: write`. There is no way to
 * obtain it without the grant, and no way to keep the grant without saying so here.
 *
 * WHY IT IS SAFE — and therefore what is CHECKED, since none of it is implied by the filename:
 *
 *   1. **Nobody but a maintainer can start it.** `workflow_dispatch` ONLY, with no inputs (so no
 *      caller-supplied repo, ref or resource name), and the job's own `if` pins repository + branch +
 *      event. That `if` is compared by EXACT normalised equality, never `contains`: `A && B && C` and
 *      `A && B && C || true` both "contain" every clause, and the second admits everything.
 *   2. **It runs reviewed code.** The checkout pins the immutable `github.sha` of the dispatch, not the
 *      moving branch name, with `persist-credentials: false`.
 *   3. **It cannot become a release actor.** No App secret, no protected environment, no reusable-
 *      workflow `secrets:` forwarding, and no value taken from a credentialed job's outputs. A job that
 *      can mint a check must not also be able to move a ref.
 *
 * The exception is JOB-LEVEL AND SCOPE-LEVEL. A workflow-level `checks: write` in the same file, the
 * same grant on any other job in it, or any other forging scope on the fixture, is NOT exempt — the
 * grant would then be in scope of jobs that hold the release App private keys. Anything malformed or
 * missing (no `on:`, no fixture job, a non-mapping document) yields NO exception, so an
 * un-analysable file reddens rather than passing by default.
 */
const COMMISSIONING = {
  file: "release-policy-commissioning.yml",
  job: "fixture",
  scope: "checks",
  admission:
    "github.event_name == 'workflow_dispatch' && " +
    "github.repository == 'aiosbrain/aios-team-brain' && " +
    "github.ref == 'refs/heads/staging'",
} as const;

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * Normalise an `if:` for EXACT comparison: collapse a folded/block scalar to one line, then unwrap a
 * single whole-string `${{ … }}`, which is the same condition to GitHub and would otherwise make a
 * legal refactor a false red. The unwrap is whole-string only, so `${{ A }} && ${{ B }}` does not
 * splice into one expression — it simply fails to match.
 */
const normaliseIf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim();
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(flat);
  return (wrapped ? wrapped[1] : flat).trim();
};
/** `secrets.NAME` and the indexed `secrets['NAME']` spelling a name sweep would miss. */
const reachesSecrets = (node: unknown): boolean => /secrets\s*[.[]/.test(JSON.stringify(node ?? null));

export function commissioningFixtureExemption(file: string, doc: Workflow): boolean {
  if (file !== COMMISSIONING.file || !isMap(doc)) return false;

  // (1a) Dispatch-only, and no input surface. Exact key-set equality: an ADDED `pull_request` or
  // `workflow_call` trigger would run a copy of this file that the maintainer never dispatched.
  const on = (doc as { on?: unknown }).on;
  if (!isMap(on) || Object.keys(on).length !== 1 || !("workflow_dispatch" in on)) return false;
  if (on.workflow_dispatch != null) return false; // an empty body parses to null; anything else takes input

  const fixture = isMap(doc.jobs) ? (doc.jobs as Record<string, unknown>)[COMMISSIONING.job] : undefined;
  if (!isMap(fixture)) return false;

  // (1b) The job's own admission, verbatim.
  if (normaliseIf(fixture.if) !== COMMISSIONING.admission) return false;

  // (2) The immutable dispatch SHA, credentials dropped — on EVERY checkout in the job, and there
  // must be at least one, since a job with no checkout has nothing reviewed to run.
  const steps = Array.isArray(fixture.steps) ? fixture.steps : [];
  const checkouts = steps.filter(
    (s) => isMap(s) && typeof s.uses === "string" && s.uses.startsWith("actions/checkout@")
  ) as Record<string, unknown>[];
  if (checkouts.length === 0) return false;
  for (const step of checkouts) {
    const w = isMap(step.with) ? step.with : {};
    if (w.ref !== "${{ github.sha }}") return false;
    if (w["persist-credentials"] !== false) return false;
  }

  // (3) No route to a release credential: no protected environment, no `secrets:` forwarding to a
  // reusable workflow, no `secrets.*` reference anywhere in the job, no workflow-level `env` carrying
  // one into its scope, and no value consumed from another job's outputs.
  if (fixture.environment !== undefined || fixture.secrets !== undefined) return false;
  if (reachesSecrets(fixture) || reachesSecrets(doc.env)) return false;
  if (/needs\.[A-Za-z0-9_-]+\.outputs/.test(JSON.stringify(fixture))) return false;

  return true;
}

export function forgingGrants(file: string, doc: Workflow): Grant[] {
  const allowed = allowlistApplies(file, doc) ? ALLOWLIST[file] : new Set<string>();
  const fixtureExempt = commissioningFixtureExemption(file, doc);
  const isCommissioningFixtureGrant = (g: Grant) =>
    // Keyed on WHERE as well as scope: `where` is `job:fixture` only for a job-level grant, so a
    // workflow-level `checks: write` in the same file stays an offender.
    fixtureExempt &&
    g.where === `job:${COMMISSIONING.job}` &&
    g.scope === COMMISSIONING.scope &&
    g.value === "write";
  return writeGrants(doc).filter(
    (g) => FORGING_SCOPES.has(g.scope) && !allowed.has(g.scope) && !isCommissioningFixtureGrant(g)
  );
}

describe("guard: no workflow may acquire a context-forging write grant (criterion 9)", () => {
  it("no workflow requests an unallowlisted contents/statuses/checks/write-all grant", () => {
    const offenders = files().flatMap((f) =>
      forgingGrants(f, load(f)).map((g) => `${f} [${g.where}] ${g.scope}: ${g.value}`)
    );
    expect(offenders, `these could mint a context or move a ref:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("actually reads a non-trivial set of workflows, so a rename cannot empty it", () => {
    expect(files().length).toBeGreaterThan(4);
    expect(files()).toContain("release-candidate.yml");
  });

  // ONE CONDITION PER FIXTURE — each spelling gets its own, because a fixture carrying two proves
  // only whichever term is evaluated first. Every spelling below was one BOTH reviewers used to
  // break the regex version of this guard.
  it.each([
    ["plain", "permissions:\n  contents: write\n"],
    ["trailing comment (this repo's own idiom)", "permissions:\n  contents: write # for the tag push\n"],
    ["quoted", 'permissions:\n  contents: "write"\n'],
    ["flow mapping", "permissions: { contents: write }\n"],
    ["job-level, not workflow-level", "jobs:\n  a:\n    permissions:\n      contents: write\n"],
    ["blanket write-all", "permissions: write-all\n"],
    ["statuses (mints a status in the required-context namespace)", "permissions:\n  statuses: write\n"],
    ["checks", "permissions:\n  checks: write\n"],
  ])("is NON-VACUOUS for: %s", (_label, yaml) => {
    expect(forgingGrants("some-new-workflow.yml", parseYaml(yaml))).not.toEqual([]);
  });

  it.each([
    ["read", "permissions:\n  contents: read\n"],
    ["read-all", "permissions: read-all\n"],
    ["an unrelated write scope", "permissions:\n  issues: write\n"],
    ["no permissions block at all", "jobs:\n  a:\n    runs-on: ubuntu-latest\n"],
  ])("does NOT flag: %s", (_label, yaml) => {
    expect(forgingGrants("some-new-workflow.yml", parseYaml(yaml))).toEqual([]);
  });

  it("the allowlist is CONDITIONAL on the trusted trigger shape, not on the filename", () => {
    // Codex, round 2: keying on the basename let a same-repo PR edit nda-gate.yml to keep
    // `pull_request_target`, ADD `pull_request`, and post a forged status from its own edited copy —
    // all while the guard stayed green because the filename had not changed.
    const trusted = "on:\n  pull_request_target:\n    branches: [main]\npermissions:\n  statuses: write\n";
    const hijacked = "on:\n  pull_request_target:\n    branches: [main]\n  pull_request:\npermissions:\n  statuses: write\n";
    expect(forgingGrants("nda-gate.yml", parseYaml(trusted)), "trusted shape keeps the exemption").toEqual([]);
    expect(forgingGrants("nda-gate.yml", parseYaml(hijacked)), "an added pull_request trigger loses it").not.toEqual([]);
    // The real file must still qualify — otherwise this guard is red for the wrong reason.
    expect(allowlistApplies("nda-gate.yml", load("nda-gate.yml"))).toBe(true);
    // …and a file with the right name but NO trusted trigger gets nothing.
    expect(allowlistApplies("nda-gate.yml", parseYaml("on:\n  push:\n"))).toBe(false);
  });

  it("allowlists nda-gate's `statuses: write` NARROWLY — that one file, that one scope", () => {
    // It is an allowlist, and it is deliberately keyed on both file AND scope: the same grant in any
    // other workflow is the forge route above, and a different scope in nda-gate is not covered.
    const trusted = (perms: string) => parseYaml(`on:\n  pull_request_target:\n${perms}`);
    expect(forgingGrants("nda-gate.yml", trusted("permissions:\n  statuses: write\n"))).toEqual([]);
    expect(forgingGrants("nda-gate.yml", trusted("permissions:\n  contents: write\n"))).not.toEqual([]);
    expect(forgingGrants("other.yml", parseYaml("permissions:\n  statuses: write\n"))).not.toEqual([]);
    // …and the real file still only wants what the allowlist grants it.
    expect(forgingGrants("nda-gate.yml", load("nda-gate.yml"))).toEqual([]);
    expect(writeGrants(load("nda-gate.yml")).map((g) => g.scope)).toEqual(["statuses"]);
  });
});

/**
 * AIO-1124 — the fixture exception, proved in BOTH directions.
 *
 * Everything below is built by mutating ONE trusted synthetic document, so each negative differs from
 * an accepted file by exactly the thing it names. The accepted case is asserted first: a negative
 * suite over a base that was never accepted proves only that the base was broken.
 */
describe("guard: the commissioning fixture's `checks: write` is exempt ONLY in its exact trusted shape", () => {
  const COMMISSIONING_FILE = "release-policy-commissioning.yml";
  const ADMISSION =
    "github.event_name == 'workflow_dispatch' && " +
    "github.repository == 'aiosbrain/aios-team-brain' && " +
    "github.ref == 'refs/heads/staging'";
  const SHA = "${{ github.sha }}";

  type TestStep = { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> };
  type TestJob = {
    if?: string;
    needs?: string | string[];
    environment?: string;
    secrets?: unknown;
    permissions?: unknown;
    steps?: TestStep[];
  };
  type TestDoc = {
    on?: unknown;
    env?: Record<string, string>;
    permissions?: unknown;
    jobs: Record<string, TestJob>;
  };

  const perms = (extra: Record<string, string> = {}) => ({ contents: "read", actions: "read", ...extra });
  const checkout = (over: Record<string, unknown> = {}): TestStep => ({
    uses: "actions/checkout@v7",
    with: { ref: SHA, "persist-credentials": false, ...over },
  });

  /** The trusted shape, in the same wiring as the real file: a credentialed sibling job included, so
   *  "the fixture holds no secret" is a real distinction rather than an artefact of a bare fixture. */
  const commissioning = (mutate: (d: TestDoc) => void = () => {}): Workflow => {
    const doc: TestDoc = {
      on: { workflow_dispatch: null },
      permissions: perms(),
      jobs: {
        intent: { if: ADMISSION, permissions: perms(), steps: [checkout()] },
        fixture: {
          if: ADMISSION,
          needs: "intent",
          permissions: perms({ checks: "write" }),
          steps: [checkout(), { run: "node -e 'await runFixtureChecks(process.env)'", env: { GITHUB_TOKEN: "${{ github.token }}" } }],
        },
        normal: {
          if: ADMISSION,
          needs: ["intent", "fixture"],
          environment: "staging-release",
          permissions: perms(),
          steps: [checkout(), { run: "node scripts/staging-ops/policy-commissioning.mjs normal-tests", env: { RELEASE_APP_PRIVATE_KEY: "${{ secrets.RELEASE_APP_PRIVATE_KEY }}" } }],
        },
      },
    };
    mutate(doc);
    return doc as Workflow;
  };

  /** The grants the guard would report, as `where scope` pairs — the shape every negative asserts on. */
  const reported = (file: string, doc: Workflow) => forgingGrants(file, doc).map((g) => `${g.where} ${g.scope}`);

  it("accepts the REAL workflow, which wants that ONE grant and nothing else", () => {
    const real = load(COMMISSIONING_FILE);
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, real)).toBe(true);
    expect(forgingGrants(COMMISSIONING_FILE, real)).toEqual([]);
    // If the real file ever wants a second write grant, the exemption must not quietly absorb it.
    expect(writeGrants(real)).toEqual([{ scope: "checks", value: "write", where: "job:fixture" }]);
  });

  it("accepts the synthetic trusted shape, so every negative below differs by exactly one thing", () => {
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, commissioning())).toBe(true);
    expect(forgingGrants(COMMISSIONING_FILE, commissioning())).toEqual([]);
  });

  it("is keyed on the FILE: the identical shape under any other name is not exempt", () => {
    expect(commissioningFixtureExemption("other.yml", commissioning())).toBe(false);
    expect(reported("other.yml", commissioning())).toEqual(["job:fixture checks"]);
    // …and it does not leak into the NDA allowlist's file either, in either direction.
    expect(reported("nda-gate.yml", commissioning())).toEqual(["job:fixture checks"]);
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, parseYaml("on:\n  pull_request_target:\npermissions:\n  statuses: write\n"))).toBe(false);
  });

  // The grant itself must be the exact one reviewed: THAT job, THAT scope, at the JOB level.
  it.each<[string, (d: TestDoc) => void, string[]]>([
    [
      "the same grant on a DIFFERENT job in the same file",
      (d) => { d.jobs.intent.permissions = perms({ checks: "write" }); },
      ["job:intent checks"],
    ],
    [
      "the grant hoisted to the WORKFLOW level, where the App-key jobs would inherit it",
      (d) => { d.permissions = perms({ checks: "write" }); d.jobs.fixture.permissions = perms(); },
      ["workflow checks"],
    ],
    [
      "a DIFFERENT forging scope on the fixture (contents)",
      (d) => { d.jobs.fixture.permissions = perms({ contents: "write" }); },
      ["job:fixture contents"],
    ],
    [
      "a different forging scope on the fixture (statuses — the required-context namespace)",
      (d) => { d.jobs.fixture.permissions = perms({ statuses: "write" }); },
      ["job:fixture statuses"],
    ],
    [
      "blanket write-all on the fixture, which INCLUDES checks",
      (d) => { d.jobs.fixture.permissions = "write-all"; },
      ["job:fixture *"],
    ],
  ])("rejects the wrong grant: %s", (_label, mutate, expected) => {
    // The shape is still trusted here — it is the GRANT that is out of scope, so the exemption stands
    // and simply does not cover this one.
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, commissioning(mutate))).toBe(true);
    expect(reported(COMMISSIONING_FILE, commissioning(mutate))).toEqual(expected);
  });

  // Everything that makes the grant safe. Each of these loses the exemption entirely.
  it.each<[string, (d: TestDoc) => void]>([
    ["an added pull_request trigger runs a PR's own edited copy", (d) => { (d.on as Record<string, unknown>).pull_request = null; }],
    ["an added workflow_call trigger lets another workflow inherit the grant", (d) => { (d.on as Record<string, unknown>).workflow_call = null; }],
    ["an added push trigger fires without a maintainer dispatching it", (d) => { (d.on as Record<string, unknown>).push = { branches: ["staging"] }; }],
    ["dispatch inputs give a caller somewhere to type a repo or ref", (d) => { d.on = { workflow_dispatch: { inputs: { ref: { required: true } } } }; }],
    ["no `on:` at all is un-analysable, not a pass", (d) => { delete d.on; }],
    ["a different repository in the admission", (d) => { d.jobs.fixture.if = ADMISSION.replace("aiosbrain/aios-team-brain", "attacker/fork"); }],
    ["a different ref in the admission", (d) => { d.jobs.fixture.if = ADMISSION.replace("refs/heads/staging", "refs/heads/main"); }],
    ["a different event in the admission", (d) => { d.jobs.fixture.if = ADMISSION.replace("workflow_dispatch", "push"); }],
    ["the repository clause dropped", (d) => { d.jobs.fixture.if = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/staging'"; }],
    // THE CONTAINS TRAP: `A && B && C || true` contains every clause and admits everything. This is
    // why the admission is compared by equality and not with `.toContain`.
    ["a disjunction appended, which contains every clause and admits everything", (d) => { d.jobs.fixture.if = `${ADMISSION} || true`; }],
    ["a disjunction on an actor, same trap", (d) => { d.jobs.fixture.if = `${ADMISSION} || github.actor == 'someone'`; }],
    ["no admission condition at all", (d) => { delete d.jobs.fixture.if; }],
    ["the checkout moved to the MOVING branch name", (d) => { d.jobs.fixture.steps = [checkout({ ref: "refs/heads/staging" })]; }],
    ["the checkout moved to an unpinned expression", (d) => { d.jobs.fixture.steps = [checkout({ ref: "${{ github.ref }}" })]; }],
    ["the checkout keeps credentials", (d) => { d.jobs.fixture.steps = [checkout({ "persist-credentials": true })]; }],
    ["the checkout omits persist-credentials, whose default is true", (d) => { d.jobs.fixture.steps = [{ uses: "actions/checkout@v7", with: { ref: SHA } }]; }],
    ["the checkout has no `with:` at all", (d) => { d.jobs.fixture.steps = [{ uses: "actions/checkout@v7" }]; }],
    ["the checkout is removed, so nothing reviewed is what runs", (d) => { d.jobs.fixture.steps = []; }],
    // Proves EVERY checkout is examined, not just the first — a second loose one is the smuggling route.
    ["a SECOND, loose checkout added after the pinned one", (d) => { d.jobs.fixture.steps = [checkout(), checkout({ ref: "refs/heads/staging" })]; }],
    ["the fixture gains an App secret", (d) => { d.jobs.fixture.steps![1].env!.RELEASE_APP_PRIVATE_KEY = "${{ secrets.RELEASE_APP_PRIVATE_KEY }}"; }],
    ["the fixture gains INDEXED secret access, which a name sweep misses", (d) => { d.jobs.fixture.steps![1].env!.KEY = "${{ secrets['RELEASE_APP_PRIVATE_KEY'] }}"; }],
    ["the fixture gains a protected environment, which is where the App keys live", (d) => { d.jobs.fixture.environment = "staging-release"; }],
    ["the fixture forwards secrets to a reusable workflow", (d) => { d.jobs.fixture.secrets = "inherit"; }],
    ["a workflow-level env puts a secret in scope of every job", (d) => { d.env = { KEY: "${{ secrets.RELEASE_APP_PRIVATE_KEY }}" }; }],
    ["the fixture consumes a credentialed job's outputs", (d) => { d.jobs.fixture.steps![1].env!.KEY = "${{ needs.normal.outputs.token }}"; }],
    ["the fixture job is gone, so the exemption has no subject", (d) => { delete (d.jobs as Record<string, unknown>).fixture; d.jobs.other = { if: ADMISSION, permissions: perms({ checks: "write" }), steps: [checkout()] }; }],
  ])("loses the exemption when: %s", (_label, mutate) => {
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, commissioning(mutate))).toBe(false);
    // …and the grant is reported again. (For the deleted-fixture case it is reported under the job
    // that now carries it, so this asserts a non-empty report rather than an exact string.)
    expect(forgingGrants(COMMISSIONING_FILE, commissioning(mutate))).not.toEqual([]);
  });

  it("treats a malformed or empty document as NO exception, and never throws on one", () => {
    for (const doc of [null, undefined, "workflow_dispatch", 42, [], {}, { jobs: {} }, { on: "workflow_dispatch", jobs: { fixture: {} } }]) {
      expect(commissioningFixtureExemption(COMMISSIONING_FILE, doc as Workflow), JSON.stringify(doc ?? null)).toBe(false);
      expect(() => forgingGrants(COMMISSIONING_FILE, doc as Workflow)).not.toThrow();
    }
  });

  it("compares the admission through YAML, where the same condition has several spellings", () => {
    const yaml = (ifValue: string, persist = "false") =>
      parseYaml(
        [
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  fixture:",
          `    if: ${ifValue}`,
          "    permissions: { contents: read, actions: read, checks: write }",
          "    steps:",
          "      - uses: actions/checkout@v7",
          "        with:",
          "          ref: " + SHA,
          `          persist-credentials: ${persist}`,
        ].join("\n")
      ) as Workflow;
    const q = (v: string) => `>-\n      ${v}`;
    // A folded scalar across lines is the same condition, and normalisation must see that.
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, yaml(q(ADMISSION)))).toBe(true);
    // The `${{ }}`-wrapped spelling is equivalent GitHub syntax, so it keeps the exemption…
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, yaml(`\${{ ${ADMISSION} }}`))).toBe(true);
    // …but the wrapper is not a hiding place for the disjunction.
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, yaml(`\${{ ${ADMISSION} || true }}`))).toBe(false);
    // A QUOTED "false" is the string "false", not the boolean — persist-credentials would be on.
    expect(commissioningFixtureExemption(COMMISSIONING_FILE, yaml(q(ADMISSION), '"false"'))).toBe(false);
  });
});

/**
 * Criterion 10 — the gate's context NAME must be unique across all workflows.
 *
 * Branch protection identifies a required check by its CONTEXT NAME (optionally plus an app id), NOT
 * by the workflow file that produced it, and GitHub warns that duplicate check names make
 * required-check behaviour ambiguous. A second workflow declaring a job with the same name could mint
 * the accepted context on a commit the gate never examined.
 *
 * PARSED, not grepped: the first version assumed exactly four spaces of indentation, so a duplicate at
 * any other indent — or with a trailing comment — returned nothing and the guard passed with the
 * duplicate sitting in the tree. Adversarial addition is precisely this guard's threat model, so an
 * indentation assumption is not a detail.
 */
const CONTEXT = "Release candidate gate";

/** Every check-run name a workflow can produce: a job's `name:`, or its id when unnamed. */
export function jobNames(doc: Workflow): string[] {
  return Object.entries(doc?.jobs ?? {}).map(([id, job]) =>
    typeof job?.name === "string" ? job.name : id
  );
}

/**
 * Job names that are EXPRESSIONS, and therefore un-analysable from the file alone.
 *
 * Codex, round 2. `jobNames` compares the literal parsed string, but GitHub EVALUATES
 * `jobs.<id>.name` before publishing the check — so `name: ${{ 'Release candidate gate' }}`, or
 * `name: ${{ matrix.context }}` with `context: [Release candidate gate]`, publishes the gate's exact
 * context while the parsed value is `"${{ … }}"` and the uniqueness assertion sails past. App pinning
 * does not help: the counterfeit and the genuine check are emitted by the same GitHub Actions app.
 *
 * There is no honest way to resolve an expression statically, so this does not try. It reports them,
 * and the guard treats "cannot be analysed" as a failure rather than a pass — which is the only
 * direction that keeps criterion 10's claim ("every resulting check name") true.
 */
export function expressionJobNames(doc: Workflow): string[] {
  return jobNames(doc).filter((n) => n.includes("${{"));
}

describe("guard: the gate's check context is unique (criterion 10)", () => {
  it("exactly one workflow can produce the gate's context name", () => {
    const declaring = files().filter((f) => jobNames(load(f)).includes(CONTEXT));
    expect(declaring, `"${CONTEXT}" must be produced by exactly one workflow`).toEqual(["release-candidate.yml"]);
  });

  it("NO workflow uses an EXPRESSION for a job name, because one cannot be analysed", () => {
    // Codex, round 2. `name: ${{ 'Release candidate gate' }}` publishes the gate's exact context while
    // parsing to a literal `"${{ … }}"`, so a purely textual comparison can never see it. Rather than
    // pretend to evaluate expressions, the repo simply does not use them for job names — and this
    // assertion is what keeps that true, turning the un-analysable case into a red diff.
    const offenders = files().flatMap((f) => expressionJobNames(load(f)).map((n) => `${f}: ${n}`));
    expect(offenders, `expression job names cannot be checked for context collisions:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is NON-VACUOUS about expressions: both counterfeit shapes are detected", () => {
    expect(expressionJobNames(parseYaml("jobs:\n  a:\n    name: ${{ 'Release candidate gate' }}\n"))).toHaveLength(1);
    expect(expressionJobNames(parseYaml("jobs:\n  a:\n    name: ${{ matrix.context }}\n"))).toHaveLength(1);
    expect(expressionJobNames(parseYaml("jobs:\n  a:\n    name: Release candidate gate\n"))).toEqual([]);
  });

  it("is NON-VACUOUS at ANY indentation, and for an unnamed job", () => {
    // The indent-4 shape the old grep assumed…
    expect(jobNames(parseYaml("jobs:\n  a:\n    name: X\n"))).toEqual(["X"]);
    // …and the shapes it silently missed.
    expect(jobNames(parseYaml("jobs:\n    deep:\n      name: X\n"))).toEqual(["X"]);
    expect(jobNames(parseYaml("jobs:\n  a:\n    name: X # a comment\n"))).toEqual(["X"]);
    expect(jobNames(parseYaml("jobs:\n  a: {name: X}\n"))).toEqual(["X"]);
    // A job with no `name:` still produces a context — under its id.
    expect(jobNames(parseYaml("jobs:\n  build:\n    runs-on: x\n"))).toEqual(["build"]);
    // Two jobs claiming the same name is the thing being detected.
    expect(jobNames(parseYaml(`jobs:\n  a:\n    name: ${CONTEXT}\n  b:\n    name: ${CONTEXT}\n`))).toHaveLength(2);
  });

  it("finds the real name in the real file, so the uniqueness assertion is not vacuous", () => {
    expect(jobNames(load("release-candidate.yml"))).toContain(CONTEXT);
  });
});
