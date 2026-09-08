import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = { uses?: string; run?: string };

describe("data-mechanics CI uses the direct Postgres service destination", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["datamechanics-tests"];

  it("runs inside the full Node 20 Bookworm image on the Postgres service network", () => {
    expect(job.name, "the required branch-protection check name changed").toBe("Data-mechanics tests (real Postgres)");
    expect(job.container).toEqual({ image: "node:20-bookworm", options: "--init" });
    expect(job.env.DATABASE_TEST_URL).toBe("postgres://app:app@postgres:5432/app_test");
    expect(job.services.postgres.ports, "a job-container service does not need a host NAT mapping").toBeUndefined();
  });

  it("retains the required install, schema, test, and migration lanes", () => {
    const runs = (job.steps as WorkflowStep[]).flatMap((step) => step.run ? [step.run] : []);
    expect(runs).toEqual(expect.arrayContaining([
      "npm ci",
      'DATABASE_URL="$DATABASE_TEST_URL" npm run pg:schema',
      "npm run test:gateway-approval",
      "npm run test:datamechanics",
      "npm run test:migrate-from-existing",
    ]));
  });
});
