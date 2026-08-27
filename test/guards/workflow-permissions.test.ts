import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RELPTR-3, Decision 5 — the `contents: read` property is CONFIGURATION, not law, so it gets a guard.
 * Spec: `docs/design/release-pointer-cutover-guard.md` (criteria 9, 10).
 *
 * WHY THIS EXISTS. The release-candidate gate's safety rests on a fact about this repository: no
 * automation can create, move or delete a tag. That is true today because the repo default is
 * `default_workflow_permissions: "read"` and every workflow declares `contents: read` or nothing —
 * and it is ONE pull request away from being false. A same-repository PR can add
 * `permissions: {contents: write}` and push or delete `refs/tags/*` DURING ITS OWN PR RUN, because a
 * `pull_request` run executes the PR's copy of the workflow. Both pre-code reviewers found this
 * independently; neither the gate nor any other in-repo check can defend against it after the fact.
 * A guard cannot prevent the change either — but it turns a silent capability grant into a red diff.
 *
 * SCOPE LIMIT, STATED. This covers `GITHUB_TOKEN` permissions only. Credentials supplied through
 * repository SECRETS (a PAT, a deploy key) are outside it, and nothing here claims otherwise.
 */

const WORKFLOWS = join(__dirname, "..", "..", ".github", "workflows");
const files = () => readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

/** Does this workflow text grant write access to repository CONTENTS (which includes refs/tags)? */
export function grantsContentsWrite(yaml: string): boolean {
  return /^\s*contents:\s*write\s*$/m.test(yaml);
}

/** Does it take the blanket grant? `write-all` includes contents, so it is the same hole, spelled differently. */
export function grantsWriteAll(yaml: string): boolean {
  return /^\s*permissions:\s*write-all\s*$/m.test(yaml);
}

describe("guard: no workflow may write repository contents (criterion 9)", () => {
  it("every workflow is free of `contents: write`", () => {
    const offenders = files().filter((f) => grantsContentsWrite(readFileSync(join(WORKFLOWS, f), "utf8")));
    expect(offenders, `these workflows could create or delete a tag: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every workflow is free of `permissions: write-all`", () => {
    const offenders = files().filter((f) => grantsWriteAll(readFileSync(join(WORKFLOWS, f), "utf8")));
    expect(offenders, `these workflows take the blanket grant: ${offenders.join(", ")}`).toEqual([]);
  });

  // ONE CONDITION PER FIXTURE. Two spellings, two separate tripping fixtures — a single fixture
  // carrying both would prove only whichever term is evaluated first.
  it("is NON-VACUOUS for `contents: write`", () => {
    expect(grantsContentsWrite("permissions:\n  contents: write\n")).toBe(true);
    expect(grantsContentsWrite("permissions:\n  contents: read\n")).toBe(false);
  });

  it("is NON-VACUOUS for `write-all`", () => {
    expect(grantsWriteAll("permissions: write-all\n")).toBe(true);
    expect(grantsWriteAll("permissions:\n  contents: read\n")).toBe(false);
  });

  it("does NOT flag the unrelated grants this repo legitimately uses", () => {
    // `nda-gate.yml` needs `statuses: write` to publish its trusted verdict onto the validated PR
    // head. That is neither spelling above, so it is untouched — stated explicitly so this is not
    // mistaken for an allowlist that could later be widened.
    const nda = readFileSync(join(WORKFLOWS, "nda-gate.yml"), "utf8");
    expect(nda).toMatch(/statuses:\s*write/);
    expect(grantsContentsWrite(nda), "statuses: write is not contents: write").toBe(false);
    expect(grantsWriteAll(nda)).toBe(false);
    // `scan-on-merge.yml` carries read-only issues/pull-requests grants; likewise untouched.
    const scan = readFileSync(join(WORKFLOWS, "scan-on-merge.yml"), "utf8");
    expect(grantsContentsWrite(scan)).toBe(false);
  });

  it("actually reads a non-trivial set of workflows, so a rename cannot empty it", () => {
    // An empty directory listing would make every assertion above vacuously true.
    expect(files().length).toBeGreaterThan(4);
    expect(files()).toContain("release-candidate.yml");
  });
});

/**
 * Criterion 10 — the gate's context NAME must be unique across all workflows.
 *
 * Branch protection identifies a required check by its CONTEXT NAME (optionally plus an app id) — NOT
 * by the workflow file that produced it, and GitHub warns that duplicate check names make
 * required-check behaviour ambiguous. So a second workflow declaring a job with the same name could
 * mint the accepted context on a commit the gate never examined, which is the wrong-green class this
 * whole slice exists to close.
 */
const CONTEXT = "Release candidate gate";

/** Job `name:` values, which are what become check-run names. */
export function jobNames(yaml: string): string[] {
  return [...yaml.matchAll(/^\s{4}name:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ""));
}

describe("guard: the gate's check context is unique (criterion 10)", () => {
  it("exactly one workflow declares a job named the gate's context", () => {
    const declaring = files().filter((f) => jobNames(readFileSync(join(WORKFLOWS, f), "utf8")).includes(CONTEXT));
    expect(declaring, `"${CONTEXT}" must be produced by exactly one workflow`).toEqual(["release-candidate.yml"]);
  });

  it("is NON-VACUOUS: the extractor finds the real name, and would find a duplicate", () => {
    // If `jobNames` returned nothing the assertion above would pass while a duplicate sat in the tree.
    const wf = readFileSync(join(WORKFLOWS, "release-candidate.yml"), "utf8");
    expect(jobNames(wf)).toContain(CONTEXT);
    expect(jobNames(`jobs:\n  a:\n    name: ${CONTEXT}\n  b:\n    name: ${CONTEXT}\n`)).toHaveLength(2);
  });
});
