#!/usr/bin/env node
/**
 * H2: THE RESUMED BOOTSTRAP'S ORDERING, read back out of a captured importer log.
 *
 * The fix this checks is an ORDER, not a set of events: a resume must re-enter `draining` and
 * re-run `stopAndVerifyAll` BEFORE it takes the exclusive data-use lock. Three independent greps
 * cannot see that — they pass on a run that took the lock first and stopped afterwards, which is
 * exactly the regression (against a baseline an ordinary failure has restored, that run blocks on
 * the lock until its deadline and the bootstrap becomes unrecoverable by any supplied command).
 *
 * It lives in a file rather than inside `node -e` in the harness so the parser itself can be
 * exercised — a parser that matches nothing reports "no receipts", which is indistinguishable from
 * a run that emitted none, and would fail (or pass) the lane for the wrong reason forever.
 *
 * Identities and phase names only; the receipt bodies are redaction-checked where they are emitted.
 */

import { readFileSync } from "node:fs";
import { isDirectEntry } from "./direct-entry.mjs";

/** Every `bootstrap-phase` receipt in a captured log, in the order the importer emitted them. */
export function bootstrapPhases(text) {
  return [...String(text ?? "").matchAll(/staging-ops-receipt bootstrap-phase (\{.*\})/g)]
    .flatMap((match) => { try { return [JSON.parse(match[1])]; } catch { return []; } });
}

/**
 * @returns {{ok: boolean, reason: string|null, positions: Record<string, number>}}
 *   `ok` only when all four checkpoints are present AND in the required order. A missing checkpoint
 *   is a distinct failure from an out-of-order one, and both are reported as such — "we could not
 *   look" must never read as "it held".
 */
export function bootstrapResumeOrderVerdict(text) {
  const phases = bootstrapPhases(text);
  const at = (name, extra = () => true) => phases.findIndex((phase) => phase.phase === name && extra(phase));
  const positions = {
    draining: at("transition-draining", (phase) => phase.resumed === true),
    stopped: at("stop-and-verify-all", (phase) => phase.resumed === true),
    locked: at("acquire-exclusive-data-lock"),
    adopted: at("adopted-published-checkpoint"),
  };
  const described = Object.entries(positions).map(([name, index]) => `${name}=${index}`).join(" ");
  const missing = Object.entries(positions).filter(([, index]) => index < 0).map(([name]) => name);
  if (missing.length) return { ok: false, reason: `the retry never emitted ${missing.join(", ")} (${described})`, positions };
  const { draining, stopped, locked, adopted } = positions;
  if (!(draining < stopped && stopped < locked && locked < adopted)) {
    return { ok: false, reason: `the retry took the exclusive lock out of order (${described})`, positions };
  }
  return { ok: true, reason: null, positions };
}

// M2: THE ENTRY TEST ITSELF WAS A WAY TO PASS WITHOUT CHECKING ANYTHING.
//
// `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` compares the module's REAL path
// against the literal invocation path, and Node resolves a module's own path through symlinks — so
// an invocation through a symlinked path never matched, the block below never ran, and the process
// exited **0 having printed nothing**. The harness reads only the exit status, so that is
// indistinguishable from a verified ordering. Shared, symlink-and-encoding-safe test instead; a
// path that cannot be resolved still fails closed. Importing this module remains side-effect-free.
if (isDirectEntry(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("a captured importer log path is required"); process.exit(2); }
  const verdict = bootstrapResumeOrderVerdict(readFileSync(file, "utf8"));
  if (!verdict.ok) { console.error(verdict.reason); process.exit(1); }
  console.log("verified resume ordering: re-entered draining, re-verified the stop, THEN took the exclusive lock");
}
