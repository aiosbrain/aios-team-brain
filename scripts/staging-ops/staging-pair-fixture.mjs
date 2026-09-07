#!/usr/bin/env node
import { createHash } from "node:crypto";
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

async function pgClient(url) { const client = new pg.Client({ connectionString: url }); await client.connect(); return client; }
async function graphDriver(url, password) { const driver = neo4j.driver(url, neo4j.auth.basic("neo4j", password)); await driver.verifyConnectivity(); return driver; }

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
    await seedGraph(driver, version);
  } finally { await prod.end(); await driver.close(); }
}

function apiKey(keyId, secret) { return { wire: `aios_${keyId}_${secret}`, hash: createHash("sha256").update(secret).digest("hex") }; }
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
    const graph = await session.run("MATCH (e:Episodic) OPTIONAL MATCH ()-[r:RELATES_TO]->() RETURN collect(e.name) AS names, collect(r.fact) AS facts");
    const names = graph.records[0].get("names"); const facts = graph.records[0].get("facts");
    if (facts.includes("narrowed source secret") || facts.includes("mixed provenance secret") || facts.includes("stale old-group secret")) throw new Error("unsafe narrowed, stale, or mixed graph data survived sanitation");
    if (!names.includes(`items:${ITEMS.team}#0`) || !names.includes(`items:${ITEMS.team}#1`) || !names.includes("correction:arc-1")) throw new Error("chunk or correction episodes were lost");
    const big = await session.run("MATCH (n:Entity {uuid:'a-ep-team-0'}) RETURN n.big AS big, n.summary AS summary"); await session.close();
    if (big.records[0].get("big").toString() !== "9007199254740993" || big.records[0].get("summary") != null) throw new Error("typed graph value or derived-cache sanitation failed");
    if (expected !== "v1") {
      const row = await staging.query("SELECT body FROM items WHERE id=$1", [ITEMS.team]);
      if (row.rows[0]?.body !== `team body ${expected}`) throw new Error(`expected ${expected} pair is not installed`);
    }
    const internal = apiKey("internal01", "internal-secret-012345678901234567890123");
    const external = apiKey("external01", "external-secret-012345678901234567890123");
    await staging.query("INSERT INTO api_keys(team_id,member_id,key_id,key_hash,name) VALUES($1,$2,'internal01',$3,'harness'),($1,$4,'external01',$5,'harness') ON CONFLICT(key_id) DO UPDATE SET key_hash=excluded.key_hash, revoked_at=null", [TEAM, INTERNAL, internal.hash, EXTERNAL, external.hash]);
    const request = async (key) => {
      const response = await fetch(new URL("/api/v1/items", process.env.STAGING_APP_ORIGIN), { headers: { authorization: `Bearer ${key}`, "x-aios-team": "paired-test" }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json(); if (!response.ok) throw new Error(`application oracle request failed (${response.status})`); return body.items;
    };
    const internalItems = await request(internal.wire); const externalItems = await request(external.wire);
    if (internalItems.length !== 4 || externalItems.length !== 1 || externalItems[0]?.access !== "external") throw new Error("real application oracle widened or narrowed copied-tier reads");
    const spy = await fetch(new URL("/count", process.env.STAGING_NETWORK_SPY_URL), { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
    if (spy.requests !== 0) throw new Error(`copied staging emitted ${spy.requests} forbidden extraction/provider request(s)`);
    await staging.query("DELETE FROM api_keys WHERE name='harness'");
    return { status: "asserted", expected, internalItems: internalItems.length, externalItems: externalItems.length, graphEpisodes: names.length };
  } finally { await staging.end(); await driver.close(); }
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

const action = process.argv[2];
const result = action === "seed" ? await seed() : action === "mutate" ? await mutate(process.argv[3] ?? "v2") : action === "assert" ? await assertInstalled(process.argv[3] ?? "v1") : action === "kill-reader-lock" ? await killReaderLock() : (() => { throw new Error("fixture action must be seed, mutate, assert, or kill-reader-lock"); })();
console.log(JSON.stringify(result ?? { status: action }));
