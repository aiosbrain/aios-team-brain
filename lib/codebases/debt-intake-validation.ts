import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import findingSchema from '../../test/fixtures/contract/finding-observations.v1.schema.json';
import requestSchema from '../../test/fixtures/contract/debt-intake-events-v1.schema.json';

export type CandidateState = 'discovered' | 'verified' | 'duplicate' | 'rejected' | 'filed' | 'queue_eligible' | 'selected' | 'remediation_started' | 'merged' | 'resolved' | 'escaped' | 'reopened' | 'incomplete';
export interface LinearLink { type: 'linear'; team: string; number: number }
export interface FindingBase {
  schema_version: 'finding-observations.v1'; visibility_tier: 'team'; event_id: string;
  producer: { name: string; version: string; run_id: string };
  observed_at: string; evidence_status: 'complete' | 'incomplete' | 'unknown';
  attribution: { program_id: string; run_id: string; attempt: number; issue: LinearLink | null };
}
export interface CandidateRecord extends FindingBase {
  record_type: 'candidate'; candidate_id: string;
  identity: { version: 'discovery.v1'; producer_namespace: string; original_run_id: string; source_artifact_sha256: string; source_record_key: { kind: 'position'; value: number } | { kind: 'structural_sha256'; value: string } };
  codebases: string[];
  taxonomy: { severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown'; defect_class: 'logic' | 'security' | 'gate-integrity' | 'test-integrity' | 'verifiability' | 'contract-drift' | 'docs' | 'perf' | 'unknown'; determinism: 'deterministic' | 'flaky' | 'unverified' | 'unknown'; fences: string[] };
  state: CandidateState; disposition: 'open' | 'duplicate' | 'rejected' | 'resolved' | 'unknown'; sequence: number; predecessor_event_id: string | null; episode: number; duplicate_target: string | null;
  links: { linear: LinearLink | null; scanner: { type: 'scanner'; producer: string; finding_id: string } | null; pull_request: { type: 'pull_request'; codebase: string; number: number } | null; merge: { type: 'merge'; codebase: string; sha: string } | null; resolution: { type: 'resolution'; sha256: string } | null };
}
export interface RunSummaryRecord extends FindingBase {
  record_type: 'run_summary'; stage: 'discovery' | 'filing' | 'remediation' | 'resolution'; capture_status: 'complete' | 'partial' | 'unknown'; detector_completed: boolean | null; detector_evidence_sha256: string | null;
  counts: { raw_candidates: number | null; emitted_candidates: number | null; terminal_stage: number | null; incomplete: number | null; malformed: number | null }; emission_gap_reason: 'none' | 'malformed' | 'unknown';
}
export type FindingRecord = CandidateRecord | RunSummaryRecord;
export interface IntakeRequest { schema_version: 'debt-intake-events.v1'; events: FindingRecord[] }
export interface FindingRegistry { producers: Record<string, readonly string[]>; codebases: readonly string[]; linear_teams: readonly string[] }
export class IntakeValidationError extends Error {
  constructor(message = 'Invalid intake events', public readonly status = 422, public readonly code = 'invalid_events') { super(message); this.name = 'IntakeValidationError'; }
}
function requireValid(condition: unknown, reason: string): asserts condition { if (!condition) throw new IntakeValidationError(reason); }

export function validCalendarTimestamp(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value.replace('Z', '.000Z');
}
const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addFormat('date-time', validCalendarTimestamp);
ajv.addSchema(findingSchema);
const checkSchema = ajv.getSchema<FindingRecord>('urn:aios:finding-observations:v1')!;
const checkRequest = ajv.compile<IntakeRequest>(requestSchema);
export function validateIntakeRequest(value: unknown): asserts value is IntakeRequest { requireValid(checkRequest(value), 'Invalid request schema'); }

/** Valid canonical records contain only ASCII strings and bounded integers. */
export function canonicalRecord(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { requireValid(!/[^\x20-\x7e]/.test(value), 'Noncanonical string'); return JSON.stringify(value); }
  if (typeof value === 'number') { requireValid(Number.isSafeInteger(value), 'Noninteger value'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalRecord).join(',') + ']';
  requireValid(typeof value === 'object' && value !== null, 'Invalid canonical value');
  return '{' + Object.keys(value).sort().map(key => canonicalRecord(key) + ':' + canonicalRecord((value as Record<string, unknown>)[key])).join(',') + '}';
}
export function candidateId(identity: CandidateRecord['identity']): string { return digest('aios.finding.candidate.discovery.v1', identity); }
function digest(domain: string, value: unknown): string { return createHash('sha256').update(domain + '\0' + canonicalRecord(value), 'utf8').digest('hex'); }
export function eventId(record: FindingRecord): string { const { event_id: ignored, ...rest } = record; void ignored; return digest('aios.finding.event.v1', rest); }

export function validateRecord(value: unknown, registry: FindingRegistry): asserts value is FindingRecord {
  requireValid(checkSchema(value), 'Invalid finding schema');
  const record = value as FindingRecord;
  const producer = record.producer;
  requireValid(Object.hasOwn(registry.producers, producer.name) && registry.producers[producer.name].includes(producer.version), 'Unconfigured producer/version');
  requireValid(record.event_id === eventId(record), 'Invalid event ID');
  if (record.attribution.issue) requireValid(registry.linear_teams.includes(record.attribution.issue.team), 'Unconfigured Linear team');
  if (record.record_type === 'run_summary') return;
  requireValid(record.identity.producer_namespace === producer.name, 'Producer namespace mismatch');
  requireValid(record.candidate_id === candidateId(record.identity), 'Invalid candidate ID');
  for (const values of [record.codebases, record.taxonomy.fences]) requireValid(values.every((v, i) => i === 0 || values[i - 1] < v), 'Noncanonical set');
  requireValid(record.codebases.every(v => v !== 'cross-repo' && registry.codebases.includes(v)), 'Unconfigured codebase');
  const fences = record.taxonomy.fences;
  requireValid(!(fences.includes('none') || fences.includes('unknown')) || fences.length === 1, 'Exclusive fence');
  const links = record.links;
  if (links.linear) requireValid(registry.linear_teams.includes(links.linear.team), 'Unconfigured Linear team');
  if (links.scanner) requireValid(Object.hasOwn(registry.producers, links.scanner.producer), 'Unconfigured scanner');
  for (const link of [links.pull_request, links.merge]) if (link) requireValid(record.codebases.includes(link.codebase), 'Link outside memberships');
  const disposition: Partial<Record<CandidateState, CandidateRecord['disposition']>> = { duplicate: 'duplicate', rejected: 'rejected', resolved: 'resolved', incomplete: 'unknown' };
  requireValid(record.disposition === (disposition[record.state] ?? 'open'), 'Contradictory disposition');
  requireValid((record.duplicate_target !== null) === (record.state === 'duplicate'), 'Duplicate linkage');
  if (record.state !== 'discovered' && record.state !== 'incomplete') requireValid(record.evidence_status === 'complete', 'Transition lacks evidence');
  if (record.state === 'incomplete') requireValid(record.evidence_status !== 'complete', 'Incomplete claims complete evidence');
  if (['filed', 'queue_eligible', 'selected', 'remediation_started', 'merged', 'resolved'].includes(record.state)) requireValid(links.linear !== null || links.scanner !== null, 'Filing link missing');
  if (['merged', 'resolved'].includes(record.state)) requireValid(links.merge !== null, 'Merge link missing');
  if (record.state === 'resolved') requireValid(links.resolution !== null, 'Resolution evidence missing');
}
const transitions: Record<CandidateState, readonly CandidateState[]> = {
  discovered: ['verified','duplicate','rejected','incomplete'], verified: ['filed','duplicate','rejected','incomplete'], filed: ['queue_eligible','duplicate','rejected','incomplete'], queue_eligible: ['selected','duplicate','rejected','incomplete'], selected: ['remediation_started','duplicate','rejected','incomplete'], remediation_started: ['merged','duplicate','rejected','incomplete'], merged: ['resolved','incomplete'], resolved: ['escaped','reopened'], escaped: ['reopened','incomplete'], duplicate: ['reopened'], rejected: ['reopened'], incomplete: ['reopened'], reopened: ['verified','duplicate','rejected','incomplete'],
};
export function validateTransition(previous: CandidateRecord | null, next: CandidateRecord): void {
  requireValid(next.sequence === (previous ? previous.sequence + 1 : 0), 'Sequence conflict or gap');
  requireValid(next.predecessor_event_id === (previous?.event_id ?? null), 'Invalid predecessor');
  if (!previous) {
    requireValid(next.state === 'discovered' && next.episode === 0, 'Missing discovery');
    requireValid(next.producer.run_id === next.identity.original_run_id, 'Discovery run mismatch');
    return;
  }
  requireValid(next.candidate_id === previous.candidate_id && canonicalRecord(next.identity) === canonicalRecord(previous.identity), 'Conflicting discovery identity');
  requireValid(next.attribution.program_id === previous.attribution.program_id, 'Program changed');
  requireValid(transitions[previous.state].includes(next.state), 'Invalid transition');
  requireValid(next.episode === previous.episode + Number(next.state === 'reopened'), 'Invalid lifecycle episode');
}
const terminal: Record<RunSummaryRecord['stage'], readonly CandidateState[]> = {
  discovery: ['verified','filed','queue_eligible','selected','remediation_started','merged','resolved','duplicate','rejected'],
  filing: ['filed','queue_eligible','selected','remediation_started','merged','resolved','duplicate','rejected'],
  remediation: ['merged','resolved','duplicate','rejected'], resolution: ['resolved','duplicate','rejected'],
};
export type CandidateStateCounts = Partial<Record<CandidateState, number>>;
export function validateRunSummary(summary: RunSummaryRecord, latest: CandidateStateCounts | readonly CandidateRecord[]): void {
  const counts: CandidateStateCounts = {};
  if (Array.isArray(latest)) { for (const event of latest) counts[event.state as CandidateState] = (counts[event.state as CandidateState] ?? 0) + 1; }
  else Object.assign(counts, latest);
  for (const [state, count] of Object.entries(counts)) requireValid(Object.hasOwn(transitions, state) && Number.isSafeInteger(count) && count >= 0, 'Invalid aggregate');
  const c = summary.counts;
  if (summary.capture_status === 'unknown') {
    requireValid(Object.values(c).every(v => v === null), 'Unknown capture has counts');
    requireValid(summary.detector_completed === null && summary.detector_evidence_sha256 === null, 'Unknown capture claims completion');
    requireValid(summary.evidence_status === 'unknown' && summary.emission_gap_reason === 'unknown', 'Unknown capture status mismatch');
    return;
  }
  const { raw_candidates: raw, emitted_candidates: emitted, terminal_stage: t, incomplete, malformed } = c;
  requireValid(raw !== null && emitted !== null && t !== null && incomplete !== null && malformed !== null, 'Known capture lacks counts');
  const complete = summary.capture_status === 'complete';
  requireValid(summary.detector_completed === complete && summary.detector_evidence_sha256 !== null, 'Detector status/evidence mismatch');
  requireValid(summary.evidence_status === (complete ? 'complete' : 'incomplete'), 'Capture evidence mismatch');
  requireValid(raw === t + incomplete, 'Raw denominator mismatch');
  requireValid(emitted === Object.values(counts).reduce((sum, n) => sum + n, 0), 'Emitted denominator mismatch');
  requireValid(raw - emitted === malformed && malformed <= incomplete, 'Malformed gap mismatch');
  requireValid(summary.emission_gap_reason === (malformed ? 'malformed' : 'none'), 'Gap reason mismatch');
  const expectedTerminal = terminal[summary.stage].reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  requireValid(t === expectedTerminal, 'Terminal count mismatch');
  requireValid(incomplete === emitted - expectedTerminal + malformed, 'Incomplete count mismatch');
  requireValid(raw !== 0 || complete, 'Empty capture lacks detector completion');
}
