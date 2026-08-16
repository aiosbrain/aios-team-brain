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
// PIPEFF-5: response-capture counters, reported at shutdown beside the request ones so a run that
// silently lost responses is visible in the tap's own summary and not only at harvest.
let responsesCaptured = 0;
let responsesLost = 0;
// Monotonic within a process, SALTED with the process's start time across processes.
//
// A bare counter was wrong, and the way it was wrong is the failure this id exists to prevent: the
// writability probe opens CAPTURE_FILE in append mode, so the file survives a tap restart, and a
// restarted tap would begin again at `${ARM}-0`. Two incarnations would then write the same ids into
// one JSONL, and a Q8' harvest pairing by id could pair incarnation 1's REQUEST with incarnation 2's
// RESPONSE — yielding a plausible, wrong orphan-drop rate on a paid run rather than a refusal.
//
// Salting rather than refusing a non-empty file: a mid-run restart is a legitimate recovery (the last
// battery needed several), and making recovery fatal would trade a silent-wrong-number risk for a
// lose-the-run risk. The harvest closes the remaining gap by REFUSING on any duplicate id.
const TAP_EPOCH = Date.now().toString(36);
let nextCallId = 0;

const server = createServer((req, res) => {
  const chunks = [];
  const callId = `${ARM}-${TAP_EPOCH}-${nextCallId++}`;
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
        JSON.stringify({ arm: ARM, at: new Date().toISOString(), id: callId, kind: "request", path: req.url, body: JSON.parse(raw.toString("utf8") || "{}") }) + "\n"
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

      // PIPEFF-5: the RESPONSE, paired to its request by `id`. Q8' (orphan-drop loss rate) needs the
      // model's raw entity list BEFORE `combined_extraction.py` deletes the unconnected ones, and
      // that list exists nowhere else — not in `llm_usage`, not in the graph.
      //
      // NON-FATAL, unlike the request capture above, and the asymmetry is deliberate. The request
      // write fires BEFORE forwarding, so failing it means unrecorded traffic would reach a paid
      // model — that guards spend integrity and must keep killing the process. This one fires AFTER
      // the money is spent, where exiting would turn a transient write error into an aborted paid
      // run with nothing to show for it. Silent loss is prevented instead by the `id` pairing: the
      // Q8' harvest REFUSES on any combined-extraction request with no paired response, so an
      // unmeasurable Q8' reads as a refusal rather than as a low loss rate.
      try {
        appendFileSync(
          CAPTURE_FILE,
          JSON.stringify({ arm: ARM, at: new Date().toISOString(), id: callId, kind: "response", status: upstream.status, body: JSON.parse(buf.toString("utf8") || "{}") }) + "\n"
        );
        responsesCaptured++;
      } catch {
        responsesLost++;
      }
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

const report = () =>
  console.log(
    `\ntap [${ARM}]: ${captured} captured · ${forwarded} forwarded · ${failed} failed · ` +
      `${responsesCaptured} responses captured · ${responsesLost} responses LOST`
  );
process.on("SIGINT", () => {
  report();
  process.exit(0);
});
process.on("SIGTERM", () => {
  report();
  process.exit(0);
});
