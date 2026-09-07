import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * "Am I a staging database?" — ONE owner, for the whole of `lib/`.
 *
 * `staging_marker` is the repo's purpose-built staging/production discriminator. It is deliberately
 * absent from `postgres/schema.sql` and from every migration, so a `pg_restore` of a production dump
 * cannot carry it to production: the archive does not contain it. (That is a claim about the restore
 * path, not a proof that no `staging_marker`-shaped table can ever exist on production — one could be
 * created independently, and STGENV-3's refusal says which table it saw so that state is diagnosable
 * rather than mysterious.) Measured 2026-09-05: `t` on staging, `f` on prod.
 *
 * WHY IT IS RAW SQL AND NOT `DbClient`. `to_regclass` is not expressible through the query builder
 * (`lib/db/types.ts`), so this reads the pool directly. Callers that need a test seam must therefore
 * INJECT this function rather than rely on an injected `db` — `runGraphProjection` does exactly that,
 * because a fake `db` would otherwise be bypassed and `getPool()` throws with no `DATABASE_URL`.
 *
 * SECOND OWNER, deliberately: `scripts/staging-refresh.sh` asks the same question in bash, because the
 * refresh script must not import app code. The single-owner guard is therefore scoped to `lib/`.
 */
export async function readStagingMarker(): Promise<boolean> {
  // The table name is a literal, not a constant: `test/guards/staging-bounded-projection.test.ts`
  // asserts this exact SQL appears in exactly one module under `lib/`, and an exported constant that
  // the query did not actually use would read as the single source of the name while not being it.
  const res = await runSql<{ present: boolean }>(
    "select to_regclass('public.staging_marker') is not null as present",
    []
  );
  return res.rows[0]?.present === true;
}
