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
  it("uses separate protected environments and checks out the trusted IMMUTABLE dispatch SHA", () => {
    expect(workflow.jobs.normal.environment).toBe("staging-release");
    expect(workflow.jobs.emergency.environment).toBe("staging-emergency");
    for (const [name, job] of Object.entries<any>(workflow.jobs)) {
      // `if: github.ref == 'refs/heads/staging'` already pins WHERE the dispatch may come from.
      expect(job.if, `${name} does not pin the dispatch ref`).toContain("github.ref == 'refs/heads/staging'");
      const checkout = job.steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
      // …and the checkout takes the SHA, not the branch NAME: a moving ref would run whatever
      // landed on staging between dispatch and job start, with App credentials in scope.
      expect(checkout.with, `${name} checks out a moving ref`).toMatchObject({
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      });
    }
  });

  it("binds candidate deployment evidence to the pinned staging service and environment", () => {
    const measure = workflow.jobs.normal.steps.find((s: any) => s.env?.RELEASE_ACTION);
    expect(Object.keys(measure.env)).toEqual(expect.arrayContaining([
      "RAILWAY_STAGING_ENVIRONMENT_ID", "RAILWAY_STAGING_APP_SERVICE_ID",
    ]));
    // Production speaks the ORDINARY health contract; it does not hold a staging health token, so
    // handing one to the production probe could only ever produce a 401.
    expect(JSON.stringify(measure.env)).not.toContain("PRODUCTION_HEALTH_TOKEN");
  });
  it("never executes candidate code and scopes App secrets to their own job", () => {
    expect(raw).not.toMatch(/checkout[^\n]*\$\{\{\s*inputs\.tag|ref:\s*\$\{\{\s*inputs\.tag/);
    expect(JSON.stringify(workflow.jobs.normal)).not.toContain("EMERGENCY_APP_PRIVATE_KEY");
    expect(JSON.stringify(workflow.jobs.emergency)).not.toContain("RELEASE_APP_PRIVATE_KEY");
    expect(raw).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });
});
