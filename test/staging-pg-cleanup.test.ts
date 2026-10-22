import { describe, expect, it, vi } from "vitest";
import {
  PRESERVED_PUBLIC_TABLES,
  assertMarkerPreserved,
  cleanPublicApplicationObjects,
  filterRestoreList,
  readMarkerSnapshot,
} from "../scripts/staging-ops/pg-paired.mjs";

// A realistic `pg_restore --list` fragment. The exact column layout matters: the filter is
// structural, and a filter that silently matched nothing would be indistinguishable from no filter.
const LISTING = `;
; Archive created at 2026-09-07 12:00:00 UTC
;     dbname: brain
;
; Selected TOC Entries:
;
5; 2615 2200 SCHEMA - public postgres
3401; 0 0 COMMENT - SCHEMA public postgres
3402; 0 0 ACL - SCHEMA public postgres
215; 1259 16388 TABLE public items postgres
216; 1259 16400 TABLE public staging_marker postgres
3403; 0 16388 TABLE DATA public items postgres
3404; 0 16400 TABLE DATA public staging_marker postgres
3374; 2606 16460 CONSTRAINT public staging_marker staging_marker_pkey postgres
3375; 2606 16461 CONSTRAINT public items items_pkey postgres
`;

describe("archive TOC filtering", () => {
  it("omits the public schema entry and its comment/ACL, keeping every application object", () => {
    const { text, omitted } = filterRestoreList(LISTING, { omitTables: [] });
    expect(omitted).toEqual([
      "SCHEMA - public postgres",
      "COMMENT - SCHEMA public postgres",
      "ACL - SCHEMA public postgres",
    ]);
    expect(text).toContain("TABLE public items postgres");
    expect(text).toContain("TABLE DATA public items postgres");
    expect(text).toContain("CONSTRAINT public items items_pkey postgres");
  });

  it("also omits every entry naming a preserved table, so a rollback archive cannot duplicate it", () => {
    // A rollback archive IS a staging dump, so it contains the marker. The LIVE marker is the
    // preserved object; recreating it from the archive would collide, and cleaning it would defeat
    // the preservation.
    const { text, omitted } = filterRestoreList(LISTING, { omitTables: PRESERVED_PUBLIC_TABLES });
    expect(text).not.toContain("staging_marker");
    expect(omitted).toContain("TABLE public staging_marker postgres");
    expect(omitted).toContain("TABLE DATA public staging_marker postgres");
    expect(omitted).toContain("CONSTRAINT public staging_marker staging_marker_pkey postgres");
    expect(text).toContain("CONSTRAINT public items items_pkey postgres");
  });

  it("preserves the order of what it keeps, because pg_restore depends on it", () => {
    const { text } = filterRestoreList(LISTING, { omitTables: PRESERVED_PUBLIC_TABLES });
    const kept = text.split("\n").filter((line) => /^\d+;/.test(line));
    expect(kept).toEqual([
      "215; 1259 16388 TABLE public items postgres",
      "3403; 0 16388 TABLE DATA public items postgres",
      "3375; 2606 16461 CONSTRAINT public items items_pkey postgres",
    ]);
  });

  it("leaves an entry alone when a preserved name only appears as a substring", () => {
    const listing = "217; 1259 16402 TABLE public staging_marker_audit postgres\n";
    expect(filterRestoreList(listing, { omitTables: ["staging_marker"] }).omitted).toEqual([]);
  });
});

/** A pg client double that records statements and answers the enumeration queries. */
function fakeClient(rowsBySql: { relations: Record<string, { name: string; kind: string }[]>; functions?: unknown[]; types?: unknown[] }) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push(String(sql));
    if (String(sql).includes("FROM pg_class")) {
      const kinds = (params?.[0] as string[]) ?? [];
      // The sequence answer is what SURVIVES the table drop: the identity-owned sequences went with
      // their tables, and re-dropping those cached names fails the whole transaction.
      if (kinds.includes("S")) return { rows: rowsBySql.relations.sequencesAfterDrop ?? [] };
      if (kinds.includes("v")) return { rows: rowsBySql.relations.views ?? [] };
      return { rows: rowsBySql.relations.tables ?? [] };
    }
    if (String(sql).includes("FROM pg_proc")) return { rows: rowsBySql.functions ?? [] };
    if (String(sql).includes("FROM pg_type")) return { rows: rowsBySql.types ?? [] };
    return { rows: [] };
  });
  return { query, statements };
}

describe("destructive cleanup of the public application objects", () => {
  const relations = {
    views: [{ name: "v_items", kind: "v" }],
    tables: [{ name: "items", kind: "r" }, { name: "graph_episodes", kind: "r" }, { name: "staging_marker", kind: "r" }],
    sequencesAfterDrop: [{ name: "standalone_seq", kind: "S" }],
  };

  it("drops the whole surviving table set in ONE statement and never the preserved marker", async () => {
    const client = fakeClient({ relations });
    const dropped = await cleanPublicApplicationObjects(client);
    const tableDrop = client.statements.find((sql) => sql.startsWith("DROP TABLE"));
    expect(tableDrop).toBe('DROP TABLE public."items", public."graph_episodes" RESTRICT');
    expect(dropped.tables).toEqual(["items", "graph_episodes"]);
    // H1: the discriminator is control state, not application data. Nothing recreates it — it is
    // absent from schema.sql and every migration, and a production archive never contained it.
    expect(tableDrop).not.toContain("staging_marker");
  });

  it("resolves failed transaction state and discards ONLY this session's temporary objects first", async () => {
    // A previous injected loader run leaves `temporary view slack_repath` on this same client
    // (migration 20260725180000). Under RESTRICT that view blocks the table DROP on the SECOND
    // restore through the same connection.
    const client = fakeClient({ relations });
    await cleanPublicApplicationObjects(client);
    expect(client.statements.slice(0, 3)).toEqual(["ROLLBACK", "DISCARD TEMP", "BEGIN"]);
    // DISCARD ALL would drop the advisory locks the entire fence depends on.
    expect(client.statements).not.toContain("DISCARD ALL");
  });

  it("requeries sequences after the tables are gone, and never before", async () => {
    const client = fakeClient({ relations });
    await cleanPublicApplicationObjects(client);
    // Match on the CALL, not on a line of it: the enumeration SQL is a multi-line template whose
    // first line is empty, so a first-line-only projection can never see it. The relkind parameter
    // is what distinguishes the sequence enumeration from the view/table ones that share the SQL.
    const calls = client.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), kinds: (params?.[0] as string[]) ?? [] }));
    const dropTables = calls.findIndex((call) => call.sql.startsWith("DROP TABLE"));
    const isSequenceQuery = (call: { sql: string; kinds: string[] }) => call.sql.includes("SELECT c.relname") && call.kinds.includes("S");
    expect(dropTables).toBeGreaterThan(0);
    // The defect this pins: a sequence inventory CACHED before the table drop still lists the
    // identity-owned sequences the drop has just removed, and re-dropping them aborts the whole
    // transaction. So both halves matter — one after, and none before.
    expect(calls.slice(0, dropTables).filter(isSequenceQuery)).toEqual([]);
    expect(calls.slice(dropTables + 1).filter(isSequenceQuery).length).toBe(1);
    expect(client.statements).toContain('DROP SEQUENCE public."standalone_seq" RESTRICT');
  });

  it("uses RESTRICT everywhere, so a dependency outside the enumerated set refuses", async () => {
    const client = fakeClient({ relations, functions: [{ ident: "public.touch_updated_at()", kind: "f" }], types: [{ ident: "public.item_kind" }] });
    await cleanPublicApplicationObjects(client);
    for (const statement of client.statements.filter((sql) => sql.startsWith("DROP"))) {
      expect(statement).toMatch(/RESTRICT$/);
    }
    expect(client.statements).toContain("DROP FUNCTION public.touch_updated_at() RESTRICT");
    expect(client.statements).toContain("DROP TYPE public.item_kind RESTRICT");
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("rolls back the whole cleanup if any drop fails", async () => {
    const client = fakeClient({ relations });
    client.query.mockImplementation(async (sql: string) => {
      client.statements.push(String(sql));
      if (String(sql).startsWith("DROP TABLE")) throw new Error("cannot drop table items because other objects depend on it");
      if (String(sql).includes("FROM pg_class")) return { rows: relations.tables };
      return { rows: [] };
    });
    await expect(cleanPublicApplicationObjects(client)).rejects.toThrow(/other objects depend/);
    expect(client.statements.filter((sql) => sql === "ROLLBACK").length).toBeGreaterThanOrEqual(2);
  });
});

describe("H1 — the staging discriminator survives the restore, verifiably", () => {
  const snapshot = { table: "staging_marker", columns: ["note"], rows: [{ note: "staging" }] };

  function markerClient(after: { present: boolean; rows?: Record<string, string>[] }) {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(String(sql));
      if (String(sql).includes("to_regclass")) return { rows: [{ present: after.present }] };
      if (String(sql).startsWith("SELECT * FROM")) return { rows: after.rows ?? [], fields: [{ name: "note" }] };
      return { rows: [] };
    });
    return { query, statements };
  }

  it("reads the marker's exact contents before the restore, so survival can be checked not assumed", async () => {
    const client = markerClient({ present: true, rows: [{ note: "staging" }] });
    expect(await readMarkerSnapshot(client)).toEqual(snapshot);
  });

  it("reports absent-before-restore on a production-shaped target", async () => {
    const client = markerClient({ present: false });
    expect(await readMarkerSnapshot(client)).toBeNull();
    expect(await assertMarkerPreserved(client, null)).toEqual({ status: "absent-before-restore" });
  });

  it("passes when the marker survived with the same contents", async () => {
    const client = markerClient({ present: true, rows: [{ note: "staging" }] });
    expect(await assertMarkerPreserved(client, snapshot)).toEqual({ status: "preserved" });
  });

  it("refuses when the marker survived with DIFFERENT contents", async () => {
    const client = markerClient({ present: true, rows: [{ note: "supplied-by-the-bundle" }] });
    await expect(assertMarkerPreserved(client, snapshot)).rejects.toThrow(/different contents/);
  });

  it("refuses to re-create the marker on a target whose staging identity is unproven", async () => {
    // Planting a staging discriminator on a database that has not been proven to be staging is the
    // exact failure the discriminator exists to prevent. A DATABASE_URL is not that proof.
    const client = markerClient({ present: false });
    await expect(assertMarkerPreserved(client, snapshot, { verifiedStagingTarget: false }))
      .rejects.toThrow(/staging identity is not independently verified/);
    expect(client.statements.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(false);
  });

  it("re-materialises it only once the pinned staging target has been independently verified", async () => {
    const client = markerClient({ present: false });
    expect(await assertMarkerPreserved(client, snapshot, { verifiedStagingTarget: true })).toEqual({ status: "rematerialised" });
    expect(client.statements).toContain('CREATE TABLE public."staging_marker"(note text PRIMARY KEY)');
  });

  it("refuses to re-create a marker whose shape it does not recognise", async () => {
    const client = markerClient({ present: false });
    await expect(assertMarkerPreserved(client, { table: "staging_marker", columns: ["note", "extra"], rows: [] }, { verifiedStagingTarget: true }))
      .rejects.toThrow(/unrecognised shape/);
  });

  it("does not treat a difference in row ORDER as a difference in contents", async () => {
    const two = { table: "staging_marker", columns: ["note"], rows: [{ note: "a" }, { note: "b" }] };
    const client = markerClient({ present: true, rows: [{ note: "b" }, { note: "a" }] });
    expect(await assertMarkerPreserved(client, two)).toEqual({ status: "preserved" });
  });
});
