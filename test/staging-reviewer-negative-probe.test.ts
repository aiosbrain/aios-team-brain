import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireJournalLock, openReviewerJournal, readReviewerJournal } from '../scripts/staging-ops/commissioning-journal.mjs';
import { validateEnvironmentControl } from '../scripts/staging-ops/policy-commissioning.mjs';
import { JOHN, WORKFLOW_PATH, WORKFLOW_NAME, assertWorkflow, apiInteraction, canonical, capture, diagnosticResult, digest, environmentPair, fileRef, fixedReviewBody, image, installation, intent, json, lifecycle, original, probe, readCapture, replay, retain, retained, reviewerEvent, slot, state, time, tokenRecord, user } from '../scripts/staging-ops/reviewer-negative-probe.mjs';

const folders:string[]=[];afterEach(()=>{for(const p of folders.splice(0))rmSync(p,{recursive:true,force:true});});
const privateDir=()=>{const p=mkdtempSync(path.join(tmpdir(),'reviewer-negative-'));chmodSync(p,0o700);folders.push(p);return p;};
const at='2026-09-26T09:00:00.000Z';const sha='a'.repeat(40);const h='b'.repeat(64);
const ref={artifact:'x.json',sha256:h};
const envs=[{name:'staging-release',environment_id:'11',job_key:'probe-release'},{name:'staging-emergency',environment_id:'12',job_key:'probe-emergency'}];
const originalRun={repository:'aiosbrain/aios-team-brain',repository_id:'1268462466',run_id:'900',attempt:'1',workflow_path:'.github/workflows/release-policy-commissioning.yml',workflow_sha:sha,intent_sha256:h};
const selfIntent={intent_version:1,control:'self_review_refused',original:originalRun,probe_workflow_path:WORKFLOW_PATH,probe_workflow_name:WORKFLOW_NAME,probe_sha:sha,ref:'refs/heads/staging',event:'workflow_dispatch',attempt:'1',dispatcher:JOHN,observer:JOHN,submitter:JOHN,environments:envs,baseline_state:ref,trigger_baseline:ref,existing_runs:['100'],staged_at:at,journal_artifact:'commissioning-900-1.reviewer-self.jsonl',prior_probe:null,provisioning:null};
const app={kind:'AppInstallation',app_id:'5043150',app_slug:'aios-reviewer-diagnostic',installation_id:'163986129',account_id:'293764221',account_login:'aiosbrain',repository_id:'1268462466'};
const inertProbe={run_id:'901',attempt:'1',workflow_id:'13',workflow_path:WORKFLOW_PATH,workflow_sha:sha,ref:'refs/heads/staging',event:'workflow_dispatch',actor:JOHN,triggering_actor:JOHN,created_at:at,jobs:[{job_key:'probe-release',job_id:'101',environment:envs[0]},{job_key:'probe-emergency',job_id:'102',environment:envs[1]}]};
const appendPayload={intent:ref,original_link:ref};

describe('reviewer diagnostic closed and nonaccepting boundary',()=>{
 it('accepts only typed John, Installation, original and two distinct environments',()=>{
  expect(user(JOHN)).toEqual(JOHN);expect(installation(app)).toEqual(app);expect(original(originalRun)).toEqual(originalRun);expect(environmentPair(envs)).toEqual(envs);expect(intent(selfIntent)).toEqual(selfIntent);expect(probe(inertProbe,selfIntent)).toEqual(inertProbe);
  expect(()=>user({...JOHN,kind:'AppInstallation'})).toThrow();expect(()=>installation({...app,user_id:'5806135'})).toThrow();expect(()=>environmentPair([envs[0],envs[0]])).toThrow();expect(()=>intent({...selfIntent,submitter:app})).toThrow();expect(()=>intent({...selfIntent,prior_probe:ref})).toThrow();expect(()=>original({...originalRun,workflow_sha:'A'.repeat(40)})).toThrow();expect(()=>probe({...inertProbe,run_id:'900'},selfIntent)).toThrow();
 });
 it('refuses extra fields, unsafe IDs, future-typed forms and lossy request integer serialization',()=>{
  expect(()=>capture({capture_version:1,route:'pending',subject_id:'1',page:null,started_at:at,completed_at:at,http_status:200,body:ref,representation:'original-json',extra:true})).toThrow();
  expect(()=>fileRef({artifact:'../escape',sha256:h})).toThrow();expect(()=>time('2026-09-26T09:00:00Z')).toThrow();
  expect(fixedReviewBody('12')).toBe('{"environment_ids":[12],"state":"approved","comment":"PC-06 unauthorized-reviewer diagnostic; no human approval"}');
  expect(()=>fixedReviewBody('9007199254740993')).toThrow();expect(()=>slot({slot_version:1,control:'self_review_refused',probe_run_id:'901',attempt:'1',environment:envs[0],channel:'installation-api',submitter:JOHN,created_at:at,expires_at:at,request_body:null,request_sha256:null},selfIntent,inertProbe)).toThrow();
 });
 it('retains exact private bytes and rejects links, loose modes, size and hash attacks',()=>{
  const dir=privateDir();const r=retain(dir,'good.json','{"a":1}');expect(json(dir,r)).toEqual({a:1});expect(()=>retained(dir,{...r,sha256:h})).toThrow();
  symlinkSync(path.join(dir,'good.json'),path.join(dir,'link.json'));expect(()=>retained(dir,{artifact:'link.json',sha256:r.sha256})).toThrow();
  chmodSync(path.join(dir,'good.json'),0o644);expect(()=>retained(dir,r)).toThrow();
  expect(()=>retain(dir,'too-big.json','x'.repeat(65537))).toThrow();
  const fake=retain(dir,'not-image.png',Buffer.from('hello'));expect(()=>image(dir,fake)).toThrow();
 });
 it('rejects replayed mutation/review markers and never treats a 403 as refusal',()=>{
  const events=[{type:'intent-linked',data:appendPayload},{type:'dispatch-used',data:{workflow_id:'13',sha,ref:'staging',body_sha256:h,before_runs:ref,trigger:ref,deadline:at}},{type:'dispatch-reconciled',data:{run_id:'901',attempt:'1',discovered:ref,matching_count:1}},{type:'review-used',data:{environment:envs[0],channel:'human-ui',state:ref,trigger:ref,slot:ref}}];
  expect(replay(events).complete).toBe(false);expect(()=>replay([...events,events.at(-1)])).toThrow();expect(()=>replay([...events,{type:'review-used',data:{...events.at(-1)!.data,environment:envs[1]}}])).not.toThrow();
  expect(()=>replay([...events,{type:'stop',data:{reason:'unknown_cause',state:ref}},{type:'review-used',data:{...events.at(-1)!.data,environment:envs[1]}}])).toThrow();
  expect(diagnosticResult({dir:privateDir(),bundleRef:ref}).status).toBe('invalid-diagnostic');
 });
 it('writes a separate hash-chained reviewer journal with durable one-use state',()=>{
  const dir=privateDir(),lock=acquireJournalLock({dir,runId:'900',attempt:'1',kind:'reviewer-self',now:()=>new Date(at)});
  try{const j=openReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self',intentSha256:h,lock,now:()=>new Date(at)});j.append('intent-linked',appendPayload);j.append('dispatch-used',{workflow_id:'13',sha,ref:'staging',body_sha256:h,before_runs:ref,trigger:ref,deadline:at});j.append('dispatch-reconciled',{run_id:'901',attempt:'1',discovered:ref,matching_count:1});expect(readReviewerJournal({dir,runId:'900',attempt:'1',kind:'reviewer-self'})).toHaveLength(3);expect(()=>j.append('dispatch-used',{workflow_id:'13',sha,ref:'staging',body_sha256:h,before_runs:ref,trigger:ref,deadline:at})).toThrow();}
  finally{lock.release();}
 });
 it('keeps both reviewer controls unverified in the original policy assessor',()=>{
  const record={reviewer_diagnostic_version:1,status:'unverified',artifact:'bundle.json',sha256:h};
  expect(validateEnvironmentControl(record,{dir:privateDir(),key:'self_review_refused',environment:'staging-release',runId:'900',attempt:'1'})).not.toBeNull();
  expect(validateEnvironmentControl(record,{dir:privateDir(),key:'unauthorized_reviewer_refused',environment:'staging-release',runId:'900',attempt:'1'})).not.toBeNull();
  expect(validateEnvironmentControl(record,{dir:privateDir(),key:'off_branch_environment_reference_refused',environment:'staging-release'})).toMatch(/wrong control/);
  expect(validateEnvironmentControl({...record,status:'verified'},{dir:privateDir(),key:'self_review_refused',environment:'staging-release'})).not.toBeNull();
 });
});
