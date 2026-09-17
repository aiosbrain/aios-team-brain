import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/evidence/search/route';
import { db, seedTeam, ingest, externalMember } from './helpers';
import { issueApiKey } from '@/lib/admin/keys';
import { backfillTeamContext } from '@/lib/projects/context/backfill';
import { mintAgentToken, revokeAgentToken } from '@/lib/access/agent-tokens';
import { createGroup, addMemberToGroup, grantProjectToGroup, revokeProjectFromGroup } from '@/lib/access/groups';
import { searchEvidence } from '@/lib/query/evidence';
import { visibleItemIds } from '@/lib/access/enforce';

async function ask(key:string, body:unknown) {
  return POST(new Request('http://test/api/v1/evidence/search',{method:'POST',headers:{authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)}) as NextRequest);
}
describe('evidence search real database and route',()=>{
  it('ranks only authorized/project-scoped matches, returns attribution, no unrelated padding',async()=>{
    const s=await seedTeam(); const other=await seedTeam();
    const {data:m}=await db().from('members').select('actor_handle').eq('id',s.memberId).single();
    await ingest(s,{path:'experiments/EXP-019.md',body:'# Protection\nCardboard nonenal protection works until day 28.',access:'team',project:'dairy',frontmatter:{authors:[{role:'author',handle:m!.actor_handle},{role:'editor',display_name:'Unknown Editor',email:'private@unknown.example'}]}});
    await ingest(s,{path:'notes.md',body:'Cardboard packaging unrelated',access:'external',project:'packaging'});
    await ingest(other,{path:'secret.md',body:'Cardboard nonenal protection secret other team',access:'team',project:'dairy'});
    await backfillTeamContext(db(),s.teamId);
    const {key}=await issueApiKey(db(),s.teamId,s.memberId,'test');
    const r=await ask(key,{query:'Has anyone looked at cardboard nonenal?',project:'dairy',limit:1});expect(r.status).toBe(200);
    const data=await r.json();expect(data.sources).toHaveLength(1);expect(data.sources[0].path).toBe('experiments/EXP-019.md');
    expect(data.sources[0].contributors).toEqual([{name:'Tester',handle:m!.actor_handle,role:'author',resolution:'exact'},{name:'Unknown Editor',role:'editor',resolution:'unresolved'}]);
    expect(JSON.stringify(data)).not.toContain('private@');expect(data.sources[0].attribution).toBe('partial');
    expect((await (await ask(key,{query:'zyxunfindablequux'})).json()).sources).toEqual([]);
    expect((await (await ask(key,{query:'EXP-019'})).json()).sources[0].path).toContain('EXP-019');
    const ext=await externalMember(s);const ek=await issueApiKey(db(),s.teamId,ext,'external');
    const external=await (await ask(ek.key,{query:'cardboard'})).json();expect(external.sources.map((x:{path:string})=>x.path)).toEqual(['notes.md']);
    expect(JSON.stringify(external)).not.toContain('Unknown Editor');
    expect((await ask(key,{query:'x',limit:21})).status).toBe(422);
    expect((await ask('bad',{query:'x'})).status).toBe(401);
    const view=await visibleItemIds(db(),{teamId:s.teamId,memberId:s.memberId});
    expect((await searchEvidence(db(),s.teamId,'team','cardboard','missing',1,view.ids)).sources).toEqual([]);
  });
  it('delegation is scope-limited and revocation is live',async()=>{
    const s=await seedTeam();await ingest(s,{path:'private.md',body:'nonenal private evidence',access:'team'});await backfillTeamContext(db(),s.teamId);
    const token=await mintAgentToken(db(),s.teamId,{memberId:s.memberId,projectScope:[]},s.memberId);expect(token.ok).toBe(true);
    const r=await ask(token.token!,{query:'nonenal'});expect(r.status).toBe(200);expect((await r.json()).sources).toEqual([]);
    await revokeAgentToken(db(),s.teamId,token.tokenRowId!,s.memberId);expect((await ask(token.token!,{query:'nonenal'})).status).toBe(401);
  });
  it('a grant admits evidence and revocation removes content and attribution for both principals',async()=>{
    const s=await seedTeam();
    expect((await db().from('members').update({role:'admin'}).eq('id',s.memberId)).error).toBeNull();
    const item=await ingest(s,{path:'restricted.md',body:'quuxrestricted insight',access:'team',frontmatter:{authors:[{display_name:'Secret Person',role:'author'}]}});
    await backfillTeamContext(db(),s.teamId);
    const {data:project}=await db().from('projects').insert({team_id:s.teamId,slug:'restricted',name:'Restricted',kind:'initiative'}).select('id').single();
    const {data:unit}=await db().from('project_context_units').select('id').eq('source_item_id',item.id).single();
    expect((await db().from('project_context_memberships').update({valid_to:new Date().toISOString()}).eq('context_unit_id',unit!.id)).error).toBeNull();
    expect((await db().from('project_context_memberships').insert({team_id:s.teamId,project_id:project!.id,context_unit_id:unit!.id,method:'manual'})).error).toBeNull();
    const group=await createGroup(db(),s.teamId,'researchers','Researchers',s.memberId);
    expect((await addMemberToGroup(db(),s.teamId,group.groupId!,s.memberId,s.memberId)).ok).toBe(true);
    const {key}=await issueApiKey(db(),s.teamId,s.memberId,'member');
    const token=await mintAgentToken(db(),s.teamId,{memberId:s.memberId,projectScope:[project!.id]},s.memberId);expect(token.ok).toBe(true);
    for(const k of [key,token.token!])expect((await (await ask(k,{query:'quuxrestricted'})).json()).sources).toEqual([]);
    expect((await grantProjectToGroup(db(),s.teamId,project!.id,group.groupId!,s.memberId)).ok).toBe(true);
    for(const k of [key,token.token!]){const r=await ask(k,{query:'quuxrestricted'});expect(r.status).toBe(200);expect(JSON.stringify(await r.json())).toContain('Secret Person');}
    expect((await revokeProjectFromGroup(db(),s.teamId,project!.id,group.groupId!,{kind:'member',memberId:s.memberId})).ok).toBe(true);
    for(const k of [key,token.token!])expect((await (await ask(k,{query:'quuxrestricted'})).json()).sources).toEqual([]);
  });
  it('never attributes generic upload ownership or connector identity as a researcher',async()=>{
    const s=await seedTeam();const a=await ingest(s,{path:'unknown.md',body:'nonenal mystery author',access:'team',actor:'demo'});
    const {data:m}=await db().from('members').select('actor_handle').eq('id',s.memberId).single();
    const ordinary=await ingest(s,{path:'ordinary.md',body:'nonenal ordinary upload',access:'team',actor:m!.actor_handle});
    const result=await searchEvidence(db(),s.teamId,'team','nonenal',undefined,8,new Set([a.id,ordinary.id]));
    expect(result.sources.every(x=>x.contributors.length===0)).toBe(true);
    expect(result.sources[0].contributors).toEqual([]);expect(result.sources[0].attribution).toBe('unresolved');
  });
});
