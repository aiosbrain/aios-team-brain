-- Notes are append-only governed items; no legacy create capability is introduced.
alter type item_kind add value if not exists 'note';

-- A trigger-maintained scalar lets the generated search column remain immutable without
-- pretending enum-to-text casts are immutable or using a newly added enum in this transaction.
alter table items add column if not exists note_search_title text not null default '';
create or replace function set_note_search_title() returns trigger language plpgsql as $$
begin
  new.note_search_title := case when new.kind::text='note' then coalesce(new.frontmatter->>'title','') else '' end;
  return new;
end $$;
drop trigger if exists items_note_search_title on items;
create trigger items_note_search_title before insert or update on items
  for each row execute function set_note_search_title();

-- Replace the stored vector once. This acquires a table lock and rebuilds its GIN index;
-- normal pre-deploy lock_timeout applies. Replays do not rewrite the table or rebuild the index.
do $$ begin
  if not exists (
    select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
    where d.adrelid='items'::regclass and a.attname='search'
      and pg_get_expr(d.adbin,d.adrelid) like '%note_search_title%'
  ) then
    alter table items drop column search;
    alter table items add column search tsvector generated always as
      (to_tsvector('english', coalesce(path,'') || ' ' || coalesce(body,'') || ' ' || note_search_title)) stored;
  end if;
end $$;
create index if not exists items_search_idx on items using gin (search);
