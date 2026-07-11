import "server-only";

/**
 * Image generation provider seam (Social Brain). Today: Google Gemini "Nano Banana"
 * (`gemini-2.5-flash-image`) via the Generative Language API. Kept behind this one function so the
 * provider is swappable later (like the LLM/reranker seams) — callers depend on `GeneratedImage`,
 * not on Gemini. Best-effort: returns null on any failure (no key, HTTP error, no image part) so a
 * missing image never fails post generation; the text draft still lands.
 *
 * Key resolution: the per-call `apiKey` (a future per-team key) wins, else `GEMINI_API_KEY` from env.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";

export interface GeneratedImage {
  mime: string;
  dataBase64: string;
}

interface GeminiPart {
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string }; // snake_case tolerance
}

/** True when image generation is configured (a key is available). Lets callers skip work cleanly. */
export function imageGenerationConfigured(apiKey?: string | null): boolean {
  return !!(apiKey ?? process.env.GEMINI_API_KEY);
}

/** Generate one image for `prompt` via Gemini Nano Banana. Null on any failure (best-effort). */
export async function generateImage(prompt: string, apiKey?: string | null): Promise<GeneratedImage | null> {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${GEMINI_BASE}/${IMAGE_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: AbortSignal.timeout(45_000), // image gen is slower than text
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      const inline = p.inlineData ?? p.inline_data;
      const data = inline?.data;
      if (data) {
        const mime = (inline as { mimeType?: string; mime_type?: string })?.mimeType ??
          (inline as { mime_type?: string })?.mime_type ?? "image/png";
        return { mime, dataBase64: data };
      }
    }
    return null;
  } catch {
    return null;
  }
}
