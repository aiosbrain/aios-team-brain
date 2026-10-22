#!/usr/bin/env node
/**
 * HIGH-3: does the ops runner's LAUNCH PATH actually reap an orphaned grandchild?
 *
 * Why a runtime probe exists at all. `runBoundedProcess` proves containment with `kill(-pgid, 0)`,
 * and Linux answers SUCCESS for an unreaped ZOMBIE group — which SIGKILL cannot remove. Under a
 * non-reaping PID 1 (`node`), an orphaned grandchild of the only multi-level chain here
 * (`reapplyTesters`: npx → tsx → node) leaves the group permanently "alive", so the importer spins
 * in containment holding BOTH the coordinator and exclusive data-use locks with staging stopped:
 * correct fail-closed behaviour, permanent outage.
 *
 * No static check can see this. `test/guards/staging-pair-harness.test.ts` pins the image's
 * ENTRYPOINT and the Railway override's command prefix, which is the right guard for DRIFT — but
 * both would pass against a tini that does not adopt, a `-s` that was dropped, or a platform that
 * puts something else at PID 1. And the paired harness cannot see it either: compose supplies
 * `init: true`, so docker-init reaps and masks the image's own behaviour entirely.
 *
 * WHAT THIS MEASURES, and what it refuses to infer:
 *  - the process at PID 1, by name — the launch path is reported, never assumed;
 *  - a real orphan: this process spawns a middle process that spawns a DETACHED grandchild and
 *    exits, so the grandchild is re-parented to the nearest subreaper;
 *  - REAPING, as the disappearance of `/proc/<pid>` — not as `kill(pid, 0)` failing, because a
 *    zombie answers `kill(pid, 0)` successfully and that is the entire defect;
 *  - a timeout is `confirmed: false`, NEVER `reaped: true`. "We could not look long enough" and
 *    "it was reaped" must not be the same outcome, for the same reason the containment loop refuses
 *    to release a fence it has not proved empty.
 *
 * Run it under the deployed command (`docker run <ops-image> scripts/staging-ops/reaper-probe.mjs`
 * exercises the image ENTRYPOINT verbatim) and under `--entrypoint node` as the negative control.
 * `scripts/staging-ops-reaper-check.sh` drives all three lanes.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GRANDCHILD_LIFETIME_MS = Number(process.env.REAPER_PROBE_CHILD_MS ?? 1_000);
const CONFIRM_TIMEOUT_MS = Number(process.env.REAPER_PROBE_TIMEOUT_MS ?? 15_000);
const POLL_MS = 50;

/**
 * The kernel's own view: `null` means the entry is GONE (reaped), `"Z"` means a zombie the parent
 * has not waited on. `comm` may contain spaces and parentheses, so the state is the field after the
 * LAST `)` — splitting on whitespace from the left misreads any process whose name contains one.
 */
function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return null;
  }
}

function pidOneIdentity() {
  const read = (file) => { try { return readFileSync(`/proc/1/${file}`, "utf8"); } catch { return ""; } };
  return {
    comm: read("comm").trim() || null,
    // Identities only: the argv of PID 1 is the launch path under test, never a credential carrier.
    cmdline: read("cmdline").split("\0").filter(Boolean).join(" ") || null,
  };
}

function orphanGrandchild() {
  // Three levels, matching the real chain. The middle process exits as soon as it has reported the
  // grandchild's PID, so the grandchild is orphaned while still running and is re-parented to the
  // nearest subreaper — PID 1 here.
  const middle = spawnSync(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), ${GRANDCHILD_LIFETIME_MS})"], { detached: true, stdio: "ignore" });
    child.unref();
    process.stdout.write(String(child.pid));
  `], { encoding: "utf8", timeout: 30_000 });
  if (middle.status !== 0) {
    throw new Error(`the middle process of the orphan chain failed (status ${middle.status}, signal ${middle.signal}): ${String(middle.stderr).slice(0, 300)}`);
  }
  const pid = Number(String(middle.stdout).trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`the orphan chain reported no usable grandchild pid: ${JSON.stringify(String(middle.stdout).slice(0, 100))}`);
  return pid;
}

async function main() {
  const pidOne = pidOneIdentity();
  const grandchild = orphanGrandchild();
  const startedAt = Date.now();
  let observedZombie = false;
  let lastState = procState(grandchild);
  // A grandchild that was never observed at all would make every later claim vacuous, so record
  // whether the probe ever saw it as a live process.
  const observedLive = lastState !== null && lastState !== "Z";

  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    lastState = procState(grandchild);
    if (lastState === null) break;
    if (lastState === "Z") observedZombie = true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const finalState = procState(grandchild);
  const reaped = finalState === null;
  const result = {
    pidOne, grandchild, observedLive, observedZombie,
    finalState, reaped,
    // The distinction the containment loop is built on: a run that timed out has CONFIRMED nothing.
    confirmed: reaped,
    waitedMs: Date.now() - startedAt, timeoutMs: CONFIRM_TIMEOUT_MS,
  };
  console.log(JSON.stringify(result));
  // Exit 0 on a confirmed reap, 1 on anything else. The negative-control lane EXPECTS the 1.
  process.exitCode = reaped ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ error: String(error?.message ?? error).slice(0, 300), reaped: false, confirmed: false }));
  process.exitCode = 2;
});
