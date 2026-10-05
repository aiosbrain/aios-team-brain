import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { assertWorkflow, WORKFLOW_PATH, WORKFLOW_NAME } from '../../scripts/staging-ops/reviewer-negative-probe.mjs';
import { inducedTriggers, fixedRead, fixedMutation, makeBoundary } from '../../scripts/staging-ops/reviewer-negative-probe-operator.mjs';

const source=readFileSync(join(__dirname,'../..',WORKFLOW_PATH),'utf8');
type WorkflowDoc = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { steps: unknown; if: unknown; environment: unknown; env?: unknown }> };
const doc=parseYaml(source) as WorkflowDoc;
describe('PC-06 inert reviewer workflow',()=>{
 it('has exactly the fixed trigger, permissions and two literal no-op jobs',()=>{
  expect(assertWorkflow(source).name).toBe(WORKFLOW_NAME);
  expect(Object.keys(doc.jobs)).toEqual(['probe-release','probe-emergency']);
  expect(doc.on).toEqual({workflow_dispatch:null});
  for(const forbidden of ['secrets','vars.','uses:','checkout','inputs','${{','needs:','env:','services:','container:','with:','shell:','GITHUB_TOKEN'])expect(source).not.toContain(forbidden);
 });
 it('rejects extra trigger, permission, code, job and changed admission',()=>{
  for(const mutate of [
   (x:WorkflowDoc)=>{x.on.push=null;},(x:WorkflowDoc)=>{x.permissions={contents:'read'};},
   (x:WorkflowDoc)=>{x.jobs.extra={...x.jobs['probe-release']};},(x:WorkflowDoc)=>{x.jobs['probe-release'].steps=[{run:'echo hello'}];},
   (x:WorkflowDoc)=>{x.jobs['probe-release'].if='true';},(x:WorkflowDoc)=>{x.jobs['probe-release'].environment='staging-emergency';},
   (x:WorkflowDoc)=>{x.jobs['probe-release'].env={SECRET:'x'};},
  ]){const x=structuredClone(doc);mutate(x);expect(()=>assertWorkflow(JSON.stringify(x))).toThrow();}
 });
 it('blocks potentially induced workflows and active hooks; excludes an exact other workflow_run name',()=>{
  expect(inducedTriggers([{text:'on:\n  workflow_run:\n    workflows: [PC-06 reviewer negative probe]\n'}],[])).toBe('blocked');
  for(const event of ['workflow_job','deployment','deployment_status','check_run','check_suite'])expect(inducedTriggers([{text:`on:\n  ${event}:\n`}],[])).toBe('blocked');
  expect(inducedTriggers([{text:'on:\n  workflow_run:\n    workflows: [A different workflow]\n'}],[])).toBe('clear');
  expect(inducedTriggers([{text:'on:\n  workflow_dispatch:\n'}],[{active:true,events:['*']}])).toBe('blocked');
  expect(inducedTriggers([{text:'on:\n  workflow_dispatch:\n'}],[{active:false,events:['*']}])).toBe('clear');
 });
 it('has fixed observer/App roles and one exact review body',async()=>{
  const observer=async()=>({complete:true,status:200,body:{},raw_text:'{}'});
  const appJwt=async()=>({complete:true,status:200,body:{},raw_text:'{}'});
  const appToken=async()=>({complete:true,status:200,body:{},raw_text:'{}'});
  const request=makeBoundary({observer,appJwt,appToken});
  expect(fixedRead('workflow')).toBe('/repos/aiosbrain/aios-team-brain/actions/workflows/release-reviewer-negative-probe.yml');
  expect(fixedMutation('review',{runId:'123',environmentId:'456'}).body).toBe('{"environment_ids":[456],"state":"approved","comment":"PC-06 unauthorized-reviewer diagnostic; no human approval"}');
  expect(()=>fixedMutation('review',{runId:'123',environmentId:'9007199254740993'})).toThrow();
  await expect(request('observer','POST','review',{runId:'123',environmentId:'456'},fixedMutation('review',{runId:'123',environmentId:'456'}).body)).rejects.toThrow();
  await expect(request('app-token','GET','pending',{runId:'123'})).rejects.toThrow();
  await expect(request('app-jwt','POST','review',{runId:'123',environmentId:'456'},fixedMutation('review',{runId:'123',environmentId:'456'}).body)).rejects.toThrow();
  await expect(request('observer','GET','hooks-projection',{page:1})).rejects.toThrow();
 });
});
