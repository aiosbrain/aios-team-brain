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
  if (/openrouter\.ai/i.test(text)) return "OpenRouter";
  if (/api\.openai\.com|(^|\W)openai(\W|$)/i.test(text)) return "OpenAI";
  if (/anthropic\.com|(^|\W)anthropic(\W|$)/i.test(text)) return "Anthropic";
  return "the model provider";
}

/**
 * The HTTP status a provider failure string carries, when it carries one.
 *
 * ⚠️ ANCHORED, because the first version read any bare three-digit number and these strings are FULL
 * of them. `"you requested up to 429 tokens"` was diagnosed as rate-limiting, and — worse —
 * `"only afford 403 tokens"` as a bad API key, which is the out-of-credit body's own phrasing sent to
 * entirely the wrong console. Found by attacking this function with realistic strings rather than the
 * three that motivated it.
 *
 * Real shapes: `LLM model @ https://host/v1: 402 {…}` and `HTTP 429 insufficient_quota`. So the digits
 * must follow a colon, `HTTP`, or `status` — and must not be a count of something.
 */
function statusIn(text: string): number | null {
  // `^` is an anchor too: a caller that hands us a bare `402 {…}` is naming a status, and the
  // false positives all sit MID-string after a word like "up to", never at the start.
  const m = text.match(/(?:^\s*|:\s*|\bHTTP\s+|\bstatus\s+)(\d{3})\b(?!\s*(?:tokens?|credits?|chars?|ms\b))/i);
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
  if (status === 429 && /rate.?limit|too many requests|quota/i.test(text)) {
    return {
      kind: "rate_limited",
      headline: `${provider} is rate-limiting this account.`,
      action: `This clears on its own. If it persists, the account's rate tier is the limit, not its balance.`,
    };
  }

  return null;
}

/** The diagnosis as one operator-facing line, or `null` when there is nothing confident to say. */
export function faultSentence(text: string | null | undefined): string | null {
  const f = diagnoseProviderFault(text);
  return f ? `${f.headline} ${f.action}` : null;
}
