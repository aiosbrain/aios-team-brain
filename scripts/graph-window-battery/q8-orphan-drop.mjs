#!/usr/bin/env node
/**
 * Q8′ — the orphan-drop loss rate of the COMBINED arm (PIPEFF-5 / AIO-868).
 *
 * WHY THIS METRIC EXISTS. Upstream's docstring says combined extraction "reduc[es] orphaned nodes".
 * It does — by DELETING them: `combined_extraction.py:295` drops every extracted node with no
 * incident edge, behind a `logger.debug`. So "orphan rate in the graph" cannot fail as a sensor, and
 * raw entity yield falls mechanically for a reason that is not quality. The real question is the one
 * this file answers: **is the candidate discarding more than the incumbent was already failing to
 * connect?** Prod's incumbent orphan share, measured 2026-08-16, is 7.1% (1,356 of 19,051).
 *
 * WHAT IT COMPUTES, and why from the response rather than the graph. The drop happens inside Python
 * before anything is written, so the graph cannot show it. The capture tap's RESPONSE record is the
 * only place the pre-drop list exists. Loss rate is computed from that response alone —
 * entities the model returned that NO returned edge references — which isolates the mechanical drop
 * from dedupe/resolution effects downstream. It mirrors `combined_extraction.py:181-189`: names are
 * matched after `_normalize_string_exact` (lowercase, collapse whitespace, trim), on BOTH sides.
 *
 * WHAT IT REFUSES, and why refusal beats a number. Every refusal below produces an UNMEASURABLE
 * verdict, never a low loss rate. A plausible wrong number here is worse than nothing: it would be
 * read as "the candidate discards little", which is the exact claim the gate exists to test.
 *   * a DUPLICATE id            — a tap restart could reissue ids; pairing would then cross
 *                                 incarnations and silently mis-pair a request with another's
 *                                 response. Salting makes this unlikely, not impossible.
 *   * an UNPAIRED request       — the response capture is deliberately non-fatal (it fires after the
 *                                 money is spent), so a lost response must surface here.
 *   * a response that does not PARSE as CombinedExtraction — an unrecognised shape is reported, never
 *                                 folded into a zero. This is the parser-that-matches-nothing lesson.
 *   * ZERO combined calls       — the arm did not run the patch at all.
 *
 * Usage:  node scripts/graph-window-battery/q8-orphan-drop.mjs <capture.jsonl> [...]
 */
import { readFileSync } from "node:fs";

/** Mirrors graphiti's `_normalize_string_exact`. */
export function normalizeExact(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this request body a combined-extraction call? Keyed on the same prefix the cost classifier uses. */
export const COMBINED_PREFIX =
  "You are an expert knowledge graph extraction specialist for an AI agent memory system.";

export function isCombinedRequest(body) {
  const sys = body?.messages?.find?.((m) => m.role === "system")?.content;
  return typeof sys === "string" && sys.startsWith(COMBINED_PREFIX);
}

/** Pull the model's JSON payload out of a chat-completions response. */
export function parseCombinedPayload(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  try {
    const o = JSON.parse(content);
    if (!Array.isArray(o?.extracted_entities) || !Array.isArray(o?.edges)) return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Orphans in ONE combined response: entities no returned edge references.
 * Returns { raw, orphans } or null when the payload shape is unrecognised.
 */
export function orphansIn(payload) {
  const raw = payload.extracted_entities.length;
  const referenced = new Set();
  for (const e of payload.edges) {
    referenced.add(normalizeExact(e?.source_entity_name));
    referenced.add(normalizeExact(e?.target_entity_name));
  }
  let orphans = 0;
  for (const ent of payload.extracted_entities) {
    const name = normalizeExact(typeof ent === "string" ? ent : ent?.name);
    if (!referenced.has(name)) orphans++;
  }
  return { raw, orphans };
}

/**
 * The whole harvest, pure over already-parsed records so it is testable without files.
 * Returns { ok: true, raw, orphans, share, calls } or { ok: false, refusal }.
 */
export function assessQ8(records) {
  const requests = new Map();
  const responses = new Map();
  for (const r of records) {
    const bucket = r.kind === "response" ? responses : requests;
    if (r.kind !== "response" && r.kind !== "request") {
      return { ok: false, refusal: `unrecognised record kind ${JSON.stringify(r.kind)} — refusing rather than guessing` };
    }
    if (r.id === undefined) {
      return { ok: false, refusal: "a record has no id — this capture predates response pairing and cannot support Q8'" };
    }
    if (bucket.has(r.id)) {
      return {
        ok: false,
        refusal: `duplicate ${r.kind} id ${r.id} — pairing would cross tap incarnations and could match one call's request to another's response`,
      };
    }
    bucket.set(r.id, r);
  }

  let raw = 0;
  let orphans = 0;
  let calls = 0;
  for (const [id, req] of requests) {
    if (!isCombinedRequest(req.body)) continue;
    calls++;
    const res = responses.get(id);
    if (!res) {
      return { ok: false, refusal: `combined-extraction request ${id} has no paired response — the response capture is non-fatal, so a loss must refuse here, not read as zero` };
    }
    const payload = parseCombinedPayload(res.body);
    if (payload === null) {
      return { ok: false, refusal: `response ${id} does not parse as a CombinedExtraction payload — an unrecognised shape is reported, never folded into a zero` };
    }
    const o = orphansIn(payload);
    raw += o.raw;
    orphans += o.orphans;
  }

  if (calls === 0) {
    return { ok: false, refusal: "no combined-extraction calls in this capture — the arm did not run PATCH 4" };
  }
  if (raw === 0) {
    return { ok: false, refusal: `${calls} combined calls returned zero entities in total — a share over an empty denominator is not a measurement` };
  }
  return { ok: true, raw, orphans, share: orphans / raw, calls };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: q8-orphan-drop.mjs <capture.jsonl> [...]");
    process.exit(1);
  }
  const records = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  );
  const out = assessQ8(records);
  if (!out.ok) {
    console.error(`Q8' UNMEASURABLE — ${out.refusal}`);
    process.exit(2);
  }
  console.log(`\nQ8' orphan-drop loss rate — ${files.length} capture file(s), ${out.calls} combined calls\n`);
  console.log(`  entities returned by the model : ${out.raw}`);
  console.log(`  dropped as orphans (no edge)   : ${out.orphans}`);
  console.log(`  LOSS RATE                      : ${(out.share * 100).toFixed(2)}%`);
  console.log(`\n  FAIL if this exceeds the battery incumbent's orphan share (prod prior: 7.1%).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
