import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityAuthoritySnapshot } from "@/lib/identity/authority";
import type { IdentityMap } from "@/lib/identity/resolve";

/**
 * COMMON ATTRIBUTION REPAIR ELIGIBILITY for Google Drive documents (AIO-1167).
 *
 * Spec. The team-wide repair (`reattributeItems` → `repairAttributionItem`) admits an item when
 *
 *     i.access::text <> 'external'
 *       OR EXISTS (SELECT 1 FROM source_item_mappings m
 *                   WHERE m.team_id = i.team_id AND m.item_id = i.id AND m.source = 'gdrive')
 *
 *   1. That one rule is applied in the bounded candidate selection AND again per item, by a
 *      statement of its own issued after the item-attribution advisory and the item row are held.
 *   2. The trust root is the PERSISTED same-team mapping. Nothing else is consulted: not the row's
 *      frontmatter, authors or contributions, not a connection id (the mapping's is NULL by
 *      design), not claims, leases or integrations.
 *   3. The recheck takes no provider or mapping lock: the order stays identity revision →
 *      item-attribution advisory → item row → versions → evidence → cursor.
 *   4. An ineligible item moves the cursor and changes nothing. An eligibility read that fails —
 *      or answers nothing — fails the attempt: nothing is written and the cursor does not move.
 *   5. Each historical version resolves from ITS OWN retained provenance.
 *
 * The connection below records each statement and answers from a script; the real-Postgres
 * counterpart is `test/datamechanics/gdrive-common-repair.datamechanics.test.ts`.
 */

type Row = Record<string, unknown>;
type Reply = Row[] | Error | undefined;
type Entry = { sql: string; params: unknown[] };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

class ScriptedConnection {
  readonly log: Entry[] = [];
  readonly release = vi.fn();

  constructor(private readonly respond: (sql: string, params: unknown[]) => Reply) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    const sql = norm(text);
    this.log.push({ sql, params });
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null, command };
    const reply = this.respond(sql, params);
    if (reply instanceof Error) throw reply;
    return { rows: reply ?? [], rowCount: reply?.length ?? 0, command };
  }

  get work(): Entry[] {
    return this.log.filter((entry) => !["begin", "commit", "rollback"].includes(entry.sql));
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
import { reattributeItems, repairAttributionItem } from "@/lib/ingest/reattribute";

function use(connection: ScriptedConnection): ScriptedConnection {
  h.connection = connection;
  return connection;
}

const TEAM = "10000000-0000-4000-8000-000000000001";
const ITEM = "50000000-0000-4000-8000-000000000001";
const ALICE = "30000000-0000-4000-8000-00000000000a";
const BOB = "30000000-0000-4000-8000-00000000000b";
const REVISION = 7;

/** The accepted rule, exactly, as one normalized SQL fragment over `items i`. */
const RULE = "(i.access::text <> 'external' or exists ( select 1 from source_item_mappings m "
  + "where m.team_id = i.team_id and m.item_id = i.id and m.source = 'gdrive'))";

// ── statement classes ──────────────────────────────────────────────────────────────────────────
const advisoryKey = (e: Entry) => (e.sql.includes("pg_advisory_xact_lock(hashtextextended(") ? String(e.params[0]) : "");
const isIdentityLock = (e: Entry) => advisoryKey(e) === `${TEAM}:identity-authority`;
const isRevisionRead = (e: Entry) => e.sql.startsWith("select revision,repair_revision from team_identity_authority") && e.sql.endsWith("for update");
const isAttributionLock = (e: Entry) => advisoryKey(e) === `${TEAM}:item:${ITEM}`;
const isItemRowLock = (e: Entry) => e.sql === "select id,member_id,member_id_locked,frontmatter from items where team_id=$1 and id=$2 for update";
const isEligibilityRead = (e: Entry) => e.sql === `select ${RULE} as eligible from items i where i.team_id=$1 and i.id=$2`;
const isCandidateRead = (e: Entry) => e.sql === `select i.id from items i where i.team_id=$1 and ${RULE} and ($2::uuid is null or i.id>$2::uuid) order by i.id limit $3`;
const isVersionLock = (e: Entry) => e.sql.startsWith("select v.id,v.member_id,v.frontmatter from item_versions v") && e.sql.endsWith("for update");
const isItemWrite = (e: Entry) => e.sql.startsWith("update items set member_id=$3");
const isVersionWrite = (e: Entry) => e.sql === "update item_versions set member_id=$2 where id=$1";
const isEvidenceWrite = (e: Entry) => e.sql.startsWith("insert into gdrive_contribution_evidence");
const isCursorAdvance = (e: Entry) => e.sql.startsWith("update team_identity_authority set cursor_item_id=$3");
const isWrite = (e: Entry) => /^(insert|update|delete) /.test(e.sql);
/** Any lock on anything provider- or mapping-shaped: forbidden once the item is held. */
const isProviderOrMappingLock = (e: Entry) => advisoryKey(e).includes(":gdrive:")
  || (e.sql.includes("source_item_mappings") && / for (update|share|key share|no key update)\b/.test(e.sql));

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);
const which = (entries: Entry[], match: (e: Entry) => boolean) => entries.filter(match);

const author = (email: string) => ({ provider: "gdrive", external_id: `permission:${email}`, email, role: "editor" });
const driveFrontmatter = (email: string, contributions: string[] = [email]) => ({
  source: "gdrive", source_id: "doc-1", authors: [author(email)],
  contributions: contributions.map((who) => ({ external_id: `permission:${who}`, email: who, role: "editor", at: "2026-09-21T08:30:00Z" })),
});

/** alice@ and bob@ are exact roster/alias addresses; nothing else resolves. */
function snapshot(): IdentityAuthoritySnapshot {
  const map: IdentityMap = {
    byEmail: new Map([["alice@example.com", ALICE], ["bob@example.com", BOB]]),
    byHandle: new Map(), emailDomains: new Set(), byProviderId: new Map(),
    ambiguousEmails: new Set(), ambiguousProviderIds: new Set(),
    providerIdentityStates: new Map(), activeMemberIds: new Set([ALICE, BOB]),
  };
  return { teamId: TEAM, revision: REVISION, repairStatus: "pending", cursorItemId: null, map, connectorIds: new Set() };
}

/** One stored item (credited to nobody) with two versions by different authors. */
function repository(opts: {
  eligible?: Reply;
  item?: Row | null;
  versions?: Row[];
} = {}) {
  const item = opts.item === undefined
    ? { id: ITEM, member_id: null, member_id_locked: false, frontmatter: driveFrontmatter("alice@example.com", ["bob@example.com", "alice@example.com"]) }
    : opts.item;
  const versions = opts.versions ?? [
    { id: "v1", member_id: null, frontmatter: driveFrontmatter("bob@example.com") },
    { id: "v2", member_id: null, frontmatter: driveFrontmatter("alice@example.com") },
  ];
  return (sql: string, params: unknown[]): Reply => {
    const e: Entry = { sql, params };
    if (isRevisionRead(e)) return [{ revision: REVISION, repair_revision: REVISION }];
    if (isItemRowLock(e)) return item ? [item] : [];
    if (isEligibilityRead(e)) return opts.eligible === undefined ? [{ eligible: true }] : opts.eligible;
    if (isVersionLock(e)) return versions;
    if (isItemWrite(e) || isVersionWrite(e)) return [{}];
    return [];
  };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
});

describe("common repair: one eligibility rule, in selection and under the item lock", () => {
  it("an ELIGIBLE item: revision → attribution advisory → item row → eligibility recheck → versions → writes → cursor; no provider or mapping lock", async () => {
    const c = use(new ScriptedConnection(repository()));
    await expect(repairAttributionItem(new PgClient(), snapshot(), ITEM))
      .resolves.toEqual({ item: 1, versions: 2, contributions: 2 });

    const work = c.work;
    const order = [
      indexOf(work, isIdentityLock),
      indexOf(work, isRevisionRead),
      indexOf(work, isAttributionLock),
      indexOf(work, isItemRowLock),
      indexOf(work, isEligibilityRead),
      indexOf(work, isVersionLock),
      indexOf(work, isItemWrite),
      indexOf(work, isVersionWrite),
      indexOf(work, isEvidenceWrite),
      indexOf(work, isCursorAdvance),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The recheck is its own statement, issued after the row lock, and it locks nothing.
    expect(which(work, isEligibilityRead)).toHaveLength(1);
    expect(work[order[4]].sql).not.toMatch(/ for (update|share|key share|no key update)\b/);
    expect(work[order[4]].params).toEqual([TEAM, ITEM]);
    // Nothing is written before it, and nothing provider- or mapping-shaped is ever locked.
    expect(indexOf(work, isWrite)).toBeGreaterThan(order[4]);
    expect(which(work, isProviderOrMappingLock)).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("commit");
  });

  it("each historical version resolves from ITS OWN retained provenance, not from the current item's authors", async () => {
    const c = use(new ScriptedConnection(repository()));
    await repairAttributionItem(new PgClient(), snapshot(), ITEM);
    // The current item is Alice's; the first version was Bob's and stays Bob's.
    expect(which(c.work, isItemWrite).map((entry) => entry.params[2])).toEqual([ALICE]);
    expect(which(c.work, isVersionWrite).map((entry) => entry.params)).toEqual([["v1", BOB], ["v2", ALICE]]);
    // Contribution evidence is per observation: each row credits its own contributor.
    const evidenceCredit = which(c.work, isEvidenceWrite).map((entry) => {
      const columns = entry.sql.match(/^insert into gdrive_contribution_evidence \(([^)]*)\)/)![1].split(",").map((column) => column.trim());
      return [entry.params[columns.indexOf("email")], entry.params[columns.indexOf("member_id")], entry.params[columns.indexOf("authority_revision")]];
    });
    expect(evidenceCredit.sort()).toEqual([["alice@example.com", ALICE, REVISION], ["bob@example.com", BOB, REVISION]]);
  });

  it("an INELIGIBLE item moves the cursor and changes nothing — whatever its frontmatter claims", async () => {
    // Forged provenance on an unmapped external row: authors, contributions and a connection id.
    const forged = { ...driveFrontmatter("alice@example.com"), connection_id: "20000000-0000-4000-8000-000000000002" };
    const c = use(new ScriptedConnection(repository({
      eligible: [{ eligible: false }],
      item: { id: ITEM, member_id: BOB, member_id_locked: false, frontmatter: forged },
    })));
    await expect(repairAttributionItem(new PgClient(), snapshot(), ITEM))
      .resolves.toEqual({ item: 0, versions: 0, contributions: 0 });
    const writes = which(c.work, isWrite);
    expect(writes).toHaveLength(1);
    expect(isCursorAdvance(writes[0])).toBe(true);
    expect(writes[0].params).toEqual([TEAM, REVISION, ITEM, 0, 0, 0]);
    // It was decided by the persisted mapping alone: the version ledger was never even read.
    expect(which(c.work, isVersionLock)).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("commit");
  });

  it("an item that is gone needs no eligibility read: the cursor moves past it", async () => {
    const c = use(new ScriptedConnection(repository({ item: null })));
    await expect(repairAttributionItem(new PgClient(), snapshot(), ITEM))
      .resolves.toEqual({ item: 0, versions: 0, contributions: 0 });
    expect(which(c.work, isEligibilityRead)).toEqual([]);
    expect(which(c.work, isWrite).every(isCursorAdvance)).toBe(true);
  });

  it.each([
    ["the mapping/provenance read fails", Object.assign(new Error("relation \"source_item_mappings\" is unavailable"), { code: "58030" }), /unavailable/],
    ["the read answers no row", [] as Row[], /eligibility could not be read/],
    ["the read answers NULL", [{ eligible: null }], /eligibility could not be read/],
  ])("FAIL CLOSED: when %s the attempt fails — nothing written, cursor not advanced, rolled back", async (_name, eligible, message) => {
    const c = use(new ScriptedConnection(repository({ eligible })));
    await expect(repairAttributionItem(new PgClient(), snapshot(), ITEM)).rejects.toThrow(message);
    expect(which(c.work, isWrite)).toEqual([]);
    expect(which(c.work, isCursorAdvance)).toEqual([]);
    expect(which(c.work, isVersionLock)).toEqual([]);
    expect(c.log.filter((entry) => entry.sql === "commit")).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("the correction lock is read under the item lock and wins: credit and versions untouched, evidence marked manual", async () => {
    const c = use(new ScriptedConnection(repository({
      item: { id: ITEM, member_id: null, member_id_locked: true, frontmatter: driveFrontmatter("alice@example.com") },
    })));
    await expect(repairAttributionItem(new PgClient(), snapshot(), ITEM))
      .resolves.toEqual({ item: 0, versions: 0, contributions: 1 });
    expect(which(c.work, isItemWrite)).toEqual([]);
    expect(which(c.work, isVersionWrite)).toEqual([]);
    const evidence = which(c.work, isEvidenceWrite)[0];
    const columns = evidence.sql.match(/^insert into gdrive_contribution_evidence \(([^)]*)\)/)![1].split(",").map((column) => column.trim());
    expect(evidence.params[columns.indexOf("member_id")]).toBeNull();
    expect(evidence.params[columns.indexOf("diagnostic")]).toBe("manual_credit_nobody");
  });

  it("the bounded candidate selection applies the SAME rule and consults nothing else", async () => {
    // A complete, healthy snapshot with nothing to repair: one candidate read, then awaiting-cache.
    const c = use(new ScriptedConnection((sql) => {
      if (sql.startsWith("select revision,repair_revision,repair_status,cursor_item_id from team_identity_authority")) {
        return [{ revision: REVISION, repair_revision: REVISION, repair_status: "pending", cursor_item_id: null }];
      }
      if (sql.startsWith("select revision,repair_revision from team_identity_authority")) {
        return [{ revision: REVISION, repair_revision: REVISION }];
      }
      return [];
    }));
    await expect(reattributeItems(new PgClient(), TEAM, { batchSize: 25 }))
      .resolves.toMatchObject({ scanned: 0, partial: false, revision: REVISION });
    const candidates = which(c.work, isCandidateRead);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].params).toEqual([TEAM, null, 25]);
    // The whole predicate is the tier and the persisted same-team gdrive mapping.
    for (const forbidden of ["frontmatter", "connection_id", "gdrive_item_claims", "gdrive_connection_authority", "integrations", "lease"]) {
      expect(candidates[0].sql, `candidate selection consults ${forbidden}`).not.toContain(forbidden);
    }
    expect(candidates[0].sql).toContain("m.team_id = i.team_id and m.item_id = i.id and m.source = 'gdrive'");
    expect(candidates[0].sql).not.toMatch(/ for (update|share)\b/);
  });
});
