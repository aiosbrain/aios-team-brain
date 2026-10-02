# Release notes — TIERRET-1: membership is the only member content read rule

Ticket AIO-1045 (brain row TIERRET-1). Spec: `docs/design/tierret1-membership-only.md`.

## What changes for readers

- **An admitted member reads exactly what its group grants serve, whatever the content's label.** An
  external collaborator granted a project now receives that project's `team`-labelled items, the
  tasks/decisions sourced from them, its meeting notes (transcript membership), grounding, OKF default
  export, timeline evidence and project cards — the same as a team-posture member with the same grant.
- **Hand-entered rows** (`created_by` set, no source item): an oracle-accepted Everyone human still sees
  all of them (unchanged); every other admitted member sees those in its **granted** projects only; a
  grantless member sees none.
- **Unchanged:** delegated `aiosd_` tokens (effective-project attenuation, external delegation still
  refused, graph/organization mirror legs still omitted); legacy connector/offroster API keys (they gain
  nothing and lose nothing — including their pre-existing hand-entered rows at Everyone posture and their
  organization-structure legs); every WRITE privilege (create destinations, uploads, meeting actions,
  admin commands, and which existing rows a member may edit — see "Edits stay on the pre-release row
  rule" below); push coercion (an external key still cannot overwrite a team item and a fresh
  external push is still stored `external`); explicit `?tier=external` OKF export narrowing and link
  redaction; people identity context; codebase/maturity telemetry; social admin gating and
  publication ceilings.
- Grants take effect **immediately on deploy** — there is no migration, no re-ingest, no data rewrite.

### Who GAINS and who LOSES on deploy — read before rolling out

- **Exposure (gain): hand-entered rows already filed in a project granted to a non-Everyone group.**
  Before this release an external-posture member saw NO hand-entered task/decision at all. Every
  hand-entered row already sitting in a project granted to a custom/client group, a person (singleton)
  group, or the builtin **External** group becomes readable by that group's members at deploy —
  **including rows filed in `external-shared` itself**, which appears in Everyone members' create
  dropdowns and accepts dashboard-created tasks. Staff may reasonably have filed internal notes there
  while external members could not see them. The same applies to TEAM-audience rows sourced from items a
  granted collaborator can see (the audience label no longer vetoes the grant).
- **Narrowing (loss): standing agents whose builtin Everyone row gave them every hand-entered row.**
  A standing agent with a builtin Everyone row (e.g. planted, or left from a tier default) used to read
  ALL hand-entered rows through its raw Everyone posture. The Everyone audience now follows the
  oracle-ACCEPTED Everyone membership, which is human-only, so such an agent sees hand-entered rows only
  in projects granted to it through non-builtin groups — and a grantless agent sees none. Agent keys
  that pull the tasks writeback feed (`GET /api/v1/tasks`) will stop receiving dashboard-created (`ui-`)
  rows outside those projects. Sourced content is unaffected (it always followed membership).
- **Edits stay on the pre-release row rule.** Because the board and decisions page now show readers rows
  they could not reach before, the task move/edit actions and the decision validity toggle now check
  the PRE-release row predicate server-side (label ceiling by posture; sourced row → source item
  visible; hand-entered row → `created_by` at Everyone posture) on top of team membership and role,
  and refuse other rows exactly like an absent row — no write, no PM projection. Every row the old board
  let a member edit stays editable. A hand-entered/sourced row that is newly READABLE is therefore
  read-only for that member. (Previously the actions checked team membership only, so a crafted request
  with a known row id could edit any team row; that is now refused too.)

**Operator review is REQUIRED before rollout:** run the read-only census below for each team, review
the listed projects/rows and agents, and decide deliberately (move or re-file rows, adjust grants, grant
agents what they need) BEFORE deploying. This release changes no grant and no row.

## Pre-deploy impact census (read-only, team-scoped)

These queries are a **candidate impact inventory**, not the exact eligibility oracle: a raw grant row
does not by itself prove that an eligible, active member holds it (an empty group, an inactive member or
an unready project changes the real outcome), and they do not model token attenuation. They return
counts and row keys/handles only — never titles or bodies. Run them in a read-only transaction against
the instance database (substitute the team slug); they write nothing and repair nothing.

```sql
begin transaction read only;

-- A. Hand-entered rows (source_item_id IS NULL and created_by IS NOT NULL — the hand-typed provenance
--    proof; rows with no creator stay hidden from everyone) in projects granted to ANY group other than
--    the builtin Everyone group: custom/client groups, singleton (person) groups, builtin External (which
--    covers external-shared). One row per project × row type; grants are collapsed to DISTINCT project
--    ids first, so a project granted to several groups is never double-counted.
with t as (select id from teams where slug = 'TEAM_SLUG'),
granted as (
  select pg.project_id, string_agg(distinct g.slug, ', ' order by g.slug) as via_groups
    from project_groups pg
    join groups g on g.id = pg.group_id and g.team_id = pg.team_id
   where pg.team_id = (select id from t)
     and not (g.is_builtin and g.slug = 'everyone')
   group by pg.project_id
),
hand as (
  select 'task' as row_type, x.row_key, x.project_id, x.audience::text as audience from tasks x
   where x.team_id = (select id from t) and x.source_item_id is null and x.created_by is not null
  union all
  select 'decision', d.row_key, d.project_id, d.audience::text from decisions d
   where d.team_id = (select id from t) and d.source_item_id is null and d.created_by is not null
)
select p.slug as project, p.kind, gr.via_groups, h.row_type,
       count(*) as rows,
       count(*) filter (where h.audience = 'team') as team_audience_rows,
       (array_agg(h.row_key order by h.row_key))[1:20] as sample_row_keys
  from hand h
  join granted gr on gr.project_id = h.project_id
  join projects p on p.id = h.project_id
 group by p.slug, p.kind, gr.via_groups, h.row_type
 order by p.slug, h.row_type;

-- B. ACTIVE standing agents (kind = 'agent', not a connector) holding a builtin Everyone row — the
--    population whose "all hand-entered rows" arm ends. Per agent: its UNREVOKED API keys
--    (revoked_at IS NULL), the projects granted to it through NON-builtin groups (its new hand-entered
--    scope), and how many hand-entered rows fall OUTSIDE that scope (the rows it stops reading).
with t as (select id from teams where slug = 'TEAM_SLUG'),
agents as (
  select m.id, m.actor_handle
    from members m
    join group_members gm on gm.member_id = m.id and gm.team_id = m.team_id
    join groups g on g.id = gm.group_id and g.team_id = gm.team_id and g.is_builtin and g.slug = 'everyone'
   where m.team_id = (select id from t) and m.status = 'active' and m.kind = 'agent' and not m.is_connector
),
agent_projects as (
  select distinct gm.member_id, pg.project_id
    from group_members gm
    join groups g on g.id = gm.group_id and g.team_id = gm.team_id and not g.is_builtin
    join project_groups pg on pg.group_id = g.id and pg.team_id = g.team_id
   where gm.team_id = (select id from t)
),
hand as (
  select x.project_id from tasks x
   where x.team_id = (select id from t) and x.source_item_id is null and x.created_by is not null
  union all
  select d.project_id from decisions d
   where d.team_id = (select id from t) and d.source_item_id is null and d.created_by is not null
)
select a.actor_handle,
       (select count(*) from api_keys k where k.team_id = (select id from t) and k.member_id = a.id and k.revoked_at is null) as active_keys,
       (select count(*) from agent_projects ap where ap.member_id = a.id) as granted_projects,
       (select count(*) from hand h
         where not exists (select 1 from agent_projects ap where ap.member_id = a.id and ap.project_id = h.project_id)) as hand_rows_no_longer_read
  from agents a
 order by active_keys desc, a.actor_handle;

rollback;
```

Interpretation: every row in **A** is content a granted collaborator may read after deploy — confirm each
project's `via_groups` audience is meant to see it (pay particular attention to `external-shared`). Every
row in **B** with `active_keys > 0` and `hand_rows_no_longer_read > 0` is an agent integration that
silently receives fewer rows after deploy; grant it the projects it needs (through a custom group) or
accept the narrowing. Neither query changes anything; repairs go through the existing admin surfaces.

## REQUIRED before rollout (each instance)

1. **Census must be clean.** For every team run the existing protected health read and confirm ZERO
   unsanctioned protected-target grants (General AND external-shared):

   ```bash
   npm run admin -- access-health <team-slug>
   ```

   Any `unsanctioned edge(s) on system projects` blocker must be repaired through the existing
   sanctioned procedure (`npm run admin -- repair-system-edge <group-slug> <project-slug> --actor
   <admin-email>`, AUDITFIX-21) BEFORE
   deploying. This release does not perform any repair.
   **Why it is now mandatory:** the replacement placement gate (`system-integrity`) refuses to place
   content into a protected project that holds an unsanctioned grant, in BOTH directions — a corrupted
   **external-shared** now stops a team→external (widening) push, and a corrupted **General** stops a
   narrowing push or a backfill, rolling the item's transaction back. That is intentional (the old gate
   let a forbidden General edge silently publish team content), but it can interrupt ingestion until the
   edge is repaired.
2. **Review the new drift blocker.** The same health read now reports `active external-tier human
   member(s) are in the builtin Everyone group`. Everyone grants General, so each listed person reads all
   team content. Resolve each deliberately (remove from Everyone, or set tier to team). This detects a
   persisted tier/membership MISMATCH only; a contractor deliberately added to Everyone through the
   groups writer has tier mirrored to `team` and is not detectable here.
3. **Run and review the impact census** ("Pre-deploy impact census" above) for each team, and record
   the operator's decision for every listed project and agent before deploying.

## Graph

Graph query/projection code (`lib/graph/*`) is **unchanged** by this release. The member graph scope is
the oracle's granted project set, carried by the admission resolver into the existing partition reader
(General restriction debt, unready/self-purging initiatives, the K cap and the empty-scope-never-falls-back
rule are the existing reader's); legacy keys and delegated tokens get no graph scope. No real-Neo4j run is
claimed for this release — the existing partition suites and the HTTP Graphiti `/search` spy
(`npm run test:http:tierret1-query`) are the evidence.

## Timeline cache — rollback and roll-forward

- Rows now live under a NEW key namespace `adm:<class>:<tier>:<hash>` at payload version **16** (15 is
  reserved by the pending Slack-semantics change). Previous code reads only `vis:<tier>:<hash>` rows, so
  **rolling back cannot serve or salvage the wider new rows** — no purge is needed for rollback safety.
  The old `vis:` rows are never read by the new code and may be deleted at leisure for space.
- **MANDATORY before rolling FORWARD again after any rollback:** the old code cannot maintain `adm:` rows
  (a reclassification during the rollback window leaves them stale), so delete them before the new build
  serves requests:

  ```sql
  delete from work_timeline_cache where group_key like 'adm:%';
  ```

  (Code equivalent: `lib/dashboard/timeline-cache.purgeAdmissionTimelineNamespace`, which also drops the
  process-local copies; a fresh deploy starts with empty process caches.) Do not rely on TTL or on the
  payload version for this.
- A code rollback restores the old restrictive member filters and the old placement gate. It does not
  retract content already read, and it may hide intentionally granted content again. Grants, labels and
  memberships are untouched either way.

## Clients — re-pull to receive OLDER newly admitted rows

Task/decision timestamps and OKF cursors do **not** move when access changes, so rows that become
visible now are older than every existing client cursor. To receive them, each workspace should:

1. Back up its workspace state file `.aios/state.json` (operator state outside this repository).
2. Reset ONLY these cursor keys to the epoch `1970-01-01T00:00:00Z` (or remove them), preserving push
   hashes and every other key: `last_pull`, `last_tasks_pull`, `last_sync_tasks_pull`,
   `last_decisions_pull`.
3. Run `aios pull`. (There is no `--full` flag.) Repeated pulls merge by row key, so re-pulling is
   idempotent.

OKF consumers must discard their own cursor and request from the epoch. Previously downloaded local data
is **not** revoked by later server-side grant changes.

## Known composition, stated

An authorized reader can copy content it may read into a new workspace push; the server already permits
this for membership-visible item bodies and is not a transitive information-flow control. This release
adds no writer capability and does not change either writer rule above.
