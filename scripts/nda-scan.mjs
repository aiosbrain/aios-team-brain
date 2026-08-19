#!/usr/bin/env node
/**
 * NDA confidentiality gate — the CI half.
 *
 * ── WHY THIS EXISTS (a real leak, not a hypothetical) ──────────────────────────────────────────
 *
 * A client's name reached this PUBLIC repo in #586 and sat on `main` until an unrelated push from a
 * different machine happened to trip a local hook days later. The gate had been working as designed
 * the whole time — the design was the problem:
 *
 *   • The forbidden-term list is deliberately PRIVATE (it names confidential clients, so committing
 *     it would leak exactly what it protects). It lives outside every repo, per machine.
 *   • The hook that reads it is installed per machine in `.git/hooks/`, which git does not track.
 *   • `.githooks/pre-push` chains that hook IF PRESENT and **skips silently when it is absent** —
 *     documented as deliberate, so contributors without the private list are not blocked.
 *   • So the gate existed on exactly ONE laptop, and whether a client name reached a public repo
 *     depended on whose machine ran `git push`. Nothing in CI checked at all.
 *
 * The local gate is not weakened by this file and is not replaced by it. This closes the hole the
 * local gate structurally cannot: a push from a machine that has never heard of the term list.
 *
 * ── THE LOG IS PUBLIC, SO THE FINDING IS REDACTED ──────────────────────────────────────────────
 *
 * This repo's Actions logs are world-readable. The local gate prints the matching LINE, which is
 * right on a private machine and catastrophic here — a gate that announces "found <client name> at
 * x.ts:40" publishes the very thing it is defending. So by default this reports `file:line` and the
 * INDEX of the term that matched, never the term and never the line. `--reveal` restores the local
 * behaviour and must only be used on a trusted terminal. (`gitleaks --redact` in the same workflow
 * is the existing precedent for this rule.)
 *
 * ── MATCHING IS DELIBERATELY IDENTICAL TO THE LOCAL GATE ───────────────────────────────────────
 *
 * Same ERE alternation over non-comment lines, same `git grep -nEiI`, same path excludes. Two gates
 * that disagree about what counts as a leak are worse than one, because the disagreement is only
 * discovered by a leak getting through the weaker one.
 *
 * FAILS CLOSED, like the local gate: no terms configured is an error, never a pass. The one
 * exception is a fork PR, where GitHub withholds secrets by design — that is reported as
 * NOT-RUN and is the workflow's job to escalate, because an unrunnable gate is not a passing grade.
 *
 * Usage:
 *   NDA_TERMS="$(cat terms.txt)" node scripts/nda-scan.mjs            # CI (redacted)
 *   node scripts/nda-scan.mjs --terms-file ~/.config/aios-nda/terms.txt --reveal
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const reveal = argv.includes("--reveal");
const termsFileIdx = argv.indexOf("--terms-file");
const termsFile = termsFileIdx >= 0 ? argv[termsFileIdx + 1] : null;

/** Same excludes as the local gate: deps, build output, binaries, LICENSE (the maintainer's name
 *  legitimately appears there), and any file whose PURPOSE is to carry the patterns. */
const PATHSPEC = [
  ":!node_modules/**", ":!**/node_modules/**", ":!dist/**", ":!**/dist/**",
  ":!.venv/**", ":!**/__pycache__/**", ":!*.png", ":!*.jpg", ":!*.jpeg", ":!*.pdf",
  ":!*.lock", ":!LICENSE",
  ":!leak-gate.sh", ":!**/leak-gate.sh", ":!nda-leak-gate.sh", ":!**/nda-leak-gate.sh",
  ":!**/confidential-terms.txt", ":!**/confidential-terms.local.txt",
  ":!**/confidential-terms.example.txt", ":!confidential-terms.example.txt",
];

/** Non-comment, non-blank lines — the local gate's exact parse. Exported for the guard test. */
export function parseTerms(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** `file:line` for every hit, plus which term index matched — never the line, never the term. */
export function scan(terms, { revealLines = false } = {}) {
  if (terms.length === 0) throw new Error("no active NDA terms — refusing to report a pass");
  const findings = [];
  // One grep per term rather than one alternation, so a hit can be attributed to a term INDEX
  // without echoing the term. The local gate does not need this because it may print freely.
  terms.forEach((term, i) => {
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-nEiI", "-e", term, "--", ...PATHSPEC], { encoding: "utf8" });
    } catch (e) {
      // git grep exits 1 for "no matches" — that is the clean case, not an error.
      if (e.status === 1) return;
      throw e;
    }
    for (const line of out.split("\n").filter(Boolean)) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      findings.push({ file: m[1], line: Number(m[2]), termIndex: i, text: revealLines ? m[3] : undefined });
    }
  });
  return findings;
}

function main() {
  const raw = termsFile ? readFileSync(termsFile, "utf8") : (process.env.NDA_TERMS ?? "");
  if (!raw.trim()) {
    console.error("NDA-GATE: BLOCKED — no term list supplied (NDA_TERMS secret or --terms-file).");
    console.error("          The gate fails closed: an unconfigured gate is not a passing grade.");
    process.exit(2); // distinct from 1 so a workflow can tell misconfiguration from a real leak
  }
  const terms = parseTerms(raw);
  let findings;
  try {
    findings = scan(terms, { revealLines: reveal });
  } catch (e) {
    console.error(`NDA-GATE: BLOCKED — ${e.message}`);
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log(`NDA-GATE: clean (${terms.length} term(s) checked across the tracked tree)`);
    return;
  }
  console.error("============================================================");
  console.error("NDA-GATE: BLOCKED — confidential identifier(s) detected.");
  console.error(reveal ? "" : "Locations only — the term is withheld because this log may be public.");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  (term #${f.termIndex + 1})${f.text ? `  ${f.text}` : ""}`);
  }
  console.error("------------------------------------------------------------");
  console.error("Run locally to see what matched:");
  console.error("  node scripts/nda-scan.mjs --terms-file ~/.config/aios-nda/terms.txt --reveal");
  console.error("============================================================");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
