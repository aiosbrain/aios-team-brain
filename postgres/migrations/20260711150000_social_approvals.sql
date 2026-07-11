-- Approval workflow + autonomy (Social Brain M4). A generated variant needs sign-off before it can
-- be scheduled/published (M5). `social_settings.autonomy` is the per-team gate — conservative by
-- default (`draft_only`: nothing advances past a draft). `content_approvals` is the queue (mirrors
-- `approval_requests`). Single writers: lib/social/settings.ts, lib/social/approvals.ts.
--
-- Mirrors postgres/schema.sql (from-zero). Idempotent. No RLS — tier is app-code (inherited).

create table if not exists social_settings (
  team_id uuid primary key references teams(id) on delete cascade,
  autonomy text not null default 'draft_only'
    check (autonomy in ('draft_only', 'approval_required', 'auto_publish_low_risk', 'fully_autonomous')),
  updated_at timestamptz not null default now()
);

create table if not exists content_approvals (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,               -- inherited from the variant
  status approval_status not null default 'pending',
  decided_by uuid references members(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists content_approvals_team_status_idx on content_approvals (team_id, status, created_at desc);
create index if not exists content_approvals_variant_idx on content_approvals (variant_id);
