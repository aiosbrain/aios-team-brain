import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PAYLOAD_ROWS,
  itemPayloadSchema,
  wireItemPayloadSchema,
} from "@/lib/api/item-payload-schema";

/**
 * The `rows` ceiling is a WIRE bound, not a storage invariant (AIO-923). This guard pins the
 * distinction, because collapsing the two is a silent, total outage rather than a visible error.
 *
 * Spec = the regression this split exists to prevent. `ingestItem` (`lib/ingest/index.ts`)
 * re-parses EVERY payload through `itemPayloadSchema`, including the ones the in-process mirror
 * legs build — and those have no transport step and legitimately exceed the wire ceiling:
 * `fetchLinearTeam` paginates `issues(first: 100)` over up to 200 pages into ONE `task` item
 * (20,000 rows), with the GitHub and Plane legs shaped the same. Applying the cap to the shared
 * schema turns a working Linear import into an `IngestValidationError` on every scheduler tick,
 * caught by the per-integration `catch` in `lib/ingest/run.ts` — so the task mirror AND all its
 * per-issue documents stop importing, permanently, with remediation advice ("narrow the source
 * selection") that a Linear-team admin cannot act on.
 *
 * So: the route parses with `wireItemPayloadSchema`, `ingestItem` with `itemPayloadSchema`, and
 * neither may drift into the other.
 */

const ROOT = join(import.meta.dirname, "..", "..");

function payload(rowCount: number) {
  return {
    project: "p",
    path: "tasks.md",
    kind: "task" as const,
    content_sha256: "a".repeat(64),
    access: "team" as const,
    body: "x",
    rows: Array.from({ length: rowCount }, (_, i) => ({ row_key: `k-${i}`, title: `t-${i}` })),
  };
}

describe("wire vs storage item-payload schema", () => {
  it("the WIRE schema rejects above the ceiling, naming rows and the limit", () => {
    const parsed = wireItemPayloadSchema.safeParse(payload(MAX_PAYLOAD_ROWS + 1));
    expect(parsed.success).toBe(false);
    // route.ts returns `issues[0].message` verbatim and drops the path.
    expect(parsed.error!.issues[0].message).toContain("rows");
    expect(parsed.error!.issues[0].message).toContain(String(MAX_PAYLOAD_ROWS));
  });

  it("the WIRE schema accepts exactly the ceiling (the cap is off-by-one clean)", () => {
    expect(wireItemPayloadSchema.safeParse(payload(MAX_PAYLOAD_ROWS)).success).toBe(true);
  });

  it("the STORAGE schema accepts a Linear-sized mirror payload the wire would refuse", () => {
    // 20,000 = fetchLinearTeam's own ceiling (200 pages × first: 100). If this ever goes red, an
    // in-process import has started failing on every tick.
    expect(itemPayloadSchema.safeParse(payload(20_000)).success).toBe(true);
    expect(wireItemPayloadSchema.safeParse(payload(20_000)).success).toBe(false);
  });

  it("ingestItem parses with the STORAGE schema and the items route with the WIRE one", () => {
    // A call-site pin: the two schemas only mean anything if each is used in exactly one place.
    // Nothing else in the codebase pins which parser each seam uses, so a one-word import change
    // would silently reinstate the outage above with every test still green.
    const ingest = readFileSync(join(ROOT, "lib", "ingest", "index.ts"), "utf8");
    expect(ingest).toContain("itemPayloadSchema.safeParse");
    expect(ingest).not.toContain("wireItemPayloadSchema");

    const route = readFileSync(join(ROOT, "app", "api", "v1", "items", "route.ts"), "utf8");
    expect(route).toContain("wireItemPayloadSchema.safeParse");
    // ...and NOT the uncapped one (`wireItemPayloadSchema` contains the substring, so match the
    // bare identifier at an import/usage boundary rather than a naive `includes`).
    expect(/(?<!wire)(?<![A-Za-z])itemPayloadSchema\b/.test(route)).toBe(false);
  });

  it("the fetchLinearTeam pagination ceiling this guard is calibrated to still holds", () => {
    // Non-vacuity: the 20,000 above is only meaningful while Linear's fetch really can reach it.
    const linear = readFileSync(join(ROOT, "lib", "ingest", "sources", "linear.ts"), "utf8");
    expect(linear).toMatch(/issues\(first:\s*100/);
    expect(linear).toMatch(/i\s*<\s*200/);
  });
});
