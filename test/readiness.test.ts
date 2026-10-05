import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthResponse, probePostgres } from "@/lib/health/readiness";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function client(query = vi.fn(async () => ({ rows: [] }))) {
  return Object.assign(new EventEmitter(), { query, release: vi.fn() });
}
afterEach(() => vi.useRealTimers());
describe("bounded readiness", () => {
  it("releases healthy connections and removes checked-out error listeners", async () => {
    const c = client();
    expect(await probePostgres(async () => c as unknown as PoolClient)).toBe(
      true,
    );
    expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.listenerCount("error")).toBe(0);
  });
  it("includes checkout in the deadline and releases a late checkout without querying", async () => {
    vi.useFakeTimers();
    const d = deferred<PoolClient>(),
      c = client();
    const p = probePostgres(() => d.promise, 40);
    await vi.advanceTimersByTimeAsync(41);
    expect(await p).toBe(false);
    d.resolve(c as unknown as PoolClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.release).toHaveBeenCalledOnce();
    expect(c.query).not.toHaveBeenCalled();
  });
  it("destroys a stalled query and observes its eventual rejection", async () => {
    vi.useFakeTimers();
    const d = deferred<never>(),
      c = client(vi.fn(() => d.promise));
    const p = probePostgres(async () => c as unknown as PoolClient, 40);
    await vi.advanceTimersByTimeAsync(41);
    expect(await p).toBe(false);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
    d.reject(new Error("late private error"));
    await Promise.resolve();
    expect(c.listenerCount("error")).toBe(0);
  });
  it("handles checked-out connection errors without a second release", async () => {
    const d = deferred<never>(),
      c = client(vi.fn(() => d.promise));
    const p = probePostgres(async () => c as unknown as PoolClient);
    await vi.waitFor(() => expect(c.query).toHaveBeenCalledOnce());
    c.emit("error", new Error("private"));
    expect(await p).toBe(false);
    d.reject(new Error("private"));
    await Promise.resolve();
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("returns safe uncached failures then fresh success", async () => {
    for (const fail of [
      async () => false,
      async () => {
        throw new Error("private connection url");
      },
    ]) {
      const r = await healthResponse(fail);
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ ok: false });
    }
    const r = await healthResponse(async () => true, "abc");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, commit: "abc" });
  });
});
