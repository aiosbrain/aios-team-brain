-- PCCC-7 (Codex High 1): 6b namespaced partition-scope keys by team SLUG ('p:<slug>:…'); PCCC-7
-- re-bases them on the IMMUTABLE team id ('p:<teamId>:…') because a supported rename strands every
-- slug key. The HUMAN data (corrections) is re-keyed to follow; slug-keyed CACHE rows are
-- regenerable and simply dropped. Idempotent by construction: after the rewrite the slug-prefix
-- predicate matches nothing, and the cache delete only ever matches non-id-namespace keys.
-- Known bound, named: a row scoped under a slug the team NO LONGER holds (renamed before this
-- migration) cannot be re-keyed here — that combination was already named-incoherent pre-PCCC-7
-- (the rename doctrine), and no such row exists in this deployment (0 enforcing teams).
update arc_corrections ac
   set group_key = 'p:' || ac.team_id || ':' || substr(ac.group_key, length('p:' || t.slug || ':') + 1)
  from teams t
 where t.id = ac.team_id
   and ac.group_key like 'p:' || t.slug || ':%'
   and ac.group_key not like 'p:' || ac.team_id || ':%';
delete from arc_cache
 where group_key like 'p:%'
   and group_key not like 'p:' || team_id || ':%';
