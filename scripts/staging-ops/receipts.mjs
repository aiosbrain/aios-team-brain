/**
 * Structured, redacted RECEIPTS for the paired-refresh harness.
 *
 * Why these exist. The harness used to assert failure scenarios as `command exited non-zero` plus
 * `the prior data is still there` — and the prior data was already there before the scenario ran. A
 * preflight refusal, a container that never started, a discovery error and the fault the test is
 * actually about all satisfy that pattern identically. What was missing is a positive statement of
 * WHICH checkpoint was reached, tied to WHICH run, so a failure earlier than the intended one cannot
 * be mistaken for the intended one.
 *
 * A receipt is one line on stdout:
 *
 *     staging-ops-receipt <kind> {"runId":"run-4","point":"after-postgres",…}
 *
 * so it survives in the container log the harness already captures, needs no extra channel, and can
 * be asserted with `grep`. Receipts carry IDENTITIES and BOOLEANS only — run ids, checkpoint names,
 * store names, counts. `emitReceipt` refuses a field whose value looks like a credential rather than
 * trusting each call site to remember, because a receipt is written to an artifact directory that
 * outlives the harness root.
 */

export const RECEIPT_PREFIX = "staging-ops-receipt";

/** Field names whose values are never identities, whatever a caller believes. */
const FORBIDDEN_KEY = /(secret|token|password|passwd|credential|key|url|dsn|authorization)/i;

/** Values that look like a URL with credentials, a bearer token or a private key block. */
const FORBIDDEN_VALUE = [/:\/\/[^/\s:@]+:[^/\s@]+@/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+\S+/i];

/**
 * @param {string} kind one of a small closed vocabulary; the harness greps for these
 * @param {Record<string, string|number|boolean|null>} fields identities only
 */
export function emitReceipt(kind, fields = {}, { write = (line) => console.log(line) } = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (FORBIDDEN_KEY.test(name)) throw new Error(`receipt field ${name} could carry a credential; receipts record identities only`);
    if (typeof value === "string" && FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error(`receipt field ${name} carries a credential-shaped value`);
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`receipt field ${name} must be a scalar identity`);
    }
    safe[name] = value;
  }
  const line = `${RECEIPT_PREFIX} ${kind} ${JSON.stringify(safe)}`;
  write(line);
  return line;
}

/** Every receipt in a captured log, in order. Used by tests; the harness greps the same lines. */
export function parseReceipts(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = new RegExp(`^${RECEIPT_PREFIX} ([a-z-]+) (\\{.*\\})$`).exec(line.trim());
    if (!match) continue;
    try { out.push({ kind: match[1], fields: JSON.parse(match[2]) }); } catch { /* a truncated log line is not a receipt */ }
  }
  return out;
}
