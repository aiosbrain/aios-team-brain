-- Phase B slice 1 (spec §5/§11): the permissive→enforcing rollout flag.
-- 'permissive' (default) = reads behave EXACTLY as today (legacy tier filter only) — byte-identical,
-- so no team is affected until an admin flips it. 'enforcing' = reads apply the oracle membership
-- filter AND the legacy tier check (visibility = oracle ∧ legacy-tier, §5.6 conjunct: a bug in
-- either fails closed). A team flips to enforcing only once its §11 backfill is confirmed complete
-- (else an un-partitioned item would fail closed and vanish — the flag IS the fail-open-to-today
-- transition mechanism). Named drop-and-re-add CHECK (replay-repairable).

alter table teams add column if not exists access_enforcement text not null default 'permissive';

do $$
begin
  alter table teams drop constraint if exists teams_access_enforcement_check;
  alter table teams add constraint teams_access_enforcement_check
    check (access_enforcement in ('permissive','enforcing'));
end $$;
