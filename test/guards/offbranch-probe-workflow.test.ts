import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  INDUCED_EVENTS, PROBE_BRANCH, PROBE_JOB_IF, PROBE_JOBS, PROBE_WORKFLOW_PATH, PROBE_WORKFLOW_SHA256,
  assertInertProbeWorkflow, inducedAutomation,
} from "../../scripts/staging-ops/offbranch-probe.mjs";

/**
 * AIO-1124 PC-06 — the inert off-branch probe workflow, enumerated COMPLETELY.
 *
 * The accepted design fixes this file's whole shape: `workflow_dispatch` only with no inputs,
 * `permissions: {}`, two independent jobs with explicit names equal to their keys, each bound to one
 * protected environment, one literal no-op each, and admission on the exact repository, event, full
 * ref and attempt 1. No checkout, action, reusable workflow, secret, variable, credential or
 * candidate code. The bytes are pinned, so ANY edit — a comment included — is red until reviewed.
 */

const ROOT = join(__dirname, "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const bytes = readFileSync(join(ROOT, PROBE_WORKFLOW_PATH));
const text = bytes.toString("utf8");
const doc = parseYaml(text);
const allWorkflows = () => Object.fromEntries(readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => [`.github/workflows/${file}`, parseYaml(readFileSync(join(WORKFLOWS, file), "utf8"))]));

describe("the inert off-branch probe workflow (PC-06)", () => {
  it("is exactly the reviewed bytes", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PROBE_WORKFLOW_SHA256);
  });

  it("parses to exactly the enumerated inert shape", () => {
    expect(assertInertProbeWorkflow(doc)).toBe(true);
    expect(doc).toEqual({
      name: "release-environment-negative-probe",
      on: { workflow_dispatch: null },
      permissions: {},
      jobs: Object.fromEntries(PROBE_JOBS.map((job: { job_key: string; environment: string }) => [job.job_key, {
        name: job.job_key, if: PROBE_JOB_IF, "runs-on": "ubuntu-latest", "timeout-minutes": 1, environment: job.environment, steps: [{ run: ":" }],
      }])),
    });
  });

  it("names the fixed repository, event, full probe ref and attempt 1 in each job's admission", () => {
    expect(PROBE_JOB_IF).toBe(`github.repository == 'aiosbrain/aios-team-brain' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/${PROBE_BRANCH}' && github.run_attempt == 1`);
  });

  it("carries no credential, variable, action, checkout, input, interpolation or dependency", () => {
    const body = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    for (const forbidden of ["secrets", "vars.", "uses:", "checkout", "inputs", "${{", "needs:", "env:", "services:", "container:", "with:", "shell:", "permissions: write", "GITHUB_TOKEN"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("refuses each single deviation from the inert shape", () => {
    const clone = () => JSON.parse(JSON.stringify(doc));
    const mutations: Array<(d: any) => void> = [
      (d) => { d.on = { workflow_dispatch: { inputs: { ref: { type: "string" } } } }; },
      (d) => { d.on = { workflow_dispatch: null, push: null }; },
      (d) => { d.permissions = { contents: "read" }; },
      (d) => { delete d.permissions; },
      (d) => { d.jobs["probe-release"].permissions = {}; },
      (d) => { d.jobs["probe-release"].needs = "probe-emergency"; },
      (d) => { d.jobs["probe-release"].steps = [{ uses: "actions/checkout@v4" }, { run: ":" }]; },
      (d) => { d.jobs["probe-release"].steps = [{ run: "echo ${{ secrets.X }}" }]; },
      (d) => { d.jobs["probe-release"].environment = "staging-emergency"; },
      (d) => { d.jobs["probe-release"].name = "Probe release"; },
      (d) => { d.jobs["probe-release"].if = PROBE_JOB_IF.replace(" && github.run_attempt == 1", ""); },
      (d) => { d.jobs["probe-release"]["timeout-minutes"] = 30; },
      (d) => { d.jobs.extra = { ...d.jobs["probe-release"] }; },
      (d) => { d.env = { A: "1" }; },
    ];
    for (const mutate of mutations) {
      const d = clone();
      mutate(d);
      expect(() => assertInertProbeWorkflow(d)).toThrow();
    }
  });
});

describe("no other workflow is induced by the probe ref's lifecycle (PC-06)", () => {
  it("holds for every workflow in this repository", () => {
    const docs = allWorkflows();
    expect(Object.keys(docs).length).toBeGreaterThan(5);
    expect(docs[PROBE_WORKFLOW_PATH]).toBeDefined();
    expect(inducedAutomation(docs)).toEqual([]);
  });

  it("refuses an induced event, an unfiltered push, a pattern, an ignore filter or the probe branch", () => {
    for (const event of INDUCED_EVENTS as string[]) {
      expect(inducedAutomation({ "x.yml": { on: { [event]: null } } }).length, event).toBe(1);
    }
    expect(inducedAutomation({ "x.yml": { on: "push" } })).toHaveLength(1);
    expect(inducedAutomation({ "x.yml": { on: ["push", "pull_request"] } })).toHaveLength(1);
    expect(inducedAutomation({ "x.yml": { on: { push: { branches: ["remediation/**"] } } } })).toHaveLength(1);
    expect(inducedAutomation({ "x.yml": { on: { push: { "branches-ignore": ["main"] } } } })).toHaveLength(1);
    expect(inducedAutomation({ "x.yml": { on: { push: { branches: [PROBE_BRANCH] } } } })).toHaveLength(1);
    expect(inducedAutomation({ "x.yml": { on: { push: { branches: ["main", "staging"] } } } })).toEqual([]);
    expect(inducedAutomation({ "x.yml": { on: { push: { tags: ["v*"] } } } })).toEqual([]);
  });
});
