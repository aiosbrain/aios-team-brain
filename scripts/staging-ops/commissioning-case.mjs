/**
 * AIO-1124 — the per-case staged state machine's CLOSED enum and its private per-job state store.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. A protected actor job cannot run one long process that both
 * mutates a ref and uploads an artifact mid-flight: only an official Actions step can upload, so the
 * measurement has to be cut into steps, and the steps have to hand state to one another. That state
 * is the load-bearing part of the whole witness protocol — it carries the case's private 256-bit
 * nonce, the exact SHAs it measured before the mutation, and the fsynced marker that says "a
 * mutation request has left this process". So it gets a module with one job, rather than being an
 * ambient temp file three call sites agree about.
 *
 * FIVE PROPERTIES, each because its absence is a way to launder a result:
 *
 *  1. **The stage and case vocabulary is CLOSED and ORDERED.** A stage may only run when its
 *     predecessor recorded success for the same case, and a case may only start when the previous
 *     case finished. There is no case selector, no dynamic matrix, and no way to reach `execute`
 *     without the `prepare` that measured its preconditions.
 *  2. **A stage validates its own `GITHUB_JOB` against the closed role table BEFORE anything else.**
 *     A helper that mints an actor credential must not be reachable from a job that was not reviewed
 *     to hold it — and "not reachable" has to mean a refusal, not an absent lookup.
 *  3. **Once-only consumption.** A witness response is consumed exactly once, recorded durably. A
 *     replayed response is a refusal, not a second opinion.
 *  4. **The mutation-used marker is fsynced BEFORE the request.** A crash after the marker means the
 *     mutation may have happened; that is an unresolved state to reconcile, and it is exactly the
 *     state that disappears if you only persist outcomes.
 *  5. **Mode 0600, no symlink, absolute path.** The nonce is not a secret credential — the artifact
 *     carrying it is readable — but it IS a one-use correlation value, and a state file another
 *     account can rewrite is a state file that can be handed a different nonce.
 *
 * It imports node built-ins only. The runner owns transports, graphs and policy; this owns sequence
 * and durability, and the one-way dependency is what keeps either testable on its own.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

export const CASE_STATE_SCHEMA_VERSION = 1;

/** The three stages the RUNNER owns for a commissioning case. Steps 2 and 4 are upload steps. */
export const COMMISSION_STAGES = Object.freeze(["prepare", "await-and-execute", "await-and-finalize"]);

/**
 * The rehearsal's OWN two stages, deliberately not the commissioning three.
 *
 * The rehearsal has no mutation, so it has no `await-and-execute` — and giving it one would mean a
 * stage that exists to mint an actor credential being reachable from a job that holds none. Its
 * separate vocabulary is what makes "the rehearsal cannot pass actor admission" a property of the
 * enum rather than of a conditional.
 */
export const REHEARSAL_STAGES = Object.freeze(["challenge", "consume"]);

export const CASE_STAGES = Object.freeze([...COMMISSION_STAGES, ...REHEARSAL_STAGES]);

/** Which stage may follow which. `null` means "may start a case". */
export const CASE_STAGE_PREDECESSOR = Object.freeze({
  prepare: null,
  "await-and-execute": "prepare",
  "await-and-finalize": "await-and-execute",
  challenge: null,
  consume: "challenge",
});

/** The direction of the challenge each stage publishes, or `null` when it publishes none. */
export const CASE_STAGE_DIRECTION = Object.freeze({
  prepare: "pre",
  "await-and-execute": "post",
  "await-and-finalize": null,
  challenge: "pre",
  consume: null,
});

/** The stage vocabulary each role may use. Crossing them is a refusal, not a fallback. */
export const ROLE_STAGES = Object.freeze({
  normal: COMMISSION_STAGES,
  emergency: COMMISSION_STAGES,
  rehearsal: REHEARSAL_STAGES,
});

export const CHALLENGE_DIRECTIONS = Object.freeze(["pre", "post"]);

/**
 * The CLOSED, ORDERED cloud case list — seven normal and four emergency, which is what makes
 * "exactly 22 witness publications" a count this build can check rather than a number in prose.
 *
 * The human/admin cases are deliberately ABSENT: they run in the local operator's own process, which
 * measures the policy directly under admin and needs no witness at all.
 */
export const CLOUD_CASE_SEQUENCE = Object.freeze({
  normal: Object.freeze([
    "normal-update-missing-check",
    "normal-update-failed-check",
    "normal-update-wrong-producer",
    "normal-update-all-green",
    "normal-force-rewind",
    "normal-force-divergent",
    "normal-delete",
  ]),
  emergency: Object.freeze([
    "emergency-update-no-checks",
    "emergency-force-rewind",
    "emergency-force-divergent",
    "emergency-delete",
  ]),
});

/** The one rehearsal "case". A closed literal, in its own domain, with an inert target. */
export const REHEARSAL_CASE_ID = "transport-rehearsal";
export const REHEARSAL_ROLE = "rehearsal";
export const REHEARSAL_DOMAIN = "rehearsal";
export const REHEARSAL_TARGET = "rehearsal";
export const COMMISSION_DOMAIN = "commission";

/** Exactly one pre and one post response per cloud case, and nothing else counts toward it. */
export const REQUIRED_WITNESS_PUBLICATIONS =
  (CLOUD_CASE_SEQUENCE.normal.length + CLOUD_CASE_SEQUENCE.emergency.length) * CHALLENGE_DIRECTIONS.length;

export class CaseStateError extends Error {
  constructor(message) { super(message); this.name = "CaseStateError"; this.exitCode = 1; }
}
export class CaseUsageError extends Error {
  constructor(message) { super(message); this.name = "CaseUsageError"; this.exitCode = 2; }
}

const DECIMAL = /^[1-9][0-9]{0,17}$/;
const NONCE = /^[0-9a-f]{64}$/;

/**
 * The ordinal a case occupies in its role's sequence, 1-based.
 *
 * 1-based because the ordinal travels in an artifact NAME, and a zero there is indistinguishable
 * from an absent field in half the places a human reads it. The rehearsal deliberately gets 0, which
 * is how a rehearsal name can never collide with a commissioning one.
 */
export function caseOrdinal(role, caseId) {
  if (role === REHEARSAL_ROLE) {
    if (caseId !== REHEARSAL_CASE_ID) throw new CaseUsageError(`the rehearsal role has exactly one case, not ${JSON.stringify(String(caseId))}`);
    return 0;
  }
  const sequence = CLOUD_CASE_SEQUENCE[role];
  if (!sequence) throw new CaseUsageError(`unknown commissioning cloud role ${JSON.stringify(String(role))}`);
  const index = sequence.indexOf(String(caseId));
  if (index < 0) throw new CaseUsageError(`case ${JSON.stringify(String(caseId))} is not one of the ${role} role's closed cases`);
  return index + 1;
}

export function assertCaseStage(stage, role = null) {
  if (!CASE_STAGES.includes(stage)) throw new CaseUsageError(`unknown commissioning case stage ${JSON.stringify(String(stage))}`);
  if (role !== null) {
    const allowed = ROLE_STAGES[role];
    if (!allowed) throw new CaseUsageError(`unknown commissioning case role ${JSON.stringify(String(role))}`);
    if (!allowed.includes(stage)) throw new CaseUsageError(`the ${role} role has no ${stage} stage`);
  }
  return stage;
}

/** The one role a case ID belongs to, resolved from the CLOSED sequences and nowhere else. */
export function roleForCase(caseId) {
  if (String(caseId) === REHEARSAL_CASE_ID) return REHEARSAL_ROLE;
  for (const [role, sequence] of Object.entries(CLOUD_CASE_SEQUENCE)) {
    if (sequence.includes(String(caseId))) return role;
  }
  throw new CaseUsageError(`case ${JSON.stringify(String(caseId))} is not one of this harness's closed cloud cases`);
}

/** A fresh 256-bit nonce. Random, per challenge, never derived from anything a caller supplies. */
export const freshNonce = () => randomBytes(32).toString("hex");

export const nonceDigest = (nonce) => {
  if (!NONCE.test(String(nonce ?? ""))) throw new CaseUsageError("a commissioning nonce is 64 lowercase hex characters");
  return createHash("sha256").update(String(nonce), "utf8").digest("hex");
};

/** The bytes-exact digest of an envelope, so both sides can bind the same artifact content. */
export const bytesDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assertPrivateStateDirectory(dir) {
  if (typeof dir !== "string" || !dir.trim()) throw new CaseUsageError("a case state directory is required");
  if (!path.isAbsolute(dir)) throw new CaseUsageError("the case state directory must be an absolute path");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new CaseUsageError("the case state directory must not be a symlink");
  if (!statSync(dir).isDirectory()) throw new CaseUsageError("the case state directory path is not a directory");
  return dir;
}

function assertRegularOrAbsent(file) {
  let link;
  try { link = lstatSync(file); } catch { return; }
  if (link.isSymbolicLink()) throw new CaseUsageError(`${path.basename(file)} is a symlink; refusing to write through it`);
  if (!link.isFile()) throw new CaseUsageError(`${path.basename(file)} is not a regular file`);
}

const stateFile = (dir, runId, attempt, role, ordinal) =>
  path.join(dir, `case-${runId}-${attempt}-${role}-${String(ordinal).padStart(2, "0")}.json`);

/** An atomic, fsynced, mode-0600 write. `rename` is what makes a torn state file impossible. */
function writeAtomic(target, payload) {
  assertRegularOrAbsent(target);
  const temporary = `${target}.tmp`;
  assertRegularOrAbsent(temporary);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, target);
  return target;
}

/**
 * The per-job private state store for ONE role's staged cases.
 *
 * Bound to a run, an attempt and a role at construction: a store cannot be asked about another
 * role's case, and every path it touches is derived rather than supplied.
 */
export function openCaseStateStore({ dir, runId, attempt, role, now = () => new Date() }) {
  if (!DECIMAL.test(String(runId))) throw new CaseUsageError("a case state store needs a positive decimal run ID");
  if (!DECIMAL.test(String(attempt))) throw new CaseUsageError("a case state store needs a positive decimal attempt");
  if (role !== REHEARSAL_ROLE && !CLOUD_CASE_SEQUENCE[role]) throw new CaseUsageError(`unknown commissioning cloud role ${JSON.stringify(String(role))}`);
  const root = assertPrivateStateDirectory(dir);
  const sequence = role === REHEARSAL_ROLE ? [REHEARSAL_CASE_ID] : CLOUD_CASE_SEQUENCE[role];

  const read = (caseId) => {
    const file = stateFile(root, runId, attempt, role, caseOrdinal(role, caseId));
    let text;
    try { text = readFileSync(file, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new CaseStateError(`the ${caseId} case state file is not valid JSON; this case cannot be resumed`); }
    if (parsed?.schema_version !== CASE_STATE_SCHEMA_VERSION) throw new CaseStateError(`the ${caseId} case state file has an unsupported schema version`);
    if (String(parsed.run_id) !== String(runId) || String(parsed.attempt) !== String(attempt) || String(parsed.role) !== String(role)) {
      throw new CaseStateError(`the ${caseId} case state file belongs to a different run, attempt or role`);
    }
    if (String(parsed.case_id) !== String(caseId)) throw new CaseStateError(`the ${caseId} case state file records case ${JSON.stringify(String(parsed.case_id ?? ""))}`);
    return parsed;
  };

  const write = (caseId, state) => writeAtomic(
    stateFile(root, runId, attempt, role, caseOrdinal(role, caseId)),
    {
      schema_version: CASE_STATE_SCHEMA_VERSION,
      run_id: String(runId), attempt: String(attempt), role: String(role), case_id: String(caseId),
      ordinal: caseOrdinal(role, caseId), updated_at: now().toISOString(), ...state,
    },
  );

  return {
    dir: root,
    role,
    sequence,
    read,
    write,

    /**
     * Refuse to start a case until every case BEFORE it in the closed sequence finalized.
     *
     * This is what stops a workflow whose steps were reordered, or one whose earlier case halted,
     * from measuring a later case against a ref state nobody planned.
     */
    assertPriorCasesFinalized(caseId) {
      const ordinal = caseOrdinal(role, caseId);
      const terminal = ROLE_STAGES[role][ROLE_STAGES[role].length - 1];
      for (const earlier of sequence.slice(0, Math.max(0, ordinal - 1))) {
        const state = read(earlier);
        if (!state) throw new CaseStateError(`case ${caseId} cannot start: the earlier case ${earlier} has no recorded state`);
        if (state.stage !== terminal || state.status !== "finalized") {
          throw new CaseStateError(`case ${caseId} cannot start: the earlier case ${earlier} is ${String(state.status ?? "unrecorded")} at stage ${String(state.stage ?? "none")}`);
        }
        // A HALT is terminal for the whole role, not just for its own case. Once an actor has
        // demonstrably done something the policy must forbid, every later case would run against a
        // state nobody planned, with a credential just shown to be over-privileged — so "finalized"
        // is not enough on its own.
        if (state.halt === true) {
          throw new CaseStateError(`case ${caseId} cannot start: the earlier case ${earlier} halted this actor, and no further mutation runs in this attempt`);
        }
        /**
         * A GENUINELY SUCCESSFUL predecessor, not merely a finalized one.
         *
         * `finalized` and `halt` were the whole test, and neither covers the state in between:
         * finalization WRITES the finalized state and then throws for an inconclusive, non-halting
         * verdict. So a case that recorded `inconclusive` — the provider refused for a reason no
         * rule explains, or the readback did not show the requested commit — left a finalized,
         * non-halting record, and the next case started against a ref state nobody had established.
         * Each case's precondition is the previous case's OUTCOME, so the outcome is what has to
         * hold.
         */
        if (state.record?.passed !== true) {
          throw new CaseStateError(
            `case ${caseId} cannot start: the earlier case ${earlier} recorded ${JSON.stringify(String(state.record?.outcome ?? "no outcome"))} rather than its expected result, so this case's preconditions were never established`,
          );
        }
      }
      return true;
    },

    /** The predecessor stage's own success, for THIS case, or a refusal naming what is missing. */
    requireStage(caseId, stage) {
      assertCaseStage(stage, role);
      const predecessor = CASE_STAGE_PREDECESSOR[stage];
      const state = read(caseId);
      if (predecessor === null) {
        if (state) throw new CaseStateError(`case ${caseId} already has recorded state; a case is prepared exactly once per attempt`);
        return null;
      }
      if (!state) throw new CaseStateError(`stage ${stage} of case ${caseId} has no ${predecessor} state to continue from`);
      if (state.stage !== predecessor) throw new CaseStateError(`stage ${stage} of case ${caseId} expected ${predecessor} state, found ${JSON.stringify(String(state.stage ?? ""))}`);
      if (state.status !== "ok") throw new CaseStateError(`stage ${stage} of case ${caseId} cannot continue from a ${predecessor} stage recorded as ${JSON.stringify(String(state.status ?? ""))}`);
      return state;
    },

    /**
     * Record that a nonce has been consumed by a response, exactly once.
     *
     * The refusal here is the replay guard: a second response bearing a nonce this store already
     * consumed is not a retry, it is a different observation wearing a used correlation value.
     */
     consumeNonce(caseId, { direction, nonce, artifact_id, artifact_digest, response_digest }) {
      if (!CHALLENGE_DIRECTIONS.includes(String(direction))) throw new CaseUsageError(`unknown challenge direction ${JSON.stringify(String(direction))}`);
      const state = read(caseId);
      if (!state) throw new CaseStateError(`case ${caseId} has no state, so no nonce of its can be consumed`);
      const consumed = Array.isArray(state.consumed) ? state.consumed : [];
      if (consumed.some((entry) => String(entry?.nonce) === String(nonce))) {
        throw new CaseStateError(`the ${direction} witness nonce for case ${caseId} has already been consumed; a replayed response is refused`);
      }
      const expected = String(state[`${direction}_nonce`] ?? "");
      if (!NONCE.test(expected)) throw new CaseStateError(`case ${caseId} recorded no ${direction} nonce to match a response against`);
      if (expected !== String(nonce)) throw new CaseStateError(`the ${direction} response for case ${caseId} carries a nonce this job never created`);
      const record = {
        direction: String(direction), nonce: String(nonce), artifact_id: Number(artifact_id) || null,
        artifact_digest: String(artifact_digest ?? ""), response_digest: String(response_digest ?? ""),
        consumed_at: now().toISOString(),
      };
      write(caseId, { ...state, consumed: [...consumed, record] });
      return record;
    },

    /**
     * Fsync "a mutation request is about to leave this process", BEFORE it leaves.
     *
     * A crash between this marker and a recorded result is the ambiguous state the canonical
     * revision forbids retrying. Persisting it is the only way that state is distinguishable from
     * "the request never happened" after the fact.
     */
    markMutationUsed(caseId, intent) {
      const state = read(caseId);
      if (!state) throw new CaseStateError(`case ${caseId} has no state to mark a mutation against`);
      if (state.mutation_used === true) {
        throw new CaseStateError(`case ${caseId} already recorded a mutation as issued; commissioning never repeats a mutation after an ambiguous response`);
      }
      write(caseId, { ...state, mutation_used: true, mutation_intent: intent ?? null, mutation_marked_at: now().toISOString() });
      return true;
    },

    /**
     * Role-scoped auxiliary state, for the one fact that belongs to the ROLE rather than to a case:
     * installation-level positive-write liveness within this exact attempt (PC-05).
     *
     * It is per-role because that is the scope the canonical revision gives it — installation-level,
     * once per attempt — and keeping it out of the per-case files is what stops it from being
     * mistaken for a per-token successful-write claim in any single case's record.
     */
    writeRoleState(key, value) {
      if (!/^[a-z][a-z-]{0,30}$/.test(String(key))) throw new CaseUsageError("a role state key is a fixed lowercase name");
      return writeAtomic(path.join(root, `role-${runId}-${attempt}-${role}-${key}.json`), {
        schema_version: CASE_STATE_SCHEMA_VERSION,
        run_id: String(runId), attempt: String(attempt), role: String(role), key: String(key),
        updated_at: now().toISOString(), ...value,
      });
    },

    readRoleState(key) {
      if (!/^[a-z][a-z-]{0,30}$/.test(String(key))) throw new CaseUsageError("a role state key is a fixed lowercase name");
      let text;
      try { text = readFileSync(path.join(root, `role-${runId}-${attempt}-${role}-${key}.json`), "utf8"); }
      catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new CaseStateError(`the ${role} ${key} state file is not valid JSON`); }
      if (parsed?.schema_version !== CASE_STATE_SCHEMA_VERSION) throw new CaseStateError(`the ${role} ${key} state file has an unsupported schema version`);
      if (String(parsed.run_id) !== String(runId) || String(parsed.attempt) !== String(attempt) || String(parsed.role) !== String(role)) {
        throw new CaseStateError(`the ${role} ${key} state file belongs to a different run, attempt or role`);
      }
      return parsed;
    },

    /** Every state file this store owns, in sequence order — the finalizer's input. */
    readAll() {
      return sequence.map((caseId) => ({ case_id: caseId, ordinal: caseOrdinal(role, caseId), state: read(caseId) }));
    },

    /** State files in the directory that this store does not own. A leftover is not evidence. */
    foreignStateFiles() {
      const owned = new Set(sequence.map((caseId) => path.basename(stateFile(root, runId, attempt, role, caseOrdinal(role, caseId)))));
      return readdirSync(root)
        .filter((name) => /^case-.*\.json$/.test(name))
        .filter((name) => name.startsWith(`case-${runId}-${attempt}-${role}-`))
        .filter((name) => !owned.has(name));
    },
  };
}
