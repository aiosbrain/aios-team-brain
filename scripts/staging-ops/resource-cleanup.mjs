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
