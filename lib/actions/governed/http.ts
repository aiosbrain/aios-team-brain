import "server-only";
import { authenticateApiKey } from "@/lib/api/auth";
import { governedActions, GovernedError, type ActionStatus } from "./index";
const MAX_BYTES = 256 * 1024;
class BodyLimitError extends GovernedError {
  constructor() {
    super("invalid_payload", 422);
  }
}
async function body(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new GovernedError("invalid_payload", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > MAX_BYTES) {
        // Leave unread bytes to the closing connection. Cancelling the incoming
        // Node stream can tear down its socket before the response is flushed;
        // keeping it alive instead can make the next request reuse that socket.
        // Do not drain or retain the remainder of an unbounded request.
        throw new BodyLimitError();
      }
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof BodyLimitError) throw error;
    throw new GovernedError("invalid_payload", 422);
  } finally {
    reader.releaseLock();
  }
}
function response(value: unknown, status: number, closeConnection = false) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(closeConnection ? { Connection: "close" } : {}),
      ...(status === 503 ? { "Retry-After": "1" } : {}),
    },
  });
}
export function errorResponse(error: unknown) {
  const safe =
    error instanceof GovernedError
      ? error
      : new GovernedError("unavailable", 503);
  return response(
    { error: safe.detail },
    safe.status,
    error instanceof BodyLimitError,
  );
}
function submitStatus(r: ActionStatus) {
  return {
    succeeded: 200,
    requested: 202,
    running: 202,
    pending_approval: 202,
    denied: 403,
    conflict: 409,
    failed: 422,
  }[r.status];
}
/** Injection is for composition, never selected by an HTTP header or runtime fixture flag. */
export function createGovernedActionHttp(service = governedActions) {
  return {
    async submit(req: Request) {
      try {
        const auth = await authenticateApiKey(req, {
          recordUsage: false,
          preserveErrors: true,
        });
        if (!auth) throw new GovernedError("unauthorized", 401);
        const result = await service.submit(auth, await body(req));
        return response(result, submitStatus(result));
      } catch (e) {
        return errorResponse(e);
      }
    },
    async status(req: Request, actionId: string) {
      try {
        const auth = await authenticateApiKey(req, {
          recordUsage: false,
          preserveErrors: true,
        });
        if (!auth) throw new GovernedError("unauthorized", 401);
        return response(await service.status(auth, actionId), 200);
      } catch (e) {
        return errorResponse(e);
      }
    },
  };
}
export const governedActionHttp = createGovernedActionHttp();
