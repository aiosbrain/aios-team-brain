-- Email+password auth (replaces trust-any-known-email passwordless login, audit M1/M2b).
-- Admin sets a member's initial password; the member logs in with it and can change it anytime.
-- NULL means no password set yet (login is rejected, not silently allowed) — see lib/auth/password.ts.
alter table auth_users add column if not exists password_hash text;
