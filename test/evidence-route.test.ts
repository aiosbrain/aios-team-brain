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

/**
 * THE REQUEST-STREAM BOUNDARY. The 16,384-byte cap is counted over ACTUAL chunks (never Content-Length),
 * the decoder is streaming so a multi-byte character split across chunks survives, an oversized body is
 * cancelled, and the reader's lock is released whatever happens. A rejected `read()` or `cancel()` is a
 * failure of the request, not a place to leak an exception: both reach the route's one generic 500.
 */
const streamRequest = (reader: Partial<ReadableStreamDefaultReader<Uint8Array>>) => ({
  headers: new Headers({ authorization: 'Bearer key' }),
  body: { getReader: () => reader },
} as unknown as Parameters<typeof POST>[0]);

/** A reader over fixed chunks, with spies for the calls the route must make. */
function chunkReader(chunks: Uint8Array[], { failRead = false, failCancel = false } = {}) {
  let at = 0;
  const releaseLock = vi.fn();
  const cancel = vi.fn(async () => { if (failCancel) throw new Error('cancel exploded with a private detail'); });
  const read = vi.fn(async () => {
    if (failRead) throw new Error('read exploded with a private detail');
    return at < chunks.length ? { done: false, value: chunks[at++] } : { done: true, value: undefined };
  });
  return { reader: { read, cancel, releaseLock } as unknown as ReadableStreamDefaultReader<Uint8Array>, read, cancel, releaseLock };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe('evidence API request-stream bounds', () => {
  it('a rejected read reaches the generic 500, leaks no message, and releases the lock', async () => {
    const { reader, releaseLock } = chunkReader([], { failRead: true });
    const response = await POST(streamRequest(reader));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private detail');
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('a rejected cancel on an oversized body does the same', async () => {
    const { reader, releaseLock, cancel } = chunkReader([encode('x'.repeat(16385))], { failCancel: true });
    const response = await POST(streamRequest(reader));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private detail');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('a successful cancel on an oversized body is the existing 422', async () => {
    const { reader, releaseLock, cancel } = chunkReader([encode('x'.repeat(8200)), encode('x'.repeat(8200))]);
    const response = await POST(streamRequest(reader));
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('request too large');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('accepts a body at EXACTLY the cap and refuses one byte more', async () => {
    // Valid JSON padded with trailing whitespace: the schema stays satisfied (a 16 KB query would not
    // be), so what the boundary actually measures is the BYTE cap.
    const pad = (total: number) => {
      const envelope = JSON.stringify({ query: 'hello' });
      return envelope + ' '.repeat(total - envelope.length);
    };
    const exact = pad(16384);
    expect(Buffer.byteLength(exact)).toBe(16384);
    const atCap = chunkReader([encode(exact)]);
    expect((await POST(streamRequest(atCap.reader))).status).toBe(200);
    expect(atCap.cancel).not.toHaveBeenCalled();
    const over = chunkReader([encode(pad(16385))]);
    expect((await POST(streamRequest(over.reader))).status).toBe(422);
  });

  it('decodes a multi-byte character SPLIT across two chunks', async () => {
    const payload = encode(JSON.stringify({ query: 'héllo wörld' }));
    const cut = 12; // inside the two-byte `é`
    const split = chunkReader([payload.subarray(0, cut), payload.subarray(cut)]);
    expect((await POST(streamRequest(split.reader))).status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith(expect.anything(), 't', 'team', 'héllo wörld', undefined, 8, expect.anything());
  });

  it('an empty stream is refused as unparseable, not treated as an empty query', async () => {
    const empty = chunkReader([]);
    const response = await POST(streamRequest(empty.reader));
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('body must be JSON');
    expect(empty.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
