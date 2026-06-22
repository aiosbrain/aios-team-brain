import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
      const res = await fetch(`${BASE_URL}/api/v1/items`);
      if (res.status === 401) return;
    } catch {
      // connection refused while the server is still binding — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`HTTP tier: server at ${BASE_URL} never became ready (no 401 on /api/v1/items)`);
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!existsSync(resolve(".next/BUILD_ID"))) {
    throw new Error(
      "HTTP tier: no production build found (.next/BUILD_ID missing). " +
        "Run `npm run build` first, or use `npm run test:http:local` which builds for you."
    );
  }

  const nextBin = resolve("node_modules/.bin/next");
  const server: ChildProcess = spawn(nextBin, ["start", "-p", PORT], {
    // Inherit the backend/secret env pinned in vitest.http.config.ts; PORT is also
    // honored by `next start`. detached so we can kill the whole process group.
    env: { ...process.env, PORT },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });

  server.on("error", (err) => {
    throw new Error(`HTTP tier: failed to spawn next start — ${err.message}`);
  });

  try {
    await waitForReady();
  } catch (e) {
    if (server.pid) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    throw e;
  }

  return async () => {
    if (server.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
}
