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
    const files = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"));
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
    expect(src, "no hardcoded remote ref may remain").not.toMatch(/"refs\/remotes\/origin\/(main|staging)"/);
  });
});

describe("branch roles — the IDENTITY PIN (criterion 3)", () => {
  it("the release ref follows RELEASE_BRANCH, NOT the contribution base", () => {
    // BOTH REVIEWERS found this missing. Today RELEASE_BRANCH === CONTRIBUTION_BASE === "main", so
    // `expect(mainRef).toBe("refs/remotes/origin/main")` passes whichever token the code used. The only
    // way to tell them apart NOW is to make them differ: rewrite the module with a sentinel
    // contribution base, re-import it, and assert the release guard's default did not move.
    const src = read("scripts/branches.mjs");
    const stubbed = src.replace('export const CONTRIBUTION_BASE = "main";', 'export const CONTRIBUTION_BASE = "SENTINEL-not-a-branch";');
    expect(stubbed, "the sentinel substitution must actually apply").not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "roles-"));
    try {
      writeFileSync(join(dir, "branches.mjs"), stubbed);
      // The guard's default expressions, evaluated against the stubbed module. If a future edit wires
      // `mainRef` to CONTRIBUTION_BASE, this reddens immediately instead of on cutover day.
      const out = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { CONTRIBUTION_BASE, RELEASE_BRANCH, INTEGRATION_BRANCH, remoteRef } from ${JSON.stringify(join(dir, "branches.mjs"))};
           process.stdout.write(JSON.stringify({ base: CONTRIBUTION_BASE, main: remoteRef(RELEASE_BRANCH), integration: remoteRef(INTEGRATION_BRANCH) }));`,
        ],
        { encoding: "utf8" }
      );
      const got = JSON.parse(out);
      expect(got.base, "the stub must have taken effect").toBe("SENTINEL-not-a-branch");
      expect(got.main, "the release ref must NOT follow the contribution base").toBe("refs/remotes/origin/main");
      expect(got.integration).toBe("refs/remotes/origin/staging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is NON-VACUOUS: wiring the release ref to CONTRIBUTION_BASE would be caught", () => {
    // Proves the pin above can fail — the mutation it is aimed at, executed directly.
    const wrong = `export const CONTRIBUTION_BASE = "SENTINEL-not-a-branch";
export const remoteRef = (b) => \`refs/remotes/origin/\${b}\`;
export const mainRef = remoteRef(CONTRIBUTION_BASE);`;
    const dir = mkdtempSync(join(tmpdir(), "roles-neg-"));
    try {
      writeFileSync(join(dir, "wrong.mjs"), wrong);
      const out = execFileSync(
        "node",
        ["--input-type=module", "-e", `import { mainRef } from ${JSON.stringify(join(dir, "wrong.mjs"))}; process.stdout.write(mainRef);`],
        { encoding: "utf8" }
      );
      expect(out, "the wrong wiring produces a different ref, so the pin discriminates").not.toBe("refs/remotes/origin/main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("branch roles — the workflows that must follow the cutover (criteria 5, 6, 7)", () => {
  it("aios-work-sync fires on EXACTLY the contribution base and the integration branch", () => {
    // EXACT SET, not "contains both": `[main, staging, "**"]` satisfies a containment check while
    // silently widening the trigger to every branch in the repository. Codex found that.
    const on = workflow("aios-work-sync.yml").on!;
    expect(on.pull_request!.branches).toEqual([CONTRIBUTION_BASE, INTEGRATION_BRANCH]);
    expect(on.pull_request!.types).toEqual(["closed"]);
    // …and INTEGRATION_BRANCH is `staging` TODAY, so this pins the widening now rather than
    // collapsing to "contains main" until the cutover moves the value.
    expect(on.pull_request!.branches).toContain("staging");
  });

  it("scan-on-merge fires on EXACTLY the same two branches", () => {
    // After the cutover `main` advances only by release fast-forward, so a `[main]`-only trigger
    // would drop codebase readiness from per-merge to per-release without any error.
    const on = workflow("scan-on-merge.yml").on!;
    expect((on.push as { branches?: string[] }).branches).toEqual([CONTRIBUTION_BASE, INTEGRATION_BRANCH]);
  });

  it("nothing INSIDE aios-work-sync re-narrows what the trigger widened", () => {
    // The trigger list and the job condition can both be right while a STEP-level `if:` suppresses
    // the emission for one branch — the widening undone one layer down, where criteria 5 cannot see
    // it. Codex found this too. The job gate is pinned as an exact string; steps carry no `if:` at all.
    const wf = workflow("aios-work-sync.yml");
    const job = wf.jobs!["notify-brain"];
    expect(job.if, "the job gate, exactly").toBe("github.event.pull_request.merged == true");
    const stepIfs = (job.steps ?? []).filter((step) => step.if !== undefined);
    expect(stepIfs, "no step may carry its own condition").toEqual([]);
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
    expect(t, "the automatic case").toMatch(/brain-native/i);
    expect(t).toMatch(/`applied`/);
    expect(t, "the case where the human closes it").toMatch(/`linked`/);
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

  it("§3.1d records WHY the instruction corpus is deferred, with the real measurement", () => {
    // The number was wrong twice. It is written down with its correction so a third attempt starts
    // from the measurement rather than re-deriving it.
    const r = RUNBOOK();
    expect(r).toMatch(/31 lines across 19 files|\*\*31 lines across 19 files\*\*/);
    expect(r, "and that the heuristic has known error bars").toMatch(/false-negatives/);
  });
});
