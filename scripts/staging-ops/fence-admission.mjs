import { bootAdmissionVerdict } from "./journal.mjs";

export const SUPPORTED_STAGING_DATA_MODES = Object.freeze(["legacy-pg-only", "copy-ready"]);
const SUPPORTED = new Set(SUPPORTED_STAGING_DATA_MODES);

/**
 * Decide whether this process is in the only scope where activation evidence may exist.
 *
 * Pinned IDs are a scope boundary, not activation by themselves: the baseline is deployed with
 * those pins before the first rollback checkpoint exists. `copy-ready` and the explicit activation
 * claim may only make admission stricter; neither can manufacture a successful journal identity.
 */
export function stagingFenceScope(env = process.env) {
  const declaredMode = String(env.STAGING_DATA_MODE ?? "").trim();
  // Railway injects RAILWAY_ENVIRONMENT_ID in production too. Only the staging-ops pin enrolls a
  // deployment in this scope; treating the platform ID alone as staging would break every normal
  // production deploy.
  const hasPinnedScope = Boolean(env.STAGING_OPS_ENVIRONMENT_ID);
  const strictClaim = env.STAGING_COPY_MODE_ACTIVATED === "true";
  const explicitCopyMode = declaredMode === "copy-ready";

  if (!hasPinnedScope && !strictClaim && !explicitCopyMode) {
    return { inspect: false, declaredMode, reason: "production-or-unenrolled-legacy" };
  }
  if (!env.STAGING_OPS_ENVIRONMENT_ID || env.STAGING_OPS_ENVIRONMENT_ID !== env.RAILWAY_ENVIRONMENT_ID) {
    throw new Error("staging fence environment identity mismatch");
  }
  return { inspect: true, declaredMode, strictClaim, explicitCopyMode };
}

/**
 * Read the durable enrollment fact without confusing installer-created empty control state with a
 * completed activation. The invariant is: a pinned staging becomes activation-aware when the
 * journal records a real run/boot/candidate/last-ready identity. A missing table or the installer's
 * initial `failed` row with no identity remains genuine preactivation compatibility.
 */
export async function readDurableFenceEnrollment(client) {
  let table;
  try {
    table = await client.query("SELECT to_regclass('staging_ops.refresh_journal')::text AS journal_table");
  } catch (error) {
    throw new Error(`staging activation evidence is unreadable: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  if (!table.rows[0]?.journal_table) return { activated: false, journal: null, reason: "control-schema-absent" };

  let result;
  try {
    result = await client.query("SELECT * FROM staging_ops.refresh_journal WHERE singleton=true");
  } catch (error) {
    throw new Error(`staging activation evidence is unreadable: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  if (result.rows.length !== 1) throw new Error("staging activation evidence is unreadable: refresh journal singleton is missing");
  const journal = result.rows[0];
  const activated = Boolean(
    journal.run_id || journal.last_ready_run_id || journal.last_ready_object_id ||
    journal.candidate_run_id || journal.candidate_object_id || journal.boot_run_id || journal.boot_commit,
  );
  return { activated, journal, reason: activated ? "durable-journal-identity" : "empty-installer-journal" };
}

/** Apply the same activation/mode/journal admission at startup and schema-load time. */
export async function classifyFenceAdmission(client, env = process.env, context = "staging process", { requireBootAdmission = true } = {}) {
  const scope = stagingFenceScope(env);
  if (!scope.inspect) return { fenced: false, activated: false, journal: null, mode: scope.declaredMode, reason: scope.reason };

  const durable = await readDurableFenceEnrollment(client);
  const activated = durable.activated || scope.strictClaim || scope.explicitCopyMode;
  if (!activated) {
    if (scope.declaredMode && scope.declaredMode !== "legacy-pg-only") {
      throw new Error(`${context} refused: unsupported preactivation staging data mode ${scope.declaredMode}`);
    }
    return { fenced: true, activated: false, journal: durable.journal, mode: scope.declaredMode || "legacy-pg-only", reason: durable.reason };
  }
  if (!SUPPORTED.has(scope.declaredMode)) {
    throw new Error(`${context} refused: activated staging requires STAGING_DATA_MODE=legacy-pg-only or copy-ready`);
  }
  if (!durable.journal) {
    throw new Error(`${context} refused: activated staging has no readable refresh journal`);
  }
  if (!requireBootAdmission) {
    return { fenced: true, activated: true, journal: durable.journal, mode: scope.declaredMode, reason: "exclusive-import-session" };
  }
  const verdict = bootAdmissionVerdict(durable.journal, env);
  if (!verdict.ok) throw new Error(`${context} refused: ${verdict.reason}`);
  return { fenced: true, activated: true, journal: durable.journal, mode: scope.declaredMode, reason: verdict.reason };
}
