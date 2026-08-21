import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * GRAPHSAT-2 — the graphiti image's build-time verifier is itself proven to discriminate. The
 * landed-watermark re-queue rule rests on the shipped ingest router being ONE serial queue; the
 * Dockerfile asserts that with graphiti/verify-single-worker.py against the patched file. Here the
 * verifier runs against a committed fixture copy of upstream's router (accepted) and against mutated
 * copies — each of which must be rejected with its named reason. python3 is a declared dependency of
 * the unit tier (CI installs it for the same-item patch guard).
 */

const root = join(import.meta.dirname, "..", "..");
const verifier = join(root, "graphiti", "verify-single-worker.py");
const fixture = readFileSync(join(root, "test", "fixtures", "graphiti", "ingest.py"), "utf8");

function run(src: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "single-worker-"));
  const p = join(dir, "ingest.py");
  writeFileSync(p, src);
  const r = spawnSync("python3", [verifier, p], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("graphiti single-worker verifier", () => {
  it("accepts upstream's router (one singleton, one task, one unbounded queue, one job per message)", () => {
    const r = run(fixture);
    expect(r.ok, r.out).toBe(true);
  });

  const mutations: [string, (s: string) => string, RegExp][] = [
    ["a second AsyncWorker() singleton", (s) => s.replace("async_worker = AsyncWorker()", "async_worker = AsyncWorker()\nasync_worker_b = AsyncWorker()"), /exactly one module-level AsyncWorker\(\) singleton/],
    ["a second worker task", (s) => s.replace("self.task = asyncio.create_task(self.worker())", "self.task = asyncio.create_task(self.worker())\n        self.task2 = asyncio.create_task(self.worker())"), /exactly one asyncio.create_task/],
    ["a bounded queue", (s) => s.replace("asyncio.Queue()", "asyncio.Queue(maxsize=100)"), /unbounded/],
    ["a second queue", (s) => s.replace("self.queue = asyncio.Queue()", "self.queue = asyncio.Queue()\n        self.queue2 = asyncio.Queue()"), /exactly one asyncio.Queue/],
    ["one job per REQUEST instead of per message", (s) => s.replace("    for m in request.messages:\n        await async_worker.queue.put(partial(add_messages_task, m))", "    await async_worker.queue.put(partial(add_messages_task, request.messages))"), /one queued job per message/],
  ];
  for (const [label, mutate, reason] of mutations) {
    it(`rejects ${label}`, () => {
      const src = mutate(fixture);
      expect(src).not.toBe(fixture); // the mutation applied
      const r = run(src);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(reason);
    });
  }
});
