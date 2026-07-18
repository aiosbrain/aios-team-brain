import "server-only";
import { completeTextOrNull } from "@/lib/llm/complete";
import { normalizeSummaryField } from "@/lib/meetings/summary-format";
import type { LlmBackendKeys } from "@/lib/query/llm-backend";

/**
 * LLM-assisted meeting-note parsing: a short summary + which roster members were likely present,
 * inferred from the transcript text. Routes through the shared, settings-aware `lib/llm/complete`
 * primitive, so it honors the team's answering-provider setting (incl. OpenRouter) exactly like the
 * Query box. Never throws: any transport failure or unparseable response degrades to "no summary,
 * no attendees" so an upload never fails because the LLM is unavailable.
 */

/** Full backend keys — resolve via `lib/query/answering.resolveAnsweringKeys` at the call site. */
export type ProviderKeys = LlmBackendKeys;

export interface RosterPerson {
  id: string;
  displayName: string;
}

export interface TranscriptExtraction {
  summary: string;
  attendeeMemberIds: string[];
}

// Keep the prompt bounded — a meeting transcript can be very long, and this is a one-shot
// summary/attendee pass, not a full-fidelity read (the full text is still stored verbatim in
// `items` regardless of what the LLM sees).
const MAX_TRANSCRIPT_CHARS = 15_000;

const SYSTEM_PROMPT =
  "You are reading a meeting transcript or notes document. Produce two things:\n" +
  "(1) A DETAILED but SKIMMABLE summary as a bulleted list — 4 to 8 bullets. Each bullet is ONE " +
  "specific point: a topic discussed, a decision made, a problem or blocker raised, or a next step. " +
  "Present tense, concrete, no filler or generic phrasing. Each bullet MUST start with '- ' and be " +
  "on its own line.\n" +
  "(2) The full names of every person who appears to have attended or spoken, exactly as they're " +
  "referred to in the text.\n" +
  'Return ONLY a JSON object of the form {"summary":"- ...\\n- ...","attendees":["Full Name", ...]}. ' +
  "No prose outside the JSON, no markdown code fences. If you can't tell who attended, return an " +
  "empty attendees array — never guess.";

export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * Meetings extraction is a background, best-effort pass — not the interactive query box — so it gets
 * a more generous timeout than `completeText`'s 30s default. Reasoning models a team may select
 * (e.g. qwen via OpenRouter) can spend 30–45s on a full transcript; at 30s the call was aborted and
 * the summary/attendees/action-items silently came back empty. 60s covers the observed latency while
 * still bounding a truly wedged provider. The backfill can pass a larger value for slow networks.
 */
export const MEETINGS_LLM_TIMEOUT_MS = 60_000;

/**
 * Token budget for the meetings passes. A detailed 4–8 bullet summary + attendees on a long
 * transcript can run past 1024 tokens; when it did, the JSON was cut off mid-string and `JSON.parse`
 * threw → the note saved blank. 2048 gives headroom, and `salvageSummaryBullets` backstops the rare
 * overrun that still truncates.
 */
export const MEETINGS_LLM_MAX_TOKENS = 2048;

/**
 * Best-effort JSON completion for the meetings LLM passes (summary/attendees AND action items),
 * through the shared settings-aware primitive. Never throws — any transport failure returns null so
 * a caller degrades gracefully.
 */
export async function callMeetingsLLM(
  system: string,
  userContent: string,
  keys: ProviderKeys,
  timeoutMs: number = MEETINGS_LLM_TIMEOUT_MS
): Promise<string | null> {
  return completeTextOrNull(
    { system, prompt: userContent },
    { keys, jsonObject: true, maxTokens: MEETINGS_LLM_MAX_TOKENS, timeoutMs }
  );
}

/**
 * Recover complete bullet lines from a malformed or truncated meetings JSON response. Some models
 * emit the summary as bare comma-separated strings (`{"summary":"- a","- b"}`, invalid JSON) or
 * overrun the token limit and cut off mid-string. Both make `JSON.parse` throw. This scavenges every
 * COMPLETE double-quoted string that reads as a bullet (a truncated trailing string has no closing
 * quote, so it's naturally excluded) — enough to still show a summary instead of a blank.
 */
export function salvageSummaryBullets(raw: string): string[] {
  const bullets: string[] = [];
  const stringLiteral = /"(?:[^"\\]|\\.)*"/g; // complete quoted strings only
  let m: RegExpExecArray | null;
  while ((m = stringLiteral.exec(raw)) !== null) {
    let value: unknown;
    try {
      value = JSON.parse(m[0]); // unescape \n, \" etc.
    } catch {
      continue;
    }
    if (typeof value === "string" && /^\s*[-*•]\s+/.test(value)) bullets.push(value.trim());
  }
  return bullets;
}

/**
 * Recover attendee names from a malformed/truncated meetings JSON response — the companion to
 * `salvageSummaryBullets`. Without this, a salvaged upload kept its summary but silently lost attendee
 * linking even when the `attendees` array was complete in the response. Scoped to the strings inside
 * the `"attendees":[ … ]` array (bounded at the first `]`, else whatever arrived before truncation) so
 * summary bullets aren't mistaken for names; a truncated trailing name has no closing quote and is
 * dropped. Returned names are still filtered against the real roster by `matchAttendees`, so junk can't
 * invent an attendee. Pure + exported for tests.
 */
export function salvageAttendeeNames(raw: string): string[] {
  const marker = raw.search(/"attendees"\s*:\s*\[/);
  if (marker === -1) return [];
  const afterOpen = raw.slice(raw.indexOf("[", marker) + 1);
  const close = afterOpen.indexOf("]");
  const body = close === -1 ? afterOpen : afterOpen.slice(0, close);
  const names: string[] = [];
  for (const m of body.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const v: unknown = JSON.parse(m[0]);
      if (typeof v === "string" && v.trim()) names.push(v.trim());
    } catch {
      /* skip an unparseable literal */
    }
  }
  return names;
}

/** Normalize a name for tolerant matching: lowercase, collapse whitespace, drop punctuation. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Match LLM-reported attendee names against the team roster. Exact (normalized) match on display
 * name, then a loose "first name matches and it's unambiguous" fallback (handles "hey it's just
 * Alex" vs a roster display name of "Alex Rivera"). Anything that doesn't resolve is dropped —
 * never invented, never blocks the upload.
 */
export function matchAttendees(names: string[], roster: RosterPerson[]): string[] {
  const byExact = new Map(roster.map((p) => [normalizeName(p.displayName), p.id]));
  const matched = new Set<string>();

  for (const raw of names) {
    const norm = normalizeName(raw);
    if (!norm) continue;
    const exact = byExact.get(norm);
    if (exact) {
      matched.add(exact);
      continue;
    }
    const firstWord = norm.split(" ")[0];
    const candidates = roster.filter((p) => normalizeName(p.displayName).split(" ")[0] === firstWord);
    if (candidates.length === 1) matched.add(candidates[0].id);
  }
  return [...matched];
}

/**
 * Summarize a transcript and infer attendees from the team roster. Best-effort — returns an empty
 * result (never throws) on any LLM failure or unparseable response.
 */
export async function extractFromTranscript(
  rawText: string,
  roster: RosterPerson[],
  keys: ProviderKeys,
  timeoutMs?: number
): Promise<TranscriptExtraction> {
  const empty: TranscriptExtraction = { summary: "", attendeeMemberIds: [] };
  const truncated = rawText.slice(0, MAX_TRANSCRIPT_CHARS);
  const rosterHint = roster.length
    ? `\n\nKnown team members (for reference, not exhaustive): ${roster.map((p) => p.displayName).join(", ")}.`
    : "";
  const raw = await callMeetingsLLM(SYSTEM_PROMPT, `Transcript:\n\n${truncated}${rosterHint}`, keys, timeoutMs);
  if (!raw) return empty;
  return parseTranscriptExtraction(raw, roster);
}

/**
 * Pure parse of the meetings LLM response into a summary + matched attendees. Split out from the
 * transport so it's unit-testable without a live model and so the summary/attendee shape handling
 * (see `normalizeSummaryField` — models differ on string-vs-array `summary`) has one home. Never
 * throws: unparseable/oddly-shaped responses degrade to an empty extraction.
 */
export function parseTranscriptExtraction(raw: string, roster: RosterPerson[]): TranscriptExtraction {
  const empty: TranscriptExtraction = { summary: "", attendeeMemberIds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    // Malformed (bullets as bare comma-separated strings) or token-truncated JSON — recover whatever
    // complete bullets we can rather than saving the note blank. Need ≥2 to count as a real summary.
    const salvaged = salvageSummaryBullets(raw);
    if (salvaged.length >= 2) {
      // Salvage attendees too — they're often complete even when the summary string was truncated;
      // matchAttendees still filters to the real roster, so nothing is invented.
      const names = salvageAttendeeNames(raw);
      console.warn(
        `[meetings] recovered from malformed/truncated JSON (${salvaged.length} bullets, ${names.length} attendee names)`
      );
      return { summary: normalizeSummaryField(salvaged), attendeeMemberIds: matchAttendees(names, roster) };
    }
    console.error("[meetings] LLM response was not valid JSON:", err instanceof Error ? err.message : err, raw.slice(0, 300));
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const obj = parsed as { summary?: unknown; attendees?: unknown };
  const summary = normalizeSummaryField(obj.summary);
  const names = Array.isArray(obj.attendees) ? obj.attendees.filter((n): n is string => typeof n === "string") : [];

  return { summary, attendeeMemberIds: matchAttendees(names, roster) };
}
