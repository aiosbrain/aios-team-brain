import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidateId, canonicalRecord, eventId, validateRecord, validateRunSummary, validateTransition, type FindingRecord, type CandidateRecord, type FindingRegistry } from '../lib/codebases/debt-intake-validation';
import { MAX_INTAKE_BYTES, parseIntakeBody, strictIntakeJson } from '../lib/codebases/debt-intake-body';
const root = resolve('test/fixtures/contract/debt-intake');
const config = JSON.parse(readFileSync(resolve(root, 'trusted-config.json'), 'utf8')) as FindingRegistry;
function records(file: string): FindingRecord[] {
  return readFileSync(resolve(root, file), 'utf8').trimEnd().split('\n').map(line => {
    const record = strictIntakeJson(line); validateRecord(record, config); return record;
  });
}
function pureLedger(file: string): void {
  const ledger = records(file);
  const histories = new Map<string, Map<number, CandidateRecord>>();
  const summaries = ledger.filter(record => record.record_type === 'run_summary');
  for (const record of ledger) if (record.record_type === 'candidate') {
    const history = histories.get(record.candidate_id) ?? new Map<number, CandidateRecord>();
    history.set(record.sequence, record); histories.set(record.candidate_id, history);
  }
  for (const history of histories.values()) {
    let prior: CandidateRecord | null = null;
    for (const next of [...history.values()].sort((a,b) => a.sequence-b.sequence)) { validateTransition(prior,next); prior=next; }
  }
  for (const summary of summaries) {
    const latest: CandidateRecord[] = [];
    for (const history of histories.values()) {
      const event = [...history.values()].filter(e => e.producer.name === summary.producer.name && e.producer.run_id === summary.producer.run_id).sort((a,b) => b.sequence-a.sequence)[0];
      if (event) latest.push(event);
    }
    validateRunSummary(summary,latest);
    const counts: Partial<Record<CandidateRecord['state'], number>> = {};
    for (const record of latest) counts[record.state] = (counts[record.state] ?? 0) + 1;
    validateRunSummary(summary,counts);
  }
}
function request(body: string | Uint8Array, headers: Record<string,string> = {}): Request {
  return new Request('https://brain.invalid/intake', { method: 'POST', headers: { 'content-type':'application/json', ...headers }, body: typeof body === 'string' ? body : new Blob([body as Uint8Array<ArrayBuffer>]) });
}
describe('pinned Harness oracle fixtures', () => {
  for (const file of readdirSync(root).filter(v => v.endsWith('.jsonl'))) it(`accepts ${file}`, () => pureLedger(file));
  // These are relational whole-ledger failures owned by storage tests, not check_record/transition/counts.
  const storageOnly = new Set(['unknown-duplicate.jsonl','duplicate-cycle.jsonl','self-duplicate.jsonl','conflicting-summary.jsonl','conflicting-replay.jsonl']);
  for (const file of readdirSync(resolve(root,'negative')).filter(v => !storageOnly.has(v))) it(`rejects oracle ${file}`, () => expect(() => pureLedger('negative/'+file)).toThrow());
  it('matches canonical known answers unchanged', () => {
    const known = JSON.parse(readFileSync(resolve(root,'known-answers.json'),'utf8')) as { identity: CandidateRecord['identity']; candidate_id: string; discovered_event_id: string; canonical_identity_utf8: string };
    expect(candidateId(known.identity)).toBe(known.candidate_id);
    expect(canonicalRecord(known.identity)).toBe(known.canonical_identity_utf8);
    const discovered = records('five-candidate-worked-example.jsonl').find(r => r.event_id === known.discovered_event_id)!;
    expect(eventId(discovered)).toBe(known.discovered_event_id);
  });
  it('rejects calendar rollover independently of valid hashes', () => {
    for (const timestamp of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','0000-01-01T00:00:00Z','2026-01-01T24:00:00Z']) {
      const value = structuredClone(records('empty-success.jsonl')[0]); value.observed_at=timestamp; value.event_id=eventId(value);
      expect(() => validateRecord(value,config)).toThrow();
    }
  });
});
describe('strict bounded intake wire parser', () => {
  for (const text of ['{"a":1,"\\u0061":2}','{"x":{"a":1,"a":2}}','{"a":1.0}','{"a":1e0}','{"a":NaN}','{"a":Infinity}','{"a":01}','{"a":9007199254740993}','\ufeff{}',' \ufeff{}','{"a":1,}','[1,]','{"a":"\\x"}']) it(`rejects ${text}`, () => expect(() => strictIntakeJson(text)).toThrow());
  it('does not inherit prototype keys', () => expect(strictIntakeJson('{"__proto__":1}')).toEqual({ __proto__:null, ['__proto__']:1 }));
  it('accepts canonical envelope and whitespace', async () => {
    const events=records('empty-success.jsonl'); expect(await parseIntakeBody(request(' \n'+JSON.stringify({schema_version:'debt-intake-events.v1',events})+'\t'))).toEqual({schema_version:'debt-intake-events.v1',events});
  });
  it('rejects invalid UTF8 and BOM', async () => {
    for (const bytes of [new Uint8Array([0xff]),new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d])]) await expect(parseIntakeBody(request(bytes))).rejects.toMatchObject({status:422});
  });
  it('rejects missing version, open envelope, no records and 257 records', async () => {
    const events=records('empty-success.jsonl');
    for (const body of [{events},{schema_version:'debt-intake-events.v1',events,unknown:true},{schema_version:'debt-intake-events.v1',events:[]},{schema_version:'debt-intake-events.v1',events:Array(257).fill(events[0])}]) await expect(parseIntakeBody(request(JSON.stringify(body)))).rejects.toMatchObject({status:422});
  });
  it('enforces the raw byte boundary despite absent or misleading length', async () => {
    const envelope=JSON.stringify({schema_version:'debt-intake-events.v1',events:records('empty-success.jsonl')});
    await expect(parseIntakeBody(request(envelope.padEnd(MAX_INTAKE_BYTES,' ')))).resolves.toBeDefined();
    for (const headers of [{},{'content-length':'1'}]) await expect(parseIntakeBody(request(envelope.padEnd(MAX_INTAKE_BYTES+1,' '),headers))).rejects.toMatchObject({status:413,code:'payload_too_large'});
  });
  it('stops reading an oversized chunked stream', async () => {
    let cancelled=false; let reads=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller) { reads++; controller.enqueue(new Uint8Array(MAX_INTAKE_BYTES)); },cancel(){cancelled=true;}});
    const req=new Request('https://brain.invalid',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    await expect(parseIntakeBody(req)).rejects.toMatchObject({status:413}); expect(cancelled).toBe(true); expect(reads).toBeLessThanOrEqual(3);
  });
  it('requires JSON UTF8 content type',async()=> {
    for(const type of ['text/plain','application/json; charset=latin1','application/json; other=1']) await expect(parseIntakeBody(request('{}',{'content-type':type}))).rejects.toMatchObject({status:422});
  });
});
