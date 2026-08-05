import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getProviderKey } from "@/lib/integrations/manage";
import { OPENROUTER_BASE_URL } from "@/lib/query/llm-backend";

/**
 * PROVIDER-REPORTED spend — the reconciliation the `llm_usage` ledger cannot do for itself.
 *
 * The ledger records what each call REPORTED. That is the only way to attribute cost to a feature,
 * and it is structurally incomplete: a call that times out, is aborted, or fails after the provider
 * already generated is billed upstream and returns us no `usage` to read. So the ledger is a floor,
 * not a total, and nothing in it can reveal by how much.
 *
 * Measured 2026-07-30: the ledger held $51.46 while OpenRouter's own `/credits` reported $96.67 spent
 * on the same key — 47% of real spend invisible, and the dashboard presented its floor as the answer.
 * The bulk was one bad day where every graph extraction hit a proxy timeout and the OpenAI SDK retried
 * three times: ~4,000 generations that the provider billed and we recorded as nothing, because we only
 * metered 2xx responses.
 *
 * So we ask the provider what it actually charged. `GET /api/v1/key` needs only the inference key the
 * team already configured (unlike `/activity`, which requires a management key — verified 403).
 *
 * WHY `/key` AND NOT `/credits`. This module used to read `/credits` and called its `total_usage`
 * key-scoped in three separate comments. It is ACCOUNT-scoped. Measured 2026-08-05: `/credits`
 * reported $202.69 while this key had spent $194.36 — so $8.33 of an unrelated key's spend was being
 * attributed to our own blind spot, in a figure whose entire job is to say how much spend we failed
 * to explain. No amount of correct metering could ever have closed it. `/key` reports `data.usage`
 * for the PRESENTED key, which is the only number the comparison was ever supposed to make.
 *
 * PERIOD SLICES ARE AVAILABLE, and they matter more than the lifetime figure. `/key` also returns
 * `usage_daily` / `usage_monthly`. Measured the same morning: today's ledger $0.0491 vs the
 * provider's $0.049143 — agreement to four decimal places, i.e. the meter is currently capturing
 * essentially everything. The lifetime gap ($42.91, 22%) is almost entirely frozen July history
 * (pre-metering + the timeout storm) that no future work can recover, which is why the MONTHLY
 * figure is the one an operator can act on and the lifetime one is context.
 *
 * `usage_monthly` is a CALENDAR month, not a rolling 30 days: August-to-date was $70.29 against a
 * $69.63 ledger, while a rolling window would have swept in the late-July storm (~$82 on our side
 * alone). UTC-vs-account-local is not separable from that observation — the UI says "the provider's
 * month" rather than implying our own boundary.
 */

const KEY_URL = `${OPENROUTER_BASE_URL}/key`;
const FETCH_TIMEOUT_MS = 4_000;
/** Spend moves slowly relative to a page view, and this sits on a render path. */
const CACHE_TTL_MS = 10 * 60_000;

export interface ProviderUsage {
  provider: "openrouter";
  /** Cumulative USD the provider says THIS KEY has spent (`/key` → `data.usage`). */
  totalUsageUsd: number;
  /**
   * This key's spend in the provider's current calendar month, when reported. The actionable figure:
   * the lifetime total is dominated by a frozen pre-metering block, so only the current period can
   * tell an operator whether spend is escaping the meter NOW.
   */
  monthUsageUsd: number | null;
}

let cache: { at: number; teamId: string; value: ProviderUsage | null } | null = null;

/** Exported for tests — a shared cache would make cases order-dependent. */
export function resetProviderUsageCache(): void {
  cache = null;
}

/**
 * Parse OpenRouter's `/credits` body. Pure, so the shape is pinned without a network call.
 *
 * Returns null rather than zero for anything unrecognised: a missing number must read as "we don't
 * know what the provider charged", never as "the provider charged nothing" — the second is exactly
 * the false reassurance this module exists to end.
 */
export function parseKeyUsageBody(body: unknown): ProviderUsage | null {
  const d = (body as { data?: { usage?: unknown; usage_monthly?: unknown } } | null)?.data;
  // `>= 0` as well as finite: a negative total would render "$-5.00 spent", which is not a number any
  // reader can act on. Unparseable and absurd both mean "we don't know".
  //
  // Keyed on `usage` SPECIFICALLY, never falling back to `total_usage`: a `/credits`-shaped body must
  // parse to null, so a silent revert to the account-wide endpoint reads as "we don't know" instead
  // of as a plausible wrong figure. That substitution is the exact defect this function was rewritten
  // to end, and a tolerant parser would let it back in unnoticed.
  if (!d || typeof d.usage !== "number" || !Number.isFinite(d.usage) || d.usage < 0) return null;
  const month =
    typeof d.usage_monthly === "number" && Number.isFinite(d.usage_monthly) && d.usage_monthly >= 0
      ? d.usage_monthly
      : null;
  return { provider: "openrouter", totalUsageUsd: d.usage, monthUsageUsd: month };
}

/**
 * What the provider says this team's key has spent, or null when we can't ask.
 *
 * Best-effort by construction — this renders on a page, and a provider outage must degrade to "no
 * reconciliation shown" rather than breaking the costs view. Only OpenRouter publishes this; other
 * providers return null and the UI simply omits the comparison.
 */
export async function getProviderReportedUsage(
  db: DbClient,
  teamId: string,
  now = Date.now()
): Promise<ProviderUsage | null> {
  if (cache && cache.teamId === teamId && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value: ProviderUsage | null = null;
  try {
    const key = await getProviderKey(db, teamId, "openrouter");
    if (key) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(KEY_URL, {
          headers: { Authorization: `Bearer ${key}` },
          signal: ctrl.signal,
        });
        if (res.ok) value = parseKeyUsageBody(await res.json());
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    value = null;
  }
  cache = { at: now, teamId, value };
  return value;
}

export interface LedgerReconciliation {
  providerUsd: number;
  ledgerUsd: number;
  /** Provider total minus what the ledger attributed. Never negative — see below. */
  unattributedUsd: number;
  /** Share of provider-reported spend the ledger could not attribute, 0–1. */
  unattributedFraction: number;
  /** Worth telling the operator about, rather than a rounding difference. */
  material: boolean;
  /**
   * `ledger-exceeds` is its OWN state, not a clamped zero. With the ledger filtered to this provider,
   * recording more than the provider billed is no longer legitimate — it means the key was rotated
   * (old spend in the ledger, fresh key at the provider) or something double-metered. Rendering the
   * clamped "accounts for $X of it" there produces a literally false sentence, so the UI says what
   * actually happened instead.
   */
  status: "reconciled" | "unattributed" | "ledger-exceeds";
}

/** Below this the difference is timing and rounding, not a missing-spend story. */
const MATERIAL_FRACTION = 0.05;
const MATERIAL_ABSOLUTE_USD = 1;

/**
 * Compare what the provider charged against what the ledger attributed.
 *
 * CLAMPED AT ZERO, deliberately. The ledger is lifetime-scoped here too, but it can still exceed the
 * provider total legitimately — an Anthropic call is list-price ESTIMATED and counted in the ledger
 * while contributing nothing to OpenRouter's number. A negative "unattributed" would be nonsense; the
 * honest reading of ledger ≥ provider is simply "nothing unattributed on this provider".
 */
export function reconcileLedger(providerUsd: number, ledgerUsd: number): LedgerReconciliation {
  const unattributed = Math.max(0, providerUsd - ledgerUsd);
  const fraction = providerUsd > 0 ? unattributed / providerUsd : 0;
  // BOTH legs. A percentage alone flags a $0.30-vs-$0.05 new install (83%, meaningless); an absolute
  // alone flags a $10 drift on $1,000/mo (1%, noise). Only a gap that is both large enough to notice
  // and large enough to matter is worth an operator's attention.
  const material = unattributed >= MATERIAL_ABSOLUTE_USD && fraction >= MATERIAL_FRACTION;
  const exceeds = ledgerUsd - providerUsd >= MATERIAL_ABSOLUTE_USD;
  return {
    providerUsd,
    ledgerUsd,
    unattributedUsd: unattributed,
    unattributedFraction: fraction,
    material,
    status: exceeds ? "ledger-exceeds" : material ? "unattributed" : "reconciled",
  };
}
