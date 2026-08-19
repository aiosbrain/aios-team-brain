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
 * ── SAME TERM SEMANTICS AS THE LOCAL GATE; DELIBERATELY STRICTER EVERYWHERE ELSE ────────────────
 *
 * Terms are read and matched the same way — non-comment lines, each an ERE, `git grep -nEiI` — because
 * two gates that disagree about what a TERM is are worse than one: the disagreement surfaces only when
 * something gets through the weaker. Two differences are intentional and both make this one stricter:
 *   • tighter path excludes (see PATHSPEC);
 *   • a `git grep` HARD error (exit >= 2, e.g. a term that is not valid ERE) throws here and exits 2.
 *     The local gate's `|| true` swallows it and prints "clean" — it fails OPEN on exactly the input
 *     most likely to be a typo in the term list. Worth fixing there; it lives outside this repo.
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
const rangeIdx = argv.indexOf("--range");
const range = rangeIdx >= 0 ? argv[rangeIdx + 1] : null;

/** Excludes: deps, build output, binaries, the root LICENSE (the maintainer's name legitimately
 *  appears there), and any file whose PURPOSE is to carry the patterns.
 *
 *  TIGHTER THAN THE LOCAL GATE, deliberately (review Medium 6). The local gate excludes `*.lock` and
 *  `LICENSE` at ANY depth, so a stray `notes.lock` or a nested `LICENSE` is a bypass surface. That
 *  was tolerable when the gate was one person's pre-push convenience; this one is the universal
 *  check, so the lockfile exclusion names the actual lockfile and LICENSE is root-anchored. */
const PATHSPEC = [
  ":!node_modules/**", ":!**/node_modules/**", ":!dist/**", ":!**/dist/**",
  ":!.venv/**", ":!**/__pycache__/**", ":!*.png", ":!*.jpg", ":!*.jpeg", ":!*.pdf",
  ":!package-lock.json", ":!/LICENSE",
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
export function scan(terms, { revealLines = false, cwd = process.cwd() } = {}) {
  if (terms.length === 0) throw new Error("no active NDA terms — refusing to report a pass");
  const findings = [];
  // One grep per term rather than one alternation, so a hit can be attributed to a term INDEX
  // without echoing the term. The local gate does not need this because it may print freely.
  terms.forEach((term, i) => {
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-nEiI", "-e", term, "--", ...PATHSPEC], { encoding: "utf8", cwd });
    } catch (e) {
      // git grep exits 1 for "no matches" — that is the clean case, not an error.
      if (e.status === 1) return;
      throw e;
    }
    for (const line of out.split("\n").filter(Boolean)) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      // No term index (review Low 8 — a membership oracle). `i` is used only for `--reveal`.
      findings.push({ file: m[1], line: Number(m[2]), text: revealLines ? m[3] : undefined, term: revealLines ? terms[i] : undefined });
    }
  });
  return findings;
}

/**
 * Scan a commit RANGE's patches and messages, not just the final tree (review Medium 5).
 *
 * A clean tree is not a clean history. Merge commits are enabled on this repo, so a term added in
 * one commit of a PR and removed in a later one still lands on `main` permanently — and a term in a
 * COMMIT MESSAGE never appears in any tree at all. Both are as public as a file. Returns bare
 * markers rather than file:line, because a patch hunk's "location" is a commit, and naming it is
 * enough to find it locally.
 */
export function scanRange(terms, rangeSpec, { revealLines = false, cwd = process.cwd() } = {}) {
  if (terms.length === 0) throw new Error("no active NDA terms — refusing to report a pass");
  const res = [];
  const regexes = terms.map((t) => new RegExp(t, "i"));

  // ADDED LINES ONLY. A commit that REMOVES a term necessarily contains it on the removed side of
  // its own patch — so a naive scan fails every scrub commit, including the one that introduced
  // this gate. A gate that blocks the fix for the thing it guards gets bypassed, and a bypassed
  // gate is worse than none. Removal is the cure, not the disease; only additions are new exposure.
  let patch = "";
  try {
    patch = execFileSync("git", ["log", "-p", "--no-color", "--format=%x00%H", rangeSpec], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      cwd,
    });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  let sha = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("\u0000")) { sha = line.slice(1, 13); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const body = line.slice(1);
    for (const [i, re] of regexes.entries()) {
      if (re.test(body)) {
        res.push({ file: `commit ${sha} (added line)`, line: 0, term: revealLines ? terms[i] : undefined, text: revealLines ? body : undefined });
        break;
      }
    }
  }

  // Commit MESSAGES never appear in any tree, and are as public as a file. Any occurrence counts —
  // a message cannot be "removed" by a later commit the way a line can.
  for (const [i, term] of terms.entries()) {
    let out = "";
    try {
      out = execFileSync("git", ["log", "--no-color", "-i", "--grep", term, "--format=%H", rangeSpec], { encoding: "utf8", cwd });
    } catch (e) {
      if (e.status === 1) continue;
      throw e;
    }
    for (const m of new Set(out.match(/^[0-9a-f]{40}$/gm) ?? [])) {
      res.push({ file: `commit ${m.slice(0, 12)} (message)`, line: 0, term: revealLines ? terms[i] : undefined });
    }
  }
  return res;
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
    // The tree is what ships; the range is what becomes permanent history. Both, when given one.
    if (range) findings = findings.concat(scanRange(terms, range, { revealLines: reveal }));
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
    console.error(`  ${f.file}:${f.line}${f.text ? `  ${f.text}` : ""}`);
  }
  console.error("------------------------------------------------------------");
  console.error("Run locally to see what matched:");
  console.error("  node scripts/nda-scan.mjs --terms-file ~/.config/aios-nda/terms.txt --reveal");
  console.error("============================================================");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
