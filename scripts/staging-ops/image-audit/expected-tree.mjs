/**
 * AIO-997 audit — WHAT `/app` SHOULD CONTAIN, derived from the pinned source revision.
 *
 * THE DIRECTION MATTERS, and M1 of the adjudication is exactly about it:
 *
 *   `.dockerignore` filters the EXPECTED set (what the Git tree should have contributed).
 *   It NEVER filters the ACTUAL set (what the image really contains).
 *
 * So an image member sitting at an excluded source path — `.git/config`, a `.env`, a `.context/`
 * agent worktree — is a FINDING, not a file the scan skips. Inverting that is how a build that
 * accidentally shipped `.git` would audit clean: the audit would decline to look at precisely the
 * thing that went wrong.
 *
 * Generated/dependency categories (`node_modules`, an empty `.next`) are PROVENANCE ACCOUNTING. They
 * explain why a path is present without a Git blob behind it. They confer no scan exemption — every
 * one of those files is still inventoried and still scanned.
 *
 * MATCHER HONESTY. `dockerignoreMatcher` implements Docker's documented pattern rules (`**`, `*`,
 * `?`, leading `/`, `!` negation with last-match-wins). Where it is imprecise it fails toward a
 * FINDING in both directions — a too-broad pattern makes real files "unexpected", a too-narrow one
 * makes excluded files "expected but absent". Neither direction produces a silent clearance, which
 * is the property that matters for an audit.
 */

/** Path categories that account for a member without a Git blob. Accounting only — never a skip. */
export const PROVENANCE_CATEGORIES = Object.freeze([
  { category: "npm-dependency", test: (path) => path === "node_modules" || path.startsWith("node_modules/") },
  { category: "next-build-dir", test: (path) => path === ".next" || path.startsWith(".next/") },
]);

const SEGMENT = (pattern) => pattern.replace(/^\/+/, "").replace(/\/+$/, "").split("/");

/** One dockerignore pattern → a predicate over a context-relative path. */
function patternMatcher(pattern) {
  const segments = SEGMENT(pattern);
  const regex = new RegExp(`^${segments.map(segmentRegex).join("/")}$`);
  return (path) => {
    if (regex.test(path)) return true;
    // A matched DIRECTORY excludes everything beneath it — `node_modules` is one pattern, not one
    // pattern per file underneath.
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) {
      if (regex.test(parts.slice(0, end).join("/"))) return true;
    }
    return false;
  };
}

function segmentRegex(segment) {
  if (segment === "**") return "[^/]*(?:/[^/]*)*";
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Docker's LAST-MATCH-WINS negation. `.env.*` then `!.env.example` means the example file is sent —
 * evaluating in any other order (or stopping at the first match) silently changes which files the
 * expected set contains, and every difference then reads as a finding about the image.
 */
export function dockerignoreMatcher(text) {
  const rules = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.startsWith("!")
      ? { negated: true, match: patternMatcher(line.slice(1)) }
      : { negated: false, match: patternMatcher(line) }));
  return (path) => {
    let excluded = false;
    for (const rule of rules) if (rule.match(path)) excluded = !rule.negated;
    return excluded;
  };
}

/**
 * The expected `/app` inventory: every tracked path of the pinned revision that `.dockerignore` did
 * NOT exclude, keyed by its in-image path.
 *
 * `entries` come from `git ls-tree -r` on the ORIGINAL source checkout (a separate directory, no
 * persisted credentials) — never from the audit's own checkout, which is different code at a
 * different commit and would make this comparison meaningless.
 */
export function expectedInventory(entries, dockerignoreText, { prefix = "app/" } = {}) {
  const excluded = dockerignoreMatcher(dockerignoreText);
  const expected = new Map();
  const excludedPaths = new Set();
  for (const entry of entries) {
    if (excluded(entry.path)) { excludedPaths.add(`${prefix}${entry.path}`); continue; }
    expected.set(`${prefix}${entry.path}`, entry);
  }
  return { expected, excludedPaths };
}

/** Which provenance category, if any, accounts for an in-image path with no Git blob behind it. */
export function provenanceCategory(imagePath, { prefix = "app/" } = {}) {
  if (!imagePath.startsWith(prefix)) return "outside-app";
  const relative = imagePath.slice(prefix.length);
  for (const { category, test } of PROVENANCE_CATEGORIES) if (test(relative)) return category;
  return undefined;
}

/**
 * Compare the ACTUAL `/app` members against the expected set.
 *
 * Every outcome is one of five, and four of them are findings:
 *
 *   `matched`            — expected path, byte-identical to the Git blob.
 *   `content-mismatch`   — expected path, DIFFERENT bytes. Something rewrote a source file.
 *   `excluded-path`      — a path `.dockerignore` excluded is in the image anyway (M1).
 *   `unexpected`         — present, not expected, and no provenance category accounts for it.
 *   `<category>`         — accounted for as a dependency/generated path, and still scanned.
 *
 * `missing` is reported separately: an expected file absent from the image says the expected set or
 * the build is wrong, and either way the comparison cannot be called complete.
 */
export function compareInventory(actual, { expected, excludedPaths }, { prefix = "app/" } = {}) {
  const outcomes = [];
  const seen = new Set();
  for (const member of actual) {
    const blob = expected.get(member.path);
    seen.add(member.path);
    if (blob) {
      outcomes.push({
        path: member.path,
        outcome: member.type === "symlink"
          // Symlinks are compared AS LINKS — target string against target string. Following one
          // would read whatever it points at on the audit host, which is the opposite of an audit.
          ? (blob.type === "symlink" && blob.linkTarget === member.linkTarget ? "matched" : "content-mismatch")
          : (blob.sha256 === member.sha256 ? "matched" : "content-mismatch"),
        kind: member.type,
      });
      continue;
    }
    if (excludedPaths.has(member.path)) {
      outcomes.push({ path: member.path, outcome: "excluded-path", kind: member.type });
      continue;
    }
    const category = provenanceCategory(member.path, { prefix });
    outcomes.push({ path: member.path, outcome: category ?? "unexpected", kind: member.type });
  }
  const missing = [...expected.keys()].filter((path) => !seen.has(path));
  return { outcomes, missing };
}

/** The counts the evidence record carries. Findings are the outcomes that are not `matched`/category. */
export function inventorySummary({ outcomes, missing }) {
  const counts = {};
  for (const { outcome } of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  const findingOutcomes = ["content-mismatch", "excluded-path", "unexpected"];
  return {
    counts: { ...counts, missing: missing.length },
    findings: findingOutcomes.reduce((total, outcome) => total + (counts[outcome] ?? 0), 0) + missing.length,
    complete: missing.length === 0,
  };
}
