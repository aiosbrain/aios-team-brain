import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCompatibleBuildIdentity,
  assertInstalledSchemaMatches,
  catalogCensus,
  loaderCapabilityIdentity,
  schemaFingerprintDigest,
} from "../scripts/staging-ops/build-identity.mjs";

const root = process.cwd();
const loader = loaderCapabilityIdentity(root);
const build = (over: Record<string, unknown> = {}) => ({
  applicationCommit: "a".repeat(40),
  schemaFingerprint: "c".repeat(64),
  migrationSet: loader.migrationSet,
  ...over,
});

describe("B4 — loader identity is the runner image, not the live target", () => {
  it("derives the loader's capability from its own schema and migration files", () => {
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const migrationDir = path.join(root, "postgres/migrations");
    const files = existsSync(migrationDir) ? readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort() : [];
    expect(loader.migrationSet.entries).toHaveLength(files.length + 1);
    expect(loader.migrationSet.entries[0]).toEqual({
      path: "postgres/schema.sql",
      sha256: digest(readFileSync(path.join(root, "postgres/schema.sql"))),
    });
    // The property that matters: nothing here reads a database. The pre-drain gate cannot depend
    // on the catalog it is about to replace, which is what blocked staging-only schema changes and
    // made a half-installed target unrecoverable.
    expect(Object.keys(loader)).toEqual(["version", "migrationSet"]);
  });

  it("is stable across calls, so it cannot drift with the target", () => {
    expect(loaderCapabilityIdentity(root).migrationSet.sha256).toBe(loader.migrationSet.sha256);
  });

  it("accepts a payload built by the same migration set", () => {
    expect(() => assertCompatibleBuildIdentity(build(), loader)).not.toThrow();
  });

  it.each([
    ["a different migration set", build({ migrationSet: { sha256: "9".repeat(64) } }), /upgrade the pinned runner image separately/],
    ["an absent migration set", build({ migrationSet: undefined }), /incompatible with the source build/],
    ["an unknown application commit", build({ applicationCommit: "not-a-sha" }), /absent or unknown/],
    ["no declared catalog digest", build({ schemaFingerprint: undefined }), /declares no canonical database schema fingerprint/],
  ])("refuses %s", (_label, payload, message) => {
    expect(() => assertCompatibleBuildIdentity(payload, loader)).toThrow(message as RegExp);
  });
});

describe("B4 — the installed result is verified and a difference is REPORTED", () => {
  const lines = ["column\titems.id\tuuid null=false", "relation\titems\tr persistence=p rowsecurity=false"];

  it("passes when the installed catalog matches the payload's declared digest", () => {
    const declared = schemaFingerprintDigest(lines);
    expect(assertInstalledSchemaMatches(declared, lines)).toEqual({ ok: true, digest: declared });
  });

  it("names the difference rather than inventing a compatibility path", () => {
    let thrown: Error | undefined;
    try { assertInstalledSchemaMatches("f".repeat(64), lines, { context: "installed source pair run-1" }); }
    catch (error) { thrown = error as Error; }
    expect(thrown?.message).toMatch(/installed source pair run-1 catalog digest/);
    expect(thrown?.message).toMatch(/reported for diagnosis, not reconciled/);
    // The diagnostic is a bounded census, not a fabricated line-level diff: the payload carries the
    // source DIGEST and not its lines, so no such diff is derivable on this side.
    expect(thrown?.message).toContain("column=1 relation=1");
  });

  it("summarises by catalog kind and nothing else", () => {
    expect(catalogCensus([...lines, "index\titems.items_pkey\tCREATE UNIQUE INDEX"])).toBe("column=1 index=1 relation=1");
  });

  it("refuses an empty catalog instead of digesting nothing", () => {
    expect(() => schemaFingerprintDigest([])).toThrow(/fingerprint is empty/);
  });
});
