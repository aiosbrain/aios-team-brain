-- Add 'blueprint' to item_kind: a team lead publishes one blueprint item per team
-- (which integrations the team uses + non-secret instance config) that ICs pull to get
-- a guided connect-checklist. No secrets are ever stored in a blueprint. See
-- docs/brain-api.md (blueprint kind). Precedent: 20260614052740_add_skill_kind.sql.
alter type item_kind add value if not exists 'blueprint';
