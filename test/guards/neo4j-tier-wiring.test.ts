import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  validateNeo4jTierWiring,
  parseScript,
  parseHealthOptions,
  JOB_ID,
} from "@/scripts/neo4j-tier-wiring.mjs";

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
    ["script password drift", "script-neo4j_password", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("NEO4J_PASSWORD=testtest1", "NEO4J_PASSWORD=x"); }],
    ["script filter changed", "script-cmd", (o) => { const s = (o.pkg as { scripts: Record<string, string> }).scripts; s["test:neo4j"] = s["test:neo4j"].replace("graph-neo4j-tier", "graph"); }],
  ];
  /** Compound mutations legitimately trip more than one invariant (no health options = cmd + all
   *  three timings; a second URL also breaks the exact-URL check). They assert containment. */
  const compound = new Set(["health options removed entirely", "script URL duplicated, second one elsewhere (the destructive-cleanup hazard)"]);
  for (const [label, code, mut] of arms) {
    it(`${label} → ${compound.has(label) ? "includes" : "exactly"} [${code}]`, () => {
      const v = violationsAfter(mut);
      if (compound.has(label)) expect(v).toContain(code);
      else expect(v).toEqual([code]);
    });
  }
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
