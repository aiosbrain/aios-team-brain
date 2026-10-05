import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pg/pool";

export const READINESS_TIMEOUT_MS = 2500;

/** One deadline covers checkout AND query. A late checkout is released without
 * issuing SQL; a timed-out/erroring checked-out connection is destroyed. */
export function probePostgres(
  connect: () => Promise<PoolClient> = () => getPool().connect(),
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let client: PoolClient | undefined;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (client) {
        client.removeListener("error", onError);
        client.release(!ok);
      }
      resolve(ok);
    };
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve()
      .then(connect)
      .then((acquired) => {
        if (finished) {
          acquired.release();
          return;
        }
        client = acquired;
        client.on("error", onError);
        // A rejected query is observed even when the deadline/error event wins.
        return client.query("select 1").then(() => finish(true), onError);
      }, onError)
      .catch(onError);
  });
}

/** Public contract matches staging's basic probe, without privileged staging
 * journals, tokens, graph diagnostics or answering-provider dependencies. */
export async function healthResponse(
  probe: () => Promise<boolean> = probePostgres,
  commit: string | null = process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
): Promise<Response> {
  let ok = false;
  try {
    ok = await probe();
  } catch {
    /* health must not disclose database errors */
  }
  return Response.json(ok ? { ok: true, commit } : { ok: false }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
