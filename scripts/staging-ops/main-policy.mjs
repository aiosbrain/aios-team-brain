/** The nine contexts measured before this change, plus the two release-specific contexts. */
export const REQUIRED_MAIN_CONTEXTS = Object.freeze([
  "Docs drift guard",
  "Static checks (lint + typecheck)",
  "Secret scan (gitleaks)",
  "Brain unit tests (vitest)",
  "Data-mechanics tests (real Postgres)",
  "Integration tests (HTTP)",
  "Graph Neo4j tier (real Neo4j)",
  "Ingestion tests (pytest)",
  "NDA confidentiality gate",
  "Release candidate gate",
  "Staging candidate validation",
]);

const integrationBypass = (actorId) => ({ actor_type: "Integration", actor_id: actorId, bypass_mode: "always" });
const mainOnly = { ref_name: { include: ["refs/heads/main"], exclude: [] } };

/** Build API-ready repository rulesets after activation has supplied measured actor/producer IDs. */
export function buildMainRulesets({ normalAppId, emergencyAppId, producerIds }) {
  if (!Number.isInteger(normalAppId) || !Number.isInteger(emergencyAppId) || normalAppId === emergencyAppId) {
    throw new Error("distinct numeric normal and emergency GitHub App IDs are required");
  }
  const statusChecks = REQUIRED_MAIN_CONTEXTS.map((context) => {
    const integrationId = Number(producerIds?.[context]);
    if (!Number.isInteger(integrationId) || integrationId <= 0) throw new Error(`producer integration ID is required for ${context}`);
    return { context, integration_id: integrationId };
  });
  return [
    {
      name: "main-integrity",
      target: "branch",
      enforcement: "active",
      conditions: structuredClone(mainOnly),
      bypass_actors: [],
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    },
    {
      name: "main-release-evidence",
      target: "branch",
      enforcement: "active",
      conditions: structuredClone(mainOnly),
      bypass_actors: [integrationBypass(emergencyAppId)],
      rules: [{
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: statusChecks,
        },
      }],
    },
    {
      name: "main-release-writer",
      target: "branch",
      enforcement: "active",
      conditions: structuredClone(mainOnly),
      bypass_actors: [integrationBypass(normalAppId), integrationBypass(emergencyAppId)],
      rules: [{ type: "update" }, { type: "pull_request" }],
    },
  ];
}

export function evaluateMainOperation({ actor, operation, checksGreen }) {
  if (operation === "force" || operation === "delete") return false;
  if (operation === "merge") return false;
  if (operation !== "update") return false;
  if (actor === "normal") return checksGreen === true;
  if (actor === "emergency") return true;
  return false;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function targetsMain(ruleset) {
  return Array.isArray(ruleset?.conditions?.ref_name?.include) && ruleset.conditions.ref_name.include.includes("refs/heads/main");
}

export function verifyEffectiveMainPolicy({ applicableRulesets, classicProtection, expected }) {
  const errors = [];
  let desired;
  try {
    desired = buildMainRulesets(expected);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const relevant = (Array.isArray(applicableRulesets) ? applicableRulesets : []).filter(targetsMain);
  for (const wanted of desired) {
    const actual = relevant.find((r) => r.name === wanted.name);
    if (!actual) {
      errors.push(`missing active ruleset ${wanted.name}`);
      continue;
    }
    for (const key of ["target", "enforcement", "conditions", "bypass_actors", "rules"]) {
      if (!sameJson(actual[key], wanted[key])) errors.push(`${wanted.name} ${key} differs from the desired contract`);
    }
  }
  for (const ruleset of relevant) {
    if (ruleset.enforcement !== "active") errors.push(`${ruleset.name ?? "unnamed ruleset"} is not active`);
    for (const bypass of ruleset.bypass_actors ?? []) {
      if (bypass.actor_type !== "Integration") errors.push(`${ruleset.name ?? "unnamed ruleset"} has an unexpected non-App bypass`);
    }
  }
  if (classicProtection?.required_status_checks != null) errors.push("classic required status checks conflict with App ruleset bypasses");
  if (classicProtection?.required_pull_request_reviews != null) errors.push("classic required pull request rule conflicts with App ruleset bypasses");
  if (classicProtection?.allow_force_pushes?.enabled === true) errors.push("classic protection allows force pushes");
  if (classicProtection?.allow_deletions?.enabled === true) errors.push("classic protection allows deletion");
  return { ok: errors.length === 0, errors };
}
