-- Store the governance validation result on each content variant (Social Brain generation). The
-- gate (lib/social/validate) records blocking violations (prohibited phrases, confidential topics)
-- and non-blocking warnings (unverified claims) checked against the Brand Brain when a draft is
-- generated. Additive + idempotent. Mirrored into schema.sql's content_variants for from-zero.
alter table content_variants add column if not exists validation jsonb not null default '{}';
