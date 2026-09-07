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
  candidate_run_id text,
  candidate_object_id text,
  candidate_digest text,
  candidate_mode text,
  catchup_commit text,
  catchup_attempts integer not null default 0,
  catchup_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO staging_ops.refresh_journal(singleton, state) VALUES (true, 'failed')
ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS last_ready_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS last_ready_digest text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_object_id text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_digest text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS candidate_mode text;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS catchup_attempts integer not null default 0;
ALTER TABLE staging_ops.refresh_journal ADD COLUMN IF NOT EXISTS catchup_error text;
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
       candidate_mode=COALESCE($7,candidate_mode), catchup_commit=COALESCE($8,catchup_commit), updated_at=now()
     WHERE singleton=true AND state = ANY($9::text[]) RETURNING *`,
    [runId, to, patch.lastSafeCheckpoint ?? null, patch.candidateRunId ?? null, patch.candidateObjectId ?? null, patch.candidateDigest ?? null, patch.candidateMode ?? null, patch.catchupCommit ?? null, from]
  );
  if (result.rows.length !== 1) throw new Error(`journal transition to ${to} refused from current state`);
  return result.rows[0];
}

export async function markReady(client, { runId, objectId, digest, commit, mode }) {
  if (!objectId || !/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new Error("ready requires the canonical durable object identity and digest");
  const result = await client.query(
    `UPDATE staging_ops.refresh_journal SET state='ready', run_id=$1, last_ready_run_id=$1,
       last_safe_checkpoint='ready',
       last_ready_object_id=$2, last_ready_digest=$3, last_ready_commit=$4, last_ready_mode=$5,
       candidate_run_id=NULL, candidate_object_id=NULL, candidate_digest=NULL, candidate_mode=NULL,
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
