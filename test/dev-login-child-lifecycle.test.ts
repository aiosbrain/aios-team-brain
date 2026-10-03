import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { allocateLoopbackPort, loopbackPortAccepts, rawGet } from "./http/dev-login-dev-setup";

// Spec (AIO-1210 AC08, docs/design/aio1210-dev-login.md): "Stop/reap children on every outcome", and
// never stop a server the carrier did not start. The carrier's children are DETACHED process groups,
// so a SIGINT/SIGTERM that ends the process holding them — Ctrl-C, a CI cancel, a runner timeout —
// would by default leave a dev server, possibly with the dev-login opt-in on, listening afterwards.
//
// These cases drive the ACTUAL lifecycle helper (`startNextChild` in test/http/dev-login-dev-setup.ts)
// from a harmless supervisor process, then signal that supervisor for real:
//
//   - the owned listeners are gone by the time the supervisor has terminated, including a forked
//     listener whose group leader had already exited;
//   - a listener that CLOSED ITS PORT but kept running is still owned: the port is not the evidence
//     that a group is gone, and neither a signalled nor an ordinary stop() reports it clean;
//   - the supervisor still terminates BY the signal it was sent, and a repeated signal does not cut
//     the cleanup short;
//   - an unrelated listener the supervisor never started is still serving afterwards.
//
// The supervisor is the process that OWNS the groups, signalled directly. The carrier's real owner is
// a Vitest forks worker, so the last block runs the installed Vitest for real over the same helper
// and stand-in, and signals the run's whole process group — the path a terminal Ctrl-C or a runner
// cancelling the command takes. A signal to the Vitest main process alone is a different thing and
// is only observed there, never promised.
//
// What stands in for Next is a tiny script at the path the helper launches
// (`node_modules/next/dist/bin/next` of a disposable temp directory): `start` is one listening
// process, `dev` is a leader that forks the listener into its own group — the shape of `next dev`.
// It serves a per-run nonce and its pid on /api/health, so every "this port is ours" below is a fact
// about that process and not about whatever happens to hold the port. Nothing here runs Next, touches
// a database or the task checkout, or signals a process this file did not start.

const HELPER = join(process.cwd(), "test", "http", "dev-login-dev-setup.ts");
const VITEST = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

const FAKE_NEXT = [
  '"use strict";',
  'const http = require("node:http");',
  'const { fork } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  "const args = process.argv.slice(2);",
  "const command = args[0];",
  'const host = args[args.indexOf("--hostname") + 1];',
  'const port = Number(args[args.indexOf("--port") + 1]);',
  'const worker = process.env.AIO1210_FAKE_ROLE === "worker";',
  'const mode = process.env.AIO1210_FAKE_WORKER_MODE || "prompt";',
  'const pids = (listener) => writeFileSync("fake-next-" + port + ".json", JSON.stringify({ leader: process.pid, listener }));',
  'if (command === "start" || worker) {',
  // A listener that ignores SIGTERM, or takes its time over it, as a busy dev server can.
  '  if (worker && mode === "stubborn") process.on("SIGTERM", () => {});',
  '  if (worker && mode === "slow") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500));',
  "  const server = http.createServer((req, res) => {",
  '    res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });',
  "    res.end(JSON.stringify({ nonce: process.env.AIO1210_FAKE_NONCE, pid: process.pid }));",
  "  });",
  "  server.listen(port, host);",
  // Next's own shutdown order, stopped half-way: on SIGTERM the listener closes, and the process
  // never exits. The interval is the harmless handle that keeps it running with its port closed.
  '  if (worker && mode === "lingering") {',
  '    process.on("SIGTERM", () => {',
  "      server.close();",
  "      server.closeAllConnections();",
  "      setInterval(() => {}, 1000);",
  "    });",
  "  }",
  "  if (!worker) pids(process.pid);",
  "} else {",
  // `next dev` shape: the leader serves nothing; a forked member of the SAME group owns the port.
  '  const child = fork(__filename, args, { env: { ...process.env, AIO1210_FAKE_ROLE: "worker" } });',
  "  pids(child.pid);",
  // The leader can be told to exit alone, leaving its listener behind (as a crashed leader would).
  '  process.on("SIGUSR2", () => process.exit(0));',
  "}",
  "",
].join("\n");

const SUPERVISOR = [
  '"use strict";',
  "const { allocateLoopbackPort, startNextChild } = require(process.env.AIO1210_HELPER);",
  "(async () => {",
  "  const owned = [];",
  "  const children = [];",
  "  for (const spec of JSON.parse(process.env.AIO1210_GROUPS)) {",
  "    const port = await allocateLoopbackPort();",
  "    const child = await startNextChild({",
  "      label: spec.label,",
  "      command: spec.command,",
  "      port,",
  "      cwd: process.env.AIO1210_FIXTURE,",
  "      readyTimeoutMs: 30000,",
  "      env: {",
  "        PATH: process.env.PATH,",
  "        AIO1210_FAKE_NONCE: process.env.AIO1210_FAKE_NONCE,",
  "        AIO1210_FAKE_WORKER_MODE: spec.mode,",
  "      },",
  "    });",
  "    owned.push(child);",
  "    children.push({ label: spec.label, pid: child.pid, port: child.port });",
  "  }",
  // An ORDINARY stop, asked for with SIGUSR2: await each child's own stop(), then — in this same
  // process, the moment it settled — ask the group itself (signal 0 delivers nothing) what is left.
  '  process.on("SIGUSR2", async () => {',
  "    const stopped = [];",
  "    for (const child of owned) {",
  "      const entry = { label: child.label };",
  "      try {",
  "        entry.record = await child.stop();",
  "      } catch (err) {",
  "        entry.error = String(err && err.message);",
  "      }",
  "      try {",
  "        process.kill(-child.pid, 0);",
  '        entry.group = "present";',
  "      } catch (err) {",
  '        entry.group = err.code === "ESRCH" ? "gone" : String(err.code);',
  "      }",
  "      stopped.push(entry);",
  "    }",
  '    process.stdout.write("SUPERVISOR_STOPPED " + JSON.stringify(stopped) + "\\n", () => process.exit(0));',
  "  });",
  '  process.stdout.write("SUPERVISOR_READY " + JSON.stringify({ pid: process.pid, children }) + "\\n");',
  // Stay up: only a signal ends this process, and installing no SIGINT/SIGTERM handler of its own is
  // the point.
  "  setInterval(() => {}, 60000);",
  "})().catch((err) => {",
  '  process.stderr.write("SUPERVISOR_FAILED " + String(err && err.message) + "\\n");',
  "  process.exit(70);",
  "});",
  "",
].join("\n");

// The carrier's process shape with nothing of the carrier's in it: the INSTALLED Vitest, run for real
// over one generated test file in the disposable directory. The config names no pool — neither does
// vitest.dev-login.config.ts — so the test file runs in whatever this Vitest uses by default, and the
// cases below MEASURE that it is a forked child of the main process before relying on it.
const TOPOLOGY_CONFIG = [
  "export default {",
  "  test: {",
  '    environment: "node",',
  "    globals: true,",
  '    include: ["topology.test.mjs"],',
  "    fileParallelism: false,",
  "    testTimeout: 120000,",
  "  },",
  "};",
  "",
].join("\n");

interface Fixture {
  dir: string;
  next: string;
  /** What every listener of THIS run answers with. */
  nonce: string;
}

interface GroupSpec {
  label: string;
  command: "start" | "dev";
  mode: "prompt" | "stubborn" | "slow" | "lingering";
}

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface StartedChild {
  label: string;
  pid: number;
  port: number;
}

interface Supervised {
  proc: ChildProcess;
  ready: { pid: number; children: StartedChild[] };
  stdout(): string;
  /** Resolves once the supervisor has exited AND its output has been read to the end. */
  ended: Promise<Ended>;
}

interface VitestRun {
  /** The Vitest MAIN process. Spawned detached, so it leads the process group the whole run is in. */
  proc: ChildProcess;
  /** What the process that ran the test file said about itself, and the children it started. */
  ready: { pid: number; parent: number; ipc: boolean; children: StartedChild[] };
  output(): string;
  /** Resolves once the main process has exited. */
  ended: Promise<Ended>;
}

interface OwnedListener {
  label: string;
  port: number;
  leader: number;
  listener: number;
}

interface Health {
  status: number;
  nonce?: string;
  pid?: number;
}

const roots: string[] = [];
const processes: ChildProcess[] = [];
const listeners: { port: number; nonce: string }[] = [];
/** Fixture processes shown to be THIS run's while they still answered: the only pids hygiene may use. */
const verified: { label: string; pids: number[] }[] = [];

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

async function health(port: number): Promise<Health> {
  const res = await rawGet({ port, path: "/api/health", headers: { host: `127.0.0.1:${port}` }, timeoutMs: 5000 });
  return { status: res.status, ...(JSON.parse(res.body) as { nonce?: string; pid?: number }) };
}

function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aio1210-lifecycle-")));
  roots.push(dir);
  // Disposable, and never inside the task checkout.
  expect(dir.startsWith(realpathSync(process.cwd()) + sep)).toBe(false);
  const bin = join(dir, "node_modules", "next", "dist", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "next"), FAKE_NEXT);
  writeFileSync(join(dir, "supervisor.cjs"), SUPERVISOR);
  return { dir, next: join(bin, "next"), nonce: randomUUID() };
}

/** Only what Node needs to start: nothing ambient decides what the fixture processes do. */
function baseEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Start the supervisor and wait for it to report its owned children READY. Anything else — it
 * exited, the helper refused, a port collided — is thrown here as a setup failure, so it can never
 * be read as a cleanup that worked.
 */
async function supervise(fx: Fixture, groups: GroupSpec[]): Promise<Supervised> {
  // `--import tsx` (resolved from the task root's installed dependencies) lets the supervisor load
  // the helper's TypeScript in ONE process: the pid signalled below is the process holding the groups.
  const proc = spawn(process.execPath, ["--import", "tsx", join(fx.dir, "supervisor.cjs")], {
    cwd: process.cwd(),
    env: baseEnv({
      AIO1210_HELPER: HELPER,
      AIO1210_FIXTURE: fx.dir,
      AIO1210_GROUPS: JSON.stringify(groups),
      AIO1210_FAKE_NONCE: fx.nonce,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(proc);
  let out = "";
  let err = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  let finished: Ended | null = null;
  const ended = new Promise<Ended>((resolvePromise) => {
    proc.once("close", (code, endedBy) => {
      finished = { code, signal: endedBy };
      resolvePromise(finished);
    });
  });

  const readyLine = (): string | undefined => out.split("\n").find((line) => line.startsWith("SUPERVISOR_READY "));
  const sawReady = await eventually(() => readyLine() !== undefined || finished !== null, 60_000);
  const line = readyLine();
  if (!sawReady || line === undefined) {
    throw new Error(
      `lifecycle fixture: the supervisor never reported READY (ended: ${JSON.stringify(finished)})\n--- stderr ---\n${err.slice(-2000)}`
    );
  }
  const ready = JSON.parse(line.slice("SUPERVISOR_READY ".length)) as Supervised["ready"];
  for (const child of ready.children) listeners.push({ port: child.port, nonce: fx.nonce });
  return { proc, ready, stdout: () => out, ended };
}

/** The generated test file of the inner Vitest run: the supervisor's job, done inside a Vitest worker. */
function topologyTest(fx: Fixture, groups: GroupSpec[], readyFile: string): string {
  return [
    'import { renameSync, writeFileSync } from "node:fs";',
    `const HELPER = ${JSON.stringify(HELPER)};`,
    `const FIXTURE = ${JSON.stringify(fx.dir)};`,
    `const NONCE = ${JSON.stringify(fx.nonce)};`,
    `const GROUPS = ${JSON.stringify(groups)};`,
    `const READY = ${JSON.stringify(readyFile)};`,
    'it("starts its owned children through the lifecycle helper and holds them until the run is cancelled", async () => {',
    "  const { allocateLoopbackPort, startNextChild } = await import(HELPER);",
    "  const children = [];",
    "  for (const spec of GROUPS) {",
    "    const port = await allocateLoopbackPort();",
    "    const child = await startNextChild({",
    "      label: spec.label,",
    "      command: spec.command,",
    "      port,",
    "      cwd: FIXTURE,",
    "      readyTimeoutMs: 30000,",
    "      env: { PATH: process.env.PATH, AIO1210_FAKE_NONCE: NONCE, AIO1210_FAKE_WORKER_MODE: spec.mode },",
    "    });",
    "    children.push({ label: spec.label, pid: child.pid, port: child.port });",
    "  }",
    // What this process IS, said by itself: its pid, its parent, and whether it has an IPC channel.
    '  const ready = { pid: process.pid, parent: process.ppid, ipc: typeof process.send === "function", children };',
    '  writeFileSync(READY + ".tmp", JSON.stringify(ready));',
    '  renameSync(READY + ".tmp", READY);',
    // Never settles: only a cancellation of the run ends this test.
    "  await new Promise(() => {});",
    "});",
    "",
  ].join("\n");
}

/**
 * Start a real `vitest run` in the disposable directory, leading a process group of its own, and
 * wait for its test file to report the children it started. As with `supervise`, anything else is a
 * setup failure thrown here — never a cancellation that worked.
 */
async function vitestRun(fx: Fixture, groups: GroupSpec[]): Promise<VitestRun> {
  const config = join(fx.dir, "vitest.config.mjs");
  const readyFile = join(fx.dir, "topology-ready.json");
  writeFileSync(config, TOPOLOGY_CONFIG);
  writeFileSync(join(fx.dir, "topology.test.mjs"), topologyTest(fx, groups, readyFile));
  // detached: this run is its own process group, as a command started from a shell is. Its forked
  // worker stays in that group; the helper's children lead groups of their own and are not in it.
  const proc = spawn(process.execPath, [VITEST, "run", "--root", fx.dir, "--config", config], {
    cwd: fx.dir,
    env: baseEnv({}),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  processes.push(proc);
  let text = "";
  const capture = (chunk: Buffer) => {
    text += chunk.toString("utf8");
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);
  let finished: Ended | null = null;
  const ended = new Promise<Ended>((resolvePromise) => {
    proc.once("exit", (code, endedBy) => {
      finished = { code, signal: endedBy };
      resolvePromise(finished);
    });
  });

  const sawReady = await eventually(() => existsSync(readyFile) || finished !== null, 60_000);
  if (!sawReady || !existsSync(readyFile)) {
    if (proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined) {
      // Still running, so the group it leads is this file's: ask the whole run to stop, then insist.
      signal(-proc.pid, "SIGTERM");
      if ((await within(ended, 15_000)) === null) signal(-proc.pid, "SIGKILL");
    }
    throw new Error(
      `lifecycle fixture: the Vitest run never reported its children READY (ended: ${JSON.stringify(finished)})\n--- output ---\n${text.slice(-2000)}`
    );
  }
  const ready = JSON.parse(readFileSync(readyFile, "utf8")) as VitestRun["ready"];
  for (const child of ready.children) listeners.push({ port: child.port, nonce: fx.nonce });
  verified.push({ label: "vitest worker", pids: [ready.pid] });
  return { proc, ready, output: () => text, ended };
}

/**
 * Measured, not assumed: the test file ran in a process of its own, forked by the Vitest main
 * process (an IPC channel, and that parent) — the topology the dedicated carrier runs in.
 */
function expectForksTopology(run: VitestRun): void {
  expect(run.proc.pid).toBeDefined();
  expect(run.ready.pid).not.toBe(run.proc.pid);
  expect(run.ready.parent).toBe(run.proc.pid);
  expect(run.ready.ipc).toBe(true);
  expect(alive(run.ready.pid)).toBe(true);
}

/**
 * Before any signal: each owned port is answered by THIS run's stand-in, by the process the
 * stand-in says is its listener, under the leader the helper says it started.
 */
async function ownedListeners(fx: Fixture, started: { ready: { children: StartedChild[] } }): Promise<OwnedListener[]> {
  const owned: OwnedListener[] = [];
  for (const child of started.ready.children) {
    const pids = JSON.parse(readFileSync(join(fx.dir, `fake-next-${child.port}.json`), "utf8")) as {
      leader: number;
      listener: number;
    };
    expect(pids.leader).toBe(child.pid);
    expect(await health(child.port)).toEqual({ status: 200, nonce: fx.nonce, pid: pids.listener });
    expect(alive(pids.leader)).toBe(true);
    expect(alive(pids.listener)).toBe(true);
    owned.push({ label: child.label, port: child.port, leader: pids.leader, listener: pids.listener });
    verified.push({ label: child.label, pids: [...new Set([pids.leader, pids.listener])] });
  }
  return owned;
}

/** A listener the supervisor never started: its own process group, its own nonce. */
async function unrelatedListener(fx: Fixture): Promise<{ proc: ChildProcess; port: number; nonce: string }> {
  const port = await allocateLoopbackPort();
  const nonce = randomUUID();
  const proc = spawn(process.execPath, [fx.next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fx.dir,
    env: baseEnv({ AIO1210_FAKE_NONCE: nonce }),
    stdio: "ignore",
    detached: true,
  });
  processes.push(proc);
  if (!(await eventually(() => loopbackPortAccepts(port, 500), 20_000))) {
    throw new Error("lifecycle fixture: the unrelated control listener never started");
  }
  expect(await health(port)).toEqual({ status: 200, nonce, pid: proc.pid });
  return { proc, port, nonce };
}

/** Signal one process — or, given a negative pid, the process group this file started under it. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** The process's termination, or null if it is still running at the deadline. */
function within(ended: Promise<Ended>, timeoutMs: number): Promise<Ended | null> {
  return Promise.race([ended, sleep(timeoutMs).then(() => null)]);
}

function cleanupRecords(stdout: string): { label: string; forced: boolean; groupGone: boolean; portClosed: boolean }[] {
  const prefix = "DEV_LOGIN_CHILD_CLEANUP_OK ";
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map(
      (line) => JSON.parse(line.slice(prefix.length)) as { label: string; forced: boolean; groupGone: boolean; portClosed: boolean }
    )
    .sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** What the supervisor reported after an ordinary stop(): each record, and the group as it then was. */
function stoppedReport(stdout: string): unknown {
  const prefix = "SUPERVISOR_STOPPED ";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : JSON.parse(line.slice(prefix.length));
}

/** A verified fixture pid is gone within the bound. One SEEN gone is forgotten: never signalled later. */
async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const isGone = await eventually(() => !alive(pid), timeoutMs);
  if (isGone) for (const entry of verified) entry.pids = entry.pids.filter((known) => known !== pid);
  return isGone;
}

/** Owned listeners are gone NOW — asked the moment the supervisor has terminated, with no grace. */
async function expectOwnedGone(owned: OwnedListener[]): Promise<void> {
  for (const group of owned) {
    expect(await loopbackPortAccepts(group.port, 500), `${group.label}: port ${group.port} still accepts`).toBe(false);
  }
  // A killed grandchild is reaped by init, not by this process: allow that a moment.
  for (const group of owned) {
    expect(await gone(group.leader, 5000), `${group.label}: leader still running`).toBe(true);
    expect(await gone(group.listener, 5000), `${group.label}: listener still running`).toBe(true);
  }
}

/** Verified fixture processes still running, by label. Observation only. */
function leftovers(): { label: string; pids: number[] }[] {
  return verified.map(({ label, pids }) => ({ label, pids: pids.filter(alive) })).filter((entry) => entry.pids.length > 0);
}

/** SIGKILL what is still running of the verified fixture pids; true once all of it is gone (bounded). */
async function reapVerified(): Promise<boolean> {
  const pids = leftovers().flatMap((entry) => entry.pids);
  verified.length = 0;
  for (const pid of pids) signal(pid, "SIGKILL");
  return eventually(() => pids.every((pid) => !alive(pid)), 10_000);
}

// Hygiene for a FAILED case only: a passing one leaves nothing (the main-only observation removes
// what it left itself, and says so). What a failed case left running is NAMED first, then removed:
// a fixture listener whose port still answers with this run's nonce, by the pid it reports — and,
// because one that closed its port answers nothing, the pids verified as this run's before any
// signal. Never by a port alone, a name or a guess. Nothing done here is a cleanup result.
afterEach(async () => {
  const left = leftovers();
  if (left.length > 0) console.error(`LIFECYCLE_FIXTURE_LEFTOVER ${JSON.stringify(left)}`);
  for (const proc of processes.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  for (const { port, nonce } of listeners.splice(0)) {
    if (!(await loopbackPortAccepts(port, 500))) continue;
    try {
      const answer = await health(port);
      if (answer.nonce === nonce && typeof answer.pid === "number") signal(answer.pid, "SIGKILL");
    } catch {
      // nothing of this run's is answering there
    }
  }
  await reapVerified();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DEADLINE_MS = 45_000;
/** How long the main-only observation watches for the worker to notice on its own. */
const MAIN_ONLY_WINDOW_MS = 5_000;

describe("dev-login carrier child lifecycle under SIGINT/SIGTERM (real processes, stand-in Next)", () => {
  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "%s stops every owned listener — a single process and a leader with a forked listener — then terminates by that signal; an unrelated listener is untouched",
    async (name) => {
      const fx = fixture();
      const control = await unrelatedListener(fx);
      const supervised = await supervise(fx, [
        { label: "start-like", command: "start", mode: "prompt" },
        { label: "dev-like", command: "dev", mode: "prompt" },
      ]);
      // One process: the pid signalled is the one that holds the owned groups.
      expect(supervised.ready.pid).toBe(supervised.proc.pid);
      const owned = await ownedListeners(fx, supervised);
      expect(owned.map((group) => group.label)).toEqual(["start-like", "dev-like"]);
      expect(owned[1].listener).not.toBe(owned[1].leader);
      expect(supervised.proc.exitCode).toBeNull();
      expect(supervised.proc.signalCode).toBeNull();

      signal(supervised.ready.pid, name);

      // Terminated BY the signal (not an exit code, not a setup failure), within the finite deadline.
      expect(await within(supervised.ended, DEADLINE_MS)).toEqual({ code: null, signal: name });
      await expectOwnedGone(owned);
      expect(cleanupRecords(supervised.stdout())).toMatchObject([
        { label: "dev-like", portClosed: true },
        { label: "start-like", portClosed: true },
      ]);

      // The listener this supervisor did not start is the same process, still serving.
      expect(control.proc.exitCode).toBeNull();
      expect(control.proc.signalCode).toBeNull();
      expect(await health(control.port)).toEqual({ status: 200, nonce: control.nonce, pid: control.proc.pid });
    },
    90_000
  );

  it(
    "a forked listener whose leader already exited is still cleaned up — escalating past a listener that ignores SIGTERM",
    async () => {
      const fx = fixture();
      const control = await unrelatedListener(fx);
      const supervised = await supervise(fx, [{ label: "dev-orphaned", command: "dev", mode: "stubborn" }]);
      const [group] = await ownedListeners(fx, supervised);

      // The leader exits on its own; its listener keeps the port. (A fixture process of this file.)
      signal(group.leader, "SIGUSR2");
      expect(await eventually(() => !alive(group.leader), 10_000)).toBe(true);
      expect(await health(group.port)).toEqual({ status: 200, nonce: fx.nonce, pid: group.listener });
      expect(supervised.proc.exitCode).toBeNull();

      signal(supervised.ready.pid, "SIGTERM");

      expect(await within(supervised.ended, DEADLINE_MS)).toEqual({ code: null, signal: "SIGTERM" });
      await expectOwnedGone([group]);
      // SIGTERM was not enough for this listener: the owned group was killed, and the port closed.
      expect(cleanupRecords(supervised.stdout())).toMatchObject([{ label: "dev-orphaned", forced: true, portClosed: true }]);
      expect(await health(control.port)).toEqual({ status: 200, nonce: control.nonce, pid: control.proc.pid });
    },
    90_000
  );

  // Installed Next closes its listener BEFORE the rest of its shutdown (start-server.js: server.close,
  // then the awaited cleanup, then exit), so "the port closed" and "the server process is gone" are
  // different facts. A cleanup that stops at the first one forgets a process it still owns.
  it(
    "a forked listener that closes its port on SIGTERM but keeps running — its leader already gone — is still owned: it is killed and reported forced before the supervisor ends",
    async () => {
      const fx = fixture();
      const control = await unrelatedListener(fx);
      const supervised = await supervise(fx, [{ label: "dev-lingering", command: "dev", mode: "lingering" }]);
      const [group] = await ownedListeners(fx, supervised);

      // The leader exits on its own; its listener keeps the port and still answers as this run's.
      signal(group.leader, "SIGUSR2");
      expect(await eventually(() => !alive(group.leader), 10_000)).toBe(true);
      expect(await health(group.port)).toEqual({ status: 200, nonce: fx.nonce, pid: group.listener });
      expect(supervised.proc.exitCode).toBeNull();

      signal(supervised.ready.pid, "SIGTERM");

      expect(await within(supervised.ended, DEADLINE_MS)).toEqual({ code: null, signal: "SIGTERM" });
      // The port closed on the first SIGTERM. The PROCESS behind it must be gone as well.
      await expectOwnedGone([group]);
      // Truthful record: closing the port was not enough, the owned group was killed and seen gone.
      expect(cleanupRecords(supervised.stdout())).toMatchObject([
        { label: "dev-lingering", forced: true, groupGone: true, portClosed: true },
      ]);
      expect(control.proc.exitCode).toBeNull();
      expect(await health(control.port)).toEqual({ status: 200, nonce: control.nonce, pid: control.proc.pid });
    },
    90_000
  );

  it(
    "an ordinary stop() settles only once the owned group is gone: a listener that closed its port and kept running is not reported clean",
    async () => {
      const fx = fixture();
      const supervised = await supervise(fx, [{ label: "dev-lingering-stop", command: "dev", mode: "lingering" }]);
      const [group] = await ownedListeners(fx, supervised);

      // No termination signal: the supervisor awaits the child's own stop(), reports and exits 0.
      signal(supervised.ready.pid, "SIGUSR2");

      expect(await within(supervised.ended, DEADLINE_MS)).toEqual({ code: 0, signal: null });
      // `group` is what the supervisor itself saw of the owned group the moment stop() had settled.
      expect(stoppedReport(supervised.stdout())).toMatchObject([
        { label: "dev-lingering-stop", group: "gone", record: { forced: true, groupGone: true, portClosed: true } },
      ]);
      await expectOwnedGone([group]);
    },
    90_000
  );

  it(
    "repeated signals do not cut the cleanup short: the listener is gone before the supervisor is, which ends by the FIRST signal",
    async () => {
      const fx = fixture();
      const supervised = await supervise(fx, [{ label: "dev-slow", command: "dev", mode: "slow" }]);
      const [group] = await ownedListeners(fx, supervised);

      // The listener needs ~1.5s to stop; the second and third signals arrive while it is stopping.
      signal(supervised.ready.pid, "SIGINT");
      await sleep(150);
      signal(supervised.ready.pid, "SIGINT");
      await sleep(150);
      signal(supervised.ready.pid, "SIGTERM");

      expect(await within(supervised.ended, DEADLINE_MS)).toEqual({ code: null, signal: "SIGINT" });
      await expectOwnedGone([group]);
      // One cleanup, allowed to finish gracefully: no forced kill was needed.
      expect(cleanupRecords(supervised.stdout())).toMatchObject([{ label: "dev-slow", forced: false, portClosed: true }]);
    },
    90_000
  );
});

// The cases above signal the process that owns the groups. In the carrier that process is a Vitest
// forks worker: the Vitest main process owns no group and ends on SIGINT/SIGTERM without waiting for
// its worker (installed vitest 4.1: the logger's signal listener exits the main process; a worker is
// only ever sent SIGTERM, then SIGKILL after 500ms, by an orderly pool stop). So what a signal does
// depends on WHICH process it reaches, and that is measured here against the installed Vitest — the
// worker's own record of the cleanup is not observable from outside once the main process is gone,
// so the processes and ports themselves are what is asserted.
describe("dev-login carrier child lifecycle under the installed Vitest's own process topology (a real `vitest run`, stand-in Next)", () => {
  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "%s to the run's whole process group reaches the forked worker that owns the listeners: they and the worker are gone, the run has ended, an unrelated listener is untouched",
    async (name) => {
      const fx = fixture();
      const control = await unrelatedListener(fx);
      const run = await vitestRun(fx, [
        { label: "start-like", command: "start", mode: "prompt" },
        { label: "dev-like", command: "dev", mode: "prompt" },
      ]);
      expectForksTopology(run);
      const owned = await ownedListeners(fx, run);
      expect(owned.map((group) => group.label)).toEqual(["start-like", "dev-like"]);

      // The group the run was started in: what a terminal Ctrl-C, or a runner cancelling the command,
      // signals. The owned listeners lead groups of their own and are not in it.
      const signalledAt = Date.now();
      signal(-(run.proc.pid as number), name);

      const main = await within(run.ended, DEADLINE_MS);
      expect(main, "the Vitest main process is still running").not.toBeNull();
      // Cancelled, not completed: the held test never settles, so a clean exit would be something else.
      expect(main).not.toEqual({ code: 0, signal: null });
      const remaining = Math.max(0, DEADLINE_MS - (Date.now() - signalledAt));
      expect(await gone(run.ready.pid, remaining), "the forked worker is still running").toBe(true);
      // Observed only, and before any hygiene: nothing in this case removes a fixture process itself.
      await expectOwnedGone(owned);
      console.log(
        `LIFECYCLE_TOPOLOGY_EVIDENCE ${JSON.stringify({ case: "command-group", signal: name, main, elapsedMs: Date.now() - signalledAt })}`
      );

      expect(control.proc.exitCode).toBeNull();
      expect(control.proc.signalCode).toBeNull();
      expect(await health(control.port)).toEqual({ status: 200, nonce: control.nonce, pid: control.proc.pid });
    },
    90_000
  );

  // NOT a cleanup promise. The helper can act only in the process that owns the groups, and a signal
  // sent to the Vitest main process alone does not reach it. What then becomes of the worker is this
  // Vitest's behaviour: it is watched for a bounded window and RECORDED either way. Whatever is left
  // is then removed by the pids verified before the signal — fixture removal, never a cancellation
  // result, and the only place a passing case does so.
  it(
    "observation, not a promise: SIGTERM to the Vitest main process ALONE ends that process; what is left of the worker and its listener is recorded, then removed by verified pid",
    async () => {
      const fx = fixture();
      const control = await unrelatedListener(fx);
      const run = await vitestRun(fx, [{ label: "dev-like", command: "dev", mode: "prompt" }]);
      expectForksTopology(run);
      const [group] = await ownedListeners(fx, run);

      signal(run.proc.pid as number, "SIGTERM");

      const main = await within(run.ended, DEADLINE_MS);
      expect(main, "the Vitest main process is still running").not.toBeNull();
      const cleanedUnaided = await eventually(
        async () =>
          !alive(run.ready.pid) && !alive(group.leader) && !alive(group.listener) && !(await loopbackPortAccepts(group.port, 500)),
        MAIN_ONLY_WINDOW_MS
      );
      console.log(
        `LIFECYCLE_TOPOLOGY_EVIDENCE ${JSON.stringify({
          case: "main-only",
          signal: "SIGTERM",
          main,
          windowMs: MAIN_ONLY_WINDOW_MS,
          cleanedUnaided,
          left: leftovers(),
        })}`
      );

      expect(await reapVerified(), "a verified fixture process survived its removal").toBe(true);
      expect(await loopbackPortAccepts(group.port, 500)).toBe(false);
      expect(control.proc.exitCode).toBeNull();
      expect(control.proc.signalCode).toBeNull();
      expect(await health(control.port)).toEqual({ status: 200, nonce: control.nonce, pid: control.proc.pid });
    },
    90_000
  );
});
