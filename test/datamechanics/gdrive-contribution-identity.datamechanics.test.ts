import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * Drive contribution evidence: one ledger row per observation (AIO-1167, real Postgres).
 *
 * Spec. A source observation is a person in a role at an instant, and a stable provider id is the
 * person. When Drive later reports the same observation with a different e-mail, or spells the same
 * instant differently, the evidence ledger still holds ONE row for it, carrying the latest
 * metadata, and the Timeline credits it once. That holds for rows written before this rule too —
 * under the legacy key the SQL backfill uses — and across a replay of that backfill, which runs on
 * every rollout.
 */
const PERSON = "permission:identity-person";
const AT = new Date(Date.now() - 86_400_000).toISOString();
/** The same instant as `AT`, as an offset spelling. */
const AT_RESPELLED = AT.replace("Z", "+00:00");

const legacyKey = (email: string, raw: string) =>
  createHash("md5").update(`${PERSON}\u001f${email}\u001feditor\u001f${raw}`).digest("hex");

function push(seed: Seed, body: string, contribution: { email: string; at: string }) {
  return ingest(seed, {
    project: "drive-identity", path: "gdrive/identity-doc.md", access: "team", body,
    frontmatter: {
      source: "gdrive", source_id: "identity-doc", title: "Identity doc", source_ts: AT,
      source_url: "https://docs.google.com/document/d/identity-doc/edit",
      authors: [{ provider: "gdrive", external_id: PERSON, role: "editor" }],
      contributions: [{ external_id: PERSON, role: "editor", ...contribution }],
    },
  });
}

async function ledger(itemId: string) {
  const { data, error } = await db().from("gdrive_contribution_evidence")
    .select("evidence_key,email,source_at_raw,member_id").eq("item_id", itemId);
  if (error) throw new Error(error.message);
  return (data ?? []) as { evidence_key: string; email: string | null; source_at_raw: string; member_id: string | null }[];
}

/** The rows the pre-fix writer left for one observation seen under two e-mails and two spellings. */
async function writeLegacyRows(seed: Seed, itemId: string) {
  await getPool().query(`delete from gdrive_contribution_evidence where item_id=$1`, [itemId]);
  const row = (email: string, raw: string, updatedAt: string) => ({
    team_id: seed.teamId, item_id: itemId, evidence_key: legacyKey(email, raw),
    external_id: PERSON, email, role: "editor", source_at: AT, source_at_raw: raw,
    member_id: seed.memberId, updated_at: updatedAt,
  });
  const { error } = await db().from("gdrive_contribution_evidence").insert([
    row("old@example.com", AT, new Date(Date.now() - 7_200_000).toISOString()),
    row("new@example.com", AT_RESPELLED, new Date(Date.now() - 3_600_000).toISOString()),
  ]);
  if (error) throw new Error(error.message);
}

/** The evidence-adoption statement of the migration that replays on every rollout, verbatim. */
function backfillStatement(): string {
  const sql = readFileSync("postgres/migrations/20260922180000_gdrive_identity_repair_ledger.sql", "utf8");
  const start = sql.indexOf("insert into gdrive_contribution_evidence(");
  const end = sql.indexOf("on conflict (team_id,item_id,evidence_key) do nothing;", start);
  if (start < 0 || end < 0) throw new Error("the evidence backfill statement was not found");
  return sql.slice(start, end + "on conflict (team_id,item_id,evidence_key) do nothing;".length);
}

async function driveTimelineCount(seed: Seed, itemId: string): Promise<number[]> {
  const { getWorkTimeline } = await import("@/lib/dashboard/work-timeline");
  const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, { visibleItemIds: new Set([itemId]) });
  return days.flatMap((day) => day.people)
    .flatMap((person) => [...person.tasks.flatMap((task) => task.sources), ...person.other])
    .filter((source) => source.source === "gdrive")
    .map((source) => source.count);
}

async function seededPerson(): Promise<Seed> {
  const seed = await seedTeam();
  await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "gdrive", externalId: PERSON });
  return seed;
}

describe("AIO-1167 Drive contribution evidence identity (real Postgres)", () => {
  it("a replay with a new e-mail and a re-spelled instant updates the observation's one row", async () => {
    const seed = await seededPerson();
    const first = await push(seed, "version one", { email: "old@example.com", at: AT });
    expect(await ledger(first.id)).toHaveLength(1);

    const second = await push(seed, "version two", { email: "new@example.com", at: AT_RESPELLED });
    expect(second.id).toBe(first.id);
    const rows = await ledger(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "new@example.com", source_at_raw: AT_RESPELLED, member_id: seed.memberId });
    expect(await driveTimelineCount(seed, first.id)).toEqual([1]);
  });

  it("rows left under the legacy key are credited once, then replaced when the item is next written", async () => {
    const seed = await seededPerson();
    const item = await push(seed, "retained body", { email: "new@example.com", at: AT_RESPELLED });
    await writeLegacyRows(seed, item.id);
    expect(await ledger(item.id)).toHaveLength(2);
    // Until the item is written again the stale row is still stored — and still one observation.
    expect(await driveTimelineCount(seed, item.id)).toEqual([1]);

    // The connector's next pass over an unchanged document.
    const again = await push(seed, "retained body", { email: "new@example.com", at: AT_RESPELLED });
    expect(again.id).toBe(item.id);
    const rows = await ledger(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "new@example.com", source_at_raw: AT_RESPELLED, member_id: seed.memberId });
    expect([legacyKey("old@example.com", AT), legacyKey("new@example.com", AT_RESPELLED)]).not.toContain(rows[0].evidence_key);
    expect(await driveTimelineCount(seed, item.id)).toEqual([1]);
  });

  it("replaying the SQL backfill adopts an unknown item once and never re-adds a row the ledger already holds", async () => {
    const seed = await seededPerson();
    const item = await push(seed, "adopted body", { email: "new@example.com", at: AT_RESPELLED });
    const written = await ledger(item.id);
    expect(written).toHaveLength(1);

    // A rollout over a ledger the ingest owner has written: nothing is added beside its row.
    await getPool().query(backfillStatement());
    expect(await ledger(item.id)).toEqual(written);

    // First adoption still happens for an item the ledger does not know …
    await getPool().query(`delete from gdrive_contribution_evidence where item_id=$1`, [item.id]);
    await getPool().query(backfillStatement());
    const adopted = await ledger(item.id);
    expect(adopted.map((row) => row.evidence_key)).toEqual([legacyKey("new@example.com", AT_RESPELLED)]);
    await getPool().query(backfillStatement());
    expect(await ledger(item.id)).toEqual(adopted);

    // … and the adopted row becomes the observation's one row on the next write.
    await push(seed, "adopted body", { email: "new@example.com", at: AT_RESPELLED });
    const converged = await ledger(item.id);
    expect(converged).toHaveLength(1);
    expect(converged[0]).toMatchObject({ evidence_key: written[0].evidence_key, member_id: seed.memberId });
  });
});
