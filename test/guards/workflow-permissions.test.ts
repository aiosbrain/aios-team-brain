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
type Workflow = { permissions?: unknown; jobs?: Record<string, { permissions?: unknown; name?: unknown }> };
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
  // Publishes its trusted verdict onto the validated PR head — the whole point of the NDA gate, and
  // it runs on `pull_request_target`, i.e. the BASE copy, not a PR's own edited copy.
  "nda-gate.yml": new Set(["statuses"]),
};

export function forgingGrants(file: string, doc: Workflow): Grant[] {
  const allowed = ALLOWLIST[file] ?? new Set<string>();
  return writeGrants(doc).filter((g) => FORGING_SCOPES.has(g.scope) && !allowed.has(g.scope));
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

  it("allowlists nda-gate's `statuses: write` NARROWLY — that one file, that one scope", () => {
    // It is an allowlist, and it is deliberately keyed on both file AND scope: the same grant in any
    // other workflow is the forge route above, and a different scope in nda-gate is not covered.
    expect(forgingGrants("nda-gate.yml", parseYaml("permissions:\n  statuses: write\n"))).toEqual([]);
    expect(forgingGrants("nda-gate.yml", parseYaml("permissions:\n  contents: write\n"))).not.toEqual([]);
    expect(forgingGrants("other.yml", parseYaml("permissions:\n  statuses: write\n"))).not.toEqual([]);
    // …and the real file still only wants what the allowlist grants it.
    expect(forgingGrants("nda-gate.yml", load("nda-gate.yml"))).toEqual([]);
    expect(writeGrants(load("nda-gate.yml")).map((g) => g.scope)).toEqual(["statuses"]);
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

describe("guard: the gate's check context is unique (criterion 10)", () => {
  it("exactly one workflow can produce the gate's context name", () => {
    const declaring = files().filter((f) => jobNames(load(f)).includes(CONTEXT));
    expect(declaring, `"${CONTEXT}" must be produced by exactly one workflow`).toEqual(["release-candidate.yml"]);
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
