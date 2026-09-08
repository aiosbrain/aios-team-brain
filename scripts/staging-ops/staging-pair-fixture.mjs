#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import neo4j from "neo4j-driver";
import { loadSchema } from "../pg-load-schema.mjs";

const TEAM = "11111111-1111-4111-8111-111111111111";
const INTERNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EXTERNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const AUTH_INTERNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const AUTH_EXTERNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const PROJECTS = {
  external: "22222222-2222-4222-8222-222222222220",
  team: "22222222-2222-4222-8222-222222222221",
  private: "22222222-2222-4222-8222-222222222222",
  deferred: "22222222-2222-4222-8222-222222222223",
};
const ITEMS = {
  external: "33333333-3333-4333-8333-333333333330",
  team: "33333333-3333-4333-8333-333333333331",
  private: "33333333-3333-4333-8333-333333333332",
  deferred: "33333333-3333-4333-8333-333333333333",
};
const GROUPS = {
  everyone: "44444444-4444-4444-8444-444444444440",
  external: "44444444-4444-4444-8444-444444444441",
  private: "44444444-4444-4444-8444-444444444442",
};
const GRAPH_GROUPS = { external: "paired_external", team: "paired_team", private: "paired_private", deferred: "paired_deferred" };
const DIAGNOSTIC_ID_ALLOWLIST = new Set([
  TEAM, INTERNAL, EXTERNAL, AUTH_INTERNAL, AUTH_EXTERNAL,
  ...Object.values(PROJECTS), ...Object.values(ITEMS), ...Object.values(GROUPS),
]);

async function pgClient(url) { const client = new pg.Client({ connectionString: url }); await client.connect(); return client; }
async function graphDriver(url, password) { const driver = neo4j.driver(url, neo4j.auth.basic("neo4j", password)); await driver.verifyConnectivity(); return driver; }

/**
 * Run one action of the CONTEXT SUBSTRATE helper against the source database.
 *
 * `GET /api/v1/items` intersects every result with the caller's CURRENT include memberships whose
 * units are `active` and item-grain. This fixture seeded items and project grants and zero units or
 * memberships, so the application oracle predicted `internal=0, external=0` **before anything was
 * copied** — a successful authentication returning an empty page, indistinguishable from a broken
 * restore. (Graph survival was compatible with it: exporter eligibility independently accepts
 * `target.id = i.project_id`.)
 *
 * It is a separate TypeScript process because those two tables have single-writer owner modules,
 * enforced by a build-failing guard, and every invariant they carry lives there. Hand-rolled SQL
 * here would seed rows that no longer had to obey the no-widening gate — in a harness whose whole
 * purpose is checking an access boundary.
 */
async function contextAction(action, kind = "team") {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    "npx", ["tsx", "--conditions", "react-server", "scripts/staging-ops/staging-pair-context.ts", "--run", action, kind],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.PROD_DATABASE_URL }, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
}

async function seedPostgres(client, suffix = "v1") {
  await client.query("INSERT INTO auth_users(id,email,password_hash) VALUES($1,'internal@example.test','production-password-hash'),($2,'external@example.test','production-password-hash')", [AUTH_INTERNAL, AUTH_EXTERNAL]);
  await client.query("INSERT INTO teams(id,slug,name) VALUES($1,'paired-test','Paired Test')", [TEAM]);
  await client.query(`INSERT INTO members(id,team_id,auth_user_id,email,display_name,actor_handle,role,tier,status) VALUES
    ($1,$3,$4,'internal@example.test','Internal Tester','internal','admin','team','active'),
    ($2,$3,$5,'external@example.test','External Tester','external','member','external','active')`, [INTERNAL, EXTERNAL, TEAM, AUTH_INTERNAL, AUTH_EXTERNAL]);
  for (const [kind, id] of Object.entries(PROJECTS)) await client.query("INSERT INTO projects(id,team_id,slug,name,kind,graph_group_id) VALUES($1,$2,$3,$3,'source',$4)", [id, TEAM, `p-${kind}`, GRAPH_GROUPS[kind]]);
  await client.query(`INSERT INTO groups(id,team_id,slug,name,is_builtin) VALUES
    ($1,$4,'everyone','Everyone',true),($2,$4,'external','External',true),($3,$4,'private-test','Private Test',false)`, [GROUPS.everyone, GROUPS.external, GROUPS.private, TEAM]);
  await client.query(`INSERT INTO group_members(team_id,group_id,member_id) VALUES
    ($1,$2,$3),($1,$4,$5),($1,$6,$3)`, [TEAM, GROUPS.everyone, INTERNAL, GROUPS.external, EXTERNAL, GROUPS.private]);
  await client.query(`INSERT INTO project_groups(team_id,project_id,group_id) VALUES
    ($1,$2,$3),($1,$2,$4),($1,$5,$3),($1,$6,$7),($1,$8,$3)`, [TEAM, PROJECTS.external, GROUPS.everyone, GROUPS.external, PROJECTS.team, PROJECTS.private, GROUPS.private, PROJECTS.deferred]);
  for (const [kind, id] of Object.entries(ITEMS)) {
    const access = kind === "external" ? "external" : "team";
    await client.query("INSERT INTO items(id,team_id,project_id,path,kind,access,body,content_sha256,actor) VALUES($1,$2,$3,$4,'deliverable',$5,$6,$7,'fixture')", [id, TEAM, PROJECTS[kind], `${kind}.md`, access, `${kind} body ${suffix}`, createHash("sha256").update(`${kind}-${suffix}`).digest("hex")]);
  }
  await client.query(`INSERT INTO graph_episodes(team_id,source_table,source_id,group_id,content_sha256,episode_uuid,chunk_shas,deferred,pending_delete_group_id) VALUES
    ($1,'items',$2,$3,$9,'ep-external','{}',false,null),
    ($1,'items',$4,$5,$10,'ep-team-0',ARRAY[$11,$12],false,'paired_old'),
    ($1,'items',$6,$7,$13,'ep-private','{}',false,null),
    ($1,'items',$8,$14,$15,null,'{}',true,null)`, [TEAM, ITEMS.external, GRAPH_GROUPS.external, ITEMS.team, GRAPH_GROUPS.team, ITEMS.private, GRAPH_GROUPS.private, ITEMS.deferred,
      createHash("sha256").update(`external-${suffix}`).digest("hex"), createHash("sha256").update(`team-${suffix}`).digest("hex"), "1".repeat(64), "2".repeat(64), createHash("sha256").update(`private-${suffix}`).digest("hex"), GRAPH_GROUPS.deferred, createHash("sha256").update(`deferred-${suffix}`).digest("hex")]);
  await client.query("INSERT INTO arc_corrections(id,team_id,arc_id,arc_title,corrected_text,group_key,created_by) VALUES('55555555-5555-4555-8555-555555555555',$1,'arc-1','Arc','corrected truth','g:paired_team',$2)", [TEAM, INTERNAL]);
  await client.query("INSERT INTO graph_episodes(team_id,source_table,source_id,group_id,content_sha256,episode_uuid) VALUES($1,'arc_corrections','55555555-5555-4555-8555-555555555555','paired_team',$2,'ep-correction')", [TEAM, "c".repeat(64)]);
  await client.query("INSERT INTO social_jobs(team_id,kind,payload) VALUES($1,'publish','{}')", [TEAM]);
}

async function substrateCounts(client) {
  const counted = await client.query(
    `SELECT (SELECT count(*) FROM project_context_units WHERE team_id=$1 AND unit_kind='item' AND state='active')::int AS units,
            (SELECT count(*) FROM project_context_memberships WHERE team_id=$1 AND decision='include')::int AS memberships,
            (SELECT count(*) FROM project_context_memberships WHERE team_id=$1 AND decision='include' AND valid_to IS NULL)::int AS current_memberships,
            (SELECT count(*) FROM project_context_memberships WHERE team_id=$1 AND decision='include' AND valid_to IS NOT NULL)::int AS closed_memberships`,
    [TEAM],
  );
  return counted.rows[0];
}

/** Four current item memberships are required; the negative control later adds one history row. */
async function assertSubstrateSeeded(client) {
  const counts = await substrateCounts(client);
  if (counts.units !== 4 || counts.memberships !== 4 || counts.current_memberships !== 4 || counts.closed_memberships !== 0) {
    throw new Error(`fixture seeded the wrong context substrate shape: ${JSON.stringify(counts)}`);
  }
  return counts;
}

async function assertReopenedSubstrate() {
  const client = await pgClient(process.env.PROD_DATABASE_URL);
  try {
    const counts = await substrateCounts(client);
    if (counts.units !== 4 || counts.memberships !== 5 || counts.current_memberships !== 4 || counts.closed_memberships !== 1) {
      throw new Error(`membership close/reopen did not retain one historical row: ${JSON.stringify(counts)}`);
    }
    return { status: "reopened-substrate-asserted", ...counts };
  } finally { await client.end(); }
}

async function createEpisode(session, { uuid, name, group, fact, big = false }) {
  await session.run(`CREATE (ep:Episodic {uuid:$uuid,name:$name,group_id:$group,created_at:datetime('2026-09-01T00:00:00Z')})
    CREATE (a:Entity {uuid:$a,name:$name,group_id:$group,big:$big,embedding:[0.1,0.2],summary:'derived cache'})
    CREATE (b:Entity {uuid:$b,name:'target',group_id:$group})
    CREATE (ep)-[:MENTIONS]->(a)
    CREATE (a)-[:RELATES_TO {uuid:$rel,fact:$fact,group_id:$group,episodes:[$uuid]}]->(b)`,
    { uuid, name, group, fact, big: big ? neo4j.int("9007199254740993") : neo4j.int(7), a: `a-${uuid}`, b: `b-${uuid}`, rel: `fact-${uuid}` });
}

async function seedGraph(driver, suffix = "v1") {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.run("MATCH (n) DETACH DELETE n");
    await createEpisode(session, { uuid: "ep-external", name: `items:${ITEMS.external}`, group: GRAPH_GROUPS.external, fact: `external fact ${suffix}` });
    await createEpisode(session, { uuid: "ep-team-0", name: `items:${ITEMS.team}#0`, group: GRAPH_GROUPS.team, fact: `team chunk zero ${suffix}`, big: true });
    await createEpisode(session, { uuid: "ep-team-1", name: `items:${ITEMS.team}#1`, group: GRAPH_GROUPS.team, fact: `team chunk one ${suffix}` });
    await createEpisode(session, { uuid: "ep-private", name: `items:${ITEMS.private}`, group: GRAPH_GROUPS.private, fact: `private fact ${suffix}` });
    await createEpisode(session, { uuid: "ep-deferred", name: `items:${ITEMS.deferred}`, group: GRAPH_GROUPS.deferred, fact: `deferred fact ${suffix}` });
    await createEpisode(session, { uuid: "ep-old", name: `items:${ITEMS.team}`, group: "paired_old", fact: "stale old-group secret" });
    await createEpisode(session, { uuid: "ep-narrowed", name: `items:${ITEMS.team}`, group: "paired_wrong", fact: "narrowed source secret" });
    await createEpisode(session, { uuid: "ep-correction", name: "correction:arc-1", group: GRAPH_GROUPS.team, fact: `correction fact ${suffix}` });
    await session.run(`MATCH (a:Entity {uuid:'a-ep-team-0'}), (b:Entity {uuid:'b-ep-team-0'})
      CREATE (a)-[:RELATES_TO {uuid:'fact-mixed',fact:'mixed provenance secret',group_id:'paired_team',episodes:['ep-team-0','ep-old']}]->(b)`);
  } finally { await session.close(); }
}

async function seed() {
  await loadSchema({ databaseUrl: process.env.PROD_DATABASE_URL });
  await loadSchema({ databaseUrl: process.env.STAGING_DATABASE_URL });
  const prod = await pgClient(process.env.PROD_DATABASE_URL); const staging = await pgClient(process.env.STAGING_DATABASE_URL);
  const prodGraph = await graphDriver(process.env.PROD_NEO4J_URL, "prodtest1"); const stagingGraph = await graphDriver(process.env.STAGING_NEO4J_URL, "stagingtest1");
  try {
    await seedPostgres(prod);
    // The substrate the app reads through, written by its canonical owners and then COUNTED here —
    // the helper reporting success and the database holding four of each are different claims.
    await contextAction("seed");
    await assertSubstrateSeeded(prod);
    await staging.query("CREATE TABLE IF NOT EXISTS staging_marker(note text primary key)");
    await staging.query("INSERT INTO teams(id,slug,name) VALUES('99999999-9999-4999-8999-999999999999','baseline','Baseline')");
    await seedGraph(prodGraph);
    const session = stagingGraph.session({ defaultAccessMode: neo4j.session.WRITE });
    await createEpisode(session, { uuid: "baseline-ep", name: "items:baseline", group: "baseline", fact: "baseline rollback" }); await session.close();
  } finally { await prod.end(); await staging.end(); await prodGraph.close(); await stagingGraph.close(); }
}

async function mutate(version) {
  const prod = await pgClient(process.env.PROD_DATABASE_URL); const driver = await graphDriver(process.env.PROD_NEO4J_URL, "prodtest1");
  try {
    await prod.query("UPDATE items SET body=$1, content_sha256=$2, updated_at=now() WHERE id=$3", [`team body ${version}`, createHash("sha256").update(`team-${version}`).digest("hex"), ITEMS.team]);
    await prod.query("UPDATE graph_episodes SET content_sha256=$1 WHERE source_id=$2 AND group_id=$3", [createHash("sha256").update(`team-${version}`).digest("hex"), ITEMS.team, GRAPH_GROUPS.team]);
    // The unit MIRRORS the item, through the owner module that does exactly that. Left stale, the
    // unit hash would drift from the item on every capture and the source↔restored comparison would
    // be comparing a fixture bug rather than the copy.
    await contextAction("mirror", "team");
    await seedGraph(driver, version);
  } finally { await prod.end(); await driver.close(); }
}

function apiKey(keyId, secret) { return { wire: `aios_${keyId}_${secret}`, hash: createHash("sha256").update(secret).digest("hex") }; }

/**
 * The GRAPH half of the version oracle, callable on its own.
 *
 * Everything the sanitation assertions check — names, typed values, excluded secrets — is identical
 * in v1…v6, so they cannot tell a restored graph from a stale one. The fixture stamps the capture
 * version into every RELATES_TO fact, and this states the oracle twice:
 *   ∀ every version-stamped fact present carries THIS version (catches a stale or unreplaced graph);
 *   ∃ the chunk/correction/group facts are present in their own groups (catches an empty or
 *     partially restored one).
 */
async function assertGraphVersion(session, expected) {
  const result = await session.run(`OPTIONAL MATCH ()-[r:RELATES_TO]->()
    RETURN collect(DISTINCT [r.fact, r.group_id]) AS facts`);
  const factPairs = result.records[0].get("facts").filter((pair) => typeof pair?.[0] === "string");
  const stale = factPairs.filter(([fact]) => / v\d+$/.test(fact) && !fact.endsWith(` ${expected}`));
  if (stale.length) throw new Error(`graph facts from another capture survived: ${stale.map(([fact, group]) => `${fact} (${group})`).join(", ")}`);
  const required = [
    [`team chunk zero ${expected}`, GRAPH_GROUPS.team],
    [`team chunk one ${expected}`, GRAPH_GROUPS.team],
    [`correction fact ${expected}`, GRAPH_GROUPS.team],
    [`external fact ${expected}`, GRAPH_GROUPS.external],
    [`private fact ${expected}`, GRAPH_GROUPS.private],
  ];
  const missing = required.filter(([fact, group]) => !factPairs.some(([f, g]) => f === fact && g === group));
  if (missing.length) throw new Error(`expected ${expected} graph facts are absent from their groups: ${missing.map(([fact, group]) => `${fact} (${group})`).join(", ")}`);
  return { facts: factPairs.length };
}

/** Graph-only version assertion — used to observe the PRIOR graph before an interruption. */
async function assertInstalledGraphVersion(expected) {
  const driver = await graphDriver(process.env.STAGING_NEO4J_URL, "stagingtest1");
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const { facts } = await assertGraphVersion(session, expected);
    return { status: "graph-version-asserted", expected, facts };
  } finally { await session.close(); await driver.close(); }
}

/**
 * The genuine first-import recovery oracle.  It names facts that exist only in the staging-owned
 * bootstrap capture, so a source install that merely failed before writing cannot satisfy it.
 */
async function assertBootstrapRestored() {
  const staging = await pgClient(process.env.STAGING_DATABASE_URL);
  const driver = await graphDriver(process.env.STAGING_NEO4J_URL, "stagingtest1");
  try {
    const baseline = await staging.query("SELECT name FROM teams WHERE slug='baseline'");
    const candidate = await staging.query("SELECT body FROM items WHERE id=$1", [ITEMS.team]);
    if (baseline.rows[0]?.name !== "Baseline" || candidate.rows.length !== 0) {
      throw new Error("bootstrap Postgres checkpoint was not restored after the first-import failure");
    }
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const graph = await session.run("MATCH (e:Episodic {uuid:'baseline-ep', group_id:'baseline'}) RETURN e.name AS name");
      if (graph.records[0]?.get("name") !== "items:baseline") throw new Error("bootstrap Neo4j checkpoint was not restored after the first-import failure");
    } finally { await session.close(); }
    const response = await fetch(new URL("/api/health", process.env.STAGING_APP_ORIGIN), {
      headers: { "x-aios-staging-health-token": process.env.STAGING_HEALTH_TOKEN }, signal: AbortSignal.timeout(60_000),
    });
    const health = await response.json();
    if (!response.ok || health.ok !== true || health.mode !== "copy-ready" || !String(health.refreshRunId ?? "").startsWith("bootstrap-")) {
      throw new Error("bootstrap deployment did not return to serving readiness after the first-import failure");
    }
    return { status: "bootstrap-pair-restored", refreshRunId: health.refreshRunId };
  } finally { await staging.end(); await driver.close(); }
}
async function assertInstalled(expected = "v1") {
  const staging = await pgClient(process.env.STAGING_DATABASE_URL); const driver = await graphDriver(process.env.STAGING_NEO4J_URL, "stagingtest1");
  try {
    const password = await staging.query("SELECT password_hash FROM auth_users WHERE id=$1", [AUTH_INTERNAL]);
    if (!password.rows[0]?.password_hash || password.rows[0].password_hash === "production-password-hash") throw new Error("staging tester password was not safely reapplied");
    const forbidden = await staging.query("SELECT (SELECT count(*) FROM social_jobs)+(SELECT count(*) FROM integrations)+(SELECT count(*) FROM api_keys) AS n");
    if (Number(forbidden.rows[0].n) !== 0) throw new Error("credentials or outbound queues survived sanitation");
    const pending = await staging.query("SELECT count(*) AS n FROM graph_episodes WHERE pending_delete_group_id IS NOT NULL OR pending_delete_at IS NOT NULL");
    if (Number(pending.rows[0].n) !== 0) throw new Error("sanitized old-group cleanup metadata was not cleared with the removed graph content");
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    const graph = await session.run(`MATCH (e:Episodic)
      OPTIONAL MATCH ()-[r:RELATES_TO]->()
      RETURN collect(DISTINCT e.name) AS names, collect(DISTINCT [r.fact, r.group_id]) AS facts`);
    const names = graph.records[0].get("names");
    const factPairs = graph.records[0].get("facts").filter((pair) => typeof pair?.[0] === "string");
    const facts = factPairs.map(([fact]) => fact);
    if (facts.includes("narrowed source secret") || facts.includes("mixed provenance secret") || facts.includes("stale old-group secret")) throw new Error("unsafe narrowed, stale, or mixed graph data survived sanitation");
    if (!names.includes(`items:${ITEMS.team}#0`) || !names.includes(`items:${ITEMS.team}#1`) || !names.includes("correction:arc-1")) throw new Error("chunk or correction episodes were lost");
    const big = await session.run("MATCH (n:Entity {uuid:'a-ep-team-0'}) RETURN n.big AS big, n.summary AS summary");
    if (big.records[0].get("big").toString() !== "9007199254740993" || big.records[0].get("summary") != null) throw new Error("typed graph value or derived-cache sanitation failed");

    // THE GRAPH IS PART OF THE VERSION ORACLE, not just of the sanitation oracle: everything above
    // holds for a graph restored from ANY capture, so a refresh that replaced Postgres and left the
    // previous graph standing — exactly the fault the recovery scenarios inject — passed unchanged.
    await assertGraphVersion(session, expected);
    await session.close();

    // The Postgres half of the same oracle, now asked for v1 as well: the fixture seeds `team body
    // v1`, so there was never a reason to skip the first version.
    const row = await staging.query("SELECT body FROM items WHERE id=$1", [ITEMS.team]);
    if (row.rows[0]?.body !== `team body ${expected}`) throw new Error(`expected ${expected} pair is not installed`);
    const internal = apiKey("internal01", "internal-secret-012345678901234567890123");
    const external = apiKey("external01", "external-secret-012345678901234567890123");
    await staging.query("INSERT INTO api_keys(team_id,member_id,key_id,key_hash,name) VALUES($1,$2,'internal01',$3,'harness'),($1,$4,'external01',$5,'harness') ON CONFLICT(key_id) DO UPDATE SET key_hash=excluded.key_hash, revoked_at=null", [TEAM, INTERNAL, internal.hash, EXTERNAL, external.hash]);
    const request = async (key) => {
      const response = await fetch(new URL("/api/v1/items", process.env.STAGING_APP_ORIGIN), { headers: { authorization: `Bearer ${key}`, "x-aios-team": "paired-test" }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(`application oracle request failed (${response.status})`);
      return body;
    };
    const internalItems = assertCopiedItems("copied read as the internal tester", await request(internal.wire), {
      [ITEMS.external]: "external", [ITEMS.team]: "team", [ITEMS.private]: "team", [ITEMS.deferred]: "team",
    });
    const externalItems = assertCopiedItems("copied read as the external tester", await request(external.wire), { [ITEMS.external]: "external" });
    const spy = await fetch(new URL("/count", process.env.STAGING_NETWORK_SPY_URL), { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
    if (spy.requests !== 0) throw new Error(`copied staging emitted ${spy.requests} forbidden extraction/provider request(s)`);
    await staging.query("DELETE FROM api_keys WHERE name='harness'");
    return { status: "asserted", expected, internalItems: internalItems.ids.length, externalItems: externalItems.ids.length, graphEpisodes: names.length };
  } finally { await staging.end(); await driver.close(); }
}

/**
 * The graph oracle's own negative control: rewrite ONLY the installed staging graph's fact versions
 * and leave Postgres alone. `assert` must then refuse. Without this, a version oracle that reads the
 * graph but compares nothing would look identical to one that does — the assertion above is exactly
 * the kind that passes for free until something proves it can fail.
 */
async function corruptGraphVersion(version) {
  const driver = await graphDriver(process.env.STAGING_NEO4J_URL, "stagingtest1");
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.run(
      `MATCH ()-[r:RELATES_TO]->() WHERE r.fact =~ '.* v[0-9]+$'
       WITH r, split(r.fact, ' ') AS parts
       SET r.fact = reduce(s = '', i IN range(0, size(parts) - 2) | s + parts[i] + ' ') + $version
       RETURN count(r) AS rewritten`,
      { version },
    );
    const rewritten = Number(result.records[0]?.get("rewritten") ?? 0);
    if (rewritten === 0) throw new Error("no version-stamped graph facts were found to corrupt; the negative control would prove nothing");
    return { status: "graph-version-corrupted", version, rewritten };
  } finally { await session.close(); await driver.close(); }
}

async function killReaderLock() {
  const staging = await pgClient(process.env.STAGING_DATABASE_URL);
  try {
    const result = await staging.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks
      WHERE locktype='advisory' AND classid=$1::integer::oid AND objid=$2::integer::oid
        AND mode='ShareLock' AND granted AND pid <> pg_backend_pid()`, [0x41494f53, 0x53544732]);
    if (!result.rows.some((row) => row.terminated === true)) throw new Error("no live startup-fence shared lock was found");
    return { status: "reader-lock-terminated", sessions: result.rows.length };
  } finally { await staging.end(); }
}

/**
 * The SOURCE-side application oracle, run before anything is exported.
 *
 * Invoked as a separate process because it needs the app's own runtime conditions
 * (`--conditions react-server`) and `DATABASE_URL` pointed at the SOURCE database — the same way
 * the importer runs `reapply-testers.ts`. It calls the REAL `GET /api/v1/items` handler with real
 * API-key authentication, which is the only thing that can answer what the handler's visibility
 * predicate does; a SQL count cannot, and that is exactly how a seed with no context memberships
 * shipped a green harness while predicting `internal=0, external=0`.
 */
async function assertSourceVisibility() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("npx", ["tsx", "--conditions", "react-server", "scripts/staging-ops/source-read-oracle.ts", "--run"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.PROD_DATABASE_URL },
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  return JSON.parse(line ?? "{}");
}

export function filteredIds(ids) {
  const named = []; let unknown = 0;
  for (const id of ids) {
    if (DIAGNOSTIC_ID_ALLOWLIST.has(id)) named.push(id); else unknown += 1;
  }
  return { named: [...new Set(named)].sort(), unknown };
}

export function assertFixtureIds(label, actual, expected) {
  const actualSet = new Set(actual); const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id));
  const extra = [...actualSet].filter((id) => !expectedSet.has(id));
  const duplicates = actual.length - actualSet.size;
  if (!missing.length && !extra.length && duplicates === 0) return;
  throw new Error(`${label} returned the wrong exact ID set: ${JSON.stringify({ expected: expected.length, actual: actual.length, duplicates, missing: filteredIds(missing), extra: filteredIds(extra) })}`);
}

/** Apply the copied-side exact ID, access, and no-pagination contract to a decoded GET response. */
export function assertCopiedItems(label, body, expectedAccess) {
  if ((body.next_cursor ?? null) !== null) throw new Error(`${label} returned a further page; exact IDs would cover only page one`);
  const items = body.items ?? [];
  const ids = items.map((item) => item.id);
  assertFixtureIds(label, ids, Object.keys(expectedAccess));
  const actualAccess = Object.fromEntries(items.map((item) => [item.id, item.access]));
  for (const [id, access] of Object.entries(expectedAccess)) {
    if (actualAccess[id] !== access) throw new Error(`${label}: an allowlisted fixture item had access ${String(actualAccess[id])}, expected ${access}`);
  }
  return { ids, access: actualAccess };
}

const canonicalRows = (rows) => rows.map((row) => JSON.stringify(row)).sort();

/** Identity + security fields for one side's context substrate, READ-ONLY, with plain SQL. */
async function substrateOf(url) {
  const client = await pgClient(url);
  try {
    const units = await client.query(
      `SELECT id, source_item_id, unit_kind, unit_key, state, audience, content_sha256
         FROM project_context_units WHERE team_id=$1 ORDER BY id`, [TEAM]);
    const memberships = await client.query(
      `SELECT m.id, m.context_unit_id, m.project_id, u.source_item_id, m.decision, m.mode, m.method,
              (m.valid_to IS NULL) AS current
         FROM project_context_memberships m JOIN project_context_units u ON u.id = m.context_unit_id AND u.team_id = m.team_id
        WHERE m.team_id=$1 ORDER BY m.id`, [TEAM]);
    const grants = await client.query("SELECT project_id, group_id FROM project_groups WHERE team_id=$1 ORDER BY project_id, group_id", [TEAM]);
    const groups = await client.query("SELECT group_id, member_id FROM group_members WHERE team_id=$1 ORDER BY group_id, member_id", [TEAM]);
    return {
      // The archive restores supplied UUIDs; compare row IDs and the membership→unit link as well as
      // the item/project identity and access state. Both current and closed history are included.
      units: units.rows,
      memberships: memberships.rows,
      grants: grants.rows,
      groupMembers: groups.rows,
    };
  } finally { await client.end(); }
}

/**
 * SOURCE vs RESTORED, before any repair.
 *
 * The restore/ready receipts say the bytes arrived; they say nothing about the substrate the app
 * reads through. If the source reads pass and the copied reads do not, THIS is the diagnostic that
 * separates a sanitizer/restore defect from a fixture one — which is why it must run before anything
 * touches staging's substrate.
 */
export function compareSubstrateSnapshots(source, restored) {
  const differences = [];
  for (const field of ["units", "memberships", "grants", "groupMembers"]) {
    const before = new Set(canonicalRows(source[field]));
    const after = new Set(canonicalRows(restored[field]));
    const missing = [...before].filter((value) => !after.has(value));
    const extra = [...after].filter((value) => !before.has(value));
    if (missing.length || extra.length) {
      const identityFields = field === "units" ? ["id", "source_item_id"]
        : field === "memberships" ? ["id", "context_unit_id", "project_id", "source_item_id"]
          : field === "grants" ? ["project_id", "group_id"] : ["group_id", "member_id"];
      const identities = (rows) => rows.flatMap((encoded) => {
        const row = JSON.parse(encoded);
        return identityFields.map((key) => row[key]).filter((value) => typeof value === "string");
      });
      differences.push({ field, missingRows: missing.length, extraRows: extra.length, missingIds: filteredIds(identities(missing)), extraIds: filteredIds(identities(extra)) });
    }
  }
  const summary = (side) => ({
    counts: { units: side.units.length, memberships: side.memberships.length, grants: side.grants.length, groupMembers: side.groupMembers.length },
    states: {
      units: { active: side.units.filter((row) => row.state === "active").length, retracted: side.units.filter((row) => row.state === "retracted").length },
      memberships: { current: side.memberships.filter((row) => row.current).length, closed: side.memberships.filter((row) => !row.current).length },
    },
    grants: {
      projectIds: filteredIds(side.grants.map((row) => row.project_id)),
      groupIds: filteredIds(side.grants.map((row) => row.group_id)),
    },
  });
  const sourceSummary = summary(source); const restoredSummary = summary(restored);
  if (sourceSummary.counts.units !== 4 || sourceSummary.counts.memberships !== 5 || sourceSummary.states.memberships.current !== 4 || sourceSummary.states.memberships.closed !== 1) {
    throw new Error(`the source substrate does not retain the expected close/reopen history: ${JSON.stringify({ stage: "substrate-compare", status: "invalid-source", source: sourceSummary })}`);
  }
  if (differences.length) throw new Error(`the copied context substrate differs from the source: ${JSON.stringify({ stage: "substrate-compare", status: "mismatch", source: sourceSummary, restored: restoredSummary, differences })}`);
  return {
    status: "substrate-preserved",
    units: source.units.length, memberships: source.memberships.length,
    currentMemberships: sourceSummary.states.memberships.current,
    closedMemberships: sourceSummary.states.memberships.closed,
    grants: source.grants.length, groupMembers: source.groupMembers.length,
  };
}

async function compareSubstrate() {
  const [source, restored] = await Promise.all([substrateOf(process.env.PROD_DATABASE_URL), substrateOf(process.env.STAGING_DATABASE_URL)]);
  return compareSubstrateSnapshots(source, restored);
}

async function runFixtureAction(action, arg) {
  return action === "seed" ? seed()
    : action === "assert-source" ? assertSourceVisibility()
      : action === "assert-bootstrap" ? assertBootstrapRestored()
      : action === "assert-reopened-substrate" ? assertReopenedSubstrate()
        : action === "compare-substrate" ? compareSubstrate()
          : action === "close-membership" ? contextAction("close", arg ?? "team")
            : action === "open-membership" ? contextAction("open", arg ?? "team")
              : action === "mutate" ? mutate(arg ?? "v2")
                : action === "assert" ? assertInstalled(arg ?? "v1")
                  : action === "assert-graph-version" ? assertInstalledGraphVersion(arg ?? "v1")
                    : action === "corrupt-graph-version" ? corruptGraphVersion(arg ?? "v99")
                      : action === "kill-reader-lock" ? killReaderLock()
                        : Promise.reject(new Error("fixture action must be seed, assert-source, assert-bootstrap, assert-reopened-substrate, compare-substrate, close-membership, open-membership, mutate, assert, assert-graph-version, corrupt-graph-version, or kill-reader-lock"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  const result = await runFixtureAction(action, process.argv[3]);
  console.log(JSON.stringify(result ?? { status: action }));
}
