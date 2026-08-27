import { looksLikeBudgetRefusal, looksLikeInFlightRefusal } from "@/lib/query/claude";

/**
 * TURN A PROVIDER'S FAILURE TEXT INTO THE ONE SENTENCE AN OPERATOR CAN ACT ON — LLMCREDIT-3.
 *
 * What the Pulse page showed on 2026-08-26, twice on one screen, in two slightly different clippings:
 *
 *   doc_task_infer — failing since 1d ago: every worker failed — LLM qwen/qwen3.7-max @
 *   https://openrouter.ai/api/v1: 402 {"error":{"message":"This request requires more credits, or
 *   fewer max_tokens. You requested up to 900 tokens, but can only afford 840. To increase, visit
 *   https://openrouter.ai/settings/credits and add more credits","code":402,"metadata":
 *   {"limit_source":"openrouter_credits","remedy_hint":"Add credits at …
 *
 * …clipped mid-word. Every fact needed to say "OpenRouter is out of credit — add credits" is in there;
 * the operator just has to read four hundred characters of JSON to find it. This is the missing layer
 * between a classification the code ALREADY makes and the human reading the banner.
 *
 * ⚠️ A CONFIDENT WRONG DIAGNOSIS IS WORSE THAN RAW TEXT. On that same screen, `Learning arcs` failed
 * with `empty content … finish_reason=length` — a reasoning model starving its own answer, whose
 * remedy is a different setting on a different page. Classifying that as a credit problem would send
 * someone to top up an account that is fine. So the taxonomy keeps them apart, and anything
 * unrecognised returns `null` rather than a guess: the caller then shows the provider's own words.
 */

export type ProviderFaultKind =
  | "out_of_credit"
  | "in_flight_budget"
  | "reasoning_starved"
  | "bad_key"
  | "rate_limited";

export interface ProviderFault {
  kind: ProviderFaultKind;
  /** What is wrong, naming the provider. One clause, no JSON. */
  headline: string;
  /** What to DO about it, naming the console or setting. */
  action: string;
}

/**
 * Who actually refused the call, read from the failure text's own base URL.
 *
 * ⚠️ DERIVED, NEVER ASSUMED — the operator asked for "whatever model provider we are using" in as many
 * words. Two reasons not to name the team's CONFIGURED provider instead: the failure text is the
 * evidence of who refused, and a fleet can run answering on one provider while embeddings sit on
 * another. Naming the configured one when a different one refused is a confident lie.
 */
export function providerNameFrom(text: string): string {
  // ⚠️ HOSTNAMES ONLY. An earlier version also matched the bare words, which named OpenAI for a MODEL
  // SLUG like `openai/gpt-5` — a slug this fleet routes through OpenRouter, so it would have named a
  // provider that refused nothing. A review caught that the code and the spec disagreed: the spec
  // says "derived from the failure text's own base URL", and now that is what it does. When no host
  // is present the generic noun is the honest answer.
  if (/openrouter\.ai/i.test(text)) return "OpenRouter";
  if (/api\.openai\.com|openai\.azure\.com/i.test(text)) return "OpenAI";
  if (/anthropic\.com/i.test(text)) return "Anthropic";
  return "the model provider";
}

/**
 * The HTTP status a provider failure string carries — recognised ONLY in a shape an LLM recorder
 * actually writes.
 *
 * ⚠️ THIS IS THE WHOLE SAFETY PROPERTY, and two rounds of attack were needed to get it right.
 *
 * First it read any bare three-digit number, and these strings are full of them:
 * `"you requested up to 429 tokens"` became rate-limiting, and `"only afford 403 tokens"` — the
 * OUT-OF-CREDIT body's own phrasing — became a bad API key.
 *
 * Then a review found the sharper one: this classifier also runs over `graph_extract`'s reason, which
 * is PROSE, not a provider response, and whose template opens with a raw count —
 * `"402 items have been projected for this team, but the graph holds 0 extracted facts…"`
 * (`lib/graph/extraction-health.ts`). A corpus of 402 items would have put "the model provider refused
 * the call for payment" on the graph leg, for days, with the real cause clipped underneath.
 *
 * So the digits must sit where a RECORDER puts them, never where prose can:
 *   `LLM <model> @ <baseUrl>: <status> …`  (lib/llm/complete, lib/query/claude)
 *   `HTTP <status> …`
 *   `<status> {…}`                          (a status immediately introducing a JSON body)
 * Anything else — including a sentence that merely begins with a number — is not a status.
 */
function statusIn(text: string): number | null {
  const m =
    // `@ <baseUrl>: <status>` — `\S*` must be allowed to swallow the URL, whose own `://` is a colon.
    // The first version used `[^:]*` and could never get past `https:`, so this branch matched nothing
    // and every passing case was really being caught by the JSON-adjacency pattern below. A criterion
    // with no `{` in it is what exposed that.
    text.match(/@\s*\S*:\s*(\d{3})\b/) ??
    text.match(/\bHTTP\s+(\d{3})\b/i) ??
    text.match(/(?:^|\s)(\d{3})\s*\{/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 400 && n <= 599 ? n : null;
}

/**
 * Diagnose a provider failure, or return `null` when it is not recognised.
 *
 * `null` IS AN ANSWER and it is the default. The surfaces fall back to showing the provider's own
 * text, which is strictly better than a wrong headline — see the class comment.
 */
export function diagnoseProviderFault(text: string | null | undefined): ProviderFault | null {
  if (!text || !text.trim()) return null;
  const provider = providerNameFrom(text);
  const status = statusIn(text);

  // The two 402s, kept apart because LLMCREDIT-1/-2 proved their remedies are opposite. Both
  // predicates are CONSUMED rather than re-spelled, so this vocabulary has exactly one owner and
  // cannot drift from the retry logic that acts on it.
  if (status === 402) {
    if (looksLikeInFlightRefusal(402, text)) {
      return {
        kind: "in_flight_budget",
        headline: `${provider} is refusing calls because too many are in flight at once for the remaining balance.`,
        action: `Add credits to raise the in-flight budget. The brain already waits and retries these, so a small backlog clears itself.`,
      };
    }
    if (looksLikeBudgetRefusal(402, text)) {
      return {
        kind: "out_of_credit",
        headline: `${provider} is out of credit — it is refusing calls this account can no longer afford.`,
        action: `Top up the account, then the failing features recover on their next run.`,
      };
    }
    // A 402 with no size and no in-flight language is a dead account, not a sizing problem.
    return {
      kind: "out_of_credit",
      headline: `${provider} refused the call for payment (402).`,
      action: `Check the account's billing status and top it up.`,
    };
  }

  // 200 OK with nothing in it: the model spent its whole budget on hidden reasoning. NOT a spend
  // problem — it was on screen directly beside one, and it needs a different picker.
  if (/empty content/i.test(text) && /finish_reason\s*=\s*length|finish_reason":\s*"length"/i.test(text)) {
    return {
      kind: "reasoning_starved",
      headline: `The answering model returned nothing — it spent its whole budget on hidden reasoning.`,
      action: `Pick a non-reasoning model in Admin → Active answering model.`,
    };
  }

  // ⚠️ NOT OBSERVED ON THIS FLEET — unlike everything above, these two have no production body behind
  // them. They are named so the unknown branch stays honest rather than swallowing them into a credit
  // diagnosis, and they are marked so nobody later reads them as measured.
  // ⚠️ CORROBORATION REQUIRED for the two unobserved kinds. A status alone is not enough: these
  // branches have no production body behind them, so the safe default when the words do not agree
  // with the number is `null` — the caller then shows the provider's own text.
  if ((status === 401 || status === 403) && /unauthor|invalid.{0,12}key|forbidden|authenticat|permission/i.test(text)) {
    return {
      kind: "bad_key",
      headline: `${provider} rejected the API key.`,
      action: `Check the key in Admin → Integrations — it may be revoked, expired, or scoped wrong.`,
    };
  }
  // ⚠️ A 429 IS NOT ALWAYS A RATE LIMIT. OpenAI reports an exhausted BILLING QUOTA as
  // `429 insufficient_quota` — the exact string in this repo's own shipped fixture, and the shape of
  // the quota incident already in this fleet's history. The first draft answered that with "the
  // account's rate tier is the limit, NOT its balance", which is a confident inversion of the truth
  // and would have sent someone to the wrong console. Quota language wins over the status.
  if (status === 429 && /insufficient_quota|exceeded your current quota|billing/i.test(text)) {
    return {
      kind: "out_of_credit",
      headline: `${provider} says this account's quota is exhausted.`,
      action: `Top up or raise the plan's quota — this is a billing limit, not a burst limit.`,
    };
  }
  if (status === 429 && /rate.?limit|too many requests/i.test(text)) {
    return {
      kind: "rate_limited",
      headline: `${provider} is rate-limiting this account.`,
      action: `This usually clears on its own. If it persists, check the account's rate tier — and its balance, since some providers report an exhausted quota as a 429.`,
    };
  }

  return null;
}

/** The diagnosis as one operator-facing line, or `null` when there is nothing confident to say. */
export function faultSentence(text: string | null | undefined): string | null {
  const f = diagnoseProviderFault(text);
  return f ? `${f.headline} ${f.action}` : null;
}
