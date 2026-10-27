import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { BASE_URL, FAKE_GOOGLE_CLIENT, HTTP_TEST_PORT as PORT } from "./server-url";

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * A controlled Google OAuth provider on loopback (AIO-1167 R44 T2). Production code is not
 * configurable: it always calls Google's fixed endpoints. The interception lives entirely in this
 * harness — `google-token-intercept.mjs`, preloaded into the test server only, answers exactly those
 * URLs from this fixture.
 *
 *   POST /token, `refresh_token` grant — `revoked-refresh` is refused `invalid_grant`; any other is
 *     exchanged for a short-lived token naming the refresh token it came from, so a test can tell
 *     which credential the broker used.
 *   POST /token, `authorization_code` grant — only for the test client's id, secret and redirect;
 *     returns `refresh-<code>` and a per-file grant, so the callback's exchange is observable.
 *   GET /userinfo — the account behind a code-exchanged access token: subject `sub-<code>`, with an
 *     UNVERIFIED email (so the publisher links no member by it).
 */
function handleToken(form: URLSearchParams, res: ServerResponse): void {
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const client = form.get("client_id") === FAKE_GOOGLE_CLIENT.id
      && form.get("client_secret") === FAKE_GOOGLE_CLIENT.secret
      && form.get("redirect_uri") === FAKE_GOOGLE_CLIENT.redirect;
    if (!code || !client) return json(res, 400, { error: "invalid_grant" });
    return json(res, 200, {
      access_token: `code-access-${code}`, refresh_token: `refresh-${code}`, expires_in: 600,
      scope: "openid https://www.googleapis.com/auth/drive.file",
    });
  }
  const refresh = form.get("refresh_token") ?? "";
  if (grant !== "refresh_token" || !refresh) return json(res, 400, { error: "invalid_request" });
  if (refresh === "revoked-refresh") return json(res, 400, { error: "invalid_grant" });
  return json(res, 200, {
    access_token: `fake-access-for-${refresh}`, expires_in: 600,
    scope: "https://www.googleapis.com/auth/drive.file",
  });
}

function handleUserinfo(authorization: string | undefined, res: ServerResponse): void {
  const code = /^Bearer code-access-(.+)$/.exec(authorization ?? "")?.[1];
  if (!code) return json(res, 401, { error: "invalid_token" });
  return json(res, 200, { sub: `sub-${code}`, email: `owner-${code}@example.com`, email_verified: false });
}

async function startFakeGoogle(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      if (req.method === "POST" && path === "/token") return handleToken(new URLSearchParams(body), res);
      if (req.method === "GET" && path === "/userinfo") return handleUserinfo(req.headers.authorization, res);
      return json(res, 404, { error: "not_found" });
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
  const intercept = pathToFileURL(resolve("test/http/google-token-intercept.mjs")).href;
  // Only the spawned TEST server gets the preload, the fixture URLs and the test OAuth client;
  // nothing else reads them.
  const fixture = `http://127.0.0.1:${(fakeGoogle.address() as AddressInfo).port}`;
  const harnessEnv = {
    AIOS_HTTP_FAKE_GOOGLE_TOKEN_URL: `${fixture}/token`,
    AIOS_HTTP_FAKE_GOOGLE_USERINFO_URL: `${fixture}/userinfo`,
    GOOGLE_DRIVE_CLIENT_ID: FAKE_GOOGLE_CLIENT.id,
    GOOGLE_DRIVE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT.secret,
    GOOGLE_DRIVE_OAUTH_REDIRECT: FAKE_GOOGLE_CLIENT.redirect,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${intercept}`].filter(Boolean).join(" "),
  };

  const nextBin = resolve("node_modules/.bin/next");
  // The MCP outer runner owns a detached Vitest process group. Keep its server
  // inside that group so an outer timeout also closes every inherited pipe.
  const detached = process.env.MCP_HTTP_ATTACHED !== "1";
  const server: ChildProcess = spawn(nextBin, ["start", "-p", PORT], {
    // Inherit the backend/secret env pinned in vitest.http.config.ts; PORT is also
    // honored by `next start`. detached so we can kill the whole process group.
    env: { ...process.env, ...harnessEnv, PORT },
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
