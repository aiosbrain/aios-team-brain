/**
 * A REAL wrapper → child → grandchild chain, standing in for controller → fence → npm → Next.
 *
 * The grandchild is the one that binds the port, exactly as Next does, and it can be told to IGNORE
 * SIGTERM — which is the case that separates "the wrapper exited" from "the workload stopped", and
 * the case the runtime-5 `EADDRINUSE` came from. The wrapper can also exit FIRST, leaving its
 * descendants running, so an orphaned-descendant stop is exercised rather than assumed.
 *
 * argv: <port> <ignoreSigterm:0|1> <wrapperExitsFirstMs|0>
 * It prints one JSON line per process to stdout so the test can record PID/PPID/PGID and the socket
 * owner. No command arguments and no environment are printed.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [port, ignoreSigterm, wrapperExitsFirstMs] = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);

// Node exposes no `getpgrp`, so the PGID is read from the OS by the test (`ps -o pgid= -p <pid>`)
// rather than guessed here. What this process can state about itself is its own identity and its
// parent's — never its command line, never its environment.
const announce = (role) => console.log(JSON.stringify({ role, pid: process.pid, ppid: process.ppid }));

if (process.env.OWNED_FIXTURE_ROLE === "grandchild") {
  announce("grandchild");
  if (ignoreSigterm === "1") {
    // Deliberately survives a graceful stop. Only group escalation can end this.
    process.on("SIGTERM", () => console.log(JSON.stringify({ role: "grandchild", ignoredSigterm: true })));
  }
  const { createServer } = await import("node:net");
  const server = createServer(() => {});
  server.listen(Number(port), "127.0.0.1", () => console.log(JSON.stringify({ role: "grandchild", listening: Number(port) })));
  setInterval(() => {}, 1000);
} else if (process.env.OWNED_FIXTURE_ROLE === "child") {
  announce("child");
  spawn(process.execPath, [self, port, ignoreSigterm, wrapperExitsFirstMs], {
    stdio: "inherit", env: { ...process.env, OWNED_FIXTURE_ROLE: "grandchild" },
  });
  setInterval(() => {}, 1000);
} else {
  announce("wrapper");
  spawn(process.execPath, [self, port, ignoreSigterm, wrapperExitsFirstMs], {
    stdio: "inherit", env: { ...process.env, OWNED_FIXTURE_ROLE: "child" },
  });
  const exitFirst = Number(wrapperExitsFirstMs ?? 0);
  if (exitFirst > 0) setTimeout(() => { console.log(JSON.stringify({ role: "wrapper", exitingFirst: true })); process.exit(0); }, exitFirst);
  else setInterval(() => {}, 1000);
}
