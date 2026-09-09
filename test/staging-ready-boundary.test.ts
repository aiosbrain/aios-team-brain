import { describe, expect, it, vi } from "vitest";
import { reconcileReadyInstall } from "../scripts/staging-ops/importer.mjs";

const READY_OBJECT = `ready-run--${"a".repeat(64)}`;
const PRIOR_OBJECT = `prior-run--${"b".repeat(64)}`;
const SOURCE_OBJECT = `source-run--${"c".repeat(64)}`;
const COMMIT = "d".repeat(40);
const HEAD = "e".repeat(40);

const ready = () => ({
  state: "ready",
  run_id: "ready-run",
  last_ready_run_id: "ready-run",
  last_ready_object_id: READY_OBJECT,
  last_ready_digest: "a".repeat(64),
  last_ready_commit: COMMIT,
  last_ready_mode: "copy-ready",
  rollback_target_run_id: "prior-run",
  rollback_target_object_id: PRIOR_OBJECT,
  rollback_target_digest: "b".repeat(64),
  rollback_target_commit: "f".repeat(40),
  rollback_target_mode: "copy-ready",
});

function scenario(failAt?: "verify" | "pointer" | "watermark" | "head" | "catchup" | "clear") {
  const rollbackStore = {
    verify: vi.fn(async () => failAt !== "verify"),
    writePointer: vi.fn(async () => { if (failAt === "pointer") throw new Error("pointer failed"); }),
    delete: vi.fn(async () => true),
  };
  const operations = {
    recordSourceWatermark: vi.fn(async () => { if (failAt === "watermark") throw new Error("watermark failed"); return {}; }),
    readStagingHead: vi.fn(async () => { if (failAt === "head") throw new Error("head failed"); return HEAD; }),
    recordCatchup: vi.fn(async () => { if (failAt === "catchup") throw new Error("catchup failed"); return {}; }),
    clearRollbackTarget: vi.fn(async () => { if (failAt === "clear") throw new Error("clear failed"); return { ...ready(), rollback_target_run_id: null, rollback_target_object_id: null }; }),
  };
  return { rollbackStore, operations };
}

describe("H2 — durable ready is the destructive rollback boundary", () => {
  it.each(["verify", "pointer", "watermark", "head", "catchup", "clear"] as const)(
    "retains the prior target when post-ready %s bookkeeping fails",
    async (failAt) => {
      const { rollbackStore, operations } = scenario(failAt);
      const canonical = ready();
      await expect(reconcileReadyInstall({
        client: {}, ready: canonical,
        opened: { manifest: { runId: "ready-run", captureEndedAt: "2026-09-08T00:00:00Z" } },
        sourceObjectId: SOURCE_OBJECT, rollbackStore, env: {}, operations,
      })).rejects.toThrow();

      // Nothing destructive belongs to this suffix. The journal object still names the serving
      // identity and the preserved prior target, and neither artifact has been deleted.
      expect(canonical).toMatchObject({
        state: "ready", last_ready_object_id: READY_OBJECT,
        rollback_target_object_id: PRIOR_OBJECT,
      });
      expect(rollbackStore.delete).not.toHaveBeenCalled();
    },
  );

  it("reconciles from canonical journal identity and only then retires the preserved artifacts", async () => {
    const { rollbackStore, operations } = scenario();
    const result = await reconcileReadyInstall({
      client: {}, ready: ready(),
      opened: { manifest: { runId: "ready-run", captureEndedAt: "2026-09-08T00:00:00Z" } },
      sourceObjectId: SOURCE_OBJECT, rollbackStore, env: {}, operations,
    });
    expect(rollbackStore.writePointer).toHaveBeenCalledWith("last-ready", expect.objectContaining({ objectId: READY_OBJECT, commit: COMMIT }));
    expect(operations.recordCatchup).toHaveBeenCalledWith({}, { commit: HEAD, attempts: 0 });
    expect(operations.clearRollbackTarget).toHaveBeenCalledWith({}, "ready-run");
    expect(rollbackStore.delete.mock.calls.map(([id]) => id).sort()).toEqual([PRIOR_OBJECT, SOURCE_OBJECT].sort());
    expect(result.catchup).toBe(HEAD);
  });

  it("reports cleanup failures without rolling back or deleting the canonical ready artifact", async () => {
    const { rollbackStore, operations } = scenario();
    rollbackStore.delete.mockRejectedValueOnce(new Error("cleanup close failed"));
    const result = await reconcileReadyInstall({
      client: {}, ready: ready(),
      opened: { manifest: { runId: "ready-run", captureEndedAt: "2026-09-08T00:00:00Z" } },
      sourceObjectId: SOURCE_OBJECT, rollbackStore, env: {}, operations,
    });
    expect(result.cleanupErrors).toEqual(["cleanup close failed"]);
    expect(rollbackStore.delete).not.toHaveBeenCalledWith(READY_OBJECT);
  });
});
