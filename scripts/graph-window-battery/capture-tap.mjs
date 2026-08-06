/**
 * The battery's capture tap (PIPEFF-2 / AIO-821).
 *
 * Phase A has to measure the SIZE of the predecessor block that every extraction call carries — the
 * parent spec's ~6,250 tokens is derived, not observed. Nothing stores prompts: neither
 * `lib/llm/graph-proxy` nor `llm_usage` keeps a request body, and this spec is not going to add
 * prompt storage to a production path in order to run an experiment.
 *
 * So the tap sits BETWEEN graphiti and the local brain:
 *
 *     graphiti  ──►  this tap  ──►  brain /api/internal/llm/v1/*  ──►  provider
 *                      │
 *                      └── appends each request body to a JSONL
 *
 * It forwards **byte-for-byte** and changes nothing — no header rewriting, no body reshaping, no
 * retries of its own. That matters: metering must still traverse the production path
 * (`graph-proxy` → `classifyGraphCall` → `recordLlmUsage`), so the `llm_usage` rows the cost harness
 * reads are the real ones, produced by the real code. A tap that "helpfully" normalised anything
 * would measure a pipeline that does not exist.
 *
 * It is also fail-loud rather than fail-open: if the capture file cannot be written, the tap exits
 * instead of quietly forwarding unrecorded traffic, because a Phase A run that silently captured
 * nothing looks exactly like one that captured a clean zero.
 *
 * Usage:
 *   TAP_PORT=3099 BRAIN_URL=http://localhost:3000 CAPTURE_FILE=/tmp/gwb/capture-w10.jsonl \
 *   node scripts/graph-window-battery/capture-tap.mjs
 *
 * Then point graphiti at it:  OPENAI_BASE_URL=http://host.docker.internal:3099/v1
 */
import { createServer } from "node:http";
import { appendFileSync, openSync, closeSync } from "node:fs";

const PORT = Number(process.env.TAP_PORT ?? 3099);
const BRAIN_URL = (process.env.BRAIN_URL ?? "http://localhost:3000").replace(/\/$/, "");
const CAPTURE_FILE = process.env.CAPTURE_FILE;
const ARM = process.env.ARM ?? "unknown";

if (!CAPTURE_FILE) {
  console.error("CAPTURE_FILE is required — a tap that captures nothing is worse than no tap");
  process.exit(1);
}
// Prove writability NOW. Discovering it at the first request means the run is already burning money.
try {
  closeSync(openSync(CAPTURE_FILE, "a"));
} catch (err) {
  console.error(`cannot write ${CAPTURE_FILE}: ${err.message}`);
  process.exit(1);
}

let captured = 0;
let forwarded = 0;
let failed = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);

    // `/v1/chat/completions` from the OpenAI SDK → the brain's internal proxy at the same suffix.
    const target = `${BRAIN_URL}/api/internal/llm/v1${req.url.replace(/^\/v1/, "")}`;

    // Capture BEFORE forwarding, so a call that errors downstream is still in the record. A capture
    // that only holds successful calls would understate exactly the population Q5 exists to watch.
    try {
      appendFileSync(
        CAPTURE_FILE,
        JSON.stringify({ arm: ARM, at: new Date().toISOString(), path: req.url, body: JSON.parse(raw.toString("utf8") || "{}") }) + "\n"
      );
      captured++;
    } catch {
      // Deliberately fatal — see the header.
      console.error("capture write failed; exiting rather than forwarding unrecorded traffic");
      process.exit(1);
    }

    try {
      const headers = { ...req.headers };
      delete headers.host; // the only rewrite, and it is a transport necessity
      delete headers["content-length"];
      const upstream = await fetch(target, { method: req.method, headers, body: raw.length ? raw : undefined });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(buf);
      forwarded++;
    } catch (err) {
      failed++;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `tap could not reach the brain: ${err.message}` } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`tap [${ARM}] :${PORT} → ${BRAIN_URL}/api/internal/llm/v1  ·  capturing to ${CAPTURE_FILE}`);
});

const report = () => console.log(`\ntap [${ARM}]: ${captured} captured · ${forwarded} forwarded · ${failed} failed`);
process.on("SIGINT", () => {
  report();
  process.exit(0);
});
process.on("SIGTERM", () => {
  report();
  process.exit(0);
});
