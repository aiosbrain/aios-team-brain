/**
 * Arm separation for the SMALL-model battery (GRAPHSMALL-1).
 *
 * The window battery's arms differ by a bind-mounted FILE, so "the arms differ by exactly one thing"
 * is checkable with `diff`. This battery's arms differ by a team CONFIG FIELD
 * (`teams.extraction_small_model`), which is not checkable that way — and review named the concrete
 * failure: `seed-local.mjs` copies the whole `teams` row into a battery DB that sequential arm runs
 * SHARE, so a `STRONG` run following a `SMALL` run inherits the field, both arms route small, the
 * delta collapses, and the session reads as "no savings / quality equal" when in truth arm separation
 * was broken. That is the worst possible failure: it looks like a clean negative result.
 *
 * So separation is a MECHANISM here, not a claim:
 *   1. `armConfig()` states each arm's field value explicitly — `STRONG` sets it to NULL rather than
 *      leaving it alone, so nothing is ever inherited from whatever ran before.
 *   2. `effectiveSnapshot()` records what the proxy would ACTUALLY resolve (the small backend target),
 *      not what the arm intended — an arm whose model name was set but which still resolves to null
 *      is a strong arm wearing a small label, and only the resolved value can tell.
 *   3. `assertArmsDiffer()` refuses a session whose two snapshots are identical, or which differ in
 *      more than the one permitted field.
 *
 * Kept in its own file (not folded into `seed-local.mjs`) deliberately: PIPEFF-5's paused branch
 * `feat/graph-combined-extraction` edits that file, and colliding with in-flight work to save one
 * import is a bad trade.
 */

/** The single field these arms are permitted to differ in. */
export const ARM_FIELD = "extraction_small_model";

export const ARMS = Object.freeze({
  /** Today's production behaviour: no small model configured, so every call routes strong. */
  STRONG: Object.freeze({ name: "STRONG", [ARM_FIELD]: null }),
  /** The lever under test. `model` is supplied per session — see `armConfig`. */
  SMALL: Object.freeze({ name: "SMALL" }),
});

/**
 * The config an arm must be seeded with. Always returns an explicit value for `ARM_FIELD` — including
 * `null` for STRONG — so a previous arm's value can never be inherited by omission.
 */
export function armConfig(arm, smallModel) {
  if (arm === "STRONG") return { [ARM_FIELD]: null };
  if (arm === "SMALL") {
    const m = typeof smallModel === "string" ? smallModel.trim() : "";
    if (!m) throw new Error("armConfig: the SMALL arm requires a model name");
    return { [ARM_FIELD]: m };
  }
  throw new Error(`armConfig: unknown arm ${String(arm)}`);
}

/**
 * What the arm RESOLVED to, as the proxy would see it. `resolved` is the small-backend target
 * (`selectSmallExtractionBackend(...)?.model ?? null`); pass it in rather than importing the resolver
 * so this file stays a pure, testable statement about arm identity.
 */
export function effectiveSnapshot(arm, resolved) {
  return { arm, [ARM_FIELD]: resolved ?? null };
}

/**
 * Refuse a session whose arms did not actually differ.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. A caller that ignores this and reports a delta
 * is reporting the difference between an arm and itself.
 */
export function assertArmsDiffer(a, b) {
  if (!a || !b) return { ok: false, reason: "arm separation: a snapshot is missing" };
  if (a.arm === b.arm) return { ok: false, reason: `arm separation: both snapshots are "${a.arm}"` };

  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== "arm"));
  const differing = [...keys].filter((k) => (a[k] ?? null) !== (b[k] ?? null));

  if (differing.length === 0) {
    // The exact leak this exists to catch: STRONG ran after SMALL and inherited the field.
    return {
      ok: false,
      reason: `arm separation: ${a.arm} and ${b.arm} resolved IDENTICAL config (${ARM_FIELD}=${String(a[ARM_FIELD] ?? null)}) — a prior arm's value was inherited, so the measured delta is between an arm and itself`,
    };
  }
  if (differing.length > 1 || differing[0] !== ARM_FIELD) {
    return {
      ok: false,
      reason: `arm separation: arms differ in [${differing.join(", ")}], but only ${ARM_FIELD} is permitted`,
    };
  }
  // The permitted field must genuinely be strong-vs-small, not small-vs-a-different-small.
  const strong = [a, b].find((s) => (s[ARM_FIELD] ?? null) === null);
  if (!strong) {
    return { ok: false, reason: `arm separation: neither arm has ${ARM_FIELD}=null, so neither is the incumbent` };
  }
  return { ok: true };
}
