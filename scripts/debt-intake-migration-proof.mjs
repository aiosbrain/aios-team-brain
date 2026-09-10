/** Test-only AIO-1101 migration proof. Uses ONLY this worktree's dm-isolated Docker server.
 * Run: node --import tsx --conditions react-server scripts/debt-intake-migration-proof.mjs
 * Creates/drops separate scratch databases, never the runner's app_test database.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { loadSchema } from './pg-load-schema.mjs';
import { fingerprint, diffFingerprints } from './schema-fingerprint.mjs';

const root = process.cwd();
const base = 'bdd8743898a862deb8dae91159556d5fd2325c9e';
const hash = createHash('sha1').update(root + '\n').digest('hex').slice(0,8);
const container = `aios-dm-${hash}`;
const inspect = JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
assert.equal(inspect.Config.Image,'postgres:16');
assert.equal(inspect.State.Running,true);
const port = inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort;
assert.match(port,/^\d+$/);
const server = `postgres://app:app@127.0.0.1:${port}`;
const admin = new Client({connectionString:server+'/postgres'});
const created=[];
const clients=[];
let productionPool;
const tables=['teams','members','codebases','code_metrics'];
const debtTables=['codebase_debt_candidates','codebase_debt_candidate_codebases','codebase_debt_candidate_events'];
const git = (...args) => execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
const oldRead = file => git('show',`${base}:${path.relative(root,file)}`);
const oldMigrations = git('ls-tree','-r','--name-only',base,'postgres/migrations').trim().split('\n').filter(f=>f.endsWith('.sql')).map(f=>path.basename(f));
const quiet={log(){}};
async function scratch(label){
  const name=`intake_proof_${label}_${randomBytes(6).toString('hex')}`;
  await admin.query(`create database "${name}"`); created.push(name);
  const client=new Client({connectionString:server+'/'+name}); await client.connect(); clients.push(client);
  return {client,url:server+'/'+name};
}
async function load(db, prior=false){
  // The production loader decides schema-first and lexical migration ordering. The historical
  // adapter only supplies immutable bdd874 bytes through its supported filesystem seam.
  await loadSchema({cwd:root,databaseUrl:db.url,env:{},logger:quiet,
    ...(prior ? {readFile:oldRead,exists:()=>true,readDir:()=>oldMigrations} : {})});
}
async function snapshot(client,names=tables){
  const out={};
  for(const table of names) out[table]=(await client.query(`select row_to_json(t)::text as bytes from ${table} t order by row_to_json(t)::text`)).rows.map(r=>r.bytes);
  return out;
}
async function seed(client){
  const team=(await client.query("insert into teams(slug,name) values('migration-proof','Migration proof') returning id")).rows[0].id;
  const member=(await client.query("insert into members(team_id,email,display_name,actor_handle,status) values($1,'proof@example.invalid','Proof','proof','active') returning id",[team])).rows[0].id;
  for(const slug of ['harness','devtools','workspace']) await client.query("insert into codebases(team_id,slug,full_name,languages,stars) values($1,$2,$3,'{\"TypeScript\":321}',7)",[team,slug,`proof/${slug}`]);
  await client.query("insert into code_metrics(team_id,codebase_id,head_sha,loc,files,test_coverage_pct,test_coverage_lines_total,test_coverage_lines_covered,recent_commits) select $1,id,$2,321,7,50,100,50,'[]' from codebases where team_id=$1 and slug='harness'",[team,'a'.repeat(40)]);
  return {team,member};
}
function sameCatalog(expected,actual,label){
  const diff=diffFingerprints(expected,actual); assert.equal(diff.text,'',`${label}:\n${diff.text}`);
}
async function constraints(client){
  const mandatory=['team_id','event_id','record','canonical_record','record_type','producer_name','producer_run_id'];
  const columns=(await client.query("select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name='codebase_debt_candidate_events'")).rows;
  for(const column of mandatory) assert.equal(columns.find(c=>c.column_name===column)?.is_nullable,'NO',column);
  const fks=(await client.query("select confrelid::regclass::text as target,confdeltype,pg_get_constraintdef(oid) as def from pg_constraint where conrelid='codebase_debt_candidate_events'::regclass and contype='f'")).rows;
  assert(fks.some(f=>f.target==='teams' && f.confdeltype==='r' && f.def.includes('FOREIGN KEY (team_id)')),'direct team RESTRICT FK');
  assert(fks.some(f=>f.target==='codebase_debt_candidates' && f.confdeltype==='r' && f.def.includes('(team_id, candidate_id)')),'composite candidate RESTRICT FK');
}
try{
  await admin.connect();
  const fresh=await scratch('fresh'); await load(fresh); const expected=await fingerprint(fresh.client); await constraints(fresh.client);
  const mirror=await scratch('mirror'); await mirror.client.query(readFileSync(path.join(root,'postgres/schema.sql'),'utf8'));
  const intakeCatalog = lines => lines.filter(line => /codebase_debt_|protect_debt_intake_evidence/.test(line));
  sameCatalog(intakeCatalog(expected),intakeCatalog(await fingerprint(mirror.client)),'intake schema-only mirror');
  const upgrade=await scratch('upgrade'); await load(upgrade,true); await seed(upgrade.client); const before=await snapshot(upgrade.client);
  assert.equal((await upgrade.client.query("select to_regclass('codebase_debt_candidate_events') as t")).rows[0].t,null);
  // This also makes a missing or drifted migration observable, independently of schema.sql.
  const delta=await scratch('delta'); await load(delta,true); await seed(delta.client); const deltaBefore=await snapshot(delta.client);
  await delta.client.query(readFileSync(path.join(root,'postgres/migrations/20260910083000_debt_intake_ledger.sql'),'utf8'));
  sameCatalog(expected,await fingerprint(delta.client),'prior base + intake migration alone');
  assert.deepEqual(await snapshot(delta.client),deltaBefore,'migration alone changed original rows');
  await load(upgrade);
  assert.deepEqual(await snapshot(upgrade.client),before,'upgrade changed original scanner/member rows');
  sameCatalog(expected,await fingerprint(upgrade.client),'populated prior-base actual loader upgrade'); await constraints(upgrade.client);
  for(const table of debtTables) assert.equal((await upgrade.client.query(`select count(*)::integer as n from ${table}`)).rows[0].n,0);
  const replay=await scratch('replay'); await load(replay); const ids=await seed(replay.client);
  const group=(await replay.client.query("insert into groups(team_id,slug,name,is_builtin) values($1,'everyone','Everyone',true) on conflict(team_id,slug) do update set is_builtin=true returning id",[ids.team])).rows[0].id;
  await replay.client.query('insert into group_members(team_id,group_id,member_id) values($1,$2,$3) on conflict do nothing',[ids.team,group,ids.member]);
  const key=(await replay.client.query("insert into api_keys(team_id,member_id,key_id,key_hash,name) values($1,$2,'migration-proof-key','test-only-not-an-upload-secret','Proof') returning id",[ids.team,ids.member])).rows[0].id;
  process.env.DATABASE_URL=replay.url; process.env.DB_BACKEND='postgres'; delete process.env.PGSSL; delete process.env.PGSSLMODE;
  const {ingestDebtIntake}=await import('../lib/codebases/debt-intake.ts');
  const {getPool}=await import('../lib/db/pg/pool.ts'); productionPool=getPool();
  const registry=JSON.parse(readFileSync(path.join(root,'test/fixtures/contract/debt-intake/trusted-config.json'),'utf8')); registry.uploaders={[key]:registry.producers};
  const records=readFileSync(path.join(root,'test/fixtures/contract/debt-intake/complete-lifecycle.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const auth={teamId:ids.team,memberId:ids.member,apiKeyId:key,memberTier:'team',memberRole:'member',actorHandle:'proof',displayName:'Proof',email:'proof@example.invalid'};
  assert.equal((await ingestDebtIntake(auth,'harness',records,registry)).status,201);
  const retained=await snapshot(replay.client,[...tables,...debtTables,'audit_log']);
  await load(replay); await load(replay);
  assert.deepEqual(await snapshot(replay.client,[...tables,...debtTables,'audit_log']),retained,'loader replay changed retained evidence');
  sameCatalog(expected,await fingerprint(replay.client),'accepted-ledger loader replay');
  assert.equal((await ingestDebtIntake(auth,'harness',records,registry)).status,200);
  console.log(JSON.stringify({status:'passed',container,base,checks:['fresh loader','intake schema mirror','populated prior-base migration alone','populated prior-base actual loader','byte-equivalent scanner/member preservation','FK/nullability catalog','production intake accepted','accepted ledger double loader replay','production intake replay'],scratchDatabases:created.length}));
} finally {
  if(productionPool) await productionPool.end();
  for(const client of clients) await client.end();
  for(const name of created) await admin.query(`drop database "${name}"`);
  await admin.end();
}
