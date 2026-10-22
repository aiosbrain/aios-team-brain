import "server-only";
import { probePostgres as boundedPostgresProbe, READINESS_TIMEOUT_MS } from "@/lib/health/readiness";
import { runRead } from "@/lib/graph/neo4j";
import {
  copiedStagingSpendAllowed,
  interactiveQueryOptIn,
  isCopiedStagingRuntime,
  readStagingRuntimeState,
  stagingHealthTokenMatches,
  type StagingDataMode,
  type StagingRuntimeState,
} from "@/lib/staging/runtime-policy";

const DEFAULT_PROBE_MS = READINESS_TIMEOUT_MS;

/**
 * What this deployment will actually do with a query, in one word.
 *
 * `unsupported-budgeted-mode` is deliberately distinct from `disabled`: the operator asked for the
 * optional budgeted mode and did not get it, and a health report that answered plain `disabled`
 * would leave them believing their configuration took effect.
 */
function answeringPosture(
  mode: StagingDataMode,
  env: NodeJS.ProcessEnv
): "enabled" | "disabled" | "unsupported-budgeted-mode" {
  // The MEASURED mode is authoritative, not just the environment the policy reads: a copy-ready
  // journal must never report `enabled`, whatever the variables say.
  const copyScoped = mode === "copy-ready" || isCopiedStagingRuntime(env);
  if (!copyScoped && copiedStagingSpendAllowed("interactive-query", env)) return "enabled";
  return interactiveQueryOptIn(env).status === "not-requested" ? "disabled" : "unsupported-budgeted-mode";
}

function positiveTimeout(raw: string | undefined, fallback = DEFAULT_PROBE_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : fallback;
}

export function probePostgres(timeoutMs = DEFAULT_PROBE_MS): Promise<boolean> {
  return boundedPostgresProbe(undefined, timeoutMs);
}

function healthJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
  if (!(await deps.probePostgres(timeoutMs))) return healthJson({ ok: false }, 503);

  const presented = request.headers.get("x-aios-staging-health-token");
  if (!presented) {
    return healthJson({ ok: true, commit: deps.env.RAILWAY_GIT_COMMIT_SHA ?? null });
  }
  if (!stagingHealthTokenMatches(presented, deps.env)) {
    return healthJson({ ok: false }, 401);
  }

  const state = await deps.readRuntimeState();
  const bootProbe = request.headers.get("x-aios-staging-boot-probe") === "true";
  if ((!state.ready && !bootProbe) || state.mode === "copy-safe-refusal") return healthJson({ ok: false }, 503);
  let graph: "disabled" | "readable" = "disabled";
  if (state.mode === "copy-ready") {
    if (!(await deps.probeNeo4j(timeoutMs))) return healthJson({ ok: false }, 503);
    graph = "readable";
  }
  return healthJson({
    ok: state.ready,
    booted: bootProbe && !state.ready ? true : undefined,
    commit: deps.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    mode: state.mode,
    refreshRunId: state.runId,
    postgres: "ready",
    graph,
    // Reported alongside `graph`, because "the graph is readable" is exactly the claim an operator
    // could mistake for "queries work here". Model-backed answering is disabled in copy scope and
    // the optional budgeted mode is not implemented, so this is the honest word for it.
    answering: answeringPosture(state.mode, deps.env),
  }, state.ready ? 200 : 202);
}
