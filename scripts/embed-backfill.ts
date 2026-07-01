/**
 * Backfill dense embeddings for existing items (optional pgvector retrieval). Idempotent — skips
 * items whose chunk set already matches their content hash, so it's safe to re-run. Requires
 * EMBEDDINGS_URL + the pgvector schema (`npm run pg:schema:vector`). Postgres target only.
 *
 * Run: EMBEDDINGS_URL=… OPENAI_API_KEY=… DATABASE_URL=… \
 *        npx tsx --conditions react-server scripts/embed-backfill.ts [teamSlug]
 */
import { runSql } from "@/lib/db/pg/pool";
import { indexItem, denseIndexAvailable } from "@/lib/query/dense-index";

type ItemRow = {
  id: string;
  team_id: string;
  body: string;
  access: "team" | "external";
  content_sha256: string;
};

async function main() {
  if (!(await denseIndexAvailable())) {
    console.error("dense retrieval unavailable: set EMBEDDINGS_URL and run `npm run pg:schema:vector` first");
    process.exit(1);
  }
  const teamSlug = process.argv[2];
  const where = teamSlug ? "where t.slug = $1" : "";
  const params = teamSlug ? [teamSlug] : [];
  const items = await runSql<ItemRow>(
    `select i.id, i.team_id, i.body, i.access, i.content_sha256
       from items i join teams t on t.id = i.team_id ${where}
      order by i.updated_at desc`,
    params
  );

  let indexed = 0;
  let chunks = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of items.rows) {
    try {
      const r = await indexItem({
        id: it.id,
        teamId: it.team_id,
        body: it.body,
        access: it.access,
        contentSha256: it.content_sha256,
      });
      if (r.skipped) skipped++;
      else {
        indexed++;
        chunks += r.chunks;
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${it.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(
    `✓ backfill: ${indexed} indexed (${chunks} chunks), ${skipped} up-to-date, ${failed} failed of ${items.rows.length}`
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
