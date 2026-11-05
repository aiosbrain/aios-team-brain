import { describe, expect, it } from "vitest";
import {
  canonicalGdriveVersion,
  compareGdriveVersions,
  decideGdriveObservation,
  gdriveCanonicalFingerprint,
} from "@/lib/ingest/gdrive-observation";

// AIO-1167 R95 — the provider's order for one Drive document is its certified `version`, an opaque
// decimal string compared exactly (never through a JS number), and only a strictly newer certified
// observation replaces the canonical item.

describe("canonicalGdriveVersion", () => {
  it.each([
    ["0007", "7"], ["0", "0"], ["000", "0"], ["42", "42"],
    ["9007199254740993", "9007199254740993"],
    ["184467440737095516160000000000", "184467440737095516160000000000"],
  ])("canonicalizes %s", (raw, canonical) => {
    expect(canonicalGdriveVersion(raw)).toBe(canonical);
  });

  it.each([
    [""], ["-1"], [" 7"], ["7 "], ["1e3"], ["7.0"], ["١٢"], [7], [9007199254740992], [true], [null], [undefined], [["7"]],
  ])("rejects %j as missing/malformed", (raw) => {
    expect(canonicalGdriveVersion(raw)).toBeNull();
  });
});

describe("compareGdriveVersions", () => {
  it("is exact past 2^53, where a number comparison ties", () => {
    expect(Number("9007199254740993")).toBe(Number("9007199254740992"));
    expect(compareGdriveVersions("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareGdriveVersions("9007199254740992", "9007199254740993")).toBe(-1);
  });

  it("orders by magnitude, not by lexicographic text", () => {
    expect(compareGdriveVersions("10", "9")).toBe(1);
    expect(compareGdriveVersions("9", "10")).toBe(-1);
    expect(compareGdriveVersions("42", "42")).toBe(0);
    expect(compareGdriveVersions("184467440737095516160000", "99999999999999999999999")).toBe(1);
  });
});

describe("decideGdriveObservation", () => {
  const fp = (sha: string, title = "T") => gdriveCanonicalFingerprint(sha, { title, source_ts: "s", modified_time: "m" });
  const at = (version: string | null, sha = "a", title = "T") => ({ version, fingerprint: fp(sha, title) });

  it("creates, and lets a strictly newer certified version replace", () => {
    expect(decideGdriveObservation(null, at("1"))).toBe("apply");
    expect(decideGdriveObservation(at("5"), at("6", "b"))).toBe("apply");
    expect(decideGdriveObservation(at("9007199254740992"), at("9007199254740993", "b"))).toBe("apply");
  });

  it("never lets an older version replace — even with an identical body", () => {
    expect(decideGdriveObservation(at("6", "b"), at("5", "a"))).toBe("stale");
    expect(decideGdriveObservation(at("6", "a"), at("5", "a"))).toBe("stale");
    expect(decideGdriveObservation(at("9007199254740993"), at("9007199254740992"))).toBe("stale");
  });

  it("never lets a missing or malformed token overwrite a certified item", () => {
    expect(decideGdriveObservation(at("6"), at(null, "b"))).toBe("stale");
    expect(decideGdriveObservation(at("6"), at(canonicalGdriveVersion("6a"), "b"))).toBe("stale");
  });

  it("upgrades a legacy (tokenless) item, and keeps legacy-over-legacy as before", () => {
    expect(decideGdriveObservation(at(null), at("3", "b"))).toBe("apply");
    expect(decideGdriveObservation(at(null), at(null, "b"))).toBe("apply");
  });

  it("an equal version is an idempotent replay when identical, a conflict when not", () => {
    expect(decideGdriveObservation(at("7"), at("7"))).toBe("apply");
    expect(decideGdriveObservation(at("7", "a"), at("7", "b"))).toBe("conflict");
    expect(decideGdriveObservation(at("7", "a", "Old"), at("7", "a", "New"))).toBe("conflict");
  });

  it("per-connection fields are not part of the canonical payload", () => {
    const a = gdriveCanonicalFingerprint("x", { title: "T", connection_id: "A", attribution_diagnostics: [1] });
    const b = gdriveCanonicalFingerprint("x", { title: "T", connection_id: "B", attribution_diagnostics: [] });
    expect(a).toBe(b);
  });
});
