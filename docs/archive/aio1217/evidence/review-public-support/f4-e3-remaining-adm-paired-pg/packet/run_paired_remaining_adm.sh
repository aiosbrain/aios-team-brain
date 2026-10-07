#!/bin/zsh
# Parent-host-only serial runner for the retained cases 1-15 fixture. Never invoke from a model worker.
set -euo pipefail

if (( $# != 5 )); then
  print -u2 'usage: run_paired_remaining_adm.sh <reference|candidate> <zero|nonzero> <runtime-worktree> <runtime-handoff> <stage>'
  exit 64
fi

runtime_name="$1"
expected_class="$2"
runtime_worktree="$3"
runtime_handoff="$4"
stage="$5"
fixture='test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts'
fixture_sha='7ae552da7d3d637a5c545caca92322f7f3330294c696cabf7de1873bc42e3407'
runner_sha='5ec2b76bdb536bef088f8a461155e3abf7f61b59215d46b5aa7a858e7083682d'
record_rel='.context/aio1217-e4-observation-records'
packet_runner='/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e2-affected-review-frozen/packet/runner/01-immutable-e4-runner.py'

[[ "$runtime_name" == reference || "$runtime_name" == candidate ]] || { print -u2 'invalid runtime name'; exit 64; }
[[ "$expected_class" == zero || "$expected_class" == nonzero ]] || { print -u2 'expected exit must be zero or nonzero'; exit 64; }
[[ -d "$runtime_worktree/.git" || -f "$runtime_worktree/.git" ]] || { print -u2 'runtime worktree is not a Git worktree'; exit 65; }
[[ "${runtime_handoff:A:h}/aio1217-worktree" == "${runtime_worktree:A}" ]] || { print -u2 'runtime handoff must be sibling of aio1217-worktree'; exit 65; }
[[ "$(shasum -a 256 "$runtime_worktree/$fixture" | awk '{print $1}')" == "$fixture_sha" ]] || { print -u2 'fixture hash mismatch'; exit 65; }
[[ "$(shasum -a 256 "$packet_runner" | awk '{print $1}')" == "$runner_sha" ]] || { print -u2 'task runner hash mismatch'; exit 65; }

mkdir -p "$runtime_worktree/$record_rel"
rm -f "$runtime_worktree/$record_rel/requests.jsonl"
cp -p "$packet_runner" "$runtime_handoff/run_check_e4.py"
[[ "$(shasum -a 256 "$runtime_handoff/run_check_e4.py" | awk '{print $1}')" == "$runner_sha" ]] || { print -u2 'copied runner hash mismatch'; exit 65; }

set +e
(cd "$runtime_handoff" && AIO1217_E4_RECORD_DIR="$record_rel" python3 ./run_check_e4.py "$stage" pg "$fixture")
actual_exit=$?
set -e
if [[ "$expected_class" == zero ]]; then
  [[ "$actual_exit" -eq 0 ]] || { print -u2 "unexpected runner exit: $actual_exit (expected zero)"; exit 66; }
else
  [[ "$actual_exit" -ne 0 ]] || { print -u2 'unexpected runner exit: 0 (expected nonzero)'; exit 66; }
fi
[[ -s "$runtime_worktree/$record_rel/requests.jsonl" ]] || { print -u2 'recorder output missing or empty'; exit 67; }
print -- "$runtime_name stage=$stage runner_exit=$actual_exit records=$runtime_worktree/$record_rel/requests.jsonl"
