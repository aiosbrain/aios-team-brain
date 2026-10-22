import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import neo4j from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../scripts/pg-load-schema.mjs";
import { capturePairedPostgres, restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";
import { exportGraph, sanitizeGraphExport } from "../scripts/staging-ops/graph-bundle.mjs";
import { packPair, unpackPair } from "../scripts/staging-ops/bundle-format.mjs";
import { createSignedEncryptedBundle, openSignedEncryptedBundle } from "../scripts/staging-ops/bundle-crypto.mjs";
import { acquireDataUseLock, installStagingOps } from "../scripts/staging-ops/journal.mjs";
import { replaceNeo4jGraph } from "../scripts/staging-ops/neo4j-replace.mjs";

const required = process.env.STAGING_PAIR_REQUIRED === "1";
const suite = required ? describe : describe.skip;
// The required CI lane is the non-skipping role harness in scripts/staging-pair-isolated.sh.
// This lower-level privileged-controller test remains available for focused local diagnosis.

suite("real paired Postgres/Neo4j refresh", () => {
  const prodUrl = process.env.PROD_DATABASE_URL!; const stagingUrl = process.env.STAGING_DATABASE_URL!;
  let prod: pg.Client; let staging: pg.Client; let prodDriver: neo4j.Driver; let stagingDriver: neo4j.Driver;
  const temp = mkdtempSync(path.join(os.tmpdir(), "staging-pair-real-"));

  beforeAll(async () => {
    await loadSchema({ databaseUrl: prodUrl }); await loadSchema({ databaseUrl: stagingUrl });
    prod = new pg.Client({ connectionString: prodUrl }); staging = new pg.Client({ connectionString: stagingUrl }); await prod.connect(); await staging.connect();
    await installStagingOps(staging);
    prodDriver = neo4j.driver(process.env.PROD_NEO4J_URL!, neo4j.auth.basic("neo4j", "prodtest1"));
    stagingDriver = neo4j.driver(process.env.STAGING_NEO4J_URL!, neo4j.auth.basic("neo4j", "stagingtest1"));
  }, 180_000);
  afterAll(async () => { await prod?.end(); await staging?.end(); await prodDriver?.close(); await stagingDriver?.close(); rmSync(temp, { recursive: true, force: true }); });

  it("exports, sanitizes, authenticates, installs and serves tier-isolated typed data with no extraction", async () => {
    const team = "11111111-1111-4111-8111-111111111111";
    await prod.query("INSERT INTO auth_users(id,email,password_hash) VALUES($1,'tester@example.test','production-password-hash')", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    await prod.query("INSERT INTO teams(id,slug,name) VALUES($1,'paired-test','Paired Test')", [team]);
    const accesses = ["external", "team", "private"];
    for (let i = 0; i < accesses.length; i++) {
      const project = `22222222-2222-4222-8222-22222222222${i}`; const item = `33333333-3333-4333-8333-33333333333${i}`; const group = `paired_${accesses[i]}`;
      await prod.query("INSERT INTO projects(id,team_id,slug,name,graph_group_id) VALUES($1,$2,$3,$3,$4)", [project, team, `p-${i}`, group]);
      await prod.query("INSERT INTO items(id,team_id,project_id,path,kind,access,body,content_sha256,actor) VALUES($1,$2,$3,$4,'document',$5,$6,$7,'fixture')", [item, team, project, `${accesses[i]}.md`, accesses[i], `${accesses[i]} body`, `${i}`.repeat(64)]);
      await prod.query("INSERT INTO graph_episodes(team_id,source_table,source_id,group_id,content_sha256,episode_uuid) VALUES($1,'items',$2,$3,$4,$5)", [team, item, group, `${i}`.repeat(64), `episode-${i}`]);
    }
    await prod.query("INSERT INTO social_jobs(team_id,kind,payload) VALUES($1,'publish','{}')", [team]);

    const source = prodDriver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      for (let i = 0; i < accesses.length; i++) await source.run(`
        CREATE (ep:Episodic {uuid:$ep,name:$name,group_id:$group,created_at:datetime('2026-09-01T00:00:00Z')})
        CREATE (a:Entity {uuid:$a,name:$access,group_id:$group,big:toInteger('9007199254740993'),embedding:[0.1,0.2],summary:'derived'})
        CREATE (b:Entity {uuid:$b,name:'target',group_id:$group})
        CREATE (ep)-[:MENTIONS]->(a)
        CREATE (a)-[:RELATES_TO {uuid:$fact,fact:$text,group_id:$group,episodes:[$ep]}]->(b)`, {
        ep: `episode-${i}`, name: `items:33333333-3333-4333-8333-33333333333${i}`, group: `paired_${accesses[i]}`, a: `entity-a-${i}`, b: `entity-b-${i}`, access: accesses[i], fact: `fact-${i}`, text: `${accesses[i]} fact`,
      });
    } finally { await source.close(); }

    const rawSession = prodDriver.session({ defaultAccessMode: neo4j.session.READ });
    const raw = await exportGraph(rawSession); await rawSession.close();
    const graph = sanitizeGraphExport(raw, { episodeAllowed: () => true });
    await capturePairedPostgres({ client: prod, databaseUrl: prodUrl, directory: temp });
    const packed = await packPair(temp, graph);
    const signing = generateKeyPairSync("ed25519"); const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sealed = createSignedEncryptedBundle({ payload: packed.payload, manifest: { runId: "real-pair", checksums: packed.checksums }, exporterSigningPrivateKey: signing.privateKey, importerEncryptionPublicKey: encryption.publicKey });
    const opened = openSignedEncryptedBundle({ bundle: sealed, exporterSigningPublicKey: signing.publicKey, importerEncryptionPrivateKey: encryption.privateKey });
    const importedGraph = await unpackPair(opened.payload, temp, opened.manifest.checksums);

    expect(await acquireDataUseLock(staging, "exclusive")).toBe(true);
    await restorePairedPostgres({ client: staging, databaseUrl: stagingUrl, directory: temp });
    const target = stagingDriver.session({ defaultAccessMode: neo4j.session.WRITE });
    await replaceNeo4jGraph({ session: target, graph: importedGraph, facts: { pinnedEnvironmentId: "stg", actualEnvironmentId: "stg", tokenEnvironmentId: "stg", neo4jHost: "staging-neo4j.railway.internal", pinnedNeo4jService: "staging-neo4j", pinnedDatabase: "neo4j", database: "neo4j", targetCredentialFingerprint: "staging", sourceCredentialFingerprint: "production", electionLockHeld: true, exclusiveDataLockHeld: true, pinnedAppServiceId: "app", pinnedGraphitiServiceId: "graphiti", stopMeasurement: { stopped: true, environmentId: "stg", services: ["app", "graphiti"], observedDeploymentIds: ["app-1", "graph-1"] } } });
    await target.close();

    expect((await staging.query("SELECT password_hash FROM auth_users WHERE email='tester@example.test'")).rows[0].password_hash).toBeNull();
    expect(Number((await staging.query("SELECT count(*) FROM social_jobs")).rows[0].count)).toBe(0);
    const read = stagingDriver.session({ defaultAccessMode: neo4j.session.READ });
    const teamFacts = await read.run("MATCH ()-[r:RELATES_TO]->() WHERE r.group_id IN $groups RETURN r.fact AS fact", { groups: ["paired_team"] });
    expect(teamFacts.records.map((r) => r.get("fact"))).toEqual(["team fact"]);
    const big = await read.run("MATCH (n:Entity {uuid:'entity-a-1'}) RETURN n.big AS big, n.summary AS summary"); await read.close();
    expect(big.records[0].get("big").toString()).toBe("9007199254740993");
    expect(big.records[0].get("summary")).toBeNull();
  }, 240_000);
});
