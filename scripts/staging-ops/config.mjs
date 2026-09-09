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

/** The service roles each side must pin. Order is the reporting order. */
const SERVICE_ROLES = Object.freeze(["appServiceId", "graphitiServiceId", "postgresServiceId", "neo4jServiceId"]);

/**
 * The identity of a DEPLOYED SERVICE INSTANCE: `(projectId, environmentId, serviceId)`.
 *
 * A Railway service ID is a GLOBAL definition; the same service is deployed into every environment
 * of its project, and the two deployments share that ID while differing in `environmentId`. The
 * previous rule ("staging and production `appServiceId` must be distinct", per role) therefore
 * refused the measured production topology outright — four errors on a correct configuration — and
 * would have forced duplicate service definitions to satisfy a check about the wrong noun. AC-01
 * asks for distinct pinned environment/service/database IDENTITIES, and the instance tuple is what
 * that means. JSON-encoded rather than delimiter-joined, so no ID containing the separator can
 * forge a match.
 */
function instanceTuple(facts, role) {
  const parts = [text(facts?.projectId), text(facts?.environmentId), text(facts?.[role])];
  return parts.every(Boolean) ? JSON.stringify(parts) : null;
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

  // The environment is what separates the two deployments, so THIS is the identity that must differ.
  // Project and global service IDs are permitted to match: one project with a staging and a
  // production environment is the measured topology, and the ordinary Railway shape.
  if (text(staging.environmentId) && text(staging.environmentId) === text(production.environmentId)) {
    errors.push("staging and production environmentId must be distinct");
  }

  for (const [side, facts] of [["staging", staging], ["production", production]]) {
    // Role aliasing WITHIN an environment is the distinctness that still matters, and it is not
    // implied by the environment check above: two incompatible roles resolving to one instance
    // (Postgres and Neo4j pinned to the same service, say) means one of them is not what the
    // preflight thinks it is, and every downstream ownership check inherits the confusion.
    const byInstance = new Map();
    for (const role of SERVICE_ROLES) {
      const tuple = instanceTuple(facts, role);
      if (!tuple) continue;
      const previous = byInstance.get(tuple);
      if (previous) errors.push(`${side} ${previous} and ${role} resolve to the same service instance`);
      else byInstance.set(tuple, role);
    }
    for (const key of ["postgresHost", "neo4jHost"]) {
      // Deliberately NOT compared across sides. Railway's private DNS is environment-scoped, so
      // `postgres.railway.internal` names a DIFFERENT database in each environment; requiring the
      // two names to differ would refuse a correctly isolated topology. Equally, the names matching
      // is not evidence that the databases are separate — that is the environment-bound read-back's
      // job, not a string comparison's.
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
