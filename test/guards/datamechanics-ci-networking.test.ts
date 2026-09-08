import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = { uses?: string; run?: string; name?: string; shell?: string };

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

/**
 * Moving this job into a Node job container took away the Postgres client tools the ubuntu-latest
 * runner supplied for free — and the staging data-mechanics specs spawn the REAL binaries (each spec
 * stubs only the one whose stall it pins, so the rollback restore's two `\copy` children are real
 * `psql` processes). A missing binary arrives inside a spec as a subprocess ENOENT, which reads like
 * a product failure, so the job provisions the tools itself and checks them before the specs run.
 *
 * Everything below is derived from the job's OWN service and container images rather than restated,
 * so bumping either without bumping the client is what fails here: Debian bookworm ships client 15,
 * and pg_dump refuses a server newer than itself.
 */
describe("the data-mechanics job supplies the Postgres client tools its specs spawn", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["datamechanics-tests"];
  const steps = job.steps as WorkflowStep[];
  const serviceMajor = /^postgres:(\d+)\b/.exec(String(job.services.postgres.image))?.[1];
  const debianSuite = /^node:\d+-([a-z]+)$/.exec(String(job.container.image))?.[1];
  const indexOfStep = (matches: (run: string) => boolean) =>
    steps.findIndex((step) => step.run !== undefined && matches(step.run));
  const scriptOf = (matches: (run: string) => boolean) => steps[indexOfStep(matches)]?.run ?? "";
  const isInstall = (run: string) => run.includes("apt.postgresql.org");
  const isVerify = (run: string) => run.includes("missing required tool");

  it("installs the client at the service's own major from the official PostgreSQL repository", () => {
    expect(serviceMajor, "the Postgres service image is no longer a plain major tag").toBeTruthy();
    expect(debianSuite, "the job container image is no longer a named Debian release").toBeTruthy();
    const install = scriptOf(isInstall);
    expect(install, `the client must match the postgres:${serviceMajor} service`).toContain(`postgresql-client-${serviceMajor}`);
    expect(install, "the PGDG suite must track the container's Debian release").toContain(`${debianSuite}-pgdg`);
    expect(install, "an unsigned apt source would install an unverified client").toMatch(
      /signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc/,
    );
  });

  it("refuses to reach the specs when a spawned tool is absent or older than the server", () => {
    const verify = scriptOf(isVerify);
    expect(verify, "a check that cannot fail is not a check").toContain("set -euo pipefail");
    const tools = /for tool in ([^;]+); do/.exec(verify)?.[1].trim().split(/\s+/) ?? [];
    // psql/pg_dump/pg_restore are spawned by the staging specs; git is how the
    // migrate-from-existing lane reads released schema states out of history.
    expect(tools).toEqual(expect.arrayContaining(["git", "psql", "pg_dump", "pg_restore"]));
    expect(verify, "the client may never trail the server major").toMatch(new RegExp(`-lt ${serviceMajor}\\b`));
  });

  it("provisions and checks the toolchain before any step that uses it", () => {
    const install = indexOfStep(isInstall);
    const verify = indexOfStep(isVerify);
    const firstDatabaseStep = indexOfStep((run) => run.includes("npm run pg:schema") || run.startsWith("npm run test:"));
    expect(install, "no step installs the Postgres client tools").toBeGreaterThanOrEqual(0);
    expect(verify, "the toolchain check must follow the install").toBeGreaterThan(install);
    expect(firstDatabaseStep, "a database step runs before the toolchain is checked").toBeGreaterThan(verify);
  });

  it("keeps both toolchain steps fail-closed", () => {
    // The shell rule below only matters because these scripts abort on the first failure and on a
    // broken pipe; if the strict-mode lines were dropped the shell question would be moot AND the
    // install could half-succeed into a green job.
    expect(scriptOf(isInstall), "an install that ignores a failed apt-get would leave no client behind")
      .toContain("set -euo pipefail");
    expect(scriptOf(isVerify), "a check that cannot fail is not a check").toContain("set -euo pipefail");
  });
});

/**
 * A job CONTAINER changes which interpreter an implicit `run` step gets: the script runs INSIDE the
 * image, where Debian's /bin/sh is dash, and dash has no `pipefail`. `set -euo pipefail` therefore
 * aborts at the `set` itself, before the step's first real command — which is how the two toolchain
 * steps above can be perfectly correct and still install nothing.
 *
 * Scoped to exactly that: which shell a `set … pipefail` step RESOLVES to, under GitHub's own
 * precedence (step `shell:` → job `defaults.run.shell` → workflow `defaults.run.shell` → the image's
 * implicit `sh`). Deliberately not a partial bash parser for constructs no step here uses; a
 * detector for syntax nobody wrote is untested surface that can only be wrong.
 */
describe("pipefail steps in the containerized data-mechanics job resolve to bash", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["datamechanics-tests"];
  const steps = (job.steps as WorkflowStep[]).filter((step) => step.run !== undefined);

  /** `set -o pipefail`, in the combined (`-euo`) and separate (`-o pipefail`) spellings. */
  const usesPipefail = (script: string) => /^\s*set\s+(-[a-zA-Z]*o\b[^\n]*pipefail|-o\s+pipefail)/m.test(script);
  const resolveShell = (step: WorkflowStep): string | undefined =>
    step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  const isBash = (shell: string | undefined) => shell !== undefined && /^bash(\s|$)/.test(shell);
  const labelOf = (step: WorkflowStep) => step.name ?? (step.run ?? "").split("\n")[0];

  it("detects pipefail and nothing else", () => {
    // Negative control: a detector matching nothing would report an empty offender list below for
    // any workflow at all, including the broken one this guard exists to catch.
    expect(usesPipefail("set -euo pipefail\napt-get update")).toBe(true);
    expect(usesPipefail("set -o pipefail")).toBe(true);
    expect(usesPipefail("set -eu\napt-get update")).toBe(false);
    expect(usesPipefail('DATABASE_URL="$DATABASE_TEST_URL" npm run pg:schema')).toBe(false);
  });

  it("still contains the pipefail steps this rule is about", () => {
    // Non-vacuity: rewritten into plain POSIX or deleted, the ∀ below becomes true of an empty set
    // and stops proving anything — fail here instead.
    const dependent = steps.filter((step) => usesPipefail(step.run ?? ""));
    expect(dependent.map(labelOf)).toEqual(
      expect.arrayContaining(["Install the PostgreSQL 16 client tools", "Verify the job toolchain"]),
    );
  });

  it("resolves bash for every one of them, never the container's implicit sh", () => {
    const offenders = steps
      .filter((step) => usesPipefail(step.run ?? "") && !isBash(resolveShell(step)))
      .map((step) => `${labelOf(step)} uses pipefail under shell ${resolveShell(step) ?? "«image sh (dash)»"}`);
    expect(offenders, "a job-container step needs an explicit bash shell to use pipefail").toEqual([]);
  });

  it("declares the shell at a scope that covers steps added later", () => {
    // The job runs in a container — the whole reason the implicit shell is dash — so the default
    // belongs on the job. A per-step `shell:` leaves the next step to rediscover exit 2 in CI.
    expect(job.container?.image, "this rule is about a job-container job").toBeTruthy();
    expect(job.defaults?.run?.shell ?? workflow.defaults?.run?.shell).toMatch(/^bash(\s|$)/);
  });
});
