import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import type { TestProject } from "vitest/node";
import { BASE_URL, HTTP_TEST_PORT as PORT } from "./server-url";
import { queryServerEnv, startFakeGraphiti, startFakeLlm, type FakeServer } from "./fake-providers";

// Global setup for the OPT-IN TIERRET-1 query harness ONLY (vitest.tierret1-query.config.ts). The
// ordinary HTTP tier keeps test/http/global-setup.ts and its no-LLM server; this one starts the two
// loopback fakes FIRST, then boots `next start` with LLM_BASE_URL / GRAPHITI_URL pinned to them and
// every cloud credential blanked (fake-providers.ts#queryServerEnv), so the real /api/v1/query route
// streams a real answer without any paid or external call.

async function probe(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/api/v1/items`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(): Promise<void> {
  // Same readiness signal as global-setup.ts: an unauthenticated items GET answers 401.
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/items`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 401) return;
    } catch {
      // still binding
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`TIERRET-1 query harness: server at ${BASE_URL} never became ready`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!existsSync(resolve(".next/BUILD_ID"))) {
    throw new Error("TIERRET-1 query harness: no production build (.next/BUILD_ID). Run `npm run build` first.");
  }
  // Refuse to attach to a server that is already listening (e.g. an ordinary HTTP-tier run, whose
  // server has NO fake provider): every assertion would then be about the wrong process.
  if (await probe()) {
    throw new Error(`TIERRET-1 query harness: ${BASE_URL} is already serving — stop that server first`);
  }

  const fakes: FakeServer[] = [];
  let server: ChildProcess | null = null;
  const stop = (signal: NodeJS.Signals) => {
    if (server?.pid) process.kill(-server.pid, signal);
  };
  const closeFakes = async () => {
    await Promise.all(fakes.map((f) => f.close()));
  };

  try {
    const llm = await startFakeLlm();
    fakes.push(llm);
    const graphiti = await startFakeGraphiti();
    fakes.push(graphiti);

    // Pinned BEFORE `next start`: the server's LLM/graph module constants are read at import.
    const env = queryServerEnv(process.env, { llmUrl: llm.url, graphitiUrl: graphiti.url }, PORT);
    server = spawn(resolve("node_modules/.bin/next"), ["start", "-p", PORT], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    server.on("error", (err) => {
      throw new Error(`TIERRET-1 query harness: failed to spawn next start — ${err.message}`);
    });
    await waitForReady();

    project.provide("tierret1FakeLlmUrl", llm.url);
    project.provide("tierret1FakeGraphitiUrl", graphiti.url);
  } catch (e) {
    try { stop("SIGKILL"); } catch { /* already gone */ }
    await closeFakes();
    throw e;
  }

  return async () => {
    const s = server!;
    try {
      if (s.pid && s.exitCode === null && s.signalCode === null) {
        const exited = once(s, "exit");
        const timeout = setTimeout(() => {
          try { stop("SIGKILL"); } catch { /* exit raced */ }
        }, 5000);
        try {
          stop("SIGTERM");
          await exited;
          if (s.signalCode === "SIGKILL") throw new Error("TIERRET-1 query server required forced termination");
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      await closeFakes();
    }
    console.log("TIERRET1_QUERY_CLEANUP_OK");
  };
}
