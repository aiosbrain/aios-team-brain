/**
 * Seed the battery's local Postgres from prod, read-only on the source (PIPEFF-2 / AIO-821).
 *
 * WHY A COPY AND NOT A FIXTURE. The corpus has to be this install's own content — see `corpus.mjs`
 * for why a synthetic fixture is the failure this workstream exists to prevent. The repo is public,
 * so that content can never be committed; it is copied into a throwaway local database at run time
 * and dies with the container.
 *
 * WHAT GETS COPIED, AND WHY EACH ONE IS LOAD-BEARING:
 *   · `teams`         — the projector and the LLM proxy both resolve the team; the row also carries
 *                       `extraction_provider`/`extraction_model`, which the arms must match or they
 *                       measure a cost shape prod does not have.
 *   · `projects`      — `items.project_id` is NOT NULL with an FK, so the corpus cannot land without it.
 *   · `members`       — Q2 (people recall) and Q6 (entity convergence) are both computed over member
 *                       names. Without these two metrics have no denominator at all.
 *   · `items`         — the pinned corpus, bodies included. The only table whose content is sensitive.
 *   · `integrations`  — copied **still encrypted**. The battery never decrypts, never prints and never
 *                       writes the provider key anywhere; the local brain decrypts it in-process with
 *                       the same `SECRETS_KEY`, exactly as prod does. That is the whole reason to copy
 *                       the ciphertext rather than resolve the key and pass it along.
 *
 * The three things beyond rows that the stack needs — `SECRETS_KEY`, `GRAPH_LLM_PROXY_SECRET` and
 * `GRAPH_LLM_TEAM` — are asserted here rather than discovered later, because without them the stack
 * boots and then quietly does nothing: `authorizeGraphProxy` fails CLOSED on an unset secret, and
 * `resolveGraphProxyTeamId` refuses rather than guessing.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=<prod public URL>  TARGET_DATABASE_URL=<local test DB>  \
 *   node scripts/graph-window-battery/seed-local.mjs
 */
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { selectCorpus, verifyCorpus, countFromBody, CANDIDATE_SQL, PROJECTABLE_KINDS } from "./corpus.mjs";

/** SSL only where the URL says so, so this runs against a plain local Postgres too. */
const connect = async (url, label) => {
  if (!url) throw new Error(`${label} is required`);
  const needsSsl = /\bsslmode=require\b/.test(url) || /rlwy\.net|railway/.test(url);
  const c = new Client({ connectionString: url, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await c.connect();
  return c;
};

/**
 * Copy whole rows without naming every column, so a schema change cannot silently drop one.
 *
 * `nulled` blanks specific columns on the way across. Used for exactly one thing today —
 * `members.auth_user_id` — and that is a decision rather than a workaround: the FK points at
 * `auth_users`, which the battery has no reason to copy because **nothing ever logs in**. Nulling it
 * is also strictly safer than satisfying it: no authentication identity is duplicated into a
 * throwaway database to run a cost experiment.
 */
async function copyRows(src, dst, table, where, params, nulled = []) {
  const { rows } = await src.query(`select * from ${table} where ${where}`, params);
  if (rows.length === 0) return 0;
  const cols = Object.keys(rows[0]).filter((c) => c !== "search"); // generated column — Postgres refuses a write
  const colList = cols.map((c) => `"${c}"`).join(", ");
  for (const r of rows) {
    const vals = cols.map((c) => (nulled.includes(c) ? null : r[c]));
    const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
    await dst.query(`insert into ${table} (${colList}) values (${ph}) on conflict (id) do nothing`, vals);
  }
  return rows.length;
}

/**
 * Count episodes per item with the projector's OWN `chunkContent`, via `count-chunks.ts`.
 * A bridge to the one implementation, never a copy of it.
 */
function countWithProjector(bodiesById) {
  const r = spawnSync(
    "npx",
    ["tsx", "--conditions", "react-server", "scripts/graph-window-battery/count-chunks.ts"],
    { input: JSON.stringify(bodiesById), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error(`count-chunks failed (${r.status}): ${r.stderr ?? ""}`);
  }
  const out = JSON.parse(r.stdout);
  const missing = Object.keys(bodiesById).filter((id) => !Number.isFinite(out[id]));
  // Refuse rather than silently falling back to the estimate for a subset — a corpus counted two
  // different ways is exactly the divergence this replaces.
  if (missing.length) throw new Error(`count-chunks returned no count for ${missing.length} item(s)`);
  return out;
}

const src = await connect(process.env.SOURCE_DATABASE_URL, "SOURCE_DATABASE_URL");
const dst = await connect(process.env.TARGET_DATABASE_URL, "TARGET_DATABASE_URL");

// Refuse to run the two at the same place. Seeding writes; the source must never be written to.
const same = process.env.SOURCE_DATABASE_URL === process.env.TARGET_DATABASE_URL;
if (same) throw new Error("SOURCE and TARGET are the same database — this script WRITES to the target");

const team = (await src.query("select * from teams order by created_at, id limit 1")).rows[0];
if (!team) throw new Error("no team in the source database");

const { rows: candidates } = await src.query(CANDIDATE_SQL, [team.id, PROJECTABLE_KINDS]);

// PIPEFF-5: count the CANDIDATES with the projector's real chunker BEFORE bucketing.
//
// This used to bucket and gate on `ceil(chars / CHUNK_CHARS)`, which was exact under the legacy
// byte-offset chunker and is not under `cdc1` (PIPEFF-3). Measured 2026-08-16: the estimate said
// **117 episodes**, the projector then pushed **164** — a 40% under-count, not the ~5% the estimate's
// own note claimed. So `EPISODE_BUDGET`'s 90–120 gate reported "within range" for a corpus 44
// episodes outside it, and bucket A ("≥8 chunks") was decided on a guess.
//
// The real chunker lives in a `server-only` module, so it is reached through `count-chunks.ts` under
// `tsx --conditions react-server` — a bridge, NOT a second implementation. Duplicating the algorithm
// here is the drift this suite already guards against once.
const candidateIds = candidates.map((r) => r.id);
const { rows: candidateBodies } = await src.query("select id, body from items where id = any($1)", [candidateIds]);
const realChunks = countWithProjector(Object.fromEntries(candidateBodies.map((r) => [r.id, r.body ?? ""])));

const selection = selectCorpus(
  candidates.map((r) => ({ ...r, chars: Number(r.chars), chunks: realChunks[r.id] }))
);
if (!selection.countedExactly) throw new Error("seed-local: some candidates lack a real chunk count — refusing to select on an estimate");
if (selection.shortfall.length) console.log(`  shortfall: ${selection.shortfall.join(" · ")}`);

const ids = selection.items.map((i) => i.id);
const bodyById = new Map(candidateBodies.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.body]));

// Verified with the SAME real counts, so `verified.episodes` is what the projector will push.
const verified = verifyCorpus(selection, bodyById, (body) => {
  const hit = Object.entries(realChunks).find(([id]) => bodyById.get(id) === body);
  return hit ? hit[1] : countFromBody(body);
});
if (verified.divergent?.length) {
  console.log(`  ⚠ ${verified.divergent.length} item(s) where the SQL estimate and the projector disagree:`);
  for (const d of verified.divergent) console.log(`      ${d.id}: estimated ${d.estimated}, actual ${d.actual}`);
}

await dst.query("begin");
const counts = {
  teams: await copyRows(src, dst, "teams", "id = $1", [team.id], ["created_by"]),
  projects: await copyRows(src, dst, "projects", "team_id = $1", [team.id]),
  members: await copyRows(src, dst, "members", "team_id = $1", [team.id], ["auth_user_id"]),
  items: await copyRows(src, dst, "items", "id = any($1)", [ids]),
  // Encrypted. Never decrypted here — the local brain does that in-process with the same SECRETS_KEY.
  integrations: await copyRows(src, dst, "integrations", "team_id = $1", [team.id]),
};
await dst.query("commit");

console.log(`\nseeded into the local database (team ${team.slug}):`);
for (const [t, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(5)} ${t}`);
console.log(`\ncorpus: ${verified.items.length} items · ${verified.episodes} episodes`);
console.log(`  single-chunk episode share ${(verified.singleChunkEpisodeShare * 100).toFixed(1)}% (prod ~17%)`);
console.log(`  episode budget: ${verified.episodeBudgetBreach ?? "within range"}`);
console.log(`\nextraction target the arms must match: ${team.extraction_provider ?? "(unset)"} / ${team.extraction_model ?? "(unset)"}`);

// Named here rather than discovered when the stack silently does nothing.
const missing = ["SECRETS_KEY", "GRAPH_LLM_PROXY_SECRET", "GRAPH_LLM_TEAM"].filter((k) => !process.env[k]);
if (missing.length) {
  console.log(`\n⚠ still needed before a single LLM call can flow: ${missing.join(", ")}`);
  console.log("  authorizeGraphProxy fails CLOSED on an unset secret, and resolveGraphProxyTeamId refuses");
  console.log("  rather than guessing — so the stack would boot and quietly extract nothing.");
}

// The pinned corpus, for the session log. Ids only; no content leaves the local database.
console.log(`\npinned item ids (for the session log):\n${verified.items.map((i) => `${i.bucket} ${i.chunks}ch ${i.id}`).join("\n")}`);

await src.end();
await dst.end();
