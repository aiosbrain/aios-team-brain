import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  validateNeo4jTierWiring,
  validateTierret1Neo4jWiring,
  expectedScriptEnv,
  parseScript,
  parseHealthOptions,
  JOB_ID,
  TIERRET1_JOB_ID,
  TIERRET1_RUN_STEP,
} from "@/scripts/neo4j-tier-wiring.mjs";
import { neo4jTestTarget, queryServerEnv } from "../http/fake-providers";

/**
 * NEO4JCI-1 — the Neo4j tier's WIRING, pinned. The tier (test/graph-neo4j-tier.test.ts) is the only
 * behavioural proof of graph tier isolation; it ran in no CI job and rotted unseen for ~4 weeks.
 * "It's in CI" is therefore a claim this guard must keep true: a dedicated job that runs the npm
 * script, a service that mirrors the local compose file, and the fail-on-skip sentinel.
 */

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const ci = () => parseYaml(read(".github/workflows/ci.yml")) as Record<string, unknown>;
const compose = () => parseYaml(read("compose.test.neo4j.yml")) as Record<string, unknown>;
const pkg = () => JSON.parse(read("package.json")) as Record<string, unknown>;

type Mut = (o: { ci: Record<string, never>; compose: Record<string, never>; pkg: Record<string, never> }) => void;
/** Deep-clone the real parsed inputs, apply one mutation, return the violations. */
function violationsAfter(mut: Mut): string[] {
  const o = { ci: structuredClone(ci()), compose: structuredClone(compose()), pkg: structuredClone(pkg()) } as never;
  mut(o);
  const { ci: c, compose: k, pkg: p } = o as { ci: unknown; compose: unknown; pkg: unknown };
  return validateNeo4jTierWiring(c, k, p);
}
const job = (o: { ci: Record<string, never> }) => (o.ci as { jobs: Record<string, Record<string, never>> }).jobs[JOB_ID] as Record<string, never> & Record<string, unknown>;

describe("Neo4j tier wiring — the real files validate", () => {
  it("ci.yml + compose.test.neo4j.yml + package.json agree: zero violations", () => {
    expect(validateNeo4jTierWiring(ci(), compose(), pkg())).toEqual([]);
  });
});

describe("Neo4j tier wiring — one mutation arm per invariant (non-vacuity)", () => {
  const arms: [string, string, Mut][] = [
    ["job deleted", "job-missing", (o) => { delete (o.ci as { jobs: Record<string, unknown> }).jobs[JOB_ID]; }],
    ["check name changed", "check-name", (o) => { (job(o) as { name: string }).name = "Neo4j"; }],
    ["run step removed", "run-step-missing", (o) => { (job(o) as { steps: { run?: string }[] }).steps = (job(o) as { steps: { run?: string }[] }).steps.filter((s) => s.run !== "npm run test:neo4j"); }],
    ["sentinel removed", "sentinel-missing", (o) => { delete (job(o) as { env: Record<string, unknown> }).env.NEO4J_TIER_REQUIRED; }],
    ["service removed", "service-missing", (o) => { delete (job(o) as { services: Record<string, unknown> }).services.neo4j; }],
    ["image drift", "image-drift", (o) => { (job(o) as { services: { neo4j: { image: string } } }).services.neo4j.image = "neo4j:5.20.0"; }],
    ["NEO4J_AUTH drift", "auth-drift", (o) => { (job(o) as { services: { neo4j: { env: Record<string, string> } } }).services.neo4j.env.NEO4J_AUTH = "neo4j/other"; }],
    ["port drift", "port-drift", (o) => { (job(o) as { services: { neo4j: { ports: string[] } } }).services.neo4j.ports = ["7687:7687"]; }],
    ["health cmd drift (unauthenticated probe)", "health-cmd-drift", (o) => { const s = (job(o) as { services: { neo4j: { options: string } } }).services.neo4j; s.options = s.options.replace(/--health-cmd "[^"]*"/, '--health-cmd "true"'); }],
    ["health retries drift", "health-retries-drift", (o) => { const s = (job(o) as { services: { neo4j: { options: string } } }).services.neo4j; s.options = s.options.replace(/--health-retries \S+/, "--health-retries 2"); }],
    ["health options removed entirely", "health-cmd-drift", (o) => { delete (job(o) as { services: { neo4j: { options?: string } } }).services.neo4j.options; }],
    ["script URL duplicated, second one elsewhere (the destructive-cleanup hazard)", "script-env-duplicate", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("NEO4J_USER=", "NEO4J_URL=bolt://prod.internal:7687 NEO4J_USER="); }],
    ["script NEO4J_TEST dropped", "script-neo4j_test", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("NEO4J_TEST=1 ", ""); }],
    ["script password drift", "script-neo4j_password", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace(/NEO4J_PASSWORD=\S+/, "NEO4J_PASSWORD=x"); }],
    ["script filter changed", "script-cmd", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("graph-neo4j-tier", "graph"); }],
    // Fable diff review M1 — a job that cannot fail is not a gate.
    ["job made conditional (if: false)", "job-conditional", (o) => { (job(o) as { if?: unknown }).if = false; }],
    ["job continue-on-error", "job-continue-on-error", (o) => { (job(o) as Record<string, unknown>)["continue-on-error"] = true; }],
    ["run step made conditional", "run-step-conditional", (o) => { const st = (job(o) as { steps: Record<string, unknown>[] }).steps.find((x) => x.run === "npm run test:neo4j")!; st.if = "false"; }],
    ["run step continue-on-error", "run-step-continue-on-error", (o) => { const st = (job(o) as { steps: Record<string, unknown>[] }).steps.find((x) => x.run === "npm run test:neo4j")!; st["continue-on-error"] = true; }],
    ["run step env blanks the sentinel", "run-step-sentinel-override", (o) => { const st = (job(o) as { steps: Record<string, unknown>[] }).steps.find((x) => x.run === "npm run test:neo4j")!; st.env = { NEO4J_TIER_REQUIRED: "" }; }],
    // Codex diff review M1/M2/L1 — the remaining false-green paths.
    ["job has needs (a skipped prerequisite skips this job, which reports SUCCESS)", "job-needs", (o) => { (job(o) as { needs?: unknown }).needs = ["docs-drift"]; }],
    ["workflow-level shell override", "workflow-shell-override", (o) => { (o.ci as { defaults?: unknown }).defaults = { run: { shell: "bash -c 'bash \"$1\" || true' _ {0}" } }; }],
    ["job-level shell override", "job-shell-override", (o) => { (job(o) as { defaults?: unknown }).defaults = { run: { shell: "bash -c 'bash \"$1\" || true' _ {0}" } }; }],
    ["run step shell override", "run-step-shell-override", (o) => { const st = (job(o) as { steps: Record<string, unknown>[] }).steps.find((x) => x.run === "npm run test:neo4j")!; st.shell = "bash -c 'bash \"$1\" || true' _ {0}"; }],
    ["health cmd commented out behind `true #`", "health-cmd-drift", (o) => { const s = (job(o) as { services: { neo4j: { options: string } } }).services.neo4j; s.options = s.options.replace('--health-cmd "', '--health-cmd "true # '); }],
    // Fable diff review M2 — the six branches that had no arm.
    ["compose service missing", "compose-service-missing", (o) => { delete (o.compose as { services: Record<string, unknown> }).services.neo4j; }],
    ["npm script missing", "script-missing", (o) => { delete (o.pkg as { scripts: Record<string, string> }).scripts["test:neo4j"]; }],
    ["health interval drift", "health-interval-drift", (o) => { const s = (job(o) as { services: { neo4j: { options: string } } }).services.neo4j; s.options = s.options.replace(/--health-interval \S+/, "--health-interval 30s"); }],
    ["health timeout drift", "health-timeout-drift", (o) => { const s = (job(o) as { services: { neo4j: { options: string } } }).services.neo4j; s.options = s.options.replace(/--health-timeout \S+/, "--health-timeout 1s"); }],
    ["script URL points elsewhere (single value)", "script-neo4j_url", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("bolt://localhost:7688", "bolt://neo4j.railway.internal:7687"); }],
    ["script user drift", "script-neo4j_user", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("NEO4J_USER=neo4j", "NEO4J_USER=admin"); }],
  ];
  /** Compound mutations legitimately trip more than one invariant (no health options = cmd + all
   *  three timings; a second URL also breaks the exact-URL check). They assert containment. */
  const compound: Record<string, string[]> = {
    // No compose service = nothing to derive the script's expected URL/user/password from either.
    "compose service missing": ["compose-service-missing", "script-neo4j_url", "script-neo4j_user", "script-neo4j_password"],
    "health options removed entirely": ["health-cmd-drift", "health-interval-drift", "health-timeout-drift", "health-retries-drift"],
    "script URL duplicated, second one elsewhere (the destructive-cleanup hazard)": ["script-env-duplicate", "script-neo4j_url"],
  };
  for (const [label, code, mut] of arms) {
    const want = compound[label] ?? [code];
    it(`${label} → exactly [${want.join(", ")}]`, () => {
      expect(violationsAfter(mut)).toEqual(want);
    });
  }
});

/**
 * AIO-1167 — the TIERRET-1 query harness reads the graph through the production Neo4j path, so the HTTP
 * job that runs it must carry the SAME isolated test Neo4j (compose's image, test auth, loopback bolt
 * port and authenticated health probe), and the spawned server must receive only that loopback test
 * service's compose-derived credentials — never an inherited NEO4J_*.
 */
describe("TIERRET-1 query harness — isolated test Neo4j wiring", () => {
  type Job = Record<string, unknown> & {
    services: { neo4j: { image: string; env: Record<string, string>; ports: string[]; options?: string } };
    steps: Record<string, unknown>[];
    env?: Record<string, string>;
  };
  const httpJob = (o: { ci: Record<string, never> }) => (o.ci as { jobs: Record<string, Job> }).jobs[TIERRET1_JOB_ID];
  function tierretAfter(mut: (o: { ci: Record<string, never>; compose: Record<string, never> }) => void): string[] {
    const o = { ci: structuredClone(ci()), compose: structuredClone(compose()) } as never;
    mut(o);
    const { ci: c, compose: k } = o as { ci: unknown; compose: unknown };
    return validateTierret1Neo4jWiring(c, k);
  }

  it("the real ci.yml + compose.test.neo4j.yml agree: zero violations", () => {
    expect(validateTierret1Neo4jWiring(ci(), compose())).toEqual([]);
  });

  const arms: [string, string[], (o: { ci: Record<string, never>; compose: Record<string, never> }) => void][] = [
    ["job deleted", ["tierret1-job-missing"], (o) => { delete (o.ci as { jobs: Record<string, unknown> }).jobs[TIERRET1_JOB_ID]; }],
    ["tierret1 step removed", ["tierret1-run-step-missing"], (o) => { const j = httpJob(o); j.steps = j.steps.filter((s) => s.run !== TIERRET1_RUN_STEP); }],
    ["neo4j service removed", ["tierret1-service-missing"], (o) => { delete (httpJob(o).services as Record<string, unknown>).neo4j; }],
    ["image drift", ["tierret1-image-drift"], (o) => { httpJob(o).services.neo4j.image = "neo4j:5.20.0"; }],
    ["auth drift", ["tierret1-auth-drift"], (o) => { httpJob(o).services.neo4j.env.NEO4J_AUTH = "neo4j/other"; }],
    ["bolt port drift (non-isolated 7687)", ["tierret1-port-drift"], (o) => { httpJob(o).services.neo4j.ports = ["7687:7687"]; }],
    ["health probe made vacuous", ["tierret1-health-cmd-drift"], (o) => { const s = httpJob(o).services.neo4j; s.options = s.options!.replace(/--health-cmd "[^"]*"/, '--health-cmd "true"'); }],
    ["health retries drift", ["tierret1-health-retries-drift"], (o) => { const s = httpJob(o).services.neo4j; s.options = s.options!.replace(/--health-retries \S+/, "--health-retries 2"); }],
    ["job-level NEO4J_URL handed to every step", ["tierret1-neo4j-env-leak"], (o) => { const j = httpJob(o); j.env = { ...(j.env ?? {}), NEO4J_URL: "bolt://neo4j.railway.internal:7687" }; }],
    ["step-level NEO4J_PASSWORD", ["tierret1-neo4j-env-leak"], (o) => { const st = httpJob(o).steps.find((s) => s.run === TIERRET1_RUN_STEP)!; st.env = { NEO4J_PASSWORD: "x" }; }],
    ["compose service missing", ["tierret1-compose-service-missing"], (o) => { delete (o.compose as { services: Record<string, unknown> }).services.neo4j; }],
  ];
  for (const [label, want, mut] of arms) {
    it(`${label} → exactly [${want.join(", ")}]`, () => {
      expect(tierretAfter(mut)).toEqual(want);
    });
  }

  it("the spawned server gets ONLY the compose-derived loopback test Neo4j, whatever the parent env holds", () => {
    const env = queryServerEnv(
      { PATH: "/usr/bin", NEO4J_URL: "bolt://neo4j.railway.internal:7687", NEO4J_USER: "prod", NEO4J_PASSWORD: "prod-secret" },
      { llmUrl: "http://127.0.0.1:1", graphitiUrl: "http://127.0.0.1:2" },
      "3999",
    );
    const want = expectedScriptEnv(compose()) as { NEO4J_URL: string; NEO4J_USER: string; NEO4J_PASSWORD: string };
    expect(new URL(env.NEO4J_URL!).hostname).toBe("127.0.0.1");
    expect(new URL(env.NEO4J_URL!).port).toBe(new URL(want.NEO4J_URL).port);
    expect(env.NEO4J_USER).toBe(want.NEO4J_USER);
    expect(env.NEO4J_PASSWORD).toBe(want.NEO4J_PASSWORD);
    // The seeding worker is handed the same target, so the suite reads and writes one service.
    expect(neo4jTestTarget()).toEqual({ url: env.NEO4J_URL, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD });
  });

  it("still refuses a non-loopback endpoint for the server", () => {
    expect(() => queryServerEnv({}, { llmUrl: "http://203.0.113.9:1", graphitiUrl: "http://127.0.0.1:2" }, "3999")).toThrow(/loopback/);
  });
});

describe("parsers", () => {
  it("parseScript keeps leading KEY=value words, reports duplicates, returns the command", () => {
    expect(parseScript("A=1 B=two vitest run x")).toEqual({ env: { A: "1", B: "two" }, dupes: [], cmd: "vitest run x" });
    expect(parseScript("A=1 A=2 cmd").dupes).toEqual(["A"]);
  });
  it("parseHealthOptions reads the four docker health flags", () => {
    expect(parseHealthOptions(`--health-cmd "x 'y'" --health-interval 3s --health-timeout 5s --health-retries 40`)).toEqual({ cmd: "x 'y'", interval: "3s", timeout: "5s", retries: "40" });
  });
});

describe("the fail-on-skip sentinel (D1b) — behavioural, via a spawned vitest", () => {
  const vitest = join(root, "node_modules", ".bin", "vitest");
  const tier = "test/graph-neo4j-tier.test.ts";
  /** A CONSTRUCTED env: the developer's shell must not leak NEO4J_TEST into either arm. */
  const env = (extra: Record<string, string>) => {
    const e: Record<string, string> = {};
    for (const [k, val] of Object.entries(process.env)) if (val !== undefined && k !== "NEO4J_TEST" && k !== "NEO4J_TIER_REQUIRED") e[k] = val;
    return { ...e, ...extra };
  };
  it("NEO4J_TIER_REQUIRED=1 without NEO4J_TEST → non-zero exit with the collection error (never a silent skip)", () => {
    const r = spawnSync(vitest, ["run", tier], { cwd: root, env: env({ NEO4J_TIER_REQUIRED: "1" }), encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/NEO4J_TIER_REQUIRED=1 but NEO4J_TEST is not '1'/);
  });
  it("neither set → exit 0 with every test skipped (a developer without Neo4j is not reddened)", () => {
    const r = spawnSync(vitest, ["run", tier], { cwd: root, env: env({}), encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/skipped/);
  });
});
