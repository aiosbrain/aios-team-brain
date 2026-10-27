import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { once } from "node:events";
import { BASE_URL, HTTP_TEST_PORT as PORT } from "./server-url";

// One production Next.js server for the whole HTTP suite. We boot `next start`
// (not `next dev`) so tests hit the real production runtime, and against a
// prebuilt .next so there's no first-request compile flakiness. The server and
// the test process share the test Postgres (DATABASE_TEST_URL), so seeding done
// in-process (lib/ingest helpers) is visible to the server over HTTP.

async function waitForReady(): Promise<void> {
  // Matches scripts/e2e.sh: an unauthenticated GET /api/v1/items returns 401 once
  // the route runtime is live. Poll until then (≤30s).
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/items`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 401) return;
    } catch {
      // connection refused while the server is still binding — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`HTTP tier: server at ${BASE_URL} never became ready (no 401 on /api/v1/items)`);
}

/**
 * A controlled Google OAuth token endpoint on loopback (AIO-1167 R44 T2). The server's broker is
 * pointed at it through `AIOS_TEST_GOOGLE_TOKEN_URL` (honoured for loopback only). A refresh token
 * named `revoked-refresh` is refused `invalid_grant`; any other is exchanged for a short-lived token
 * that names the refresh token it came from, so a test can tell which credential the broker used.
 */
async function startFakeGoogle(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const refresh = form.get("refresh_token") ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method !== "POST" || form.get("grant_type") !== "refresh_token" || !refresh) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_request" }));
      } else if (refresh === "revoked-refresh") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
      } else {
        res.end(JSON.stringify({
          access_token: `fake-access-for-${refresh}`, expires_in: 600,
          scope: "https://www.googleapis.com/auth/drive.file",
        }));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return server;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!existsSync(resolve(".next/BUILD_ID"))) {
    throw new Error(
      "HTTP tier: no production build found (.next/BUILD_ID missing). " +
        "Run `npm run build` first, or use `npm run test:http:local` which builds for you."
    );
  }

  const fakeGoogle = await startFakeGoogle();
  process.env.AIOS_TEST_GOOGLE_TOKEN_URL =
    `http://127.0.0.1:${(fakeGoogle.address() as AddressInfo).port}/token`;

  const nextBin = resolve("node_modules/.bin/next");
  // The MCP outer runner owns a detached Vitest process group. Keep its server
  // inside that group so an outer timeout also closes every inherited pipe.
  const detached = process.env.MCP_HTTP_ATTACHED !== "1";
  const server: ChildProcess = spawn(nextBin, ["start", "-p", PORT], {
    // Inherit the backend/secret env pinned in vitest.http.config.ts; PORT is also
    // honored by `next start`. detached so we can kill the whole process group.
    env: { ...process.env, PORT },
    stdio: ["ignore", "inherit", "inherit"],
    detached,
  });
  const stop = (signal: NodeJS.Signals) => {
    if (!server.pid) return;
    if (detached) process.kill(-server.pid, signal);
    else server.kill(signal);
  };

  server.on("error", (err) => {
    throw new Error(`HTTP tier: failed to spawn next start — ${err.message}`);
  });

  try {
    await waitForReady();
  } catch (e) {
    if (server.pid) {
      try {
        stop("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fakeGoogle.close();
    throw e;
  }

  return async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      const timeout = setTimeout(() => {
        try { stop("SIGKILL"); } catch { /* exit raced */ }
      }, 5000);
      try {
        stop("SIGTERM");
        await exited;
        if (server.signalCode === "SIGKILL") throw new Error("HTTP server required forced termination");
      } finally { clearTimeout(timeout); }
    }
    await new Promise<void>((resolveClose) => fakeGoogle.close(() => resolveClose()));
    console.log("HTTP_SERVER_CLEANUP_OK");
  };
}
