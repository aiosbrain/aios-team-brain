#!/usr/bin/env bash
set -euo pipefail

# ── HIGH-3: the ops runner's reaping, EXECUTED rather than asserted ─────────────────────────────
#
# `test/guards/staging-pair-harness.test.ts` pins the image ENTRYPOINT and the Railway override's
# command prefix. That is the right guard for DRIFT and it is not a proof: it passes against a tini
# that does not adopt, a `-s` that was dropped, a base image whose `/usr/bin/tini` is a stub, or a
# platform that puts something else at PID 1. The paired harness cannot see it either — compose sets
# `init: true`, so docker-init reaps and masks the image's own behaviour completely.
#
# So this runs the deployed launch path for real, three lanes:
#
#   1. IMAGE ENTRYPOINT   — `docker run <image> <probe>`, which is exactly what the ENTRYPOINT does.
#   2. RAILWAY OVERRIDE   — the command prefix read OUT of `config/staging-ops/schedules.json`, the
#                           path that actually runs in production and never executes the ENTRYPOINT.
#   3. NEGATIVE CONTROL   — `--entrypoint node`, the shape the incident happened under. It must FAIL
#                           to reap; a probe that cannot observe the defect proves nothing about the
#                           two lanes above.
#
# It is a DIAGNOSTIC COMMAND, not a CI dependency: it builds an image and takes minutes. Run it when
# the ops image, its base, or the schedules command changes.
#
# Deliberately NOT `--init`: supplying docker-init would reap on every lane and make all three pass.
# Nothing here resets Docker globally — one uniquely tagged image and uniquely named containers,
# removed on exit, and no `docker system prune`, no `compose down` of anything it did not create.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

command -v docker >/dev/null 2>&1 || { echo "the ops reaper check requires docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "the ops reaper check requires a running Docker engine" >&2; exit 1; }

tag="aios-staging-ops-reaper-check:${USER:-runner}-$$"
container_prefix="aios-reaper-check-${USER:-runner}-$$"
probe="scripts/staging-ops/reaper-probe.mjs"
# Bounded, and reported as UNCONFIRMED rather than as a pass if it runs out — the same rule the
# containment loop follows when it refuses to release a fence it has not proved empty.
confirm_timeout_ms="${REAPER_CHECK_TIMEOUT_MS:-15000}"

cleanup() {
  for lane in entrypoint override control; do
    docker rm -f "${container_prefix}-${lane}" >/dev/null 2>&1 || true
  done
  # Only the image THIS run built, by its unique tag.
  docker image rm -f "$tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# The override prefix is READ from the deployed configuration, never restated here: a check that
# spelled it out itself would keep passing after the configuration changed underneath it.
mapfile -t override_prefix < <(node -e '
const schedules = JSON.parse(require("node:fs").readFileSync("config/staging-ops/schedules.json", "utf8"));
const commands = Object.values(schedules.services).map((service) => service.command);
const prefixes = new Set(commands.map((command) => JSON.stringify(command.slice(0, 4))));
if (prefixes.size !== 1) { console.error("the scheduled services do not share one launch prefix: " + [...prefixes].join(" vs ")); process.exit(1); }
process.stdout.write(JSON.parse([...prefixes][0]).join("\n"));
')
[[ "${#override_prefix[@]}" -eq 4 ]] || { echo "could not read a four-part launch prefix from schedules.json" >&2; exit 1; }
echo "deployed launch prefix: ${override_prefix[*]}"

echo "[1/4] build the ops runner image under a tag unique to this run"
docker build -f docker/staging-ops.Dockerfile -t "$tag" . >/dev/null

# Runs one lane and prints its probe JSON. Returns the probe's exit status; never masks it.
run_lane() {
  local lane="$1"; shift
  local status=0
  docker run --rm --name "${container_prefix}-${lane}" \
    -e "REAPER_PROBE_TIMEOUT_MS=${confirm_timeout_ms}" \
    "$@" >"$repo_root/.reaper-check-${lane}.json" 2>&1 || status=$?
  echo "lane ${lane}: $(cat "$repo_root/.reaper-check-${lane}.json")"
  return "$status"
}

# `reaped` AND `confirmed`, and the PID-1 identity the lane claims to be testing. A lane that passed
# because something else was PID 1 would not be a test of this image at all.
assert_reaped() {
  local lane="$1" expect_pid_one="$2"
  node -e '
const fs = require("node:fs");
const [lane, expected, file] = process.argv.slice(1);
const raw = fs.readFileSync(file, "utf8").trim().split("\n").pop();
let result;
try { result = JSON.parse(raw); } catch { console.error(`lane ${lane} produced no probe result: ${raw.slice(0, 300)}`); process.exit(1); }
if (result.error) { console.error(`lane ${lane} failed to run its probe: ${result.error}`); process.exit(1); }
if (result.pidOne?.comm !== expected) { console.error(`lane ${lane} ran under PID 1 "${result.pidOne?.comm}", expected "${expected}" — this lane did not exercise the path it names`); process.exit(1); }
if (!result.observedLive) { console.error(`lane ${lane} never observed a live grandchild, so it proved nothing`); process.exit(1); }
if (!result.confirmed) { console.error(`lane ${lane} did NOT confirm reaping within ${result.timeoutMs}ms (final state ${result.finalState})`); process.exit(1); }
if (!result.reaped) { console.error(`lane ${lane} reported confirmed without reaped, which is a contradiction`); process.exit(1); }
console.log(`verified: ${lane} reaped its orphaned grandchild under PID 1 "${result.pidOne.comm}" in ${result.waitedMs}ms`);
' "$lane" "$expect_pid_one" "$repo_root/.reaper-check-${lane}.json"
}

echo "[2/4] the IMAGE ENTRYPOINT reaps an orphaned grandchild"
run_lane entrypoint "$tag" "$probe"
assert_reaped entrypoint tini

echo "[3/4] the RAILWAY OVERRIDE command reaps it too — the hosted path never runs the ENTRYPOINT"
run_lane override --entrypoint "${override_prefix[0]}" "$tag" "${override_prefix[@]:1}" "$probe"
assert_reaped override tini

echo "[4/4] NEGATIVE CONTROL: without the reaper the orphan survives as a zombie"
control_status=0
run_lane control --entrypoint node "$tag" "$probe" || control_status=$?
if [[ "$control_status" -eq 0 ]]; then
  echo "the negative control REAPED the orphan, so this probe cannot detect the defect it exists for" >&2
  exit 1
fi
node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").pop();
const result = JSON.parse(raw);
if (result.error) { console.error(`the negative control failed to run its probe: ${result.error}`); process.exit(1); }
if (result.pidOne?.comm !== "node") { console.error(`the negative control ran under PID 1 "${result.pidOne?.comm}", so it is not the un-reaped shape`); process.exit(1); }
if (!result.observedZombie || result.finalState !== "Z") { console.error(`the negative control did not leave a zombie (final state ${result.finalState}); the probe cannot see the defect`); process.exit(1); }
console.log("verified: the negative control left an unreaped zombie, so the two lanes above are real observations");
' "$repo_root/.reaper-check-control.json"

rm -f "$repo_root"/.reaper-check-*.json
echo "ops runner reaping confirmed on the deployed ENTRYPOINT and the Railway override command, with a control that can fail"
