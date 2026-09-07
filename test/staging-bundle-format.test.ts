import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packPair, unpackPair, validatePairManifest } from "../scripts/staging-ops/bundle-format.mjs";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(path.join(os.tmpdir(), "pair-format-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("immutable pair format", () => {
  it("round-trips binary PG, transformed auth and typed graph with per-file checksums", async () => {
    const a = dir();
    writeFileSync(path.join(a, "postgres.dump"), Buffer.from([0, 255, 8]));
    writeFileSync(path.join(a, "auth_users.csv"), "id,password_hash\n1,\n");
    const graphLedger = "team_id,source_table,source_id,group_id,episode_uuid\nt,items,i,g,e\n";
    writeFileSync(path.join(a, "graph_episodes.csv"), graphLedger);
    const graph = { codecVersion: 1, nodes: [], relationships: [], sanitation: {} };
    const packed = await packPair(a, graph);
    expect(packed.checksums.graphLedger.bytes).toBe(Buffer.byteLength(graphLedger));
    const b = dir();
    expect(await unpackPair(packed.payload, b, packed.checksums)).toEqual(graph);
    expect(readFileSync(path.join(b, "graph_episodes.csv"), "utf8")).toBe(graphLedger);
    const tampered = JSON.parse(packed.payload.toString());
    tampered.graph = Buffer.from("different").toString("base64");
    await expect(unpackPair(Buffer.from(JSON.stringify(tampered)), dir(), packed.checksums)).rejects.toThrow(/checksum/);
  });

  it("refuses expired and incomplete build metadata", () => {
    const base = { formatVersion: 1, graphCodecVersion: 1, runId: "r", captureStartedAt: "2026-01-01T00:00:00Z", captureEndedAt: "2026-01-01T00:01:00Z", expiresAt: "2026-01-02T00:00:00Z", checksums: Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((n) => [n, { sha256: "a".repeat(64) }])), build: {} };
    expect(validatePairManifest(base, Date.parse("2026-01-03T00:00:00Z")).ok).toBe(false);
  });
});
