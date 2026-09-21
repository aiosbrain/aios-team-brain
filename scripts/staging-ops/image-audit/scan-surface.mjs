/**
 * AIO-997 audit — THE SCANNER'S INPUT REPRESENTATION, and why it is not just "the file".
 *
 * TWO MEASURED FACTS ABOUT THE PINNED SCANNER drive everything in this module. Both were established
 * by executing gitleaks 8.28.0 itself, not inferred from its documentation:
 *
 *  1. **It skips a file whose first bytes are binary magic.** A 61-byte fixture containing a
 *     detectable synthetic credential behind four ELF bytes (`7f 45 4c 46`) produced an EMPTY report
 *     and `scanned ~0 bytes`. The same bytes without the magic produced one `github-pat` finding. A
 *     four-NUL prefix did NOT suppress detection, so this is magic/MIME sniffing rather than general
 *     binary-byte handling — and switching to `detect --pipe` (stdin) reproduced the same skip, so
 *     stdin is not a rescue.
 *  2. **Its default config carries a global path allowlist.** With `extend.useDefault = true`, the
 *     identical plaintext staged as `.bin` and `.svg` was skipped (`DBG skipping file: global
 *     allowlist`) while the same bytes as `.txt` were found. Three byte-identical files, one finding.
 *
 * Both defects produced a CLEAN-LOOKING report over content nobody scanned, with no limitation
 * recorded anywhere. That is the failure this module exists to remove.
 *
 * THE REPRESENTATION, and its one hard rule. A staged scan file is a fixed printable ASCII header
 * followed by the member's EXACT ORIGINAL BYTES. Nothing is decoded, re-encoded, truncated,
 * normalised, or filtered; no NUL is dropped; no `strings`-style extraction happens anywhere. The
 * suffix of every staged id is the same fixed one, chosen by this audit and never inherited from the
 * member's own name. So:
 *
 *   staged bytes  ===  HEADER || original bytes            (byte-for-byte, asserted by test)
 *
 * WHAT THIS DOES AND DOES NOT BUY. It makes the pinned scanner actually READ a binary-magic member,
 * measured on the exact fixture above (84 scanned bytes, one finding, original 61 bytes preserved).
 * It does NOT prove every binary format, encoding or compression is now covered, and it says nothing
 * about archives — those stay `export-walk`'s bounded expansion with recorded limitations. Coverage
 * means "the recorded byte-preserving scanner input under the recorded rules", and every gap outside
 * that is still a limitation that blocks.
 *
 * IDENTITY IS UNAFFECTED. Hashes, the `/app` inventory comparison and archive classification all run
 * on the ORIGINAL member bytes. The header exists only on the scanner's copy.
 */
import { randomBytes } from "node:crypto";

/**
 * The representation, pinned. `header` is the EXACT 23-byte string the feasibility probe measured;
 * changing it changes what the pinned scanner sees, so it is versioned and recorded in the evidence.
 */
export const SCAN_REPRESENTATION = Object.freeze({
  version: "aios.image-audit.scan-surface.v1",
  header: "AIOS binary scan input\n",
  /**
   * ONE suffix for every staged file, whatever the member was called. Inheriting `.bin`/`.svg` is
   * exactly what the default config's global allowlist keys on.
   */
  suffix: ".txt",
  note:
    "each staged scan file is this fixed ASCII header followed by the member's exact original bytes; " +
    "no strings extraction, decoding, truncation, normalisation or dropped NULs. Identity, inventory " +
    "and archive classification use the original bytes, never this representation.",
});

/** The header as bytes. Frozen at module load so no caller can re-derive it differently. */
export const SCAN_HEADER = Buffer.from(SCAN_REPRESENTATION.header, "ascii");

/** Where the image CONFIG/history is staged. A group of its own, so a finding there is attributable. */
export const CONFIG_SCAN_GROUP = "C";

/** `L3/000412.txt` — a layer index (or the config group) and an ordinal, and nothing else. */
export function scanId(group, sequence) {
  return `${group}/${String(sequence).padStart(6, "0")}${SCAN_REPRESENTATION.suffix}`;
}

/** The scanner's copy of a member: fixed header, then the original bytes, unchanged. */
export function wrapForScan(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.concat([SCAN_HEADER, body]);
}

// ---------------------------------------------------------------------------
// The capability canary
// ---------------------------------------------------------------------------

/** Four bytes of ELF magic — the exact prefix the measured skip keys on. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * A synthetic, per-run, credential-SHAPED value that the pinned config's `github-pat` rule matches.
 *
 * Generated rather than hardcoded, for two reasons that both matter: a literal of this shape in a
 * public repository would be found by the repository's own scanner on every CI run, and a fixed value
 * would be a constant in source that reviewers have to keep proving is not real. The SHAPE is fixed
 * (that is what the canary tests); the value is minted per run and never leaves private scratch.
 */
export function canarySentinel(random = randomBytes) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const body = [...random(36)].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `ghp_${body}`;
}

/**
 * The two canary fixtures, as a matched pair. Both carry the SAME sentinel and differ only by the
 * representation — which is what makes the result attributable to the representation rather than to
 * the rule, the config or the binary being broken.
 *
 *   `unwrapped` — ELF magic + sentinel. The measured behaviour is ZERO findings.
 *   `wrapped`   — the representation applied to those exact bytes. Expected: ONE finding.
 */
export function canaryFixtures(sentinel) {
  const original = Buffer.concat([ELF_MAGIC, Buffer.from(`\nGITHUB_TOKEN=${sentinel}\n`, "ascii")]);
  return Object.freeze({
    sentinel,
    original,
    unwrapped: original,
    wrapped: wrapForScan(original),
  });
}

/**
 * What the canary's two reports mean for COVERAGE.
 *
 * `wrappedFindings === 0` is the only outcome that changes the audit's verdict: it says the pinned
 * scanner did not read the representation this audit stages, so every binary-magic member's coverage
 * is unverified and must be recorded as such. It is a REFUSAL of a coverage claim, never a finding
 * about the image.
 *
 * `unwrappedFindings > 0` is not a failure. It means the skip this representation exists to defeat
 * did not occur on this platform/version, so the wrapper was belt-and-braces for this run — recorded
 * so a reader can see the negative control did not hold, rather than silently reading as proof.
 */
export function assessCanary({ wrappedFindings, unwrappedFindings }) {
  const wrapped = Number.isInteger(wrappedFindings) ? wrappedFindings : -1;
  const unwrapped = Number.isInteger(unwrappedFindings) ? unwrappedFindings : -1;
  if (wrapped < 0 || unwrapped < 0) {
    return Object.freeze({
      status: "unverified",
      representation: SCAN_REPRESENTATION.version,
      reason: "the capability canary produced no readable finding counts",
    });
  }
  if (wrapped === 0) {
    return Object.freeze({
      status: "unverified",
      representation: SCAN_REPRESENTATION.version,
      reason: "the pinned scanner did not detect the synthetic sentinel in this audit's staged representation",
    });
  }
  return Object.freeze({
    status: "verified",
    representation: SCAN_REPRESENTATION.version,
    /**
     * The negative control, reported as measured. `false` means the unwrapped binary-magic fixture
     * was ALSO detected, i.e. the skip did not reproduce here — true on some platform/version
     * combination, and a fact a reader is entitled to instead of an implied guarantee.
     */
    binaryMagicSkipReproduced: unwrapped === 0,
    note: "measured on a synthetic per-run sentinel in private scratch; never counted as an image finding",
  });
}
