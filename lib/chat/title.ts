import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { DbClient } from "@/lib/db/types";
import type { ProviderKeys } from "@/lib/query/claude";
import { selectLlmBackend } from "@/lib/query/llm-backend";
import { setTitle } from "@/lib/chat/store";

/**
 * Background conversation-title generator. After a conversation's first exchange we replace the
 * derived (first-question) title with a short LLM-written label — the ChatGPT-style sidebar polish.
 * Best-effort: any failure (no key, timeout) leaves the derived title in place. Cheap model + tiny
 * output; runs after the answer has already streamed, so it never adds user-visible latency.
 */

// Cheap, fast model for titles (not the answer model). Local OpenAI-compatible backend wins if set.
const TITLE_MODEL = "claude-haiku-4-5-20251001";
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "llama3.1-8b-64k:latest";

const TITLE_SYSTEM =
  "You label a chat with a 3–5 word title in Title Case. Output ONLY the title — no quotes, no trailing punctuation, no preamble.";

/** Sanitize a model's title output to a single clean line (strip quotes/`<think>`, collapse, cap). */
export function cleanTitle(raw: string, max = 60): string {
  const stripped = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/g, ""); // drop reasoning spans
  // First non-empty line (models sometimes emit a blank/preamble line first).
  let t = (stripped.split("\n").map((s) => s.trim()).find(Boolean) ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'`\s]+|["'`\s.]+$/g, "").trim(); // surrounding quotes + trailing period
  if (t.length > max) t = t.slice(0, max).trimEnd();
  return t;
}

/** Generate a short title from the first Q+A, or null on any failure (caller keeps the derived title). */
export async function generateTitle(
  question: string,
  answer: string,
  keys: ProviderKeys = {}
): Promise<string | null> {
  const prompt = `Question: ${question.trim()}\n\nAnswer: ${answer.trim().slice(0, 600)}\n\nTitle:`;
  try {
    // Same backend the answer used (OpenRouter → LLM_BASE_URL → Anthropic), so titles never diverge.
    const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys);
    if (backend.kind !== "anthropic") {
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
          max_tokens: 24,
          messages: [
            { role: "system", content: TITLE_SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(6000), // never hold the response open on a slow title call
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return cleanTitle(j.choices?.[0]?.message?.content ?? "") || null;
    }
    const client = new Anthropic(keys.anthropicKey ? { apiKey: keys.anthropicKey } : undefined);
    const msg = await client.messages.create(
      {
        model: TITLE_MODEL,
        max_tokens: 24,
        system: TITLE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 6000, maxRetries: 0 }
    );
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return cleanTitle(text) || null;
  } catch {
    return null;
  }
}

/** Generate + persist a title for a freshly-created conversation. Best-effort (never throws to the caller). */
export async function generateAndSetTitle(
  db: DbClient,
  owner: { teamId: string; memberId: string },
  conversationId: string,
  question: string,
  answer: string,
  keys: ProviderKeys = {}
): Promise<void> {
  try {
    const title = await generateTitle(question, answer, keys);
    if (title) await setTitle(db, owner, conversationId, title);
  } catch {
    // keep the derived title
  }
}
