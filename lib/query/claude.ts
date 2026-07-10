import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedContext } from "./retrieve";
import { selectLlmBackend, type LlmBackend } from "./llm-backend";

/**
 * Thin adapter around the Claude API so a future agent backend (e.g. Hermes)
 * is a one-module swap. Stable cached system prefix; numbered sources;
 * question last (keeps the cacheable prefix stable per team).
 *
 * Backend selection is env-driven:
 *   - LLM_BASE_URL set  → stream from a local OpenAI-compatible endpoint
 *     (Ollama / Hermes / llama.cpp). LLM_MODEL picks the model; cost is $0.
 *   - LLM_BASE_URL unset → the original Anthropic path (unchanged).
 */

const MODEL = "claude-opus-4-8";
// $5 / $25 per MTok; cache reads ~0.1x input
const INPUT_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_PER_TOKEN = 25 / 1_000_000;
const CACHE_READ_PER_TOKEN = 0.5 / 1_000_000;

// Local OpenAI-compatible backend (Ollama/Hermes). Unset → cloud Anthropic.
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "llama3.1-8b-64k:latest";

const SYSTEM_PROMPT = `You are the Team Brain — the shared memory and coordination assistant for a team using AIOS.

Rules:
- Answer ONLY from the provided sources and structured context. If they don't cover the question, say so plainly — never invent facts, decisions, or attributions.
- Cite sources inline using their markers, e.g. [S2]. Cite the structured context as [CTX].
- Be concise and operational: lead with the answer, then the supporting evidence.
- Answer EVERY part of a multi-part question. If it contains several asks (e.g. about two different people), address each one explicitly — never silently drop a part.
- If a <conversation_so_far> block is present, use it to resolve references to earlier turns ("he", "she", "they", "that", "the same one"). It is prior context only — still answer ONLY from the sources and structured context below.
- Decisions marked [SUPERSEDED] are no longer valid — say so if relevant.
- Interpret relative dates in the USER'S timezone stated at the top of the context. "today" means the last 24 hours (the rolling window given, NOT the calendar day) — so an item timestamped within that window counts as "today" even if its calendar date reads as yesterday. "yesterday" = the 24h before that; "this week" = the last 7 days; "recently" ≈ the last two weeks. Dates in the structured context (e.g. a task's "updated" date, a commit's day) are calendar dates and may be in UTC or the commit's own timezone — reconcile them against the window rather than assuming the user's calendar day.
- Never speculate about content above the caller's access tier; what you were given is what they may see.`;

/** Render an instant's Y-M-D, H:M, weekday and UTC-offset in a given IANA timezone. */
function partsInZone(now: Date, timeZone: string): { date: string; time: string; weekday: string; offset: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // 00–23 (avoids the "24:00" ICU quirk at midnight)
    weekday: "long",
    timeZoneName: "longOffset",
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: p.weekday ?? "",
    offset: normalizeOffset(p.timeZoneName ?? "GMT+00:00"),
  };
}

/**
 * Normalize an ICU `longOffset` string to a deterministic "UTC±HH:MM" form. Some ICU builds render
 * UTC's longOffset as bare "GMT" instead of "GMT+00:00" (both are valid CLDR renderings) — left
 * unhandled, that yields "UTC" instead of "UTC+00:00" after the GMT→UTC replace, which is
 * inconsistent across Node/ICU builds even for the same input instant/timezone. Normalize the
 * offsetless case explicitly so output doesn't depend on the local ICU data.
 */
function normalizeOffset(raw: string): string {
  const withUtc = raw.replace("GMT", "UTC");
  return withUtc === "UTC" ? "UTC+00:00" : withUtc;
}

/**
 * The date/time anchor injected at the top of the query context. States NOW in the user's timezone
 * and defines "today" as the trailing 24 hours (a rolling window with an explicit UTC cutoff the
 * model can compare digest dates against) — so a GMT+8 user's 05:00-UTC commit reads as "today",
 * not "yesterday". Pure + injectable (`now`, `timeZone`) for deterministic tests; invalid tz → UTC.
 */
export function currentDateLine(now: Date = new Date(), timeZone: string = "UTC"): string {
  let z = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
  } catch {
    z = "UTC";
  }
  const { date, time, weekday, offset } = partsInZone(now, z);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return (
    `Current date & time: ${date} ${time} (${weekday}) — user timezone ${z} (${offset}).\n` +
    `"today" = the last 24 hours (rolling window since ${since}); "yesterday" = the 24h before that; ` +
    `"this week" = the last 7 days. Resolve all relative dates in the user's timezone.`
  );
}

/**
 * "Stay quiet" (Organ 3): when retrieval found no query-specific match (`grounded === false`), the
 * sources are just recent items as background, not a real hit. We surface that explicitly so the
 * model abstains instead of confabulating a connection. Soft — it still lets a clearly-relevant
 * structured digest answer; it just removes the false confidence of "documents were retrieved".
 */
export function groundingNote(grounded: boolean): string {
  return grounded
    ? ""
    : "[Retrieval note] No documents specifically matched this question — the sources below are recent items included only as background. If neither they nor the structured context clearly contain the answer, say you don't have that information rather than guessing.\n\n";
}

/** One prior exchange in the current chat session, used to resolve follow-ups/pronouns. */
export interface ChatTurn {
  question: string;
  answer: string;
}

/**
 * The signed-in member a query is being answered FOR. Anchors first-person resolution: without it,
 * "how about me?" has no referent (the model only sees a by-name activity digest, with no way to
 * know which row is the caller). Every field optional — we render whatever identity we have.
 */
export interface CallerIdentity {
  displayName?: string | null;
  email?: string | null;
  handle?: string | null;
}

/**
 * A one-line "who is asking" anchor injected into the query context so the model can resolve
 * first-person references ("me", "my", "I", "mine") to a concrete person — and match that person
 * against the by-name entries in the structured digests (git/people activity, tasks, decisions).
 * Pure + bounded; returns "" when we have no usable identity (→ no behavior change).
 */
export function callerBlock(caller?: CallerIdentity): string {
  if (!caller) return "";
  const name = (caller.displayName ?? "").trim();
  const email = (caller.email ?? "").trim();
  const handle = (caller.handle ?? "").trim();
  if (!name && !email && !handle) return "";
  const who = [name || null, email ? `<${email}>` : null, handle ? `@${handle}` : null]
    .filter(Boolean)
    .join(" ");
  return (
    `<caller>\nYou are answering for ${who}. Resolve first-person references ("me", "my", "I", "mine") ` +
    `to this person, and match them against the named entries in the structured context (e.g. the activity ` +
    `digests, task assignees, decision authors).\n</caller>`
  );
}

// Windowed memory: the brain is RAG-grounded, not a freeform chatbot, so we carry only the last
// few turns (each answer truncated) — enough to resolve "he/that", cheap on tokens, no overflow.
const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_CHARS = 400;

/**
 * Build a compact `<conversation_so_far>` block from recent turns so the model can resolve
 * references to earlier messages. Pure + bounded: last N turns, each prior answer collapsed to a
 * single line and truncated. Returns "" when there's no usable history.
 */
export function conversationBlock(
  history: ChatTurn[] | undefined,
  opts: { maxTurns?: number; maxAnswerChars?: number } = {}
): string {
  const maxTurns = opts.maxTurns ?? MAX_HISTORY_TURNS;
  const maxAnswerChars = opts.maxAnswerChars ?? MAX_ANSWER_CHARS;
  const recent = (history ?? [])
    .filter((t) => t.question.trim())
    .slice(-maxTurns);
  if (recent.length === 0) return "";
  const lines = recent.map((t) => {
    const q = t.question.trim().replace(/\s+/g, " ");
    let a = t.answer.trim().replace(/\s+/g, " ");
    if (a.length > maxAnswerChars) a = `${a.slice(0, maxAnswerChars).trimEnd()}…`;
    return a ? `User: ${q}\nBrain: ${a}` : `User: ${q}`;
  });
  return `<conversation_so_far>\n${lines.join("\n\n")}\n</conversation_so_far>`;
}

export type QueryUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

/**
 * Per-team provider keys (resolved from the encrypted integrations store by the caller). When a key
 * is null/absent the SDK / fetch falls back to the process env, preserving the original env-only
 * behavior for instances that haven't set a key in the dashboard.
 */
export interface ProviderKeys {
  anthropicKey?: string | null;
  openaiKey?: string | null;
  // OpenRouter (OpenAI-compatible gateway): a per-team key + chosen model select this backend first.
  openrouterKey?: string | null;
  openrouterModel?: string | null;
}

export async function* streamAnswer(
  ctx: RetrievedContext,
  question: string,
  keys: ProviderKeys = {},
  history: ChatTurn[] = [],
  caller?: CallerIdentity,
  timeZone: string = "UTC"
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; usage: QueryUsage }
> {
  const sourcesBlock = ctx.sources
    .map(
      (s) =>
        `<source id="${s.sid}" project="${s.project}" path="${s.path}" kind="${s.kind}" synced="${s.synced_at}">\n${s.text}\n</source>`
    )
    .join("\n\n");

  const note = groundingNote(ctx.grounded);
  const convo = conversationBlock(history);
  const who = callerBlock(caller);

  // OpenRouter (per-team) or a local OpenAI-compatible endpoint (LLM_BASE_URL) — same wire shape.
  const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys);
  if (backend.kind !== "anthropic") {
    yield* streamOpenAICompatible(backend, note, who, convo, ctx.structured, sourcesBlock, question, timeZone);
    return;
  }

  // Per-team key wins; otherwise the SDK reads ANTHROPIC_API_KEY from the env.
  const client = new Anthropic(keys.anthropicKey ? { apiKey: keys.anthropicKey } : undefined);

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: currentDateLine(new Date(), timeZone) },
          ...(who ? [{ type: "text" as const, text: who }] : []),
          ...(note ? [{ type: "text" as const, text: note }] : []),
          { type: "text", text: `<structured_context>\n${ctx.structured}\n</structured_context>` },
          { type: "text", text: sourcesBlock || "<no document sources matched>" },
          ...(convo ? [{ type: "text" as const, text: convo }] : []),
          { type: "text", text: `Question: ${question}` },
        ],
      },
    ],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "delta", text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  const u = final.usage;
  const cost =
    (u.input_tokens ?? 0) * INPUT_PER_TOKEN +
    (u.output_tokens ?? 0) * OUTPUT_PER_TOKEN +
    (u.cache_read_input_tokens ?? 0) * CACHE_READ_PER_TOKEN;
  yield {
    type: "done",
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cost_usd: Math.round(cost * 100000) / 100000,
    },
  };
}

/**
 * Stream from an OpenAI-compatible chat endpoint — OpenRouter (per-team gateway) OR a local
 * endpoint (Ollama/Hermes/llama.cpp via LLM_BASE_URL). Same `delta`/`done` contract as the Anthropic
 * path. Strips any `<think>…</think>` reasoning spans so the answer stays clean on reasoning models.
 * Cost is reported as $0 here (token counts are accurate); per-model OpenRouter cost is a follow-up.
 */
async function* streamOpenAICompatible(
  backend: Extract<LlmBackend, { kind: "openrouter" | "openai-compatible" }>,
  note: string,
  who: string,
  convo: string,
  structured: string,
  sourcesBlock: string,
  question: string,
  timeZone: string
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; usage: QueryUsage }
> {
  const userContent =
    currentDateLine(new Date(), timeZone) +
    "\n\n" +
    (who ? `${who}\n\n` : "") +
    note +
    `<structured_context>\n${structured}\n</structured_context>\n\n` +
    `${sourcesBlock || "<no document sources matched>"}\n\n` +
    (convo ? `${convo}\n\n` : "") +
    `Question: ${question}`;

  const apiKey = backend.apiKey ?? process.env.OPENAI_API_KEY ?? "local";
  const res = await fetch(`${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(backend.kind === "openrouter" ? backend.headers : {}),
    },
    body: JSON.stringify({
      model: backend.model,
      max_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`LLM ${backend.model} @ ${backend.baseUrl}: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inThink = false;
  let prompt = 0;
  let completion = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) {
        prompt = j.usage.prompt_tokens ?? prompt;
        completion = j.usage.completion_tokens ?? completion;
      }
      let piece: string = j.choices?.[0]?.delta?.content ?? "";
      if (!piece) continue;
      // Drop <think>…</think> reasoning spans (token-by-token aware).
      let out = "";
      while (piece.length) {
        if (inThink) {
          const end = piece.indexOf("</think>");
          if (end === -1) { piece = ""; break; }
          piece = piece.slice(end + 8);
          inThink = false;
        } else {
          const start = piece.indexOf("<think>");
          if (start === -1) { out += piece; piece = ""; break; }
          out += piece.slice(0, start);
          piece = piece.slice(start + 7);
          inThink = true;
        }
      }
      if (out) yield { type: "delta", text: out };
    }
  }

  yield {
    type: "done",
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      cache_read_tokens: 0,
      cost_usd: 0,
    },
  };
}
