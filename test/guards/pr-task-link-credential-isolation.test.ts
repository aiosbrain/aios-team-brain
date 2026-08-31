import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * BUILD-FAILING GUARD: PR-controlled code never executes next to a durable credential.
 *
 * THE DEFECT THIS EXISTS FOR, and it shipped. `pr-task-link.yml` ran on `pull_request`, checked out
 * the PR's merge ref with `actions/checkout`'s default, and `await import`ed
 * `scripts/pr-work-keys.mjs` FROM THAT CHECKOUT with a TEAM-tier `AIOS_API_KEY`, `AIOS_BRAIN_URL`
 * and `AIOS_TEAM` in the job environment. Its own header explained at length why that was safe —
 * and the explanation reasoned entirely about FORKS, which GitHub does withhold secrets from. It
 * never reached the case that matters here: a SAME-REPOSITORY branch pull request, which is how
 * every maintainer and every agent in this repo works, gets the full secret set. Editing one file
 * in one same-repo PR exfiltrated a durable brain credential, and nothing turned red.
 *
 * A prose warning in a workflow header is exactly the control that failed. So the property is
 * asserted as DATA instead: parse every workflow, find the jobs a pull request can reach that hold
 * a secret, and fail if any of them takes the pull request's code rather than the base branch's.
 *
 * WHY YAML AND NOT GREP. The sibling guard `workflow-permissions.test.ts` records the same lesson:
 * `ref: "${{ github.event.pull_request.head.sha }}"`, a flow mapping, a trailing comment, and a
 * different indentation are all the same document and different text. A guard that cannot express
 * the shape it guards against is decoration.
 *
 * SCOPE LIMIT, STATED — and the honest version, because an overstated guard is the control that
 * failed last time. This reads workflow FILES. It cannot see repository or organization secret
 * configuration, environment protection rules, or branch protection; those are read back from the
 * API in the pull request that changes them. Two consequences worth naming rather than implying:
 * naming an `environment:` does NOT stop a job reading a same-named REPOSITORY secret (an
 * environment secret only shadows one), so a green result here is not evidence that a credential is
 * environment-scoped; and a third-party action's behaviour is opaque to this file — only the shapes
 * enumerated in `credentialExposures` are detected, not "this job is safe".
 */

const WORKFLOWS = join(__dirname, "..", "..", ".github", "workflows");
const files = () => readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const text = (f: string) => readFileSync(join(WORKFLOWS, f), "utf8");

/** Deliberately loose — this guard inspects shapes nobody would write on purpose. */
type Step = { uses?: unknown; with?: unknown; run?: unknown; name?: unknown };
type Job = {
  steps?: unknown;
  env?: unknown;
  environment?: unknown;
  permissions?: unknown;
  uses?: unknown;
  secrets?: unknown;
  "continue-on-error"?: unknown;
};
type Workflow = { on?: unknown; env?: unknown; jobs?: Record<string, Job> };
const load = (f: string) => parseYaml(text(f)) as Workflow;

/** Trigger names, tolerating `on: pull_request`, `on: [a, b]` and the mapping form. */
export function triggers(doc: Workflow): string[] {
  const on = doc?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on as Record<string, unknown>);
  return [];
}

/**
 * Can a pull request cause this workflow's code to run with the base repository's secrets?
 *
 * Four events, not two. `workflow_call` is here because a reusable workflow is invoked BY one of the
 * others and inherits whatever the caller passes — scanning only the caller would leave the callee
 * entirely unexamined, and `secrets: inherit` is one line. `workflow_run` is here because it fires
 * on a PR workflow COMPLETING, runs base-branch code with full secrets, and its canonical use is to
 * download the artifact the pull request's own build produced — the same class wearing a different
 * trigger. Neither shape exists in this repository today; they are in the list so that adding one
 * does not silently arrive outside the guard.
 */
export const isPrReachable = (doc: Workflow): boolean =>
  triggers(doc).some(
    (t) => t === "pull_request" || t === "pull_request_target" || t === "workflow_call" || t === "workflow_run"
  );

/**
 * Every `secrets.X` referenced anywhere in a subtree.
 *
 * Recursive over the parsed document rather than line-matched, because a secret can be handed to a
 * job at the workflow level, the job level, a step's `env:`, an action's `with:`, or inline in a
 * `run:` — and "is a credential in scope for this job" has to be true across all of them.
 * `secrets.GITHUB_TOKEN` is NOT excluded: on `pull_request_target` it is the base repository's
 * token, which is precisely what a pwn-request wants.
 */
export function secretRefs(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") {
      for (const m of n.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_-]*)/g)) out.push(m[1]);
      return;
    }
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n && typeof n === "object") return void Object.values(n as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return [...new Set(out)].sort();
}

/** Refs whose content the pull request author controls. `refs/pull/N/merge` is the checkout default. */
const UNTRUSTED_REF =
  /github\.event\.pull_request\.head\b|github\.head_ref\b|github\.event\.pull_request\.merge_commit_sha\b|refs\/pull\//;

/**
 * Commands that MOVE THE WORKING TREE — the way to get PR content into a trusted checkout by hand.
 * `pull` and `worktree` are on the list because neither reads like a checkout: `git pull . prhead`
 * and `git worktree add /tmp/w prhead` both land PR objects somewhere executable.
 */
const TREE_MOVING = /\bgit\s+(?:checkout|switch|merge|pull|worktree|cherry-pick|rebase|am|reset|restore|apply)\b/;

/**
 * Commands that EXECUTE third-party or PR-authored code. A package install runs lifecycle scripts;
 * a downloaded artifact is whatever the PR's own build produced. Neither belongs in a job holding a
 * durable credential, and both become immediate RCE the moment someone also adds a head checkout.
 */
const CODE_EXECUTING =
  /\b(?:npm\s+(?:ci|install|i)\b|npx\s|yarn(?:\s+install)?\b|pnpm\s+(?:install|i)\b|bun\s+install|pip\s+install|poetry\s+install|bundle\s+install)/;

/** A PR field read straight into a `run:` — substituted before the shell parses, i.e. injection. */
const PR_INTERPOLATION = /\$\{\{[^}]*(?:github\.event\.pull_request\.|github\.head_ref|github\.event\.issue\.)/;

const asSteps = (job: Job): Step[] => (Array.isArray(job?.steps) ? (job.steps as Step[]) : []);
const usesId = (step: Step): string => (typeof step?.uses === "string" ? step.uses.trim() : "");
const isCheckout = (step: Step): boolean => /^actions\/checkout(@|$)/.test(usesId(step));
const withValue = (step: Step, key: string): string | undefined => {
  const w = step?.with;
  if (!w || typeof w !== "object") return undefined;
  const v = (w as Record<string, unknown>)[key];
  return v === undefined ? undefined : String(v);
};
const stepRef = (step: Step): string | undefined => withValue(step, "ref");

export type Finding = { file: string; job: string; why: string };

/**
 * Every way a PR-reachable job that holds a secret can end up running the pull request's own code.
 *
 * The rules each trace to a real route:
 *  1. an explicit `ref:` (or `repository:`) pointing at the PR head — the textbook pwn-request;
 *  2. a DEFAULT `actions/checkout` under `pull_request`, which is `refs/pull/N/merge`, i.e. the PR's
 *     code with no `ref:` line to notice in review. This is the one that actually shipped here;
 *  3. a `run:` that moves the working tree onto fetched PR objects (`git checkout`, `git merge`, …) —
 *     fetching PR objects as DATA is fine and is how `nda-gate.yml` works; checking them out is not;
 *  4. a `run:` that installs packages, or a step that downloads an artifact;
 *  5. a PR field interpolated into a `run:` — substituted before the shell parses it, so a PR title
 *     is a command-injection primitive in a job that can read a durable credential;
 *  6. a `uses:` this file cannot analyse — a LOCAL action (`./…`, whose code on `pull_request` comes
 *     from the pull request's own tree even with no checkout step at all) or a reusable workflow;
 *  7. rules 2 and 5 applied to a `workflow_call` CALLEE, which resolves an unqualified ref against
 *     its caller and cannot know whether that caller was a pull request. See `callerControlledRef`.
 *
 * `secrets: inherit` counts as a credential in scope on its own: a caller job that passes it has no
 * `steps` and no `secrets.` string anywhere, so without this the whole caller/callee pair vanishes.
 */
export function credentialExposures(file: string, doc: Workflow): Finding[] {
  if (!isPrReachable(doc)) return [];
  const onPullRequest = triggers(doc).includes("pull_request");
  const onWorkflowCall = triggers(doc).includes("workflow_call");
  /**
   * WHOSE REF DOES AN UNQUALIFIED CHECKOUT RESOLVE TO?
   *
   * Under `pull_request`: `refs/pull/N/merge`, the PR's own code. Under `workflow_call`: THE CALLER'S,
   * and the callee has no way to find out what that was. A reusable workflow invoked from a
   * `pull_request` job therefore checks out the pull request while holding whatever credential it was
   * passed — and this file cannot resolve the call graph to prove otherwise.
   *
   * Found by an adversarial review of this very guard: the first version read `onPullRequest` alone,
   * so a `workflow_call`-ONLY file scored `false` and its default checkout was waved through. The
   * caller-side rule below already fails closed for the ordinary shape (a job with `uses:` is flagged,
   * and `secrets: inherit` counts as a credential), but it cannot see a callee that names
   * `secrets.FOO` in its OWN `env:` while the caller passes nothing — there the caller has no secrets
   * in scope, `continue`s, and nobody audits the callee at all.
   *
   * So the callee assumes the worst about its caller. That is deliberately conservative: a false
   * positive here is waived with an explicit trusted `ref:`, and a false negative is the bug.
   */
  const callerControlledRef = onPullRequest || onWorkflowCall;
  const refOrigin = onPullRequest
    ? "`refs/pull/N/merge`, the PR's own code"
    : "the CALLER's ref, which a `pull_request` caller makes the PR's own code";
  const workflowSecrets = secretRefs(doc?.env);
  const found: Finding[] = [];
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    const inherits = String((job as { secrets?: unknown })?.secrets ?? "").trim() === "inherit";
    const secrets = [...new Set([...workflowSecrets, ...secretRefs(job), ...(inherits ? ["<inherit>"] : [])])];
    if (!secrets.length) continue;
    const add = (why: string) => found.push({ file, job: jobId, why: `${why} (secrets in scope: ${secrets.join(", ")})` });
    // A job may CALL a reusable workflow instead of running steps. Whatever that workflow does is
    // not in this file, so it cannot be cleared here — and `secrets: inherit` hands it everything.
    const jobUses = typeof (job as { uses?: unknown })?.uses === "string" ? String((job as { uses: string }).uses) : "";
    if (jobUses) add(`calls a reusable workflow this guard cannot see through: ${jobUses}`);
    for (const step of asSteps(job)) {
      if (isCheckout(step)) {
        const ref = stepRef(step);
        const repo = withValue(step, "repository");
        if (ref !== undefined && UNTRUSTED_REF.test(ref)) add(`checks out a PR-controlled ref: ${ref}`);
        else if (repo !== undefined && UNTRUSTED_REF.test(repo)) add(`checks out a PR-controlled repository: ${repo}`);
        // UNDER `pull_request`, THE INNOCENT-LOOKING EXPRESSIONS ARE THE PR TOO. `github.sha` on that
        // event IS the merge commit and `github.ref` IS `refs/pull/N/merge` — neither contains the
        // word "head", so an enumerated deny-list reads them as trusted. Writing `ref: ${{ github.sha }}`
        // is the way someone gets here by accident rather than by attack, so on this trigger ANY
        // expression ref is a finding. (On `pull_request_target` the same expressions are the base
        // tip, which is exactly the trusted thing, so the rule is scoped to the trigger.)
        else if (ref !== undefined && callerControlledRef && ref.includes("${{")) {
          add(`checks out an expression ref that resolves to ${refOrigin}: ${ref}`);
        } else if (ref === undefined && callerControlledRef) {
          add(`default \`actions/checkout\` — that is ${refOrigin}`);
        }
      }
      const uses = usesId(step);
      if (/^actions\/download-artifact(@|$)/.test(uses)) add("downloads a PR-produced artifact");
      // `uses: ./path` runs the action from the repository AT THE WORKFLOW'S REF. On `pull_request`
      // that is the pull request's own tree — PR code executing with no checkout step to notice.
      if (uses.startsWith("./") && callerControlledRef) add(`runs a local action resolved at ${refOrigin}: ${uses}`);
      const run = typeof step?.run === "string" ? step.run : "";
      if (TREE_MOVING.test(run)) add("moves the working tree with git — PR objects must stay data");
      if (CODE_EXECUTING.test(run)) add("installs packages, executing lifecycle scripts beside a credential");
      if (PR_INTERPOLATION.test(run)) add("interpolates a PR-controlled field into a `run:` block");
    }
  }
  return found;
}

/**
 * The ONE documented exception, and it is a different vulnerability with a different fix.
 *
 * `aios-work-sync.yml` runs on `pull_request: [closed]` gated by `merged == true`, so its default
 * checkout is PR-controlled code running with the same three brain secrets. It is NOT closed here
 * for two reasons: it fires only AFTER a merge (so it costs a reviewer's approval, not just an
 * `edited` event), and rewriting it is Phase 0 item 5 of the leak-gate remediation plan — a separate
 * change with its own test evidence. Removing it from this list without fixing the workflow is the
 * only wrong move: the entry is here so the hole is counted, not so it is forgotten.
 */
const KNOWN_GAPS = new Set(["aios-work-sync.yml"]);

describe("guard: no PR-reachable job runs PR-controlled code with a credential", () => {
  it("finds a non-trivial set of workflows, so a rename cannot empty this guard", () => {
    expect(files().length).toBeGreaterThan(4);
    expect(files()).toContain("pr-task-link.yml");
    expect(files()).toContain("aios-work-sync.yml");
  });

  it("no workflow outside the documented gap exposes a secret to PR-controlled code", () => {
    const offenders = files()
      .filter((f) => !KNOWN_GAPS.has(f))
      .flatMap((f) => credentialExposures(f, load(f)))
      .map((x) => `${x.file} [job:${x.job}] ${x.why}`);
    expect(offenders, `these hand a durable credential to code a pull request can edit:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the gap list is EXACTLY the documented one, and every entry still really trips the detector", () => {
    // Two failure modes, both real. A new name silently added to the list is a new hole; a name left
    // on the list after its workflow was fixed makes the list lie about what is outstanding.
    expect([...KNOWN_GAPS]).toEqual(["aios-work-sync.yml"]);
    for (const f of KNOWN_GAPS) {
      expect(credentialExposures(f, load(f)), `${f} no longer trips this — remove it from KNOWN_GAPS`).not.toEqual([]);
    }
  });

  it("`nda-gate.yml` stays clean: fetching PR objects as DATA is not an exposure", () => {
    // The guard must not push the repo toward deleting its confidentiality gate. nda-gate holds
    // NDA_TERMS on `pull_request_target`, fetches `refs/pull/N/head` and `/merge`, and never checks
    // either out. If this ever reddens, the fix is to look at nda-gate — not to loosen this rule.
    expect(secretRefs(load("nda-gate.yml"))).toContain("NDA_TERMS");
    expect(credentialExposures("nda-gate.yml", load("nda-gate.yml"))).toEqual([]);
  });

  // ONE CONDITION PER FIXTURE. Each of these is a spelling that a text search misses.
  const secretJob = (steps: string) =>
    `on:\n  pull_request_target:\n    branches: [main]\njobs:\n  a:\n    env:\n      K: \${{ secrets.AIOS_API_KEY }}\n    steps:\n${steps}`;
  it.each([
    ["explicit head sha", secretJob("      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n")],
    ["head ref by name", secretJob("      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.head_ref }}\n")],
    ["the raw pull ref", secretJob("      - uses: actions/checkout@abc\n        with:\n          ref: refs/pull/12/merge\n")],
    ["flow mapping, no line to grep", secretJob("      - {uses: actions/checkout@abc, with: {ref: '${{ github.event.pull_request.head.ref }}'}}\n")],
    ["a hand-rolled git checkout of fetched PR objects", secretJob("      - run: git fetch origin +refs/pull/1/head:x && git checkout x\n")],
    ["a package install beside the credential", secretJob("      - run: npm ci\n")],
    ["a PR-produced artifact", secretJob("      - uses: actions/download-artifact@abc\n")],
    [
      "the DEFAULT checkout under `pull_request` — the shape that actually shipped",
      "on:\n  pull_request:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n",
    ],
    [
      "a secret injected at the WORKFLOW level rather than the job",
      "on:\n  pull_request:\nenv:\n  K: ${{ secrets.AIOS_API_KEY }}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n",
    ],
    [
      "a secret reached only through a step's `with:`",
      "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n      - uses: some/action@abc\n        with:\n          token: ${{ secrets.AIOS_API_KEY }}\n",
    ],
    // The four evasions the pre-push review found. Each passed the first version of this guard.
    [
      "a reusable workflow handed everything via `secrets: inherit` — no steps, no `secrets.` text",
      "on:\n  pull_request:\njobs:\n  a:\n    uses: ./.github/workflows/inner.yml\n    secrets: inherit\n",
    ],
    [
      "the callee side of that pair, which is reachable only through `workflow_call`",
      "on:\n  workflow_call:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n",
    ],
    [
      "`workflow_run` downloading the artifact the PR's own build produced",
      "on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/download-artifact@abc\n",
    ],
    ["`npm i` — the short alias the first version of CODE_EXECUTING missed", secretJob("      - run: npm i\n")],
    ["`npx`, which fetches and executes a package", secretJob("      - run: npx some-tool\n")],
    [
      "a local action, whose code on `pull_request` IS the PR's tree even with no checkout step",
      "on:\n  pull_request:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: ./.github/actions/helper\n",
    ],
    [
      "a PR title interpolated into a run block — injection, not just leakage",
      secretJob('      - run: echo "${{ github.event.pull_request.title }}"\n'),
    ],
    [
      "`ref: ${{ github.sha }}` under `pull_request` — that IS the merge commit, and it says no `head`",
      "on:\n  pull_request:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.sha }}\n",
    ],
    [
      "`ref: ${{ github.ref }}` under `pull_request` — that IS `refs/pull/N/merge`",
      "on:\n  pull_request:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.ref }}\n",
    ],
    ["`git pull` of a fetched PR ref", secretJob("      - run: git fetch origin +refs/pull/1/head:x && git pull . x\n")],
    ["`git worktree add`, which never says checkout", secretJob("      - run: git worktree add /tmp/w x && node /tmp/w/build.js\n")],
    [
      "a checkout redirected by `repository:` rather than `ref:`",
      secretJob(
        "      - uses: actions/checkout@abc\n        with:\n          repository: ${{ github.event.pull_request.head.repo.full_name }}\n          ref: main\n"
      ),
    ],
  ])("is NON-VACUOUS for: %s", (_label, yaml) => {
    expect(credentialExposures("fixture.yml", parseYaml(yaml))).not.toEqual([]);
  });

  it.each([
    [
      "the safe shape: pull_request_target + default (base) checkout",
      "on:\n  pull_request_target:\n    branches: [main]\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n",
    ],
    [
      "fetching PR objects as data, never checking them out",
      "on:\n  pull_request_target:\njobs:\n  a:\n    env:\n      K: ${{ secrets.NDA_TERMS }}\n    steps:\n      - uses: actions/checkout@abc\n      - run: git fetch --no-tags origin +refs/pull/1/head:refs/scan/head && git rev-parse refs/scan/head\n",
    ],
    [
      "a PR-head checkout with NO secret anywhere — nothing to steal",
      "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n",
    ],
    [
      "`ref: ${{ github.sha }}` under pull_request_target — the SAME expression, and there it is the base tip",
      "on:\n  pull_request_target:\n    branches: [main]\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n        with:\n          ref: ${{ github.sha }}\n",
    ],
    ["not PR-reachable at all", "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n      - run: npm ci\n"],
  ])("does NOT flag: %s", (_label, yaml) => {
    expect(credentialExposures("fixture.yml", parseYaml(yaml))).toEqual([]);
  });
});

/**
 * The `workflow_call` callee, kept in its own block because it is the one rule whose justification is
 * "this file cannot know the answer" rather than "this file can see the answer".
 *
 * Raised as a P1 against an earlier version of this guard by an adversarial review, and narrowed on
 * verification: the caller-side rule already fails closed for the ordinary shape, and there are ZERO
 * `workflow_call` workflows anywhere in the AIOS tree today. It is latent, not live. It is closed
 * anyway — the residual gap is real (a callee naming `secrets.FOO` in its own `env:`, reached from a
 * caller that passes nothing, is audited by neither side), it is cheap, and the same class turned up
 * independently in the parallel workspace policy-checker. A rule that is one reusable workflow away
 * from mattering is worth having before the reusable workflow, not after.
 */
describe("guard: a `workflow_call` callee assumes the worst about its caller", () => {
  const callee = (step: string) =>
    parseYaml(`on:\n  workflow_call:\njobs:\n  a:\n    env:\n      K: \${{ secrets.AIOS_API_KEY }}\n    steps:\n${step}`);

  it("flags a DEFAULT checkout in a callee holding its own secret", () => {
    // The gap itself. The caller passes nothing, so the caller-side rule `continue`s past that job
    // with no secrets in scope — this file is the only place the exposure can be seen.
    const found = credentialExposures("inner.yml", callee("      - uses: actions/checkout@abc\n"));
    expect(found).not.toEqual([]);
    expect(found[0].why, "the message must name WHOSE ref it is, or it is unactionable").toMatch(/CALLER's ref/);
  });

  it("flags an EXPRESSION ref in a callee for the same reason", () => {
    expect(credentialExposures("inner.yml", callee("      - uses: actions/checkout@abc\n        with:\n          ref: \${{ inputs.ref }}\n"))).not.toEqual([]);
  });

  it("does NOT flag an explicit, trusted, literal ref — the waiver has to exist", () => {
    // Otherwise this is a blanket false positive dressed up as a rule, and the next person deletes it.
    // A literal SHA cannot be redirected by a caller, so the callee no longer depends on its trust.
    expect(
      credentialExposures(
        "inner.yml",
        callee("      - uses: actions/checkout@abc\n        with:\n          ref: dd42b4fe421d436bf1a8993ab62f79d35e4ad63b\n")
      )
    ).toEqual([]);
  });

  it("does NOT flag a callee with no secret in scope", () => {
    expect(
      credentialExposures("inner.yml", parseYaml("on:\n  workflow_call:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n"))
    ).toEqual([]);
  });

  it("the CALLER-side rule still fires independently — the two do not mask each other", () => {
    // Both halves of the pair must be catchable on their own, because in a real repository they are
    // two files and a reviewer may only be looking at one of them.
    const caller = parseYaml("on:\n  pull_request:\njobs:\n  a:\n    uses: ./.github/workflows/inner.yml\n    secrets: inherit\n");
    const callerFindings = credentialExposures("caller.yml", caller);
    expect(callerFindings).not.toEqual([]);
    expect(callerFindings[0].why).toMatch(/cannot see through/);
    expect(callerFindings[0].why, "`secrets: inherit` must count as a credential in scope").toMatch(/<inherit>/);
    // …and the callee half, in the same assertion, so a change that collapses one into the other reds.
    expect(credentialExposures("inner.yml", callee("      - uses: actions/checkout@abc\n"))).not.toEqual([]);
  });

  it("is honest that this is latent: there are no `workflow_call` workflows to protect yet", () => {
    // If this ever fails, the rule above stopped being hypothetical and the new file needs reading.
    const callers = files().filter((f) => triggers(load(f)).includes("workflow_call"));
    expect(callers, "a reusable workflow appeared — check it against the rule above").toEqual([]);
  });
});

describe("guard: pr-task-link.yml specifically", () => {
  const FILE = "pr-task-link.yml";
  const doc = () => load(FILE);
  const job = () => doc().jobs!["work-key"];

  it("has no PR-head checkout and no credential exposure of any kind", () => {
    expect(credentialExposures(FILE, doc())).toEqual([]);
    // Belt and braces on the exact regression, over the EXECUTABLE lines only — the file's header
    // names the forbidden shape in prose on purpose, and a guard that cannot tell the warning from
    // the vulnerability would push someone to delete the warning.
    const code = text(FILE)
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/ref:\s*\$\{\{[^}]*github\.event\.pull_request\.head/);
    expect(code).not.toMatch(/ref:\s*\$\{\{[^}]*github\.head_ref/);
  });

  it("runs ONLY on pull_request_target — an added `pull_request` trigger restores the hole", () => {
    // Not "includes pull_request_target": declaring BOTH would run the PR's own copy of this file
    // with the same secrets, and every other assertion here would still pass.
    expect(triggers(doc())).toEqual(["pull_request_target"]);
  });

  it("is pinned to `main`, which is what the environment's branch policy allows", () => {
    // On pull_request_target the run's ref is the PR's BASE branch, and `trusted-automation` only
    // permits `main`. A PR into any other branch would be refused the environment and go RED — and
    // this check is advisory, so it is never allowed to go red. The two settings move together.
    const on = doc().on as Record<string, { branches?: unknown; types?: unknown }>;
    expect(on.pull_request_target.branches).toEqual(["main"]);
    expect(on.pull_request_target.types).toEqual(["opened", "edited", "synchronize", "reopened"]);
  });

  it("takes its credentials from the `trusted-automation` environment", () => {
    expect(job().environment).toBe("trusted-automation");
    expect(secretRefs(job())).toEqual(["AIOS_API_KEY", "AIOS_BRAIN_URL", "AIOS_TEAM"]);
  });

  it("requests `contents: read` and NOTHING else", () => {
    // `statuses: write` / `checks: write` in a PR-reachable workflow can mint a required context on
    // an arbitrary SHA — see workflow-permissions.test.ts. This one has no business with either.
    expect((doc() as { permissions?: unknown }).permissions).toEqual({ contents: "read" });
    expect(job().permissions, "no job-level widening either").toBeUndefined();
  });

  it("cannot fail a pull request", () => {
    expect(job()["continue-on-error"]).toBe(true);
    // The script swallows its own errors too; both layers are load-bearing for "advisory".
    expect(text(FILE)).toMatch(/\}\)\(\)\.catch\(/);
  });

  it("pins every action by full commit SHA", () => {
    const uses = asSteps(job()).map(usesId).filter(Boolean);
    expect(uses.length, "no actions found — this assertion would be vacuous").toBeGreaterThan(0);
    for (const u of uses) expect(u, `${u} is not pinned by SHA`).toMatch(/@[0-9a-f]{40}$/);
  });

  it("STILL verifies that a work key exists in the brain, not merely that it matches", () => {
    // The regression this check was rewritten to fix, and the one most likely to be lost in a
    // security rewrite: a key that matches the PATTERN is not a key that EXISTS. Shape alone is not
    // a check — that is how a session's worth of invented `AIO-48x` keys went green.
    const body = text(FILE);
    expect(body).toContain("scripts/pr-work-keys.mjs");
    expect(body, "the by-key question (brain-api 1.14)").toContain("mode=table&keys=");
    expect(body, "the pre-1.14 fallback").toContain("?all=1");
    expect(body).toContain("unknownKeysFrom(body)");
    expect(body).toContain("verifyKeys(keys, knownKeysFrom(body)");
    expect(body).toContain("TASKS_PAGE_BOUND");
    expect(body, "and the soft skip when the environment has no credentials yet").toMatch(
      /brain credentials not configured/
    );
  });

  it("reads PR metadata as DATA, never as a `run:` interpolation", () => {
    // Interpolation is substituted before the shell parses, so a PR title is a command-injection
    // primitive in a job that holds a durable credential. The payload is read from the event file.
    expect(text(FILE)).toContain("process.env.GITHUB_EVENT_PATH");
    const runs = asSteps(job()).map((s) => (typeof s.run === "string" ? s.run : ""));
    expect(runs.filter(Boolean).length, "no run blocks found — this would be vacuous").toBeGreaterThan(0);
    for (const run of runs) {
      // NO INTERPOLATION AT ALL, not "no dangerous interpolation". A narrower rule — banning only
      // `github.event.pull_request.title|body|head` — is what an earlier version of this assertion
      // said, and it passed a draft of the workflow whose own JS comment contained a literal
      // expression: GitHub scans a `run:` block for expressions with no idea that JavaScript has
      // comments, so that draft would have failed to evaluate on every run. `actionlint` caught it,
      // this catches it, and the bright line is cheaper to hold than the taxonomy.
      expect(run, "a `run:` block in this job must contain no workflow expression whatsoever").not.toContain("${{");
    }
  });
});
