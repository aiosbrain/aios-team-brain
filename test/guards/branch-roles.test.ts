import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONTRIBUTION_BASE, INTEGRATION_BRANCH, RELEASE_BRANCH, remoteRef } from "../../scripts/branches.mjs";

/**
 * RELPTR-4 — the three branch roles, and the workflows that follow them.
 * Spec: `docs/design/cutover-prep-integration-branch.md` (criteria 1–9).
 *
 * THE DEFECT THIS FILE EXISTS FOR, which is not the obvious one. `scripts/release-candidate-guard.mjs`
 * hardcoded `refs/remotes/origin/staging` — an UNDECLARED SECOND OWNER of the integration branch, while
 * a first draft of this slice was declaring the same name as `main`. Two independent pre-code reviews
 * killed that draft.
 *
 * But the sharper trap is what remains after the fix: **`RELEASE_BRANCH` and `CONTRIBUTION_BASE` are
 * both `"main"` today.** A consumer wired to the wrong one passes every value assertion — "the release
 * ref resolves to main" is true either way — and stays green until cutover day, when
 * `CONTRIBUTION_BASE` moves to `staging` and assertion C silently becomes "is `staging` an ancestor of
 * the candidate". That is the pre-cutover-green / post-cutover-silent shape this whole program exists
 * to prevent, so it gets a test that can see it TODAY: the identity pin below.
 */

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Loose on purpose — these guards inspect workflow shapes, including ones nobody would write. */
type Step = { if?: unknown };
type Job = { if?: unknown; steps?: Step[] };
type Workflow = { on?: Record<string, { branches?: string[]; types?: string[]; push?: unknown }>; jobs?: Record<string, Job> };
const workflow = (name: string) => parseYaml(read(`.github/workflows/${name}`)) as Workflow;

describe("branch roles — one owner per role (criteria 1, 2)", () => {
  it("the three roles hold the values the design says they hold", () => {
    expect(CONTRIBUTION_BASE, "moves at the cutover").toBe("main");
    expect(INTEGRATION_BRANCH, "already staging — RELPTR-3 reads it").toBe("staging");
    expect(RELEASE_BRANCH, "what installers deploy").toBe("main");
    expect(remoteRef("x")).toBe("refs/remotes/origin/x");
  });

  it("each role is DECLARED exactly once across scripts/**", () => {
    // One owner per role, so moving the contribution base at cutover is one edit rather than a sweep.
    // RECURSIVE — criterion 1 says `scripts/**` and the first version read only `scripts/*`. Both
    // reviewers found the same surviving mutation: declare a role in `scripts/setup/deploy-policy.mjs`
    // and the undeclared-second-owner class this slice exists to kill returns one directory down.
    const files = readdirSync(join(ROOT, "scripts"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"));
    for (const role of ["CONTRIBUTION_BASE", "INTEGRATION_BRANCH", "RELEASE_BRANCH"]) {
      const declaring = files.filter((f) => new RegExp(`export const ${role}\\b`).test(read(`scripts/${f}`)));
      expect(declaring, `${role} must have exactly one declaration`).toEqual(["branches.mjs"]);
    }
  });

  it("the release-candidate guard no longer hardcodes a ref — it names the ROLES", () => {
    // The second-owner defect, pinned so it cannot return. Asserted on the token, not the value,
    // because the value is what makes the mistake invisible (see the identity pin below).
    const src = read("scripts/release-candidate-guard.mjs");
    expect(src, "must import the roles").toMatch(/from "\.\/branches\.mjs"/);
    expect(src).toMatch(/mainRef = remoteRef\(RELEASE_BRANCH\)/);
    expect(src).toMatch(/integrationRef = remoteRef\(INTEGRATION_BRANCH\)/);
    // Any quoting, not just double — a single-quoted or backticked literal would have evaded the
    // first spelling of this assertion.
    expect(src, "no hardcoded remote ref may remain").not.toMatch(/refs\/remotes\/origin\/(main|staging)/);
  });
});

describe("branch roles — the IDENTITY PIN (criterion 3)", () => {
  /**
   * WHY THIS RUNS THE GUARD INSTEAD OF READING ITS SOURCE.
   *
   * A first version of this pin stubbed `CONTRIBUTION_BASE` and then asserted
   * `remoteRef(RELEASE_BRANCH) === "refs/remotes/origin/main"` — which is TAUTOLOGICAL. It evaluates
   * its own expression and never imports the release guard, so mis-wiring the guard could not redden
   * it. Mutation-testing caught that: the mutation `mainRef = remoteRef(CONTRIBUTION_BASE)` reddened
   * only the source-token assertion, and a source-token regex is evadable by an equivalent spelling.
   *
   * So this copies BOTH modules into a scratch tree with `CONTRIBUTION_BASE` set to a sentinel, builds
   * a real repository where a valid candidate exists, and runs the guard through its DEFAULT refs. If
   * `mainRef` follows the contribution base, it resolves to a ref that does not exist, assertion C
   * goes false, and the verdict flips to FAIL. Behaviour, not text.
   */
  // Isolated for every child process, git AND node. Both reviewers flagged that the RELPTR-3 twin in
  // `release-candidate-gate.test.ts` already does this and this file did not: a machine with
  // `tag.gpgSign = true` would make the annotated tag below attempt signing and the pin would red — or
  // hang on a pinentry — for a reason that has nothing to do with the wiring under test. `vi.stubEnv`
  // alone would not reach the spawned `node`, so the env is passed explicitly.
  const ISOLATED = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
  } as NodeJS.ProcessEnv;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: ISOLATED }).trim();

  // RELPTR-6 D2 — match the DECLARATION, not the value it currently holds. The first version
  // replaced the literal string `export const CONTRIBUTION_BASE = "main";`, so the day the cutover
  // moves that value the substitution silently stops matching. It fails loudly today (the
  // `not.toBe(src)` below), which is why this is brittleness rather than a false green — but
  // "update the literal to `staging`" would reintroduce the identical coupling one cutover later.
  // Global + count-checked: a SECOND declaration would otherwise leave one copy unstubbed, and the
  // stub would test a module that still resolves the real branch.
  const CONTRIBUTION_BASE_DECL = /export const CONTRIBUTION_BASE = "[^"]*";/g;

  function scratchWithStub(stubValue: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "roles-pin-"));
    const src = read("scripts/branches.mjs");
    expect(src.match(CONTRIBUTION_BASE_DECL), "exactly one declaration to stub").toHaveLength(1);
    const branches =
      stubValue === null ? src : src.replace(CONTRIBUTION_BASE_DECL, `export const CONTRIBUTION_BASE = ${JSON.stringify(stubValue)};`);
    if (stubValue !== null) expect(branches, "the stub must apply").not.toBe(src);
    writeFileSync(join(dir, "branches.mjs"), branches);
    writeFileSync(join(dir, "release-candidate-guard.mjs"), read("scripts/release-candidate-guard.mjs"));

    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    git(dir, "add", "package.json");
    git(dir, "commit", "-qm", "base");
    const parent = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }));
    git(dir, "add", "package.json");
    git(dir, "commit", "-qm", "release");
    const head = git(dir, "rev-parse", "HEAD");

    // ASYMMETRIC ON PURPOSE — both reviewers found the first version degenerate. With `origin/main`,
    // `origin/staging` and the tag all at ONE commit, C and D become indistinguishable: a full C↔D
    // ref SWAP passes every behavioural test, leaving only a source-token regex holding the line —
    // and this file's own header calls those evadable. Post-cutover a surviving swap would make D ask
    // "reachable from main", turning the deliberate pre-cutover red green.
    //
    // So: release branch one commit BEHIND, integration branch AT the candidate. C still holds (the
    // parent is an ancestor of head) and D still holds (head is reachable from staging) — but swap
    // them and D asks whether head is reachable from the PARENT, which it is not. The swap now reds.
    git(dir, "update-ref", "refs/remotes/origin/main", parent);
    git(dir, "update-ref", "refs/remotes/origin/staging", head);
    git(dir, "tag", "-a", "v0.3.0", "-m", "v0.3.0");
    return { dir, head, parent };
  }

  /** Run the guard with its DEFAULT refs — the thing under test. */
  const runWithDefaults = (dir: string, head: string) =>
    JSON.parse(
      execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(join(dir, "release-candidate-guard.mjs"))};
           const r = main({ ref: "refs/tags/v0.3.0", sha: ${JSON.stringify(head)}, remote: ".", cwd: ${JSON.stringify(dir)}, log: () => {} });
           process.stdout.write(JSON.stringify(r));`,
        ],
        { encoding: "utf8", env: ISOLATED }
      )
    );

  it("PASSES with a sentinel contribution base — the release ref does not follow it", () => {
    const { dir, head } = scratchWithStub("SENTINEL-not-a-branch");
    try {
      const r = runWithDefaults(dir, head);
      expect(r.facts.mainIsAncestor, "assertion C must still resolve against the RELEASE branch").toBe(true);
      expect(r.facts.reachableFromIntegration).toBe(true);
      expect(r.verdict, `moving CONTRIBUTION_BASE must not affect the release check: ${r.failures}`).toBe("PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is NON-VACUOUS: mis-wiring mainRef to CONTRIBUTION_BASE makes this FAIL", () => {
    // The mutation the pin exists for, executed. Without this, a green above proves nothing.
    const { dir, head } = scratchWithStub("SENTINEL-not-a-branch");
    try {
      const guard = readFileSync(join(dir, "release-candidate-guard.mjs"), "utf8");
      const mis = guard
        .replace("import { INTEGRATION_BRANCH, RELEASE_BRANCH, remoteRef }", "import { CONTRIBUTION_BASE, INTEGRATION_BRANCH, RELEASE_BRANCH, remoteRef }")
        .replace("mainRef = remoteRef(RELEASE_BRANCH)", "mainRef = remoteRef(CONTRIBUTION_BASE)");
      expect(mis, "the mis-wiring must apply").not.toBe(guard);
      writeFileSync(join(dir, "release-candidate-guard.mjs"), mis);
      const r = runWithDefaults(dir, head);
      expect(r.facts.mainIsAncestor, "the sentinel ref does not exist, so C goes false").toBe(false);
      expect(r.verdict).toBe("FAIL");
      expect(r.failures.join(" ")).toMatch(/^C: |C: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is NON-VACUOUS on the OTHER axis: swapping the C and D refs makes this FAIL", () => {
    // The mutation the asymmetric fixture exists for. Until the fixture stopped putting every ref on
    // one commit, this swap was caught only by a source-token regex.
    const { dir, head } = scratchWithStub(null);
    try {
      const guard = readFileSync(join(dir, "release-candidate-guard.mjs"), "utf8");
      const swapped = guard
        .replace("mainRef = remoteRef(RELEASE_BRANCH)", "mainRef = remoteRef(__TMP__)")
        .replace("integrationRef = remoteRef(INTEGRATION_BRANCH)", "integrationRef = remoteRef(RELEASE_BRANCH)")
        .replace("mainRef = remoteRef(__TMP__)", "mainRef = remoteRef(INTEGRATION_BRANCH)");
      expect(swapped, "the swap must apply").not.toBe(guard);
      writeFileSync(join(dir, "release-candidate-guard.mjs"), swapped);
      const r = runWithDefaults(dir, head);
      expect(r.verdict, "a C/D swap must be observable, not just readable").toBe("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the UNSTUBBED module still passes, so the sentinel is what makes the difference", () => {
    const { dir, head } = scratchWithStub(null);
    try {
      expect(runWithDefaults(dir, head).verdict).toBe("PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("branch roles — the workflows that must follow the cutover (criteria 5, 6, 7)", () => {
  it("aios-work-sync fires on EXACTLY the release branch and the integration branch", () => {
    // EXACT SET, not "contains both": `[main, staging, "**"]` satisfies a containment check while
    // silently widening the trigger to every branch in the repository. Codex found that.
    //
    // `pull_request_target`, not `pull_request` — the credential-isolation fix. Under `pull_request`
    // the workflow FILE comes from the pull request's head, so the `merged == true` gate was
    // contributor-editable and an unmerged close fired the job with three brain secrets in scope.
    // The branch filter is doubly load-bearing on this trigger: without it the "base" is whatever
    // branch a pull request targets, so a collaborator can make their own tree the trusted one.
    // `test/guards/pr-task-link-credential-isolation.test.ts` owns the security half; this owns the
    // RELPTR-4 half, and both must move together.
    //
    // RELPTR-6 D1 — THE PAIR IS `[RELEASE_BRANCH, INTEGRATION_BRANCH]`, AND IT USED TO BE
    // `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]`. Today those evaluate identically (`["main",
    // "staging"]`), which is exactly why the mis-wiring was invisible — the same identity trap
    // `scripts/branches.mjs`'s header names, found in a second place. On cutover day
    // `CONTRIBUTION_BASE` becomes `staging`, the old expectation COLLAPSES to
    // `["staging", "staging"]`, and this guard reddens against a workflow file that is correct.
    //
    // WHY RELEASE AND NOT CONTRIBUTION — by elimination, which is the only argument that holds in
    // both worlds. The trigger needs two DISTINCT branches. `[CONTRIBUTION_BASE, RELEASE_BRANCH]`
    // collapses today (both `main`); `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]` collapses after the
    // cutover (both `staging`); `[RELEASE_BRANCH, INTEGRATION_BRANCH]` is distinct in both. That is
    // the whole justification and it is checkable.
    //
    // TWO REFUTED VERSIONS, both kept so neither is re-derived. This is the one claim in this slice
    // that three passes disagreed about, so the evidence is written down rather than the conclusion.
    //
    //   (1) A draft called this pair a SECURITY ALLOWLIST of trusted pull-request bases.
    //   (2) Fable's diff review disproved (1) by arguing that on `pull_request_target` the workflow
    //       file — `on:` filter included — is read from the pull request's BASE branch, which a
    //       same-repo collaborator controls.
    //
    // (2) IS ALSO WRONG, AND IS THE OLDER MODEL. gpt-6-astra caught it and it was verified against
    // the primary source: GitHub changed `pull_request_target` effective 2025-12-08 —
    // "The workflow file and checkout commit will always be taken from the repository's default
    // branch, regardless of the pull request's base branch", and "environment rules evaluate against
    // the default branch". (github.blog/changelog/2025-11-07-actions-pull_request_target-and-
    // environment-branch-protections-changes/)
    //
    // So the base branch controls neither the workflow file nor the environment evaluation. But
    // "therefore the filter is not a security control" — a first version of this comment — is the
    // over-correction, and Fable's re-clear caught it. The filter is not a CREDENTIAL boundary; it is
    // the INTEGRITY control over which merges count. With `branches: ["**"]` a collaborator opens a
    // pull request into their own unprotected branch, merges it themselves, satisfies
    // `merged == true && same-repo` from trusted default-branch code, and `notify-brain` posts a work
    // event that can resolve `applied` and close a task. Under the verified model the filter is MORE
    // load-bearing, not less, because a same-repo branch can no longer edit it. The separate
    // blast-radius control over the CREDENTIAL is the `trusted-automation` environment policy,
    // evaluated against the DEFAULT branch — repository settings, not this file.
    //
    // What IS true and worth keeping: a release fast-forward is a PUSH, so it does not by itself
    // raise `pull_request_target`. ("emits none at all" was too strong — if a `staging`→`main` pull
    // request is open when the push lands, GitHub marks it merged and `closed` fires with
    // `merged == true`.) `main`'s entry serves exactly those in-flight and exceptional pull
    // requests into the release branch.
    const on = workflow("aios-work-sync.yml").on!;
    expect(Object.keys(on), "the trigger itself is part of criterion 5 now").toEqual(["pull_request_target"]);
    expect(on.pull_request_target!.branches).toEqual([RELEASE_BRANCH, INTEGRATION_BRANCH]);
    expect(on.pull_request_target!.types).toEqual(["closed"]);
  });

  it("the two roles in that pair can never be the same branch", () => {
    // The property the old pair lacked, asserted directly instead of via a `toContain("staging")`
    // that stopped meaning anything once `staging` could be BOTH values. `[RELEASE_BRANCH,
    // INTEGRATION_BRANCH]` is a two-branch allowlist by construction; `[CONTRIBUTION_BASE,
    // INTEGRATION_BRANCH]` is only a two-branch allowlist by accident of today's values.
    //
    // ONE assertion, not two. A first version followed this with
    // `expect([A,B]).toHaveLength(new Set([A,B]).size)` and a comment claiming it pinned the
    // COLLAPSE of the old pair. For a 2-tuple that is the same predicate respelled, and it never
    // mentioned `CONTRIBUTION_BASE` — a comment describing a third thing neither line did.
    expect(RELEASE_BRANCH, "a collapsed pair is a one-branch trigger wearing a two-branch shape").not.toBe(INTEGRATION_BRANCH);
  });

  it("the workflow triggers are pinned to the RELEASE role, not the contribution base", () => {
    // WHY A SOURCE REGEX, WHICH THIS FILE'S OWN HEADER CALLS EVADABLE: today
    // `RELEASE_BRANCH === CONTRIBUTION_BASE === "main"`, so the two role pairs are the SAME VALUE
    // and no value or behavioural assertion can tell them apart. Measured, not assumed — reverting
    // either `toEqual` below to `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]` leaves EVERY test in this
    // file green (`scripts/mutate.mjs` verdict: SURVIVED, twice). Fable's diff review found
    // exactly that gap, and this test exists because of it. An evadable pin beats no pin; the
    // alternative was a fix nothing held in place until cutover day made it loud.
    // COMMENT LINES ARE STRIPPED FIRST. gpt-6-astra's cold review found the hole in the first
    // version: prefixing either assertion with `//` leaves both regex checks satisfied — the string
    // is still in the file — while removing its execution entirely, so the count certified coverage
    // that no longer runs. Stated limits, because a guard's blind spots belong in the guard: this
    // strips LINE comments only, so a `/* … */` block around an assertion evades it — and so does
    // disabling the test that contains it (`it.skip`, `describe.skip`, `xit`, `it.todo`), which
    // leaves the source text and therefore the count untouched. Same class, same acceptance: these
    // are deliberate edits by someone reading this comment, not silent drift.
    const src = read("test/guards/branch-roles.test.ts")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(src, "the trigger assertions must name RELEASE_BRANCH").not.toMatch(/toEqual\(\[CONTRIBUTION_BASE, INTEGRATION_BRANCH\]\)/);
    // NON-VACUOUS: forbidding a shape proves nothing unless the shape it REPLACED is present.
    // Both trigger sites, counted — deleting or commenting out one would otherwise satisfy the
    // line above while removing the assertion it exists to protect.
    expect(src.match(/toEqual\(\[RELEASE_BRANCH, INTEGRATION_BRANCH\]\)/g), "both trigger sites, uncommented").toHaveLength(2);
  });

  it("scan-on-merge fires on EXACTLY the same two branches", () => {
    // RELPTR-4's original failure: a `[main]`-ONLY push trigger after contributions moved would
    // drop codebase readiness from per-merge to per-release without any error. That is why the
    // trigger was widened, and it is still why `staging` must be here.
    //
    // RELPTR-6 D1, and a REFUTATION worth keeping: a draft of that slice justified retaining
    // `main` by claiming its removal would reduce readiness to per-release. Codex disproved it —
    // post-cutover every merge lands on `staging`, so `staging`-only scanning is still per-merge.
    // `main`'s entry buys release-time retry/reconciliation, at the cost of normally re-scanning a
    // SHA already scanned on `staging`.
    //
    // A FIRST VERSION CALLED THAT "duplicate compute rather than a wrong result". Too strong, and
    // gpt-6-astra produced the counterexample; re-derived here before folding. `lib/codebases/ingest.ts`
    // upserts on `(codebase_id, head_sha)` and REFRESHES `scanned_at`, while
    // `lib/metrics/codebases.ts` picks the latest scan by ORDERING ON `scanned_at`. So: staging
    // scans A then B; a later release fast-forward re-scans A; A now carries the newest timestamp
    // and wins "latest" despite B being newer by ancestry. That is a pre-existing operational risk
    // this slice neither introduces nor fixes — recorded so the reassurance is not repeated.
    const on = workflow("scan-on-merge.yml").on!;
    expect((on.push as { branches?: string[] }).branches).toEqual([RELEASE_BRANCH, INTEGRATION_BRANCH]);
  });

  it("nothing INSIDE aios-work-sync re-narrows what the trigger widened", () => {
    // The trigger list and the job condition can both be right while a STEP-level `if:` suppresses
    // the emission for one branch — the widening undone one layer down, where criteria 5 cannot see
    // it. Codex found this too. The job gate is pinned as an exact string; steps carry no `if:` at all.
    const wf = workflow("aios-work-sync.yml");
    const job = wf.jobs!["notify-brain"];
    // Exact string, both clauses. `merged == true` is the merge semantics (`closed` fires on ANY
    // close); the same-repository clause is the credential fix keeping fork pull requests away from
    // secrets that `pull_request` used to withhold for us. NEITHER of them narrows by BRANCH, which
    // is what criterion 5 is protecting here.
    expect(job.if, "the job gate, exactly").toBe(
      "github.event.pull_request.merged == true && github.event.pull_request.head.repo.full_name == github.repository"
    );
    const stepIfs = (job.steps ?? []).filter((step) => step.if !== undefined);
    expect(stepIfs, "no step may carry its own condition").toEqual([]);
  });

  it("scan-on-merge's concurrency group is PER-REF, so one branch cannot cancel the other", () => {
    // Found by a mutation that SURVIVED: widening the trigger while leaving one global group means a
    // push to either branch cancels an in-flight scan of the other (`cancel-in-progress: true`), so a
    // staging push could kill a main scan and leave the older snapshot as the dashboard's latest.
    // Changing the group without pinning it would have been a fix nothing held in place.
    const wf = workflow("scan-on-merge.yml") as unknown as { concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
    expect(wf.concurrency?.group, "must vary by ref").toMatch(/\$\{\{\s*github\.ref\s*\}\}/);
    expect(wf.concurrency?.["cancel-in-progress"], "still one scan at a time PER ref").toBe(true);
  });

  it("the work-sync BODY never reads the base ref either", () => {
    // Fable found the layer below the layer: criterion 7 pins the trigger and the job/step conditions,
    // but the run body is free text. `if (pr.base.ref !== "main") process.exit(0)` inside it would keep
    // every guard green while post-cutover staging merges emitted nothing — the exact silent failure
    // constraint 3 describes. This also documents §3.1b's limitation: the payload is `pr.head.ref` only.
    const body = read(".github/workflows/aios-work-sync.yml");
    expect(body, "no base-ref branching in the body").not.toMatch(/base_ref|base\.ref/);
  });

  it("is NON-VACUOUS: the parsed shapes are real, not empty reads", () => {
    // A parse returning undefined would make every assertion above vacuously pass.
    expect(workflow("aios-work-sync.yml").jobs!["notify-brain"].steps!.length).toBeGreaterThan(0);
    expect(Object.keys(workflow("scan-on-merge.yml").jobs!).length).toBeGreaterThan(0);
  });
});

describe("branch roles — the PR template states the split (criterion 8)", () => {
  const TPL = () => read(".github/pull_request_template.md");

  it("names BOTH outcomes, because the old text promised only the automatic one", () => {
    // PRESENCE, not absence: stripping the sentence entirely would satisfy a "no longer claims
    // automatic close" check while telling a contributor nothing. And the old claim was HALF true —
    // a brain-native row in this project really does complete automatically — so the fix is to state
    // the split, not to delete the promise.
    const t = TPL();
    // NOT existential: swapping `applied` and `linked` preserves both tokens while publishing the
    // opposite guidance, so the MAPPING is asserted, not the vocabulary.
    expect(t, "brain-native rows map to applied").toMatch(/BRAIN-NATIVE row[\s\S]{0,120}`applied`/);
    expect(t, "workspace rows map to linked").toMatch(/pushed from the workspace[\s\S]{0,160}`linked`/);
    expect(t).toMatch(/3-log\/tasks\.md/);
    expect(t, "must say the workspace row is left open on purpose").toMatch(/DELIBERATELY left open/);
  });

  it("still asks for the work key at all", () => {
    expect(TPL()).toMatch(/AIOS-Work:/);
  });
});

describe("branch roles — the runbook records the decisions (criterion 9)", () => {
  const RUNBOOK = () => read("docs/RELEASING.md");

  it("§3.1b states the ticket-closing decision, its revert policy, and the applied/linked split", () => {
    const r = RUNBOOK();
    expect(r).toMatch(/a ticket closes when its work merges to the CONTRIBUTION BASE/);
    expect(r, "the revert case must be decided, not left open").toMatch(/\*\*stays closed\*\* if the release is later\s*\n?reverted or never cut/);
    expect(r).toMatch(/`applied`/);
    expect(r).toMatch(/`linked`/);
    // The limitation the review said was "recorded" with nowhere to record it.
    expect(r, "the pr.head.ref limitation").toMatch(/carries only\s*\n?`pr\.head\.ref`/);
  });

  it("§3.1c enumerates the cutover-day edits a shared constant does NOT remove", () => {
    // The first draft claimed "the cutover is one edit". It is not, and planning a day around the
    // wrong number is the failure this section prevents.
    const r = RUNBOOK();
    expect(r).toMatch(/is not "the cutover is one edit"|not \*\*"the cutover is one edit"\*\*/);
    expect(r).toMatch(/dependabot\.yml` `target-branch`/);
    expect(r, "prose naming a branch is undetectable by a guard").toMatch(/Prose that NAMES a branch/);
    expect(r, "and the protection changes, which nothing in code can move").toMatch(/Every branch-protection change/);
  });

  it("constraint 3 is marked PREPARED with what remains human", () => {
    const row3 = RUNBOOK().split("\n").find((l) => l.startsWith("| 3 |")) ?? "";
    expect(row3, "constraint row 3 must exist").not.toBe("");
    expect(row3).toMatch(/PREPARED \(RELPTR-4\)/);
    expect(row3, "must say what is left for a human").toMatch(/Still human at cutover/);
    expect(row3, "must not still describe it as unfixed").not.toMatch(/cannot be deferred/);
  });

  it("§3.2 carries the two new ordering pairs", () => {
    const r = RUNBOOK();
    expect(r).toMatch(/work-sync-and-scan-widened: DONE \(RELPTR-4\)/);
    expect(r).toMatch(/dependabot-target-branch: at the cutover, never before/);
  });

  it("§3.1d records the instruction corpus disposition and the scan's limits", () => {
    // RELPTR-5 replaces the undercount with a per-site disposition. Keep the release-role
    // identity fixture above fixed; only this superseded runbook assertion changes.
    const r = RUNBOOK().split("### 3.1d")[1].split("### 3.2")[0];
    expect(r).toContain("12 canonical files: 22 path-form occurrences + 4 refspec occurrences");
    expect(r).toContain("per-site presence AND absence");
    expect(r, "and that the heuristic has known error bars").toMatch(/false-negatives/);
  });
});
