import "server-only";
import { runSql } from "./pool";
import { lookupRelationship } from "./relationships";

/**
 * A PostgREST-compatible query builder over `pg`, supporting exactly the subset
 * of the Supabase client surface this app uses (see the data-access catalog):
 * select with embedded resources + `(count)` aggregates + FTS + JSON `->>`,
 * insert/update/upsert/delete, count/head, and the filter/order/limit chain.
 *
 * It is awaitable like the Supabase builder and resolves to `{ data, error,
 * count }` — it never rejects, mirroring Supabase semantics. Anything outside
 * the supported subset throws loudly so we never silently return wrong rows.
 */

export interface PgResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
  count: number | null;
}

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like";
interface Filter {
  col: string;
  op: FilterOp | "not";
  val: unknown;
  notOp?: FilterOp; // when op === "not": the negated operator (e.g. "is")
}
interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

class Params {
  readonly values: unknown[] = [];
  /** Bind a value, returning its `$n` placeholder (jsonb objects are cast). */
  bind(val: unknown): string {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)) {
      this.values.push(JSON.stringify(val));
      return `$${this.values.length}::jsonb`;
    }
    this.values.push(val instanceof Date ? val.toISOString() : val);
    return `$${this.values.length}`;
  }
}

/** Split a select/returning spec on top-level commas (respecting parens). */
function splitTopLevel(spec: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of spec) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Turn `attrs->>status` into a safe SQL expression `(attrs ->> 'status')`. */
function compileColumn(col: string): string {
  if (col.includes("->>")) {
    const [base, key] = col.split("->>");
    if (!/^[a-z_][a-z0-9_]*$/i.test(base.trim()) || !/^[a-z0-9_]+$/i.test(key.trim())) {
      throw new Error(`pg-adapter: unsupported JSON column expression "${col}"`);
    }
    return `(${base.trim()} ->> '${key.trim()}')`;
  }
  if (!/^[a-z_][a-z0-9_.*]*$/i.test(col)) {
    throw new Error(`pg-adapter: unsupported column reference "${col}"`);
  }
  return col;
}

export class PgQuery<T = unknown> implements PromiseLike<PgResult<T>> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private selectSpec = "*";
  private returningSpec: string | null = null;
  private filters: Filter[] = [];
  private orders: OrderSpec[] = [];
  private limitN?: number;
  private offsetN?: number;
  private singleMode: "single" | "maybe" | null = null;
  private countMode: "exact" | null = null;
  private headMode = false;
  private payload?: unknown;
  private conflictCols?: string;
  private textSearchSpec?: { col: string; query: string; config: string };

  constructor(private readonly table: string) {}

  // ── shape ──────────────────────────────────────────────────────────────────
  select(spec = "*", opts?: { count?: "exact"; head?: boolean }): this {
    if (this.op === "select") {
      this.selectSpec = spec;
      if (opts?.count) this.countMode = opts.count;
      if (opts?.head) this.headMode = true;
    } else {
      this.returningSpec = spec; // RETURNING after a mutation
    }
    return this;
  }
  insert(values: unknown): this {
    this.op = "insert";
    this.payload = values;
    return this;
  }
  update(values: unknown): this {
    this.op = "update";
    this.payload = values;
    return this;
  }
  upsert(values: unknown, opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = values;
    this.conflictCols = opts?.onConflict;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }

  // ── filters ──────────────────────────────────────────────────────────────────
  eq(col: string, val: unknown): this {
    return this.push(col, "eq", val);
  }
  neq(col: string, val: unknown): this {
    return this.push(col, "neq", val);
  }
  gt(col: string, val: unknown): this {
    return this.push(col, "gt", val);
  }
  gte(col: string, val: unknown): this {
    return this.push(col, "gte", val);
  }
  lt(col: string, val: unknown): this {
    return this.push(col, "lt", val);
  }
  lte(col: string, val: unknown): this {
    return this.push(col, "lte", val);
  }
  in(col: string, val: unknown[]): this {
    return this.push(col, "in", val);
  }
  is(col: string, val: null): this {
    return this.push(col, "is", val);
  }
  like(col: string, val: string): this {
    return this.push(col, "like", val);
  }
  not(col: string, op: FilterOp, val: unknown): this {
    this.filters.push({ col, op: "not", notOp: op, val });
    return this;
  }
  textSearch(col: string, query: string, opts?: { type?: string; config?: string }): this {
    const config = opts?.config ?? "english";
    if (!/^[a-z_]+$/i.test(config)) throw new Error(`pg-adapter: bad FTS config "${config}"`);
    this.textSearchSpec = { col, query, config };
    return this;
  }

  private push(col: string, op: FilterOp, val: unknown): this {
    this.filters.push({ col, op, val });
    return this;
  }

  // ── ordering / pagination / cardinality ──────────────────────────────────────
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({
      col,
      ascending: opts?.ascending ?? true,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  single(): this {
    this.singleMode = "single";
    return this;
  }
  maybeSingle(): this {
    this.singleMode = "maybe";
    return this;
  }

  // ── execution ────────────────────────────────────────────────────────────────
  then<R1 = PgResult<T>, R2 = never>(
    onfulfilled?: ((v: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<PgResult<T>> {
    try {
      switch (this.op) {
        case "select":
          return await this.runSelect();
        case "insert":
        case "upsert":
          return await this.runInsert();
        case "update":
          return await this.runUpdate();
        case "delete":
          return await this.runDelete();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "pg query failed";
      console.error(`[pg] ${this.op} ${this.table}: ${message}`);
      return { data: null, error: { message }, count: null };
    }
  }

  private whereClause(p: Params): string {
    const parts: string[] = [];
    for (const f of this.filters) {
      const col = compileColumn(f.col);
      const op = f.op === "not" ? f.notOp! : f.op;
      const negate = f.op === "not";
      let clause: string;
      switch (op) {
        case "eq":
          clause = `${col} = ${p.bind(f.val)}`;
          break;
        case "neq":
          clause = `${col} <> ${p.bind(f.val)}`;
          break;
        case "gt":
          clause = `${col} > ${p.bind(f.val)}`;
          break;
        case "gte":
          clause = `${col} >= ${p.bind(f.val)}`;
          break;
        case "lt":
          clause = `${col} < ${p.bind(f.val)}`;
          break;
        case "lte":
          clause = `${col} <= ${p.bind(f.val)}`;
          break;
        case "like":
          clause = `${col} LIKE ${p.bind(f.val)}`;
          break;
        case "is":
          clause = `${col} IS NULL`;
          break;
        case "in": {
          const arr = (f.val as unknown[]) ?? [];
          if (arr.length === 0) {
            clause = "false";
            break;
          }
          clause = `${col} IN (${arr.map((v) => p.bind(v)).join(", ")})`;
          break;
        }
        default:
          throw new Error(`pg-adapter: unsupported operator "${op}"`);
      }
      parts.push(negate ? `NOT (${clause})` : clause);
    }
    if (this.textSearchSpec) {
      const { col, query, config } = this.textSearchSpec;
      parts.push(`${compileColumn(col)} @@ websearch_to_tsquery('${config}', ${p.bind(query)})`);
    }
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  }

  private orderClause(): string {
    if (!this.orders.length) return "";
    const cols = this.orders.map((o) => {
      const dir = o.ascending ? "ASC" : "DESC";
      const nulls =
        o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
      return `${compileColumn(o.col)} ${dir}${nulls}`;
    });
    return `ORDER BY ${cols.join(", ")}`;
  }

  private limitClause(): string {
    let out = "";
    if (this.limitN !== undefined) out += ` LIMIT ${Number(this.limitN)}`;
    if (this.offsetN !== undefined) out += ` OFFSET ${Number(this.offsetN)}`;
    return out;
  }

  /** Compile the select list, expanding embedded resources into subqueries. */
  private selectList(): string {
    const tokens = splitTopLevel(this.selectSpec);
    const cols: string[] = [];
    for (const tok of tokens) {
      const paren = tok.indexOf("(");
      if (paren === -1) {
        cols.push(tok === "*" ? "*" : compileColumn(tok));
        continue;
      }
      const head = tok.slice(0, paren);
      const inner = tok.slice(paren + 1, tok.lastIndexOf(")")).trim();
      const alias = head.includes(":") ? head.split(":")[0].trim() : head.trim();
      const rel = lookupRelationship(this.table, alias);
      if (!rel) throw new Error(`pg-adapter: unknown embed "${alias}" on "${this.table}"`);
      const join = `${rel.table}.${rel.foreign} = ${this.table}.${rel.local}`;
      if (inner === "count" || rel.kind === "many") {
        cols.push(
          `(select json_agg(json_build_object('count', _c.c)) ` +
            `from (select count(*)::int c from ${rel.table} where ${join}) _c) as "${alias}"`
        );
      } else {
        const sub = splitTopLevel(inner).map(compileColumn).join(", ");
        cols.push(
          `(select row_to_json(_e) from ` +
            `(select ${sub} from ${rel.table} where ${join} limit 1) _e) as "${alias}"`
        );
      }
    }
    return cols.join(", ");
  }

  private finalizeRows(rows: T[], count: number | null): PgResult<T> {
    if (this.singleMode) {
      if (rows.length > 1 && this.singleMode === "single") {
        return { data: null, error: { message: "multiple rows returned" }, count };
      }
      return { data: (rows[0] ?? null) as T, error: null, count };
    }
    return { data: rows as unknown as T, error: null, count };
  }

  private async runSelect(): Promise<PgResult<T>> {
    const p = new Params();
    const where = this.whereClause(p);
    if (this.headMode && this.countMode) {
      const { rows } = await runSql<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.table} ${where}`,
        p.values
      );
      return { data: null, error: null, count: rows[0]?.count ?? 0 };
    }
    const sql = `SELECT ${this.selectList()} FROM ${this.table} ${where} ${this.orderClause()} ${this.limitClause()}`;
    const { rows } = await runSql<T>(sql, p.values);
    let count: number | null = null;
    if (this.countMode) {
      const cp = new Params();
      const cwhere = this.whereClause(cp);
      const { rows: cr } = await runSql<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${this.table} ${cwhere}`,
        cp.values
      );
      count = cr[0]?.count ?? 0;
    }
    return this.finalizeRows(rows, count);
  }

  private returningClause(): string {
    if (!this.returningSpec) return "";
    const cols = splitTopLevel(this.returningSpec);
    if (cols.some((c) => c.includes("("))) {
      throw new Error("pg-adapter: embeds in RETURNING are not supported");
    }
    return ` RETURNING ${cols.map(compileColumn).join(", ")}`;
  }

  private async runInsert(): Promise<PgResult<T>> {
    const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Record<
      string,
      unknown
    >[];
    if (rows.length === 0) return { data: [] as unknown as T, error: null, count: null };
    const columns = Object.keys(rows[0]);
    const p = new Params();
    const valuesSql = rows
      .map((row) => `(${columns.map((c) => p.bind(row[c])).join(", ")})`)
      .join(", ");
    let conflict = "";
    if (this.op === "upsert" && this.conflictCols) {
      const target = this.conflictCols
        .split(",")
        .map((c) => compileColumn(c.trim()))
        .join(", ");
      const updates = columns
        .filter((c) => !this.conflictCols!.split(",").map((x) => x.trim()).includes(c))
        .map((c) => `${c} = EXCLUDED.${c}`);
      conflict = updates.length
        ? ` ON CONFLICT (${target}) DO UPDATE SET ${updates.join(", ")}`
        : ` ON CONFLICT (${target}) DO NOTHING`;
    }
    const sql = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES ${valuesSql}${conflict}${this.returningClause()}`;
    const { rows: out } = await runSql<T>(sql, p.values);
    return this.returningSpec ? this.finalizeRows(out, null) : { data: null, error: null, count: null };
  }

  private async runUpdate(): Promise<PgResult<T>> {
    const payload = this.payload as Record<string, unknown>;
    const p = new Params();
    const set = Object.keys(payload)
      .map((c) => `${c} = ${p.bind(payload[c])}`)
      .join(", ");
    const where = this.whereClause(p);
    const sql = `UPDATE ${this.table} SET ${set} ${where}${this.returningClause()}`;
    const { rows } = await runSql<T>(sql, p.values);
    return this.returningSpec ? this.finalizeRows(rows, null) : { data: null, error: null, count: null };
  }

  private async runDelete(): Promise<PgResult<T>> {
    const p = new Params();
    const where = this.whereClause(p);
    const sql = `DELETE FROM ${this.table} ${where}${this.returningClause()}`;
    const { rows } = await runSql<T>(sql, p.values);
    return this.returningSpec ? this.finalizeRows(rows, null) : { data: null, error: null, count: null };
  }
}
