/**
 * The LOCAL, mode-0600, append-only journal for one AIO-1124 commissioning run (PC-03/PC-07).
 *
 * This is the only durable record of which disposable provider resources a commissioning run
 * actually created, and it is what cleanup is allowed to act on. Everything about its shape follows
 * from one rule: **cleanup may delete a resource only because this file says this run created it,
 * with this exact fingerprint.** Not because a name matches a prefix, not because an enumeration
 * returned it, not because deleting it would make the run look finished.
 *
 * Five properties, each of which exists because its absence is a way to lose or fake evidence:
 *
 *  1. **Append-only, hash-chained.** Every record carries the digest of the previous record's
 *     exact serialized bytes. A truncated or edited chain REFUSES further writes rather than
 *     continuing from a state nobody can reconstruct. Old records are never rewritten.
 *  2. **Intent before the request, result after it.** Both are fsynced. A crash between the two
 *     leaves a mutation whose outcome is UNKNOWN — which is a state recovery must reconcile by
 *     provider readback, and is precisely the state that vanishes if you only journal successes.
 *  3. **An exclusive run-scoped lock guards every writer**, cleanup and recovery included. Lock
 *     creation is atomic (`wx`), and the holder's nonce is re-read on every append: a writer that
 *     lost the lock stops writing instead of interleaving into another process's chain.
 *  4. **A stale lock is never removed on elapsed time.** Recovery requires the caller to prove the
 *     original owner is gone AND to reconcile the last recorded mutation by provider readback.
 *     Time-based lock stealing is how two cleanups delete each other's half of a run.
 *  5. **No credential-shaped value may enter.** Refused at append time, not by reviewer discipline.
 *
 * Derived snapshots may be regenerated from a verified chain, atomically and at mode 0600, but they
 * never replace it: a snapshot is a view, and the historical events are the evidence.
 */

import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export const JOURNAL_SCHEMA_VERSION = 1;

/** The chain's fixed root. A first record whose `prev` is anything else is not this chain's head. */
export const GENESIS_DIGEST = "0".repeat(64);

/** The closed set of event types. An unknown type is a caller bug, not a new kind of evidence. */
export const JOURNAL_EVENTS = Object.freeze([
  "run-opened",
  "baseline-measured",
  "mutation-intent",
  "mutation-result",
  "readback",
  "resource-created",
  "case-outcome",
  "cleanup-intent",
  "cleanup-result",
  "recovery",
  "run-closed",
]);

export class JournalLockedError extends Error {
  constructor(owner) {
    super("another commissioning writer holds this run's journal lock");
    this.name = "JournalLockedError";
    this.owner = owner;
  }
}

export class JournalChainError extends Error {
  constructor(message) {
    super(message);
    this.name = "JournalChainError";
  }
}

export class JournalRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "JournalRefusalError";
  }
}

const DECIMAL = /^[1-9][0-9]{0,17}$/;

function assertRunIdentity(runId, attempt) {
  if (!DECIMAL.test(String(runId))) throw new JournalRefusalError("journal run ID must be a positive decimal");
  if (!DECIMAL.test(String(attempt))) throw new JournalRefusalError("journal attempt must be a positive decimal");
}

const baseName = (runId, attempt) => `commissioning-${runId}-${attempt}`;

export const journalPath = (dir, runId, attempt) => path.join(dir, `${baseName(runId, attempt)}.jsonl`);
export const lockPath = (dir, runId, attempt) => path.join(dir, `${baseName(runId, attempt)}.lock`);
export const snapshotPath = (dir, runId, attempt) => path.join(dir, `${baseName(runId, attempt)}.snapshot.json`);
/**
 * A SECOND lock, held only for the duration of a recovery.
 *
 * The run lock cannot serialise its own replacement: two recoveries both find the same stale owner,
 * both reconcile, and both then unlink the pathname — so the second deletes the lock the first just
 * acquired, and two writers proceed believing they own the run. This one is created `wx` before
 * anything is read and released only at the end, so exactly one recovery can be in flight.
 */
export const recoveryLockPath = (dir, runId, attempt) => path.join(dir, `${baseName(runId, attempt)}.recovery.lock`);

/**
 * The evidence directory must be a real, private directory this process owns.
 *
 * A symlinked directory (or a symlinked journal inside it) means the 0600 mode is being applied to
 * a file somewhere else — which is how a "private" journal ends up world-readable, or ends up
 * overwriting a path the operator did not choose. Group/other permission bits on the directory are
 * refused for the same reason: the mode on the file is not a control if the directory around it
 * lets another account replace the file wholesale.
 */
export function assertPrivateDirectory(dir) {
  if (typeof dir !== "string" || !dir.trim()) throw new JournalRefusalError("an evidence directory path is required");
  if (!path.isAbsolute(dir)) throw new JournalRefusalError("the evidence directory must be an absolute path");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const link = lstatSync(dir);
  if (link.isSymbolicLink()) throw new JournalRefusalError("the evidence directory must not be a symlink");
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new JournalRefusalError("the evidence directory path is not a directory");
  if ((stats.mode & 0o077) !== 0) throw new JournalRefusalError("the evidence directory must not be group- or world-accessible");
  return realpathSync(dir);
}

/** A file the journal is about to write must be a regular file, never a link to somewhere else. */
function assertRegularOrAbsent(file) {
  let link;
  try { link = lstatSync(file); } catch { return; }
  if (link.isSymbolicLink()) throw new JournalRefusalError(`${path.basename(file)} is a symlink; refusing to write through it`);
  if (!link.isFile()) throw new JournalRefusalError(`${path.basename(file)} is not a regular file`);
  if ((link.mode & 0o077) !== 0) throw new JournalRefusalError(`${path.basename(file)} is group- or world-accessible`);
}

const CREDENTIAL_KEY = /(token|secret|password|passphrase|private_?key|privatekey|authorization|credential)/i;
const CREDENTIAL_VALUE = /(-----BEGIN |gh[pousr]_[A-Za-z0-9]{16,}|^eyJ[A-Za-z0-9_-]{10,}\.)/;

/**
 * Refuse credential-shaped content at the boundary. The journal records IDENTITIES (App IDs, ref
 * names, ruleset IDs, SHAs) and VERDICTS; a value that looks like key material is a caller mistake
 * that must fail loudly here rather than sit at rest in a file the operator later attaches to a
 * ticket.
 */
export function assertNoCredentialShapedValues(value, at = "record") {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.test(value)) throw new JournalRefusalError(`${at} contains credential-shaped material`);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialShapedValues(entry, `${at}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key) && typeof entry === "string" && entry.length > 0) {
      throw new JournalRefusalError(`${at}.${key} is a credential-shaped field and may not be journaled`);
    }
    assertNoCredentialShapedValues(entry, `${at}.${key}`);
  }
}

const digestOf = (line) => createHash("sha256").update(line, "utf8").digest("hex");

/**
 * Acquire the run-scoped exclusive lock. `wx` is the atomicity: two processes racing to create the
 * same path cannot both succeed, on any platform this runs on.
 */
export function acquireJournalLock({
  dir, runId, attempt, now = () => new Date(), pid = process.pid, host = hostname(),
  nonce = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32),
}) {
  assertRunIdentity(runId, attempt);
  const root = assertPrivateDirectory(dir);
  const file = lockPath(root, runId, attempt);
  assertRegularOrAbsent(file);
  const owner = { v: JOURNAL_SCHEMA_VERSION, run_id: String(runId), attempt: String(attempt), pid, host, nonce, acquired_at: now().toISOString() };
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new JournalLockedError(readLockOwner(root, runId, attempt));
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    ...owner,
    dir: root,
    release() {
      // Only the holder removes it, and only if the on-disk nonce still says so. A release that
      // deletes someone else's lock is the same bug as stealing it.
      const current = readLockOwner(root, runId, attempt);
      if (current?.nonce !== nonce) return false;
      unlinkSync(file);
      return true;
    },
  };
}

export function readLockOwner(dir, runId, attempt) {
  try {
    return JSON.parse(readFileSync(lockPath(dir, runId, attempt), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Explicit local recovery of a lock whose owner is gone (PC-03).
 *
 * THREE proofs are REQUIRED and none is inferable from the lock file:
 *  - `ownerGone` — the caller verified the recorded PID/host is not running this run. Elapsed time is
 *    not that proof; a slow provider call looks exactly like a dead process.
 *  - `reconcile` — a provider READBACK of the last recorded mutation, so the run resumes from what
 *    the provider actually holds rather than from what the journal last intended.
 *  - the lock is STILL the one this recovery started from, re-read immediately before replacement.
 *
 * The last of those is what stops a recovery from deleting a live owner's lock: `reconcile` is
 * awaited, and in that window another recovery can complete and take the lock. Comparing the nonce
 * at replacement time turns that race into a refusal. A recovery-scoped lock makes the race rare;
 * the nonce check makes it safe, and both are needed — the first alone leaves the window open across
 * processes that were already past it.
 *
 * An unreconciled or unknown last mutation stays inconclusive. Nothing here adopts or deletes a
 * resource to make the chain look complete.
 */
export async function recoverJournalLock({ dir, runId, attempt, ownerGone, reconcile, now = () => new Date() }) {
  assertRunIdentity(runId, attempt);
  const root = assertPrivateDirectory(dir);
  const recoveryLock = recoveryLockPath(root, runId, attempt);
  assertRegularOrAbsent(recoveryLock);
  let recoveryFd;
  try {
    recoveryFd = openSync(recoveryLock, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new JournalRefusalError("another recovery of this run is already in flight; recoveries are serialised");
    throw error;
  }
  try {
    writeSync(recoveryFd, `${JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, pid: process.pid, host: hostname(), started_at: now().toISOString() })}\n`);
    fsyncSync(recoveryFd);
  } finally {
    closeSync(recoveryFd);
  }
  try {
    const owner = readLockOwner(root, runId, attempt);
    if (!owner) throw new JournalRefusalError("there is no lock to recover for this run");
    if (ownerGone !== true) throw new JournalRefusalError("lock recovery requires explicit verification that the recorded owner is gone; elapsed time is not that verification");
    if (typeof reconcile !== "function") throw new JournalRefusalError("lock recovery requires a provider readback reconciliation");
    if (typeof owner.nonce !== "string" || !owner.nonce) throw new JournalRefusalError("the lock being recovered carries no owner nonce; it cannot be identified at replacement");
    const records = readJournal({ dir: root, runId, attempt });

    // The unresolved mutation may be a CLEANUP one. Looking only at `mutation-*` omits an interrupted
    // ruleset or ref DELETE — the most consequential thing a crashed cleanup can leave behind, and
    // the one a resumed run most needs reconciled before it decides anything.
    const INTENTS = ["mutation-intent", "cleanup-intent"];
    const RESULTS = ["mutation-result", "cleanup-result"];
    const lastIntent = [...records].reverse().find((record) => INTENTS.includes(record.type));
    const lastResult = [...records].reverse().find((record) => RESULTS.includes(record.type));
    const unresolved = lastIntent && (!lastResult || lastResult.seq < lastIntent.seq) ? lastIntent : null;
    const reconciliation = await reconcile(unresolved ? { kind_of_intent: unresolved.type, ...unresolved.data } : null);
    if (reconciliation?.reconciled !== true) {
      throw new JournalRefusalError("the last recorded mutation could not be reconciled by provider readback; the run stays inconclusive");
    }

    // Re-read AFTER the await. If the lock is gone or is somebody else's, this recovery lost the race
    // and must not unlink: the file it would remove now belongs to a writer that believes it owns the
    // run, and removing it is how provider cleanup interleaves with that writer.
    const current = readLockOwner(root, runId, attempt);
    if (!current) throw new JournalRefusalError("the lock this recovery started from was already released; re-check the run rather than replacing it");
    if (current.nonce !== owner.nonce) throw new JournalRefusalError("the lock was replaced while this recovery was reconciling; refusing to remove the new owner's lock");
    unlinkSync(lockPath(root, runId, attempt));
    const lock = acquireJournalLock({ dir: root, runId, attempt, now });
    const journal = openJournal({ dir: root, runId, attempt, source: records[0]?.source ?? "unknown", lock });
    journal.append("recovery", {
      replaced_owner: { pid: owner.pid, host: owner.host, acquired_at: owner.acquired_at },
      unresolved_intent_seq: unresolved?.seq ?? null,
      unresolved_intent_type: unresolved?.type ?? null,
      readback: reconciliation.readback ?? null,
    });
    return { lock, journal, unresolvedIntent: unresolved?.data ?? null, unresolvedIntentType: unresolved?.type ?? null, readback: reconciliation.readback ?? null };
  } finally {
    try { unlinkSync(recoveryLock); } catch { /* a recovery that never created it has nothing to remove */ }
  }
}

/**
 * Read and VERIFY the whole chain. Every failure mode is a refusal, never a shortened list:
 * a partial trailing line (a crash mid-write), a broken `prev` link, a non-monotonic sequence, or
 * a record belonging to a different run.
 */
export function readJournal({ dir, runId, attempt }) {
  assertRunIdentity(runId, attempt);
  const file = journalPath(dir, runId, attempt);
  assertRegularOrAbsent(file);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new JournalChainError("the journal ends mid-record; the chain is truncated and refuses further writes");
  const lines = text.slice(0, -1).split("\n");
  const records = [];
  let previous = GENESIS_DIGEST;
  let expectedSeq = 1;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { throw new JournalChainError(`journal record ${expectedSeq} is not valid JSON; the chain is corrupt`); }
    if (record?.v !== JOURNAL_SCHEMA_VERSION) throw new JournalChainError(`journal record ${expectedSeq} has an unsupported schema version`);
    if (record.seq !== expectedSeq) throw new JournalChainError(`journal sequence broke at record ${expectedSeq}; the chain is not append-only`);
    if (record.prev !== previous) throw new JournalChainError(`journal record ${expectedSeq} does not chain to its predecessor`);
    if (String(record.run_id) !== String(runId) || String(record.attempt) !== String(attempt)) {
      throw new JournalChainError(`journal record ${expectedSeq} belongs to a different run or attempt`);
    }
    records.push(record);
    previous = digestOf(line);
    expectedSeq += 1;
  }
  return records;
}

/**
 * Open the journal for appending under a held lock.
 *
 * `source` binds the chain to the immutable commissioning source (the trusted workflow SHA); a
 * record written under a different source is a different run's evidence wearing this run's name.
 */
export function openJournal({ dir, runId, attempt, source, lock, now = () => new Date() }) {
  assertRunIdentity(runId, attempt);
  const root = assertPrivateDirectory(dir);
  if (!lock?.nonce) throw new JournalRefusalError("journal writes require a held run-scoped lock");
  const file = journalPath(root, runId, attempt);
  let records = readJournal({ dir: root, runId, attempt });
  // Chain from the file's OWN BYTES, never from a re-serialization of the parsed record: two
  // spellings of the same object hash differently, and a link computed from the wrong one would
  // make every later record fail verification for a reason nobody could find.
  let previous = GENESIS_DIGEST;
  if (records.length) {
    const lines = readFileSync(file, "utf8").slice(0, -1).split("\n");
    previous = digestOf(lines[lines.length - 1]);
  }
  let seq = records.length;

  function append(type, data) {
    if (!JOURNAL_EVENTS.includes(type)) throw new JournalRefusalError(`unknown journal event type ${type}`);
    const held = readLockOwner(root, runId, attempt);
    if (held?.nonce !== lock.nonce) throw new JournalRefusalError("this writer no longer holds the run-scoped journal lock");
    assertNoCredentialShapedValues(data, type);
    assertRegularOrAbsent(file);
    seq += 1;
    const record = {
      v: JOURNAL_SCHEMA_VERSION, seq, run_id: String(runId), attempt: String(attempt),
      source: String(source ?? "unknown"), prev: previous, ts: now().toISOString(), type,
      data: data === undefined ? null : data,
    };
    const line = JSON.stringify(record);
    const fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, `${line}\n`);
      // Durability before the next step, not at process exit: an intent that is not on disk before
      // the request leaves is an intent that a crash erases while the mutation still happened.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    previous = digestOf(line);
    records = [...records, record];
    return record;
  }

  return {
    path: file,
    append,
    read: () => readJournal({ dir: root, runId, attempt }),
    get length() { return seq; },
  };
}

/**
 * An atomic, mode-0600 DERIVED view of a verified chain. Regenerating it is always safe because it
 * is never the evidence — `readJournal` is.
 */
export function writeJournalSnapshot({ dir, runId, attempt, snapshot }) {
  const root = assertPrivateDirectory(dir);
  assertNoCredentialShapedValues(snapshot, "snapshot");
  const target = snapshotPath(root, runId, attempt);
  assertRegularOrAbsent(target);
  const temporary = `${target}.tmp`;
  assertRegularOrAbsent(temporary);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  return target;
}
