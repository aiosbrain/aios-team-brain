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
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { PROBE_INTENT_PAIRS, PROBE_JOURNAL_EVENT_TYPES, RESOURCE_LINK_EVENT, SOURCE_OBSERVED_EVENT, assertProbeEventPayload, checkProbeJournalShape, parseProbeIntent, readDescriptor } from "./offbranch-probe.mjs";

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
  /**
   * The provider's OWN representation of a resource, measured by a readback AFTER the create was
   * journaled. It is a separate event because the create and the fingerprint are separate fallible
   * steps: a POST that returns 201 and a GET that then returns 503 leaves a resource that exists,
   * is owned, and has no measured fingerprint — and collapsing the two into one record is exactly
   * how that resource became unaccountable (F5).
   */
  "resource-fingerprinted",
  "case-outcome",
  "cleanup-intent",
  "cleanup-result",
  /** A readback, without a mutation, proved an owned resource absent or a pull request closed. */
  "resource-retired",
  /**
   * The bounded outcome of reconciling an intent whose result was lost. Distinct from `recovery`,
   * which is about a LOCK: this is about a MUTATION whose response never arrived, and it is what
   * must exist before anything decides to create or delete on that intent's behalf.
   */
  "reconciliation",
  "recovery",
  /**
   * The digest of the PRIVATE production input/subject file (PC-04), bound into the chain before any
   * disposable mutation. It is the anchor that makes the offline reconstruction authoritative: a file
   * swapped after the fact no longer matches the hash-linked record that named it.
   */
  "production-inputs-bound",
  /**
   * PC-06's staged off-branch probe, LINKED into this original attempt before its ref exists: the
   * probe intent's basename and digest plus the probe journal it owns. The one cross-run bridge,
   * and it points forward only — a probe cannot attach itself to an attempt that never staged it.
   */
  RESOURCE_LINK_EVENT,
  /**
   * A MEASURED LIVE SOURCE observed by a phase that has no probe journal to write it into yet
   * (R06-F3). PC-06's staging phase measures the live head before anything is staged; when that
   * head has moved, the refusal must leave a durable trace, or restoring staging lets the very same
   * attempt stage later as though the move had never been seen. This original attempt's own
   * hash-chained journal is the trusted bound history available at that moment — nothing is
   * fabricated to hold it, and a journal already closed is never reopened to log it.
   */
  SOURCE_OBSERVED_EVENT,
  "run-closed",
]);

/**
 * The SEPARATE witness journal's closed event set (F1).
 *
 * The local witness process is read-only with respect to provider resources, so it must not share the
 * resource journal's exclusive lock — a witness running concurrently with `human-tests` would
 * otherwise deadlock against it. It keeps its own chain, under its own lock, and the two are
 * cross-checked at final assessment because both bind the same immutable source and manifest.
 */
export const WITNESS_JOURNAL_EVENTS = Object.freeze([
  "witness-opened",
  "challenge-observed",
  "dispatch-intent",
  "dispatch-result",
  "response-reconciled",
  "reconciliation",
  "witness-closed",
]);

/** The two chains this module can carry, and the event vocabulary each admits. */
export const JOURNAL_KINDS = Object.freeze({
  resource: Object.freeze({ suffix: "", events: JOURNAL_EVENTS }),
  witness: Object.freeze({ suffix: ".witness", events: WITNESS_JOURNAL_EVENTS }),
  // The staged off-branch probe's OWN ownership chain, under its own lock: create-once ref, one
  // dispatch, run identity, captures, cancellation and exact-SHA cleanup. Its payloads are closed
  // per event in `offbranch-probe.mjs`; this vocabulary is the same list, imported, not retyped.
  probe: Object.freeze({ suffix: ".probe", events: PROBE_JOURNAL_EVENT_TYPES }),
});

function assertJournalKind(kind) {
  const spec = JOURNAL_KINDS[kind];
  if (!spec) throw new JournalRefusalError(`unknown commissioning journal kind ${JSON.stringify(String(kind))}`);
  return spec;
}

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

const baseName = (runId, attempt, kind = "resource") => `commissioning-${runId}-${attempt}${assertJournalKind(kind).suffix}`;

export const journalPath = (dir, runId, attempt, kind = "resource") => path.join(dir, `${baseName(runId, attempt, kind)}.jsonl`);
export const lockPath = (dir, runId, attempt, kind = "resource") => path.join(dir, `${baseName(runId, attempt, kind)}.lock`);
export const snapshotPath = (dir, runId, attempt, kind = "resource") => path.join(dir, `${baseName(runId, attempt, kind)}.snapshot.json`);
/**
 * A SECOND lock, held only for the duration of a recovery.
 *
 * The run lock cannot serialise its own replacement: two recoveries both find the same stale owner,
 * both reconcile, and both then unlink the pathname — so the second deletes the lock the first just
 * acquired, and two writers proceed believing they own the run. This one is created `wx` before
 * anything is read and released only at the end, so exactly one recovery can be in flight.
 */
export const recoveryLockPath = (dir, runId, attempt, kind = "resource") => path.join(dir, `${baseName(runId, attempt, kind)}.recovery.lock`);

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
  dir, runId, attempt, kind = "resource", now = () => new Date(), pid = process.pid, host = hostname(),
  nonce = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32),
}) {
  assertRunIdentity(runId, attempt);
  assertJournalKind(kind);
  const root = assertPrivateDirectory(dir);
  const file = lockPath(root, runId, attempt, kind);
  assertRegularOrAbsent(file);
  const owner = { v: JOURNAL_SCHEMA_VERSION, run_id: String(runId), attempt: String(attempt), kind: String(kind), pid, host, nonce, acquired_at: now().toISOString() };
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new JournalLockedError(readLockOwner(root, runId, attempt, kind));
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
  } catch (error) {
    // A partial write may not contain a readable nonce. The exclusive file descriptor still
    // identifies our own creation; never remove a replacement at the same pathname.
    const created = fstatSync(fd);
    let current;
    try { current = lstatSync(file); } catch { /* already removed */ }
    if (current?.dev === created.dev && current?.ino === created.ino) unlinkSync(file);
    throw error;
  } finally {
    closeSync(fd);
  }
  return {
    ...owner,
    dir: root,
    release() {
      // Only the holder removes it, and only if the on-disk nonce still says so. A release that
      // deletes someone else's lock is the same bug as stealing it.
      const current = readLockOwner(root, runId, attempt, kind);
      if (current?.nonce !== nonce) return false;
      unlinkSync(file);
      return true;
    },
  };
}

export function readLockOwner(dir, runId, attempt, kind = "resource") {
  try {
    return JSON.parse(readFileSync(lockPath(dir, runId, attempt, kind), "utf8"));
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
export async function recoverJournalLock({ dir, runId, attempt, kind = "resource", ownerGone, reconcile, now = () => new Date() }) {
  assertRunIdentity(runId, attempt);
  assertJournalKind(kind);
  const root = assertPrivateDirectory(dir);
  const recoveryLock = recoveryLockPath(root, runId, attempt, kind);
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
  } catch (error) {
    unlinkSync(recoveryLock);
    throw error;
  } finally {
    closeSync(recoveryFd);
  }
  try {
    const owner = readLockOwner(root, runId, attempt, kind);
    if (!owner) throw new JournalRefusalError("there is no lock to recover for this run");
    if (ownerGone !== true) throw new JournalRefusalError("lock recovery requires explicit verification that the recorded owner is gone; elapsed time is not that verification");
    if (typeof reconcile !== "function") throw new JournalRefusalError("lock recovery requires a provider readback reconciliation");
    if (typeof owner.nonce !== "string" || !owner.nonce) throw new JournalRefusalError("the lock being recovered carries no owner nonce; it cannot be identified at replacement");
    const records = readJournal({ dir: root, runId, attempt, kind });

    // The unresolved mutation may be a CLEANUP one. Looking only at `mutation-*` omits an interrupted
    // ruleset or ref DELETE — the most consequential thing a crashed cleanup can leave behind, and
    // the one a resumed run most needs reconciled before it decides anything.
    // `dispatch-intent`/`dispatch-result` are the witness chain's counterparts: a lost witness
    // dispatch is exactly as unresolved as a lost ruleset create, and is reconciled the same way.
    const INTENTS = kind === "probe" ? Object.keys(PROBE_INTENT_PAIRS) : ["mutation-intent", "cleanup-intent", "dispatch-intent"];
    const RESULTS = kind === "probe" ? Object.values(PROBE_INTENT_PAIRS) : ["mutation-result", "cleanup-result", "dispatch-result"];
    const lastIntent = [...records].reverse().find((record) => INTENTS.includes(record.type));
    const lastResult = [...records].reverse().find((record) => kind === "probe" ? record.type === PROBE_INTENT_PAIRS[lastIntent?.type] : RESULTS.includes(record.type));
    const unresolved = lastIntent && (!lastResult || lastResult.seq < lastIntent.seq) ? lastIntent : null;
    let probeBinding = null;
    const reconciledIntents = [];
    if (kind === "probe") {
      checkProbeJournalShape(records);
      const opened = records[0];
      if (opened?.type !== "probe-opened" || records.some((record) => record.type === "probe-closed")) {
        throw new JournalRefusalError("only an open bound probe journal can recover its writer lock");
      }
      const resource = readJournal({ dir: root, runId, attempt });
      const links = resource.filter((record) => record.type === RESOURCE_LINK_EVENT);
      if (links.length !== 1 || links[0].data.intent_artifact !== opened.data.intent_artifact
        || links[0].data.intent_sha256 !== opened.data.intent_sha256
        || links[0].data.probe_journal !== path.basename(journalPath(root, runId, attempt, kind))) {
        throw new JournalRefusalError("probe recovery requires the exact original resource-journal link");
      }
      probeBinding = readDescriptor(root, { artifact: opened.data.intent_artifact, sha256: opened.data.intent_sha256 }, "the recovery probe intent");
      parseProbeIntent(probeBinding, { commissioning: probeBinding.commissioning });
      if (probeBinding.commissioning.run_id !== String(runId) || probeBinding.commissioning.attempt !== String(attempt)
        || opened.data.commissioning_run_id !== String(runId) || opened.data.commissioning_attempt !== String(attempt)
        || [...records, ...resource].some((record) => record.source !== probeBinding.commissioning.workflow_sha)) {
        throw new JournalRefusalError("probe recovery source/run/attempt binding differs from its original journal");
      }
      // Reconcile EVERY probe mutation, including results whose transport completed but whose
      // effect is ambiguous. The lock event never resolves these resource intents by assertion.
      for (const intent of records.filter((record) => PROBE_INTENT_PAIRS[record.type])) {
        const readback = await reconcile({ kind_of_intent: intent.type, intent_seq: intent.seq, ...intent.data });
        if (readback?.reconciled !== true) throw new JournalRefusalError("a probe mutation could not be reconciled by provider readback; the old lock is retained");
        reconciledIntents.push({ seq: intent.seq, type: intent.type });
      }
    }
    const reconciliation = kind === "probe" && reconciledIntents.length
      ? { reconciled: true }
      : await reconcile(unresolved ? { kind_of_intent: unresolved.type, ...unresolved.data } : null);
    if (reconciliation?.reconciled !== true) {
      throw new JournalRefusalError("the last recorded mutation could not be reconciled by provider readback; the run stays inconclusive");
    }

    // Re-read AFTER the await. If the lock is gone or is somebody else's, this recovery lost the race
    // and must not unlink: the file it would remove now belongs to a writer that believes it owns the
    // run, and removing it is how provider cleanup interleaves with that writer.
    const current = readLockOwner(root, runId, attempt, kind);
    if (!current) throw new JournalRefusalError("the lock this recovery started from was already released; re-check the run rather than replacing it");
    if (current.nonce !== owner.nonce) throw new JournalRefusalError("the lock was replaced while this recovery was reconciling; refusing to remove the new owner's lock");
    if (JSON.stringify(readJournal({ dir: root, runId, attempt, kind })) !== JSON.stringify(records)) {
      throw new JournalRefusalError("the journal changed while recovery was reconciling; the original lock is retained");
    }
    unlinkSync(lockPath(root, runId, attempt, kind));
    const lock = acquireJournalLock({ dir: root, runId, attempt, kind, now });
    try {
      const journal = openJournal({ dir: root, runId, attempt, kind, source: records[0]?.source ?? "unknown", lock, now });
      const replacedOwner = { pid: owner.pid, host: owner.host, acquired_at: owner.acquired_at };
      if (kind === "probe") {
        journal.append("lock-recovered", assertProbeEventPayload("lock-recovered", {
          replaced_owner: replacedOwner, intent_sha256: records[0].data.intent_sha256, reconciled_intents: reconciledIntents,
        }));
      } else {
        journal.append(kind === "witness" ? "reconciliation" : "recovery", {
          replaced_owner: replacedOwner,
          unresolved_intent_seq: unresolved?.seq ?? null,
          unresolved_intent_type: unresolved?.type ?? null,
          readback: reconciliation.readback ?? null,
        });
      }
      return { lock, journal, unresolvedIntent: unresolved?.data ?? null, unresolvedIntentType: unresolved?.type ?? null, readback: reconciliation.readback ?? null };
    } catch (error) {
      // Recovery owns this replacement; no append/open failure may strand it. A partial journal
      // write still fails chain verification on the next open, rather than becoming authority.
      lock.release();
      throw error;
    }
  } finally {
    try { unlinkSync(recoveryLock); } catch { /* a recovery that never created it has nothing to remove */ }
  }
}

/**
 * Read and VERIFY the whole chain. Every failure mode is a refusal, never a shortened list:
 * a partial trailing line (a crash mid-write), a broken `prev` link, a non-monotonic sequence, or
 * a record belonging to a different run.
 */
export function readJournal({ dir, runId, attempt, kind = "resource" }) {
  assertRunIdentity(runId, attempt);
  assertJournalKind(kind);
  const file = journalPath(dir, runId, attempt, kind);
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
    // A record from the OTHER chain read as this one's would let witness events be counted as
    // resource ownership, or the reverse. The two vocabularies are disjoint, but the binding is
    // explicit rather than left to that coincidence.
    if (record.kind !== undefined && String(record.kind) !== String(kind)) {
      throw new JournalChainError(`journal record ${expectedSeq} belongs to the ${String(record.kind)} chain, not the ${String(kind)} one`);
    }
    if (kind === "probe" && records.some((entry) => entry.type === "probe-closed")) {
      throw new JournalChainError("a closed probe journal has a later record; terminal history cannot reopen");
    }
    records.push(record);
    previous = digestOf(line);
    expectedSeq += 1;
  }
  return records;
}

const positiveIdentity = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/** The exact identity of one creation lifetime. Names and SHAs alone never acquire ownership. */
export function resourceLifecycleKey(data) {
  if (data?.kind === "ruleset") {
    const id = positiveIdentity(data.id);
    const name = typeof data.name === "string" && data.name ? data.name : null;
    return id !== null && name ? `ruleset:${id}:${name}` : null;
  }
  if (data?.kind === "ref") {
    return typeof data.ref === "string" && data.ref ? `ref:${data.ref}` : null;
  }
  if (data?.kind === "pull-request") {
    const number = positiveIdentity(data.number);
    return number !== null ? `pull-request:${number}` : null;
  }
  if (data?.kind === "commit") {
    const node = typeof data.node === "string" && data.node ? data.node : null;
    const sha = typeof data.sha === "string" && /^[0-9a-f]{40}$/.test(data.sha) ? data.sha : null;
    return node && sha ? `commit:${node}:${sha}` : null;
  }
  return null;
}

function lifecycleForEvent(resources, data) {
  if (data?.kind === "ruleset") {
    const id = positiveIdentity(data.id);
    const matches = [...resources.values()].filter((entry) => entry.kind === "ruleset" && positiveIdentity(entry.identity.id) === id);
    return matches.length === 1 ? matches[0] : null;
  }
  if (data?.kind === "ref") {
    const matches = [...resources.values()].filter((entry) => entry.kind === "ref" && entry.identity.ref === data.ref);
    return matches.length === 1 ? matches[0] : null;
  }
  if (data?.kind === "pull-request") {
    const number = positiveIdentity(data.number);
    const matches = [...resources.values()].filter((entry) => entry.kind === "pull-request" && positiveIdentity(entry.identity.number) === number);
    return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

/**
 * Reduce a verified RESOURCE-journal prefix into creation lifetimes.
 *
 * This deliberately does not require `run-closed`: setup and cleanup must read open prefixes while
 * recovering. Consumers that claim a final packet use `latestClosure` and the terminal states.
 */
export function reduceResourceLifecycles(records) {
  const resources = new Map();
  const errors = [];
  const closures = [];
  for (const record of records) {
    if (record?.kind !== undefined && record.kind !== "resource") continue;
    if (record.type === "resource-created") {
      const key = resourceLifecycleKey(record.data);
      if (!key) { errors.push(`resource-created record ${record.seq} has no exact lifecycle identity`); continue; }
      if (resources.has(key)) {
        errors.push(`resource-created record ${record.seq} attempts to reacquire existing lifetime ${key}`);
        continue;
      }
      resources.set(key, {
        key, kind: record.data.kind, identity: record.data, createdSeq: record.seq,
        state: record.data.kind === "commit" ? "inert" : "owned-active",
        pendingCleanup: null, terminalEvents: [], cleanupEvents: [], lastMaterialSeq: record.seq,
      });
      continue;
    }
    if (record.type === "cleanup-intent") {
      const lifetime = lifecycleForEvent(resources, record.data);
      if (!lifetime) { errors.push(`cleanup-intent record ${record.seq} names no exact creation lifetime`); continue; }
      if (record.data?.lifecycle_key !== lifetime.key) { errors.push(`cleanup-intent record ${record.seq} does not bind exact lifetime ${lifetime.key}`); continue; }
      if (["retired", "retired-reappeared"].includes(lifetime.state)) {
        errors.push(`cleanup-intent record ${record.seq} tries to mutate retired lifetime ${lifetime.key}`);
        continue;
      }
      if (lifetime.pendingCleanup) { errors.push(`cleanup-intent record ${record.seq} overlaps unresolved cleanup intent ${lifetime.pendingCleanup.seq}`); continue; }
      lifetime.pendingCleanup = { seq: record.seq, data: record.data };
      lifetime.state = "cleanup-pending";
      lifetime.cleanupEvents.push(record);
      lifetime.lastMaterialSeq = record.seq;
      continue;
    }
    if (record.type === "cleanup-result") {
      const lifetime = lifecycleForEvent(resources, record.data);
      if (!lifetime) { errors.push(`cleanup-result record ${record.seq} names no exact creation lifetime`); continue; }
      if (record.data?.lifecycle_key !== lifetime.key) { errors.push(`cleanup-result record ${record.seq} does not bind exact lifetime ${lifetime.key}`); continue; }
      if (!lifetime.pendingCleanup) { errors.push(`cleanup-result record ${record.seq} has no pending cleanup intent for ${lifetime.key}`); continue; }
      lifetime.cleanupEvents.push(record);
      lifetime.pendingCleanup = null;
      lifetime.lastMaterialSeq = record.seq;
      const retired = lifetime.kind === "ruleset"
        ? record.data?.removed === true && Number(record.data?.readback_status) === 404
        : lifetime.kind === "ref"
          ? record.data?.removed === true && record.data?.readback_absent === true && record.data?.readback_sha === null
          : record.data?.closed === true && Number(record.data?.readback_status) === 200 && record.data?.readback_state === "closed";
      lifetime.state = retired ? "retired" : "owned-active";
      if (retired) lifetime.terminalEvents.push(record);
      continue;
    }
    if (record.type === "reconciliation" && positiveIdentity(record.data?.cleanup_intent_seq) !== null) {
      const lifetime = lifecycleForEvent(resources, record.data);
      if (!lifetime || lifetime.pendingCleanup?.seq !== positiveIdentity(record.data.cleanup_intent_seq)) {
        errors.push(`cleanup reconciliation record ${record.seq} does not resolve its exact pending cleanup intent`);
        continue;
      }
      if (record.data?.lifecycle_key !== lifetime.key || record.data?.outcome !== "cleanup-still-present") {
        errors.push(`cleanup reconciliation record ${record.seq} does not carry the exact active lifetime readback`);
        continue;
      }
      lifetime.cleanupEvents.push(record);
      lifetime.pendingCleanup = null;
      lifetime.state = "owned-active";
      lifetime.lastMaterialSeq = record.seq;
      continue;
    }
    if (record.type === "reconciliation" && record.data?.outcome === "retired-resource-reappeared") {
      const lifetime = lifecycleForEvent(resources, record.data);
      const present = lifetime?.kind === "ruleset"
        ? Number(record.data?.readback_status) === 200
        : lifetime?.kind === "ref"
          ? typeof record.data?.readback_sha === "string" && /^[a-f0-9]{40}$/i.test(record.data.readback_sha)
          : Number(record.data?.readback_status) === 200 && record.data?.readback_state === "open";
      if (!lifetime || record.data?.lifecycle_key !== lifetime.key
        || !["retired", "retired-reappeared"].includes(lifetime.state) || !present) {
        errors.push(`reappearance record ${record.seq} does not bind a retired lifetime and present readback`);
        continue;
      }
      lifetime.state = "retired-reappeared";
      lifetime.cleanupEvents.push(record);
      lifetime.lastMaterialSeq = record.seq;
      continue;
    }
    if (record.type === "resource-retired") {
      const lifetime = lifecycleForEvent(resources, record.data);
      const allowed = lifetime?.kind === "pull-request"
        ? record.data?.reason === "confirmed-closed"
        : record.data?.reason === "confirmed-absent";
      if (!lifetime || !allowed || record.data?.lifecycle_key !== lifetime.key) { errors.push(`resource-retired record ${record.seq} has no exact truthful retirement identity`); continue; }
      if (lifetime.pendingCleanup && positiveIdentity(record.data?.cleanup_intent_seq) !== lifetime.pendingCleanup.seq) {
        errors.push(`resource-retired record ${record.seq} does not resolve the pending cleanup intent for ${lifetime.key}`);
        continue;
      }
      lifetime.pendingCleanup = null;
      lifetime.state = "retired";
      lifetime.terminalEvents.push(record);
      lifetime.lastMaterialSeq = record.seq;
      continue;
    }
    if (record.type === "run-closed") closures.push(record);
  }
  return {
    resources: [...resources.values()], errors, closures,
    latestClosure: closures.at(-1) ?? null,
  };
}

/**
 * Open the journal for appending under a held lock.
 *
 * `source` binds the chain to the immutable commissioning source (the trusted workflow SHA); a
 * record written under a different source is a different run's evidence wearing this run's name.
 */
export function openJournal({ dir, runId, attempt, source, lock, kind = "resource", now = () => new Date() }) {
  assertRunIdentity(runId, attempt);
  const spec = assertJournalKind(kind);
  const root = assertPrivateDirectory(dir);
  if (!lock?.nonce) throw new JournalRefusalError("journal writes require a held run-scoped lock");
  // A lock taken for the OTHER chain is not this chain's lock. Without this the witness process
  // could append to the resource journal under its own read-only lock — the exact coupling the
  // separate witness journal exists to prevent.
  if (lock.kind !== undefined && String(lock.kind) !== String(kind)) {
    throw new JournalRefusalError(`this writer holds the ${String(lock.kind)} journal lock, not the ${String(kind)} one`);
  }
  const file = journalPath(root, runId, attempt, kind);
  let records = readJournal({ dir: root, runId, attempt, kind });
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
    if (kind === "probe" && readJournal({ dir: root, runId, attempt, kind }).some((entry) => entry.type === "probe-closed")) {
      throw new JournalRefusalError("a closed probe journal cannot receive another event");
    }
    if (!spec.events.includes(type)) throw new JournalRefusalError(`unknown ${kind} journal event type ${type}`);
    const held = readLockOwner(root, runId, attempt, kind);
    if (held?.nonce !== lock.nonce) throw new JournalRefusalError("this writer no longer holds the run-scoped journal lock");
    assertNoCredentialShapedValues(data, type);
    assertRegularOrAbsent(file);
    seq += 1;
    const record = {
      v: JOURNAL_SCHEMA_VERSION, seq, run_id: String(runId), attempt: String(attempt), kind: String(kind),
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
    kind: String(kind),
    append,
    read: () => readJournal({ dir: root, runId, attempt, kind }),
    get length() { return seq; },
  };
}

/**
 * ── THE ONCE-ONLY WITNESS EVENT TRANSITION ──────────────────────────────────────────────────────
 *
 * The closed binding that decides whether two records describe THE SAME EVENT.
 *
 * Every field here is a retained challenge/dispatch/publication fact or an exact digest. A field
 * outside the list is never consulted for equality, and a field inside it may never differ.
 *
 * `polls`, `envelope_digest` and `recovered_pending_dispatch_seq` are deliberately OUTSIDE: they
 * describe THIS PROCESS'S ATTEMPT TO OBSERVE a publication, not the publication. A first pass that
 * dispatched holds an envelope digest; a later pass that finds the artifact already published holds
 * `null` — and it is nevertheless the same publication, because the expected artifact name, the
 * provider artifact ID, the publisher run and the entry digest are all the same. So they are
 * excluded from the equality test, and the transition returns the ORIGINAL record untouched rather
 * than merging, overwriting or appending. Exactly one record survives, and a genuinely different
 * publication under the same key still refuses.
 */
export const ONCE_ONLY_EVENT_BINDINGS = Object.freeze({
  "challenge-observed": Object.freeze(["case_id", "role", "direction", "artifact_id", "challenge_digest", "nonce_digest", "expires_at"]),
  "response-reconciled": Object.freeze(["case_id", "role", "direction", "expected_artifact", "artifact_id", "publisher_run_id", "entry_digest"]),
});

/**
 * Append a witness event AT MOST ONCE, or return the one already recorded, or refuse.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────────────────────────
 *
 * Four append sites wrote these events UNCONDITIONALLY: one `challenge-observed` on every serve of
 * an item, and one `response-reconciled` from each of three reconciliation paths. So any restarted
 * or re-entered witness process — an ordinary production event, since the whole point of the
 * pending-dispatch reconciliation is that the process can die and resume — appended a second copy
 * of an event that is once-only by contract. The final assessment counted them and refused, and the
 * wrong fix was to make the assessment count presence instead. This is the right one: the producer
 * makes the transition, and the assessment keeps requiring exactly one.
 *
 * Three outcomes and no fourth:
 *
 *  - nothing recorded for this key  → append once;
 *  - exactly one record whose complete closed binding is byte-identical → return THAT record,
 *    without appending;
 *  - a conflicting binding, or more than one matching record already in the chain → REFUSE.
 *
 * It performs no measurement, mints no nonce, restamps no timestamp and dispatches nothing. The
 * caller has already re-resolved the publication through the ordinary consumer path, so the original
 * challenge, its ORIGINAL expiry and the existing source and provenance rules have all been applied
 * before this is reached.
 */
export function recordWitnessEventOnce({ journal, type, data }) {
  const binding = ONCE_ONLY_EVENT_BINDINGS[String(type)];
  if (!binding) throw new JournalRefusalError(`${String(type)} is not a once-only witness event`);
  const caseId = String(data?.case_id ?? "");
  const direction = String(data?.direction ?? "");
  if (!caseId || !direction) throw new JournalRefusalError(`a ${type} record needs its case and direction to be recorded once-only`);
  const project = (value) => JSON.stringify(binding.map((field) => (value?.[field] === undefined ? null : value[field])));
  const wanted = project(data);
  const existing = journal.read().filter((record) => String(record.type) === String(type)
    && String(record.data?.case_id ?? "") === caseId
    && String(record.data?.direction ?? "") === direction);
  if (existing.length > 1) {
    throw new JournalRefusalError(
      `this witness journal already holds ${existing.length} ${type} records for ${caseId}:${direction}; a once-only event cannot be resolved from an ambiguous history`,
    );
  }
  if (existing.length === 1) {
    if (project(existing[0].data) !== wanted) {
      const conflicting = binding.filter((field) => JSON.stringify(existing[0].data?.[field] ?? null) !== JSON.stringify(data?.[field] ?? null));
      throw new JournalRefusalError(
        `this witness journal already holds a different ${type} for ${caseId}:${direction} (conflicting: ${conflicting.join(", ")}); commissioning refuses to record a second one`,
      );
    }
    // THE RETAINED RECORD, returned as it stands. Nothing is appended and nothing is rewritten.
    return { record: existing[0].data, appended: false, replayed: true };
  }
  journal.append(type, data);
  return { record: data, appended: true, replayed: false };
}

/**
 * An atomic, mode-0600 DERIVED view of a verified chain. Regenerating it is always safe because it
 * is never the evidence — `readJournal` is.
 */
export function writeJournalSnapshot({ dir, runId, attempt, snapshot, kind = "resource" }) {
  const root = assertPrivateDirectory(dir);
  assertJournalKind(kind);
  assertNoCredentialShapedValues(snapshot, "snapshot");
  const target = snapshotPath(root, runId, attempt, kind);
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
