#!/usr/bin/env bash
set -euo pipefail

# Required mode (the CI lane sets it): a missing engine is a FAILURE, never a quiet pass. Without
# this, "docker is not installed" and "every assertion held" are the same green tick.
if [[ "${STAGING_PAIR_REQUIRED:-}" == "1" ]]; then
  for binary in docker node; do
    command -v "$binary" >/dev/null 2>&1 || { echo "staging paired refresh lane requires $binary" >&2; exit 1; }
  done
  docker compose version >/dev/null 2>&1 || { echo "staging paired refresh lane requires the docker compose plugin" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "staging paired refresh lane requires a running Docker engine" >&2; exit 1; }
fi

project="aios-staging-pair-${USER:-runner}-$$"
harness_root="$(mktemp -d "${TMPDIR:-/tmp}/aios-staging-pair.XXXXXX")"
export STAGING_HARNESS_SECRETS_DIR="$harness_root/secrets"
node scripts/staging-ops/generate-harness-secrets.mjs "$STAGING_HARNESS_SECRETS_DIR"
export STAGING_COMPARISON_KEY_BASE64="$(tr -d '\n' < "$STAGING_HARNESS_SECRETS_DIR/exporter/comparison-key")"
compose=(docker compose -p "$project" -f compose.test.staging-pair.yml)

# Durable, REDACTED evidence. The harness root is a mktemp dir the trap deletes, so every failure
# receipt and command log used to die with the run — on CI, the only record of why a required lane
# failed. It also holds the generated keys, so "keep the directory" is not the fix: only `*.log`
# files are copied, with harness secrets, URL credentials and bearer tokens masked.
artifacts="${STAGING_PAIR_ARTIFACT_DIR:-$PWD/.staging-pair-artifacts}"

# Cleanup REPORTS what it could not clean up. `down … >/dev/null 2>&1 || true` silently tolerated a
# failed teardown, and a run whose `up` died part-way left containers behind in `Created` with no
# mention of it anywhere — so the next run inherited them and the failure looked like a new one.
cleanup() {
  if ! "${compose[@]}" down -v --remove-orphans >"$harness_root/cleanup.log" 2>&1; then
    echo "harness cleanup: 'compose down' failed for project $project" >&2
    sed -n '1,40p' "$harness_root/cleanup.log" >&2
  fi
  # Anything still labelled with THIS project — a `Created` container from a half-finished `up`, or a
  # `run --name` container from an interrupted step — removed by ID, scoped to this project only.
  local leftovers
  leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
  if [[ -n "$leftovers" ]]; then
    echo "harness cleanup: removing leftover container(s) of project $project" >&2
    # shellcheck disable=SC2086 -- deliberate word splitting: one ID per line
    docker rm -f $leftovers >>"$harness_root/cleanup.log" 2>&1 || echo "harness cleanup: could not remove every container of project $project" >&2
  fi
  node scripts/staging-ops/redact-artifacts.mjs "$harness_root" "$STAGING_HARNESS_SECRETS_DIR" "$artifacts" >/dev/null 2>&1 || true
  rm -rf -- "$harness_root"
}
trap cleanup EXIT INT TERM

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$harness_root/$label.log" 2>&1; then
    echo "expected denial unexpectedly succeeded: $label" >&2
    return 1
  fi
  echo "verified denial: $label"
}

# ── Receipts ────────────────────────────────────────────────────────────────────────────────────
# `expect_failure` alone asserts "this exited non-zero", which a preflight refusal, a container that
# never started and a discovery error satisfy exactly as well as the fault the scenario is about —
# and the follow-up `assert vN` passes because the prior pair was ALREADY installed before the
# scenario ran. So each failure scenario now also demands the specific receipts the intended
# checkpoint emits (`scripts/staging-ops/receipts.mjs`), tied to the candidate run id.
receipt() {
  local log="$1" kind="$2" pattern="$3"
  grep -F "staging-ops-receipt $kind " "$harness_root/$log" | grep -Eq "$pattern"
}

require_receipt() {
  local log="$1" kind="$2" pattern="$3" why="$4"
  if ! receipt "$log" "$kind" "$pattern"; then
    echo "missing receipt: $why (expected '$kind' matching $pattern in $log)" >&2
    sed -n '1,80p' "$harness_root/$log" >&2
    return 1
  fi
  echo "verified receipt: $why"
}

refuse_receipt() {
  local log="$1" kind="$2" pattern="$3" why="$4"
  if receipt "$log" "$kind" "$pattern"; then
    echo "unexpected receipt: $why (found '$kind' matching $pattern in $log)" >&2
    return 1
  fi
  echo "verified absence: $why"
}

journal_field() {
  "${compose[@]}" exec -T staging-pg psql -U app -d brain -Atc \
    "select coalesce($1::text,'') from staging_ops.refresh_journal where singleton=true" 2>/dev/null || true
}

require_journal() {
  local field="$1" expected="$2" why="$3"
  local observed
  observed="$(journal_field "$field")"
  if [[ "$observed" != "$expected" ]]; then
    echo "journal $field is '$observed', expected '$expected' ($why)" >&2
    return 1
  fi
  echo "verified journal: $field=$expected ($why)"
}

echo "[1/11] build and start isolated Postgres 18, Neo4j 5.26.2, and ACL object stores"
"${compose[@]}" build exporter importer fixture-controller maintenance source-object-store rollback-object-store network-spy
"${compose[@]}" up -d --wait --wait-timeout 180 prod-pg staging-pg prod-neo4j staging-neo4j source-object-store rollback-object-store network-spy
"${compose[@]}" run --rm fixture-controller seed
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs install-ops
"${compose[@]}" up -d maintenance
maintenance_ready=0
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' http://127.0.0.1:8080/identity >/dev/null 2>&1; then
    maintenance_ready=1
    break
  fi
  sleep 1
done
if [[ "$maintenance_ready" -ne 1 ]]; then
  echo "local maintenance controller did not start within 30 seconds" >&2
  exit 1
fi

echo "[2/11] prove role network and mounted-key boundaries with non-vacuous positive controls"
"${compose[@]}" run --rm --no-deps exporter scripts/staging-ops/network-boundary-probe.mjs allow prod-pg.railway.internal
"${compose[@]}" run --rm --no-deps exporter scripts/staging-ops/network-boundary-probe.mjs allow source-object-store
"${compose[@]}" run --rm --no-deps exporter scripts/staging-ops/network-boundary-probe.mjs deny staging-pg.railway.internal
"${compose[@]}" run --rm --no-deps exporter scripts/staging-ops/network-boundary-probe.mjs deny rollback-object-store
"${compose[@]}" run --rm --no-deps importer scripts/staging-ops/network-boundary-probe.mjs allow staging-pg.railway.internal
"${compose[@]}" run --rm --no-deps importer scripts/staging-ops/network-boundary-probe.mjs allow source-object-store
"${compose[@]}" run --rm --no-deps importer scripts/staging-ops/network-boundary-probe.mjs allow rollback-object-store
"${compose[@]}" run --rm --no-deps importer scripts/staging-ops/network-boundary-probe.mjs deny prod-pg.railway.internal
"${compose[@]}" run --rm --no-deps exporter scripts/staging-ops/secret-boundary-probe.mjs exporter
"${compose[@]}" run --rm --no-deps importer scripts/staging-ops/secret-boundary-probe.mjs importer

echo "[3/11] bootstrap a durable staging-owned rollback pair through the importer CLI"
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs bootstrap-rollback
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"mode":"copy-ready"}' http://127.0.0.1:8080/runtime-mode >/dev/null

echo "[4/11] export and install the first pair through separate role CLI containers"
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-1 exporter | tee "$harness_root/run-1.log"
run1_object="$(tail -n 1 "$harness_root/run-1.log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).objectId))')"
"${compose[@]}" run --rm --no-deps \
  -e PROBE_S3_ENDPOINT=http://source-object-store:9000 -e PROBE_S3_ACCESS_KEY_ID=source-read -e PROBE_S3_SECRET_ACCESS_KEY=source-read-secret \
  -e PROBE_S3_BUCKET=staging-pair -e PROBE_S3_KEY="source/$run1_object.bundle" importer scripts/staging-ops/object-store-acl-probe.mjs get
"${compose[@]}" run --rm --no-deps \
  -e PROBE_S3_ENDPOINT=http://source-object-store:9000 -e PROBE_S3_ACCESS_KEY_ID=source-publish -e PROBE_S3_SECRET_ACCESS_KEY=source-publish-secret \
  -e PROBE_S3_BUCKET=staging-pair -e PROBE_S3_KEY="source/$run1_object.bundle" exporter scripts/staging-ops/object-store-acl-probe.mjs expect-access-denied-get
"${compose[@]}" run --rm --no-deps \
  -e PROBE_S3_ENDPOINT=http://source-object-store:9000 -e PROBE_S3_ACCESS_KEY_ID=source-read -e PROBE_S3_SECRET_ACCESS_KEY=source-read-secret \
  -e PROBE_S3_BUCKET=staging-pair -e PROBE_S3_KEY=source/forbidden.bundle importer scripts/staging-ops/object-store-acl-probe.mjs expect-access-denied-put
"${compose[@]}" run --rm --no-deps \
  -e PROBE_S3_ENDPOINT=http://source-object-store:9000 -e PROBE_S3_ACCESS_KEY_ID=source-read -e PROBE_S3_SECRET_ACCESS_KEY=wrong-secret \
  -e PROBE_S3_BUCKET=staging-pair -e PROBE_S3_KEY="source/$run1_object.bundle" importer scripts/staging-ops/object-store-acl-probe.mjs expect-access-denied-get
"${compose[@]}" run --rm --no-deps -e PROBE_S3_URL="http://source-object-store:9000/staging-pair/source/$run1_object.bundle" importer scripts/staging-ops/forged-s3-auth-probe.mjs
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v1
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs install "$run1_object"

echo "[5/11] exercise second-run discovery, chunks/corrections, and a newly appearing Graphiti deployment"
"${compose[@]}" run --rm fixture-controller mutate v2
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-2 exporter
stale_graph="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"serviceId":"graphiti-local"}' http://127.0.0.1:8080/inject-deployment | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -X POST \
  "http://127.0.0.1:8080/deployments/$stale_graph/stop" >/dev/null
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"serviceId":"graphiti-local"}' http://127.0.0.1:8080/inject-deployment >/dev/null
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v2

echo "[6/11] advance staging head and catch up code without copying data again"
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"commit":"dddddddddddddddddddddddddddddddddddddddd"}' http://127.0.0.1:8080/branch-head >/dev/null
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v2

echo "[7/11] kill an importer AFTER a real Postgres write and reconcile the journal on the next worker"
"${compose[@]}" run --rm fixture-controller mutate v3
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-3 exporter
interrupted_container="${project}-interrupted-importer"
"${compose[@]}" run --name "$interrupted_container" -e STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS=120000 importer scripts/staging-ops/importer.mjs tick >"$harness_root/interrupted.log" 2>&1 & interrupted_pid=$!
# THE BARRIER IS THE POSTGRES WRITE, NOT THE JOURNAL STATE. `state=importing` is written BEFORE the
# restore begins, so killing on it can land before a single byte of candidate data exists — and a
# "recovery" from that is a recovery from nothing. Wait for run-3's own `postgres-restored` receipt
# (the importer then holds at the bounded pause), and independently confirm the two stores are in
# the state the scenario claims: candidate v3 body in Postgres, PRIOR v2 facts still in the graph.
observed_after_postgres=0
for _ in $(seq 1 90); do
  if receipt interrupted.log postgres-restored '"runId":"run-3"'; then observed_after_postgres=1; break; fi
  sleep 1
done
if [[ "$observed_after_postgres" -ne 1 ]]; then
  echo "interrupted importer never reached the post-Postgres barrier for run-3" >&2
  sed -n '1,80p' "$harness_root/interrupted.log" >&2
  exit 1
fi
staged_body="$("${compose[@]}" exec -T staging-pg psql -U app -d brain -Atc \
  "select body from items where id='33333333-3333-4333-8333-333333333331'" 2>/dev/null || true)"
if [[ "$staged_body" != "team body v3" ]]; then
  echo "expected the candidate v3 Postgres write before the kill, observed '$staged_body'" >&2
  exit 1
fi
"${compose[@]}" run --rm fixture-controller assert-graph-version v2
docker kill --signal KILL "$interrupted_container" >/dev/null
wait "$interrupted_pid" || true
docker rm -f "$interrupted_container" >/dev/null 2>&1 || true
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v2
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v3

echo "[8/11] inject handled mid-install faults after EACH store and prove prior-pair recovery"
"${compose[@]}" run --rm fixture-controller mutate v4
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-4 exporter
# NEGATIVE CONTROL FIRST. A fault BEFORE the drain replaces nothing, so it must not be able to
# satisfy this scenario — under the old assertion ("exited non-zero" + "v3 is still installed") it
# did, because v3 was already installed and nothing had been touched. The receipts below are what
# tell the two apart, so their discriminating power is demonstrated here rather than assumed.
expect_failure pre-drain-control "${compose[@]}" run --rm -e STAGING_FAULT_POINT=before-drain importer scripts/staging-ops/importer.mjs tick
require_receipt pre-drain-control fault-injected '"point":"before-drain".*"runId":"run-4"' "the control failed at the point it claims"
refuse_receipt pre-drain-control postgres-restored '"runId":"run-4"' "a pre-drain failure wrote no candidate Postgres"
refuse_receipt pre-drain-control prior-pair-restored '"failedRunId":"run-4"' "a pre-drain failure triggers no recovery, so it cannot pass the recovery scenario"
"${compose[@]}" run --rm fixture-controller assert v3

# THE REAL SCENARIO: fail after the Postgres restore, and require the exact receipts — the fault at
# the named point for THIS candidate run, and a recovery that restored BOTH stores to the prior
# identity and booted it ready — plus the journal transition and the prior data itself.
expect_failure install-fault-recovers "${compose[@]}" run --rm -e STAGING_FAULT_POINT=after-postgres importer scripts/staging-ops/importer.mjs tick
require_receipt install-fault-recovers postgres-restored '"runId":"run-4"' "the candidate Postgres restore actually happened"
require_receipt install-fault-recovers fault-injected '"point":"after-postgres".*"runId":"run-4"' "the injected fault fired after Postgres, not earlier"
require_receipt install-fault-recovers prior-pair-restored '"failedRunId":"run-4".*"postgres":true.*"graph":true.*"ready":true' "recovery restored BOTH stores and booted the prior pair ready"
require_journal state ready "staging is serving again after the handled fault"
"${compose[@]}" run --rm fixture-controller assert v3

# AND AFTER THE GRAPH, which the previous single scenario never exercised: the candidate had already
# replaced both stores, so recovery has to undo two of them, and the graph half of the oracle is the
# only thing that can see the difference.
expect_failure graph-fault-recovers "${compose[@]}" run --rm -e STAGING_FAULT_POINT=after-graph importer scripts/staging-ops/importer.mjs tick
require_receipt graph-fault-recovers graph-restored '"runId":"run-4"' "the candidate graph restore actually happened"
require_receipt graph-fault-recovers fault-injected '"point":"after-graph".*"runId":"run-4"' "the injected fault fired after the graph restore"
require_receipt graph-fault-recovers prior-pair-restored '"failedRunId":"run-4".*"postgres":true.*"graph":true.*"ready":true' "recovery restored BOTH stores after a graph-stage fault"
"${compose[@]}" run --rm fixture-controller assert v3
"${compose[@]}" run --rm fixture-controller assert-graph-version v3

echo "[9/11] prove lock loss kills the serving child, then recover through an exact deployment"
"${compose[@]}" run --rm fixture-controller kill-reader-lock
sleep 2
active_app="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' 'http://127.0.0.1:8080/deployments?serviceId=app-local')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.deployments.length)process.exit(1)' "$active_app"
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"serviceId":"app-local","commitSha":"dddddddddddddddddddddddddddddddddddddddd"}' http://127.0.0.1:8080/deploy >/dev/null

echo "[10/11] prove failed rollback stays stopped, recover, then race concurrent importers"
"${compose[@]}" run --rm fixture-controller mutate v5
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-5 exporter
expect_failure failed-rollback-stays-stopped "${compose[@]}" run --rm -e STAGING_FAULT_POINT=after-postgres -e STAGING_FAULT_ROLLBACK=1 importer scripts/staging-ops/importer.mjs tick
# The intended checkpoint, again by receipt: the install fault fired where it claims, the ROLLBACK
# then failed, and the journal is fenced at `recovery-required` — not merely "the app is stopped",
# which a failure anywhere before the drain would also produce.
require_receipt failed-rollback-stays-stopped fault-injected '"point":"after-postgres".*"runId":"run-5"' "the rollback-failure scenario failed mid-install, for this run"
require_receipt failed-rollback-stays-stopped recovery-required '"failedRunId":"run-5".*"rollbackAttempted":true' "the rollback was attempted and failed, leaving staging fenced"
refuse_receipt failed-rollback-stays-stopped prior-pair-restored '"failedRunId":"run-5"' "a failed rollback must not report a restored prior pair"
require_journal state failed "a failed rollback leaves the journal failed"
require_journal last_safe_checkpoint recovery-required "a failed rollback fences staging until an explicit recovery"
active_app="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' 'http://127.0.0.1:8080/deployments?serviceId=app-local')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.deployments.length)process.exit(1)' "$active_app"
# The PINNED SET, not just the app: a Graphiti deployment left running would still be able to write
# to the graph while staging is supposed to be fenced.
active_graphiti="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' 'http://127.0.0.1:8080/deployments?serviceId=graphiti-local')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.deployments.length)process.exit(1)' "$active_graphiti"
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs rollback recovery-after-injected-failure >"$harness_root/explicit-recovery.log" 2>&1
require_receipt explicit-recovery prior-pair-restored '"postgres":true.*"graph":true.*"ready":true' "the explicit recovery restored BOTH stores and booted ready"
require_journal state ready "explicit recovery returns staging to ready"
"${compose[@]}" run --rm fixture-controller assert v3
"${compose[@]}" run --rm fixture-controller assert-graph-version v3
"${compose[@]}" run --rm fixture-controller mutate v6
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-6 exporter
set +e
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick >"$harness_root/concurrent-a.log" 2>&1 & first=$!
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick >"$harness_root/concurrent-b.log" 2>&1 & second=$!
wait "$first"; first_status=$?
wait "$second"; second_status=$?
set -e
if [[ "$first_status" -ne 0 && "$second_status" -ne 0 ]]; then
  echo "both concurrent importers failed" >&2
  sed -n '1,160p' "$harness_root/concurrent-a.log" >&2
  sed -n '1,160p' "$harness_root/concurrent-b.log" >&2
  exit 1
fi
"${compose[@]}" run --rm fixture-controller assert v6

echo "[11/11] prove the graph version oracle can actually refuse"
# Every assertion above that says "the prior/candidate pair is installed" now depends on the graph
# half of the oracle, and an oracle that never refuses proves nothing. Rewrite ONLY the installed
# graph's fact versions — Postgres untouched — and require the assert to fail. This is deliberately
# last: it leaves the graph corrupted, and the harness is finished with it.
"${compose[@]}" run --rm fixture-controller corrupt-graph-version v99
expect_failure graph-version-oracle-refuses "${compose[@]}" run --rm fixture-controller assert v6
grep -q "graph facts from another capture survived" "$harness_root/graph-version-oracle-refuses.log" || {
  echo "the assert failed for some other reason than the graph version" >&2
  sed -n '1,40p' "$harness_root/graph-version-oracle-refuses.log" >&2
  exit 1
}
echo "staging paired refresh harness passed: isolated roles, S3 ACLs, CLI bootstrap/export/install/retry/catch-up/fault receipts/two-store recovery/rollback/lock-loss/concurrency, a graph version oracle proven able to refuse, and real application oracle reads"
