import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
//   - the supervisor still terminates BY the signal it was sent, and a repeated signal does not cut
//     the cleanup short;
//   - an unrelated listener the supervisor never started is still serving afterwards.
//
// What stands in for Next is a tiny script at the path the helper launches
// (`node_modules/next/dist/bin/next` of a disposable temp directory): `start` is one listening
// process, `dev` is a leader that forks the listener into its own group — the shape of `next dev`.
// It serves a per-run nonce and its pid on /api/health, so every "this port is ours" below is a fact
// about that process and not about whatever happens to hold the port. Nothing here runs Next, touches
// a database or the task checkout, or signals a process this file did not start.

const HELPER = join(process.cwd(), "test", "http", "dev-login-dev-setup.ts");

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
  "  http",
  "    .createServer((req, res) => {",
  '      res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });',
  "      res.end(JSON.stringify({ nonce: process.env.AIO1210_FAKE_NONCE, pid: process.pid }));",
  "    })",
  "    .listen(port, host);",
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
  "    children.push({ label: spec.label, pid: child.pid, port: child.port });",
  "  }",
  '  process.stdout.write("SUPERVISOR_READY " + JSON.stringify({ pid: process.pid, children }) + "\\n");',
  // Stay up: only a signal ends this process, and installing no handler of its own is the point.
  "  setInterval(() => {}, 60000);",
  "})().catch((err) => {",
  '  process.stderr.write("SUPERVISOR_FAILED " + String(err && err.message) + "\\n");',
  "  process.exit(70);",
  "});",
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
  mode: "prompt" | "stubborn" | "slow";
}

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Supervised {
  proc: ChildProcess;
  ready: { pid: number; children: { label: string; pid: number; port: number }[] };
  stdout(): string;
  /** Resolves once the supervisor has exited AND its output has been read to the end. */
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
  const dir = mkdtempSync(join(tmpdir(), "aio1210-lifecycle-"));
  roots.push(dir);
  // Disposable, and never inside the task checkout.
  expect(realpathSync(dir).startsWith(realpathSync(process.cwd()) + sep)).toBe(false);
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

/**
 * Before any signal: each owned port is answered by THIS run's stand-in, by the process the
 * stand-in says is its listener, under the leader the helper says it started.
 */
async function ownedListeners(fx: Fixture, supervised: Supervised): Promise<OwnedListener[]> {
  const owned: OwnedListener[] = [];
  for (const child of supervised.ready.children) {
    const pids = JSON.parse(readFileSync(join(fx.dir, `fake-next-${child.port}.json`), "utf8")) as {
      leader: number;
      listener: number;
    };
    expect(pids.leader).toBe(child.pid);
    expect(await health(child.port)).toEqual({ status: 200, nonce: fx.nonce, pid: pids.listener });
    expect(alive(pids.leader)).toBe(true);
    expect(alive(pids.listener)).toBe(true);
    owned.push({ label: child.label, port: child.port, leader: pids.leader, listener: pids.listener });
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

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** The supervisor's termination, or null if it is still running at the deadline. */
function within(ended: Promise<Ended>, timeoutMs: number): Promise<Ended | null> {
  return Promise.race([ended, sleep(timeoutMs).then(() => null)]);
}

function cleanupRecords(stdout: string): { label: string; forced: boolean; portClosed: boolean }[] {
  const prefix = "DEV_LOGIN_CHILD_CLEANUP_OK ";
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as { label: string; forced: boolean; portClosed: boolean })
    .sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** Owned listeners are gone NOW — asked the moment the supervisor has terminated, with no grace. */
async function expectOwnedGone(owned: OwnedListener[]): Promise<void> {
  for (const group of owned) {
    expect(await loopbackPortAccepts(group.port, 500), `${group.label}: port ${group.port} still accepts`).toBe(false);
  }
  // A killed grandchild is reaped by init, not by this process: allow that a moment.
  for (const group of owned) {
    expect(await eventually(() => !alive(group.leader), 5000), `${group.label}: leader still running`).toBe(true);
    expect(await eventually(() => !alive(group.listener), 5000), `${group.label}: listener still running`).toBe(true);
  }
}

// Hygiene for a FAILED case only: a passing one leaves nothing. A fixture listener is killed only if
// its port still answers with this run's nonce, and by the pid it reports — never by guess.
afterEach(async () => {
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
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DEADLINE_MS = 45_000;

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
