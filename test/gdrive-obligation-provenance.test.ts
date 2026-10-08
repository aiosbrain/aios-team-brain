import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRUSTED PROVENANCE for the Google identity OBLIGATION repair (AIO-1167).
 *
 * Spec. A `gdrive` identity obligation rewrites retained Drive credit. It may touch an item only
 * when that item IS a Drive document:
 *
 *     COALESCE(i.frontmatter->>'source', '') = 'gdrive'
 *       AND EXISTS (SELECT 1 FROM source_item_mappings m
 *                    WHERE m.team_id = i.team_id AND m.item_id = i.id AND m.source = 'gdrive')
 *
 *   The rule is two-valued: a row with no `source`, or a JSON-null one, is not a Drive document —
 *   a definite false, scanned past — and never the SQL NULL that the reader treats as a failed read.
 *
 *   1. That rule bounds candidate NOMINATION, together with the existing author and cursor bounds.
 *   2. It is applied AGAIN per item, by a statement of its own issued after the item-attribution
 *      advisory and the item row lock, before any item, version or evidence write.
 *   3. The trust root is the persisted same-team mapping. Frontmatter alone, claims, connection
 *      enablement and leases are never consulted and cannot substitute for it.
 *   4. An ineligible candidate is a no-op that the obligation's cursor moves past.
 *   5. A provenance read that fails — or answers nothing — fails the batch: every write and the
 *      obligation's cursor roll back, and the retry is recorded afterwards.
 *   6. This drain is not the team-wide repair: it never moves the team cursor, never takes the
 *      team's repair turn, and never calls the common per-item repair.
 *
 * The connection below records each statement and answers from a script; the real-PostgreSQL
 * counterpart is `test/datamechanics/gdrive-obligation-provenance.datamechanics.test.ts`.
 */

type Row = Record<string, unknown>;
type Reply = Row[] | Error | undefined;
type Entry = { sql: string; params: unknown[] };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

class ScriptedConnection {
  readonly log: Entry[] = [];
  readonly release = vi.fn();

  constructor(private readonly respond: (entry: Entry) => Reply) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    const entry = { sql: norm(text), params };
    this.log.push(entry);
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null, command };
    const reply = this.respond(entry);
    if (reply instanceof Error) throw reply;
    return { rows: reply ?? [], rowCount: reply?.length ?? 0, command };
  }

  get transactions(): { work: Entry[]; end: string }[] {
    const out: { work: Entry[]; end: string }[] = [];
    let open: Entry[] | null = null;
    for (const entry of this.log) {
      if (entry.sql === "begin") open = [];
      else if (entry.sql === "commit" || entry.sql === "rollback") {
        if (open) out.push({ work: open, end: entry.sql });
        open = null;
      } else open?.push(entry);
    }
    return out;
  }
}

const h = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    async connect(): Promise<unknown> {
      return h.connection;
    }
    async query(text: string, params?: unknown[]): Promise<unknown> {
      return (h.connection as { query(text: string, params?: unknown[]): Promise<unknown> }).query(text, params);
    }
  },
  types: { setTypeParser(): void {} },
}));

import { PgClient } from "@/lib/db/pg/client";
import { runIdentityRepairObligation } from "@/lib/ingest/identity-repair";
import { readCommonRepairEligibility, readDriveObligationProvenance } from "@/lib/ingest/repair-eligibility";
import { withTransaction } from "@/lib/db/pg/pool";

const TEAM = "10000000-0000-4000-8000-000000000001";
const ITEM = "50000000-0000-4000-8000-000000000001";
const BOB = "30000000-0000-4000-8000-00000000000b";
const EXTERNAL_ID = "permission:person-a";
const REVISION = 7;
const MAPPING_REVISION = 3;

const MAPPING = "exists ( select 1 from source_item_mappings m "
  + "where m.team_id = i.team_id and m.item_id = i.id and m.source = 'gdrive')";
/** The accepted obligation rule, exactly, as one normalized SQL fragment over `items i`. */
const RULE = `(coalesce(i.frontmatter->>'source', '') = 'gdrive' and ${MAPPING})`;

const advisoryKey = (e: Entry) => (e.sql.includes("pg_advisory_xact_lock(hashtextextended(") ? String(e.params[0]) : "");
const isAttributionLock = (e: Entry) => advisoryKey(e) === `${TEAM}:item:${ITEM}`;
const isItemRowLock = (e: Entry) => e.sql === "select id,member_id,member_id_locked,frontmatter from items where team_id=$1 and id=$2 for update";
const isProvenanceRead = (e: Entry) => e.sql === `select ${RULE} as drive_provenance from items i where i.team_id=$1 and i.id=$2`;
const isCandidateRead = (e: Entry) => e.sql.startsWith("select i.id from items i where i.team_id=$1 and ");
const isVersionLock = (e: Entry) => e.sql.startsWith("select v.id,v.member_id,v.frontmatter from item_versions v");
const isItemWrite = (e: Entry) => e.sql.startsWith("update items set member_id=$3");
const isVersionWrite = (e: Entry) => e.sql === "update item_versions set member_id=$2 where id=$1";
const isEvidenceWrite = (e: Entry) => e.sql.startsWith("insert into gdrive_contribution_evidence");
const isObligationCursor = (e: Entry) => e.sql.startsWith("update identity_repair_obligations set cursor_item_id=$5");
const isObligationRetry = (e: Entry) => e.sql.startsWith("update identity_repair_obligations set status='retry'");
const isObligationComplete = (e: Entry) => e.sql.startsWith("update identity_repair_obligations set status='complete'");
const isCreditWrite = (e: Entry) => isItemWrite(e) || isVersionWrite(e) || isEvidenceWrite(e);

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);

const driveFrontmatter = {
  source: "gdrive", source_id: "doc-1",
  authors: [{ provider: "gdrive", external_id: EXTERNAL_ID, email: "person-a@provider.example", role: "editor" }],
  contributions: [{ external_id: EXTERNAL_ID, email: "person-a@provider.example", role: "editor", at: "2026-09-21T08:30:00Z" }],
};

const OBLIGATION = {
  team_id: TEAM, provider: "gdrive", external_id: EXTERNAL_ID, mapping_revision: MAPPING_REVISION,
  cursor_item_id: null, items_scanned: 0, items_updated: 0, versions_updated: 0, contributions_updated: 0,
};

/**
 * One stored document credited to Bob, whose Google identity has just been unlinked: nothing
 * resolves any more, so an admitted repair clears the item, its version and the evidence.
 */
function repository(provenance: Reply) {
  return (entry: Entry): Reply => {
    const { sql } = entry;
    if (sql.startsWith("select revision,repair_revision,repair_status,cursor_item_id from team_identity_authority")) {
      return [{ revision: REVISION, repair_revision: REVISION, repair_status: "pending", cursor_item_id: null }];
    }
    if (sql.startsWith("select revision,repair_revision from team_identity_authority")) {
      return [{ revision: REVISION, repair_revision: REVISION }];
    }
    if (sql.startsWith("select team_id,provider,external_id,mapping_revision,cursor_item_id")) return [OBLIGATION];
    if (sql.startsWith("select revision from member_identity_mapping_state")) return [{ revision: MAPPING_REVISION }];
    if (isCandidateRead(entry)) return [{ id: ITEM }];
    if (isItemRowLock(entry)) return [{ id: ITEM, member_id: BOB, member_id_locked: false, frontmatter: driveFrontmatter }];
    if (isProvenanceRead(entry)) return provenance;
    if (isVersionLock(entry)) return [{ id: "v1", member_id: BOB, frontmatter: driveFrontmatter }];
    if (isItemWrite(entry) || isVersionWrite(entry)) return [{}];
    if (sql.startsWith("select slug from teams")) return [{ slug: "acme" }];
    if (sql.startsWith("insert into team_authorization_epochs")) return [{ epoch: 2 }];
    return [];
  };
}

function use(provenance: Reply): ScriptedConnection {
  const connection = new ScriptedConnection(repository(provenance));
  h.connection = connection;
  return connection;
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
});

describe("obligation repair: Drive provenance is nominated by the mapping and rechecked under the item lock", () => {
  it("an ADMITTED item: attribution advisory → item row → provenance recheck → versions → writes → obligation cursor", async () => {
    const c = use([{ drive_provenance: true }]);
    await expect(runIdentityRepairObligation(new PgClient(), OBLIGATION))
      .resolves.toEqual({ status: "complete", scanned: 1 });

    const work = c.log;
    const order = [
      indexOf(work, isAttributionLock),
      indexOf(work, isItemRowLock),
      indexOf(work, isProvenanceRead),
      indexOf(work, isItemWrite),
      indexOf(work, isVersionLock),
      indexOf(work, isVersionWrite),
      indexOf(work, isEvidenceWrite),
      indexOf(work, isObligationCursor),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The recheck is one statement of its own, it locks nothing, and no credit is written before it.
    expect(work.filter(isProvenanceRead)).toHaveLength(1);
    expect(work[order[2]].params).toEqual([TEAM, ITEM]);
    expect(work[order[2]].sql).not.toMatch(/ for (update|share|key share|no key update)\b/);
    expect(indexOf(work, isCreditWrite)).toBeGreaterThan(order[2]);
    // The unlinked identity's retained credit is cleared at both levels.
    expect(work.find(isItemWrite)!.params).toEqual([TEAM, ITEM, null]);
    expect(work.find(isVersionWrite)!.params).toEqual(["v1", null]);
    // All of it — and the obligation's cursor — in the batch transaction.
    const batch = c.transactions.find((t) => t.work.some(isObligationCursor))!;
    expect(batch.end).toBe("commit");
    expect(batch.work.filter(isCreditWrite).length).toBeGreaterThanOrEqual(3);
    expect(batch.work.find(isObligationCursor)!.params.slice(4)).toEqual([ITEM, 1, 1, 1, 1]);
  });

  it("NOMINATION requires the same rule, with the existing author and cursor bounds, and consults nothing else", async () => {
    const c = use([{ drive_provenance: true }]);
    await runIdentityRepairObligation(new PgClient(), OBLIGATION, { batchSize: 25 });
    const candidates = c.log.filter(isCandidateRead);
    expect(candidates).toHaveLength(1);
    const { sql, params } = candidates[0];
    expect(sql.startsWith(`select i.id from items i where i.team_id=$1 and ${RULE} and ($3::uuid is null or i.id>$3::uuid) and (`)).toBe(true);
    // The author bounds are unchanged: this identity, among the authors or the contributions.
    expect(sql).toContain("i.frontmatter->'authors'");
    expect(sql).toContain("i.frontmatter->'contributions'");
    expect(sql).toContain("a->>'external_id'=$2");
    expect(sql.endsWith("order by i.id limit $4")).toBe(true);
    expect(params.slice(0, 4)).toEqual([TEAM, EXTERNAL_ID, null, 25]);
    for (const forbidden of ["connection_id", "gdrive_item_claims", "gdrive_connection_authority", "integrations", "lease"]) {
      expect(sql, `nomination consults ${forbidden}`).not.toContain(forbidden);
    }
    expect(sql).not.toMatch(/ for (update|share)\b/);
  });

  it("an INELIGIBLE candidate is a no-op the cursor moves past — whatever its frontmatter claims", async () => {
    // The row still carries Drive source, authors and contributions; the mapping says otherwise.
    const c = use([{ drive_provenance: false }]);
    await expect(runIdentityRepairObligation(new PgClient(), OBLIGATION))
      .resolves.toEqual({ status: "complete", scanned: 1 });
    expect(c.log.filter(isCreditWrite)).toEqual([]);
    // Decided by provenance alone: the version ledger was never even read.
    expect(c.log.filter(isVersionLock)).toEqual([]);
    const cursor = c.log.find(isObligationCursor)!;
    expect(cursor.params.slice(4)).toEqual([ITEM, 1, 0, 0, 0]);
    expect(c.log.filter(isObligationComplete)).toHaveLength(1);
  });

  it.each([
    ["the provenance read fails", Object.assign(new Error("relation \"source_item_mappings\" is unavailable"), { code: "58030" }), /unavailable/],
    ["the read answers no row", [] as Row[], /drive repair provenance could not be read/i],
    ["the read answers NULL", [{ drive_provenance: null }], /drive repair provenance could not be read/i],
  ])("FAIL CLOSED: when %s the batch fails — no credit write, no cursor, rolled back, retry recorded after", async (_name, provenance, message) => {
    const c = use(provenance);
    await expect(runIdentityRepairObligation(new PgClient(), OBLIGATION)).rejects.toThrow(message);
    expect(c.log.filter(isCreditWrite)).toEqual([]);
    expect(c.log.filter(isObligationCursor)).toEqual([]);
    expect(c.log.filter(isObligationComplete)).toEqual([]);
    const batch = c.transactions.find((t) => t.work.some(isProvenanceRead))!;
    expect(batch.end).toBe("rollback");
    // The retry is written once the failed batch is gone.
    const retry = c.log.findIndex(isObligationRetry);
    expect(retry).toBeGreaterThan(c.log.findIndex((e) => e.sql === "rollback"));
  });

  it("this drain is not the team-wide repair: no team cursor, no repair turn, no common per-item repair", async () => {
    const c = use([{ drive_provenance: true }]);
    await runIdentityRepairObligation(new PgClient(), OBLIGATION);
    expect(c.log.filter((e) => e.sql.startsWith("update team_identity_authority"))).toEqual([]);
    expect(c.log.filter((e) => e.sql.includes("pg_try_advisory_xact_lock"))).toEqual([]);
    expect(c.log.filter((e) => e.sql.includes(") as eligible from items i where"))).toEqual([]);

    const source = readFileSync("lib/ingest/identity-repair.ts", "utf8");
    const imports = source.match(/^import[\s\S]*?from "[^"]+";$/gm) ?? [];
    expect(imports.some((line) => line.includes("@/lib/ingest/repair-eligibility"))).toBe(true);
    expect(imports.some((line) => /["']@\/lib\/ingest\/reattribute["']/.test(line))).toBe(false);
    for (const forbidden of ["repairAttributionItem(", "advanceIdentityRepairCursor", "tryLockAttributionRepairTurn"]) {
      expect(source, `the obligation drain uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the two rules share one mapping reader and stay distinct", () => {
  it("each reader issues its own rule, and both fail closed on anything but one boolean", async () => {
    const c = use([{ drive_provenance: true }]);
    await withTransaction(async () => {
      await expect(readDriveObligationProvenance(TEAM, ITEM)).resolves.toBe(true);
      // The common rule is the tier OR the mapping; the scripted repository has no answer for it.
      await expect(readCommonRepairEligibility(TEAM, ITEM)).rejects.toThrow(/repair eligibility could not be read/);
    });
    const [obligation, common] = c.log.filter((e) => e.sql.startsWith("select ("));
    expect(obligation.sql).toBe(`select ${RULE} as drive_provenance from items i where i.team_id=$1 and i.id=$2`);
    expect(common.sql).toBe(`select (i.access::text <> 'external' or ${MAPPING}) as eligible from items i where i.team_id=$1 and i.id=$2`);
    // Frontmatter source is part of the OBLIGATION rule only; it never widens the common one.
    expect(common.sql).not.toContain("frontmatter");
  });

  it("the obligation rule cannot answer NULL for a missing source: absence is false, and only a read that did not answer fails", async () => {
    // Every operand is two-valued — the coalesced comparison and EXISTS — so the conjunction is.
    const c = use([{ drive_provenance: false }]);
    await withTransaction(async () => {
      await expect(readDriveObligationProvenance(TEAM, ITEM)).resolves.toBe(false);
    });
    const [read] = c.log.filter((e) => e.sql.startsWith("select ("));
    expect(read.sql).toContain("coalesce(i.frontmatter->>'source', '') = 'gdrive'");
    // No bare three-valued comparison of the source survives anywhere in the rule.
    expect(read.sql.replace("coalesce(i.frontmatter->>'source', '') = 'gdrive'", "")).not.toContain("frontmatter");
    // The reader's own guard is unchanged: a NULL or absent ANSWER is still a failed read.
    use([{ drive_provenance: null }]);
    await withTransaction(async () => {
      await expect(readDriveObligationProvenance(TEAM, ITEM)).rejects.toThrow(/could not be read/);
    });
  });
});
