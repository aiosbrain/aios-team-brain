import "server-only";

/**
 * Does the selected model support STRUCTURED OUTPUTS — and therefore graph extraction?
 *
 * Graphiti extracts entities and edges via `client.beta.chat.completions.parse`: an OpenAI call
 * carrying a JSON schema that the model must adhere to. A model that cannot do that returns prose or
 * loosely-shaped JSON, Graphiti fails to parse it, and — because it keeps returning `202` — the
 * symptom is an empty graph and blank narrative arcs. Indistinguishable from a quota outage, and it
 * took log forensics across two services to attribute the last one.
 *
 * Since the graph proxy made the Admin answering-model picker also drive extraction, that failure is
 * now one dropdown away. `qwen3.7-flash` is exactly the shape: it advertises `response_format` but
 * NOT `structured_outputs`, and it is the cheap one, so it is the one people reach for.
 *
 * The two flags are not interchangeable, and only the second decides this:
 *   • `response_format`    — can mean merely "will emit valid JSON" (`json_object` mode).
 *   • `structured_outputs` — adheres to a supplied JSON *schema*. This is what `.parse()` needs.
 *
 * Advisory, never blocking: this is a save-time WARNING, so an unreachable capability list, an
 * unlisted model, or a local endpoint must all read as "can't tell" and let the save proceed. Telling
 * someone their model is broken on no evidence is the failure mode of the work-key check, and this
 * file exists downstream of that lesson.
 */

/** OpenRouter publishes per-model capabilities here. No key required — it is a public catalogue. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 4_000;
/** One process-wide cache. The catalogue changes on the order of days; a save is rare. */
const CACHE_TTL_MS = 60 * 60_000;

export type StructuredOutputVerdict =
  | { status: "supported" }
  | { status: "unsupported"; model: string }
  | { status: "unknown"; reason: string };

interface CatalogueEntry {
  supportsStructuredOutputs: boolean;
}

let cache: { at: number; models: Map<string, CatalogueEntry> } | null = null;

/** Exported for tests — a stale cache between cases would make them order-dependent. */
export function resetStructuredOutputCache(): void {
  cache = null;
}

/**
 * Parse OpenRouter's catalogue into "model id → does it adhere to a JSON schema".
 *
 * Pure, so the capability rule is testable without a network. Keyed on `structured_outputs`
 * specifically; a model listing only `response_format` counts as UNSUPPORTED, which is the whole
 * distinction that makes this check worth having.
 */
export function parseModelCatalogue(body: unknown): Map<string, CatalogueEntry> {
  const out = new Map<string, CatalogueEntry>();
  const rows = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as { id?: unknown; supported_parameters?: unknown }[]) {
    if (typeof row?.id !== "string") continue;
    const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
    out.set(row.id, { supportsStructuredOutputs: params.includes("structured_outputs") });
  }
  return out;
}

/** Decide from an already-fetched catalogue. Pure — the network half is `checkStructuredOutputSupport`. */
export function verdictFor(model: string, models: Map<string, CatalogueEntry>): StructuredOutputVerdict {
  if (!models.size) return { status: "unknown", reason: "the model catalogue could not be read" };
  const entry = models.get(model);
  // An unlisted model is NOT a broken one — OpenRouter adds models continually, and a stale catalogue
  // must never accuse. "Couldn't verify" is its own outcome.
  if (!entry) return { status: "unknown", reason: `${model} is not listed in the model catalogue` };
  return entry.supportsStructuredOutputs ? { status: "supported" } : { status: "unsupported", model };
}

async function loadCatalogue(now: number): Promise<Map<string, CatalogueEntry>> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.models;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: ctrl.signal });
    if (!res.ok) return new Map();
    const models = parseModelCatalogue(await res.json());
    if (models.size) cache = { at: now, models };
    return models;
  } catch {
    return new Map(); // → "unknown", never a false accusation
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this provider+model support the structured outputs graph extraction needs?
 *
 * Only OpenRouter can be answered: it publishes a capability catalogue. For every other provider this
 * returns `unknown` rather than guessing — Anthropic is refused by the proxy for a different reason
 * anyway, OpenAI's own models all support it, and a local endpoint is unknowable from here.
 */
export async function checkStructuredOutputSupport(
  provider: string,
  model: string,
  now = Date.now()
): Promise<StructuredOutputVerdict> {
  if (provider !== "openrouter") {
    return { status: "unknown", reason: `capability data is only published for OpenRouter models` };
  }
  if (!model.trim()) return { status: "unknown", reason: "no model selected" };
  return verdictFor(model.trim(), await loadCatalogue(now));
}

/**
 * The sentence an admin sees. Returned alongside a SUCCESSFUL save — the model is theirs to choose,
 * and the brain's own answering path works fine without structured outputs. Only the graph breaks.
 */
export function structuredOutputWarning(v: StructuredOutputVerdict): string | null {
  if (v.status !== "unsupported") return null;
  return (
    `Saved — but ${v.model} does not support structured outputs, which graph extraction requires. ` +
    `Narrative arcs and the learning panel will stop gaining new facts (the query box, timeline and ` +
    `search are unaffected). Pick a model listing "structured_outputs" if you use the context engine.`
  );
}
