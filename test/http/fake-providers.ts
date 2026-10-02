import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
// Type-only and erased at runtime (the global setup must not load vitest's runtime). A `declare module`
// augmentation never adds its target to the TS program, and `test/` is tsconfig-excluded, so this import
// is what makes `vitest` resolvable for the ProvidedContext augmentation below under `tsc --noEmit`.
import type {} from "vitest";

/**
 * TEST-ONLY loopback fakes for the opt-in TIERRET-1 query harness (`vitest.tierret1-query.config.ts`).
 * Never imported by product code or by the ordinary HTTP tier, whose no-LLM contract is unchanged.
 *
 *   - fake OpenAI-compatible endpoint: `POST /v1/chat/completions`. `stream: true` → a valid SSE answer
 *     (one content delta, a usage frame, `[DONE]`); otherwise a non-streaming JSON completion (title
 *     path). Every request body is captured. `/__anthropic_trap/*` is where the server's
 *     ANTHROPIC_BASE_URL points, so an Anthropic fallback is RECORDED and refused instead of leaving the
 *     machine.
 *   - fake Graphiti: `POST /search` captured and answered `{ facts: [] }`; `/healthcheck` ok.
 *
 * Both bind 127.0.0.1 on an ephemeral port and expose `GET /__fake/captured` + `POST /__fake/reset` so the
 * test worker (a different process from the global setup that owns them) can read what the server sent.
 */

declare module "vitest" {
  export interface ProvidedContext {
    tierret1FakeLlmUrl: string;
    tierret1FakeGraphitiUrl: string;
  }
}

export const FAKE_MODEL = "tierret1-fake-model";
export const FAKE_ANSWER = "Fake loopback answer [S1].";

export interface CapturedChat {
  path: string;
  authorization: string | null;
  body: { model?: string; stream?: boolean; messages?: { role: string; content: string }[] } & Record<string, unknown>;
}
export interface LlmCaptured {
  chat: CapturedChat[];
  anthropicTrap: string[];
  unexpected: string[];
}
export interface GraphCaptured {
  search: { query: string; group_ids: string[]; max_facts?: number }[];
  other: string[];
}

export interface FakeServer {
  url: string;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<FakeServer> {
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function startFakeLlm(): Promise<FakeServer> {
  let captured: LlmCaptured = { chat: [], anthropicTrap: [], unexpected: [] };
  return listen(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/__fake/captured") return json(res, 200, captured);
    if (req.method === "POST" && url === "/__fake/reset") {
      captured = { chat: [], anthropicTrap: [], unexpected: [] };
      return json(res, 200, { ok: true });
    }
    if (url.startsWith("/__anthropic_trap")) {
      captured.anthropicTrap.push(`${req.method} ${url}`);
      await readBody(req);
      return json(res, 500, { error: { type: "tierret1_trap", message: "Anthropic fallback is forbidden in this harness" } });
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req)) as CapturedChat["body"];
      captured.chat.push({ path: url, authorization: req.headers.authorization ?? null, body });
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: FAKE_ANSWER } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      return json(res, 200, {
        choices: [{ index: 0, message: { role: "assistant", content: "Fake title" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    }
    captured.unexpected.push(`${req.method} ${url}`);
    await readBody(req);
    return json(res, 404, { error: "unexpected fake LLM path" });
  });
}

export function startFakeGraphiti(): Promise<FakeServer> {
  let captured: GraphCaptured = { search: [], other: [] };
  return listen(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/__fake/captured") return json(res, 200, captured);
    if (req.method === "POST" && url === "/__fake/reset") {
      captured = { search: [], other: [] };
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url === "/healthcheck") return json(res, 200, { status: "healthy" });
    if (req.method === "POST" && url === "/search") {
      captured.search.push(JSON.parse(await readBody(req)) as GraphCaptured["search"][number]);
      return json(res, 200, { facts: [] });
    }
    captured.other.push(`${req.method} ${url}`);
    await readBody(req);
    return json(res, 200, {});
  });
}

/**
 * Credentials and optional outbound endpoints blanked in the `next start` child (and in the seeding test
 * process). Set to "" rather than deleted: Next.js reads `process.env` FIRST and stops once a variable
 * is found, so an empty value also stops a local `.env*` file from re-supplying a real key.
 */
const SCRUBBED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "EMBEDDINGS_URL",
  "EMBEDDINGS_API_KEY",
  "RERANK_URL",
  "RERANK_TOKEN",
  "RETRIEVAL_AUGMENT_URL",
  "RETRIEVAL_AUGMENT_TOKEN",
  "NEO4J_URL",
  "NEO4J_USER",
  "NEO4J_PASSWORD",
  "GRAPH_LLM_PROXY_SECRET",
  "RESEND_API_KEY",
  "SMTP_URL",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "STAGING_DATA_MODE",
  "STAGING_OPS_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_ID",
  "STAGING_QUERY_LLM_ENABLED",
  "STAGING_QUERY_LLM_BUDGET_USD",
];
/** Harness secrets the server legitimately needs (fixed test values set by vitest.http.config.ts). */
const KEEP = new Set(["AUTH_SECRET", "SECRETS_KEY", "DATABASE_URL", "DATABASE_TEST_URL"]);
const SECRET_SHAPED = /(API_KEY|_TOKEN|_SECRET|PASSWORD)$/;

export function scrubbedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SCRUBBED) out[k] = "";
  for (const k of Object.keys(base)) if (SECRET_SHAPED.test(k) && !KEEP.has(k)) out[k] = "";
  return out;
}

function assertLoopback(name: string, value: string): void {
  if (!value) throw new Error(`TIERRET-1 query harness: ${name} must be a non-empty loopback URL`);
  if (new URL(value).hostname !== "127.0.0.1") throw new Error(`TIERRET-1 query harness: ${name} must be loopback, got ${value}`);
}

/** The exact environment the `next start` child receives. Pins every model/graph endpoint to loopback. */
export function queryServerEnv(base: NodeJS.ProcessEnv, fakes: { llmUrl: string; graphitiUrl: string }, port: string): NodeJS.ProcessEnv {
  const pins = {
    // Answering: `teams.answering_provider = 'local'` + this non-empty LLM_BASE_URL selects the fake.
    LLM_BASE_URL: `${fakes.llmUrl}/v1`,
    LLM_MODEL: FAKE_MODEL,
    // Any Anthropic fallback (e.g. an empty local URL) lands on the recorded trap, never the network.
    ANTHROPIC_BASE_URL: `${fakes.llmUrl}/__anthropic_trap`,
    // Graph read leg → the fake /search spy. The projector stays off: this harness tests reads only.
    GRAPHITI_URL: fakes.graphitiUrl,
    GRAPH_PROJECT_ENABLED: "false",
    INGEST_POLL_ENABLED: "false",
    SOCIAL_JOBS_ENABLED: "false",
    CONTEXT_PROVIDER: "native",
  };
  assertLoopback("LLM_BASE_URL", pins.LLM_BASE_URL);
  assertLoopback("ANTHROPIC_BASE_URL", pins.ANTHROPIC_BASE_URL);
  assertLoopback("GRAPHITI_URL", pins.GRAPHITI_URL);
  return { ...base, ...scrubbedEnv(base), ...pins, PORT: port };
}
