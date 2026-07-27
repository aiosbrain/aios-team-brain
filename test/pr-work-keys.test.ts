import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs shared by the two PR workflows; no types, deliberately dependency-free.
import { extractWorkKeys, knownKeysFrom, taskRowsFrom, verifyKeys, TASKS_PAGE_BOUND } from "../scripts/pr-work-keys.mjs";

/**
 * The PR work-key check, which shipped broken because it lived in a YAML heredoc no test tier could reach.
 *
 * It exists to answer one question honestly — "does the ticket this PR cites actually exist?" — after a
 * session of PRs cited invented `AIO-48x` keys, passed a format-only check, and linked to nothing on the
 * timeline. Its first real run then reported a REAL key as nonexistent, which is the worse failure: an
 * advisory warning that accuses on no evidence gets ignored, and then it protects nothing.
 */

describe("extractWorkKeys — what the PR CLAIMS, not what it discusses", () => {
  it("takes keys from the title, body and branch name", () => {
    const keys = extractWorkKeys({
      title: "fix(timeline): something (AIO-484)",
      body: "AIOS-Work: AIO-500",
      head: { ref: "feat/AIO-501-thing" },
    });
    expect(keys.sort()).toEqual(["AIO-484", "AIO-500", "AIO-501"]);
  });

  it("ignores a key inside INLINE CODE — prose about keys is not a claim", () => {
    // The real regression: a PR explaining that the model "sees `T1…Tn`" was read as citing `T1`, so the
    // check warned that T1 doesn't exist AND the merge step would have posted T1 as a key to close.
    const keys = extractWorkKeys({ title: "", body: "the model sees `T1` and `T2` with no way to know whose is whose", head: { ref: "" } });
    expect(keys).toEqual([]);
  });

  it("ignores keys inside a fenced block", () => {
    const keys = extractWorkKeys({ title: "", body: "example:\n```\nAIOS-Work: AIO-999\n```\n", head: { ref: "" } });
    expect(keys).toEqual([]);
  });

  it("ignores keys after an UNCLOSED fence", () => {
    // A lazy `[\s\S]*?` needs a closing fence, so one stray ``` used to leave the whole rest of the body
    // matchable. Failing toward over-match is the direction that closes someone else's ticket on merge.
    expect(extractWorkKeys({ title: "", body: "example:\n```\nAIOS-Work: AIO-999\nand more prose", head: { ref: "" } })).toEqual([]);
  });

  it("ignores keys inside a ~~~ fence", () => {
    expect(extractWorkKeys({ title: "", body: "x:\n~~~\nAIO-999\n~~~\n", head: { ref: "" } })).toEqual([]);
  });

  it("ignores the PR template's commented-out placeholder", () => {
    expect(extractWorkKeys({ title: "", body: "<!-- e.g. AIO-72 -->", head: { ref: "" } })).toEqual([]);
  });

  it("still finds a real key in a body that ALSO discusses keys in code spans", () => {
    // The stripping must not swallow the claim: this is the shape of every PR that explains its own work.
    const keys = extractWorkKeys({ title: "", body: "the model sees `T1`.\n\nAIOS-Work: AIO-484", head: { ref: "" } });
    expect(keys).toEqual(["AIO-484"]);
  });
});

describe("knownKeysFrom — the response shape the endpoint actually returns", () => {
  it("reads keys out of the PROJECT-GROUPED response", () => {
    // `GET /api/v1/tasks` answers `{tasks: [{project, rows: [...]}]}`. Reading `tasks` as rows is what
    // produced an empty set — and therefore "every key you cited is invented" — on real data.
    const body = {
      mode: "table",
      tasks: [
        { project: "aios-team-brain", rows: [{ row_key: "AIO-484" }, { row_key: "AIO-537" }] },
        { project: "other", rows: [{ row_key: "OTH-1" }] },
      ],
    };
    expect([...knownKeysFrom(body)].sort()).toEqual(["AIO-484", "AIO-537", "OTH-1"]);
  });

  it("tolerates a flat array of rows", () => {
    expect([...knownKeysFrom([{ row_key: "AIO-1" }, { rowKey: "AIO-2" }])].sort()).toEqual(["AIO-1", "AIO-2"]);
  });

  it("is empty — not a crash — for a shape it doesn't recognise", () => {
    expect(knownKeysFrom({ unexpected: true }).size).toBe(0);
    expect(knownKeysFrom(null).size).toBe(0);
  });
});

describe("verifyKeys — 'we couldn't ask' is NOT 'your key is fake'", () => {
  it("reports UNVERIFIED when no keys came back at all", () => {
    // Zero known keys means an empty response, a shape change, or a tier that sees nothing — each
    // indistinguishable from a brain with no tasks. Calling a real key invented on that evidence is the
    // failure that trains everyone to ignore the warning.
    // `reason` distinguishes the two ways we can fail to know: nothing came back at all vs. a full page
    // that may not contain it. The warning text differs, because the fix differs.
    expect(verifyKeys(["AIO-484"], new Set())).toEqual({ status: "unverified", keys: ["AIO-484"], reason: "empty" });
  });

  it("reports INVENTED only when the brain demonstrably has other keys", () => {
    expect(verifyKeys(["AIO-999"], new Set(["AIO-484"]))).toEqual({ status: "invented", invented: ["AIO-999"], checked: 1 });
  });

  it("reports OK when every cited key exists", () => {
    expect(verifyKeys(["AIO-484"], new Set(["AIO-484", "AIO-537"]))).toEqual({ status: "ok", checked: 2 });
  });

  it("reports NONE when the PR cites nothing", () => {
    expect(verifyKeys([], new Set(["AIO-484"]))).toEqual({ status: "none" });
  });
});

/**
 * The blocker the first version of this fix still had.
 *
 * `?all=1` is bounded at 500 rows, ordered `updated_at` ASCENDING, and table mode does not paginate. Prod
 * had 677 keyed tasks and AIO-484 sat at rank 628 — so the check downloaded the 500 STALEST tasks, never
 * saw the one it was asked about, and would have announced "AIO-484 does not exist (500 task keys
 * checked)". Fixing the response SHAPE alone would have re-run the same false accusation with a bigger,
 * more convincing number attached.
 */
describe("a truncated read cannot prove a key is fake", () => {
  const fullPage = new Set(Array.from({ length: TASKS_PAGE_BOUND }, (_, i) => `OLD-${i}`));

  it("reports UNVERIFIED, not invented, when the page is full and the key wasn't in it", () => {
    const v = verifyKeys(["AIO-484"], fullPage, { truncated: true });
    expect(v.status).toBe("unverified");
    expect(v.reason).toBe("truncated");
    expect(v.keys).toEqual(["AIO-484"]);
  });

  it("STILL confirms a key that IS in the truncated page — absence proves nothing, presence proves it", () => {
    // The check must not degrade to useless: a full page is still positive evidence for what it contains.
    const withIt = new Set([...fullPage, "AIO-484"]);
    expect(verifyKeys(["AIO-484"], withIt, { truncated: true }).status).toBe("ok");
  });

  it("still calls a key invented when the read was NOT truncated", () => {
    // The whole point of the check survives: a short page is the whole table, so absence is real evidence.
    expect(verifyKeys(["AIO-999"], new Set(["AIO-484"]), { truncated: false }).status).toBe("invented");
  });

  it("TASKS_PAGE_BOUND matches the bound the API actually enforces", () => {
    // Pinned against the route's own constant — if PAGE moves and this doesn't, the check silently stops
    // detecting truncation and goes back to accusing.
    const route = readFileSync(join(process.cwd(), "app", "api", "v1", "tasks", "route.ts"), "utf8");
    expect(route).toContain(`const PAGE = ${TASKS_PAGE_BOUND};`);
  });

  it("taskRowsFrom counts rows across project groups, so truncation is detectable", () => {
    const body = { tasks: [{ project: "a", rows: [{ row_key: "X-1" }, { row_key: "X-2" }] }, { project: "b", rows: [{ row_key: "X-3" }] }] };
    expect(taskRowsFrom(body).length).toBe(3);
  });
});
