/**
 * Catalog fingerprint of a live Postgres database — the assertion primitive behind the
 * migrate-from-existing lane (`scripts/migrate-from-existing.mjs`).
 *
 * A fingerprint is a SORTED list of `kind\tidentity\tdefinition` lines read straight out of the
 * system catalogs: columns (type/default/nullability/identity), indexes, constraints, enum labels
 * IN ENUM SORT ORDER, functions, triggers and views. Two databases with the same fingerprint are
 * structurally the same database as far as anything the app can observe.
 *
 * Deliberately NOT part of the fingerprint:
 *  - `attnum` (physical column order). `schema.sql` writes a column in its natural place; a
 *    migration can only `add column` at the end. Both are correct, so ordering a column set by
 *    attnum would report a false difference on literally every additive migration. Columns are
 *    keyed and sorted by NAME.
 *  - OIDs, sizes, row counts, and anything else that changes run to run.
 *
 * Pure node + `pg` (no tsx), so it runs anywhere the deploy-time loader runs.
 */

/** One row per column: type, default, nullability, identity/generated-ness. */
const COLUMNS_SQL = `
  select 'column' as kind,
         c.relname || '.' || a.attname as ident,
         format_type(a.atttypid, a.atttypmod)
           || ' null=' || (not a.attnotnull)::text
           || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
           || ' identity=' || coalesce(nullif(a.attidentity::text, ''), '-')
           || ' generated=' || coalesce(nullif(a.attgenerated::text, ''), '-')
           || ' collation=' || coalesce(co.collname, '-')
           as def
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_collation co on co.oid = a.attcollation
   where n.nspname = $1 and a.attnum > 0 and not a.attisdropped
     and c.relkind in ('r','p','v','m','f')
`;

/** Index definitions, minus the schema qualification noise. */
const INDEXES_SQL = `
  select 'index' as kind, c.relname || '.' || i.relname as ident,
         pg_get_indexdef(i.oid) as def
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class c on c.oid = x.indrelid
    join pg_namespace n on n.oid = i.relnamespace
   where n.nspname = $1
`;

/** Every constraint: check, fk, unique, pk, exclusion. */
const CONSTRAINTS_SQL = `
  select 'constraint' as kind,
         coalesce(c.relname, '-') || '.' || con.conname as ident,
         pg_get_constraintdef(con.oid) || ' deferrable=' || con.condeferrable::text as def
    from pg_constraint con
    join pg_namespace n on n.oid = con.connamespace
    left join pg_class c on c.oid = con.conrelid
   where n.nspname = $1
`;

/**
 * Enum labels in ENUM SORT ORDER, not alphabetical — `order by status` reads enumsortorder, so a
 * migration that appends a label where `schema.sql` inserts it mid-list is a real behavioural
 * difference and must fail the lane.
 */
const ENUMS_SQL = `
  select 'enum' as kind, t.typname as ident,
         string_agg(e.enumlabel, ',' order by e.enumsortorder) as def
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = $1
   group by t.typname
`;

/** Domains (and their constraints) — a schema.sql-only construct is still a construct. */
const DOMAINS_SQL = `
  select 'domain' as kind, t.typname as ident,
         format_type(t.typbasetype, t.typtypmod) || ' notnull=' || t.typnotnull::text
           || ' default=' || coalesce(t.typdefault, '-') as def
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = $1 and t.typtype = 'd'
`;

/** Full function bodies: a migration that redefines a trigger function must be mirrored too. */
const FUNCTIONS_SQL = `
  select 'function' as kind,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as ident,
         pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = $1 and p.prokind in ('f','p')
`;

const TRIGGERS_SQL = `
  select 'trigger' as kind, c.relname || '.' || t.tgname as ident,
         pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = $1 and not t.tgisinternal
`;

const RELATIONS_SQL = `
  select 'relation' as kind, c.relname as ident,
         c.relkind::text || ' persistence=' || c.relpersistence::text
           || ' rowsecurity=' || c.relrowsecurity::text
           || coalesce(' view=' || pg_get_viewdef(c.oid, true), '') as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = $1 and c.relkind in ('r','p','v','m','f','S')
`;

const SECTIONS = [
  RELATIONS_SQL, COLUMNS_SQL, INDEXES_SQL, CONSTRAINTS_SQL,
  ENUMS_SQL, DOMAINS_SQL, FUNCTIONS_SQL, TRIGGERS_SQL,
];

/**
 * @param {import("pg").Client} client
 * @param {string} schema
 * @returns {Promise<string[]>} sorted `kind\tident\tdef` lines
 */
export async function fingerprint(client, schema = "public") {
  /** @type {string[]} */
  const lines = [];
  for (const sql of SECTIONS) {
    const { rows } = await client.query(sql, [schema]);
    for (const row of rows) {
      // Collapse whitespace so a reformatted-but-identical function body isn't a false diff.
      const def = String(row.def).replace(/\s+/g, " ").trim();
      lines.push(`${row.kind}\t${row.ident}\t${def}`);
    }
  }
  lines.sort();
  return lines;
}

/**
 * Human-readable diff of two fingerprints, capped so a catastrophic mismatch doesn't bury the log.
 * @param {string[]} expected @param {string[]} actual
 */
export function diffFingerprints(expected, actual, limit = 40) {
  const left = new Set(expected);
  const right = new Set(actual);
  const missing = expected.filter((l) => !right.has(l));
  const extra = actual.filter((l) => !left.has(l));
  const out = [];
  for (const line of missing.slice(0, limit)) out.push(`- ${line}`);
  if (missing.length > limit) out.push(`  … ${missing.length - limit} more missing`);
  for (const line of extra.slice(0, limit)) out.push(`+ ${line}`);
  if (extra.length > limit) out.push(`  … ${extra.length - limit} more extra`);
  return { missing, extra, text: out.join("\n") };
}
