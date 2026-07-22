import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";

// Spec (work-timeline correctness, PR-A): a routine re-sync re-materializes EVERY row in a task file,
// but must NOT bump `updated_at` on rows that didn't actually change — otherwise the Timeline mistakes
// a sibling edit for "worked on today" (the "spawning agents" bug). Plus the two new work-signal
// columns: `worked_at` (provider state-transition, partial-write) and `assigned_at` (stamped only when
// the assignee changes). Real-DB outcomes the in-memory FakeSupabase cannot verify.

type Row = {
  row_key: string;
  title: string;
  assignee?: string;
  worked_at?: string | null;
};

// Push one task-kind item carrying `rows`. A fresh `body` per push forces a materialize (not the
// unchanged fast-path); the body mirrors the rows so it's realistic.
async function pushTasks(seed: Seed, rows: Row[], nonce: string) {
  const body = `# tasks ${nonce}\n\n${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  return ingest(seed, { path: "linear/eng/issues.md", project: "acme", kind: "task", rows, body, access: "team" });
}

async function readTask(seed: Seed, rowKey: string) {
  const { data } = await db()
    .from("tasks")
    .select("row_key, title, assignee, updated_at, worked_at, assigned_at")
    .eq("team_id", seed.teamId)
    .eq("row_key", rowKey)
    .single();
  return data as {
    row_key: string;
    title: string;
    assignee: string;
    updated_at: string | Date;
    worked_at: string | Date | null;
    assigned_at: string | Date | null;
  } | null;
}

const ms = (v: string | Date | null): number => (v === null ? NaN : v instanceof Date ? v.getTime() : Date.parse(v));

describe("task timestamp correctness (real Postgres)", () => {
  it("a sibling-row edit does NOT bump updated_at on the unchanged rows", async () => {
    const seed = await seedTeam();
    await pushTasks(
      seed,
      [
        { row_key: "ENG-1", title: "one" },
        { row_key: "ENG-2", title: "two" },
        { row_key: "ENG-3", title: "three" },
      ],
      "v1"
    );
    const b0 = await readTask(seed, "ENG-2");
    const c0 = await readTask(seed, "ENG-3");
    expect(b0 && c0).toBeTruthy();

    // Re-push: only ENG-1's title changes. ENG-2 / ENG-3 are byte-identical rows.
    await pushTasks(
      seed,
      [
        { row_key: "ENG-1", title: "one — edited" },
        { row_key: "ENG-2", title: "two" },
        { row_key: "ENG-3", title: "three" },
      ],
      "v2"
    );
    const a1 = await readTask(seed, "ENG-1");
    const b1 = await readTask(seed, "ENG-2");
    const c1 = await readTask(seed, "ENG-3");

    // The changed row bumped; the untouched siblings kept their exact prior updated_at (the fix).
    expect(ms(a1!.updated_at)).toBeGreaterThan(ms(b0!.updated_at));
    expect(ms(b1!.updated_at)).toBe(ms(b0!.updated_at));
    expect(ms(c1!.updated_at)).toBe(ms(c0!.updated_at));
  });

  it("worked_at persists (partial-write): present key writes, absent key preserves", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [{ row_key: "ENG-9", title: "t", worked_at: "2026-07-05T00:00:00.000Z" }], "w1");
    const r0 = await readTask(seed, "ENG-9");
    expect(ms(r0!.worked_at)).toBe(Date.parse("2026-07-05T00:00:00.000Z"));

    // A later push that OMITS worked_at must preserve the stored value (not clear it).
    await pushTasks(seed, [{ row_key: "ENG-9", title: "t — edited" }], "w2");
    const r1 = await readTask(seed, "ENG-9");
    expect(ms(r1!.worked_at)).toBe(Date.parse("2026-07-05T00:00:00.000Z"));

    // A new transition updates it.
    await pushTasks(seed, [{ row_key: "ENG-9", title: "t — edited", worked_at: "2026-07-10T00:00:00.000Z" }], "w3");
    const r2 = await readTask(seed, "ENG-9");
    expect(ms(r2!.worked_at)).toBe(Date.parse("2026-07-10T00:00:00.000Z"));
  });

  it("a worked_at-only change updates worked_at but does NOT bump updated_at (the split PR-A relies on)", async () => {
    const seed = await seedTeam();
    // Identical projectable row, only worked_at differs between the two pushes.
    await pushTasks(seed, [{ row_key: "ENG-8", title: "t", assignee: "Alice", worked_at: "2026-07-05T00:00:00.000Z" }], "s1");
    const r0 = await readTask(seed, "ENG-8");
    await pushTasks(seed, [{ row_key: "ENG-8", title: "t", assignee: "Alice", worked_at: "2026-07-06T00:00:00.000Z" }], "s2");
    const r1 = await readTask(seed, "ENG-8");
    // worked_at moved (a real transition), but nothing projectable/due changed → updated_at preserved.
    expect(ms(r1!.worked_at)).toBe(Date.parse("2026-07-06T00:00:00.000Z"));
    expect(ms(r1!.updated_at)).toBe(ms(r0!.updated_at));
  });

  it("assigned_at is stamped only when the assignee actually changes", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [{ row_key: "ENG-7", title: "t", assignee: "Alice" }], "a1");
    const r0 = await readTask(seed, "ENG-7");
    expect(r0!.assigned_at).not.toBeNull(); // newly assigned to Alice

    // Re-push with a title edit but the SAME assignee → assigned_at preserved even though updated_at bumps.
    await pushTasks(seed, [{ row_key: "ENG-7", title: "t — edited", assignee: "Alice" }], "a2");
    const r1 = await readTask(seed, "ENG-7");
    expect(ms(r1!.assigned_at)).toBe(ms(r0!.assigned_at));
    expect(ms(r1!.updated_at)).toBeGreaterThan(ms(r0!.updated_at));

    // Reassign to Bob → assigned_at moves.
    await pushTasks(seed, [{ row_key: "ENG-7", title: "t", assignee: "Bob" }], "a3");
    const r2 = await readTask(seed, "ENG-7");
    expect(ms(r2!.assigned_at)).toBeGreaterThan(ms(r0!.assigned_at));
  });
});
