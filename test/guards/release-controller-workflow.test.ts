/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const file = ".github/workflows/release-controller.yml";
const raw = readFileSync(file, "utf8");
const workflow = YAML.parse(raw);

describe("trusted release-controller workflow wiring", () => {
  it("is dispatch-only, serialized across normal/emergency, and keeps GITHUB_TOKEN read-only", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toMatchObject({ group: "aios-main-promotion", "cancel-in-progress": false });
  });
  it("uses separate protected environments and checks out only trusted staging code", () => {
    expect(workflow.jobs.normal.environment).toBe("staging-release");
    expect(workflow.jobs.emergency.environment).toBe("staging-emergency");
    for (const job of Object.values<any>(workflow.jobs)) {
      const checkout = job.steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toMatchObject({ ref: "staging", "persist-credentials": false });
    }
  });
  it("never executes candidate code and scopes App secrets to their own job", () => {
    expect(raw).not.toMatch(/checkout[^\n]*\$\{\{\s*inputs\.tag|ref:\s*\$\{\{\s*inputs\.tag/);
    expect(JSON.stringify(workflow.jobs.normal)).not.toContain("EMERGENCY_APP_PRIVATE_KEY");
    expect(JSON.stringify(workflow.jobs.emergency)).not.toContain("RELEASE_APP_PRIVATE_KEY");
    expect(raw).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });
});
