const FULL_SHA = /^[0-9a-f]{40}$/i;

export const JOURNAL_STATES = Object.freeze(["capturing", "published", "draining", "importing", "verifying", "booting", "ready", "failed"]);
export const COORDINATOR_LOCK = Object.freeze([0x41494f53, 0x53544731]);
export const DATA_USE_LOCK = Object.freeze([0x41494f53, 0x53544732]);

export const INSTALL_STAGING_OPS_SQL = `
CREATE SCHEMA IF NOT EXISTS staging_ops;
CREATE TABLE IF NOT EXISTS staging_ops.refresh_journal (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id text,
  state text NOT NULL CHECK (state IN ('capturing','published','draining','importing','verifying','booting','ready','failed')),
  last_safe_checkpoint text,
  last_ready_run_id text,
  last_ready_object_id text,
  last_ready_digest text,
  last_ready_commit text,
  last_ready_mode text,
  rollback_target_run_id text,
  rollback_target_object_id text,
  rollback_target_digest text,
  rollback_target_commit text,
  rollback_target_mode text,
  candidate_run_id text,
  candidate_object_id text,
  candidate_digest text,
  candidate_mode text,
  boot_run_id text,
  boot_commit text,
  catchup_commit text,
  catchup_attempts integer not null default 0,
  catchup_error text,
  source_watermark timestamptz,
  source_watermark_run_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO staging_ops.refresh_journal(singleton, state) VALUES (true, 'failed')
ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS last_ready_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS last_ready_digest text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_digest text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_mode text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS boot_run_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS boot_commit text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS catchup_attempts integer not null default 0;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS catchup_error text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS source_watermark timestamptz;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS source_watermark_run_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS rollback_target_run_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS rollback_target_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS rollback_target_digest text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS rollback_target_commit text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS rollback_target_mode text;

-- H2: the FIRST bootstrap's own durable recovery record. Everything the first bootstrap knew about
-- how to put staging back lived in one local variable (current) in the worker's memory. After
-- stopAndVerifyAll() returns, the platform reports no active deployment by construction, so a
-- replacement worker's currentDeployment() cannot re-measure it, there is no last_ready and no
-- preserved prior pair to roll back to, and the ordinary catch cannot run because SIGKILL does not
-- run catches. Both stores stay intact and correct — and staging stays stopped and fenced, with no
-- supplied command able to restore it. This row is what a fresh worker reconciles against.
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_run_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_phase text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_deployment_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_commit text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_mode text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_environment_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_app_service_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS bootstrap_digest text;

-- Fable HIGH-1: a durable admission record for DESTRUCTIVE source-install attempts, keyed on the
-- immutable object identity. Without it, a candidate that deterministically fails after entering
-- draining is rediscovered by the very next automatic tick — because rollback restores the prior,
-- clears recovery-required, and never advances the success watermark past the failed candidate —
-- and staging is drained, stopped and restored again, indefinitely, for a candidate already known
-- to fail. It lives in staging_ops, which the paired install does not restore, so it survives the
-- rollback and the ready transition that erase every other trace of the attempt.
CREATE TABLE IF NOT EXISTS staging_ops.source_install_attempts (
  object_id text PRIMARY KEY,
  run_id text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('attempted','failed','installed')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
`;

/** The bootstrap phases a fresh worker can resume from, in order of progress. */
export const BOOTSTRAP_PHASES = Object.freeze(["stopping", "captured"]);

export async function installStagingOps(client) {
  await client.query(INSTALL_STAGING_OPS_SQL);
}

async function lock(client, [a, b], mode, wait) {
  const fn = `pg_${wait ? "advisory" : "try_advisory"}_${mode === "shared" ? "lock_shared" : "lock"}`;
  const result = await client.query(`SELECT ${fn}($1, $2) AS acquired`, [a, b]);
  return wait || result.rows[0]?.acquired === true;
}

export const acquireCoordinatorLock = (client, wait = false) => lock(client, COORDINATOR_LOCK, "exclusive", wait);
export const acquireDataUseLock = (client, mode, wait = false) => lock(client, DATA_USE_LOCK, mode, wait);

export async function releaseCoordinatorLock(client) {
  await client.query("SELECT pg_advisory_unlock($1, $2)", COORDINATOR_LOCK);
}

export async function releaseDataUseLock(client, mode) {
  await client.query(`SELECT pg_advisory_unlock${mode === "shared" ? "_shared" : ""}($1, $2)`, DATA_USE_LOCK);
}

export async function hasExclusiveDataUseLock(client) {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND classid=$1::integer::oid AND objid=$2::integer::oid AND mode='ExclusiveLock' AND granted
  ) AS held`, DATA_USE_LOCK);
  return result.rows[0]?.held === true;
}

async function hasLock(client, [a, b], mode) {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND classid=$1::integer::oid AND objid=$2::integer::oid AND mode=$3 AND granted
  ) AS held`, [a, b, mode]);
  return result.rows[0]?.held === true;
}

export const hasCoordinatorLock = (client) => hasLock(client, COORDINATOR_LOCK, "ExclusiveLock");

export async function readJournal(client) {
  const result = await client.query("SELECT * FROM staging_ops.refresh_journal WHERE singleton=true");
  if (result.rows.length !== 1) throw new Error("staging refresh journal is missing");
  return result.rows[0];
}

export async function transitionJournal(client, { runId, from, to, patch = {} }) {
  if (!JOURNAL_STATES.includes(to)) throw new Error(`invalid journal state ${to}`);
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET run_id=$1, state=$2,
       last_safe_checkpoint=COALESCE($3,last_safe_checkpoint), candidate_run_id=COALESCE($4,candidate_run_id),
       candidate_object_id=COALESCE($5,candidate_object_id), candidate_digest=COALESCE($6,candidate_digest),
       candidate_mode=COALESCE($7,candidate_mode), catchup_commit=COALESCE($8,catchup_commit),
       boot_run_id=COALESCE($9,boot_run_id), boot_commit=COALESCE($10,boot_commit),
       rollback_target_run_id=CASE WHEN $11 THEN last_ready_run_id ELSE rollback_target_run_id END,
       rollback_target_object_id=CASE WHEN $11 THEN last_ready_object_id ELSE rollback_target_object_id END,
       rollback_target_digest=CASE WHEN $11 THEN last_ready_digest ELSE rollback_target_digest END,
       rollback_target_commit=CASE WHEN $11 THEN last_ready_commit ELSE rollback_target_commit END,
       rollback_target_mode=CASE WHEN $11 THEN last_ready_mode ELSE rollback_target_mode END,
       updated_at=now()
     WHERE singleton=true AND state = ANY($12::text[]) RETURNING *`,
    [runId, to, patch.lastSafeCheckpoint ?? null, patch.candidateRunId ?? null, patch.candidateObjectId ?? null, patch.candidateDigest ?? null, patch.candidateMode ?? null, patch.catchupCommit ?? null, patch.bootRunId ?? null, patch.bootCommit ?? null, patch.snapshotRollbackTarget === true, from]
  );
  if (result.rows.length !== 1) throw new Error(`journal transition to ${to} refused from current state`);
  return result.rows[0];
}

/** Clear the prior target only after every fallible ready-boundary reconciliation step succeeds. */
export async function clearRollbackTarget(client, runId) {
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET
       rollback_target_run_id=NULL, rollback_target_object_id=NULL, rollback_target_digest=NULL,
       rollback_target_commit=NULL, rollback_target_mode=NULL, updated_at=now()
     WHERE singleton=true AND state='ready' AND run_id=$1 RETURNING *`,
    [runId],
  );
  if (result.rows.length !== 1) throw new Error("rollback target cleanup refused outside the canonical ready run");
  return result.rows[0];
}

/**
 * B1: the ONE admission decision, shared by the schema loader (Railway's preDeployCommand) and the
 * startup fence.
 *
 * The loader used to admit only `ready`. But the importer deliberately deploys the app while the
 * journal is `booting` — that IS the fresh process the refresh is waiting for — so a ready-only gate
 * failed the predeploy of the very deployment it had just selected, failing the import and driving a
 * rollback. Admission is therefore `ready`, OR exactly the run/SHA this refresh selected for boot.
 *
 * "Exactly" is the whole point: a booting journal admits ONLY a process whose commit equals the
 * recorded boot commit and whose boot run matches the journal's current run. Missing or mismatched
 * identity is refused, as is every other state.
 *
 * @param {Record<string, unknown>} journal
 * @param {NodeJS.ProcessEnv} env
 */
export function bootAdmissionVerdict(journal, env = process.env) {
  const state = String(journal?.state ?? "");
  if (state === "ready") {
    return journal?.run_id
      ? { ok: true, reason: "ready" }
      : { ok: false, reason: "journal is ready with no run identity" };
  }
  if (state !== "booting") return { ok: false, reason: `refresh state is ${state || "unknown"}` };

  const bootCommit = String(journal?.boot_commit ?? "");
  const bootRunId = String(journal?.boot_run_id ?? "");
  const actual = String(env.RAILWAY_GIT_COMMIT_SHA ?? "");
  if (!FULL_SHA.test(bootCommit) || !bootRunId) return { ok: false, reason: "booting journal records no exact selected boot identity" };
  if (bootRunId !== String(journal?.run_id ?? "")) return { ok: false, reason: "booting journal boot run does not match its current run" };
  if (!FULL_SHA.test(actual)) return { ok: false, reason: "starting process reports no exact commit identity" };
  if (actual !== bootCommit) return { ok: false, reason: "starting process is not the selected booting deployment" };
  return { ok: true, reason: "selected booting deployment" };
}

/** Reads the journal and applies the shared admission verdict. Throws with the exact reason. */
export async function assertBootAdmission(client, env = process.env, context = "copy-mode startup") {
  const journal = await readJournal(client);
  const verdict = bootAdmissionVerdict(journal, env);
  if (!verdict.ok) throw new Error(`${context} refused: ${verdict.reason}`);
  return journal;
}

/**
 * B3: durable monotonic capture watermark. Discovery must never choose a run older than the newest
 * one already installed — doing so oscillated staging between two weekly bundles forever. The
 * watermark advances only forward and only under the coordinator lock.
 */
export async function recordSourceWatermark(client, { capturedAt, runId }) {
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal
        SET source_watermark = GREATEST(COALESCE(source_watermark, to_timestamp(0)), $1::timestamptz),
            source_watermark_run_id = CASE
              WHEN source_watermark IS NULL OR $1::timestamptz >= source_watermark THEN $2
              ELSE source_watermark_run_id END,
            updated_at = now()
      WHERE singleton=true RETURNING source_watermark, source_watermark_run_id`,
    [capturedAt, runId]
  );
  if (result.rows.length !== 1) throw new Error("source watermark update failed");
  return result.rows[0];
}

export async function markReady(client, { runId, objectId, digest, commit, mode }) {
  if (!objectId || !/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new Error("ready requires the canonical durable object identity and digest");
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET state='ready', run_id=$1, last_ready_run_id=$1,
       last_safe_checkpoint='ready',
       last_ready_object_id=$2, last_ready_digest=$3, last_ready_commit=$4, last_ready_mode=$5,
       candidate_run_id=NULL, candidate_object_id=NULL, candidate_digest=NULL, candidate_mode=NULL,
       boot_run_id=NULL, boot_commit=NULL,
       catchup_attempts=0, catchup_error=NULL, updated_at=now()
     WHERE singleton=true AND state='booting' AND run_id=$1 RETURNING *`,
    [runId, objectId, digest, commit, mode]
  );
  if (result.rows.length !== 1) throw new Error("ready transition refused before successful boot");
  return result.rows[0];
}

// ── H2: interrupted first-bootstrap recovery record ────────────────────────────────────────────

/**
 * Persist what a REPLACEMENT worker needs to finish this bootstrap, BEFORE anything is stopped.
 *
 * The identity fields are not decoration: a fresh worker must be able to prove the record describes
 * ITS pinned environment and app service before acting on it, and refuse otherwise. Written under
 * the coordinator lock, like every other bootstrap decision.
 */
export async function recordBootstrapRecovery(client, { runId, phase, deploymentId, commit, mode, environmentId, appServiceId, objectId = null, digest = null }) {
  if (!runId || !BOOTSTRAP_PHASES.includes(phase)) throw new Error("bootstrap recovery record requires a run and a supported phase");
  if (!FULL_SHA.test(String(commit ?? ""))) throw new Error("bootstrap recovery record requires the exact measured deployment commit");
  if (!deploymentId || !mode || !environmentId || !appServiceId) throw new Error("bootstrap recovery record requires the measured deployment and its pinned environment/service identity");
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET
       bootstrap_run_id=$1, bootstrap_phase=$2, bootstrap_deployment_id=$3, bootstrap_commit=$4,
       bootstrap_mode=$5, bootstrap_environment_id=$6, bootstrap_app_service_id=$7,
       bootstrap_object_id=COALESCE($8, bootstrap_object_id), bootstrap_digest=COALESCE($9, bootstrap_digest),
       updated_at=now()
     WHERE singleton=true RETURNING *`,
    [runId, phase, deploymentId, commit, mode, environmentId, appServiceId, objectId, digest],
  );
  if (result.rows.length !== 1) throw new Error("bootstrap recovery record write failed");
  return result.rows[0];
}

/** Cleared only once the bootstrap has actually committed ready; never to escape fencing. */
export async function clearBootstrapRecovery(client, runId) {
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET
       bootstrap_run_id=NULL, bootstrap_phase=NULL, bootstrap_deployment_id=NULL, bootstrap_commit=NULL,
       bootstrap_mode=NULL, bootstrap_environment_id=NULL, bootstrap_app_service_id=NULL,
       bootstrap_object_id=NULL, bootstrap_digest=NULL, updated_at=now()
     WHERE singleton=true AND state='ready' AND run_id=$1 RETURNING *`,
    [runId],
  );
  if (result.rows.length !== 1) throw new Error("bootstrap recovery cleanup refused outside its own ready run");
  return result.rows[0];
}

/**
 * Decide whether a recorded interrupted bootstrap may be resumed by THIS worker.
 *
 * Refusal is the safe outcome everywhere: an ambiguous or mismatched recorded identity leaves
 * staging fenced with no lifecycle or database mutation, which is exactly the state an operator can
 * inspect. Nothing here invents a last-ready, guesses a branch head, or clears enrollment.
 */
export function bootstrapResumeVerdict(journal, env = process.env) {
  const runId = String(journal?.bootstrap_run_id ?? "");
  const phase = String(journal?.bootstrap_phase ?? "");
  if (!runId) return { resume: false, reason: "no interrupted bootstrap is recorded" };
  if (!BOOTSTRAP_PHASES.includes(phase)) return { resume: false, ok: false, reason: `recorded bootstrap phase ${phase || "is absent"} is not resumable` };
  const commit = String(journal?.bootstrap_commit ?? "");
  const mode = String(journal?.bootstrap_mode ?? "");
  if (!FULL_SHA.test(commit)) return { resume: false, ok: false, reason: "recorded bootstrap baseline has no exact commit identity" };
  if (!new Set(["legacy-pg-only", "copy-ready"]).has(mode)) return { resume: false, ok: false, reason: "recorded bootstrap mode is not a supported staging mode" };
  if (String(journal?.run_id ?? "") !== runId) return { resume: false, ok: false, reason: "recorded bootstrap run is not the journal's current run" };
  // The recorded SUBJECT must be this worker's own pinned subject. A record about another
  // environment or app service is evidence about that environment, not permission to act here.
  const expectedEnvironment = String(env.RAILWAY_ENVIRONMENT_ID ?? "");
  const expectedService = String(env.STAGING_APP_SERVICE_ID ?? "");
  if (!expectedEnvironment || !expectedService) return { resume: false, ok: false, reason: "this worker has no pinned environment/app-service identity to validate the recorded bootstrap against" };
  if (String(journal?.bootstrap_environment_id ?? "") !== expectedEnvironment || String(journal?.bootstrap_app_service_id ?? "") !== expectedService) {
    return { resume: false, ok: false, reason: "the recorded interrupted bootstrap is about a different pinned environment or application service" };
  }
  if (phase === "captured" && (!journal?.bootstrap_object_id || !/^[0-9a-f]{64}$/.test(String(journal?.bootstrap_digest ?? "")))) {
    return { resume: false, ok: false, reason: "the recorded bootstrap claims a published checkpoint with no canonical object identity" };
  }
  return {
    resume: true, ok: true, reason: `resuming interrupted bootstrap ${runId} from ${phase}`,
    runId, phase, commit, mode,
    deploymentId: String(journal.bootstrap_deployment_id ?? ""),
    objectId: journal.bootstrap_object_id ?? null,
    digest: journal.bootstrap_digest ?? null,
  };
}

// ── Fable HIGH-1: destructive source-install attempt admission ──────────────────────────────────

export async function readSourceAttempt(client, objectId) {
  const result = await client.query("SELECT * FROM staging_ops.source_install_attempts WHERE object_id=$1", [objectId]);
  return result.rows[0] ?? null;
}

/**
 * Mark a destructive attempt BEFORE the mutation it authorises, so a crash between the two leaves
 * the attempt recorded rather than erased. Conservative by construction: the failure mode of an
 * over-recorded attempt is "an operator must retry explicitly"; the failure mode of an
 * under-recorded one is the repeated-outage loop this record exists to stop.
 */
export async function recordSourceAttempt(client, { objectId, runId, digest }) {
  if (!objectId || !runId || !/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new Error("install attempt admission requires the immutable source identity and digest");
  const result = await client.query(
    `INSERT INTO staging_ops.source_install_attempts (object_id, run_id, digest, status, attempts)
       VALUES ($1,$2,$3,'attempted',1)
     ON CONFLICT (object_id) DO UPDATE SET
       status='attempted', attempts=staging_ops.source_install_attempts.attempts + 1,
       last_attempt_at=now(), last_error=NULL, run_id=EXCLUDED.run_id, digest=EXCLUDED.digest
     RETURNING *`,
    [objectId, runId, digest],
  );
  if (result.rows.length !== 1) throw new Error("install attempt admission record write failed");
  return result.rows[0];
}

export async function completeSourceAttempt(client, { objectId, status, error = null }) {
  if (!new Set(["failed", "installed"]).has(status)) throw new Error("install attempt completion requires a terminal status");
  const result = await client.query(
    `UPDATE staging_ops.source_install_attempts SET status=$2, last_error=$3, last_attempt_at=now()
       WHERE object_id=$1 RETURNING *`,
    [objectId, status, error === null ? null : String(error).slice(0, 500)],
  );
  return result.rows[0] ?? null;
}

/**
 * The automatic-admission decision. `attempted` is treated exactly like `failed`: a record left in
 * `attempted` means a worker entered the destructive path and did not come back to say how it
 * ended, which is the interrupted case, and is not a reason to drain staging again unattended.
 *
 * Only EXPLICIT operator invocation (`importer install <object-id>`) may authorise another attempt;
 * this is deliberately not a variable, a flag on the daemon, or a bounded automatic retry count.
 */
/**
 * Withdraw an attempt record on a PROVEN non-destructive failure.
 *
 * The record is written before the drain because a crash must not be able to erase it — and a crash
 * cannot reach this function, by construction. This is the narrow opposite case: the caller has
 * positive evidence that the drain transition never completed, so nothing was stopped and neither
 * store was touched. Leaving `attempted` there would demand an explicit operator retry for a
 * pre-drain environment fault (a misconfigured runner pin, a refused transition) that the next tick
 * would have handled by itself, with no outage either way.
 */
export async function withdrawSourceAttempt(client, objectId) {
  const result = await client.query(
    "DELETE FROM staging_ops.source_install_attempts WHERE object_id=$1 AND status='attempted' RETURNING object_id",
    [objectId],
  );
  return result.rows.length === 1;
}

export function sourceAttemptAdmission(attempt, { automatic }) {
  if (!automatic) return { ok: true, reason: "explicit operator invocation" };
  if (!attempt) return { ok: true, reason: "no recorded destructive attempt for this immutable source" };
  if (attempt.status === "installed") return { ok: true, reason: "the recorded attempt for this source completed" };
  return {
    ok: false,
    reason: `immutable source ${attempt.object_id} already made ${attempt.attempts} destructive install attempt(s) and last ended "${attempt.status}"; automatic refresh will not drain staging again for it. Fix the cause and retry explicitly with \`importer install ${attempt.object_id}\`, or publish a new source`,
  };
}

export async function recordCatchup(client, { commit, attempts, error = null }) {
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET catchup_commit=$1, catchup_attempts=$2, catchup_error=$3, updated_at=now()
     WHERE singleton=true RETURNING *`, [commit, attempts, error]
  );
  if (result.rows.length !== 1) throw new Error("catch-up journal update failed");
  return result.rows[0];
}
