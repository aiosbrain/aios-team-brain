import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({auth:vi.fn(),agent:vi.fn(),visible:vi.fn(),delegated:vi.fn(),search:vi.fn(),rate:vi.fn()}));
vi.mock('@/lib/api/auth',()=>({authenticateApiKey:mocks.auth,authenticateAgentToken:mocks.agent,isAgentBearer:(r:Request)=>r.headers.get('authorization')?.includes('aiosd_')}));
vi.mock('@/lib/db/admin',()=>({adminClient:()=>({})}));
vi.mock('@/lib/access/enforce',()=>({visibleItemIds:mocks.visible,delegatedVisibleItemIds:mocks.delegated}));
vi.mock('@/lib/api/rate-limit',()=>({rateLimitWithReset:mocks.rate}));
vi.mock('@/lib/query/evidence',()=>({searchEvidence:mocks.search}));
import {POST} from '@/app/api/v1/evidence/search/route';
const req=(body:unknown, key='key')=>new NextRequest('http://test/api/v1/evidence/search',{method:'POST',headers:{authorization:`Bearer ${key}`},body:typeof body==='string'?body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();mocks.auth.mockResolvedValue({teamId:'t',memberId:'m',memberTier:'team'});mocks.rate.mockResolvedValue({allowed:true,retryAfterSeconds:1});mocks.visible.mockResolvedValue({ids:new Set(['id'])});mocks.search.mockResolvedValue({sources:[],returned:0,truncated:false});});
describe('evidence API failure semantics',()=>{
 it('visibility lookup failure is not successful no matches',async()=>{mocks.visible.mockResolvedValue({ids:new Set(),error:true});expect((await POST(req({query:'hello'}))).status).toBe(500);expect(mocks.search).not.toHaveBeenCalled();});
 it('attribution/search failure stays error without leaking details',async()=>{mocks.search.mockRejectedValue(new Error('private credential value'));const r=await POST(req({query:'hello'}));expect(r.status).toBe(500);expect(await r.text()).not.toContain('private credential');});
 it('delegated identity uses launching member rate bucket and token oracle',async()=>{mocks.agent.mockResolvedValue({teamId:'t',memberId:'launcher',memberTier:'team'});mocks.delegated.mockResolvedValue({ids:new Set()});expect((await POST(req({query:'hello'},'aiosd_token'))).status).toBe(200);expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.visible).not.toHaveBeenCalled();expect(mocks.rate).toHaveBeenCalledWith({},'launcher:evidence-search',30);});
 it('bounds actual request and strict schema',async()=>{for(const b of ['x'.repeat(17000),'{bad',JSON.stringify({query:'hi',limit:0}),JSON.stringify({query:'hi',conversation_id:'x'})])expect((await POST(req(b))).status).toBe(422);expect(mocks.search).not.toHaveBeenCalled();});
 it('rate limits before retrieval',async()=>{mocks.rate.mockResolvedValue({allowed:false,retryAfterSeconds:15});const r=await POST(req({query:'hello'}));expect(r.status).toBe(429);expect(r.headers.get('Retry-After')).toBe('15');expect(mocks.search).not.toHaveBeenCalled();});
});
