import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";
import type { ItemPayload } from "@/lib/api/schemas";

vi.mock("server-only", () => ({}));

const { ingestItem } = await import("@/lib/ingest");
const { FakeSupabase } = await import("@/lib/ingest/fake-supabase");

/**
 * GUARD (AIO-1167, HIGH): Google Drive ownership is enforced by the COMMON writer, not remembered by
 * its callers.
 *
 * `ingestItem` is the sole content writer, and callers reach it without the Drive execution fence
 * (`note.create` via `POST /api/v1/actions` and approvals, meetings, connectors, the scanner, seed
 * scripts). The invariant: inside `ingestItem`, after the canonical item row is locked and BEFORE
 * the first changed or unchanged mutation, every writer that is not a fenced Drive commit runs
 * `assertNotDriveOwnedTarget` — unconditionally, never behind an optional caller-supplied flag —
 * and the fenced-commit capability is only an object `ingestGdriveApiItem` minted
 * (`fencedDriveCommits`), never one a caller built.
 *
 * Two layers: the behaviour on the fake client (fast, every run; the real-Postgres proof is
 * `test/datamechanics/drive-common-writer-ownership.datamechanics.test.ts`), and a structural
 * predicate with NEGATIVE CONTROLS — each mutation that removes or weakens the enforcement must make
 * the predicate fail, so a refactor cannot quietly turn the guard into a tautology.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = readFileSync(join(ROOT, "lib", "ingest", "index.ts"), "utf8");

const AUTH = { teamId: "00000000-0000-4000-8000-00000000d71e", memberId: "mem-1", apiKeyId: "key-1" };

function payload(over: Partial<ItemPayload> = {}): ItemPayload {
  return {
    project: "acme", path: "notes/owned.md", kind: "deliverable", content_sha256: "a".repeat(64),
    access: "team", actor: "member", frontmatter: { source: "notion" }, body: "hello", ...over,
  } as ItemPayload;
}

/** The body of `export async function ingestItem(` up to the next top-level declaration. */
function ingestItemBody(src: string): string {
  const start = src.indexOf("export async function ingestItem(");
  if (start < 0) return "";
  const rest = src.slice(start);
  const end = rest.slice(1).search(/\n(export |async function |function |const |interface |type )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/**
 * The structural invariant. Returns the list of violations (empty = holds).
 */
function enforcementViolations(src: string): string[] {
  const problems: string[] = [];
  const body = ingestItemBody(src);
  if (!body) return ["ingestItem not found"];

  // 1. The capability is checked against the module-private brand before it is trusted.
  const brand = body.indexOf("fencedDriveCommits.has(_internal.gdrive)");
  const trusted = body.indexOf("const gdriveCommit = _internal.gdrive");
  if (brand < 0) problems.push("the fenced-commit capability is not checked against fencedDriveCommits");
  if (trusted < 0 || (brand >= 0 && trusted < brand)) problems.push("gdriveCommit is trusted before the brand check");
  if (!/^const fencedDriveCommits = new WeakSet<GdriveIngestCommit>\(\);$/m.test(src)) problems.push("no module-private brand set");
  if (/\bexport\b[^\n]*\bfencedDriveCommits\b/.test(src)) problems.push("the brand set is exported");

  // 2. The call exists, after the row lock and before the first item mutation.
  const call = body.indexOf("await assertNotDriveOwnedTarget(");
  const lock = body.indexOf("await lockItemContext(session");
  const firstMutation = body.indexOf("if (existing && existing.content_sha256 === contentSha)");
  if (call < 0) problems.push("ingestItem does not call assertNotDriveOwnedTarget");
  if (lock < 0) problems.push("the item row lock was not found");
  if (firstMutation < 0) problems.push("the unchanged-path mutation marker was not found");
  if (call >= 0 && lock >= 0 && call < lock) problems.push("the ownership check runs before the item row is locked");
  if (call >= 0 && firstMutation >= 0 && call > firstMutation) problems.push("the ownership check runs after an item mutation");

  // 3. Its ONLY guard is the fenced commit — never an optional caller-supplied option.
  if (call >= 0) {
    const before = body.slice(0, call);
    const lastIf = before.lastIndexOf("if (");
    const guard = before.slice(lastIf, before.indexOf("{", lastIf) + 1);
    if (guard.replace(/\s+/g, " ") !== "if (!gdriveCommit) {") problems.push(`the ownership check is gated by \`${guard}\``);
    // Nothing between that guard and the call may consult a caller-supplied option.
    if (/_internal\.\w+/.test(before.slice(lastIf))) problems.push("the ownership check depends on a caller-supplied option");
  }

  // 4. The check itself refuses whenever ownership is found.
  const helper = src.slice(src.indexOf("async function assertNotDriveOwnedTarget("));
  const helperBody = helper.slice(0, helper.indexOf("\n}\n") + 2);
  if (!/if \(owned\) throw input\.refusal\(\);/.test(helperBody)) problems.push("the check does not throw on ownership");
  if (!/from\("source_item_mappings"\)[\s\S]*\.eq\("source", "gdrive"\)[\s\S]*\.eq\("item_id", input\.existing\.id\)/.test(helperBody)) {
    problems.push("the check does not consult the Drive provider mapping");
  }
  if (!/stored\.source === "gdrive"/.test(helperBody)) problems.push("the check does not consult stored Drive provenance");
  // 5. Drive CONTENT is refused outright for every unfenced writer — creation and restore included.
  //    No minted-id, mapping or target condition may soften it.
  if (!/if \(input\.driveProvenance\) \{\s*owned = true;\s*\}/.test(helperBody)) {
    problems.push("a Drive-sourced payload is not refused unconditionally");
  }
  if (!/driveProvenance: requestedPayload\.frontmatter\?\.source === "gdrive",/.test(body)) {
    problems.push("the call does not derive Drive provenance from the payload");
  }
  return problems;
}

describe("guard: the common writer enforces Drive ownership", () => {
  it("the shipped source satisfies the invariant", () => {
    expect(enforcementViolations(SOURCE)).toEqual([]);
  });

  it.each([
    ["the call is removed", (src: string) => src.replace(/\n\s*await assertNotDriveOwnedTarget\(db, \{[\s\S]*?\n\s*\}\);/, "\n")],
    ["the call is gated by an optional caller flag", (src: string) =>
      src.replace("if (!gdriveCommit) {\n    // AUTHORITATIVE", "if (!gdriveCommit && _internal.driveOwnedRefusal) {\n    // AUTHORITATIVE")],
    ["the call is moved after the unchanged-path mutation", (src: string) => {
      const match = src.match(/\n\s*if \(!gdriveCommit\) \{\n\s*\/\/ AUTHORITATIVE[\s\S]*?\n\s*\}\);\n\s*\}/);
      if (!match) return src;
      const without = src.replace(match[0], "");
      const marker = "  if (existing && existing.content_sha256 === contentSha) {";
      return without.replace(marker, `${marker}${match[0]}`);
    }],
    ["the brand check is removed", (src: string) => src.replace("fencedDriveCommits.has(_internal.gdrive)", "true")],
    ["the mapping read is dropped", (src: string) => src.replace('.eq("source", "gdrive")', '.eq("source", "none")')],
    ["the refusal is swallowed", (src: string) => src.replace("if (owned) throw input.refusal();", "if (owned) return;")],
    ["a minted-id exception is reintroduced for Drive content", (src: string) =>
      src.replace(/if \(input\.driveProvenance\) \{\s*owned = true;\s*\}/,
        "if (input.driveProvenance) {\n    owned = input.existing !== null;\n  }")],
    ["Drive provenance stops being derived from the payload", (src: string) =>
      src.replace('driveProvenance: requestedPayload.frontmatter?.source === "gdrive",', "driveProvenance: false,")],
  ])("NEGATIVE CONTROL: the predicate fails when %s", (_name, mutate) => {
    const mutated = mutate(SOURCE);
    expect(mutated, "the mutation did not apply — the control would be vacuous").not.toBe(SOURCE);
    expect(enforcementViolations(mutated).length).toBeGreaterThan(0);
  });
});

describe("behaviour: the common writer on the fake client", () => {
  it("refuses a target owned by stored Drive provenance — changed and unchanged body — and leaves every row as it was", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const first = await ingestItem(supa, AUTH, payload(), "team");
    expect(first.status).toBe("created");
    const row = fake.tables.items.find((item) => item.id === first.id)!;
    row.frontmatter = { source: "gdrive", source_id: "doc-1" };
    const before = structuredClone(fake.tables);

    await expect(ingestItem(supa, AUTH, payload({ body: "overwrite", content_sha256: "b".repeat(64) }), "external"))
      .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    await expect(ingestItem(supa, AUTH, payload({ frontmatter: { source: "notion", title: "relabel" } }), "external"))
      .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    expect(fake.tables).toEqual(before);
  });

  it("refuses a target owned by a Drive mapping alone, whatever its own frontmatter says", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const first = await ingestItem(supa, AUTH, payload({ path: "notes/mapped.md" }), "team");
    fake.tables.source_item_mappings = [{
      team_id: AUTH.teamId, source: "gdrive", provider_id: "mapped-doc", item_id: first.id, connection_id: null,
    }];
    const before = structuredClone(fake.tables);

    await expect(ingestItem(supa, AUTH, payload({ path: "notes/mapped.md", body: "overwrite", content_sha256: "c".repeat(64) }), "team"))
      .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    expect(fake.tables).toEqual(before);
  });

  it("refuses Drive CONTENT outright — a first creation of a never-seen document, with or without a provider id — writing nothing", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const before = structuredClone(fake.tables);
    for (const frontmatter of [
      { source: "gdrive", source_id: "never-seen-doc" },
      { source: "gdrive" },
    ]) {
      await expect(ingestItem(supa, AUTH, payload({ path: "gdrive/new.md", frontmatter }), "external"))
        .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    }
    expect(fake.tables).toEqual(before);
    expect(fake.tables.items).toEqual([]);
  });

  it("CONTROL: an ordinary item with no Drive ownership still updates; a same-team mapping for ANOTHER item does not block it", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const first = await ingestItem(supa, AUTH, payload({ path: "notes/plain.md" }), "team");
    fake.tables.source_item_mappings = [{
      team_id: AUTH.teamId, source: "gdrive", provider_id: "elsewhere", item_id: "00000000-0000-4000-8000-000000000001",
      connection_id: null,
    }];
    const updated = await ingestItem(supa, AUTH, payload({ path: "notes/plain.md", body: "v2", content_sha256: "d".repeat(64) }), "team");
    expect(updated).toMatchObject({ status: "updated", id: first.id });
  });
});
