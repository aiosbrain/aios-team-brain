/**
 * Minimal in-memory Supabase stand-in for unit-testing lib/ingest without a DB.
 * Supports exactly the PostgREST fluent chain ingestItem() uses: from().upsert/
 * insert/update/delete/select with eq()/maybeSingle()/single()/not(col,'is',null).
 * Not a general mock — faithful to the calls in index.ts, deliberately small.
 */
type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "notNull"; col: string };

let idSeq = 1;
const nextId = () => `id-${idSeq++}`;

export class FakeSupabase {
  tables: Record<string, Row[]> = {
    projects: [],
    items: [],
    item_versions: [],
    tasks: [],
    decisions: [],
    audit_log: [],
  };

  from(table: string) {
    this.tables[table] ??= [];
    return new Builder(this.tables[table]);
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
  not(col: string, _op: "is", _val: null) {
    this.filters.push({ kind: "notNull", col });
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
    return this.filters.every((f) =>
      f.kind === "eq" ? row[f.col] === f.val : row[f.col] !== null && row[f.col] !== undefined
    );
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
