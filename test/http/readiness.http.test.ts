import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { BASE_URL, HTTP_TEST_PORT } from "./server-url";

it("serves an uncached public database readiness response", async () => {
  const r = await fetch(`${BASE_URL}/api/health`);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({
    ok: true,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  });
});
// AIO-1208 AC-11: public readiness is the ONLY unauthenticated answer. Presenting a token that
// does not verify is refused with exactly `{ ok: false }` — never the public body, never detail.
it("refuses a wrong staging health token with 401 and no readiness detail", async () => {
  const r = await fetch(`${BASE_URL}/api/health`, {
    headers: { "x-aios-staging-health-token": "w".repeat(40) },
  });
  expect(r.status).toBe(401);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({ ok: false });
});
it("real HTTP returns bounded safe503 with an unreachable database", async () => {
  const port = String(Number(HTTP_TEST_PORT) + 1);
  const server = spawn(
    process.execPath,
    [resolve("node_modules/next/dist/bin/next"), "start", "-p", port],
    {
      env: {
        ...process.env,
        PORT: port,
        DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/unavailable",
        PG_CONNECT_TIMEOUT_MS: "10000",
      },
      stdio: "ignore",
    },
  );
  try {
    let response: Response | undefined;
    for (let n = 0; n < 30; n++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(4000),
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response!.json()).toEqual({ ok: false });
  } finally {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}, 12000);
