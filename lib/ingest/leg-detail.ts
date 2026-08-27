/**
 * How one failing pipeline leg reads in the banner — LLMCREDIT-3.
 *
 * ⚠️ ITS OWN MODULE, and the reason is a boundary `tsc` cannot see. This composition began life inside
 * `lib/ingest/pipeline-health.ts`, which is `import "server-only"`, and the banner that needs it is
 * `"use client"` — so the Next build failed while `npx tsc --noEmit` and the whole unit tier stayed
 * green (the test config even aliases `server-only` to an empty stub). CI's `npm run build` is what
 * caught it. Anything BOTH sides need lives here, where neither boundary applies.
 */

/** The provider's own words are kept available, never allowed to BE the message. ONE constant: the
 *  banner had its own copy of this number, which is two constants that would drift. */
export const RAW_ERROR_CLIP = 160;

export interface LegDetailInput {
  error: string | null;
  diagnosis: { headline: string; action: string } | null;
}

/**
 * What the banner prints for one failing leg: the sentence an operator can act on, and the provider's
 * own words underneath.
 *
 * PURE, and it is the CALL SITE — extracted because the component itself is not reachable from this
 * repo's unit tier (no DOM harness, and `@testing-library` is not installed), so pinning only the
 * classifier would leave "does the banner actually lead with it" tested by nothing. That is the
 * pin-the-call-site failure this repo names, and a review found both specced criteria missing.
 */
export function legDetail(leg: LegDetailInput): { lead: string | null; raw: string | null } {
  const raw = leg.error
    ? leg.error.length > RAW_ERROR_CLIP
      ? `${leg.error.slice(0, RAW_ERROR_CLIP)}…`
      : leg.error
    : null;
  if (!leg.diagnosis) return { lead: null, raw };
  return { lead: `${leg.diagnosis.headline} ${leg.diagnosis.action}`, raw };
}
