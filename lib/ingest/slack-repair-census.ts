import "server-only";

import { createHash } from "node:crypto";

import { lookupSlackAccount, type SlackAccountLookupStatus, type SlackAccountMapping } from "@/lib/identity/resolve";
import { canonicalSlackChannelIds } from "./slack-source-binding";
import { parseSlackItemPath, scopedSlackItemPath } from "./sources/slack-namespace";

/**
 * PURE classifier for the Slack repair census (AIO-1170).
 *
 * The census is a bounded, inactive, dry-run diagnostic over STORED Slack facts for one explicit
 * `{teamId, integrationId, channelId}`. This module performs no I/O: `slack-repair-census-read.ts`
 * gathers the facts on its own read-only transaction and hands them here to be classified. Nothing
 * in the application calls either module (`test/guards/slack-source-not-wired.test.ts`).
 *
 * Three rules shape everything below:
 *
 *  1. AN OBSERVATION IS NOT A CLAIM. The strongest conclusion is "observed at this database
 *     snapshot". A legacy path is at most a CANDIDATE: today's binding, a workspace written in
 *     frontmatter and a syntactically scoped path do not prove where a legacy item came from, so no
 *     classification here means "safe to migrate" and every target is labelled hypothetical.
 *  2. STORED IDS COMPARE BYTE-EXACT; PATH SEGMENTS COMPARE LOWER-CASED. Scoped paths are written
 *     lower-case while provider ids arrive upper-case, so a path segment is compared against the
 *     lower-cased requested id. A stored provider-id column is never folded: a case-only variant is
 *     a different identity, reported as a conflict rather than accepted as an alias.
 *  3. NOTHING STORED IS ECHOED UNVALIDATED. A malformed path is reported as a category, malformed
 *     metadata as a status, an author as a count. Free text from a row never reaches the report.
 *
 * It carries no writable capability: a later attended repair must re-read provenance, mappings,
 * locks and collisions inside its own writer transaction.
 */

export const SLACK_REPAIR_CENSUS_LIMITS = Object.freeze({
  defaultPageSize: 25,
  maxPageSize: 50,
  /** Peer id arrays return at most this many ids; one more qualifying peer proves overflow. */
  peerIdCap: 50,
  observationCap: 50,
  /** Live mapping candidates read per account before the account is reported as overflowed. */
  mappingCandidateCap: 50,
  statementTimeoutMs: 5000,
});

// ── request, scope and cursor ────────────────────────────────────────────────

export interface SlackRepairCensusScope {
  teamId: string;
  integrationId: string;
  channelId: string;
}

export interface SlackRepairCensusRequest {
  scope: SlackRepairCensusScope;
  /** Omission means `dry_run`. There is no other mode. */
  mode?: "dry_run";
  /** Default 25; a whole number from 1 to 50. */
  pageSize?: number;
  cursor?: string;
}

export interface SlackRepairCursorPosition {
  scopeFingerprint: string;
  lastItemId: string;
}

export interface ValidatedSlackRepairCensusRequest {
  scope: SlackRepairCensusScope;
  mode: "dry_run";
  pageSize: number;
  cursor: SlackRepairCursorPosition | null;
}

export type SlackRepairCensusInputCategory =
  | "invalid_request"
  | "invalid_scope"
  | "invalid_mode"
  | "invalid_page_size"
  | "invalid_cursor";

/**
 * A rejected request. The message is a STATIC category and no `cause` is attached: the rejected
 * value may be a token, a provider message or hostile text, and quoting it would copy it into the
 * throw, the stack and every log that records it.
 */
export class SlackRepairCensusInputError extends TypeError {
  readonly category: SlackRepairCensusInputCategory;

  constructor(category: SlackRepairCensusInputCategory) {
    super(`slack repair census: ${category}`);
    this.name = "SlackRepairCensusInputError";
    this.category = category;
  }
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANY_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The provider-id alphabet every Slack table and the path namespace share. */
const PROVIDER_ID = /^[A-Za-z0-9]+$/;
/** Far above any id Slack mints; it is what keeps an encoded cursor inside its size bound. */
const MAX_PROVIDER_ID_LENGTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_VERSION = 1;
const CURSOR_KEYS = ["v", "teamId", "integrationId", "channelId", "scopeFingerprint", "lastItemId"] as const;
const REQUEST_KEYS: readonly string[] = ["scope", "mode", "pageSize", "cursor"];
const SCOPE_KEYS: readonly string[] = ["teamId", "integrationId", "channelId"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROVIDER_ID_LENGTH && PROVIDER_ID.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function readScope(value: unknown): SlackRepairCensusScope {
  const invalid = (): SlackRepairCensusInputError => new SlackRepairCensusInputError("invalid_scope");
  if (!isPlainObject(value)) throw invalid();
  // No caller-supplied workspace, verdict or provenance: the scope is exactly these three ids.
  if (Object.keys(value).some((key) => !SCOPE_KEYS.includes(key))) throw invalid();
  const { teamId, integrationId, channelId } = value;
  if (typeof teamId !== "string" || !ANY_CASE_UUID.test(teamId)) throw invalid();
  if (typeof integrationId !== "string" || !ANY_CASE_UUID.test(integrationId)) throw invalid();
  if (!isProviderId(channelId)) throw invalid();
  // UUIDs are canonical lower case; a provider id keeps its bytes.
  return { teamId: teamId.toLowerCase(), integrationId: integrationId.toLowerCase(), channelId };
}

function cursorWire(scope: SlackRepairCensusScope, position: SlackRepairCursorPosition): string {
  const wire = {
    v: CURSOR_VERSION,
    teamId: scope.teamId,
    integrationId: scope.integrationId,
    channelId: scope.channelId,
    scopeFingerprint: position.scopeFingerprint,
    lastItemId: position.lastItemId,
  };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

/**
 * Cursor v1: the exact canonical scope, the scope fingerprint it was minted under and the last
 * scanned item id. It is a continuation LOCATOR — never an authorization token, a repair checkpoint
 * or proof of anything: the reader re-validates the scope on every invocation.
 */
export function encodeSlackRepairCursor(input: {
  scope: SlackRepairCensusScope;
  scopeFingerprint: string;
  lastItemId: string;
}): string {
  const { scope, scopeFingerprint, lastItemId } = input;
  if (
    !isCanonicalUuid(scope?.teamId) ||
    !isCanonicalUuid(scope?.integrationId) ||
    !isProviderId(scope?.channelId) ||
    typeof scopeFingerprint !== "string" ||
    !SHA256_HEX.test(scopeFingerprint) ||
    !isCanonicalUuid(lastItemId)
  ) {
    throw new SlackRepairCensusInputError("invalid_cursor");
  }
  const scopeOnly = { teamId: scope.teamId, integrationId: scope.integrationId, channelId: scope.channelId };
  return cursorWire(scopeOnly, { scopeFingerprint, lastItemId });
}

function readCursor(value: unknown, scope: SlackRepairCensusScope): SlackRepairCursorPosition {
  const invalid = (): SlackRepairCensusInputError => new SlackRepairCensusInputError("invalid_cursor");
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) throw invalid();
  if (!BASE64URL.test(value)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!isPlainObject(decoded)) throw invalid();
  const keys = Object.keys(decoded);
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) throw invalid();
  const { v, teamId, integrationId, channelId, scopeFingerprint, lastItemId } = decoded;
  if (v !== CURSOR_VERSION) throw invalid();
  if (!isCanonicalUuid(teamId) || !isCanonicalUuid(integrationId) || !isCanonicalUuid(lastItemId)) throw invalid();
  if (!isProviderId(channelId)) throw invalid();
  if (typeof scopeFingerprint !== "string" || !SHA256_HEX.test(scopeFingerprint)) throw invalid();
  // One spelling only: padding, whitespace, re-ordered or repeated keys all decode to a different wire.
  if (cursorWire({ teamId, integrationId, channelId }, { scopeFingerprint, lastItemId }) !== value) throw invalid();
  // A cursor minted for another scope — including a case variant of this channel — is not this scope's.
  if (teamId !== scope.teamId || integrationId !== scope.integrationId || channelId !== scope.channelId) {
    throw invalid();
  }
  return { scopeFingerprint, lastItemId };
}

/** Everything that can be refused without a database, refused before one is opened. */
export function validateSlackRepairCensusRequest(request: unknown): ValidatedSlackRepairCensusRequest {
  if (!isPlainObject(request)) throw new SlackRepairCensusInputError("invalid_request");
  // Totals, verdicts, provenance and mapping dispositions are outputs. None is an input.
  if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) {
    throw new SlackRepairCensusInputError("invalid_request");
  }
  const scope = readScope(request.scope);

  if (request.mode !== undefined && request.mode !== "dry_run") {
    throw new SlackRepairCensusInputError("invalid_mode");
  }

  let pageSize: number = SLACK_REPAIR_CENSUS_LIMITS.defaultPageSize;
  if (request.pageSize !== undefined) {
    const requested = request.pageSize;
    if (
      typeof requested !== "number" ||
      !Number.isSafeInteger(requested) ||
      requested < 1 ||
      requested > SLACK_REPAIR_CENSUS_LIMITS.maxPageSize
    ) {
      throw new SlackRepairCensusInputError("invalid_page_size");
    }
    pageSize = requested;
  }

  const cursor = request.cursor === undefined ? null : readCursor(request.cursor, scope);
  return { scope, mode: "dry_run", pageSize, cursor };
}

// ── scope fingerprint and availability ───────────────────────────────────────

export interface SlackRepairScopeFingerprintFacts {
  scope: SlackRepairCensusScope;
  integrationStatus: string;
  /** `integrations.updated_at` as UTC text with six fractional digits, formatted by PostgreSQL. */
  updatedAtUtcMicroseconds: string;
  /** The canonical CURRENT selection from `integrations.config`, never the binding's cached copy. */
  selectedChannelIds: readonly string[];
  bindingState: string;
  bindingWorkspaceId: string | null;
  bindingConfigRevision: string;
}

/**
 * SHA-256 over the UTF-8 JSON of the ordered v1 tuple. It changes on disable/enable, deselection, a
 * config edit (down to one microsecond of `updated_at`), a binding state change and a workspace
 * rotation — every change after which a traversal must not silently resume.
 */
export function slackRepairScopeFingerprint(facts: SlackRepairScopeFingerprintFacts): string {
  const selected = [...new Set(facts.selectedChannelIds)].sort();
  const tuple = [
    "v1",
    facts.scope.teamId,
    facts.scope.integrationId,
    facts.scope.channelId,
    facts.integrationStatus,
    facts.updatedAtUtcMicroseconds,
    selected,
    facts.bindingState,
    facts.bindingWorkspaceId,
    facts.bindingConfigRevision,
  ];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

/** The single `integrations` / `slack_integration_bindings` join row, as the reader projects it. */
export interface SlackRepairScopeRow {
  integrationType: string;
  integrationStatus: string;
  updatedAtUtcMicroseconds: string;
  /** `integrations.config->'channelIds'` only — no other part of the config is read. */
  configChannelIds: unknown;
  bindingState: string;
  bindingWorkspaceId: string | null;
  bindingConfigRevision: string;
}

export type SlackRepairScopeDecision =
  | {
      outcome: "available";
      scopeFingerprint: string;
      /** The STORED binding workspace. Its currency is not established by this slice. */
      bindingWorkspaceId: string;
      integrationStatus: "enabled" | "disabled";
    }
  | { outcome: "refused"; reason: "scope_unavailable" | "scope_changed" };

/**
 * Availability and cursor precedence, decided on every invocation:
 *
 *  • no joined Slack row → `scope_unavailable`, with or without a cursor (a non-Slack integration is
 *    not a joined Slack row, whatever else about it moved);
 *  • a joined row whose fingerprint differs from the cursor's → `scope_changed`, even when the move
 *    is what made it unavailable;
 *  • otherwise the scope must be available NOW: an unchanged fingerprint cannot resume a scope that
 *    is not verified, has no valid workspace or does not currently select the channel.
 *
 * A disabled integration is deliberately readable for historical diagnostics, and reported as
 * disabled. That is not permission to poll.
 */
export function decideSlackRepairScope(input: {
  scope: SlackRepairCensusScope;
  row: SlackRepairScopeRow | null;
  cursor: SlackRepairCursorPosition | null;
}): SlackRepairScopeDecision {
  const { scope, row, cursor } = input;
  const unavailable: SlackRepairScopeDecision = { outcome: "refused", reason: "scope_unavailable" };
  if (!row || row.integrationType !== "slack") return unavailable;

  const selected = canonicalSlackChannelIds({ channelIds: row.configChannelIds }).selected;
  const scopeFingerprint = slackRepairScopeFingerprint({
    scope,
    integrationStatus: row.integrationStatus,
    updatedAtUtcMicroseconds: row.updatedAtUtcMicroseconds,
    selectedChannelIds: selected,
    bindingState: row.bindingState,
    bindingWorkspaceId: row.bindingWorkspaceId,
    bindingConfigRevision: row.bindingConfigRevision,
  });
  if (cursor && cursor.scopeFingerprint !== scopeFingerprint) return { outcome: "refused", reason: "scope_changed" };

  const status = row.integrationStatus;
  if (status !== "enabled" && status !== "disabled") return unavailable;
  if (row.bindingState !== "verified") return unavailable;
  const workspace = row.bindingWorkspaceId;
  if (!isProviderId(workspace)) return unavailable;
  // Byte-exact against the current selection: a case variant of a selected channel is not selected.
  if (!selected.includes(scope.channelId)) return unavailable;
  return { outcome: "available", scopeFingerprint, bindingWorkspaceId: workspace, integrationStatus: status };
}

// ── relationship classification ──────────────────────────────────────────────

export type SlackRepairRelationship =
  | "channel_candidate"
  | "scoped_channel_match"
  | "unresolved_channel"
  | "conflicting_evidence";

export type SlackRepairEvidenceLabel =
  | "legacy_path_segment"
  | "scoped_path_segments"
  | "retained_channel_metadata"
  | "source_ledger"
  | "channel_state";

export type SlackRepairProvenance = "unproven" | "conflicting" | "scoped_ledger_observed";

export type SlackRepairPathObservation =
  | { kind: "legacy"; channelSegment: string; rootTs: string }
  | { kind: "scoped"; workspaceSegment: string; channelSegment: string; rootTs: string }
  | { kind: "malformed"; category: "unparseable_slack_path" };

export type SlackRepairChannelMetadataStatus = "absent" | "valid" | "malformed";

export interface SlackRepairHypotheticalTarget {
  hypothetical: true;
  workspace: "stored_binding_workspace";
  path: string;
}

/** The exact stored source identity of some of an item's ledger rows. */
export interface SlackRepairLedgerSourceIdentity {
  workspaceId: string;
  channelId: string;
}

export interface SlackRepairRelationshipFacts {
  scope: SlackRepairCensusScope;
  bindingWorkspaceId: string;
  path: unknown;
  /** A narrow frontmatter projection. Only `channel_id` is read here. */
  frontmatter: unknown;
  ledgerSources: readonly SlackRepairLedgerSourceIdentity[];
}

export interface SlackRepairRelationshipResult {
  bucket: "entry" | "unrelated" | "other_workspace";
  /** Null unless the row is an entry. */
  relationship: SlackRepairRelationship | null;
  path: SlackRepairPathObservation;
  evidence: SlackRepairEvidenceLabel[];
  provenance: SlackRepairProvenance;
  retainedChannelMetadata: SlackRepairChannelMetadataStatus;
  hypotheticalTarget: SlackRepairHypotheticalTarget | null;
  /** Fails the gate producer's exact path rule. An overlapping diagnostic, not a bucket. */
  gateNoncanonical: boolean;
  /** The scoped path's workspace segment, when this row is an other-workspace observation. */
  otherWorkspaceId: string | null;
}

/** The existing new-channel gate producer's path rule, byte for byte. */
const GATE_CANONICAL_PATH = /^slack\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[0-9]+[.][0-9]{6}[.]md$/;

const EVIDENCE_ORDER: readonly SlackRepairEvidenceLabel[] = [
  "legacy_path_segment",
  "scoped_path_segments",
  "retained_channel_metadata",
  "source_ledger",
  "channel_state",
];

function readChannelMetadata(frontmatter: unknown): { status: SlackRepairChannelMetadataStatus; value: string | null } {
  if (!isPlainObject(frontmatter)) return { status: "absent", value: null };
  const stored = frontmatter.channel_id;
  if (stored === undefined || stored === null) return { status: "absent", value: null };
  // Present but not a provider id: flagged, never trusted and never treated as proof of exclusion.
  if (!isProviderId(stored)) return { status: "malformed", value: null };
  return { status: "valid", value: stored };
}

/**
 * The deterministic relationship of one stored Slack item to the requested scope.
 *
 * Rules in order, with explicit contradictory ledger/metadata facts overriding an otherwise matching
 * classification to `conflicting_evidence`:
 *
 *  • scoped path, channel differs → unrelated, unless this item's own ledger or valid retained
 *    metadata names the requested source;
 *  • scoped path, channel and workspace match → `scoped_channel_match`;
 *  • scoped path, channel matches, workspace differs → an other-workspace observation only;
 *  • legacy path, segment equals the lower-cased requested channel → `channel_candidate`;
 *  • legacy path, segment differs, valid retained metadata exactly matches → `channel_candidate`;
 *  • legacy path, segment equals a DIFFERENT valid retained channel id, lower-cased → unrelated;
 *  • every other legacy or unparseable Slack item → `unresolved_channel`.
 *
 * A path that does not parse is never repaired into one that does.
 */
export function classifySlackRepairRelationship(input: SlackRepairRelationshipFacts): SlackRepairRelationshipResult {
  const { scope, bindingWorkspaceId } = input;
  const path = typeof input.path === "string" ? input.path : "";
  const parsed = parseSlackItemPath(path);
  const gateNoncanonical = !GATE_CANONICAL_PATH.test(path);
  const metadata = readChannelMetadata(input.frontmatter);
  const metadataMatches = metadata.status === "valid" && metadata.value === scope.channelId;
  const metadataDiffers = metadata.status === "valid" && metadata.value !== scope.channelId;

  // Stored ids compare byte-exact: `t1` is not `T1`, and a row carrying it is a different source.
  const fromRequestedSource = (source: SlackRepairLedgerSourceIdentity): boolean =>
    source.workspaceId === bindingWorkspaceId && source.channelId === scope.channelId;
  const ledgerRequested = input.ledgerSources.some(fromRequestedSource);
  const ledgerForeign = input.ledgerSources.some((source) => !fromRequestedSource(source));

  const observedPath: SlackRepairPathObservation = !parsed
    ? { kind: "malformed", category: "unparseable_slack_path" }
    : parsed.kind === "legacy"
      ? { kind: "legacy", channelSegment: parsed.channelSegment, rootTs: parsed.rootTs }
      : {
          kind: "scoped",
          workspaceSegment: parsed.workspaceSegment,
          channelSegment: parsed.channelSegment,
          rootTs: parsed.rootTs,
        };

  const base = {
    path: observedPath,
    retainedChannelMetadata: metadata.status,
    gateNoncanonical,
    otherWorkspaceId: null,
  };
  const notAnEntry = (bucket: "unrelated" | "other_workspace", otherWorkspaceId: string | null) => ({
    ...base,
    bucket,
    relationship: null,
    evidence: [],
    provenance: "unproven" as const,
    hypotheticalTarget: null,
    otherWorkspaceId,
  });
  const entry = (
    relationship: SlackRepairRelationship,
    labels: readonly (SlackRepairEvidenceLabel | false)[],
    provenance: SlackRepairProvenance = relationship === "conflicting_evidence" ? "conflicting" : "unproven"
  ): SlackRepairRelationshipResult => {
    const present = new Set(labels.filter((label): label is SlackRepairEvidenceLabel => label !== false));
    let hypotheticalTarget: SlackRepairHypotheticalTarget | null = null;
    if (relationship === "channel_candidate" && parsed?.kind === "legacy") {
      // Where this item WOULD live under the stored binding workspace. Being able to name the path
      // is not evidence that the item belongs there.
      hypotheticalTarget = {
        hypothetical: true,
        workspace: "stored_binding_workspace",
        path: scopedSlackItemPath(bindingWorkspaceId, scope.channelId, parsed.rootTs),
      };
    }
    return {
      ...base,
      bucket: "entry",
      relationship,
      evidence: EVIDENCE_ORDER.filter((label) => present.has(label)),
      provenance,
      hypotheticalTarget,
    };
  };
  const ledgerLabel = ledgerRequested && "source_ledger";
  const metadataLabel = metadataMatches && "retained_channel_metadata";

  if (!parsed) return entry("unresolved_channel", [ledgerLabel]);

  if (parsed.kind === "scoped") {
    const channelMatches = parsed.channelSegment.toLowerCase() === scope.channelId.toLowerCase();
    const workspaceMatches = parsed.workspaceSegment.toLowerCase() === bindingWorkspaceId.toLowerCase();
    if (!channelMatches) {
      if (ledgerRequested || metadataMatches) return entry("conflicting_evidence", [metadataLabel, ledgerLabel]);
      return notAnEntry("unrelated", null);
    }
    if (!workspaceMatches) {
      // Another workspace's copy of this raw channel is ambiguity evidence, never a requested-workspace
      // count — unless this item's own ledger says the requested source wrote it.
      if (ledgerRequested) return entry("conflicting_evidence", [metadataLabel, ledgerLabel]);
      return notAnEntry("other_workspace", parsed.workspaceSegment);
    }
    const labels: readonly (SlackRepairEvidenceLabel | false)[] = ["scoped_path_segments", metadataLabel, ledgerLabel];
    if (ledgerForeign || metadataDiffers) return entry("conflicting_evidence", labels);
    // Reports ledger facts. It is not migration authority.
    return entry("scoped_channel_match", labels, ledgerRequested ? "scoped_ledger_observed" : "unproven");
  }

  // Legacy three-segment path: the segment is a string that was on disk — a channel id or an old
  // display-name slug, indistinguishable here. A match is a candidate and stays unproven.
  const segmentMatches = parsed.channelSegment === scope.channelId.toLowerCase();
  if (segmentMatches) {
    const labels: readonly (SlackRepairEvidenceLabel | false)[] = ["legacy_path_segment", metadataLabel, ledgerLabel];
    return entry(metadataDiffers || ledgerForeign ? "conflicting_evidence" : "channel_candidate", labels);
  }
  if (metadataMatches) {
    return entry(ledgerForeign ? "conflicting_evidence" : "channel_candidate", [metadataLabel, ledgerLabel]);
  }
  if (metadataDiffers && metadata.value !== null && parsed.channelSegment === metadata.value.toLowerCase()) {
    // Path and retained metadata agree on a different channel.
    if (ledgerRequested) return entry("conflicting_evidence", [ledgerLabel]);
    return notAnEntry("unrelated", null);
  }
  return entry("unresolved_channel", [ledgerLabel]);
}

// ── entries ──────────────────────────────────────────────────────────────────

export type SlackRepairCorrectionLock = "unlocked" | "locked_with_owner" | "locked_no_owner";

export type SlackRepairParticipantsStatus = "absent" | "present_empty" | "present_valid" | "present_malformed";

export interface SlackRepairParticipantsObservation {
  status: SlackRepairParticipantsStatus;
  validCount: number;
  /** The earliest and latest INDIVIDUALLY attested endpoints. Nothing between them is implied. */
  earliestAttestedTs: string | null;
  latestAttestedTs: string | null;
}

/** Decimal strings: the database counts are `bigint` and may exceed a safe JS integer. */
export interface SlackRepairLedgerObservation {
  present: boolean;
  totalMessages: string;
  eligibleNondeletedMessages: string;
  /** Excluded and deleted may overlap; they do not partition the total. */
  excludedMessages: string;
  deletedMessages: string;
  /** Exact distinct UTC days of eligible, non-deleted messages. Not a member-credit count. */
  eligibleNondeletedUtcDays: string;
  /** Rows of this item whose stored source is not the requested one, reported apart. */
  conflictingSourceMessages: string;
}

export type SlackRepairAuthorStatus = SlackAccountLookupStatus | "nonhuman_member" | "mapping_candidates_overflow";

export type SlackRepairPendingCategory =
  | "source_refetch_required"
  | "provenance_review_required"
  | "mapping_review_required"
  | "pending_queue_work"
  | "lock_exception";

export type SlackRepairQueueStatus = "not_applicable" | "not_observed" | "queued" | "running";

export interface SlackRepairCensusEntry {
  itemId: string;
  projectId: string;
  path: SlackRepairPathObservation;
  relationship: SlackRepairRelationship;
  evidence: SlackRepairEvidenceLabel[];
  provenance: SlackRepairProvenance;
  retainedChannelMetadata: SlackRepairChannelMetadataStatus;
  hypotheticalTarget: SlackRepairHypotheticalTarget | null;
  /** Same team AND project, excluding this item: the actual path uniqueness key. 0 or 1. */
  exactTargetItemId: string | null;
  /** Potential thread ambiguity in other projects. Never a uniqueness collision, never deduplicated. */
  sameThreadOtherProjectItemIds: string[];
  sameThreadOtherProjectItemIdsTruncated: boolean;
  /** Other legacy candidates in this project bound for the same hypothetical target. */
  sameProjectConvergingItemIds: string[];
  sameProjectConvergingItemIdsTruncated: boolean;
  correctionLock: SlackRepairCorrectionLock;
  participants: SlackRepairParticipantsObservation;
  ledger: SlackRepairLedgerObservation;
  authorMapping: Record<SlackRepairAuthorStatus, number>;
  queueStatus: SlackRepairQueueStatus;
  queueErrorObserved: boolean;
  pending: SlackRepairPendingCategory[];
}

export interface SlackRepairLedgerSourceFacts extends SlackRepairLedgerSourceIdentity {
  totalMessages: string;
  eligibleNondeletedMessages: string;
  excludedMessages: string;
  deletedMessages: string;
  eligibleNondeletedUtcDays: string;
}

/** Stored facts for ONE scanned item, gathered by the reader inside its page snapshot. */
export interface SlackRepairItemFacts {
  scope: SlackRepairCensusScope;
  bindingWorkspaceId: string;
  item: {
    id: string;
    projectId: string;
    path: unknown;
    frontmatter: unknown;
    memberId: string | null;
    memberIdLocked: boolean;
  };
  /** This item's ledger rows, aggregated per exact stored source identity. */
  ledgerSources: readonly SlackRepairLedgerSourceFacts[];
  /** One status per distinct observed author account. */
  authorStatuses: readonly string[];
  /** Items stored at this item's hypothetical target path (any project). */
  targetPathItems: readonly { itemId: string; projectId: string }[];
  /** Qualified by the reader; up to one more than the cap, so overflow is provable. */
  otherProjectSameThreadItemIds: readonly string[];
  sameProjectConvergingItemIds: readonly string[];
  /** A queue row for this exact scope and byte-exact root, or null when none was observed. */
  queue: { status: string; errorObserved: boolean } | null;
}

export interface SlackRepairWorkspaceObservation {
  kind: "channel_state" | "scanned_scoped_path";
  workspaceId: string;
  /** The channel-state row id or the scanned item id the observation came from. */
  sourceId: string;
}

export type SlackRepairItemClassification =
  | { bucket: "entry"; gateNoncanonical: boolean; entry: SlackRepairCensusEntry }
  | { bucket: "unrelated"; gateNoncanonical: boolean }
  | { bucket: "other_workspace"; gateNoncanonical: boolean; observation: SlackRepairWorkspaceObservation };

const AUTHOR_STATUSES: readonly SlackRepairAuthorStatus[] = [
  "resolved",
  "invalid_input",
  "no_mapping",
  "conflicting_mapping",
  "incomplete_provenance",
  "conflicting_provenance",
  "ambiguous_workspaces",
  "unknown_account",
  "unmapped_account",
  "mismatched_member",
  "unresolved_legacy_evidence",
  "nonhuman_member",
  "mapping_candidates_overflow",
];

const PENDING_ORDER: readonly SlackRepairPendingCategory[] = [
  "source_refetch_required",
  "provenance_review_required",
  "mapping_review_required",
  "pending_queue_work",
  "lock_exception",
];

const RELATIONSHIPS: readonly SlackRepairRelationship[] = [
  "channel_candidate",
  "scoped_channel_match",
  "unresolved_channel",
  "conflicting_evidence",
];

const DECIMAL = /^[0-9]{1,40}$/;

function decimal(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError("slack repair census: a ledger count is not a non-negative decimal string");
  }
  return value.replace(/^0+(?=[0-9])/, "");
}

/** Exact decimal-string addition: these are `bigint` counts and are never passed through a float. */
function addDecimal(left: string, right: string): string {
  let carry = 0;
  let sum = "";
  for (let l = left.length - 1, r = right.length - 1; l >= 0 || r >= 0 || carry > 0; l--, r--) {
    const digit = (l >= 0 ? left.charCodeAt(l) - 48 : 0) + (r >= 0 ? right.charCodeAt(r) - 48 : 0) + carry;
    sum = String(digit % 10) + sum;
    carry = digit >= 10 ? 1 : 0;
  }
  return sum === "" ? "0" : sum;
}

function observeLedger(
  facts: Pick<SlackRepairItemFacts, "scope" | "bindingWorkspaceId" | "ledgerSources">
): SlackRepairLedgerObservation {
  const ledger: SlackRepairLedgerObservation = {
    present: false,
    totalMessages: "0",
    eligibleNondeletedMessages: "0",
    excludedMessages: "0",
    deletedMessages: "0",
    eligibleNondeletedUtcDays: "0",
    conflictingSourceMessages: "0",
  };
  for (const source of facts.ledgerSources) {
    const total = decimal(source.totalMessages);
    if (source.workspaceId !== facts.bindingWorkspaceId || source.channelId !== facts.scope.channelId) {
      // Only rows consistent with the requested source enter its counts.
      ledger.conflictingSourceMessages = addDecimal(ledger.conflictingSourceMessages, total);
      continue;
    }
    ledger.totalMessages = addDecimal(ledger.totalMessages, total);
    ledger.eligibleNondeletedMessages = addDecimal(
      ledger.eligibleNondeletedMessages,
      decimal(source.eligibleNondeletedMessages)
    );
    ledger.excludedMessages = addDecimal(ledger.excludedMessages, decimal(source.excludedMessages));
    ledger.deletedMessages = addDecimal(ledger.deletedMessages, decimal(source.deletedMessages));
    ledger.eligibleNondeletedUtcDays = addDecimal(
      ledger.eligibleNondeletedUtcDays,
      decimal(source.eligibleNondeletedUtcDays)
    );
  }
  // Presence is independent of eligibility: a deleted-only or excluded-only ledger is still a ledger.
  ledger.present = ledger.totalMessages !== "0";
  return ledger;
}

const ISO_INSTANT = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:[.]([0-9]{1,6}))?Z$/;

interface AttestedInstant {
  text: string;
  milliseconds: number;
  microseconds: number;
}

function readInstant(value: unknown): AttestedInstant | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return { text: value, milliseconds, microseconds: Number((match[2] ?? "").padEnd(6, "0")) };
}

function earlier(left: AttestedInstant, right: AttestedInstant): boolean {
  return left.milliseconds !== right.milliseconds
    ? left.milliseconds < right.milliseconds
    : left.microseconds < right.microseconds;
}

/**
 * The retained `participants[]` metadata, as a status and two endpoints. Absent, empty, valid and
 * malformed stay distinct, and an endpoint pair is never expanded into the days between: this is
 * metadata somebody wrote, not a ledger of when anyone worked.
 */
function observeParticipants(frontmatter: unknown): SlackRepairParticipantsObservation {
  const none = { validCount: 0, earliestAttestedTs: null, latestAttestedTs: null };
  if (!isPlainObject(frontmatter) || !Object.prototype.hasOwnProperty.call(frontmatter, "participants")) {
    return { status: "absent", ...none };
  }
  const stored = frontmatter.participants;
  if (!Array.isArray(stored)) return { status: "present_malformed", ...none };
  if (stored.length === 0) return { status: "present_empty", ...none };

  let validCount = 0;
  let earliest: AttestedInstant | null = null;
  let latest: AttestedInstant | null = null;
  for (const participant of stored as unknown[]) {
    if (!isPlainObject(participant)) continue;
    const authorId = participant.author_id;
    if (typeof authorId !== "string" || authorId.trim() === "") continue;
    const endpoints: AttestedInstant[] = [];
    let wellFormed = true;
    for (const key of ["first_ts", "last_ts"] as const) {
      if (participant[key] === undefined) continue;
      const instant = readInstant(participant[key]);
      if (instant) endpoints.push(instant);
      else wellFormed = false;
    }
    if (!wellFormed) continue;
    validCount += 1;
    for (const instant of endpoints) {
      if (earliest === null || earlier(instant, earliest)) earliest = instant;
      if (latest === null || earlier(latest, instant)) latest = instant;
    }
  }
  return {
    status: validCount === stored.length ? "present_valid" : "present_malformed",
    validCount,
    earliestAttestedTs: earliest?.text ?? null,
    latestAttestedTs: latest?.text ?? null,
  };
}

function capPeerIds(ids: readonly string[], selfId: string): { ids: string[]; truncated: boolean } {
  const unique = [...new Set(ids)].filter((id) => id !== selfId).sort();
  const cap = SLACK_REPAIR_CENSUS_LIMITS.peerIdCap;
  return { ids: unique.slice(0, cap), truncated: unique.length > cap };
}

function tallyAuthors(statuses: readonly string[]): Record<SlackRepairAuthorStatus, number> {
  const tally = Object.fromEntries(AUTHOR_STATUSES.map((status) => [status, 0])) as Record<
    SlackRepairAuthorStatus,
    number
  >;
  for (const status of statuses) {
    // The taxonomy is closed. A status this module does not define is an error, not a new bucket.
    if (!AUTHOR_STATUSES.includes(status as SlackRepairAuthorStatus)) {
      throw new TypeError("slack repair census: an author status is outside the closed taxonomy");
    }
    tally[status as SlackRepairAuthorStatus] += 1;
  }
  return tally;
}

/**
 * One scanned row → exactly one bucket: an entry, an unrelated count, or an other-workspace
 * observation. A contradiction takes precedence and moves the row into entries, never both.
 */
export function classifySlackRepairItem(facts: SlackRepairItemFacts): SlackRepairItemClassification {
  const { scope, bindingWorkspaceId, item } = facts;
  const relation = classifySlackRepairRelationship({
    scope,
    bindingWorkspaceId,
    path: item.path,
    frontmatter: item.frontmatter,
    ledgerSources: facts.ledgerSources,
  });
  const { gateNoncanonical } = relation;
  const relationship = relation.relationship;
  if (relation.bucket !== "entry" || relationship === null) {
    if (relation.bucket === "other_workspace" && relation.otherWorkspaceId !== null) {
      return {
        bucket: "other_workspace",
        gateNoncanonical,
        observation: { kind: "scanned_scoped_path", workspaceId: relation.otherWorkspaceId, sourceId: item.id },
      };
    }
    return { bucket: "unrelated", gateNoncanonical };
  }

  const ledger = observeLedger(facts);
  const authorMapping = tallyAuthors(facts.authorStatuses);

  // The actual uniqueness key is (team, project, path): only a same-project occupant is a collision.
  // Another project's item at that path is potential thread ambiguity, reported separately.
  const target = relation.hypotheticalTarget;
  const occupants = target ? facts.targetPathItems.filter((other) => other.itemId !== item.id) : [];
  const exactTargetItemId = occupants.find((other) => other.projectId === item.projectId)?.itemId ?? null;
  const otherProject = capPeerIds(
    [
      ...facts.otherProjectSameThreadItemIds,
      ...occupants.filter((other) => other.projectId !== item.projectId).map((other) => other.itemId),
    ],
    item.id
  );
  const converging = capPeerIds(facts.sameProjectConvergingItemIds, item.id);

  // A null owner cannot distinguish an explicit clear from owner deletion (ON DELETE SET NULL), so
  // the stored state is reported and no cause is claimed.
  const correctionLock: SlackRepairCorrectionLock = !item.memberIdLocked
    ? "unlocked"
    : item.memberId
      ? "locked_with_owner"
      : "locked_no_owner";

  // The queue has no item key. A queue row may be associated only with a scoped match, by exact scope
  // and byte-exact root; a legacy item whose root merely equals a queued one gets no association.
  let queueStatus: SlackRepairQueueStatus = "not_applicable";
  let queueErrorObserved = false;
  if (relationship === "scoped_channel_match") {
    if (facts.queue === null) {
      // Absence is not completed hydration and not a complete ledger.
      queueStatus = "not_observed";
    } else {
      if (facts.queue.status !== "queued" && facts.queue.status !== "running") {
        throw new TypeError("slack repair census: a queue status is outside the stored codec");
      }
      queueStatus = facts.queue.status;
      queueErrorObserved = facts.queue.errorObserved === true;
    }
  }

  const pendingNow = new Set<SlackRepairPendingCategory>();
  // A legacy or unparseable entry has unknown hydration status; so does a scoped item with no ledger.
  // Neither ledger presence nor queue absence certifies that an item is complete.
  if (relation.path.kind !== "scoped" || !ledger.present) pendingNow.add("source_refetch_required");
  if (
    relation.path.kind !== "scoped" ||
    relationship === "conflicting_evidence" ||
    converging.ids.length > 0 ||
    converging.truncated
  ) {
    pendingNow.add("provenance_review_required");
  }
  if (AUTHOR_STATUSES.some((status) => status !== "resolved" && authorMapping[status] > 0)) {
    pendingNow.add("mapping_review_required");
  }
  if (queueStatus === "queued" || queueStatus === "running") pendingNow.add("pending_queue_work");
  if (correctionLock === "locked_no_owner") pendingNow.add("lock_exception");

  const entry: SlackRepairCensusEntry = {
    itemId: item.id,
    projectId: item.projectId,
    path: relation.path,
    relationship,
    evidence: relation.evidence,
    provenance: relation.provenance,
    retainedChannelMetadata: relation.retainedChannelMetadata,
    hypotheticalTarget: target,
    exactTargetItemId,
    sameThreadOtherProjectItemIds: otherProject.ids,
    sameThreadOtherProjectItemIdsTruncated: otherProject.truncated,
    sameProjectConvergingItemIds: converging.ids,
    sameProjectConvergingItemIdsTruncated: converging.truncated,
    correctionLock,
    participants: observeParticipants(item.frontmatter),
    ledger,
    authorMapping,
    queueStatus,
    queueErrorObserved,
    pending: PENDING_ORDER.filter((category) => pendingNow.has(category)),
  };
  return { bucket: "entry", gateNoncanonical, entry };
}

// ── author mapping diagnostics ───────────────────────────────────────────────

/** The existing account lookup's id-part syntax: Slack states these ids upper-case. */
const SLACK_ID_PART = /^[A-Z0-9]+$/;

export interface SlackRepairAuthorFacts {
  teamId: string;
  externalId: unknown;
  /** Where the id was observed: this item's source ledger, or its retained participant metadata. */
  origin: "source_ledger" | "participant_metadata";
  /** Supplied ONLY from a consistent source-ledger row of the item — never a binding or a path. */
  verifiedItemWorkspaceId?: string;
  /** Team-scoped live mapping candidates for this account, spelling variants included. */
  mappings: readonly SlackAccountMapping[];
  /** The bounded candidate read hit its limit: the candidates above are not known to be complete. */
  mappingCandidatesOverflow: boolean;
  /** Current human (non-connector) members among the candidates' members. */
  humanMemberIds: ReadonlySet<string> | readonly string[];
}

/**
 * One observed author account → one status of the closed taxonomy.
 *
 * A retained participant id is `incomplete_provenance` however qualified it looks, whatever is
 * mapped and whatever the current workspace is: nothing in this slice verifies where a legacy item
 * came from. A ledger author resolves only through the existing exact lookup, only when every
 * candidate was read, and only to a current human member. Spelling variants are collision evidence
 * (the lookup applies JS trim/case semantics), never aliases.
 */
export function classifySlackRepairAuthor(input: SlackRepairAuthorFacts): SlackRepairAuthorStatus {
  const { externalId } = input;
  if (typeof externalId !== "string") return "invalid_input";
  const parts = externalId.split(":");
  if (parts.length > 2 || parts.some((part) => !SLACK_ID_PART.test(part))) return "invalid_input";

  if (input.origin === "participant_metadata") return "incomplete_provenance";
  if (input.origin !== "source_ledger") {
    throw new TypeError("slack repair census: an author origin is outside the closed taxonomy");
  }
  const workspace = input.verifiedItemWorkspaceId;
  if (typeof workspace !== "string" || !SLACK_ID_PART.test(workspace)) return "incomplete_provenance";
  // Never resolve from a truncated candidate set, even when the exact row is among those read.
  if (input.mappingCandidatesOverflow) return "mapping_candidates_overflow";

  const result = lookupSlackAccount({
    teamId: input.teamId,
    externalId,
    verifiedItemWorkspaceId: workspace,
    mappings: input.mappings,
  });
  if (result.status !== "resolved") return result.status;
  const humans = new Set<string>(input.humanMemberIds);
  return result.memberId !== null && humans.has(result.memberId) ? "resolved" : "nonhuman_member";
}

// ── page counts and observations ─────────────────────────────────────────────

export interface SlackRepairPageCounts {
  /** All four relationships; they sum to the number of entries. */
  byRelationship: Record<SlackRepairRelationship, number>;
  /** Entries carrying each category, once each. These overlap and are not an item total. */
  byPendingCategory: Record<SlackRepairPendingCategory, number>;
  /** Both locked states. */
  lockedItems: number;
}

export function countSlackRepairEntries(entries: readonly SlackRepairCensusEntry[]): SlackRepairPageCounts {
  const byRelationship = Object.fromEntries(RELATIONSHIPS.map((name) => [name, 0])) as Record<
    SlackRepairRelationship,
    number
  >;
  const byPendingCategory = Object.fromEntries(PENDING_ORDER.map((name) => [name, 0])) as Record<
    SlackRepairPendingCategory,
    number
  >;
  let lockedItems = 0;
  for (const entry of entries) {
    byRelationship[entry.relationship] += 1;
    for (const category of new Set(entry.pending)) byPendingCategory[category] += 1;
    if (entry.correctionLock !== "unlocked") lockedItems += 1;
  }
  return { byRelationship, byPendingCategory, lockedItems };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Other-workspace observations for the raw channel, in one deterministic order (kind, workspace id,
 * source row) and capped. They cover channel-state rows and the scoped paths scanned on this page
 * ONLY: an empty, untruncated list is not an exhaustive workspace inventory.
 */
export function orderSlackRepairObservations(observations: readonly SlackRepairWorkspaceObservation[]): {
  observations: SlackRepairWorkspaceObservation[];
  truncated: boolean;
} {
  const ordered = observations
    .map(({ kind, workspaceId, sourceId }): SlackRepairWorkspaceObservation => {
      if (kind !== "channel_state" && kind !== "scanned_scoped_path") {
        throw new TypeError("slack repair census: an observation kind is outside the closed taxonomy");
      }
      return { kind, workspaceId, sourceId };
    })
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.workspaceId, right.workspaceId) ||
        compareText(left.sourceId, right.sourceId)
    );
  const cap = SLACK_REPAIR_CENSUS_LIMITS.observationCap;
  return { observations: ordered.slice(0, cap), truncated: ordered.length > cap };
}

// ── namespace gate observation ───────────────────────────────────────────────

/** A stored `slack_channel_migration_gates` row, bigints read as text so nothing is rounded. */
export interface SlackRepairGateRow {
  state: unknown;
  revision: unknown;
  ready_revision: unknown;
  resolved_workspace_ids: unknown;
  completed_repair_id: unknown;
  blocked_reason: unknown;
}

export type SlackRepairGateObservation =
  | { status: "absent" }
  | { status: "blocked"; revision: number; blockedReason: string | null }
  | {
      status: "ready";
      revision: number;
      readyRevision: number;
      resolvedWorkspaceIds: string[];
      completedRepairId: string;
    };

/** The sanitized blocking-category syntax the gate table itself enforces. */
const GATE_BLOCKED_REASON = /^[a-z][a-z0-9_]{0,39}$/;

function gateCounter(value: unknown): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]+$/.test(text)) {
    throw new TypeError("slack repair census: a stored gate revision is not a non-negative whole number");
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("slack repair census: a stored gate revision is not representable as a safe integer");
  }
  return parsed;
}

/**
 * The census owns this decoder because the gate module exports no plain reader. It mirrors that
 * module's ready/blocked codec: readiness is ALL of its evidence or none of it, so a corrupt or
 * incomplete row is an error rather than a quiet verdict, and absence stays absent. Messages are
 * static — a stored value that fails this codec is exactly the value not to quote. Reporting `ready`
 * is an observation; it changes no flag on the page and is not migration readiness.
 */
export function decodeSlackRepairGate(row: SlackRepairGateRow | null | undefined): SlackRepairGateObservation {
  if (row === null || row === undefined) return { status: "absent" };
  if (row.state !== "blocked" && row.state !== "ready") {
    throw new TypeError("slack repair census: a stored gate has an unknown state");
  }
  const revision = gateCounter(row.revision);
  const readyRevision = row.ready_revision === null ? null : gateCounter(row.ready_revision);
  if (!Array.isArray(row.resolved_workspace_ids)) {
    throw new TypeError("slack repair census: stored gate workspaces did not read back as an array");
  }
  const resolvedWorkspaceIds: string[] = [];
  for (const workspace of row.resolved_workspace_ids as unknown[]) {
    if (!isProviderId(workspace)) {
      throw new TypeError("slack repair census: a stored gate workspace is not a provider id");
    }
    resolvedWorkspaceIds.push(workspace);
  }
  let completedRepairId: string | null = null;
  if (row.completed_repair_id !== null) {
    const stored = row.completed_repair_id;
    if (typeof stored !== "string" || !ANY_CASE_UUID.test(stored)) {
      throw new TypeError("slack repair census: a stored gate repair id is not a UUID");
    }
    completedRepairId = stored;
  }
  let blockedReason: string | null = null;
  if (row.blocked_reason !== null) {
    const stored = row.blocked_reason;
    if (typeof stored !== "string" || !GATE_BLOCKED_REASON.test(stored)) {
      throw new TypeError("slack repair census: a stored gate blocking reason is not a sanitized category");
    }
    blockedReason = stored;
  }

  if (row.state === "ready") {
    if (
      readyRevision === null ||
      readyRevision !== revision ||
      resolvedWorkspaceIds.length === 0 ||
      completedRepairId === null ||
      blockedReason !== null
    ) {
      throw new TypeError("slack repair census: a stored gate claims ready without complete, current evidence");
    }
    return { status: "ready", revision, readyRevision, resolvedWorkspaceIds, completedRepairId };
  }
  if (readyRevision !== null || resolvedWorkspaceIds.length > 0 || completedRepairId !== null) {
    throw new TypeError("slack repair census: a stored gate is blocked but carries readiness evidence");
  }
  return { status: "blocked", revision, blockedReason };
}

// ── the page ─────────────────────────────────────────────────────────────────

/** Recorded source progress for the channel. Stored facts only: no provider was asked. */
export interface SlackRepairSourceObservation {
  channelState: "present" | "absent";
  publicState: string | null;
  publicCheckedAt: string | null;
  newestAnchorTs: string | null;
  historicalAnchorTs: string | null;
  /** Recorded coverage. It does not establish current retention, access or a live available range. */
  recordedCoverage: {
    completedLowerTs: string | null;
    completedUpperTs: string | null;
    historicalFloorReached: boolean | null;
    newestCatchupUpperTs: string | null;
  };
  /** Channel-level queue counts for the exact (team, stored binding workspace, channel). */
  threads: { queued: string; running: string; withError: string };
  providerAvailableRange: { status: "unknown_not_read" };
}

export type SlackRepairCensusResult =
  | { outcome: "refused"; mode: "dry_run"; reason: "scope_unavailable" | "scope_changed" }
  | {
      outcome: "page";
      mode: "dry_run";
      scope: SlackRepairCensusScope;
      consistency: "page_snapshot";
      historicalCensusComplete: false;
      applyReady: false;
      observedAt: string;
      scopeFingerprint: string;
      integrationStatus: "enabled" | "disabled";
      gateNoncanonicalItems: number;
      otherWorkspaceObservations: readonly SlackRepairWorkspaceObservation[];
      otherWorkspaceObservationsTruncated: boolean;
      scannedItems: number;
      unrelatedItems: number;
      otherWorkspaceItems: number;
      otherWorkspaceObservationSources: "channel_state_and_scanned_paths_only";
      bindingCurrency: "not_established";
      entries: readonly SlackRepairCensusEntry[];
      source: SlackRepairSourceObservation;
      namespaceGate: SlackRepairGateObservation;
      counts: SlackRepairPageCounts;
      nextCursor: string | null;
      traversalExhaustedAtThisSnapshot: boolean;
    };
