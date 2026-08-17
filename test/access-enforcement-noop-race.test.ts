import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { setAccessEnforcement } from "@/lib/admin/access-enforcement";

/**
 * The no-op flip's read-back discipline (Fable delta review D2).
 *
 * `setAccessEnforcement` reads the mode BACK off the row before reporting success, and the WRITE
 * path refuses when the read-back disagrees with what was asked for. The no-op path (`previous ===
 * mode`, so nothing is written) reads back too — and that read can disagree for the same reason:
 * a second operator flipping the row between our `previous` read and the read-back. Without the
 * check the command reports `ok`, prints a mode nobody asked for, and — because `auditFlip` fires
 * on `written.mode !== previous` — writes a phantom `access.enforcement_changed` row attributed to
 * the WRONG operator, duplicating the real one.
 *
 * This is a unit test rather than a data-mechanics one on purpose: the failure is a race between
 * two reads of the same row, which real Postgres cannot be made to reproduce deterministically.
 * The stub interleaves the two reads exactly as the race would.
 */

/** A DbClient whose `teams` read returns `reads` in order — i.e. a row that changes underneath us.
 *  `allowWrite` arms the WRITE-path variant (PRET-2's guarded predicate): the update "succeeds"
 *  (matches zero rows — the adapter reports no error either way), and the subsequent read-back
 *  reveals the raced row. */
function racingDb(reads: string[], audits: unknown[], opts: { allowWrite?: boolean } = {}): DbClient {
  return {
    from(table: string) {
      if (table === "audit_log") {
        return {
          insert: async (row: unknown) => {
            audits.push(row);
            return { error: null };
          },
        };
      }
      if (table === "teams") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { access_enforcement: reads.shift() ?? "permissive" },
                error: null,
              }),
            }),
          }),
          update: () => {
            if (!opts.allowWrite) throw new Error("the no-op path must never UPDATE the row");
            // The guarded update (…and access_enforcement = previous) against a raced row
            // matches ZERO rows — RETURNING yields an empty set (Codex M2: the matched-row
            // count, not a read-back, is what distinguishes "my write landed" from "someone
            // else landed the same mode").
            const chain = {
              eq: () => chain,
              select: async () => ({ data: [], error: null }),
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as DbClient;
}

describe("setAccessEnforcement — the no-op path reads back with the same discipline as the write path", () => {
  it("refuses, and writes no audit row, when the row changed under a no-op flip", async () => {
    const audits: unknown[] = [];
    // Operator A asks for `permissive` on a team that reads `permissive`; operator B flips it to
    // `enforcing` in between A's two reads.
    const res = await setAccessEnforcement(racingDb(["permissive", "enforcing"], audits), "t1", "permissive");

    expect(res.ok, "a mode we did not ask for is not a success").toBe(false);
    expect(res.error).toMatch(/concurrent change/);
    expect(res.error).toMatch(/enforcing/);
    expect(
      audits,
      "the phantom row is the real damage: it would attribute B's flip to A, on top of B's own entry"
    ).toEqual([]);
  });

  it("still reports the honest no-op when nothing raced", async () => {
    const audits: unknown[] = [];
    const res = await setAccessEnforcement(racingDb(["permissive", "permissive"], audits), "t1", "permissive");

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("permissive");
    expect(res.changed).toBe(false);
    expect(audits, "permissive→permissive is not a visibility change worth a trail entry").toEqual([]);
  });

  it("the WRITE path's guarded predicate: a raced write matches zero rows and fails, no audit row (PRET-2)", async () => {
    const audits: unknown[] = [];
    // Operator A downgrades to `permissive` from a row that reads `enforcing`; a concurrent
    // flip moves the row first. A's guarded update matches ZERO rows — and the matched-count
    // judgment catches even the SAME-TARGET race (B landed the same mode A wanted), where the
    // old read-back would have reported A's write as `changed:true` and fired a second,
    // mis-attributed audit row for one actual transition (Codex M2).
    const res = await setAccessEnforcement(racingDb(["enforcing"], audits, { allowWrite: true }), "t1", "permissive");

    expect(res.ok, "a write that did not land is not a success").toBe(false);
    expect(res.error).toMatch(/matched 0 row/);
    expect(audits, "no phantom enforcement_changed row for a write that matched zero rows").toEqual([]);
  });
});
