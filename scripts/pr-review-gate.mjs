import { CONTRIBUTION_BASE } from "./branches.mjs";

/**
 * The pre-push review gate, as a check (CLAUDE.md §"Review gate").
 *
 * The convention — every PR records WHAT reviewed its diff — existed for a while and was honoured only
 * when someone remembered. That is the failure mode CLAUDE.md §2 names: "a single writer + a
 * build-failing guard > discipline you have to remember."
 *
 * Pure and unit-tested ON PURPOSE. `pr-task-link.yml` documents what happens otherwise: its response
 * parser "shipped reading the tasks response in a shape it never returns … because it lived in a YAML
 * heredoc that no tier could reach". A gate that is itself unverified either blocks honest PRs or waves
 * everything through, and nobody finds out which.
 *
 * ── The asymmetry that shapes this file ─────────────────────────────────────────────────────────────
 * A FALSE NEGATIVE (rejecting a real attestation) is much worse than a false positive. It blocks honest
 * work with a message accusing the author of skipping a review they did — and the response to a gate
 * that cries wolf is to switch it off. A false positive costs one un-gated PR. So the matcher is
 * deliberately PERMISSIVE about form and strict only about substance:
 *   - `## Review — Reviewed by X — verdict Y` (CLAUDE.md's canonical line) and a bare
 *     `Reviewed by X — verdict Y` (what `.github/pull_request_template.md` asks for) both pass.
 *   - emphasis, heading level, blockquote, NBSP, CRLF, `verdict:`, and every unicode dash all pass.
 * Rather than one baroque regex, the body is NORMALIZED and then matched — each step is separately
 * testable, and adding tolerance can't silently break another case.
 *
 * SHAPE ALONE IS NOT A CHECK — the lesson the work-key check learned when every PR in one session cited
 * an invented `AIO-48x` that matched the pattern and existed nowhere. The skill hands authors a template
 * containing literal `<tool>` / `<one-line summary>` slots; pasting it unedited must FAIL, or the gate
 * certifies a review that never happened.
 */

/** Fenced code and HTML comments are QUOTED text, not claims. Stripping them first is what stops the
 *  instructions (which contain the template) from either poisoning or satisfying the check — the same
 *  reason `pr-work-keys.mjs` refuses to count a work-key written inside backticks. */
function stripQuotedRegions(body) {
  return String(body ?? "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n");
}

/** One line, reduced to the form the matcher cares about. */
function normalizeLine(line) {
  return line
    .replace(/ /g, " ") // NBSP — routine when pasting from rendered markdown
    .replace(/[*_`]/g, "") // emphasis / inline code around any part of the line
    // Leading markdown furniture: blockquote, heading hashes, a list marker (`-`, `+`, `1.`, `1)`)
    // and a task-list checkbox. This repo's prose style is bullets, so an attestation written as a
    // list item is a LIKELY form, not an exotic one — and before this `* Reviewed by …` passed while
    // `- Reviewed by …` was rejected, purely because the emphasis strip above ate the asterisk.
    // Being accused of skipping a review you ran, based on which bullet you typed, is exactly the
    // false negative this file exists to avoid.
    .replace(/^[\s>#]*(?:[-+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, "")
    .replace(/[‐-―−]/g, "-") // every unicode dash/minus → ASCII hyphen
    .trim();
}

// After normalization: an optional `Review -` label, then the claim. `.+?` for the tool is bounded by
// the ` - verdict` separator; the verdict runs to end of line.
const CLAIM_RE = /^(?:review\s*-+\s*)?reviewed by\s+(.+?)\s*-+\s*verdict\b\s*:?\s*(.+)$/i;

/** An unedited template slot. Anchored to the WHOLE value: a verdict may legitimately contain angle
 *  brackets (`fixed <Button> null deref`, `Map<string,int>`) and rejecting those told honest authors
 *  they had pasted a template. Only a value that IS a slot counts. */
function isPlaceholder(value) {
  const v = (value ?? "").trim();
  if (!v) return true;
  return /^<[^>]*>$/.test(v);
}

/**
 * Does this PR body carry a REAL attestation? Scans EVERY candidate line and accepts if any one is
 * genuine — a single `.exec` meant that quoting the template (or this check's own error message, which
 * prints it) above a real attestation rejected the PR.
 *
 * Returns the parsed parts so the caller can echo what it accepted; an opaque pass is how a broken
 * matcher hides.
 */
export function readAttestation(body) {
  let sawPlaceholder = false;
  for (const raw of stripQuotedRegions(body).split(/\r?\n/)) {
    // Cheap pre-filter, and it is what keeps `CLAIM_RE` off pathological input: its `(.+?)\s*-+\s*`
    // backtracks quadratically on a long run of hyphens (65k chars ≈ 7s). Only a line that actually
    // claims a review reaches the regex, and a line far longer than any real attestation is skipped.
    if (raw.length > 2000 || !/reviewed by/i.test(raw)) continue;
    const m = CLAIM_RE.exec(normalizeLine(raw));
    if (!m) continue;
    const [, tool, verdict] = m;
    if (isPlaceholder(tool) || isPlaceholder(verdict)) {
      sawPlaceholder = true;
      continue;
    }
    return { ok: true, tool: tool.trim(), verdict: verdict.trim() };
  }
  return { ok: false, reason: sawPlaceholder ? "placeholder" : "missing" };
}

/** The sanctioned alternative when no local reviewer was available: hand the diff to CodeRabbit. */
export const CODERABBIT_LABEL = "ready-for-review";

export function hasCodeRabbitLabel(labels) {
  return (labels ?? []).some((l) => String(l?.name ?? l).trim().toLowerCase() === CODERABBIT_LABEL);
}

/**
 * The gate's verdict for one PR.
 *
 * `pass` — attested, or handed to CodeRabbit via the label.
 * `skip` — a draft. You legitimately push a draft BEFORE reviewing it; blocking there would only teach
 *          people to write the line early, which is the fabrication this is meant to prevent. The gate
 *          re-runs on `ready_for_review`, so nothing merges unattested.
 * `fail` — everything else.
 */
export function evaluatePr(pr) {
  if (pr?.draft) return { status: "skip", reason: "draft" };
  if (hasCodeRabbitLabel(pr?.labels)) return { status: "pass", reason: "coderabbit-label" };
  const att = readAttestation(pr?.body);
  if (att.ok) return { status: "pass", reason: "attested", tool: att.tool, verdict: att.verdict };
  return { status: "fail", reason: att.reason };
}

// The template is shown INSIDE a fenced block, which `stripQuotedRegions` removes — so an author who
// pastes this whole message into the PR body while fixing it doesn't lock themselves out.
export const FAIL_MESSAGE = {
  missing:
    `This PR records no diff review. Per CLAUDE.md, fetch the contribution base and review \`git diff origin/${CONTRIBUTION_BASE}...HEAD\` with a local ` +
    "reviewer (Fable `code-reviewer`, Local Bugbot, or equivalent), then add ONE line to the PR body:\n" +
    "```\n## Review — Reviewed by <the reviewer you ran> — verdict <what it found>\n```\n" +
    `If no local reviewer was available, say so and add the \`${CODERABBIT_LABEL}\` label so CodeRabbit reviews it instead.`,
  placeholder:
    "The review line still has the template's `<...>` slots unfilled. Name the reviewer you actually " +
    "ran and what it found — a pasted template certifies a review that never happened.",
};
