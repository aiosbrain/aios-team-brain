/** Wire-format budgeting is independent of transports: never slice serialized JSON. */
export type EvidenceContributor = { name: string | null; handle?: string; role: string; resolution: 'exact' | 'recorded' | 'unresolved' };
export type EvidenceSource = {
  sid: string; item_id: string; title: string; path: string; project: string; kind: string;
  work_at: string; excerpt: string; excerpt_truncated: boolean;
  contributors: EvidenceContributor[]; attribution: 'resolved' | 'partial' | 'unresolved';
  source_url?: string;
};
export type EvidenceResponse = { sources: EvidenceSource[]; returned: number; truncated: boolean };

export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const prefix = text.slice(0, Math.max(0, max - 1));
  const boundary = prefix.lastIndexOf(' ');
  return prefix.slice(0, boundary > max / 2 ? boundary : undefined).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

export function excerptFor(body: string, terms: string[], max = 1800): { text: string; truncated: boolean } {
  if (body.length <= max) return { text: body, truncated: false };
  const lower = body.toLowerCase();
  const positions = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
  let start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 200);
  if (start > 0) {
    const boundary = body.indexOf(' ', start);
    if (boundary >= start && boundary < start + 80) start = boundary + 1;
  }
  return { text: (start ? '…' : '') + clipWords(body.slice(start), max - (start ? 1 : 0)), truncated: true };
}

export function boundEvidence(sources: EvidenceSource[], more: boolean): EvidenceResponse {
  const result: EvidenceResponse = { sources: sources.map(s => ({ ...s })), returned: sources.length, truncated: more || sources.some(s => s.excerpt_truncated) };
  while (JSON.stringify(result).length > 20000 && result.sources.length) {
    result.truncated = true;
    const longest = [...result.sources].sort((a,b) => b.excerpt.length - a.excerpt.length)[0];
    if (longest.excerpt.length > 400) {
      longest.excerpt = clipWords(longest.excerpt, Math.max(400, Math.floor(longest.excerpt.length * .75)));
      longest.excerpt_truncated = true;
    } else result.sources.pop();
    result.returned = result.sources.length;
  }
  return result;
}
