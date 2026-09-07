/**
 * Minimal in-memory Supabase stand-in for unit-testing lib/ingest without a DB.
 * Supports exactly the PostgREST fluent chain ingestItem() uses: from().upsert/
 * insert/update/delete/select with eq()/maybeSingle()/single()/not(col,'is',null).
 * Not a general mock — faithful to the calls in index.ts, deliberately small.
 */
type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "in"; col: string; val: unknown[] }
  | { kind: "notNull"; col: string }
  | { kind: "isNull"; col: string };

// Real UUIDs, not `id-<n>` (PCCC-4): ingestItem now mints graph partition pointers whose scheme
// asserts canonical-UUID inputs (a reviewed fail-loud invariant a fixture must satisfy, not weaken).
import { randomUUID } from "node:crypto";
import type { TransactionSession } from "@/lib/db/types";
import { bindTransactionSessionAlias } from "@/lib/db/pg/tx";
const nextId = () => randomUUID();

export class FakeSupabase {
  private readonly bound: boolean;

  constructor(bound = false) {
    this.bound = bound;
  }

  tables: Record<string, Row[]> = {
    projects: [],
    items: [],
    item_versions: [],
    tasks: [],
    decisions: [],
    audit_log: [],
    project_context_units: [],
    project_context_memberships: [],
    project_groups: [],
    groups: [],
  };

  from(table: string) {
    this.tables[table] ??= [];
    return new Builder(this.tables[table]);
  }

  /**
   * Explicit orchestration-only transaction fixture. Row locking is a no-op: this proves neither
   * PostgreSQL atomicity nor concurrency. The SQL executor recognizes only ingest/context control
   * statements and rejects everything else instead of pretending to be a database.
   */
  async transaction<T>(
    fn: (session: {
      db: FakeSupabase;
      executeSql: <R = Row>(text: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number }>;
      optionalAudit<R>(operation: () => Promise<R>, fallback: R): Promise<R>;
    }) => Promise<T>
  ): Promise<T> {
    if (this.bound) throw new Error("transaction-session-already-bound");
    const snapshot = structuredClone(this.tables);
    const sessionDb = new FakeSupabase(true);
    sessionDb.tables = this.tables;
    let active = true;
    const executeSql = async <R = Row>(text: string, params: unknown[] = []) => {
      if (!active) throw new Error("transaction-session-completed");
      const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized === "show lock_timeout") {
        return { rows: [{ lock_timeout: "0" } as R], rowCount: 1 };
      }
      if (normalized.startsWith("select set_config('lock_timeout'")) {
        return { rows: [] as R[], rowCount: 1 };
      }
      if (normalized.startsWith("select pg_advisory_xact_lock")) {
        return { rows: [] as R[], rowCount: 1 };
      }
      if (normalized.includes(" from items ") && normalized.includes("for update")) {
        const byPath = normalized.includes("project_id = $2 and path = $3");
        const rows = this.tables.items.filter((row) =>
          byPath
            ? row.team_id === params[0] && row.project_id === params[1] && row.path === params[2]
            : row.team_id === params[0] && row.id === params[1]
        );
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (normalized.includes(" from items ") && normalized.includes("where team_id = $1 and id = $2")) {
        const rows = this.tables.items.filter(
          (row) => row.team_id === params[0] && row.id === params[1]
        );
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (normalized.startsWith("update project_context_units u")) {
        const unit = this.tables.project_context_units.find(
          (row) => row.id === params[0] && row.team_id === params[1]
        );
        const item = this.tables.items.find(
          (row) => row.id === params[2] && row.team_id === params[1]
        );
        if (!unit || !item || unit.source_item_id !== item.id || unit.unit_kind !== "item") {
          return { rows: [] as R[], rowCount: 0 };
        }
        Object.assign(unit, {
          audience: item.access,
          content_sha256: item.content_sha256,
          occurred_at: item.work_at,
          updated_at: new Date().toISOString(),
        });
        return { rows: [{ audience: unit.audience } as R], rowCount: 1 };
      }
      throw new Error(`fake transaction executor: unsupported SQL: ${normalized}`);
    };
    let fakeSession: (TransactionSession & { active: boolean }) | undefined;
    try {
      fakeSession = {
        db: sessionDb,
        executeSql,
        active: true,
        async optionalAudit<R>(operation: () => Promise<R>, fallback: R): Promise<R> {
          const auditSnapshot = structuredClone(sessionDb.tables.audit_log);
          try {
            return await operation();
          } catch {
            sessionDb.tables.audit_log = auditSnapshot;
            return fallback;
          }
        },
      };
      bindTransactionSessionAlias(sessionDb, fakeSession);
      const result = await fn(fakeSession);
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
        // Deliberate fake limitation: every ok:false restores the snapshot. Production may commit
        // the protected-human refusal standing state, whose persistence is authoritative only in
        // the real PostgreSQL A13-08/A13-09 data-mechanics coverage.
        this.tables = snapshot;
      }
      return result;
    } catch (error) {
      this.tables = snapshot;
      throw error;
    } finally {
      active = false;
      if (fakeSession) fakeSession.active = false;
    }
  }
}

class Builder implements PromiseLike<{ data: unknown; error: null }> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | null = null;
  private conflict: string[] = [];
  private filters: Filter[] = [];
  private wantSelect = false;

  constructor(private rows: Row[]) {}

  // -- ops ----------------------------------------------------------------
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = payload;
    this.conflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  select(_cols?: string) {
    this.wantSelect = true;
    return this;
  }

  // -- filters ------------------------------------------------------------
  eq(col: string, val: unknown) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ kind: "in", col, val });
    return this;
  }
  not(col: string, _op: "is", _val: null) {
    this.filters.push({ kind: "notNull", col });
    return this;
  }
  /** `.is(col, null)` — the pointer writer's immutability predicate (PCCC-4). A row whose column
   *  was never set matches too: the fake's inserts omit absent columns, where Postgres stores null. */
  is(col: string, _val: null) {
    this.filters.push({ kind: "isNull", col });
    return this;
  }
  order(_col: string, _opts?: { ascending?: boolean }) {
    return this; // ordering is irrelevant to these unit tests
  }

  // -- terminals ----------------------------------------------------------
  async single() {
    const out = this.run();
    return { data: out[0] ?? null, error: out.length ? null : { message: "no rows" } };
  }
  async maybeSingle() {
    return { data: this.run()[0] ?? null, error: null };
  }
  then<R>(resolve: (v: { data: unknown; error: null }) => R): R {
    return resolve({ data: this.run(), error: null });
  }

  // -- execution ----------------------------------------------------------
  private match(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === "eq") return row[f.col] === f.val;
      if (f.kind === "in") return f.val.includes(row[f.col]);
      if (f.kind === "isNull") return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] !== null && row[f.col] !== undefined;
    });
  }

  private run(): Row[] {
    switch (this.op) {
      case "insert": {
        const row = { id: this.payload!.id ?? nextId(), ...this.payload };
        this.rows.push(row);
        return [row];
      }
      case "upsert": {
        const found = this.conflict.length
          ? this.rows.find((r) => this.conflict.every((k) => r[k] === this.payload![k]))
          : undefined;
        if (found) {
          Object.assign(found, this.payload);
          return [found];
        }
        const row = { id: this.payload!.id ?? nextId(), ...this.payload };
        this.rows.push(row);
        return [row];
      }
      case "update": {
        for (const r of this.rows.filter((r) => this.match(r))) Object.assign(r, this.payload);
        return [];
      }
      case "delete": {
        for (let i = this.rows.length - 1; i >= 0; i--) {
          if (this.match(this.rows[i])) this.rows.splice(i, 1);
        }
        return [];
      }
      case "select":
      default:
        return this.rows.filter((r) => this.match(r));
    }
  }
}
