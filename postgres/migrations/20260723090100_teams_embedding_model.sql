-- Optional embedding model slug for the team's chosen embeddings provider (curated 1536-dim list;
-- null = provider default). Free text (no CHECK), mirroring teams.reasoning_model.
alter table teams add column if not exists embedding_model text;
