import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateFileStore } from "../scripts/staging-ops/private-store.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("role-separated private stores", () => {
  it("makes publisher objects immutable and source identity read-only", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bundle-store-")); roots.push(root);
    const publisher = new PrivateFileStore({ root, role: "publisher" });
    await publisher.putImmutable("run-1", Buffer.from("sealed"));
    await expect(publisher.putImmutable("run-1", Buffer.from("replacement"))).rejects.toThrow(/already exists/);
    const reader = new PrivateFileStore({ root, role: "source-reader" });
    await expect(reader.putImmutable("run-2", Buffer.from("x"))).rejects.toThrow(/read-only/);
    expect((await reader.read("run-1")).toString()).toBe("sealed");
  });

  it("lets only importer-owned rollback storage pin a verified source object", async () => {
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "source-store-")); const rollbackRoot = mkdtempSync(path.join(os.tmpdir(), "rollback-store-")); roots.push(sourceRoot, rollbackRoot);
    await new PrivateFileStore({ root: sourceRoot, role: "publisher" }).putImmutable("run-1", Buffer.from("sealed"));
    const rollback = new PrivateFileStore({ root: rollbackRoot, role: "rollback-owner" });
    await rollback.pinFrom(new PrivateFileStore({ root: sourceRoot, role: "source-reader" }), "run-1");
    expect((await rollback.read("run-1")).toString()).toBe("sealed");
    await expect(new PrivateFileStore({ root: sourceRoot, role: "source-reader" }).delete("run-1")).rejects.toThrow(/only rollback owner/);
    await rollback.delete("run-1");
    await expect(rollback.read("run-1")).rejects.toThrow();
  });
});
