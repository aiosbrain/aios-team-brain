import type { UnsanctionedEdge } from "@/lib/access/system-projects";

/**
 * AUDITFIX-25 — the bounded, typed evidence a FAILED per-team access bootstrap carries, and the one
 * labelled error string that travels with it.
 *
 * Pure and dependency-free on purpose (the `system-projects` import is type-only): the scheduler-side
 * producer (`lib/access/bootstrap.ts`) and the server-rendered consumer
 * (`components/admin/ingest-runs-panel.tsx`) share this ONE definition of the envelope, its budgets
 * and its validation, and neither may drag a database client into the other.
 *
 * WHAT THIS REPLACES. The outcome used to carry a single error in which a census finding REPLACED a
 * simultaneous convergence failure, built from a summary already clamped to 200 characters — so the
 * long-arm case could not even be expressed, and a failed ledger row had no structured half at all.
 *
 * WHAT IT IS NOT. Not an exhaustive export: the count is exact, the sample is at most sixteen findings
 * and the summary may end inside a name. `total`/`omitted` are the authoritative part. Not a detector
 * either — the census and the sanctioned-pair predicate stay where they are, and nothing here decides
 * what a finding IS.
 *
 * THE BUDGETS ARE PRESENTATION BUDGETS, measured in UTF-8 bytes of the text actually stored — never
 * in characters, and for the metadata never before JSON escaping (a control character is one byte raw
 * and six serialized). They are not database capacity estimates.
 */

export interface BootstrapPhaseError {
  message: string;
  /** True when `message` was shortened to fit its arm; the cut is also visible as a trailing `…`. */
  truncated: boolean;
}

/** One sampled finding. The UUIDs are exact; the slugs are DISPLAY labels (≤ 96 bytes, flagged when
 *  shortened) and are not repair-command arguments. */
export interface BootstrapEvidenceSample {
  projectId: string;
  groupId: string;
  projectSlug: string;
  groupSlug: string;
  projectSlugTruncated: boolean;
  groupSlugTruncated: boolean;
}

/** Version 1 of the envelope stored under `meta.accessBootstrapEvidence` on a failed team row. */
export interface AccessBootstrapEvidence {
  version: 1;
  teamId: string;
  /** A clean phase OMITS `error`; a failed one always carries it. */
  convergence: { status: "ok" | "failed"; error?: BootstrapPhaseError };
  /** `total` is the exact full finding count of a completed census (zero included) and `null` when
   *  the census could not be read — unavailable is never zero. */
  census: { status: "complete" | "failed"; total: number | null; error?: BootstrapPhaseError };
  sample: BootstrapEvidenceSample[];
  /** `total - sample.length`, or `null` beside an unavailable total. */
  omitted: number | null;
}

export type CapturedConvergence = { status: "ok" } | { status: "failed"; message: string };
export type CapturedCensus =
  | { status: "complete"; edges: readonly UnsanctionedEdge[] }
  | { status: "failed"; message: string };

/** The RAW phase results: full safe-extracted messages and the census's full finding list — never
 *  an already summarized, sampled or shortened form. Every bound is applied here. */
export interface BootstrapEvidenceInput {
  teamId: string;
  convergence: CapturedConvergence;
  census: CapturedCensus;
}

export type BuiltBootstrapEvidence = { ok: true } | { ok: false; error: string; evidence: AccessBootstrapEvidence };

export type BootstrapFailure = { kind: "returned"; result: unknown } | { kind: "thrown"; value: unknown };

const MAX_META_BYTES = 8192;
const MAX_SAMPLES = 16;
const MAX_SLUG_BYTES = 96;
const MAX_COMPOUND_BYTES = 480;
/** What each arm is guaranteed when BOTH phases fail — a long arm cannot erase the other's. */
const ARM_RESERVE_BYTES = 224;

const CENSUS_LABEL = "census: ";
const CONVERGENCE_LABEL = "convergence: ";
const ARM_SEPARATOR = "; ";
const ELLIPSIS = "…";
const REPLACEMENT = "�";

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** UTF-8 length without allocating; an isolated surrogate counts as the three bytes it encodes to. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

const ELLIPSIS_BYTES = utf8Bytes(ELLIPSIS);
const LONE_CENSUS_BYTES = MAX_COMPOUND_BYTES - utf8Bytes(CENSUS_LABEL);
const LONE_CONVERGENCE_BYTES = MAX_COMPOUND_BYTES - utf8Bytes(CONVERGENCE_LABEL);
const DUAL_POOL_BYTES = MAX_COMPOUND_BYTES - utf8Bytes(CENSUS_LABEL) - utf8Bytes(ARM_SEPARATOR) - utf8Bytes(CONVERGENCE_LABEL);

/**
 * NUL and ISOLATED surrogate code units become U+FFFD; a valid pair is preserved, and so is every
 * other character (controls, quotes and backslashes are escaped by JSON, not replaced). jsonb rejects
 * exactly those two, and the best-effort ledger writer swallows the failed insert — so without this a
 * hostile message does not produce an ugly row, it produces NO row.
 *
 * Throws on a non-string: a malformed input is a builder fault for the caller's guard, never text.
 */
function normalizeText(text: string): string {
  if (typeof text !== "string") throw new TypeError("bootstrap evidence text must be a string");
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      i += 1;
      continue;
    }
    if (unit === 0 || isHighSurrogate(unit) || isLowSurrogate(unit)) {
      out += text.slice(from, i) + REPLACEMENT;
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * Fit NORMALIZED text into `maxBytes`. Text that fits is returned whole and unflagged; otherwise the
 * result is the longest code-point prefix that fits TOGETHER WITH the cue, so the cue is inside the
 * budget and a surrogate pair is never halved. The cut stops at the first code point that does not
 * fit — it never skips ahead to a smaller one.
 */
function clipToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  const room = maxBytes - ELLIPSIS_BYTES;
  let used = 0;
  let end = 0;
  while (end < text.length) {
    const unit = text.charCodeAt(end);
    // Normalized input: a high surrogate here always leads a valid pair.
    const units = isHighSurrogate(unit) ? 2 : 1;
    const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : units === 2 ? 4 : 3;
    if (used + size > room) break;
    used += size;
    end += units;
  }
  return { text: text.slice(0, end) + ELLIPSIS, truncated: true };
}

/** A finding with every field normalized and NOTHING shortened — the unit the order is defined on. */
type Finding = { projectSlug: string; groupSlug: string; projectId: string; groupId: string };

/** Plain JavaScript string order (UTF-16 code units): locale-independent, so two runs are diffable. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const compareFindings = (a: Finding, b: Finding) =>
  compareText(a.projectSlug, b.projectSlug) ||
  compareText(a.groupSlug, b.groupSlug) ||
  compareText(a.projectId, b.projectId) ||
  compareText(a.groupId, b.groupId);

/**
 * The first sixteen findings by full normalized tuple, IDs breaking slug ties, whatever order the
 * census rows arrived in (the adapter orders only when asked). Findings are NOT deduplicated.
 *
 * A bounded insertion rather than `[...edges].sort()`: the kept window never exceeds seventeen
 * entries, so this adds no second whole-array copy on top of the list the census already
 * materialized. That is a statement about THIS function's storage — the census itself is unpaginated.
 * The caller's edges are only read.
 */
function firstFindings(edges: readonly UnsanctionedEdge[]): Finding[] {
  const kept: Finding[] = [];
  for (const edge of edges) {
    const finding: Finding = {
      projectSlug: normalizeText(edge.projectSlug),
      groupSlug: normalizeText(edge.groupSlug),
      projectId: normalizeText(edge.projectId),
      groupId: normalizeText(edge.groupId),
    };
    if (kept.length === MAX_SAMPLES && compareFindings(finding, kept[MAX_SAMPLES - 1]) >= 0) continue;
    let at = kept.length;
    while (at > 0 && compareFindings(finding, kept[at - 1]) < 0) at -= 1;
    kept.splice(at, 0, finding);
    if (kept.length > MAX_SAMPLES) kept.pop();
  }
  return kept;
}

function displaySample(finding: Finding): BootstrapEvidenceSample {
  const project = clipToBytes(finding.projectSlug, MAX_SLUG_BYTES);
  const group = clipToBytes(finding.groupSlug, MAX_SLUG_BYTES);
  return {
    projectId: finding.projectId,
    groupId: finding.groupId,
    projectSlug: project.text,
    groupSlug: group.text,
    projectSlugTruncated: project.truncated,
    groupSlugTruncated: group.truncated,
  };
}

/**
 * The message bytes each arm may occupy. A lone arm gets the whole compound minus its label. Two arms
 * each START at `min(full, 224)` — their reservation — and what is left of the 457-byte pool extends
 * the census toward its full length first, then convergence. So neither arm can consume the other's
 * guaranteed 224, and a short arm's unused reservation is not wasted (it is what lets a real adoption
 * refusal keep its repair suffix beside a one-edge census).
 */
function armBudgets(censusBytes: number | null, convergenceBytes: number | null): { census: number; convergence: number } {
  if (censusBytes === null || convergenceBytes === null) {
    return { census: LONE_CENSUS_BYTES, convergence: LONE_CONVERGENCE_BYTES };
  }
  let census = Math.min(censusBytes, ARM_RESERVE_BYTES);
  let convergence = Math.min(convergenceBytes, ARM_RESERVE_BYTES);
  let spare = DUAL_POOL_BYTES - census - convergence;
  const toCensus = Math.min(spare, censusBytes - census);
  census += toCensus;
  spare -= toCensus;
  convergence += Math.min(spare, convergenceBytes - convergence);
  return { census, convergence };
}

/** The measured wrapper is the WHOLE namespace object as the writer serializes it — key and braces
 *  included, after escaping — not the envelope alone and not its raw text. */
const serializedBytes = (evidence: AccessBootstrapEvidence) => utf8Bytes(JSON.stringify({ accessBootstrapEvidence: evidence }));

/**
 * Build the failed outcome's labelled error and its version-1 evidence from the RAW phase results.
 *
 * Wholly clean phases — convergence ok and a completed census with zero findings — return EXACTLY
 * `{ ok: true }`: a healthy team has no envelope and no placeholder keys.
 *
 * Otherwise the result carries `census: …; convergence: …` (census first, only the failing arms, at
 * most 480 bytes — inside the ledger writer's 500-character clamp, so that clamp never cuts it) and
 * evidence whose arm messages ARE the compound's arms. The census summary is the exact count head
 * plus the first ≤16 ordered FULL pairs, taken before any metadata trimming; it may end inside a
 * name and promises no complete list. Samples are then dropped from the END of the order until the
 * serialized namespace fits 8,192 bytes, `omitted` recomputed at each step.
 *
 * NOT GUARDED, deliberately: a malformed input throws. The caller owns that guard and its fixed
 * no-evidence fallback — catching here would hide a formatting fault behind a plausible envelope.
 */
export function buildBootstrapEvidence(input: BootstrapEvidenceInput): BuiltBootstrapEvidence {
  const convergenceFull = input.convergence.status === "failed" ? normalizeText(input.convergence.message) : null;

  let total: number | null = null;
  let censusFull: string | null = null;
  let findings: Finding[] = [];
  if (input.census.status === "failed") {
    censusFull = normalizeText(input.census.message);
  } else {
    total = input.census.edges.length;
    findings = firstFindings(input.census.edges);
    if (total > 0) {
      censusFull =
        `${total} unsanctioned edge(s) on system projects: ` +
        findings.map((f) => `${f.projectSlug}→${f.groupSlug}`).join(", ");
    }
  }
  if (convergenceFull === null && censusFull === null) return { ok: true };

  // An arm is only ever cut when its budget is at least a full reservation, so the count head (a few
  // dozen bytes) always survives the cut whole.
  const budgets = armBudgets(
    censusFull === null ? null : utf8Bytes(censusFull),
    convergenceFull === null ? null : utf8Bytes(convergenceFull)
  );
  const censusArm = censusFull === null ? null : clipToBytes(censusFull, budgets.census);
  const convergenceArm = convergenceFull === null ? null : clipToBytes(convergenceFull, budgets.convergence);

  const evidence: AccessBootstrapEvidence = {
    version: 1,
    teamId: normalizeText(input.teamId),
    convergence: convergenceArm
      ? { status: "failed", error: { message: convergenceArm.text, truncated: convergenceArm.truncated } }
      : { status: "ok" },
    census: censusArm
      ? { status: input.census.status, total, error: { message: censusArm.text, truncated: censusArm.truncated } }
      : { status: "complete", total },
    sample: findings.map(displaySample),
    omitted: total === null ? null : total - findings.length,
  };

  let size = serializedBytes(evidence);
  while (size > MAX_META_BYTES && evidence.sample.length > 0) {
    evidence.sample.pop();
    evidence.omitted = (total as number) - evidence.sample.length;
    size = serializedBytes(evidence);
  }
  // Unreachable with bounded arms and a UUID team id; if it ever is not, refuse to hand the writer
  // an over-budget payload rather than quietly exceeding the bound.
  if (size > MAX_META_BYTES) throw new Error("bootstrap evidence exceeds its metadata budget with an empty sample");

  const arms: string[] = [];
  if (censusArm) arms.push(CENSUS_LABEL + censusArm.text);
  if (convergenceArm) arms.push(CONVERGENCE_LABEL + convergenceArm.text);
  return { ok: false, error: arms.join(ARM_SEPARATOR), evidence };
}

/** The `error` of a returned collaborator result, when it is a nonempty string and reading it is safe. */
function returnedError(result: unknown): string | null {
  try {
    if (result === null || typeof result !== "object") return null;
    const error = (result as { error?: unknown }).error;
    return typeof error === "string" && error.length > 0 ? error : null;
  } catch {
    return null;
  }
}

/** The `message` of a thrown value, when the value is an Error and the message a nonempty string. */
function thrownMessage(value: unknown): string | null {
  try {
    if (!(value instanceof Error)) return null;
    const message: unknown = value.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

const CENSUS_ERROR_PREFIX = "system-edge census ";

/**
 * Turn one phase's failure into its FULL message — a nonempty string, never thrown from.
 *
 * It takes the WHOLE returned result or thrown value, not an already-read `.error`/`.message`: those
 * can be throwing accessors, and a read at the call site sits inside the per-team `catch`, where a
 * throw escapes the team's guard and aborts every remaining team. Only a string is ever used; a
 * missing, empty, non-string or faulting one becomes the phase's fixed fallback. Nothing is coerced —
 * no `String(value)`, no template, no JSON — and a thrown non-Error is never mined for `.message`.
 * An EMPTY message must not be passed through either: it is falsy, and used to turn a failed phase green.
 *
 * The census writer prefixes its own read failures, so ONE leading `system-edge census ` is stripped
 * from a returned census error (the compound's `census: ` label already says it). Bounding and
 * normalization are the builder's; this returns the message whole.
 */
export function extractBootstrapFailureMessage(phase: "convergence" | "census", failure: BootstrapFailure): string {
  if (failure.kind === "thrown") {
    const message = thrownMessage(failure.value) ?? "threw";
    return phase === "census" ? `system-edge census threw: ${message}` : message;
  }
  const error = returnedError(failure.result);
  if (phase === "convergence") return error ?? "unknown";
  if (error === null) return "failed";
  const reason = error.startsWith(CENSUS_ERROR_PREFIX) ? error.slice(CENSUS_ERROR_PREFIX.length) : error;
  return reason.length > 0 ? reason : "failed";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** `length` first: a string's UTF-8 size is at least its length, so an enormous one is refused unread. */
const fitsBytes = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" && value.length <= maxBytes && utf8Bytes(value) <= maxBytes;

function decodePhaseError(value: unknown): BootstrapPhaseError | null {
  if (!isRecord(value)) return null;
  const { message, truncated } = value;
  if (!fitsBytes(message, MAX_COMPOUND_BYTES) || typeof truncated !== "boolean") return null;
  return { message, truncated };
}

function decodeRow(row: { source: unknown; team_id: unknown; ok: unknown; meta: unknown }): AccessBootstrapEvidence | null {
  // Row identity first: evidence belongs only to a FAILED, team-owned `access_bootstrap` row. The
  // `team_id is null` rows are merged into every team's reader, so an envelope there is never shown.
  if (row.source !== "access_bootstrap" || row.ok !== false) return null;
  const rowTeamId = row.team_id;
  if (!isUuid(rowTeamId)) return null;

  let meta = row.meta;
  if (typeof meta === "string") {
    // A legacy JSON-string meta is bounded BEFORE it is parsed.
    if (!fitsBytes(meta, MAX_META_BYTES)) return null;
    meta = JSON.parse(meta);
  }
  if (!isRecord(meta)) return null;
  const envelope = meta.accessBootstrapEvidence;
  if (!isRecord(envelope)) return null;
  if (envelope.version !== 1 || envelope.teamId !== rowTeamId) return null;

  const convergence = envelope.convergence;
  if (!isRecord(convergence)) return null;
  let convergenceError: BootstrapPhaseError | null = null;
  if (convergence.status === "failed") {
    convergenceError = decodePhaseError(convergence.error);
    if (!convergenceError) return null;
  } else if (convergence.status !== "ok") return null;

  // Shape and LENGTH before any entry is read.
  const sample = envelope.sample;
  if (!Array.isArray(sample) || sample.length > MAX_SAMPLES) return null;

  const census = envelope.census;
  if (!isRecord(census)) return null;
  let censusStatus: "complete" | "failed";
  let total: number | null;
  let censusError: BootstrapPhaseError | null = null;
  if (census.status === "failed") {
    // Unavailable: no count, no omitted count, no samples — and always a named reason.
    if (census.total !== null || envelope.omitted !== null || sample.length !== 0) return null;
    censusStatus = "failed";
    total = null;
    censusError = decodePhaseError(census.error);
    if (!censusError) return null;
  } else if (census.status === "complete") {
    if (!isCount(census.total) || !isCount(envelope.omitted)) return null;
    if (envelope.omitted !== census.total - sample.length) return null;
    censusStatus = "complete";
    total = census.total;
    if (total > 0) {
      censusError = decodePhaseError(census.error);
      if (!censusError) return null;
    }
  } else return null;

  // The producer never emits an envelope for a wholly healthy state.
  if (!convergenceError && !censusError) return null;

  // The arms came out of one labelled compound of at most 480 bytes. The budget is CONTEXTUAL — the
  // untruncated source lengths are gone, so no fixed per-arm maximum can be reconstructed.
  if (convergenceError && censusError) {
    if (utf8Bytes(censusError.message) + utf8Bytes(convergenceError.message) > DUAL_POOL_BYTES) return null;
  } else if (censusError) {
    if (utf8Bytes(censusError.message) > LONE_CENSUS_BYTES) return null;
  } else if (convergenceError && utf8Bytes(convergenceError.message) > LONE_CONVERGENCE_BYTES) return null;

  const projected: BootstrapEvidenceSample[] = [];
  for (let i = 0; i < sample.length; i++) {
    const entry: unknown = sample[i];
    if (!isRecord(entry)) return null;
    const { projectId, groupId, projectSlug, groupSlug, projectSlugTruncated, groupSlugTruncated } = entry;
    if (!isUuid(projectId) || !isUuid(groupId)) return null;
    if (!fitsBytes(projectSlug, MAX_SLUG_BYTES) || !fitsBytes(groupSlug, MAX_SLUG_BYTES)) return null;
    if (typeof projectSlugTruncated !== "boolean" || typeof groupSlugTruncated !== "boolean") return null;
    projected.push({ projectId, groupId, projectSlug, groupSlug, projectSlugTruncated, groupSlugTruncated });
  }

  const evidence: AccessBootstrapEvidence = {
    version: 1,
    teamId: rowTeamId,
    convergence: convergenceError ? { status: "failed", error: convergenceError } : { status: "ok" },
    census: censusError ? { status: censusStatus, total, error: censusError } : { status: censusStatus, total },
    sample: projected,
    omitted: total === null ? null : total - projected.length,
  };
  // Measured on the PROJECTION — validated, bounded primitives only — so nothing unknown is ever
  // handed to the serializer.
  if (serializedBytes(evidence) > MAX_META_BYTES) return null;
  return evidence;
}

/**
 * Recognize a version-1 envelope on a ledger row, or return `null` — in which case the row keeps its
 * existing error presentation. Fail-closed throughout: a malformed, oversized, future-version,
 * healthy-shaped or team-mismatched envelope is not evidence, and neither is one on an ok row, a
 * `team_id is null` row or another source's row.
 *
 * The result is a FRESH projection of the known, validated fields. Unknown envelope, phase, error,
 * sample and sibling-meta properties are dropped without being read, measured or serialized, so
 * arbitrary failed-row metadata cannot reach the page through this path. `meta` may be an object or a
 * legacy JSON string. Validated here: types, UUIDs, status/count relationships and budgets — not the
 * summary grammar, and not equality with the row's stored error text.
 */
export function decodeBootstrapEvidence(row: {
  source: unknown;
  team_id: unknown;
  ok: unknown;
  meta: unknown;
}): AccessBootstrapEvidence | null {
  try {
    return decodeRow(row);
  } catch {
    // An unparseable legacy string, or a hostile accessor anywhere in the row.
    return null;
  }
}
