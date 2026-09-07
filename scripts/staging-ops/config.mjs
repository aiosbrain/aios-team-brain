/**
 * Read-only topology decision for the staging-first workflow. The caller supplies facts obtained
 * from provider APIs; this module never fetches variables and never mutates platform state.
 */

const INTERNAL_HOST = /(?:^|\.)railway\.internal$/i;
const REQUIRED_REFERENCE = /\$\{\{[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\}\}/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactedReference(value) {
  return REQUIRED_REFERENCE.test(text(value)) ? "reference" : "non-reference value";
}

/**
 * @param {{
 * repositoryDefaultBranch?: string,
 * contributionBranch?: string,
 * staging?: Record<string, any>,
 * production?: Record<string, any>
 * }} topology
 */
export function preflightStagingTopology(topology) {
  const errors = [];
  const staging = topology?.staging ?? {};
  const production = topology?.production ?? {};

  if (text(topology?.repositoryDefaultBranch) !== "staging") errors.push("repository default branch must be staging");
  if (text(topology?.contributionBranch) !== "staging") errors.push("contribution branch must be staging");
  if (text(staging.appSourceBranch) !== "staging") errors.push("staging app source branch must be staging");
  if (text(production.appSourceBranch) !== "main") errors.push("production app source branch must be main");

  for (const key of ["projectId", "environmentId", "appServiceId", "graphitiServiceId", "postgresServiceId", "neo4jServiceId"]) {
    if (!text(staging[key])) errors.push(`staging ${key} is required`);
    if (!text(production[key])) errors.push(`production ${key} is required`);
  }

  for (const key of ["environmentId", "appServiceId", "graphitiServiceId", "postgresServiceId", "neo4jServiceId"]) {
    if (text(staging[key]) && text(staging[key]) === text(production[key])) errors.push(`staging and production ${key} must be distinct`);
  }

  for (const [side, facts] of [["staging", staging], ["production", production]]) {
    for (const key of ["postgresHost", "neo4jHost"]) {
      const host = text(facts[key]).replace(/^\[|\]$/g, "");
      if (!host || !INTERNAL_HOST.test(host)) errors.push(`${side} ${key} must be a Railway internal hostname`);
    }
    for (const key of ["DATABASE_URL", "NEO4J_URL"]) {
      const value = facts.variableReferences?.[key];
      if (!REQUIRED_REFERENCE.test(text(value))) {
        errors.push(`${side} ${key} must be a Railway variable reference (observed ${redactedReference(value)})`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertStagingTopology(topology) {
  const result = preflightStagingTopology(topology);
  if (!result.ok) throw new Error(`staging topology preflight refused:\n- ${result.errors.join("\n- ")}`);
  return result;
}
