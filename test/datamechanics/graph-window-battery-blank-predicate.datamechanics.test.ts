import { describe, expect, it } from "vitest";
import { runSql } from "@/lib/db/pg/pool";
import { chunkContent } from "@/lib/graph/project";
// @ts-expect-error — plain .mjs script, no types.
import { blankBodySql } from "../../scripts/graph-window-battery/corpus.mjs";

/**
 * Spec: the battery's "this body yields no episodes" SQL predicate must agree with `chunkContent`,
 * which decides it with JS `.trim()` (PIPEFF-2 / AIO-821).
 *
 * THIS BELONGS IN THE REAL-POSTGRES TIER AND NOWHERE ELSE. The whole subtlety is Postgres string
 * semantics: `btrim/1` strips **spaces only**, so `btrim(E'  \n\t  ')` is `E'\n\t'`, not `''`. The
 * first version of the battery used `btrim(body) = ''` and would therefore have counted a
 * newline-or-tab-only body as a one-episode item that the projector then emits ZERO episodes for.
 *
 * That divergence is not cosmetic: the counted and pushed episode totals drift apart, which can trip
 * the `armsCompleted` validity check and invalidate a paid session over an instrument bug, and it
 * skews the single-chunk share that makes C1 transferable to prod.
 *
 * A unit test cannot catch any of this — it would hand-feed a `blank` boolean the SQL would never
 * have produced, which is exactly how the original whitespace test passed while the bug was live.
 */
describe("blankBodySql agrees with chunkContent about which bodies yield no episodes", () => {
  // Each case is one whitespace shape. Plain spaces are the case both predicates get right; the
  // others are the ones only the regex gets right.
  const blankCases = ["", " ", "   ", "\n", "\t", "  \n\t  ", "\r\n", ""];
  const nonBlankCases = ["a", " a ", "\n#\n", "0"];

  it("marks every whitespace-only body blank, matching chunkContent's empty output", async () => {
    for (const body of blankCases) {
      const { rows } = await runSql<{ blank: boolean }>(`select (${blankBodySql("$1::text")}) as blank`, [body]);
      expect(chunkContent(body), `chunkContent for ${JSON.stringify(body)}`).toEqual([]);
      expect(rows[0].blank, `SQL predicate for ${JSON.stringify(body)}`).toBe(true);
    }
  });

  it("marks every content-bearing body non-blank, matching chunkContent's non-empty output", async () => {
    for (const body of nonBlankCases) {
      const { rows } = await runSql<{ blank: boolean }>(`select (${blankBodySql("$1::text")}) as blank`, [body]);
      expect(chunkContent(body).length, `chunkContent for ${JSON.stringify(body)}`).toBeGreaterThan(0);
      expect(rows[0].blank, `SQL predicate for ${JSON.stringify(body)}`).toBe(false);
    }
  });

  it("proves the predicate this replaced was WRONG — btrim strips spaces only", async () => {
    // Non-vacuity: if this ever starts agreeing, the case above stopped discriminating and the two
    // tests together no longer prove the fix.
    const { rows } = await runSql<{ old_says_blank: boolean; js_says_blank: boolean }>(
      `select (btrim($1::text) = '') as old_says_blank, true as js_says_blank`,
      ["  \n\t  "]
    );
    expect(rows[0].old_says_blank).toBe(false);
    expect(chunkContent("  \n\t  ")).toEqual([]);
  });
});
