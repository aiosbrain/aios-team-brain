import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { groupAlive, supervisionSupported } from "../scripts/staging-ops/owned-workload.mjs";

/**
 * The CONTROLLER's half, driven the way the harness drives it: a real controller process, real HTTP,
 * real supervised workloads that bind a real port.
 *
 * Runtime 5 measured both failures here. A SIGTERM-terminated child kept `exitCode === null`, so it
 * was listed active and a second stop hung for 10,007 ms; and a stop that "completed" left a Next
 * descendant on `0.0.0.0:3000`, so the replacement deployment died with `EADDRINUSE`. Neither is
 * observable from a unit test of the handler — the first needs a signal-terminated child, the second
 * needs a descendant that outlives its wrapper.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/owned-workload-wrapper.mjs", import.meta.url));
const CONTROLLER = fileURLToPath(new URL("../scripts/staging-ops/local-maintenance-service.mjs", import.meta.url));
const TOKEN = "local-maintenance-token";
const POSIX = supervisionSupported();

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
/**
 * The HOST matters. macOS with `SO_REUSEADDR` (Node's default) lets a more specific address bind
 * while a wildcard one is held, so probing `127.0.0.1` against a `0.0.0.0` listener answers a
 * different question than the one being asked. Each check names the address it is actually about.
 */
const canBind = async (port: number, host = "127.0.0.1") => await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(port, host, () => probe.close(() => resolve(true)));
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return false;
};

const running: { controller: ChildProcess | null; sentinel: Server | null }[] = [];
afterEach(async () => {
  for (const { controller, sentinel } of running.splice(0)) {
    if (controller?.pid) { try { process.kill(-controller.pid, "SIGKILL"); } catch { /* gone */ } }
    if (sentinel) await new Promise((resolve) => sentinel.close(() => resolve(null)));
  }
});

interface Controller { port: number; appPort: number; child: ChildProcess; call: (path: string, init?: RequestInit) => Promise<{ status: number; body: Record<string, unknown> }> }

async function startController(): Promise<Controller> {
  const port = await freePort();
  const appPort = await freePort();
  const child = spawn(process.execPath, [CONTROLLER], {
    // Its own group, so the test can guarantee cleanup of the controller AND everything it spawned.
    detached: true, stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port), LOCAL_APP_PORT: String(appPort),
      LOCAL_MAINTENANCE_TOKEN: TOKEN,
      STAGING_IMPORTER_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
      LOCAL_APP_COMMAND_JSON: JSON.stringify([process.execPath, FIXTURE, String(appPort), "0", "0"]),
    },
  });
  running.push({ controller: child, sentinel: null });
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const up = await waitFor(async () => {
    try { return (await call("/identity")).status === 200; } catch { return false; }
  });
  if (!up) throw new Error("the local maintenance controller never became reachable");
  return { port, appPort, child, call };
}

const activeApps = async (controller: Controller) =>
  ((await controller.call("/deployments?serviceId=app-local")).body.deployments as Record<string, unknown>[]);

describe.runIf(POSIX)("the controller stops what it owns, and only that", () => {
  it("lists a SIGNAL-terminated deployment as gone, and a repeat stop returns promptly", async () => {
    // THE 10,007 ms HANG, end to end. The child dies on SIGTERM (`exitCode === null`), and the old
    // listing filter reported it alive — so the harness asked for a second stop that never returned.
    const controller = await startController();
    expect(await waitFor(async () => (await activeApps(controller)).length === 1)).toBe(true);
    const [app] = await activeApps(controller);

    const first = await controller.call(`/deployments/${app.id}/stop`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await activeApps(controller), "a stopped deployment is still listed as active").toEqual([]);

    const startedAt = Date.now();
    const second = await controller.call(`/deployments/${app.id}/stop`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(Date.now() - startedAt, "the repeat stop hung").toBeLessThan(3_000);
  }, 60_000);

  it("frees the app address, so a REPLACEMENT deployment can be spawned", async () => {
    // The second measured failure: the replacement 10 s after a "completed" stop died with
    // EADDRINUSE because a descendant still held the port.
    const controller = await startController();
    expect(await waitFor(async () => !(await canBind(controller.appPort))), "the supervised app never bound its port").toBe(true);
    const [app] = await activeApps(controller);

    expect((await controller.call(`/deployments/${app.id}/stop`, { method: "POST" })).status).toBe(200);
    expect(await waitFor(() => canBind(controller.appPort)), "the address was still held after a completed stop").toBe(true);

    const deployed = await controller.call("/deploy", { method: "POST", body: JSON.stringify({ serviceId: "app-local", commitSha: "b".repeat(40) }) });
    expect(deployed.status).toBe(200);
    expect(deployed.body.id).toBeTruthy();
    expect(await waitFor(async () => !(await canBind(controller.appPort))), "the replacement never started").toBe(true);
  }, 60_000);

  it("REFUSES a replacement when an unrelated listener holds the address, and leaves it alive", async () => {
    // Nothing is killed for holding a port. The refusal is explicit, and the listener survives it.
    const controller = await startController();
    const [app] = await activeApps(controller);
    expect((await controller.call(`/deployments/${app.id}/stop`, { method: "POST" })).status).toBe(200);
    expect(await waitFor(() => canBind(controller.appPort))).toBe(true);

    const sentinel = createServer(() => {});
    await new Promise((resolve) => sentinel.listen(controller.appPort, "0.0.0.0", () => resolve(null)));
    running.push({ controller: null, sentinel });

    const refused = await controller.call("/deploy", { method: "POST", body: JSON.stringify({ serviceId: "app-local", commitSha: "b".repeat(40) }) });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("address-in-use");
    expect(refused.body.port).toBe(controller.appPort);
    // Untouched — asked about the SAME wildcard address the sentinel actually holds.
    expect(sentinel.listening, "the unrelated listener was closed").toBe(true);
    expect(await canBind(controller.appPort, "0.0.0.0"), "the unrelated listener lost its socket").toBe(false);
    // …and no replacement was started behind the refusal.
    expect(await activeApps(controller)).toEqual([]);
  }, 60_000);

  it("stops every owned workload when the CONTROLLER itself shuts down", async () => {
    const controller = await startController();
    expect(await waitFor(async () => !(await canBind(controller.appPort)))).toBe(true);

    process.kill(controller.child.pid!, "SIGTERM");
    expect(await waitFor(() => canBind(controller.appPort)), "controller shutdown left a workload holding the address").toBe(true);
    expect(await waitFor(() => !groupAlive(controller.child.pid!)), "the controller never exited").toBe(true);
  }, 60_000);
});
