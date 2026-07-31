import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs shared with the GitHub workflow (same pattern as pr-work-keys).
import { readAttestation, evaluatePr, hasCodeRabbitLabel, CODERABBIT_LABEL } from "../scripts/pr-review-gate.mjs";

/**
 * Spec: the gate must accept a real attestation, reject a missing or PASTED-TEMPLATE one, and never
 * block a draft. Written from the rule in CLAUDE.md §"Review gate", not from the regex.
 *
 * The check itself is the thing most likely to be wrong here — `pr-task-link.yml` shipped a parser that
 * read a response shape the API never returns, because it lived in a YAML heredoc no test could reach.
 * So the matcher lives in a script and every branch of it is pinned.
 */

const REAL = "## Review — Reviewed by code-reviewer (fable) — verdict CLEAR, 1 LOW deferred";

function pr(over: Record<string, unknown> = {}) {
  return { draft: false, labels: [], body: REAL, ...over };
}

describe("readAttestation — what counts as a recorded review", () => {
  it("accepts the canonical line and reports what it accepted", () => {
    const a = readAttestation(REAL);
    expect(a.ok).toBe(true);
    expect(a.tool).toBe("code-reviewer (fable)");
    expect(a.verdict).toBe("CLEAR, 1 LOW deferred");
  });

  it("finds the line anywhere in a long body", () => {
    expect(readAttestation(`## What\n\nsome prose\n\n${REAL}\n\n## Test plan\n- [ ] x`).ok).toBe(true);
  });

  it("accepts Local Bugbot — the gate is tool-flexible, not Fable-only", () => {
    expect(readAttestation("## Review — Reviewed by Local Bugbot — verdict no blockers").ok).toBe(true);
  });

  it("accepts plain hyphens — editors and authors rewrite em-dashes", () => {
    expect(readAttestation("## Review - Reviewed by Fable - verdict clean").ok).toBe(true);
  });

  it("REJECTS the unedited template — a pasted placeholder certifies a review that never happened", () => {
    const a = readAttestation("## Review — Reviewed by <tool> — verdict <one-line summary>");
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("placeholder");
  });

  it("rejects a half-filled template", () => {
    expect(readAttestation("## Review — Reviewed by Fable — verdict <one-line summary>").ok).toBe(false);
  });

  it("rejects a body with no review line", () => {
    expect(readAttestation("## What\nfixed a bug\n## Test plan\n- [ ] ran it").reason).toBe("missing");
  });

  it("rejects prose that merely mentions a review", () => {
    expect(readAttestation("I reviewed this myself and it looks fine.").ok).toBe(false);
  });

  it("rejects an empty or absent body", () => {
    expect(readAttestation("").ok).toBe(false);
    expect(readAttestation(null).ok).toBe(false);
  });
});

/**
 * Every case below is a FALSE NEGATIVE found by review — an honest attestation the first matcher
 * rejected. These matter more than false positives: blocking real work with a message accusing the
 * author of skipping a review they ran is how a gate gets switched off.
 */
describe("readAttestation — forms that must NOT be rejected", () => {
  it("accepts the bare line the PR template asks for (no `## Review —` prefix)", () => {
    // .github/pull_request_template.md says: "One line: Reviewed by <…> — verdict …"
    expect(readAttestation("## Review summary\n\nReviewed by Fable — verdict no blockers")).toMatchObject({
      ok: true,
      tool: "Fable",
      verdict: "no blockers",
    });
  });

  it("accepts a real attestation even when the TEMPLATE is quoted above it", () => {
    // The gate's own failure message prints the template; pasting it in while fixing must not lock
    // the author out. A single `.exec` matched the placeholder first and rejected the PR.
    const body = "## Review — Reviewed by <tool> — verdict <one-line summary>\n\n## Review — Reviewed by Fable — verdict CLEAR";
    expect(readAttestation(body)).toMatchObject({ ok: true, tool: "Fable", verdict: "CLEAR" });
  });

  it("accepts a verdict containing angle brackets", () => {
    // `<Button>` / `Map<string,int>` are ordinary things to name in a verdict — not a pasted template.
    expect(readAttestation("## Review — Reviewed by Fable — verdict fixed <Button> null deref")).toMatchObject({
      ok: true,
      verdict: "fixed <Button> null deref",
    });
  });

  it("accepts emphasis, blockquotes and CRLF", () => {
    expect(readAttestation("**## Review — Reviewed by Fable — verdict clean**").ok).toBe(true);
    expect(readAttestation("> Reviewed by Local Bugbot — verdict clean").ok).toBe(true);
    expect(readAttestation("## Review — Reviewed by Fable — verdict clean\r\n").ok).toBe(true);
  });

  it("accepts a non-breaking space and `verdict:`", () => {
    expect(readAttestation("Reviewed by\u00a0Fable — verdict:\u00a0clean").ok).toBe(true);
  });

  it("accepts every list-marker form — this repo writes prose in bullets", () => {
    // `* …` used to pass while `- …` was rejected, purely because the emphasis strip ate the asterisk.
    // Accusing someone of skipping a review based on which bullet they typed is the worst kind of
    // false negative: arbitrary, and it teaches people the gate is noise.
    for (const marker of ["-", "+", "*", "1.", "1)", "- [x]", "- [ ]"]) {
      expect(readAttestation(`${marker} Reviewed by Fable — verdict clean`).ok, marker).toBe(true);
    }
  });

  it("accepts unicode minus and horizontal bar as separators", () => {
    expect(readAttestation("Reviewed by Fable − verdict clean").ok).toBe(true);
    expect(readAttestation("Reviewed by Fable ― verdict clean").ok).toBe(true);
  });
});

describe("readAttestation — quoted regions are not claims", () => {
  it("ignores an attestation inside a fenced code block", () => {
    // Otherwise a filled EXAMPLE in a template would auto-pass every PR that kept the template.
    expect(readAttestation("```\n## Review — Reviewed by Fable — verdict clean\n```").ok).toBe(false);
  });

  it("ignores an attestation inside an HTML comment", () => {
    expect(readAttestation("<!--\nReviewed by Fable — verdict clean\n-->").ok).toBe(false);
  });

  it("still finds a real line outside the fence", () => {
    expect(readAttestation("```\nexample: Reviewed by <tool> — verdict <x>\n```\nReviewed by Fable — verdict clean").ok).toBe(true);
  });
});

describe("readAttestation — pathological input", () => {
  it("does not hang on a long hyphen run (the matcher backtracks quadratically)", () => {
    // 65k is GitHub's PR-body cap; unguarded this took ~7s. Self-inflicted only, but a gate that can
    // be stalled by its own input is a gate people learn to ignore.
    const started = Date.now();
    expect(readAttestation(`Reviewed by ${"-".repeat(65_000)} verdict x`).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still reads a normal attestation in a very long body", () => {
    const filler = "lorem ipsum dolor sit amet\n".repeat(2_000);
    expect(readAttestation(`${filler}Reviewed by Fable — verdict clean\n${filler}`).ok).toBe(true);
  });
});

describe("evaluatePr — the gate's verdict", () => {
  it("passes an attested PR", () => {
    expect(evaluatePr(pr())).toMatchObject({ status: "pass", reason: "attested" });
  });

  it("passes an unattested PR that handed the review to CodeRabbit", () => {
    expect(evaluatePr(pr({ body: "no review line", labels: [{ name: CODERABBIT_LABEL }] }))).toMatchObject({
      status: "pass",
      reason: "coderabbit-label",
    });
  });

  it("skips a draft — you push a draft BEFORE reviewing it", () => {
    // Blocking here would teach people to write the attestation early, which is the fabrication the
    // gate exists to prevent. It re-runs on ready_for_review.
    expect(evaluatePr(pr({ draft: true, body: "wip" }))).toMatchObject({ status: "skip" });
  });

  it("FAILS an unattested, unlabelled, non-draft PR", () => {
    expect(evaluatePr(pr({ body: "## What\njust a small change" }))).toMatchObject({
      status: "fail",
      reason: "missing",
    });
  });

  it("FAILS a PR carrying only the pasted template", () => {
    expect(evaluatePr(pr({ body: "## Review — Reviewed by <tool> — verdict <one-line summary>" }))).toMatchObject({
      status: "fail",
      reason: "placeholder",
    });
  });
});

describe("hasCodeRabbitLabel", () => {
  it("matches case-insensitively and tolerates bare strings", () => {
    expect(hasCodeRabbitLabel([{ name: "Ready-For-Review" }])).toBe(true);
    expect(hasCodeRabbitLabel([CODERABBIT_LABEL])).toBe(true);
  });

  it("does not match an unrelated label", () => {
    expect(hasCodeRabbitLabel([{ name: "bug" }])).toBe(false);
    expect(hasCodeRabbitLabel([])).toBe(false);
  });
});
