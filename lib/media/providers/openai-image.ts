import "server-only";

/**
 * OpenAI image generation adapter (Social Brain). Provider-specific detail behind a neutral
 * interface (mirrors the pm-sync adapter pattern). Returns base64 bytes — the gpt-image-* models
 * respond with `b64_json`, not a URL (verified in the provider spike). The API key is the standard
 * OpenAI key (same as the answering LLM), resolved by the caller via getProviderKey.
 */

export interface ImageGenParams {
  prompt: string;
  apiKey: string;
  model?: string;
  size?: string;
}

export interface ImageGenResult {
  b64: string;
  model: string;
}

export const DEFAULT_IMAGE_MODEL = "gpt-image-1.5";

export async function generateOpenAiImage(params: ImageGenParams): Promise<ImageGenResult> {
  const model = params.model ?? DEFAULT_IMAGE_MODEL;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.apiKey}` },
    body: JSON.stringify({ model, prompt: params.prompt, size: params.size ?? "1024x1024", n: 1 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`openai image ${model}: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const j = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai image: response had no b64_json");
  return { b64, model };
}
