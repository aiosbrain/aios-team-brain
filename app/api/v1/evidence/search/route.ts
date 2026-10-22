import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminClient } from '@/lib/db/admin';
import { authenticateApiKey, authenticateAgentToken, isAgentBearer } from '@/lib/api/auth';
import { rateLimitWithReset } from '@/lib/api/rate-limit';
import { errorResponse } from '@/lib/api/schemas';
import { visibleItemIds, delegatedVisibleItemIds } from '@/lib/access/enforce';
import { searchEvidence } from '@/lib/query/evidence';

export const runtime = 'nodejs';
export const maxDuration = 15;
const schema = z.object({ query: z.string().trim().min(1).max(2000), project: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(20).default(8) }).strict();

export async function POST(req: NextRequest) {
  const started = Date.now();
  try {
    const delegated = isAgentBearer(req);
    const agent = delegated ? await authenticateAgentToken(req) : null;
    const member = delegated ? null : await authenticateApiKey(req);
    const auth = agent ?? member;
    if (!auth) return errorResponse('unauthorized', 'invalid credential or team', 401);
    const db = adminClient();
    const rate = await rateLimitWithReset(db, `${auth.memberId}:evidence-search`, 30);
    if (!rate.allowed) {
      const response = errorResponse('rate_limited', '30 evidence searches/min per member', 429);
      response.headers.set('Retry-After', String(rate.retryAfterSeconds));
      return response;
    }
    // Bound actual request bytes, including chunked bodies; do not trust Content-Length.
    const reader = req.body?.getReader(); let bytes = 0; let body = '';
    const decoder = new TextDecoder();
    if (reader) try {
      // The termination condition is the READ RESULT itself, not a `while (true)` with a break: the
      // first read happens inside this try/finally (so a rejection still releases the lock and still
      // reaches the route's one generic catch), and each iteration updates the state it loops on.
      let read = await reader.read();
      while (!read.done) {
        bytes += read.value.byteLength;
        if (bytes > 16384) { await reader.cancel(); return errorResponse('invalid_payload', 'request too large', 422); }
        body += decoder.decode(read.value, {stream:true});
        read = await reader.read();
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    let json: unknown;
    try { json = JSON.parse(body); } catch { return errorResponse('invalid_payload', 'body must be JSON', 422); }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return errorResponse('invalid_payload', 'query required (1–2000 characters), limit 1–20', 422);
    const view = agent ? await delegatedVisibleItemIds(db, agent) : await visibleItemIds(db, {teamId:auth.teamId, memberId:auth.memberId});
    if (view.error) return errorResponse('internal', 'enforcement check failed', 500);
    const {query,project,limit} = parsed.data;
    const result = await searchEvidence(db, auth.teamId, auth.memberTier, query, project, limit, view.ids);
    console.info(JSON.stringify({event:'evidence_search',duration_ms:Date.now()-started,result_count:result.returned}));
    return new Response(JSON.stringify(result), {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  } catch {
    console.warn(JSON.stringify({event:'evidence_search_failed',duration_ms:Date.now()-started}));
    return errorResponse('internal', 'evidence search failed', 500);
  }
}
