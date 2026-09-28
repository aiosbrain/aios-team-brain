-- Append-only domain provenance. Separate from user-editable item frontmatter.
create table if not exists governed_item_origins (
  item_id uuid primary key,
  team_id uuid not null,
  member_id uuid not null,
  project_id uuid not null,
  kind text not null check (kind in ('decision','note')),
  entity_id uuid not null,
  identity_key text not null,
  revision uuid not null,
  created_at timestamptz not null default now(),
  foreign key (team_id,item_id) references items(team_id,id) on delete restrict,
  foreign key (team_id,member_id) references members(team_id,id) on delete restrict,
  foreign key (team_id,project_id) references projects(team_id,id) on delete restrict,
  unique (team_id,member_id,project_id,kind,identity_key),
  unique (team_id,kind,entity_id)
);

create or replace function protect_governed_item_origin() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'items' then
    -- Generated search is NULL in NEW before UPDATE; compare its immutable source columns instead.
    if exists(select 1 from governed_item_origins where item_id=old.id)
       and (tg_op='DELETE' or to_jsonb(new)-'synced_at'-'search' is distinct from to_jsonb(old)-'synced_at'-'search') then
      raise exception using errcode='23514', message='immutable_origin';
    end if;
  elsif tg_table_name = 'decisions' then
    if exists(select 1 from governed_item_origins where kind='decision' and entity_id=old.id and team_id=old.team_id)
       and (tg_op='DELETE' or to_jsonb(new) is distinct from to_jsonb(old)) then
      raise exception using errcode='23514', message='immutable_origin';
    end if;
  else
    raise exception using errcode='23514', message='immutable_origin';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists governed_item_immutable on items;
create trigger governed_item_immutable before update or delete on items
  for each row execute function protect_governed_item_origin();
drop trigger if exists governed_decision_immutable on decisions;
create trigger governed_decision_immutable before update or delete on decisions
  for each row execute function protect_governed_item_origin();
drop trigger if exists governed_origin_immutable on governed_item_origins;
create trigger governed_origin_immutable before update or delete on governed_item_origins
  for each row execute function protect_governed_item_origin();
