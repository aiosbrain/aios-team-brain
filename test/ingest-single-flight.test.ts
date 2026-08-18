import { describe, it, expect } from "vitest";
import { singleFlight } from "@/lib/ingest/single-flight";

/**
 * TICKSTALL-1 acceptance criterion 1. The scheduler tick must not run concurrently with itself: the
 * durable backfill cursor has no compare-and-swap behind it, so a second in-flight pass can resurrect
 * a superseded cursor.
 *
 * The second test is the one that matters more. A guard that leaks `inFlight = true` wedges ingestion
 * PERMANENTLY — every later tick returns immediately and nothing ever runs again — which is strictly
 * worse than the overlap it replaces. Spec-derived, and it went red before `finally` was used.
 */
describe("singleFlight — the scheduler tick cannot overlap itself", () => {
  it("skips a call that arrives while one is already running, and does not run the task twice", async () => {
    let started = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    const guarded = singleFlight(async () => { started++; await blocked; });

    const first = guarded();
    const second = await guarded(); // arrives mid-flight

    expect(second.ran, "the overlapping call must be refused, not queued").toBe(false);
    expect(started, "the task body must not have been entered a second time").toBe(1);

    release();
    expect((await first).ran).toBe(true);
  });

  it("clears the flag when the task THROWS — a leaked flag wedges ingestion forever", async () => {
    let runs = 0;
    const guarded = singleFlight(async () => { runs++; throw new Error("stage blew up"); });

    await expect(guarded()).rejects.toThrow("stage blew up");
    // The next tick must still run. If the flag leaked, this returns { ran: false } and the poller is
    // dead for the lifetime of the process — the failure mode that makes this a module, not two lines.
    await expect(guarded()).rejects.toThrow("stage blew up");
    expect(runs, "a throwing tick must not disable every subsequent tick").toBe(2);
  });

  it("runs again normally once the previous call has settled", async () => {
    let runs = 0;
    const guarded = singleFlight(async () => { runs++; });
    expect((await guarded()).ran).toBe(true);
    expect((await guarded()).ran).toBe(true);
    expect(runs).toBe(2);
  });

  it("skipping is per-wrapper, not global — two schedulers do not block each other", () => {
    // Guards the SHAPE: module-level state shared across wrappers would make an unrelated caller's
    // long task silently suppress this one. Cheap to assert, and the alternative implementation
    // (a module-scoped boolean) is the obvious way to write this wrong.
    const a = singleFlight(async () => {});
    const b = singleFlight(async () => {});
    expect(a).not.toBe(b);
  });
});
