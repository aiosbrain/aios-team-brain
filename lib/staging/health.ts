import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pg/pool";
import { runRead } from "@/lib/graph/neo4j";
import {
  readStagingRuntimeState,
  stagingHealthTokenMatches,
  type StagingRuntimeState,
} from "@/lib/staging/runtime-policy";

const DEFAULT_PROBE_MS = 2_500;

function positiveTimeout(raw: string | undefined, fallback = DEFAULT_PROBE_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : fallback;
}

export async function probePostgres(timeoutMs = DEFAULT_PROBE_MS): Promise<boolean> {
  let client: PoolClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = await getPool().connect();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("postgres health probe timed out")), timeoutMs);
    });
    await Promise.race([client.query("select 1"), timeout]);
    return true;
  } catch {
    client?.release(true);
    client = undefined;
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    client?.release();
  }
}

export async function probeNeo4j(timeoutMs = DEFAULT_PROBE_MS): Promise<boolean> {
  try {
    const rows = await runRead<{ ok: number }>("RETURN 1 AS ok", {}, { timeoutMs });
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

interface HealthDependencies {
  probePostgres: (timeoutMs: number) => Promise<boolean>;
  probeNeo4j: (timeoutMs: number) => Promise<boolean>;
  readRuntimeState: () => Promise<StagingRuntimeState>;
  env: NodeJS.ProcessEnv;
}

const defaults = (env: NodeJS.ProcessEnv): HealthDependencies => ({
  probePostgres,
  probeNeo4j,
  readRuntimeState: () => readStagingRuntimeState(env),
  env,
});

export async function healthResponse(
  request: Request,
  deps: HealthDependencies = defaults(process.env)
): Promise<Response> {
  const timeoutMs = positiveTimeout(deps.env.STAGING_HEALTH_PROBE_TIMEOUT_MS);
  if (!(await deps.probePostgres(timeoutMs))) return Response.json({ ok: false }, { status: 503 });

  const presented = request.headers.get("x-aios-staging-health-token");
  if (!presented) {
    return Response.json({ ok: true, commit: deps.env.RAILWAY_GIT_COMMIT_SHA ?? null });
  }
  if (!stagingHealthTokenMatches(presented, deps.env)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const state = await deps.readRuntimeState();
  const bootProbe = request.headers.get("x-aios-staging-boot-probe") === "true";
  if ((!state.ready && !bootProbe) || state.mode === "copy-safe-refusal") return Response.json({ ok: false }, { status: 503 });
  let graph: "disabled" | "readable" = "disabled";
  if (state.mode === "copy-ready") {
    if (!(await deps.probeNeo4j(timeoutMs))) return Response.json({ ok: false }, { status: 503 });
    graph = "readable";
  }
  return Response.json({
    ok: state.ready,
    booted: bootProbe && !state.ready ? true : undefined,
    commit: deps.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    mode: state.mode,
    refreshRunId: state.runId,
    postgres: "ready",
    graph,
  }, { status: state.ready ? 200 : 202 });
}
