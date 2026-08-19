#!/usr/bin/env node
/* global process, console */
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
import { execFileSync, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const argv = process.argv.slice(2);
const reveal = argv.includes("--reveal");
const termsFileIdx = argv.indexOf("--terms-file");
const termsFile = termsFileIdx >= 0 ? argv[termsFileIdx + 1] : null;
const rangeIdx = argv.indexOf("--range");
const range = rangeIdx >= 0 ? argv[rangeIdx + 1] : null;
const treeIdx = argv.indexOf("--tree");
const tree = treeIdx >= 0 ? argv[treeIdx + 1] : null;

// No path exclusions. This is a scan of the tracked tree, and a tracked lockfile, binary, symlink,
// filename, or generated-looking directory is just as public as source code. `git grep` already
// ignores untracked dependencies/build output, so exclusions only create places a leak can hide.
const PATHSPEC = ["."];

/** Non-comment, non-blank lines — the local gate's exact parse. Exported for the guard test. */
export function parseTerms(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function assertSafeTerms(terms) {
  // Backreferences make BSD/GNU implementations leave their linear-time automata and can hang on
  // attacker-chosen content. The private list does not need them; reject without echoing which term.
  if (terms.some((term) => /\\[1-9]/.test(term))) {
    throw new Error("confidential-pattern scan could not run");
  }
}

/** Run a term-bearing subprocess without ever propagating its command/error text to a public log. */
function runRedacted(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...options });
  } catch (e) {
    if (e.status === 1) return null;
    throw new Error("confidential-pattern scan could not run");
  }
}

/** Match the private EREs with the system ERE engine, never a dynamic JavaScript RegExp. */
function matchesAnyEre(value, terms) {
  assertSafeTerms(terms);
  const args = ["-Eiq", ...terms.flatMap((term) => ["-e", term])];
  const result = spawnSync("grep", args, { input: value, encoding: "utf8", timeout: 30_000 });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  // Do not include stderr: an invalid expression may be echoed there.
  throw new Error("confidential-pattern scan could not run");
}

function matchingTermSets(values, terms) {
  const sets = values.map(() => new Set());
  if (values.length === 0) return sets;
  const input = values.join("\n");
  for (const [termIndex, term] of terms.entries()) {
    const result = spawnSync("grep", ["-Ein", "-e", term], {
      input,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.status === 1) continue;
    if (result.status !== 0) throw new Error("confidential-pattern scan could not run");
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const valueIndex = Number(line.slice(0, line.indexOf(":"))) - 1;
      if (sets[valueIndex]) sets[valueIndex].add(termIndex);
    }
  }
  return sets;
}

/** One POSIX-ERE process for a whole corpus; matching text stays captured and is never emitted. */
function matchingIndexes(values, terms) {
  if (values.length === 0) return [];
  assertSafeTerms(terms);
  const input = values
    .map((value) => value.normalize("NFKC").replace(/[\0\r\n]/g, " "))
    .join("\n");
  const result = spawnSync("grep", ["-Ein", ...terms.flatMap((term) => ["-e", term.normalize("NFKC")])], {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error("confidential-pattern scan could not run");
  return [...new Set(result.stdout.split("\n").filter(Boolean).map((line) => Number(line.slice(0, line.indexOf(":"))) - 1))];
}

function safeLocation(path, terms) {
  const hasControlCharacter = [...path].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  const unsafe = hasControlCharacter || matchesAnyEre(
    path.normalize("NFKC").replace(/[\r\n]/g, " "),
    terms.map((term) => term.normalize("NFKC"))
  );
  return unsafe
    ? "tracked path (redacted)"
    : path;
}

function trackedPaths(cwd, treeish = null) {
  const args = treeish ? ["ls-tree", "-rz", "--name-only", treeish] : ["ls-files", "-z"];
  const out = runRedacted("git", args, { encoding: "utf8", cwd });
  return (out ?? "").split("\0").filter(Boolean);
}

function submodulePaths(cwd, treeish = null) {
  const args = treeish ? ["ls-tree", "-rz", treeish] : ["ls-files", "-s", "-z"];
  const out = runRedacted("git", args, { encoding: "utf8", cwd }) ?? "";
  return out
    .split("\0")
    .filter(Boolean)
    .map((record) => /^(\d{6})\s+[^\t]+\t([\s\S]+)$/.exec(record))
    .filter((match) => match?.[1] === "160000")
    .map((match) => match[2]);
}

function trackedBuffer(path, cwd, treeish = null) {
  try {
    if (treeish) {
      const out = runRedacted("git", ["show", `${treeish}:${path}`], {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (out === null) throw new Error("tracked content could not be read");
      return out;
    }
    const absolute = `${cwd}/${path}`;
    const stat = lstatSync(absolute);
    return stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute, "utf8")) : readFileSync(absolute);
  } catch {
    throw new Error("tracked content could not be read");
  }
}

function trackedText(path, cwd, treeish = null) {
  const bytes = trackedBuffer(path, cwd, treeish);
  const representations = [bytes.toString("utf8")];
  // UTF-16 is common enough to warrant explicit decoding. NUL collapsing alone turns every letter
  // into a separately spaced token and misses the identifier. Try both byte orders; false positives
  // are safe and remain location-only.
  if (bytes.includes(0)) {
    representations.push(bytes.toString("utf16le"));
    const swapped = Buffer.from(bytes);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = first;
    }
    representations.push(swapped.toString("utf16le"));
  }
  return representations.join(" ");
}

function isOpaqueBinary(bytes, path) {
  // Check the WHOLE blob: a format may carry a long ASCII header before compressed bytes. Also
  // classify common compressed/document/image containers by name and magic; attempting to unpack
  // attacker-controlled archives inside a secret-bearing workflow creates parser and zip-bomb risk.
  if (bytes.includes(0)) return true;
  if (/\.(?:7z|bz2|docx?|gif|gz|jpe?g|pdf|png|rar|tar|tgz|webp|xlsx?|xz|zip)$/i.test(path)) return true;
  const magic = bytes.subarray(0, 8).toString("hex");
  if (/^(?:25504446|504b0304|1f8b08|425a68|fd377a585a00|377abcaf271c|52617221|89504e47|ffd8ff|47494638)/.test(magic)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** `file:line` for every hit, plus which term index matched — never the line, never the term. */
export function scan(terms, { revealLines = false, cwd = process.cwd(), treeish = null } = {}) {
  if (terms.length === 0) throw new Error("no active NDA terms — refusing to report a pass");
  assertSafeTerms(terms);
  const findings = [];
  const seen = new Set();
  const normalizedTerms = terms.map((term) => term.normalize("NFKC"));

  // `-l -z` is filename-safe (colons/newlines cannot corrupt parsing) and does NOT ignore binary
  // blobs. We report line 0 rather than buffering the matching line, keeping the protected text out
  // of every ordinary output path. `--reveal` re-reads locally for the trusted-terminal escape hatch.
  for (const [i, term] of terms.entries()) {
    const treeArgs = treeish ? [treeish] : [];
    const out = runRedacted("git", ["grep", "-lEiz", "-e", term, ...treeArgs, "--", ...PATHSPEC], {
      encoding: "utf8",
      cwd,
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const rawPath of (out ?? "").split("\0").filter(Boolean)) {
      const path = treeish && rawPath.startsWith(`${treeish}:`) ? rawPath.slice(treeish.length + 1) : rawPath;
      const file = safeLocation(path, terms);
      const key = `${file}\0tree`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file,
        line: 0,
        text: revealLines ? trackedText(path, cwd, treeish) : undefined,
        term: revealLines ? terms[i] : undefined,
      });
    }
  }

  // Canonicalize Unicode and collapse line boundaries, so decomposed spelling and an identifier
  // split across adjacent lines do not bypass the line-oriented exact-byte scan above. This is a
  // secondary conservative pass; a hit is intentionally reported at file:0.
  const opaqueSubmodules = submodulePaths(cwd, treeish);
  if (opaqueSubmodules.length > 0) {
    findings.push({
      file: "submodule content (opaque)",
      line: 0,
      text: revealLines ? opaqueSubmodules.join("\n") : undefined,
    });
  }
  const submoduleSet = new Set(opaqueSubmodules);
  const paths = trackedPaths(cwd, treeish).filter((path) => !submoduleSet.has(path));
  for (const index of matchingIndexes(paths, normalizedTerms)) {
    const path = paths[index];
    const file = "tracked path (redacted)";
    const key = `${file}\0path`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ file, line: 0, text: revealLines ? path : undefined });
  }
  const normalizedFiles = paths.map((path) => trackedText(path, cwd, treeish).normalize("NFKC").replace(/[\0\r\n]/g, " "));
  for (const index of matchingIndexes(normalizedFiles, normalizedTerms)) {
    const path = paths[index];
    const normalized = normalizedFiles[index];
    const file = safeLocation(path, terms);
    const key = `${file}\0tree`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ file, line: 0, text: revealLines ? normalized : undefined });
  }
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
  assertSafeTerms(terms);
  const res = [];
  const normalizedTerms = terms.map((term) => term.normalize("NFKC"));
  const commits = (runRedacted("git", ["rev-list", "--reverse", rangeSpec], { encoding: "utf8", cwd }) ?? "")
    .split("\n")
    .filter(Boolean);
  if (commits.length > 100) throw new Error("confidential-pattern scan could not run");
  let changedPathCount = 0;
  let scannedByteCount = 0;

  // ADDED LINES ONLY. A commit that REMOVES a term necessarily contains it on the removed side of
  // its own patch — so a naive scan fails every scrub commit, including the one that introduced
  // this gate. A gate that blocks the fix for the thing it guards gets bypassed, and a bypassed
  // gate is worse than none. Removal is the cure, not the disease; only additions are new exposure.
  for (const commit of commits) {
    const parents = (runRedacted("git", ["show", "-s", "--format=%P", commit], { encoding: "utf8", cwd }) ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const comparisons = parents.length > 0 ? parents : [null];
    const changedEntries = [];
    for (const parent of comparisons) {
      const diffArgs = parent
        ? ["diff-tree", "--no-commit-id", "--name-status", "-M", "-r", "-z", "--diff-filter=AMCRT", parent, commit]
        : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-M", "-r", "-z", "--diff-filter=AMCRT", commit];
      const names = runRedacted("git", diffArgs, { encoding: "utf8", cwd }) ?? "";
      const tokens = names.split("\0").filter(Boolean);
      for (let i = 0; i < tokens.length;) {
        const status = tokens[i++];
        const explicitOldPath = /^[RC]/.test(status) ? tokens[i++] : null;
        if (i >= tokens.length) break;
        const path = tokens[i++];
        changedEntries.push({ parent, oldPath: explicitOldPath ?? (status.startsWith("A") ? null : path), path });
      }
    }
    const destinationPaths = [...new Set(changedEntries.map((entry) => entry.path))];
    changedPathCount += destinationPaths.length;
    if (changedPathCount > 2_000) throw new Error("confidential-pattern scan could not run");
    const currentSubmodules = new Set(submodulePaths(cwd, commit));

    const corpus = [];
    const corpusIndexes = new Map();
    const addCorpus = (value) => {
      const existing = corpusIndexes.get(value);
      if (existing !== undefined) return existing;
      scannedByteCount += Buffer.byteLength(value);
      if (scannedByteCount > 64 * 1024 * 1024) throw new Error("confidential-pattern scan could not run");
      const index = corpus.length;
      corpus.push(value);
      corpusIndexes.set(value, index);
      return index;
    };
    const currentBlobs = new Map();
    const previousBlobs = new Map();
    for (const path of destinationPaths) {
      addCorpus(path.normalize("NFKC"));
      if (!currentSubmodules.has(path)) {
        const value = trackedText(path, cwd, commit).normalize("NFKC").replace(/[\0\r\n]/g, " ");
        currentBlobs.set(path, value);
        addCorpus(value);
      }
    }
    for (const entry of changedEntries) {
      if (entry.oldPath) addCorpus(entry.oldPath.normalize("NFKC"));
      if (!entry.parent || !entry.oldPath) continue;
      try {
        const value = trackedText(entry.oldPath, cwd, entry.parent).normalize("NFKC").replace(/[\0\r\n]/g, " ");
        previousBlobs.set(entry, value);
        addCorpus(value);
      } catch {
        // A missing parent blob is equivalent to no previous match.
      }
    }
    const corpusMatches = matchingTermSets(corpus, normalizedTerms);
    const matchesFor = (value) => corpusMatches[corpusIndexes.get(value)] ?? new Set();

    const matchedBefore = (entry, kind) => {
      if (!entry.parent || !entry.oldPath) return new Set();
      if (kind === "path") return matchesFor(entry.oldPath.normalize("NFKC"));
      const value = previousBlobs.get(entry);
      return value === undefined ? new Set() : matchesFor(value);
    };

    // Inspect each CHANGED blob in the resulting commit, and compare it with the corresponding
    // parent blob. This catches a term formed across unchanged+added lines or in UTF-16 while not
    // re-flagging a term inherited from the base branch that this very range is scrubbing.
    const introducedBlob = destinationPaths.some((path) => {
      if (currentSubmodules.has(path)) return true;
      const currentValue = currentBlobs.get(path);
      const currentMatches = currentValue === undefined ? new Set() : matchesFor(currentValue);
      if (currentMatches.size === 0) return false;
      return changedEntries.filter((entry) => entry.path === path).some((entry) => {
        const before = matchedBefore(entry, "blob");
        return [...currentMatches].some((index) => !before.has(index));
      });
    });
    if (introducedBlob) {
      res.push({ file: `commit ${commit.slice(0, 12)} (changed tracked content)`, line: 0 });
    }
    const patch = runRedacted(
      "git",
      ["show", "--format=", "--no-ext-diff", "--no-color", "--unified=0", "-m", commit],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, cwd }
    ) ?? "";
    const blocks = [];
    let block = [];
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        block.push(line.slice(1));
      } else if (block.length > 0) {
        blocks.push(block);
        block = [];
      }
    }
    if (block.length > 0) blocks.push(block);
    const matching = blocks.find((lines) =>
      matchesAnyEre(lines.join(" ").normalize("NFKC"), normalizedTerms)
    );
    if (matching) {
      res.push({
        file: `commit ${commit.slice(0, 12)} (added content)`,
        line: 0,
        text: revealLines ? matching.join("\n") : undefined,
      });
    }

    // Filenames are public too. A destination is new exposure only when the corresponding parent
    // name did not already match, so renaming a confidential path away remains a passing scrub.
    if (changedEntries.some((entry) => {
      const current = matchesFor(entry.path.normalize("NFKC"));
      const before = matchedBefore(entry, "path");
      return [...current].some((index) => !before.has(index));
    })) {
      res.push({ file: `commit ${commit.slice(0, 12)} (added path, redacted)`, line: 0 });
    }
    // Compressed/opaque binary formats cannot be soundly searched without executing format-specific
    // parsers on untrusted PR input. Fail closed on any newly added/modified binary instead of
    // pretending a raw-byte grep proves it clean. Existing unchanged binaries are not grandfathered
    // into every range finding; only a commit that publishes new binary bytes is blocked.
    if (destinationPaths.some((path) => {
      try {
        return isOpaqueBinary(trackedBuffer(path, cwd, commit), path);
      } catch {
        return true;
      }
    })) {
      res.push({ file: `commit ${commit.slice(0, 12)} (opaque binary content)`, line: 0 });
    }

    // Commit messages may span lines and never appear in a tree. Read them without a term-bearing
    // command line, then apply the same ERE/Unicode/whitespace semantics as added content.
    const message = runRedacted("git", ["show", "-s", "--format=%B", commit], { encoding: "utf8", cwd }) ?? "";
    if (matchesAnyEre(message.normalize("NFKC").replace(/\r?\n/g, " "), normalizedTerms)) {
      res.push({ file: `commit ${commit.slice(0, 12)} (message)`, line: 0, text: revealLines ? message : undefined });
    }
  }

  return res;
}

function main() {
  if ((termsFileIdx >= 0 && !termsFile) || (rangeIdx >= 0 && !range) || (treeIdx >= 0 && !tree)) {
    console.error("NDA-GATE: BLOCKED — an option is missing its value.");
    process.exit(2);
  }
  const raw = termsFile ? readFileSync(termsFile, "utf8") : (process.env.NDA_TERMS ?? "");
  if (reveal && process.env.CI) {
    console.error("NDA-GATE: BLOCKED — reveal mode is disabled in CI.");
    process.exit(2);
  }
  if (!raw.trim()) {
    console.error("NDA-GATE: BLOCKED — no term list supplied (NDA_TERMS secret or --terms-file).");
    console.error("          The gate fails closed: an unconfigured gate is not a passing grade.");
    process.exit(2); // distinct from 1 so a workflow can tell misconfiguration from a real leak
  }
  const terms = parseTerms(raw);
  let findings;
  try {
    findings = scan(terms, { revealLines: reveal, treeish: tree });
    // The tree is what ships; the range is what becomes permanent history. Both, when given one.
    if (range) findings = findings.concat(scanRange(terms, range, { revealLines: reveal }));
  } catch (e) {
    console.error(`NDA-GATE: BLOCKED — ${e.message}`);
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log("NDA-GATE: clean (private patterns checked across the tracked tree)");
    return;
  }
  console.error("============================================================");
  console.error("NDA-GATE: BLOCKED — confidential identifier(s) detected.");
  // Even redacted locations are a term-list oracle in public CI: an attacker can place a
  // different candidate in each neutral-named file and learn every matching candidate from the
  // reported paths. CI therefore exposes only the unavoidable one-bit blocked verdict. Locations
  // remain useful in a trusted local terminal, where the private list is already available.
  if (!process.env.CI) {
    console.error(reveal ? "" : "Locations only — protected text is withheld.");
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}${f.text ? `  ${f.text}` : ""}`);
    }
  }
  console.error("------------------------------------------------------------");
  if (!process.env.CI) {
    console.error("Run locally to see what matched:");
    console.error("  node scripts/nda-scan.mjs --terms-file ~/.config/aios-nda/terms.txt --reveal");
  }
  console.error("============================================================");
  process.exit(1);
}

function isCliEntryPoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) main();
