import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM-assisted meeting-note parsing: a short summary + which roster members were likely present,
 * inferred from the transcript text. Mirrors lib/graph/arcs.ts's provider pattern exactly
 * (OpenAI-compatible `chat/completions` when LLM_BASE_URL is set, else Anthropic Messages API) —
 * see that file for the rationale. Never throws: any transport failure or unparseable response
 * degrades to "no summary, no attendees" so an upload never fails because the LLM is unavailable.
 */

export interface ProviderKeys {
  openaiKey?: string | null;
  anthropicKey?: string | null;
}

export interface RosterPerson {
  id: string;
  displayName: string;
}

export interface TranscriptExtraction {
  summary: string;
  attendeeMemberIds: string[];
}

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o";
const ANTHROPIC_MODEL = process.env.MEETINGS_ANTHROPIC_MODEL ?? "claude-sonnet-5";
// Keep the prompt bounded — a meeting transcript can be very long, and this is a one-shot
// summary/attendee pass, not a full-fidelity read (the full text is still stored verbatim in
// `items` regardless of what the LLM sees).
const MAX_TRANSCRIPT_CHARS = 15_000;

const SYSTEM_PROMPT =
  "You are reading a meeting transcript or notes document. Write a concise 2-3 sentence summary " +
  "(present tense, specific — what was discussed/decided, not generic filler), and list the full " +
  "names of every person who appears to have attended or spoken, exactly as they're referred to in " +
  "the text. Return ONLY a JSON object of the form " +
  '{"summary":"...","attendees":["Full Name", ...]}. No prose, no markdown code fences — the raw ' +
  "JSON object only. If you can't tell who attended, return an empty attendees array — never guess.";

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end !== -1 && end > start ? body.slice(start, end + 1) : body;
}

async function callOpenAICompatible(userContent: string, apiKey?: string | null): Promise<string | null> {
  const res = await fetch(`${LLM_BASE_URL!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? process.env.OPENAI_API_KEY ?? "local"}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[meetings] LLM_BASE_URL call failed: ${res.status} ${res.statusText} —`,
      body.slice(0, 300)
    );
    return null;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? null;
}

async function callAnthropic(userContent: string, apiKey?: string | null): Promise<string | null> {
  const client = new Anthropic(apiKey ? { apiKey } : undefined);
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${userContent}\n\nReturn ONLY the JSON object.` }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : null;
}

async function callLLMRaw(userContent: string, keys: ProviderKeys): Promise<string | null> {
  try {
    return LLM_BASE_URL
      ? await callOpenAICompatible(userContent, keys.openaiKey)
      : await callAnthropic(userContent, keys.anthropicKey);
  } catch (err) {
    console.error("[meetings] LLM call failed:", err instanceof Error ? err.message : err);
    return null;
  }
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
  keys: ProviderKeys
): Promise<TranscriptExtraction> {
  const empty: TranscriptExtraction = { summary: "", attendeeMemberIds: [] };
  const truncated = rawText.slice(0, MAX_TRANSCRIPT_CHARS);
  const rosterHint = roster.length
    ? `\n\nKnown team members (for reference, not exhaustive): ${roster.map((p) => p.displayName).join(", ")}.`
    : "";
  const raw = await callLLMRaw(`Transcript:\n\n${truncated}${rosterHint}`, keys);
  if (!raw) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    console.error("[meetings] LLM response was not valid JSON:", err instanceof Error ? err.message : err, raw.slice(0, 300));
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const obj = parsed as { summary?: unknown; attendees?: unknown };
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const names = Array.isArray(obj.attendees) ? obj.attendees.filter((n): n is string => typeof n === "string") : [];

  return { summary, attendeeMemberIds: matchAttendees(names, roster) };
}
