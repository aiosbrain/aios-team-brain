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
`;

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

export async function recordCatchup(client, { commit, attempts, error = null }) {
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET catchup_commit=$1, catchup_attempts=$2, catchup_error=$3, updated_at=now()
     WHERE singleton=true RETURNING *`, [commit, attempts, error]
  );
  if (result.rows.length !== 1) throw new Error("catch-up journal update failed");
  return result.rows[0];
}
