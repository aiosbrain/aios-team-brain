/**
 * probe.mjs — prove a credential works, at the moment the user pastes it.
 *
 * WHY THIS IS NOT A BYPASS OF THE LLM SINGLE-CALLER RULE (CLAUDE.md §6)
 *
 * The rule is that every text-GENERATION task must route through `lib/llm/complete` so it honors
 * `teams.answering_provider`. This file generates nothing. It is a setup-time credential check that
 * runs *before the team exists* — there is no database to read a provider setting from, and the
 * provider is whatever the user chose thirty seconds ago in the interview. `selectLlmBackend` could
 * not serve this call even in principle. Deliberately no `new Anthropic(...)` client and no
 * `/chat/completions` POST: every probe below is a metadata GET.
 *
 * WHY VALIDATE AT ALL, INSTEAD OF LETTING THE APP FIND OUT
 *
 * Because the alternative is what happens today: a wrong key is accepted silently at setup and
 * surfaces later as an unanswerable query box, which reads as "the product is broken" rather than
 * "this key is wrong". `npm run doctor` checks that a key is *present and well-formed*; only a real
 * request proves it is *valid*. That gap is the whole reason this exists.
 *
 * Every probe is free and side-effect-free — a models/metadata listing, never a completion, so
 * validating costs the user nothing.
 */

/** Distinguish "your key is wrong" from "we couldn't reach the provider" — the fixes differ. */
export const PROBE_OK = "ok";
export const PROBE_BAD_CREDENTIAL = "bad-credential";
export const PROBE_NO_ACCESS = "no-access";
export const PROBE_UNREACHABLE = "unreachable";

/**
 * Map an HTTP status onto a verdict.
 *
 * 401 vs 403 is the distinction worth keeping: 401 means the key itself is rejected, 403 means the
 * key authenticated but isn't entitled to this resource. Telling a user with a valid-but-unentitled
 * key to "check your key" sends them to re-paste a key that was correct all along.
 */
export function verdictForStatus(status) {
  if (status >= 200 && status < 300) return { verdict: PROBE_OK, detail: "key accepted" };
  if (status === 401) return { verdict: PROBE_BAD_CREDENTIAL, detail: "the provider rejected this key (401)" };
  if (status === 403) {
    return {
      verdict: PROBE_NO_ACCESS,
      detail: "the key is valid but not permitted to use this resource (403) — check the plan or workspace it belongs to",
    };
  }
  if (status === 429) {
    // A rate limit proves the key authenticated — it is a PASS for our purposes.
    return { verdict: PROBE_OK, detail: "key accepted (rate-limited right now, which still proves it authenticates)" };
  }
  return { verdict: PROBE_UNREACHABLE, detail: `unexpected response from the provider (HTTP ${status})` };
}

/**
 * Per-provider metadata endpoint + headers.
 *
 * Anthropic requires the `anthropic-version` header on every request, including this one — omitting
 * it fails for a reason that has nothing to do with the user's key, which would be a maddening
 * "your key is wrong" message to debug.
 */
export function probeRequestFor(provider, { key, baseUrl } = {}) {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      };
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${key}` } };
    case "openrouter":
      // `/key` returns this key's own metadata — cheaper than listing every model OpenRouter proxies.
      return { url: "https://openrouter.ai/api/v1/key", headers: { authorization: `Bearer ${key}` } };
    case "local": {
      // An OpenAI-compatible endpoint on the user's own hardware. Usually needs no key at all.
      const root = String(baseUrl ?? "").replace(/\/+$/, "");
      return {
        url: `${root}/models`,
        headers: key ? { authorization: `Bearer ${key}` } : {},
      };
    }
    default:
      return null;
  }
}

/**
 * Run the probe. `fetchImpl` and `timeoutMs` are injectable so the tests never touch the network.
 *
 * A hang is the failure mode that matters most here: this runs inside an interactive prompt, and an
 * unbounded fetch would leave the user staring at a dead terminal with no way to know whether to
 * wait. Always bounded, and a timeout reports as unreachable rather than as a bad key.
 */
export async function probeCredential(provider, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = opts;
  const request = probeRequestFor(provider, opts);
  if (!request) return { verdict: PROBE_OK, detail: "nothing to check for this choice" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    return verdictForStatus(res.status);
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      verdict: PROBE_UNREACHABLE,
      detail: aborted
        ? `no response within ${Math.round(timeoutMs / 1000)}s — check your network, or skip and configure the model later in Admin`
        : `could not reach the provider: ${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Is the Docker daemon actually running? `docker --version` answers a different question. */
export function dockerVerdict({ status, stderr = "" }) {
  if (status === 0) return { verdict: PROBE_OK, detail: "docker is running" };
  if (/permission denied/i.test(stderr)) {
    return { verdict: PROBE_NO_ACCESS, detail: "docker is installed but this user can't talk to it" };
  }
  if (/cannot connect|daemon|is the docker daemon running/i.test(stderr)) {
    return { verdict: PROBE_UNREACHABLE, detail: "docker is installed but not running — start Docker Desktop and re-run" };
  }
  if (/not found|no such file/i.test(stderr)) {
    return { verdict: PROBE_UNREACHABLE, detail: "docker isn't installed — https://docs.docker.com/get-docker/" };
  }
  return { verdict: PROBE_UNREACHABLE, detail: stderr.trim().split("\n")[0] || "docker check failed" };
}
