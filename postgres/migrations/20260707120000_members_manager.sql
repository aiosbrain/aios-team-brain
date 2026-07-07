-- Org-chart source: who a member reports to. Nullable self-FK, matching the auth_user_id
-- convention on this same table. Populated via the Admin -> Members "Reports to" selector
-- (setMemberManager) and synced into the company graph (lib/graph/company-actors.ts) as
-- both a REPORTS_TO relationship edge and attrs.reports_to on the member's actor entity.
alter table members add column if not exists manager_member_id uuid references members(id) on delete set null;
