#!/usr/bin/env bash
# Progress for the rep in flight: extraction attempts, spend, and whether the ledger agrees.
. /tmp/gwb5/env.sh
psql "$BATTERY_URL" -At -F'|' -c "
select
  (select count(*) from llm_usage where call_kind in ('extract_nodes','extract_nodes_and_edges')) as extracts,
  (select coalesce(round(sum(cost_usd),4),0) from llm_usage) as spend_usd,
  (select coalesce(max(meta->>'episodes'),'-') from ingest_runs where source='graph_project') as pushed_episodes,
  (select coalesce(round(extract(epoch from (now()-max(created_at))))::int,-1) from llm_usage) as quiet_secs;"
