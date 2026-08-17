-- PRET-2 (Codex diff-review High 2): the operator-undo hold is CONTROL STATE and must not ride
-- a best-effort audit row — a downgrade whose audit insert silently failed would be re-flipped
-- by the scheduler within one tick, turning the one-command undo into a lease. The hold is a
-- teams column written ATOMICALLY with the mode change (the same UPDATE statement) by the sole
-- flip writer (lib/admin/access-enforcement.ts): any downgrade sets it, any enforcing flip
-- clears it. Additive; mirrored in schema.sql for from-zero.
alter table teams add column if not exists autoflip_hold boolean not null default false;
