/**
 * NEO4JCI-1 — the pure validator behind test/guards/neo4j-tier-wiring.test.ts.
 *
 * "The Neo4j tier runs in CI" is a claim that rotted once (a green `npm test` reported the tier
 * skipped for ~4 weeks). This validates the WIRING as data: the CI workflow, the compose file the
 * local tier uses, and package.json's script — parsed by the caller — must agree, and the dedicated
 * job must carry the fail-on-skip sentinel. Pure so the guard mutation-tests it over objects, one
 * arm per invariant, instead of editing files.
 *
 * Returns a list of violation codes (empty = wired). Codes are stable strings the guard asserts on
 * exactly, so a missing branch cannot hide behind a different one.
 */

export const JOB_ID = "neo4j-tier-tests";
export const CHECK_NAME = "Graph Neo4j tier (real Neo4j)";
export const RUN_STEP = "npm run test:neo4j";
export const SENTINEL = "NEO4J_TIER_REQUIRED";
export const EXPECTED_SCRIPT_ENV = {
  NEO4J_TEST: "1",
  NEO4J_URL: "bolt://localhost:7688",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "testtest1",
};
export const EXPECTED_SCRIPT_CMD = "vitest run graph-neo4j-tier";

/** Parse a `KEY=v KEY2=v2 cmd args…` shell line into leading assignments + the command. Duplicate
 *  keys are reported, not last-wins — a second `NEO4J_URL=` pointing elsewhere is exactly the
 *  destructive-cleanup hazard this exists to catch. */
export function parseScript(script) {
  const words = String(script ?? "").trim().split(/\s+/);
  const env = {};
  const dupes = [];
  let i = 0;
  for (; i < words.length; i++) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(words[i]);
    if (!m) break;
    if (m[1] in env) dupes.push(m[1]);
    env[m[1]] = m[2];
  }
  return { env, dupes, cmd: words.slice(i).join(" ") };
}

/** Docker health flags out of an Actions `options` string. */
export function parseHealthOptions(options) {
  const o = String(options ?? "");
  const cmd = /--health-cmd\s+"([^"]*)"/.exec(o)?.[1] ?? /--health-cmd\s+'([^']*)'/.exec(o)?.[1] ?? null;
  const pick = (k) => new RegExp(`--health-${k}\\s+(\\S+)`).exec(o)?.[1] ?? null;
  return { cmd, interval: pick("interval"), timeout: pick("timeout"), retries: pick("retries") };
}

/** Compose's healthcheck `test` is `["CMD-SHELL", "<cmd>"]` or a string. */
function composeProbe(hc) {
  const t = hc?.test;
  if (Array.isArray(t)) return t[0] === "CMD-SHELL" ? t.slice(1).join(" ") : t.join(" ");
  return typeof t === "string" ? t : null;
}

export function validateNeo4jTierWiring(ci, compose, pkg) {
  const v = [];
  const job = ci?.jobs?.[JOB_ID];
  if (!job) return ["job-missing"];
  if (job.name !== CHECK_NAME) v.push("check-name");
  // A job that cannot FAIL is not a gate (Fable diff review M1): `if`, `continue-on-error`, or a
  // step-level env blanking the sentinel all leave "it's in CI" true on paper and false in effect.
  if (job.if !== undefined) v.push("job-conditional");
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) v.push("job-continue-on-error");
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const runStep = steps.find((s) => typeof s?.run === "string" && s.run.trim() === RUN_STEP);
  if (!runStep) v.push("run-step-missing");
  else {
    if (runStep.if !== undefined) v.push("run-step-conditional");
    if (runStep["continue-on-error"] !== undefined && runStep["continue-on-error"] !== false) v.push("run-step-continue-on-error");
    if (runStep.env && Object.prototype.hasOwnProperty.call(runStep.env, SENTINEL)) v.push("run-step-sentinel-override");
  }
  if (String(job.env?.[SENTINEL] ?? "") !== "1") v.push("sentinel-missing");

  const svc = job.services?.neo4j;
  const ref = compose?.services?.neo4j;
  if (!ref) v.push("compose-service-missing");
  if (!svc) {
    v.push("service-missing");
  } else if (ref) {
    if (svc.image !== ref.image) v.push("image-drift");
    const refAuth = ref.environment?.NEO4J_AUTH ?? (Array.isArray(ref.environment) ? ref.environment.find((e) => String(e).startsWith("NEO4J_AUTH="))?.slice("NEO4J_AUTH=".length) : undefined);
    if (String(svc.env?.NEO4J_AUTH ?? "") !== String(refAuth ?? "")) v.push("auth-drift");
    const refBolt = (ref.ports ?? []).map(String).find((p) => p.endsWith(":7687"));
    if (!(svc.ports ?? []).map(String).includes(String(refBolt))) v.push("port-drift");
    const h = parseHealthOptions(svc.options);
    const probe = composeProbe(ref.healthcheck);
    if (!h.cmd || !probe || !h.cmd.includes(probe.replace(/\s*\|\|\s*exit 1$/, ""))) v.push("health-cmd-drift");
    for (const k of ["interval", "timeout", "retries"]) {
      if (String(h[k] ?? "") !== String(ref.healthcheck?.[k] ?? "")) v.push(`health-${k}-drift`);
    }
  }

  const script = pkg?.scripts?.["test:neo4j"];
  if (typeof script !== "string") {
    v.push("script-missing");
  } else {
    const { env, dupes, cmd } = parseScript(script);
    if (dupes.length) v.push("script-env-duplicate");
    for (const [k, want] of Object.entries(EXPECTED_SCRIPT_ENV)) {
      if (env[k] !== want) v.push(`script-${k.toLowerCase()}`);
    }
    if (cmd !== EXPECTED_SCRIPT_CMD) v.push("script-cmd");
  }
  return v;
}
