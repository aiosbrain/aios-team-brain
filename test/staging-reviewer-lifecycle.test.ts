import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireJournalLock, openJournal, openReviewerJournal, readJournal, readReviewerJournal } from '../scripts/staging-ops/commissioning-journal.mjs';
import { cancelAndFinalize, collectApp, collectSelf, dispatch, fixedFetchTransport, openSession, stage } from '../scripts/staging-ops/reviewer-negative-probe-operator.mjs';
import { assessEvidence } from '../scripts/staging-ops/policy-commissioning.mjs';
import { JOHN, authoritativeBundle, canonical, diagnosticResult, digest, exactAppPermissions, retain } from '../scripts/staging-ops/reviewer-negative-probe.mjs';

const root=path.join(__dirname,'..');const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const artifact=(dir:string,name:string,value:unknown)=>{writeFileSync(path.join(dir,name),`${JSON.stringify(value)}\n`,{mode:0o600});};
const fake=()=>{const calls:Array<[string,string,unknown]>=[];let dispatchCount=0;const cancelled=new Set<number>();
 const original={id:900,run_attempt:1,status:'in_progress',conclusion:null,head_sha:source,path:'.github/workflows/release-policy-commissioning.yml',actor:{id:12345,login:'commissioning-bot',type:'Bot'},repository:{id:1268462466,full_name:'aiosbrain/aios-team-brain'}};
 const probe=(runId=901)=>({id:runId,workflow_id:13,run_attempt:1,status:cancelled.has(runId)?'completed':'waiting',conclusion:cancelled.has(runId)?'cancelled':null,head_sha:source,head_branch:'staging',path:'.github/workflows/release-reviewer-negative-probe.yml',event:'workflow_dispatch',created_at:'2026-09-26T09:00:00Z',updated_at:'2026-09-26T09:00:01Z',repository:{id:1268462466,full_name:'aiosbrain/aios-team-brain'},actor:{id:5806135,login:'johnellison',type:'User'},triggering_actor:{id:5806135,login:'johnellison',type:'User'}});
 const environment=(name:string)=>({id:name==='staging-release'?11:12,name,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{id:5806135,login:'johnellison',type:'User'}}]},{type:'branch_policy'}]});
 const jobs=(runId=901)=>['staging-release','staging-emergency'].map((name,n)=>({id:101+(runId-901)*2+n,run_id:runId,head_sha:source,name:n?'probe-emergency':'probe-release',status:cancelled.has(runId)?'completed':'waiting',conclusion:cancelled.has(runId)?'cancelled':null,steps:[],runner_id:null,runner_name:null}));
 const transport=async(method:string,target:string,body:unknown)=>{calls.push([method,target,body]);let status=200,bodyValue:unknown={};if(method==='POST'){status=204;bodyValue=null;if(target.endsWith('/dispatches'))dispatchCount++;else if(target.endsWith('/cancel'))cancelled.add(Number(target.match(/runs\/(\d+)\/cancel$/)?.[1]));else throw new Error(`unexpected write ${target}`);}
 else if(target==='/repos/aiosbrain/aios-team-brain')bodyValue={id:1268462466,full_name:'aiosbrain/aios-team-brain',default_branch:'staging'};
 else if(target.endsWith('/git/ref/heads/staging'))bodyValue={object:{sha:source}};
 else if(target.endsWith('/actions/runs/900'))bodyValue=original;
 else if(target.endsWith('/actions/runs/900/pending_deployments'))bodyValue=[{environment:{id:11,name:'staging-release'},current_user_can_approve:false},{environment:{id:12,name:'staging-emergency'},current_user_can_approve:false}];
 else if(target.endsWith('/actions/runs/900/approvals'))bodyValue=[];
 else if(target.endsWith('/actions/workflows/release-reviewer-negative-probe.yml'))bodyValue={id:13,path:'.github/workflows/release-reviewer-negative-probe.yml',name:'PC-06 reviewer negative probe',state:'active'};
 else if(target.includes('/actions/workflows/13/runs?'))bodyValue={total_count:dispatchCount,workflow_runs:Array.from({length:dispatchCount},(_,n)=>probe(901+n))};
 else if(/\/actions\/runs\/90[12](?:\/attempts\/1)?$/.test(target))bodyValue=probe(Number(target.match(/runs\/(\d+)/)?.[1]));
 else if(/\/actions\/runs\/90[12]\/attempts\/1\/jobs\?/.test(target))bodyValue={total_count:2,jobs:jobs(Number(target.match(/runs\/(\d+)/)?.[1]))};
 else if(/\/actions\/runs\/90[12]\/pending_deployments$/.test(target))bodyValue=cancelled.has(Number(target.match(/runs\/(\d+)/)?.[1]))?[]:[{environment:{id:11,name:'staging-release'},current_user_can_approve:false},{environment:{id:12,name:'staging-emergency'},current_user_can_approve:false}];
 else if(/\/actions\/runs\/90[12]\/approvals$/.test(target))bodyValue=[];
 else if(target.includes('/deployment-branch-policies?'))bodyValue={total_count:1,branch_policies:[{name:'staging',type:'branch'}]};
 else if(target.includes('/environments/'))bodyValue=environment(target.endsWith('staging-release')?'staging-release':'staging-emergency');
 else throw new Error(`unexpected fixture path ${target}`);
 return {complete:true,status,body:bodyValue,raw_text:status===204?'':JSON.stringify(bodyValue)};};return {calls,transport};};
async function setup(){const dir=mkdtempSync(path.join(tmpdir(),'reviewer-stage-'));chmodSync(dir,0o700);dirs.push(dir);artifact(dir,'commissioning-900-1-intent.json',{schema_version:1,repository:'aiosbrain/aios-team-brain',repository_id:1268462466,run_id:'900',attempt:'1',workflow_path:'.github/workflows/release-policy-commissioning.yml',workflow_sha:source});const controls:Record<string,Record<string,unknown>>={};for(const name of ['staging-release','staging-emergency']){const environment_id=name==='staging-release'?11:12;for(const [control,measured,sourceKind] of [
 ['required_reviewer_is_owner',{reviewer_login:'johnellison',reviewer_id:5806135,reviewer_type:'User'},'provider-api'],
 ['prevent_self_review_enabled',{prevent_self_review:true},'provider-api'],
 ['branch_policy_limits_to_staging',{protected_branches:false,custom_branch_policies:true,branches:['staging']},'provider-api'],
 ['administrators_cannot_bypass',{can_admins_bypass:false},'provider-ui']
] as const){const filename=`env-${control}-${name}.json`;artifact(dir,filename,{control,environment:name,environment_id,source:sourceKind,measured});const artifact_sha256=digest(readFileSync(path.join(dir,filename)));(controls[control]??={})[name]={status:'verified',environment_name:name,environment_id,source:sourceKind,expected:measured,measured,artifact:filename,artifact_sha256,measured_at:'2026-09-26T08:59:30.000Z'};}}artifact(dir,'commissioning-900-1-environment-controls.json',{schema_version:1,phase:'setup',run_id:'900',attempt:'1',controls});const lock=acquireJournalLock({dir,runId:'900',attempt:'1'});try{openJournal({dir,runId:'900',attempt:'1',lock,source,now:()=>new Date('2026-09-26T08:59:00.000Z')}).append('run-opened',{phase:'active'});}finally{lock.release();}const f=fake();const options={runId:'900',attempt:'1',dir,control:'self_review_refused',observer:f.transport,hooksProjection:async()=>({status:200,entries:[]})};return {dir,f,options};}
describe('reviewer staged one-shot lifecycle',()=>{
 it('refuses a competing process lock before writing the original link or immutable intent',async()=>{
  const {dir,options}=await setup();
  const moduleUrl=pathToFileURL(path.join(root,'scripts/staging-ops/commissioning-journal.mjs')).href;
  const holderCode=`import {acquireJournalLock} from ${JSON.stringify(moduleUrl)}; const lock=acquireJournalLock({dir:process.argv[1],runId:'900',attempt:'1',kind:'reviewer-self'}); process.send('locked'); process.on('message',()=>{lock.release();process.exit(27)});`;
  const holder=spawn(process.execPath,['--input-type=module','-e',holderCode,dir],{cwd:root,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';holder.stderr.on('data',chunk=>{stderr+=chunk;});
  const exit=new Promise<number|null>(resolve=>holder.once('exit',resolve));
  try{
   await new Promise<void>((resolve,reject)=>{holder.once('message',()=>resolve());holder.once('error',reject);holder.once('exit',code=>reject(new Error(`lock holder exited before ready: ${code} ${stderr}`)));});
   const originalBefore=readJournal({dir,runId:'900',attempt:'1'});
   await expect(stage(await openSession(options))).rejects.toThrow(/another commissioning writer holds/);
   expect(readJournal({dir,runId:'900',attempt:'1'})).toEqual(originalBefore);
   expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'})).toHaveLength(0);
   expect(existsSync(path.join(dir,'reviewer-900-1-self-intent.json'))).toBe(false);
   holder.send('release');expect(await exit).toBe(27);
   expect((await stage(await openSession(options))).status).toBe('staged');
   expect(readJournal({dir,runId:'900',attempt:'1'}).filter(x=>x.type==='reviewer-probe-linked')).toHaveLength(1);
  }finally{if(holder.exitCode===null)holder.kill();await exit;}
 },60000);
 it('refuses an App stage while another process owns the App reviewer lock',async()=>{
  const {dir,options}=await setup();
  const moduleUrl=pathToFileURL(path.join(root,'scripts/staging-ops/commissioning-journal.mjs')).href;
  const holderCode=`import {acquireJournalLock} from ${JSON.stringify(moduleUrl)}; const lock=acquireJournalLock({dir:process.argv[1],runId:'900',attempt:'1',kind:'reviewer-app'}); process.send('locked'); process.on('message',()=>{lock.release();process.exit(27)});`;
  const holder=spawn(process.execPath,['--input-type=module','-e',holderCode,dir],{cwd:root,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';holder.stderr.on('data',chunk=>{stderr+=chunk;});
  const exit=new Promise<number|null>(resolve=>holder.once('exit',resolve));
  try{
   await new Promise<void>((resolve,reject)=>{holder.once('message',()=>resolve());holder.once('error',reject);holder.once('exit',code=>reject(new Error(`lock holder exited before ready: ${code} ${stderr}`)));});
   const originalBefore=readJournal({dir,runId:'900',attempt:'1'});
   await expect(stage(await openSession({...options,control:'unauthorized_reviewer_refused'}))).rejects.toThrow(/another commissioning writer holds/);
   expect(readJournal({dir,runId:'900',attempt:'1'})).toEqual(originalBefore);
   expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app'})).toHaveLength(0);
   expect(existsSync(path.join(dir,'reviewer-900-1-app-intent.json'))).toBe(false);
   holder.send('release');expect(await exit).toBe(27);
  }finally{if(holder.exitCode===null)holder.kill();await exit;}
 },60000);
 it('links the original before one fixed dispatch and refuses a competing dispatch without a second POST',async()=>{const {dir,f,options}=await setup();const session=await openSession(options);const staged=await stage(session);expect(staged.status).toBe('staged');expect(assessEvidence({dir,runId:'900',attempt:'1'}).blockers.some(x=>x.gate==='PC-07'&&x.detail.includes('linked reviewer'))).toBe(true);expect(readJournal({dir,runId:'900',attempt:'1'}).filter(x=>x.type==='reviewer-probe-linked')).toHaveLength(1);expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}).map(x=>x.event)).toEqual(['intent-linked']);const first=await dispatch(await openSession(options));expect(first.status).toBe('dispatch-sent');expect(f.calls.filter(x=>x[0]==='POST')).toHaveLength(1);await expect(dispatch(await openSession(options))).rejects.toThrow(/already consumed/);expect(f.calls.filter(x=>x[0]==='POST')).toHaveLength(1);});
 it('consumes a dispatch with a lost response and never sends another',async()=>{const {dir,f,options}=await setup();await stage(await openSession(options));let writes=0;const lossy=async(method:string,target:string,body:unknown)=>{if(method==='POST'){writes++;return {complete:false,status:0};}return f.transport(method,target,body);};const result=await dispatch(await openSession({...options,observer:lossy}));expect(result.status).toBe('dispatch-response-lost');expect(writes).toBe(1);await expect(dispatch(await openSession({...options,observer:lossy}))).rejects.toThrow(/already consumed/);expect(writes).toBe(1);expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}).map(x=>x.event)).toEqual(['intent-linked','dispatch-used']);});
 it('blocks dispatch if a downstream hook is active',async()=>{const {dir,options}=await setup();await expect(stage(await openSession({...options,hooksProjection:async()=>({status:200,entries:[{id:'661488152',active:true,events:['*']}]})}))).rejects.toThrow(/trigger blocks dispatch/);expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'})).toHaveLength(0);});
 it('refuses original pending substitution before dispatch',async()=>{
  const {f,options}=await setup();await stage(await openSession(options));let writes=0;
  const drift=async(method:string,target:string,body:unknown)=>{const response=await f.transport(method,target,body);if(method==='POST')writes++;if(target.endsWith('/runs/900/pending_deployments')){response.body=[{environment:{id:77,name:'other'},current_user_can_approve:false},{environment:{id:88,name:'other2'},current_user_can_approve:false}];response.raw_text=JSON.stringify(response.body);}return response;};
  await expect(dispatch(await openSession({...options,observer:drift}))).rejects.toThrow(/original protected run/);expect(writes).toBe(0);
 });
 it('refuses policy drift before dispatch and original closure before a human slot',async()=>{
  const first=await setup();await stage(await openSession(first.options));let writes=0;
  const policyDrift=async(method:string,target:string,body:unknown)=>{const response=await first.f.transport(method,target,body);if(method==='POST')writes++;if(target.endsWith('/environments/staging-release')){response.body={...response.body,protection_rules:[{type:'branch_policy'}]};response.raw_text=JSON.stringify(response.body);}return response;};
  await expect(dispatch(await openSession({...first.options,observer:policyDrift}))).rejects.toThrow(/policy|reviewer|protection rules/);expect(writes).toBe(0);
  const second=await setup();let tick=Date.parse('2026-09-26T09:00:00.000Z');const now=()=>new Date(tick);await stage(await openSession({...second.options,now}));await dispatch(await openSession({...second.options,now}));let slots=0;
  const closedOriginal=async(method:string,target:string,body:unknown)=>{const response=await second.f.transport(method,target,body);if(target.endsWith('/runs/900')){response.body={...response.body,status:'completed',conclusion:'success'};response.raw_text=JSON.stringify(response.body);}return response;};
  const result=await collectSelf(await openSession({...second.options,now,observer:closedOriginal}),{onSlot:async()=>{slots++;},sleep:async(ms:number)=>{tick+=ms;}});expect(result.cleanup_status).toBe('blocked');expect(slots).toBe(0);
 },60000);
 it('does not cancel a rerun of the owned probe attempt',async()=>{
  const {dir,f,options}=await setup();let tick=Date.parse('2026-09-26T09:00:00.000Z');const now=()=>new Date(tick);await stage(await openSession({...options,now}));await dispatch(await openSession({...options,now}));
  const observer=async(method:string,target:string,body:unknown)=>{const response=await f.transport(method,target,body);if(target.endsWith('/runs/901')){response.body={...response.body,run_attempt:2};response.raw_text=JSON.stringify(response.body);}return response;};
  let slots=0;const result=await collectSelf(await openSession({...options,now,observer}),{onSlot:async()=>{slots++;},sleep:async(ms:number)=>{tick+=ms;}});
  expect(result.cleanup_status).toBe('blocked');expect(slots).toBe(0);expect(f.calls.filter(x=>x[0]==='POST'&&x[1].endsWith('/cancel'))).toHaveLength(0);
  expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}).some(x=>x.event==='cancel-used')).toBe(false);
 },60000);
 it('does not stage the App control after an unresolved human slot, even when cancellation completed',async()=>{const {dir,f,options}=await setup();const clock=()=>new Date('2026-09-26T09:00:00.000Z');const opts={...options,now:clock};await stage(await openSession(opts));await dispatch(await openSession(opts));const result=await collectSelf(await openSession(opts),{onSlot:async()=>{throw new Error('no original human participation');}});expect(result.cleanup_status).toBe('complete');const journal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'});expect(journal.some(x=>x.event==='review-unresolved')).toBe(true);await expect(stage(await openSession({...opts,control:'unauthorized_reviewer_refused'}))).rejects.toThrow(/prior reviewer diagnostic incomplete/);expect(f.calls.filter(x=>x[0]==='POST')).toHaveLength(2);},60000);
 it('retains an unexpected approval as one linked unsafe observation and stops',async()=>{
  const {dir,f,options}=await setup();const now=()=>new Date('2026-09-26T09:00:00.000Z');await stage(await openSession({...options,now}));await dispatch(await openSession({...options,now}));let admitted=false,slots=0;
  const observer=async(method:string,target:string,body:unknown)=>{const response=await f.transport(method,target,body);if(admitted&&target.endsWith('/runs/901/approvals')){response.body=[{state:'approved'}];response.raw_text=JSON.stringify(response.body);}return response;};
  const result=await collectSelf(await openSession({...options,now,observer}),{onSlot:async({slot,files}:{slot:{sha256:string},files:{session:string,image:string,participation:string,transcription:string}})=>{slots++;artifact(dir,files.session,{source:'provider-ui',participant:JOHN,run_id:'901',attempt:'1',observed_at:now().toISOString()});writeFileSync(path.join(dir,files.image),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64'),{mode:0o600});writeFileSync(path.join(dir,files.participation),`John personally used the UI for run 901 in staging-release slot ${slot.sha256}`,{mode:0o600});writeFileSync(path.join(dir,files.transcription),'Unexpected approval', {mode:0o600});admitted=true;}});
  expect(result.cleanup_status).toBe('complete');expect(slots).toBe(1);const journal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'});expect(journal.filter(x=>x.event==='review-observed')).toHaveLength(1);expect(journal.find(x=>x.event==='stop')?.payload.reason).toBe('unexpected_admission');const bundleName='reviewer-900-1-self-bundle.json';const bytes=readFileSync(path.join(dir,bundleName));expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:journal,originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('diagnostic-unverified');
 },60000);
 it('retains two serial human UI slots with an advancing clock and a complete unverified bundle',async()=>{const {dir,options}=await setup();let tick=Date.parse('2026-09-26T09:00:00.000Z');const clock=()=>new Date(tick);const opts={...options,now:clock};await stage(await openSession(opts));await dispatch(await openSession(opts));const result=await collectSelf(await openSession(opts),{onSlot:async({slot,files}:{slot:{sha256:string},files:{session:string,image:string,participation:string,transcription:string}})=>{
  artifact(dir,files.session,{source:'provider-ui',participant:{kind:'User',user_id:'5806135',login:'johnellison',provider_type:'User'},run_id:'901',attempt:'1',observed_at:clock().toISOString()});
  writeFileSync(path.join(dir,files.image),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64'),{mode:0o600});
  writeFileSync(path.join(dir,files.participation),`John personally used the UI for run 901 in ${files.participation.includes('staging-release')?'staging-release':'staging-emergency'} slot ${slot.sha256}`,{mode:0o600});
  writeFileSync(path.join(dir,files.transcription),'Self-review action was not available in the provider UI.',{mode:0o600});
  tick+=1000;
 }});expect(result.status).toBe('diagnostic-unverified');expect(result.cleanup_status).toBe('complete');const bundleName='reviewer-900-1-self-bundle.json';const bytes=readFileSync(path.join(dir,bundleName));const assessed=diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})});expect(assessed.status).toBe('diagnostic-unverified');expect(assessed.observations).toBe(2);
  const bundle=JSON.parse(bytes.toString('utf8'));const first=JSON.parse(readFileSync(path.join(dir,bundle.observations[0].artifact),'utf8'));const second=JSON.parse(readFileSync(path.join(dir,bundle.observations[1].artifact),'utf8'));
  expect(first.interaction.captured_at).toBe('2026-09-26T09:00:01.000Z');expect(second.before).not.toEqual(first.before);expect(first.measured_at).toBe('2026-09-26T09:00:02.000Z');
  const linked=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'})[0].payload.original_link;const linkBytes=readFileSync(path.join(dir,linked.artifact));
  rmSync(path.join(dir,linked.artifact));expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
  writeFileSync(path.join(dir,linked.artifact),Buffer.from(`${canonical({...JSON.parse(linkBytes.toString('utf8')),journal_seq:999})}\n`),{mode:0o600});expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
  const wrong=retain(dir,'wrong-original-link.json',`${canonical({...JSON.parse(linkBytes.toString('utf8')),journal_seq:999})}\n`);writeFileSync(path.join(dir,linked.artifact),linkBytes,{mode:0o600});const alteredJournal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'});alteredJournal[0]={...alteredJournal[0],payload:{...alteredJournal[0].payload,original_link:wrong}};expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:alteredJournal,originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
  const altered=retain(dir,'altered-first-observation.json',`${canonical({...first,before:second.before})}\n`);const alteredBundle=retain(dir,'altered-bundle.json',`${canonical({...bundle,observations:[altered,bundle.observations[1]]})}\n`);
  expect(diagnosticResult({dir,bundleRef:alteredBundle,journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
  const future=retain(dir,'future-observation.json',`${canonical({...first,measured_at:'2099-01-01T00:00:00.000Z'})}\n`);const futureBundle=retain(dir,'future-bundle.json',`${canonical({...bundle,observations:[future,bundle.observations[1]]})}\n`);expect(diagnosticResult({dir,bundleRef:futureBundle,journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
  const terminal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}).find(x=>x.event==='terminal-observed');rmSync(path.join(dir,terminal!.payload.trigger.artifact));expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'})}).status).toBe('invalid-diagnostic');
 },60000);
});

async function prepareAppControl(clock=()=>new Date('2026-09-26T09:00:00.000Z')){
  const {dir,options}=await setup();const selfOpts={...options,now:clock};
  await stage(await openSession(selfOpts));await dispatch(await openSession(selfOpts));
  await collectSelf(await openSession(selfOpts),{onSlot:async({slot,files}:{slot:{sha256:string},files:{session:string,image:string,participation:string,transcription:string}})=>{
   artifact(dir,files.session,{source:'provider-ui',participant:JOHN,run_id:'901',attempt:'1',observed_at:clock().toISOString()});
   writeFileSync(path.join(dir,files.image),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64'),{mode:0o600});
   writeFileSync(path.join(dir,files.participation),`John personally used the UI for run 901 in ${files.participation.includes('staging-release')?'staging-release':'staging-emergency'} slot ${slot.sha256}`,{mode:0o600});
   writeFileSync(path.join(dir,files.transcription),'The provider UI did not permit self-review.',{mode:0o600});
  }});
  const selfIntent=JSON.parse(readFileSync(path.join(dir,'reviewer-900-1-self-intent.json'),'utf8'));
  const priorBytes=readFileSync(path.join(dir,'reviewer-900-1-self-lifecycle.json'));const prior={artifact:'reviewer-900-1-self-lifecycle.json',sha256:digest(priorBytes)};
  const owner=retain(dir,'synthetic-owner.json','{}');const provisioning=retain(dir,'synthetic-provisioning.json',`${canonical({provisioning_version:1,principal:{kind:'AppInstallation',app_id:'5043150',app_slug:'aios-reviewer-diagnostic',installation_id:'163986129',account_id:'293764221',account_login:'aiosbrain',repository_id:'1268462466'},required_permissions:{deployments:'write',metadata:'read'},repository_selection:'selected',owner_decision:owner})}\n`);
  const app={kind:'AppInstallation',app_id:'5043150',app_slug:'aios-reviewer-diagnostic',installation_id:'163986129',account_id:'293764221',account_login:'aiosbrain',repository_id:'1268462466'};
  const i={...selfIntent,control:'unauthorized_reviewer_refused',submitter:app,prior_probe:prior,provisioning,existing_runs:['901'],journal_artifact:'commissioning-900-1.reviewer-app.jsonl'};
  const intentRef=retain(dir,'reviewer-900-1-app-intent.json',`${canonical(i)}\n`);
  const resourceLock=acquireJournalLock({dir,runId:'900',attempt:'1'});let seq;
  try{const j=openJournal({dir,runId:'900',attempt:'1',lock:resourceLock,source});seq=j.append('reviewer-probe-linked',{control:i.control,intent_sha256:intentRef.sha256,probe_journal_artifact:i.journal_artifact}).seq;}finally{resourceLock.release();}
  const originalLink=retain(dir,'reviewer-900-1-app-original-link-001.json',`${canonical({link_version:1,control:i.control,original_run_id:'900',original_attempt:'1',journal_seq:seq,intent_sha256:intentRef.sha256,journal_artifact:i.journal_artifact})}\n`);
  const reviewerLock=acquireJournalLock({dir,runId:'900',attempt:'1',kind:'reviewer-app'});
  try{openReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app',intentSha256:intentRef.sha256,lock:reviewerLock,now:clock}).append('intent-linked',{intent:intentRef,original_link:originalLink});}finally{reviewerLock.release();}
  const appOpts={...options,control:'unauthorized_reviewer_refused',now:clock};await dispatch(await openSession(appOpts));
  return {dir,options,clock,appOpts,app,prior};
}

describe('isolated App diagnostic request',()=>{
 it('stops after the first generic 403, cancels the second inert run and revokes only its token',async()=>{
  const {dir,appOpts,app,prior}=await prepareAppControl();
  let reviews=0,revokes=0,mints=0;const response=(status:number,body:unknown)=>({complete:true,status,body,raw_text:status===204?'':JSON.stringify(body)});
  const jwtAdapter=async(method:string,target:string)=>{if(method==='GET'&&target==='/app')return response(200,{id:5043150,slug:'aios-reviewer-diagnostic'});if(method==='GET'&&target==='/app/installations/163986129')return response(200,{id:163986129,app_id:5043150,account:{id:293764221,login:'aiosbrain'},repository_selection:'selected',suspended_at:null,permissions:{deployments:'write',metadata:'read'}});if(method==='POST'&&target.endsWith('/access_tokens')){mints++;return response(201,{token:'synthetic-in-memory-token',expires_at:'2026-09-26T09:20:00Z',repositories:[{id:1268462466}],permissions:{deployments:'write',metadata:'read'}});}throw new Error('unexpected JWT route');}; // aios-secret-fixture:synthetic-in-memory-token
  const tokenFactory=(_token:string)=>async(method:string,target:string)=>{if(method==='GET'&&target.startsWith('/installation/repositories?'))return response(200,{total_count:1,repositories:[{id:1268462466,full_name:'aiosbrain/aios-team-brain'}]});if(method==='POST'&&target.endsWith('/pending_deployments')){reviews++;return response(403,{message:'Forbidden'});}if(method==='DELETE'&&target==='/installation/token'){revokes++;return response(204,null);}throw new Error('unexpected token route');};
  const result=await collectApp(await openSession(appOpts),{appJwtAdapter:jwtAdapter,tokenAdapterFactory:tokenFactory});
  expect(result.status).toBe('diagnostic-unverified');expect(result.reason).toBe('unknown_cause');expect(result.cleanup_status).toBe('complete');expect({mints,reviews,revokes}).toEqual({mints:1,reviews:1,revokes:1});
  await expect(collectApp(await openSession(appOpts),{appJwtAdapter:jwtAdapter,tokenAdapterFactory:tokenFactory})).rejects.toThrow();expect({mints,reviews,revokes}).toEqual({mints:1,reviews:1,revokes:1});
  const journal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app'});expect(journal.filter(x=>x.event==='review-used')).toHaveLength(1);expect(journal.map(x=>x.event)).toContain('token-revoke-used');
  const bundleName='reviewer-900-1-app-bundle.json';const bytes=readFileSync(path.join(dir,bundleName));const assessed=diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:journal,priorRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'}),provisioned:app});expect(assessed.status).toBe('diagnostic-unverified');expect(assessed.observations).toBe(1);
  const bundle=JSON.parse(bytes.toString('utf8'));const life=JSON.parse(readFileSync(path.join(dir,bundle.lifecycle.artifact),'utf8'));
  const cleanupBytes=readFileSync(path.join(dir,life.token_cleanup.artifact));rmSync(path.join(dir,life.token_cleanup.artifact));expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:journal,priorRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'}),provisioned:app}).status).toBe('invalid-diagnostic');writeFileSync(path.join(dir,life.token_cleanup.artifact),cleanupBytes,{mode:0o600});
  rmSync(path.join(dir,prior.artifact));expect(diagnosticResult({dir,bundleRef:{artifact:bundleName,sha256:digest(bytes)},journalRecords:journal,priorRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'}),provisioned:app}).status).toBe('invalid-diagnostic');
 },60000);
 it('does not submit or mint when the selected installation is suspended',async()=>{
  const {dir,appOpts}=await prepareAppControl();let mints=0,reviews=0;
  const response=(status:number,body:unknown)=>({complete:true,status,body,raw_text:status===204?'':JSON.stringify(body)});
  const jwtAdapter=async(method:string,target:string)=>{if(method==='GET'&&target==='/app')return response(200,{id:5043150,slug:'aios-reviewer-diagnostic'});if(method==='GET'&&target==='/app/installations/163986129')return response(200,{id:163986129,app_id:5043150,account:{id:293764221,login:'aiosbrain'},repository_selection:'selected',suspended_at:'2026-09-26T08:00:00Z',permissions:{deployments:'write',metadata:'read'}});if(method==='POST'){mints++;}throw new Error('unexpected JWT route');};
  const result=await collectApp(await openSession(appOpts),{appJwtAdapter:jwtAdapter,tokenAdapterFactory:()=>async()=>{reviews++;throw new Error('unexpected token use');}});expect(result.cleanup_status).toBe('blocked');expect({mints,reviews}).toEqual({mints:0,reviews:0});expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app'}).some(x=>x.event==='review-used')).toBe(false);
 },90000);
 it('revokes an owned widened token without attempting a review',async()=>{
  const {dir,appOpts}=await prepareAppControl();let mints=0,reviews=0,revokes=0;const response=(status:number,body:unknown)=>({complete:true,status,body,raw_text:status===204?'':JSON.stringify(body)});
  const jwtAdapter=async(method:string,target:string)=>{if(method==='GET'&&target==='/app')return response(200,{id:5043150,slug:'aios-reviewer-diagnostic'});if(method==='GET'&&target==='/app/installations/163986129')return response(200,{id:163986129,app_id:5043150,account:{id:293764221,login:'aiosbrain'},repository_selection:'selected',suspended_at:null,permissions:{deployments:'write',metadata:'read'}});if(method==='POST'&&target.endsWith('/access_tokens')){mints++;return response(201,{token:'synthetic-in-memory-token',expires_at:'2026-09-26T09:20:00Z',repositories:[{id:1268462466}],permissions:{deployments:'write',metadata:'read',contents:'write'}});}throw new Error('unexpected JWT route');}; // aios-secret-fixture:synthetic-in-memory-token
  const tokenFactory=(_token:string)=>async(method:string,target:string)=>{if(method==='DELETE'&&target==='/installation/token'){revokes++;return response(204,null);}if(method==='POST')reviews++;throw new Error('unexpected token route');};
  const result=await collectApp(await openSession(appOpts),{appJwtAdapter:jwtAdapter,tokenAdapterFactory:tokenFactory});expect(result.status).toBe('diagnostic-unverified');expect(result.cleanup_status).toBe('blocked');expect({mints,reviews,revokes}).toEqual({mints:1,reviews:0,revokes:1});expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app'}).some(x=>x.event==='review-used')).toBe(false);
 },90000);
 it('reconciles a lost revoke only after known expiry without repeating a write',async()=>{
  let tick=Date.parse('2026-09-26T09:00:00.000Z');const clock=()=>new Date(tick);const {dir,appOpts,app}=await prepareAppControl(clock);let mints=0,reviews=0,revokes=0;
  const response=(status:number,body:unknown)=>({complete:true,status,body,raw_text:status===204?'':JSON.stringify(body)});
  const jwtAdapter=async(method:string,target:string)=>{if(method==='GET'&&target==='/app')return response(200,{id:5043150,slug:'aios-reviewer-diagnostic'});if(method==='GET'&&target==='/app/installations/163986129')return response(200,{id:163986129,app_id:5043150,account:{id:293764221,login:'aiosbrain'},repository_selection:'selected',suspended_at:null,permissions:{deployments:'write',metadata:'read'}});if(method==='POST'&&target.endsWith('/access_tokens')){mints++;return response(201,{token:'synthetic-in-memory-token',expires_at:'2026-09-26T09:20:00Z',repositories:[{id:1268462466}],permissions:{deployments:'write',metadata:'read'}});}throw new Error('unexpected JWT route');}; // aios-secret-fixture:synthetic-in-memory-token
  const tokenFactory=(_token:string)=>async(method:string,target:string)=>{if(method==='GET'&&target.startsWith('/installation/repositories?'))return response(200,{total_count:1,repositories:[{id:1268462466,full_name:'aiosbrain/aios-team-brain'}]});if(method==='POST'&&target.endsWith('/pending_deployments')){reviews++;return response(403,{message:'Forbidden'});}if(method==='DELETE'&&target==='/installation/token'){revokes++;return {complete:false,status:0};}throw new Error('unexpected token route');};
  const blocked=await collectApp(await openSession(appOpts),{appJwtAdapter:jwtAdapter,tokenAdapterFactory:tokenFactory});expect(blocked.cleanup_status).toBe('blocked');expect({mints,reviews,revokes}).toEqual({mints:1,reviews:1,revokes:1});
  tick=Date.parse('2026-09-26T09:21:00.000Z');const reconciled=await cancelAndFinalize(await openSession(appOpts));expect(reconciled.cleanup_status).toBe('complete');expect({mints,reviews,revokes}).toEqual({mints:1,reviews:1,revokes:1});
  const journal=readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-app'});expect(journal.filter(x=>x.event==='token-cleanup').map(x=>x.payload.disposition)).toEqual(['unresolved','expired_deadline_observed']);const bundle='reviewer-900-1-app-bundle-001.json';const bytes=readFileSync(path.join(dir,bundle));const assessment=diagnosticResult({dir,bundleRef:{artifact:bundle,sha256:digest(bytes)},journalRecords:journal,priorRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'}),provisioned:app});expect(assessment).toMatchObject({status:'diagnostic-unverified'});
  expect(authoritativeBundle(dir,journal,'900','1','unauthorized_reviewer_refused').artifact).toBe(bundle);
  expect(diagnosticResult({dir,bundleRef:{artifact:'reviewer-900-1-app-bundle.json',sha256:digest(readFileSync(path.join(dir,'reviewer-900-1-app-bundle.json')))},journalRecords:journal,priorRecords:readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'}),originalRecords:readJournal({dir,runId:'900',attempt:'1'}),provisioned:app}).status).toBe('invalid-diagnostic');
  // This unit fixture uses a synthetic owner descriptor, so original assessment must still
  // refuse it; the public provisioning-bound repro proves the complete original path.
  expect(assessEvidence({dir,runId:'900',attempt:'1'}).blockers.find(x=>x.gate==='PC-07'&&x.detail.includes('linked reviewer'))?.detail).toContain('owner adjudication binding differs');
  const retry=await cancelAndFinalize(await openSession(appOpts));expect(retry.lifecycle.artifact).toBe('reviewer-900-1-app-lifecycle-001.json');expect({mints,reviews,revokes}).toEqual({mints:1,reviews:1,revokes:1});
  const duplicate='reviewer-900-1-app-bundle-002.json';writeFileSync(path.join(dir,duplicate),bytes,{mode:0o600});expect(()=>authoritativeBundle(dir,journal,'900','1','unauthorized_reviewer_refused')).toThrow(/ambiguous/);expect(assessEvidence({dir,runId:'900',attempt:'1'}).blockers.find(x=>x.gate==='PC-07'&&x.detail.includes('linked reviewer'))?.detail).toContain('ambiguous');rmSync(path.join(dir,duplicate));
 },90000);
});

describe('deadline-bounded App transport',()=>{it('caps its request abort to the remaining slot',async()=>{const original=AbortSignal.timeout;const observed:number[]=[];const spy=vi.spyOn(AbortSignal,'timeout').mockImplementation((ms:number)=>{observed.push(ms);return original(ms);});try{const transport=fixedFetchTransport('synthetic-token',{now:()=>new Date('2026-09-26T09:00:00.000Z'),fetchImpl:async()=>({status:204,body:null,arrayBuffer:async()=>new ArrayBuffer(0)}) as unknown as Response});await transport('POST','/fixed',null,{deadlineAt:'2026-09-26T09:00:01.000Z'});expect(observed).toEqual([1000]);await expect(transport('POST','/fixed',null,{deadlineAt:'2026-09-26T08:59:59.999Z'})).rejects.toThrow(/deadline expired/);}finally{spy.mockRestore();}});});

describe('exact App grant',()=>{it('rejects a widened returned permission object',()=>{expect(()=>exactAppPermissions({deployments:'write',metadata:'read',contents:'write'})).toThrow(/exact deployment-only/);expect(()=>exactAppPermissions({deployments:'write',metadata:'read'})).not.toThrow();});});
