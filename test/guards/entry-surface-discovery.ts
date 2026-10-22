/**
 * AUDITFIX-18 — the DISCOVERY seam: a repository tree → the sources the entry-surface analysis reads.
 *
 * TEST-ONLY. Nothing here ships. It is imported by `test/guards/context-hook-callsites.test.ts`,
 * which owns the criteria, and by the `entry-surface-report.ts` diagnostic.
 *
 * ## Why this is its own module, with the ROOT injected
 *
 * The walk used to live inside the test file, which made the real-tree criteria its ONLY caller: a
 * fixture could exercise the ANALYSER but never the WALK. That matters because the walk is exactly
 * where the production file set loses its excluded sources — a synthetic file list modelling "the
 * excluded file is simply absent" therefore proves the analyser's behaviour on an input the real
 * path never produces (Astra medium 1). With the root injected, a throwaway tree on disk runs the
 * whole path — walk → exclusions → read → analyse — that `AC18-07` runs against this repository.
 *
 * The walk itself is UNCHANGED by the extraction: same roots, same exclusions, same extension list,
 * same symlink handling, same sort order, same tolerance of unreadable entries.
 *
 * ## The second thing a root buys: RESOLUTION EVIDENCE
 *
 * Dropping a file is not the same as the file not existing, and the analysis could not tell those
 * apart — so a reference into an excluded source read as a terminal asset, or as nothing at all.
 * `createSourceFileProbe` answers the one narrow question that separates them ("is there a SOURCE
 * file at this repo-relative path?") for the tree that was walked. It grants nothing: eligibility to
 * be a graph node still belongs to the walk, so evidence explains a REFUSAL and never admits a node.
 *
 * `createManifestProbe` is the same idea for the one piece of METADATA a local reference can turn
 * on: a `package.json` directly under the reference base. The source host cannot answer for it (a
 * manifest is not a source spelling, and admitting it there would report metadata as an excluded
 * source), and the resolver reads only supplied contents, so without this a directory manifest
 * redirecting into an ingestion wrapper was invisible — the analysis took a sibling `index` and
 * reported nothing. Existence is the whole answer: the refusal it feeds reads no contents, follows
 * no redirect, and consults no ancestor.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  analyseEntrySurfaces,
  CANONICAL_WRITER_MODULE,
  isSourceSpelling,
  MANIFEST_NAME,
  type EntryAnalysisOptions,
  type EntryRecord,
  type EntrySurfaceAnalysis,
  type SourceFile,
} from "./entry-surface-graph";

/**
 * Directories walked, and every top-level directory NOT walked WITH ITS REASON.
 *
 * ⚠️ FABLE DIFF REVIEW, HIGH 2. The list was once `["lib", "app", "scripts"]`, which silently
 * omitted `components/` — 109 shipped files, several already importing `lib/ingest/*` — plus every
 * ROOT-LEVEL source (`instrumentation.ts`, `proxy.ts`) and every non-`.ts` extension. A guard whose
 * coverage shrinks silently as the repo grows is the failure it exists to prevent, so the two lists
 * below must together account for the ENTIRE top level (asserted by `AC9`) — a new shipped
 * directory fails the build until someone decides which list it belongs in.
 */
export const WALKED_ROOTS = ["app", "components", "lib", "scripts"] as const;

export const NOT_WALKED_ROOTS: Record<string, string> = {
  // Added by the staging paired-refresh work: runner env examples and the schedule/storage
  // contract are declarative data, so none of these files can write an item.
  config: "runner configuration examples + the schedules/storage contract (no executable source)",
  docker: "container bootstrap (.mjs/.sh); calls the drain rather than the writer",
  docs: "prose",
  fixtures: "test data",
  graphiti: "the Python graph sidecar — HTTP-only to the brain",
  ingestion: "the Python connector sidecar — HTTP-only to the brain",
  postgres: "SQL schema + migrations",
  public: "static assets",
  test: "tests are not writers",
  validation: "evaluation fixtures/reports",
};

// ⚠️ `.jsx` was ADDED by AUDITFIX-18. It was missing here, so a `.jsx` component importing a
// wrapper was invisible to discovery AND to parsing — a hole in BOTH guards, not just the new one.
// `AC18-05a` asserts this list and the graph's are one list, so they cannot drift apart again.
export const WALK_SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The files the walk yields but the analysis does not treat as callers. The canonical writer is
 *  excluded here and added back by the graph as its SEED. */
export const isSkippedSource = (rel: string): boolean =>
  /\.test\.tsx?$/.test(rel) ||
  rel.endsWith(".d.ts") ||
  rel === CANONICAL_WRITER_MODULE ||
  // Not a writer: an in-memory PostgREST double used only by tests.
  rel === "lib/ingest/fake-supabase.ts";

/** Every source path the guard analyses under `root`, repo-relative and sorted. */
export function discoverSourcePaths(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (relDir: string) => {
    for (const name of readdirSync(join(root, relDir))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = `${relDir}/${name}`;
      // A broken symlink or an unreadable entry must not crash the guard (Codex LOW 1).
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Symlinked directories would loop or double-count; visit each real path once.
        const real = relative(root, realpathSync(join(root, rel)));
        if (seen.has(real)) continue;
        seen.add(real);
        walk(rel);
      } else if (WALK_SOURCE_EXT.some((e) => rel.endsWith(e)) && !isSkippedSource(rel)) out.push(rel);
    }
  };
  for (const r of WALKED_ROOTS) walk(r);
  // Root-level sources ship too (`instrumentation.ts`, `proxy.ts`) and the old walk never saw them.
  for (const name of readdirSync(root)) {
    if (!WALK_SOURCE_EXT.some((e) => name.endsWith(e)) || isSkippedSource(name)) continue;
    try {
      if (statSync(join(root, name)).isFile()) out.push(name);
    } catch {
      /* unreadable root entry */
    }
  }
  return out.sort();
}

/** The discovered paths, read. This is the exact input the real-tree criteria analyse. */
export function readDiscoveredSources(root: string): SourceFile[] {
  return discoverSourcePaths(root).map((rel) => ({ rel, code: readFileSync(join(root, rel), "utf8") }));
}

/**
 * The two refusals BOTH evidence hosts owe, whatever they answer about:
 *
 * - **Not inside the root.** Empty, absolute or `..`-climbing paths are refused rather than
 *   normalised: these hosts exist to describe THIS repository, and a resolver bug must not become a
 *   read of somewhere else on the machine.
 * - **`node_modules`.** Dependencies are terminal by design and this slice does not crawl them; a
 *   dependency file must read as unresolved, not as a repository source somebody excluded.
 */
const isInsideRoot = (rel: string): boolean => {
  if (rel === "" || rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg !== "node_modules");
};

/**
 * The SOURCE host's third refusal, and the one that keeps the whole mechanism honest: **not a source
 * spelling** (`isSourceSpelling`, owned by the graph so there is one list). `candidates(base)` offers
 * the bare base too, so a host that answered "yes, `docs/bridge.css` is there" would classify a
 * genuine STYLESHEET as an excluded source and make an ordinary CSS import unwritable.
 */
const isProbeablePath = (rel: string): boolean => isInsideRoot(rel) && isSourceSpelling(rel);

/**
 * The MANIFEST host's own admissible-path rule, and the counterpart to the first refusal above:
 * this one answers for exactly `package.json`, which `isProbeablePath` must never admit. The two
 * hosts are deliberately disjoint — a `package.json` is metadata, and letting the SOURCE host see
 * one would report it as an excluded source; letting the manifest host see anything else would
 * turn a narrow existence question into a second file system view. Same root, same `node_modules`
 * refusal, same escape refusal.
 */
const isProbeableManifest = (rel: string): boolean =>
  isInsideRoot(rel) && (rel === MANIFEST_NAME || rel.endsWith(`/${MANIFEST_NAME}`));

/** Memoised "is there a FILE at `root/rel`, and may I answer about it at all?" — the shared body of
 *  the two evidence hosts below. The answers cannot change inside one analysis, and both hosts are
 *  asked about the same paths repeatedly (TypeScript's own probing, then the written-out candidate
 *  enumeration), so caching them is free. An unreadable entry is no evidence, not a crash. */
const createFileProbe = (root: string, admissible: (rel: string) => boolean): ((rel: string) => boolean) => {
  const answers = new Map<string, boolean>();
  return (rel: string): boolean => {
    const hit = answers.get(rel);
    if (hit !== undefined) return hit;
    let exists = false;
    if (admissible(rel)) {
      try {
        exists = statSync(join(root, rel)).isFile();
      } catch {
        exists = false; // absent, or an unreadable entry — either way, no evidence
      }
    }
    answers.set(rel, exists);
    return exists;
  };
};

/**
 * A NARROWLY SCOPED file-existence host over `root`: "is there a source file at this repo-relative
 * path?" — nothing else. No directory listing, no traversal, no reads (Astra medium 1).
 *
 * It exists because the walk is where excluded sources DISAPPEAR: `docs/bridge.css.ts` is not merely
 * excluded by the time the analysis runs, it is invisible, so a specifier naming it falls through to
 * the terminal-asset branch and the reference — with every surface behind it — is lost in silence.
 * This supplies the missing half of that sentence, and only that half: `analyseEntrySurfaces` never
 * admits what this finds as a graph NODE (see `EntryAnalysisOptions.sourceFileExists`).
 *
 * Memoised per path. It is asked about EVERY local reference, not only the ones the supplied files
 * failed to satisfy — resolution has one existence view and this is half of it — so the real tree
 * puts thousands of questions through here, many of them repeats from TypeScript's own probing. The
 * answers cannot change inside one analysis, so caching them is free.
 */
export function createSourceFileProbe(root: string): (rel: string) => boolean {
  return createFileProbe(root, isProbeablePath);
}

/**
 * The MANIFEST evidence host over `root`: "is there a `package.json` at this repo-relative path?"
 * — nothing else, and nothing read (Astra final adjudication, P1).
 *
 * It exists because a local directory manifest is invisible to everything else in this seam: the
 * walk yields SOURCES, the resolver reads only supplied contents, and the source probe refuses
 * non-source spellings on purpose. So a directory whose real `package.json` redirects into an
 * ingestion wrapper resolved to whatever `index` sat beside it, and the edge disappeared silently
 * — reproduced against installed TypeScript, which named the wrapper while the guard reported no
 * violation. This supplies the one fact needed to REFUSE that spelling rather than guess at it.
 *
 * What it is not: a manifest reader. Contents, `main`/`exports`/`types` redirects, ancestor
 * manifests and dependency crawling are all outside this slice, and no caller can reach them
 * through this — existence is the entire answer available.
 */
export function createManifestProbe(root: string): (rel: string) => boolean {
  return createFileProbe(root, isProbeableManifest);
}

/**
 * THE SEAM the real-tree criteria and the on-disk fixtures share: discover under `root`, then
 * analyse. Both halves in ONE function on purpose — a fixture that re-implemented either half would
 * be proving that the copy agrees with itself, which is the whole reason this module exists.
 *
 * The resolution-evidence host is built HERE, from the same `root` that was walked, and overrides
 * anything a caller passed: "which tree is this analysis about" is the seam's decision, and a
 * mismatched pair — a walk of one tree explained by the file listing of another — is not a
 * configuration anybody should be able to construct.
 */
export function analyseTreeAt(
  root: string,
  inventory: Readonly<Record<string, EntryRecord>>,
  options: EntryAnalysisOptions = {}
): EntrySurfaceAnalysis {
  return analyseTreeWithSources(root, inventory, options).analysis;
}

/** `analyseTreeAt`, plus the sources it discovered — for the diagnostic, which reports the size of
 *  the walk it ran and must not walk a second time to learn it. */
export function analyseTreeWithSources(
  root: string,
  inventory: Readonly<Record<string, EntryRecord>>,
  options: EntryAnalysisOptions = {}
): { files: SourceFile[]; analysis: EntrySurfaceAnalysis } {
  const files = readDiscoveredSources(root);
  const analysis = analyseEntrySurfaces(files, inventory, {
    ...options,
    sourceFileExists: createSourceFileProbe(root),
    manifestExists: createManifestProbe(root),
  });
  return { files, analysis };
}
