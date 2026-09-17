import 'server-only';
import type { DbClient } from '@/lib/db/types';
import { parseAuthorRefs } from '@/lib/attribution/resolve-authors';
import { rankedFtsSearch, type FtsHit } from './fts-search';
import { buildFtsQuery } from './fts-query';
import { boundEvidence, clipWords, excerptFor, type EvidenceContributor, type EvidenceSource } from './evidence-format';

type Member = { id: string; display_name: string | null; actor_handle: string | null; email: string | null; is_connector: boolean };
const clean = (s: unknown): string | null => typeof s === 'string' && s.trim() && !s.includes('@') ? clipWords(s.trim(), 200) : null;
const lower = (s: unknown) => typeof s === 'string' ? s.trim().toLowerCase() : '';

async function contributorsFor(db: DbClient, teamId: string, hits: FtsHit[]) {
  // The roster is used only to resolve identities explicitly attached to these authorized sources.
  // Never serialize the roster, email aliases, unresolved diagnostics, or a connector account.
  const results = await Promise.all([
    db.from('members').select('id, display_name, actor_handle, email, is_connector').eq('team_id', teamId),
    db.from('member_emails').select('member_id, email').eq('team_id', teamId),
    db.from('member_identities').select('member_id, provider, external_id, email').eq('team_id', teamId),
  ]);
  if (results.some(r => r.error)) throw new Error('attribution lookup failed');
  const members = (results[0].data ?? []) as Member[];
  const roster = new Map(members.map(m => [m.id,m]));
  const humans = new Map(members.filter(m => !m.is_connector).map(m => [m.id,m]));
  const emails = new Map<string,string>(); const handles = new Map<string,string>(); const providers = new Map<string,string>();
  for (const m of members) {
    if (m.email) emails.set(lower(m.email), m.id);
    if (m.actor_handle) handles.set(lower(m.actor_handle), m.id);
  }
  for (const a of results[1].data ?? []) if (roster.has(a.member_id) && a.email) emails.set(lower(a.email), a.member_id);
  for (const a of results[2].data ?? []) if (roster.has(a.member_id)) {
    providers.set(`${lower(a.provider)}:${lower(a.external_id)}`, a.member_id);
    if (a.email) emails.set(lower(a.email), a.member_id);
  }
  return hits.map(hit => {
    const refs = parseAuthorRefs(hit.frontmatter ?? {});
    const contributors = refs.slice(0,20).map((ref): EvidenceContributor | null => {
      const id = (ref.provider && ref.externalId ? providers.get(`${lower(ref.provider)}:${lower(ref.externalId)}`) : undefined)
        ?? (ref.email ? emails.get(lower(ref.email)) : undefined)
        ?? (ref.handle ? handles.get(lower(ref.handle)) : undefined);
      if (id && roster.get(id)?.is_connector) return null;
      const m = id ? humans.get(id) : undefined;
      return { name: clean(m?.display_name) ?? clean(ref.displayName),
        ...(clean(m?.actor_handle ?? ref.handle) ? { handle: clean(m?.actor_handle ?? ref.handle)! } : {}),
        role: clean(ref.role) ?? 'contributor', resolution: m ? 'exact' : 'unresolved' };
    }).filter((person): person is EvidenceContributor => person !== null);
    return { contributors, omitted: refs.length > 20 };
  });
}

export async function searchEvidence(db: DbClient, teamId: string, tier: 'team'|'external', query: string, project: string | undefined, limit: number, visibleIds: ReadonlySet<string>) {
  if (!visibleIds) throw new Error('visibility required');
  const parsed = buildFtsQuery(query);
  const hits = await rankedFtsSearch(teamId, tier, parsed.query, limit + 1, null, [...visibleIds], { project, metadata: true, identifiers: query.match(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g) ?? [] });
  const selected = hits.slice(0, limit);
  if (!selected.length) return boundEvidence([], false);
  const attribution = await contributorsFor(db, teamId, selected);
  const sources: EvidenceSource[] = selected.map((hit,i) => {
    const excerpt = excerptFor(hit.body, parsed.terms);
    const people = attribution[i].contributors;
    const resolved = people.filter(p => p.resolution !== 'unresolved').length;
    const fm = hit.frontmatter ?? {};
    let sourceUrl: string | undefined;
    if (typeof fm.source_url === 'string' && fm.source_url.length < 1500) {
      try { const u = new URL(fm.source_url); if (['http:','https:'].includes(u.protocol) && !u.username && !u.password) sourceUrl = u.href; } catch { /* no canonical URL */ }
    }
    return { sid: `S${i+1}`, item_id: hit.id, title: clipWords(hit.title || hit.path.split('/').pop() || hit.path, 300),
      path: hit.path, project: hit.project, kind: hit.kind, work_at: hit.work_at,
      excerpt: excerpt.text, excerpt_truncated: excerpt.truncated, contributors: people,
      attribution: resolved && resolved === people.length ? 'resolved' : resolved ? 'partial' : 'unresolved',
      ...(sourceUrl ? { source_url: sourceUrl } : {}), };
  });
  return boundEvidence(sources, hits.length > limit || attribution.some(a => a.omitted));
}
