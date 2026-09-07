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

cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
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

echo "[1/10] build and start isolated Postgres 18, Neo4j 5.26.2, and ACL object stores"
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

echo "[2/10] prove role network and mounted-key boundaries with non-vacuous positive controls"
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

echo "[3/10] bootstrap a durable staging-owned rollback pair through the importer CLI"
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs bootstrap-rollback
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"mode":"copy-ready"}' http://127.0.0.1:8080/runtime-mode >/dev/null

echo "[4/10] export and install the first pair through separate role CLI containers"
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

echo "[5/10] exercise second-run discovery, chunks/corrections, and a newly appearing Graphiti deployment"
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

echo "[6/10] advance staging head and catch up code without copying data again"
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"commit":"dddddddddddddddddddddddddddddddddddddddd"}' http://127.0.0.1:8080/branch-head >/dev/null
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v2

echo "[7/10] kill an importer mid-restore and reconcile the durable journal on the next worker"
"${compose[@]}" run --rm fixture-controller mutate v3
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-3 exporter
interrupted_container="${project}-interrupted-importer"
"${compose[@]}" run --name "$interrupted_container" -e STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS=120000 importer scripts/staging-ops/importer.mjs tick >"$harness_root/interrupted.log" 2>&1 & interrupted_pid=$!
observed_importing=0
for _ in $(seq 1 60); do
  state="$("${compose[@]}" exec -T staging-pg psql -U app -d brain -Atc "select state from staging_ops.refresh_journal where singleton=true" 2>/dev/null || true)"
  if [[ "$state" == "importing" ]]; then observed_importing=1; break; fi
  sleep 1
done
if [[ "$observed_importing" -ne 1 ]]; then echo "interrupted importer never reached importing" >&2; exit 1; fi
docker kill --signal KILL "$interrupted_container" >/dev/null
wait "$interrupted_pid" || true
docker rm -f "$interrupted_container" >/dev/null 2>&1 || true
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v2
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v3

echo "[8/10] inject a handled mid-install fault and prove automatic prior-pair recovery"
"${compose[@]}" run --rm fixture-controller mutate v4
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-4 exporter
expect_failure install-fault-recovers "${compose[@]}" run --rm -e STAGING_FAULT_POINT=after-postgres importer scripts/staging-ops/importer.mjs tick
"${compose[@]}" run --rm fixture-controller assert v3

echo "[9/10] prove lock loss kills the serving child, then recover through an exact deployment"
"${compose[@]}" run --rm fixture-controller kill-reader-lock
sleep 2
active_app="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' 'http://127.0.0.1:8080/deployments?serviceId=app-local')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.deployments.length)process.exit(1)' "$active_app"
"${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' -H 'content-type: application/json' \
  -d '{"serviceId":"app-local","commitSha":"dddddddddddddddddddddddddddddddddddddddd"}' http://127.0.0.1:8080/deploy >/dev/null

echo "[10/10] prove failed rollback stays stopped, recover, then race concurrent importers"
"${compose[@]}" run --rm fixture-controller mutate v5
"${compose[@]}" run --rm -e STAGING_BUNDLE_RUN_ID=run-5 exporter
expect_failure failed-rollback-stays-stopped "${compose[@]}" run --rm -e STAGING_FAULT_POINT=after-postgres -e STAGING_FAULT_ROLLBACK=1 importer scripts/staging-ops/importer.mjs tick
active_app="$("${compose[@]}" exec -T maintenance curl -fsS -H 'authorization: Bearer local-maintenance-token' 'http://127.0.0.1:8080/deployments?serviceId=app-local')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.deployments.length)process.exit(1)' "$active_app"
"${compose[@]}" run --rm importer scripts/staging-ops/importer.mjs rollback recovery-after-injected-failure
"${compose[@]}" run --rm fixture-controller assert v3
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
echo "staging paired refresh harness passed: isolated roles, S3 ACLs, CLI bootstrap/export/install/retry/catch-up/fault/rollback/lock-loss/concurrency, and real application oracle reads"
