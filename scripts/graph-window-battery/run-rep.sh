#!/usr/bin/env bash
# One rep of the PIPEFF-5 battery: fresh graph, the arm's file, a clean cost window, real projector.
#
# WHY A SCRIPT AND NOT A SEQUENCE OF COMMANDS. Sixteen reps typed by hand is sixteen chances to skip
# the graph reset, reuse a capture file, or forget to clear the ledger — and every one of those
# produces a plausible number rather than an error. The previous battery lost a rep to exactly that
# class (a raw ledger delete that contaminated an arm and cost ~$1.40 to redo).
#
# Usage:  ARM=PATCHED3 REP=1 bash scripts/graph-window-battery/run-rep.sh
# Env:    from /tmp/gwb5/env.sh (BATTERY_URL, GRAPH_LLM_PROXY_SECRET, SECRETS_KEY, GRAPH_LLM_TEAM)
set -euo pipefail

: "${ARM:?set ARM (PATCHED3|COMBINED)}"
: "${REP:?set REP}"
ARMFILE="/tmp/gwb-arms/graphiti.${ARM}.py"
[ -f "$ARMFILE" ] || { echo "no arm file $ARMFILE — run build-arms.mjs first"; exit 1; }

. /tmp/gwb5/env.sh
CAP="/tmp/gwb5/captures/capture-${ARM}-${REP}.jsonl"
mkdir -p /tmp/gwb5/captures

# A capture file that already exists would interleave two reps in one JSONL and Q8' pairs by id
# across the whole file — refuse rather than append.
[ -e "$CAP" ] && { echo "REFUSING: $CAP exists — a rep must not append to another rep's capture"; exit 1; }

echo "── ${ARM} rep ${REP} ──────────────────────────────────────────"

# 1. FRESH graph. A carried-over graph makes the next rep measure a different question (dedupe
#    candidate lists grow), which is why every rep gets its own Neo4j from empty.
docker rm -f gwb5-neo >/dev/null 2>&1 || true
docker run -d --name gwb5-neo --network gwb5net -p 7690:7687 \
  -e NEO4J_AUTH=neo4j/batterypw \
  -e NEO4J_server_memory_heap_max__size=768m --memory=1500m neo4j:5.26.2 >/dev/null
until docker exec gwb5-neo wget -qO- http://localhost:7474 >/dev/null 2>&1; do sleep 3; done

# 2. graphiti on THIS arm's file, bind-mounted so "the arms differ in one file" stays checkable.
docker rm -f gwb5-gra >/dev/null 2>&1 || true
docker run -d --name gwb5-gra --network gwb5net -p 8010:8000 \
  -v "$ARMFILE":/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py:ro \
  -e NEO4J_URI=bolt://gwb5-neo:7687 -e NEO4J_USER=neo4j -e NEO4J_PASSWORD=batterypw \
  -e PORT=8000 -e db_backend=neo4j \
  -e OPENAI_BASE_URL=http://host.docker.internal:3099/v1 \
  -e OPENAI_API_KEY="$GRAPH_LLM_PROXY_SECRET" \
  -e MODEL_NAME=qwen/qwen3.7-plus \
  aios-graphiti:0293-pinned >/dev/null
until curl -sf -m 5 localhost:8010/healthcheck >/dev/null 2>&1; do sleep 3; done

# 3. Assert the container really serves this arm — the silent-no-op hazard, checked per rep rather
#    than assumed from the mount succeeding.
IN=$(docker exec gwb5-gra grep -c "PIPEFF-5: one extraction call" /app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py || true)
P3=$(docker exec gwb5-gra grep -c "PIPEFF-2: carry only the SAME ITEM" /app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py || true)
[ "$P3" = "1" ] || { echo "REFUSING: PATCH 3 missing from the served file — the incumbent must be what prod runs"; exit 1; }
if [ "$ARM" = "COMBINED" ]; then
  [ "$IN" = "1" ] || { echo "REFUSING: COMBINED arm is not serving PATCH 4"; exit 1; }
else
  [ "$IN" = "0" ] || { echo "REFUSING: $ARM arm IS serving PATCH 4"; exit 1; }
fi
echo "  arm verified in-container: PATCH3=$P3 PATCH4=$IN"

# 4. Clean cost window + ledger. The projector must see every item as unprojected, or it pushes
#    nothing and the rep silently measures an empty run.
psql "$BATTERY_URL" -q -c "truncate llm_usage, ingest_runs, graph_episodes;" >/dev/null

# 5. Restart the tap onto this rep's capture file.
pkill -f "capture-tap.mjs" >/dev/null 2>&1 || true
sleep 1
ARM="$ARM" CAPTURE_FILE="$CAP" BRAIN_URL=http://localhost:3010 PORT=3099 \
  nohup node scripts/graph-window-battery/capture-tap.mjs > "/tmp/gwb5/tap-${ARM}-${REP}.log" 2>&1 &
sleep 3

# 6. Drive the REAL projector path — this is what writes ingest_runs.meta.episodes, without which
#    Q5 is unmeasurable and C1 loses its guard against a retry-rate shift reading as a saving.
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "  window opens $START"
# There is no HTTP trigger for projection — it is scheduler-driven. `run-projection.ts` is the
# battery's sanctioned driver: the scheduler's own runGraphProjection() + recordIngestRun() pair,
# NOT a bespoke pusher, because the second call is what writes ingest_runs.meta.episodes. Without
# that row the cost harness's cross-check is unavailable and Q5 is unmeasurable.
DATABASE_URL="$BATTERY_URL" GRAPHITI_URL=http://localhost:8010 \
  GRAPH_FANOUT_PUSH_MAX_PER_PASS=0 \
  npx tsx --conditions react-server scripts/graph-window-battery/run-projection.ts 2>&1 | sed 's/^/  /'

echo "  pushed; extraction runs async. Watch with: bash scripts/graph-window-battery/rep-status.sh"
echo "$START" > "/tmp/gwb5/window-${ARM}-${REP}.start"
