/**
 * Cleanup that actually reaches every resource.
 *
 * The measured shape: `finally { await session.close(); await driver.close(); await client.end(); }`.
 * If the session close rejects — a dropped bolt connection is the ordinary way that happens — the
 * driver and the Postgres client are never closed at all, and the process keeps a connection and a
 * backend alive for its remaining lifetime. The sequential form reads as "close all three" and is
 * "close the first, then maybe the rest".
 *
 * So: EVERY closer is attempted, in order, regardless of the others. The first failure is rethrown
 * once they have all run, which keeps today's behaviour that a cleanup failure is visible rather
 * than swallowed — the only thing that changes is that the later resources are no longer skipped.
 * Any further failures are attached as `otherCleanupFailures` so none of them disappears silently.
 *
 * @param {...(null|undefined|(() => unknown|Promise<unknown>))} closers
 */
export async function closeAll(...closers) {
  const failures = [];
  for (const close of closers) {
    if (!close) continue;
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return true;
  const [first, ...rest] = failures;
  if (rest.length && first && typeof first === "object") {
    try { Object.defineProperty(first, "otherCleanupFailures", { value: rest, enumerable: false }); } catch { /* frozen error: the first one still propagates */ }
  }
  throw first;
}

export function ownedCloser(close, terminate = close) {
  return Object.freeze({ close, terminate });
}

/**
 * Shared terminal-cleanup ceiling. On expiry an owned resource is actively terminated and its
 * close is awaited. If termination cannot make it settle inside the configured grace, the worker
 * exits instead of returning through a finally block and pretending its work is quiescent.
 */
export async function closeAllWithinBudget({ budget, terminateGraceMs = 2_000, terminateWorker = (error) => {
  console.error(`staging cleanup could not confirm termination: ${error.message}`);
  process.exit(1);
}}, ...resources) {
  const failures = [];
  for (const resource of resources.filter(Boolean)) {
    const descriptor = typeof resource === "function" ? ownedCloser(resource) : resource;
    let settled = false;
    const closing = Promise.resolve().then(descriptor.close).then(
      (value) => { settled = true; return { status: "fulfilled", value }; },
      (reason) => { settled = true; return { status: "rejected", reason }; },
    );
    const wait = async (ms) => {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); });
      const result = await Promise.race([closing, timeout]);
      clearTimeout(timer);
      return result;
    };
    let cleanupMs = 0;
    try { cleanupMs = budget.remaining(Number.POSITIVE_INFINITY, "terminal resource cleanup"); } catch { cleanupMs = 0; }
    let result = await wait(Math.max(1, cleanupMs));
    if (!result && !settled) {
      try { await descriptor.terminate?.(); } catch (error) { failures.push(error); }
      let terminationMs = terminateGraceMs;
      try { terminationMs = Math.min(terminateGraceMs, budget.remaining(Number.POSITIVE_INFINITY, "terminal resource termination")); } catch { /* the finite grace is the final non-renewing reserve */ }
      result = await wait(terminationMs).catch(() => null);
      if (!result && !settled) {
        const error = new Error("owned resource did not settle after bounded cleanup termination; durable reconciliation is required");
        await terminateWorker(error);
        throw error;
      }
    }
    if (result?.status === "rejected") failures.push(result.reason);
  }
  if (!failures.length) return true;
  const [first, ...rest] = failures;
  if (rest.length && first && typeof first === "object") {
    try { Object.defineProperty(first, "otherCleanupFailures", { value: rest, enumerable: false }); } catch { /* first still propagates */ }
  }
  throw first;
}
