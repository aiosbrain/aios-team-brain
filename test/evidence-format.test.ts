import { describe, it, expect } from 'vitest';
import { boundEvidence, excerptFor, type EvidenceSource } from '@/lib/query/evidence-format';
const source = (i: number): EvidenceSource => ({ sid: `S${i}`, item_id: String(i), title: 'Title', path: 'experiments/a.md', project: 'demo', kind: 'artifact', work_at: '2026-09-17', excerpt: ('word "quoted" \\ sample\n').repeat(2000), excerpt_truncated: false, contributors: [], attribution: 'unresolved' });
describe('bounded evidence responses', () => {
  it('remains valid JSON under 20k including escaped characters and metadata', () => {
    const out = boundEvidence(Array.from({length:20}, (_,i)=>source(i+1)), true);
    const wire = JSON.stringify(out);
    expect(wire.length).toBeLessThanOrEqual(20000);
    expect(JSON.parse(wire).returned).toBe(out.sources.length);
    expect(out.truncated).toBe(true);
    expect(out.sources.length).toBeGreaterThan(0);
  });
  it('returns honest empty matches', () => expect(boundEvidence([], false)).toEqual({sources:[],returned:0,truncated:false}));
  it('selects passages around matched terms and flags omissions', () => {
    const body = 'Unrelated opening. '.repeat(400) + 'Cardboard protection fails after week six. ' + 'Other detail. '.repeat(400);
    const out = excerptFor(body, ['cardboard'], 800);
    expect(out.text).toContain('Cardboard protection fails');
    expect(out.text.length).toBeLessThanOrEqual(800);
    expect(out.truncated).toBe(true);
  });
});
