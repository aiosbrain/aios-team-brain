-- AIO-1167 Batch 4: revision-fenced provider identity repair and retained Drive
-- contribution evidence. Additive and replay-safe.

create table if not exists member_identity_mapping_state (
  team_id uuid not null references teams(id) on delete cascade,
  provider text not null,
  external_id text not null,
  member_id uuid,
  revision bigint not null default 1 check (revision > 0),
  state text not null default 'linked' check (state in ('linked','unlinked')),
  updated_at timestamptz not null default now(),
  primary key (team_id, provider, external_id),
  foreign key (team_id, member_id) references members(team_id, id) on delete set null (member_id)
);
create index if not exists member_identity_mapping_state_member_idx
  on member_identity_mapping_state(team_id, member_id) where member_id is not null;

create table if not exists identity_repair_obligations (
  team_id uuid not null references teams(id) on delete cascade,
  provider text not null,
  external_id text not null,
  mapping_revision bigint not null check (mapping_revision > 0),
  status text not null default 'pending'
    check (status in ('pending','running','retry','complete','obsolete')),
  cursor_item_id uuid,
  items_scanned bigint not null default 0,
  items_updated bigint not null default 0,
  versions_updated bigint not null default 0,
  contributions_updated bigint not null default 0,
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (team_id, provider, external_id, mapping_revision)
);
create index if not exists identity_repair_obligations_pending_idx
  on identity_repair_obligations(status, next_attempt_at, updated_at)
  where status in ('pending','running','retry');

-- One immutable source observation per item/person-role-instant. `member_id` is the
-- current derived mapping and is repairable; the provider provenance is never replaced.
create table if not exists gdrive_contribution_evidence (
  team_id uuid not null references teams(id) on delete cascade,
  item_id uuid not null,
  evidence_key text not null,
  external_id text,
  email citext,
  display_name text,
  role text not null,
  source_at timestamptz,
  source_at_raw text not null default '',
  member_id uuid,
  mapping_revision bigint,
  diagnostic text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, item_id, evidence_key),
  foreign key (team_id, item_id) references items(team_id, id) on delete cascade,
  foreign key (team_id, member_id) references members(team_id, id) on delete set null (member_id)
);
create index if not exists gdrive_contribution_evidence_time_idx
  on gdrive_contribution_evidence(team_id, source_at desc, item_id, evidence_key);
create index if not exists gdrive_contribution_evidence_identity_idx
  on gdrive_contribution_evidence(team_id, external_id)
  where external_id is not null;
create index if not exists gdrive_contribution_evidence_member_idx
  on gdrive_contribution_evidence(team_id, member_id, source_at desc)
  where member_id is not null;

-- Existing links begin at revision 1. Later mutations advance monotonically through
-- lib/identity/member-identities.ts and enqueue a repair for that exact revision.
insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state)
select team_id, lower(provider), external_id, member_id, 1, 'linked'
  from member_identities
on conflict (team_id,provider,external_id) do nothing;

-- Adopt retained Google observations. Connector-produced timestamps are ISO-8601;
-- malformed historical values remain retained with a diagnostic instead of aborting the upgrade.
insert into gdrive_contribution_evidence(
  team_id,item_id,evidence_key,external_id,email,display_name,role,
  source_at,source_at_raw,diagnostic
)
select i.team_id, i.id,
       md5(btrim(coalesce(c->>'external_id','')) || chr(31)
           || lower(btrim(coalesce(c->>'email',''))) || chr(31)
           || lower(btrim(coalesce(c->>'role',''))) || chr(31)
           || btrim(coalesce(c->>'at',''))),
       nullif(btrim(c->>'external_id'),''), nullif(lower(btrim(c->>'email')),''),
       nullif(btrim(c->>'display_name'),''), lower(btrim(coalesce(c->>'role',''))),
       case when pg_input_is_valid(btrim(coalesce(c->>'at','')), 'timestamptz')
            then btrim(c->>'at')::timestamptz else null end,
       btrim(coalesce(c->>'at','')),
       case
         when nullif(btrim(c->>'external_id'),'') is null
          and nullif(btrim(c->>'email'),'') is null
           then 'missing_identity'
         when not pg_input_is_valid(btrim(coalesce(c->>'at','')), 'timestamptz')
           then 'missing_source_time'
         else null
       end
  from items i
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(i.frontmatter->'contributions')='array'
         then i.frontmatter->'contributions' else '[]'::jsonb end
  ) c
 where i.frontmatter->>'source'='gdrive'
   and nullif(lower(btrim(c->>'role')),'') is not null
on conflict (team_id,item_id,evidence_key) do nothing;

insert into identity_repair_obligations(team_id,provider,external_id,mapping_revision)
select team_id,provider,external_id,revision
  from member_identity_mapping_state
 where provider='gdrive'
on conflict do nothing;
