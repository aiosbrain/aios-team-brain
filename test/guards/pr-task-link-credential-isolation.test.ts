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
 * EMPTY, and that is the claim this file now makes: every PR-reachable workflow in this repository
 * is asserted clean, with no exception.
 *
 * It held `aios-work-sync.yml` until Phase 0 item 5 of the leak-gate remediation plan. That workflow
 * ran on `pull_request: [closed]` gated by `merged == true` — and the gate lived in the same file,
 * which on `pull_request` GitHub takes from the pull request's head. So the gate was not a gate: a
 * same-repository branch could delete it, print the three brain secrets, and CLOSE ITS OWN UNMERGED
 * pull request to fire the job. `closed` fires on any close. It is now `pull_request_target` with a
 * same-repository condition, base-branch code only, and `environment: trusted-automation`; the
 * `aios-work-sync.yml specifically` block below pins each of those.
 *
 * A name added back to this list is a new hole. A name left on it after its workflow was fixed makes
 * the list lie about what is outstanding — which is why the assertion below is an exact-set equality
 * in both directions rather than a subset check.
 */
const KNOWN_GAPS = new Set<string>([]);

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

  it("the gap list is EMPTY — no workflow here is excused from the rule", () => {
    // Two failure modes, both real. A new name silently added to the list is a new hole; a name left
    // on the list after its workflow was fixed makes the list lie about what is outstanding.
    expect([...KNOWN_GAPS]).toEqual([]);
    for (const f of KNOWN_GAPS) {
      expect(credentialExposures(f, load(f)), `${f} no longer trips this — remove it from KNOWN_GAPS`).not.toEqual([]);
    }
  });

  it("the exclusion is still WIRED, so emptying the list did not disarm the filter", () => {
    // With no entries the `for` loop above is inert and the `.filter(…)` in the sweep is a no-op, so
    // neither can any longer show that KNOWN_GAPS does anything. Without this, someone could delete
    // the mechanism entirely and every assertion in this file would stay green — and the NEXT hole
    // would be waved through by a list that no longer exists. Proven by exercising the filter over a
    // known-dirty file name instead of by reading the source.
    const dirty = "aios-work-sync-preimage.yml";
    const preimage = parseYaml(
      "on:\n  pull_request:\n    types: [closed]\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - uses: actions/checkout@abc\n"
    ) as Workflow;
    expect(credentialExposures(dirty, preimage), "the pre-fix shape must still be a finding").not.toEqual([]);
    const gaps = new Set([dirty]);
    expect([dirty].filter((f) => !gaps.has(f)), "a listed name is excluded from the sweep").toEqual([]);
    expect([dirty].filter((f) => !KNOWN_GAPS.has(f)), "an unlisted name is not").toEqual([dirty]);
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

  /**
   * THE REFUTED pull_request_target MODEL MUST BE GONE AS A CLAIM, not as a phrase and not as a line.
   *
   * THREE VERSIONS, and each hole was found by a different reviewer, so the history is the spec:
   *   v1 forbade two exact strings. Fable: green over a file asserting the same model four lines up
   *      in different words. A phrase pin proves the text changed, not the model.
   *   v2 forbade a FAMILY of phrasings, and stripped whole LINES carrying a retraction word so the
   *      corrections could quote the old claim in order to retract it. gpt-6-astra broke it with one
   *      line: `# The main-only policy is obsolete; the ref is always the base branch.` — "obsolete"
   *      strips the line, live assertion and all. It also showed the positive half was satisfiable by
   *      deleting every explanation and keeping the literal date.
   *   v3 (this one) exempts QUOTED and PARENTHETICAL spans instead of whole lines, on a rule that is
   *      easy to follow and easy to check: **history goes in quotes or parentheses; assertions do
   *      not.** An unquoted, unparenthesised assertion is always caught, however it is worded, and
   *      whatever retraction words share its line.
   */
  /**
   * v4. THE v3 STRIPPER WAS BLIND TO A THIRD OF THE FILE IT CERTIFIED, and Fable measured it: 35.3% of
   * `pr-task-link.yml`. `/"[^"]*"/` lets `[^"]*` cross NEWLINES, and the `run:` heredoc contains odd
   * numbers of `"` per line, so quote pairing ran away — two spans of 16 and 18 lines, executable code
   * included, were being deleted before matching. An assertion inserted anywhere inside them was
   * invisible. An unbalanced `(` in any comment did the same thing until the next `)`.
   *
   * Two changes, both narrowing: only COMMENT lines are considered at all (an assertion about the
   * event model lives in a comment, never in code), and a span may not cross a line.
   */
  const COMMENT_LINE = /^\s*(#|\/\/)/;
  const HISTORY_SPAN = /"[^"\n]*"|\([^)\n]*\)/g;   // quoted or parenthetical, WITHIN ONE LINE
  /**
   * v5 — TRAILING comments count. v4 filtered to lines that BEGIN with a marker, so
   * `statuses: write # …the ref is always the base branch` was structurally invisible. That is not a
   * hypothetical: `nda-gate.yml:19` was an actual carrier hiding in exactly that shape, and the file
   * asserted the corrected model 80 lines lower — one file saying both. A comment is a comment
   * wherever it sits.
   *
   * Over-inclusion is the safe direction here: a `#` inside a shell string in a `run:` body gets
   * treated as a comment tail, which can only cause a FALSE RED — loud, and fixable by quoting.
   * Under-inclusion is what just hid a carrier.
   */
  const commentPart = (line: string): string =>
    COMMENT_LINE.test(line) ? line : (line.match(/\s(?:#|\/\/)\s?(.*)$/)?.[1] ?? "");
  const OLD_MODEL: readonly [RegExp, string][] = [
    [/ref is (?:always |ALWAYS )?the (?:pull request's )?base branch/i, "ref is the base branch"],
    [/run's ref is the pull request's target branch/i, "ref is the target branch"],
    [/(?:runs|executes) the BASE branch's/i, "code comes from the base branch"],
    [/default is the base branch/i, "checkout default is the base branch"],
    [/base.branch (?:code|scanner) only/i, "base-branch-code-only rule"],
    [/policy allows\s+`main`\s+only/i, "policy allows main only"],
    // "base SHA" — the vocabulary the EIGHTH carrier used. Fable found the text AND the gap: fixing
    // the line without adding the pattern leaves the guard unable to catch its return (mutation M16
    // SURVIVED until this row existed).
    [/base SHA/i, "check attaches to the base SHA"],
  ];
  /** The claim that must be POSITIVELY made — a date alone certifies nothing. */
  const CURRENT_MODEL = /default branch,? regardless of the pull request's base|evaluate against the default branch|ref is the DEFAULT branch|from the DEFAULT branch/;
  const assertions = (src: string) =>
    src.split("\n").map(commentPart).map((l) => l.replace(HISTORY_SPAN, " ")).join("\n");

  // FOUR files carry claims about these mechanics; ALL must be free of the refuted model.
  it.each([["pr-task-link.yml"], ["aios-work-sync.yml"], ["nda-gate.yml"], ["scan-on-merge.yml"]])(
    "%s never asserts the refuted model",
    (file) => {
      const live = assertions(text(file));
      for (const [re, label] of OLD_MODEL) {
        expect(live, `refuted model survives as an assertion: ${label}`).not.toMatch(re);
      }
    }
  );

  // Only the THREE `pull_request_target` workflows must positively state that model. `scan-on-merge`
  // is a `push` workflow — requiring it to state a rule that does not govern it would be the guard
  // teaching the wrong thing, so it gets its own assertion below.
  it.each([["pr-task-link.yml"], ["aios-work-sync.yml"], ["nda-gate.yml"]])(
    "%s states the CURRENT model, not merely a date",
    (file) => expect(text(file), "the current model must be STATED").toMatch(CURRENT_MODEL)
  );

  it("scan-on-merge.yml states that it is a `push` trigger and the change does NOT govern it", () => {
    // The distinction is the thing most likely to be flattened by a future reader "tidying" these
    // comments into agreement — and flattening it in either direction is a real error: the 2025-12-08
    // change moved `pull_request_target` to the default branch and left `push` alone.
    const src = text("scan-on-merge.yml");
    expect(src, "must name its own trigger semantics").toMatch(/ref is the PUSHED BRANCH|run's ref is the pushed branch/i);
    expect(src, "and must say the pull_request_target change does not apply").toMatch(/does NOT apply here|not that event/i);
  });

  it("is NON-VACUOUS in both directions, including the two evasions astra found", () => {
    // Direction 1 — a live assertion is caught however it is dressed.
    const plain = "# On pull_request_target the ref is always the base branch, so the policy is satisfied.";
    const astraM10 = "# The main-only policy is obsolete; the ref is always the base branch.";
    for (const line of [plain, astraM10]) {
      expect(assertions(line), `must be caught: ${line}`).toMatch(OLD_MODEL[0][0]);
    }
    // Direction 2 — a genuine retraction is exempt, so the rule does not push authors to delete history.
    for (const line of ['# It said "the ref is always the base branch"; that was the pre-2025-12-08 model.',
                        "# The ref is the DEFAULT branch (it was the base branch until 2025-12-08)."]) {
      expect(assertions(line), `must be exempt: ${line}`).not.toMatch(OLD_MODEL[0][0]);
    }
    // astra M11 — deleting the prose and keeping the date must NOT satisfy the positive half.
    expect("# 2025-12-08", "a bare date certifies nothing").not.toMatch(CURRENT_MODEL);

    // FABLE's v3 BREAK, as a standing control. An assertion placed deep in the `run:` body — inside
    // what the runaway quote-span used to swallow — must be seen. Reconstructed rather than described:
    // a line with an odd `"` upstream, then the assertion many lines later.
    // THE REAL SHAPE, not a paraphrase of it. A first version of this control had only ONE `"`, so
    // `/"[^"]*"/` never closed and nothing was stripped — it passed under the BROKEN stripper too,
    // which is a control that controls nothing. The bug needs a quote that OPENS before the assertion
    // and CLOSES after it, so the runaway span swallows the line in between.
    const runawayQuote = [
      '      # the script prints "Found work key(s)',
      "      - run: node scripts/pr-work-keys.mjs",
      "      # On pull_request_target the ref is always the base branch, so any author satisfies it.",
      '      # …and the log line ends with a closing " here',
    ].join("\n");
    expect(assertions(runawayQuote), "a runaway quote must not hide a later assertion").toMatch(OLD_MODEL[0][0]);
    // …and code lines are ignored entirely, so a string literal in a script cannot trip the guard.
    expect(assertions('      - run: echo "the ref is always the base branch"'), "code is not a claim").not.toMatch(OLD_MODEL[0][0]);

    // v5 control — Fable's EIGHTH carrier, which lived in a TRAILING comment and was structurally
    // invisible to v4. `nda-gate.yml:19` was exactly this shape.
    const trailing = "  statuses: write # on pull_request_target the ref is always the base branch";
    expect(assertions(trailing), "a trailing comment is still a comment").toMatch(OLD_MODEL[0][0]);
    // …and a trailing comment can retract, like any other.
    expect(assertions('  statuses: write # it said "the ref is always the base branch" until 2025-12-08'),
      "a trailing retraction is exempt").not.toMatch(OLD_MODEL[0][0]);
  });

  it("fires on exactly the release branch and the contribution base", () => {
    // WAS "pinned to `main`, which is what the environment's branch policy allows", and the
    // rationale under it was the pre-2025-12-08 event model: it said the run's ref is the PR's BASE
    // branch, so a PR into any other branch would be refused a `main`-only environment and go red.
    //
    // GitHub changed that effective 2025-12-08 — "For `pull_request_target`, environment rules
    // evaluate against the default branch" — so the base branch never decides the environment check,
    // and the trigger list and the policy are INDEPENDENT. The assertion below was always right; only
    // its reason was wrong, which is the more dangerous half to leave standing.
    //
    // What keeps this advisory check off red now is the `trusted-automation` policy containing the
    // DEFAULT branch (widened to `[main, staging]` before the default moved at the cutover).
    const on = doc().on as Record<string, { branches?: unknown; types?: unknown }>;
    expect(on.pull_request_target.branches).toEqual(["main", "staging"]);
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

/**
 * The file with every COMMENT removed — YAML `#` lines and the JavaScript `//` lines inside the
 * heredoc alike.
 *
 * These workflows describe the vulnerability they close, at length and on purpose, because the
 * control that failed here was a header that reasoned about the wrong threat. A guard that cannot
 * tell the warning from the practice would push the next person to delete the warning, so the
 * "must not contain X" assertions read this view rather than the raw text.
 */
const executable = (f: string): string =>
  text(f)
    .split("\n")
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join("\n");

describe("guard: aios-work-sync.yml specifically", () => {
  const FILE = "aios-work-sync.yml";
  const doc = () => load(FILE);
  const job = () => doc().jobs!["notify-brain"];

  it("has no credential exposure of any kind — this is what leaving KNOWN_GAPS means", () => {
    expect(credentialExposures(FILE, doc())).toEqual([]);
    // Belt and braces on the exact regression, over the executable lines only.
    const code = executable(FILE);
    expect(code).not.toMatch(/ref:\s*\$\{\{[^}]*github\.event\.pull_request\.head/);
    expect(code).not.toMatch(/ref:\s*\$\{\{[^}]*github\.head_ref/);
  });

  it("the comment stripper is NON-VACUOUS — it removes comments and keeps code", () => {
    // Otherwise `executable()` could silently return "" and every not-toContain assertion above
    // would pass by reading nothing at all.
    const code = executable(FILE);
    expect(code, "the checkout is code and must survive").toContain("actions/checkout@");
    expect(code, "so must the step env").toContain("PR_TITLE:");
    expect(code, "a YAML comment must not").not.toContain("pwn-request");
    expect(code, "nor a JS comment inside the heredoc").not.toContain("BASE-BRANCH CODE");
  });

  it("runs ONLY on pull_request_target — an added `pull_request` trigger restores the whole hole", () => {
    // Not "includes pull_request_target". Declaring BOTH would run the pull request's own copy of
    // this file with the same three secrets, and every other assertion here would still pass. That
    // is not hypothetical: `pull_request` IS the trigger this workflow shipped with, and on it the
    // `merged == true` gate below is contributor-editable, so an unmerged close fires the job.
    expect(triggers(doc())).toEqual(["pull_request_target"]);
  });

  it("carries an explicit branch filter — without one, a contributor picks the base", () => {
    // MANDATORY, and it is the non-obvious half of the fix. `pull_request_target` alone means the
    // "base" is whatever branch the pull request targets, so a collaborator pushes `evil`, opens
    // `evil2 -> evil`, and the trusted base-branch code IS their own tree. The filter is what makes
    // "base branch" mean a reviewed branch. Asserted as an EXACT SET, matching branch-roles.test.ts:
    // `[main, staging, "**"]` satisfies containment while widening to every branch in the repository.
    const on = doc().on as Record<string, { branches?: unknown; types?: unknown }>;
    expect(on.pull_request_target.branches).toEqual(["main", "staging"]);
    expect(on.pull_request_target.types).toEqual(["closed"]);
  });

  it("keeps `merged == true`, and adds the same-repository condition forks used to get for free", () => {
    // `closed` fires on ANY close, so `merged == true` is the whole of the merge semantics — it is
    // preserved, but now it lives in base-branch code where a pull request cannot delete it. The
    // second clause is new: under `pull_request` a fork run received no secrets and skipped
    // harmlessly, and `pull_request_target` would newly hand the brain credentials to a run an
    // outside contributor can start. Asserted as an exact string so dropping either half reds.
    expect(job().if).toBe(
      "github.event.pull_request.merged == true && github.event.pull_request.head.repo.full_name == github.repository"
    );
  });

  it("takes its credentials from the `trusted-automation` environment", () => {
    // The third and last `AIOS_*` consumer to enrol, which is what unblocks deleting the
    // repository-level copies. NOT a fork boundary: on `pull_request_target` the ref is the DEFAULT
    // branch (GitHub, effective 2025-12-08), so every author — fork or not — satisfies the policy
    // identically. An earlier version of this line said "always the base branch"; same conclusion,
    // obsolete mechanism. See the file header.
    expect(job().environment).toBe("trusted-automation");
    expect(secretRefs(job())).toEqual(["AIOS_API_KEY", "AIOS_BRAIN_URL", "AIOS_TEAM"]);
  });

  it("requests `contents: read` and NOTHING else", () => {
    expect((doc() as { permissions?: unknown }).permissions).toEqual({ contents: "read" });
    expect(job().permissions, "no job-level widening either").toBeUndefined();
  });

  it("checks out the BASE branch: a checkout with no `ref:`, pinned by full commit SHA", () => {
    const checkouts = asSteps(job()).filter(isCheckout);
    expect(checkouts.length, "no checkout found — the ref assertion would be vacuous").toBe(1);
    expect(stepRef(checkouts[0]), "any `ref:` at all is the pwn-request").toBeUndefined();
    const uses = asSteps(job()).map(usesId).filter(Boolean);
    expect(uses.length, "no actions found — this assertion would be vacuous").toBeGreaterThan(0);
    for (const u of uses) expect(u, `${u} is not pinned by SHA`).toMatch(/@[0-9a-f]{40}$/);
  });

  it("reads pull request metadata from `env:`, never as a `run:` interpolation", () => {
    // Interpolation is substituted before the shell parses, so a pull request TITLE is a
    // command-injection primitive in a job that holds a durable credential.
    const steps = asSteps(job());
    const runs = steps.map((s) => (typeof s.run === "string" ? s.run : ""));
    expect(runs.filter(Boolean).length, "no run blocks found — this would be vacuous").toBeGreaterThan(0);
    for (const run of runs) {
      // NO INTERPOLATION AT ALL, not "no dangerous interpolation" — GitHub scans a `run:` block for
      // expressions with no idea that JavaScript has comments, so even a commented-out one is
      // evaluated for real. `actionlint` caught that in the sibling workflow; the bright line is
      // cheaper to hold than the taxonomy.
      expect(run, "a `run:` block in this job must contain no workflow expression whatsoever").not.toContain("${{");
    }
    // …and the values really do arrive, so the rule above did not simply delete the feature.
    const stepEnv = steps.flatMap((s) => Object.entries(((s as { env?: Record<string, string> }).env ?? {})));
    const fromPr = stepEnv.filter(([, v]) => String(v).includes("github.event.pull_request."));
    expect(fromPr.map(([k]) => k).sort()).toEqual([
      "PR_BODY",
      "PR_HEAD_REF",
      "PR_HEAD_SHA",
      "PR_HTML_URL",
      "PR_MERGED_BY",
      "PR_MERGE_COMMIT_SHA",
      "PR_TITLE",
      "PR_USER",
    ]);
    const body = text(FILE);
    for (const [name] of fromPr) expect(body, `${name} must be read with process.env`).toContain(`process.env.${name}`);
    // The enumerated set above is the POINT: a whole-payload read would make the trusted field list
    // implied rather than visible, so the workflow must not go back to parsing the event file.
    // EXECUTABLE LINES ONLY — both the YAML header and the inline JS say the words "no longer parses
    // GITHUB_EVENT_PATH" on purpose, and a guard that cannot tell the explanation from the practice
    // would push the next person to delete the explanation.
    expect(executable(FILE), "no whole-payload read").not.toContain("GITHUB_EVENT_PATH");
  });

  it("STILL posts the merged work event through the ONE shared matcher", () => {
    // The regression most likely to be lost in a security rewrite: this is the only step that closes
    // a task. `scripts/pr-work-keys.mjs` is shared with pr-task-link.yml precisely because two inline
    // copies disagreed once — the advisory check cleared a PR whose keys this step read differently.
    const body = text(FILE);
    expect(body).toContain("scripts/pr-work-keys.mjs");
    expect(body).toContain("extractWorkKeys");
    expect(body).toContain("/api/v1/work-events");
    expect(body, "the pushed project decides applied-vs-linked").toContain("AIOS_PROJECT: aios-team-brain");
  });

  it("fails LOUDLY — it is the only thing that closes a task", () => {
    // The opposite requirement to pr-task-link.yml, which is advisory and `continue-on-error: true`.
    // A silent skip here leaves the board wrong with a green tick next to it.
    expect(job()["continue-on-error"], "must not be excused from failing").toBeUndefined();
    expect(text(FILE)).toContain("process.exit(1)");
  });
});

/**
 * ENROLMENT COMPLETENESS — the precondition for deleting the repository-level secrets.
 *
 * `AIOS_API_KEY` / `AIOS_BRAIN_URL` / `AIOS_TEAM` exist twice over: as repository secrets, which
 * GitHub hands to EVERY job, and (once entered) as `trusted-automation` environment secrets, which
 * only jobs naming that environment can read. An environment secret merely SHADOWS a same-named
 * repository secret — so the environment becomes load-bearing only when the repository copies are
 * DELETED, and deleting them breaks any consumer that has not enrolled.
 *
 * So the guard is not "these three files name the environment", which a rename would empty. It is:
 * every job anywhere in this repository that reads one of the three MUST name the environment. A new
 * consumer added without it is caught here rather than by a red workflow after the deletion.
 *
 * STATED LIMIT, because this is exactly where an overstated guard would do harm: naming the
 * environment does NOT scope the credential, and a green result here is not evidence that the
 * repository-level copies are gone. That deletion is a repository-admin action this file cannot see.
 */
describe("guard: every AIOS_* credential consumer is enrolled in `trusted-automation`", () => {
  const BRAIN_SECRETS = ["AIOS_API_KEY", "AIOS_BRAIN_URL", "AIOS_TEAM"];

  /** [file, jobId] for every job with one of the three brain secrets in scope. */
  const consumers = (): [string, string][] =>
    files().flatMap((f) => {
      const doc = load(f);
      const wf = secretRefs(doc?.env);
      return Object.entries(doc?.jobs ?? {})
        .filter(([, job]) => [...wf, ...secretRefs(job)].some((s) => BRAIN_SECRETS.includes(s)))
        .map(([id]) => [f, id] as [string, string]);
    });

  it("finds exactly the three known consumers — a rename cannot empty this", () => {
    // Enumerated, so a fourth consumer appearing is a deliberate decision rather than a silent one.
    expect(consumers().map(([f, j]) => `${f}:${j}`).sort()).toEqual([
      "aios-work-sync.yml:notify-brain",
      "pr-task-link.yml:work-key",
      "scan-on-merge.yml:scan",
    ]);
  });

  it("every one of them names the environment", () => {
    const unenrolled = consumers()
      .filter(([f, j]) => load(f).jobs![j].environment !== "trusted-automation")
      .map(([f, j]) => `${f} [job:${j}]`);
    expect(
      unenrolled,
      `these read a brain secret without naming trusted-automation, so deleting the repository-level copies would break them:\n${unenrolled.join("\n")}`
    ).toEqual([]);
  });

  it("is NON-VACUOUS: an unenrolled consumer is detected", () => {
    const doc = parseYaml(
      "on:\n  push:\njobs:\n  a:\n    env:\n      K: ${{ secrets.AIOS_API_KEY }}\n    steps:\n      - run: 'true'\n"
    ) as Workflow;
    expect(doc.jobs!["a"].environment, "the fixture must really lack it").toBeUndefined();
    expect(secretRefs(doc.jobs!["a"]).some((s) => BRAIN_SECRETS.includes(s))).toBe(true);
  });
});
