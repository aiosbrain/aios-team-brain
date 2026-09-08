/**
 * AUDITFIX-18 — the reverse-import ENTRY-SURFACE analysis seam.
 *
 * TEST-ONLY. Nothing here ships; it is imported by `test/guards/context-hook-callsites.test.ts`,
 * which owns the criteria. It lives in its own module for one reason: the guard IS the behaviour
 * under test, so the fixtures and the real-tree pass must call the SAME function, and a second
 * copy of the algorithm inside the test file would prove only that the copy agrees with itself.
 *
 * ## What this analysis is, and what it is NOT
 *
 * It follows MODULE IMPORTS in reverse, from the canonical writer outward to every file that can
 * reach it, to a fixpoint. It does not decide which exported function actually runs, so a reached
 * file is a REVIEW OBLIGATION, not a proof that an ingest happens there. The three entry classes
 * are review declarations. The old direct-writer classes keep their own structural checks; nothing
 * here relaxes them, and nothing here is seeded from either inventory (see `analyseEntrySurfaces`).
 */

import ts from "typescript";

/** A file as analysed: repo-relative path + source text. Fixtures and the real walk share it. */
export interface SourceFile {
  rel: string;
  code: string;
}

/** The one module that defines the writer — the graph's SEED, added explicitly (the direct-call
 *  walk excludes it, so it would otherwise never be a node). */
export const CANONICAL_WRITER_MODULE = "lib/ingest/index.ts";

/**
 * Extensions the graph reads. `.jsx` is NEW in this slice: the existing walk omitted it, which
 * meant a `.jsx` component importing a wrapper was invisible to discovery AND to parsing. The test
 * file asserts its own walk list equals this one, so there is a single owner rather than two lists
 * that drift.
 */
export const GRAPH_SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * The alias configuration this graph is pinned to. Asserted against the real `tsconfig.json`, so a
 * NEW repo alias cannot silently look like an external package specifier and drop its edges.
 */
export const PINNED_TS_PATHS: Readonly<Record<string, readonly string[]>> = { "@/*": ["./*"] };

/**
 * Suffixes recognised as NON-CODE assets. Reaching this list is the LAST step of resolution, never
 * the first: a specifier spelled `./x.css` can perfectly well resolve to the source `./x.css.ts`,
 * and an extension-first shortcut would drop that edge together with every surface behind it
 * (Astra adjudication 2). Only when NO source resolves at all — neither one the walk supplied nor
 * one the repository merely evidences — does an asset suffix make the reference a terminal
 * dependency instead of a failure.
 */
const ASSET_EXT = [
  ".css", ".scss", ".sass", ".less", ".styl",
  ".json", ".json5", ".yaml", ".yml", ".toml", ".xml", ".csv", ".txt", ".md", ".mdx", ".sql", ".html",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".webm", ".ogg",
  ".wasm", ".node", ".graphql", ".gql",
] as const;

/**
 * Is `rel` spelled like a SOURCE the graph could read?
 *
 * The one owner of that question, because two callers ask it about very different things: the
 * candidate enumeration below, and the repository file-existence host (`entry-surface-discovery`)
 * that supplies resolution evidence for sources the walk dropped. Declaration files need no clause
 * of their own — `.d.ts` ends with `.ts` — and the point of the predicate is what it EXCLUDES: a
 * `.css`, `.json` or `.png` name is not a source spelling, so nothing may ask the disk about one.
 * That is what keeps a genuine stylesheet a terminal asset instead of an "excluded source".
 */
export function isSourceSpelling(rel: string): boolean {
  return GRAPH_SOURCE_EXT.some((e) => rel.endsWith(e));
}

/**
 * Is `rel` a file the graph may treat as a NODE?
 *
 * Mirrors the direct-call walk's SUFFIX and FILE exclusions — type declarations, tests, and the
 * in-memory PostgREST double — and excludes the canonical writer, which the walk also excludes and
 * which the graph adds back as its seed. A runtime reference resolving to something this rejects is
 * an EXCLUDED REFERENCE: it FAILS the guard (`excluded-ref`) rather than being listed and forgotten,
 * because an unasserted list at the build boundary is exactly a silent graph hole (Astra
 * adjudication 4).
 *
 * ⚠️ This is NOT the whole eligibility policy, and must never be used as if it were (Astra medium 1).
 * The walk also drops whole ROOTS (`docs/`, `test/`, …) and every hidden/generated directory, and a
 * file dropped for one of those reasons can perfectly well satisfy every clause below. Eligibility is
 * therefore "the walk SUPPLIED it **and** this returns true"; a source found by any other means — the
 * resolution-evidence host in `resolve` — is excluded BY CONSTRUCTION, whatever its suffix.
 */
export function isGraphSourceFile(rel: string): boolean {
  if (!isSourceSpelling(rel)) return false;
  if (/\.d\.(ts|mts|cts)$/.test(rel)) return false;
  if (/\.test\.[a-z]+$/.test(rel)) return false;
  if (rel === CANONICAL_WRITER_MODULE) return false;
  // Not a writer: an in-memory PostgREST double used only by tests.
  if (rel === "lib/ingest/fake-supabase.ts") return false;
  return true;
}

/**
 * The three ENTRY classes. Review declarations, not machine-certified execution facts:
 *
 * - `RECONCILES`       — after-response, inline, or AUDITFIX-14's bounded manual pass. The reason
 *                        must say WHICH, and whether pending/failure is possible.
 * - `SWEEP_DEPENDENT`  — a real ingestion entry that relies on a later sweep. The reason must state
 *                        that dependency and the disabled-poller limitation where it applies.
 * - `IMPORT_ONLY`      — a conservative dependency inclusion with no identified ingest operation at
 *                        this surface (a reader export, a UI consumer). The reason must name the
 *                        actual import responsible.
 */
export const ENTRY_CLASSES = ["RECONCILES", "SWEEP_DEPENDENT", "IMPORT_ONLY"] as const;
export type EntryClass = (typeof ENTRY_CLASSES)[number];

export interface EntryRecord {
  class: EntryClass;
  /** Concrete: the chain/operation and the coverage limitation. Non-empty, never auto-generated. */
  reason: string;
}

/**
 * The kinds a criterion can name. Kinds exist so a control asserts the rule that MUST fire rather
 * than "something failed" — the AUDITFIX-2 lesson (Fable L2) applied to the new rules.
 */
export type EntryViolationKind =
  | "unclassified-entry"
  | "blank-reason"
  | "unknown-class"
  | "stale-entry"
  | "refused-load"
  | "stale-exception"
  | "unsupported-alias"
  | "unsupported-directory-manifest"
  | "unsupported-file-url"
  | "unresolved"
  | "excluded-ref"
  | "parse";

export interface EntryViolation {
  kind: EntryViolationKind;
  message: string;
}

/** A local reference that resolved INTO an excluded source. Reported AND failed — the list is a
 *  convenience for the reader, never the enforcement (see `isGraphSourceFile`). */
export interface ExcludedRef {
  from: string;
  specifier: string;
  /** `file:line` of the reference. */
  at: string;
  target: string;
}

/**
 * One narrowly reviewed computed-load exception. EXACT-MATCH on every field: change the binding,
 * the value, the enclosing function, the occurrence count or the file and the exception no longer
 * applies (the load is refused). No file-wide or identifier-only exemptions exist, so a new
 * computed loader elsewhere in the same file cannot borrow this one — and neither can a nearer
 * binding that merely reuses the spelling, because the match is on the DECLARATION the argument
 * resolves to, not on its text.
 *
 * ⚠️ **It covers a dynamic `import(...)` and nothing else** (`EXCEPTION_LOADER`, Astra medium 3).
 * There is deliberately no field to widen that: `require(E2B_MODULE)` presents the matcher with the
 * same binding, the same function and the same count as the reviewed import, so without the loader
 * kind a synchronous CommonJS load — different semantics, and not the thing anybody reviewed —
 * borrows an exception written for the asynchronous one. Granting `require` would need a new,
 * separately reasoned entry shape, which is precisely the decision this refuses to make implicitly.
 */
export interface ComputedLoadException {
  /** Exact repo-relative path. */
  file: string;
  /** The function whose body holds the load. */
  functionName: string;
  /** The identifier passed to `import(...)` — the argument must be EXACTLY that identifier, and it
   *  must RESOLVE to the top-level const below. A parameter, local, block, catch or destructured
   *  binding of the same spelling is a different declaration, so it is refused, not excused. */
  binding: string;
  /** The top-level `const`'s string literal value. */
  value: string;
  /** How many loads of `binding` this file may contain. */
  occurrences: number;
  /** Why the external package justifies a non-literal load. Non-empty. */
  reason: string;
}

/**
 * The exceptions in force against the real tree. One, today.
 *
 * `@e2b/code-interpreter` is an OPTIONAL, undeclared dependency: the specifier is held in a
 * string-typed const so `tsc` treats the import as `any` and the package need not be installed to
 * typecheck. That is an external-package reason, and it is the only one. If the load is deleted the
 * exception goes STALE and fails — an exception nobody needs is a hole nobody is watching.
 */
export const COMPUTED_LOAD_EXCEPTIONS: readonly ComputedLoadException[] = [
  {
    file: "lib/actions/sandbox/e2b.ts",
    functionName: "defaultLoader",
    binding: "E2B_MODULE",
    value: "@e2b/code-interpreter",
    occurrences: 1,
    reason:
      "the E2B SDK is an OPTIONAL, undeclared dependency; the string-typed const keeps tsc from " +
      "requiring it to be installed. External package — it can never resolve to a repo module",
  },
];

export interface EntryAnalysisOptions {
  /**
   * The exceptions in force for THIS analysis. Defaults to NONE — fail-closed. The real-tree caller
   * passes `COMPUTED_LOAD_EXCEPTIONS` explicitly; a default that silently granted them is how an
   * exception stops being a decision anybody made, and it would also make every synthetic fixture
   * fail the stale-exception check for a file it never contained.
   */
  exceptions?: readonly ComputedLoadException[];
  /**
   * RESOLUTION EVIDENCE ONLY: "is there a source file at this repo-relative path?" (Astra medium 1).
   *
   * Defaults to UNDEFINED, and that default is a control rather than an omission: with no host the
   * analysis touches no filesystem at all, so a virtual fixture naming a path that genuinely exists
   * on this disk still comes back unresolved and the synthetic criteria keep meaning what they say.
   * `analyseTreeAt` — the discovery seam — is the only caller that supplies one, built from the SAME
   * root it walked.
   *
   * What it buys: the walk DROPS excluded roots (`docs/`, `test/`, …), hidden/generated directories
   * and excluded files, so by the time the analysis runs, a source behind one of those boundaries is
   * not merely excluded — it is invisible, and an asset-looking specifier naming it falls through to
   * the terminal-asset branch, taking every surface behind it in silence. This answers the narrow
   * question that turns that silence into an `excluded-ref`.
   *
   * WHEN it is consulted: throughout resolution, on equal footing with the supplied files, because
   * "which file does this specifier name?" is a question about the repository and not about what the
   * walk kept. It is deliberately NOT a last-resort tier consulted only once every supplied file has
   * failed — that ordering is what let a lower-priority supplied file mask the excluded one that
   * actually wins, and it is the defect this replaced (Astra code round 2, `createResolver`).
   *
   * What it must NOT do, and what the host in `entry-surface-discovery` therefore enforces: answer
   * for non-source spellings (a real stylesheet would become an "excluded source"), leave the
   * repository, or walk into `node_modules` — dependency crawling is out of scope by design.
   * A file it finds is NEVER admitted as a node, whichever path resolved it: eligibility belongs to
   * the walk (see `isGraphSourceFile`), and this only explains WHY a reference could not be followed.
   */
  sourceFileExists?: (rel: string) => boolean;
  /**
   * MANIFEST EVIDENCE ONLY: "is there a `package.json` at this exact repo-relative path?" (Astra
   * final adjudication, P1). Narrower than `sourceFileExists` in both directions — it answers for
   * ONE filename, and it answers for a file the source probe must never see, because a
   * `package.json` is not a source spelling and admitting one there would classify metadata as an
   * excluded SOURCE.
   *
   * Why it exists at all: the graph reads SOURCES, and `readFile` serves supplied contents only, so
   * a local directory manifest on disk is invisible to TypeScript inside this resolver. A directory
   * whose real `package.json` redirects (`main`/`exports`) into an ingestion wrapper therefore
   * resolved to whatever `index` happened to be there, and the edge — with every surface behind it
   * — vanished with no diagnostic. The coordinator reproduced exactly that: installed TypeScript
   * named `lib/wrap.ts` for `@/lib/bridge` while this analysis reported no violation at all.
   *
   * The fix is a REFUSAL, not a second resolver (`resolve`): this slice does not interpret manifest
   * contents, redirects, ancestors or dependencies, so the only thing it needs to know is whether
   * the reference base carries one. Defaults to UNDEFINED like the source probe, so a virtual
   * fixture may SUPPLY the metadata as an ordinary file and still reaches no disk.
   */
  manifestExists?: (rel: string) => boolean;
}

export interface EntrySurfaceAnalysis {
  violations: EntryViolation[];
  /** Sorted. Every reached file meeting the SURFACE predicate — the exact key set of the inventory. */
  surfaces: string[];
  /** Sorted. Every reached module INCLUDING the seed. */
  closure: string[];
  /** One deterministic chain per reached file: `[file, …importee…, CANONICAL_WRITER_MODULE]`.
   *  Shortest chain wins; ties break on the lexicographically smallest next hop, so the diagnostic
   *  is stable across runs and across the order files arrive in. */
  witness: Record<string, string[]>;
  /** References into excluded sources — surfaced for the reader; each one also FAILS the guard. */
  excludedRefs: ExcludedRef[];
}

/* ────────────────────────────── parsing ────────────────────────────── */

const scriptKindFor = (rel: string): ts.ScriptKind =>
  rel.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : rel.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(rel)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

/** A collision-free cache key over two strings. Length-prefixed rather than separator-joined so no
 *  control character has to appear in this source file to keep the two halves apart. */
const cacheKey = (a: string, b: string): string => `${a.length}:${a}${b}`;

/**
 * Parsing is MEMOISED on (path, content). The real tree is ~1,000 files and the criteria call the
 * analysis many times with small fixtures; without this the whole tree would be re-parsed per call,
 * which is precisely what pushed the AUDITFIX-2 criteria past vitest's default timeout under
 * coverage instrumentation in CI. Keyed on the CONTENT, so a fixture that reuses a path with
 * different code still parses fresh.
 */
const graphParseCache = new Map<string, ts.SourceFile>();
function parseGraphSource(rel: string, code: string): ts.SourceFile {
  const key = cacheKey(rel, code);
  let sf = graphParseCache.get(key);
  if (!sf) {
    sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
    graphParseCache.set(key, sf);
  }
  return sf;
}

/** Syntactic parse diagnostics. `parseDiagnostics` is internal to the compiler API, so the cast is
 *  deliberate: a parse error that is swallowed is a file whose edges silently do not exist. */
function parseErrorsOf(src: ts.SourceFile): readonly ts.Diagnostic[] {
  return (src as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/* ─────────────── path helpers — pure string work, never the filesystem ─────────────── */

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/**
 * Is this specifier an ABSOLUTE path spelling? (Astra medium 2.)
 *
 * The three forms a supported platform writes, recognised on EVERY platform rather than through
 * `path.isAbsolute`: that helper answers for the host it runs on, so `C:\tmp\x.mjs` is "not
 * absolute" on this POSIX runner and would be waved through as a package name — a guard that
 * silently loses edges depending on where CI happens to run is worse than one that has an opinion.
 *
 *   `/tmp/x.mjs`            POSIX absolute
 *   `\tmp\x.mjs`, `\\srv\s` Windows root-relative and UNC
 *   `C:\tmp\x.mjs`, `C:/…`  Windows drive-qualified
 *
 * A package specifier can look path-SHAPED (`zod/lib/helpers.js`, `@sentry/nextjs/esm/client.js`)
 * and a builtin carries a scheme-ish colon (`node:path`), so none of these tests may key on "has a
 * slash" or "has a colon": the drive form needs a SINGLE letter before the colon and a separator
 * after it, which `node:path` fails on both counts.
 */
const isAbsoluteSpecifier = (spec: string): boolean =>
  spec.startsWith("/") || spec.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(spec);

/**
 * Canonicalise a LOCAL specifier's PATH SEPARATORS — one spelling for the whole of resolution.
 *
 * `joinRel` below splits on `/` alone, while TypeScript's own host normalisation accepts `\` as a
 * separator too. So `../lib\bridge` and `../lib/bridge` named the SAME file to the compiler while
 * this analysis carried `lib\bridge` around as one opaque segment: the manifest probe, the
 * outside-root check and the candidate enumeration all asked about a filesystem name that no POSIX
 * tree has, and the refusal that should have fired never did. Reproduced through the real seam — the
 * backslash spelling resolved to `lib/wrap.ts` through a directory manifest while the guard reported
 * ZERO violations (Astra final round 2, P1). A boundary anybody can leave by changing SPELLING is
 * not a boundary.
 *
 * Applied ONCE, at the top of `resolve`, so every consumer downstream shares one local identity and
 * mixed separators cannot open a second namespace — `.` and `..` segments are then recognised
 * however they were punctuated, rather than hiding inside a segment. It does not consult the host
 * platform's separator (`path.sep` answers for the runner, not for the repository), decodes nothing,
 * and runs AFTER the `#…`, `file:` and absolute-path refusals in `analyseEntrySurfaces`, so no
 * unsupported spelling can be normalised into an allowed one. A repository file whose NAME really
 * contains a backslash is out of scope, as it is for TypeScript.
 */
const normaliseSeparators = (spec: string): string => spec.replace(/\\/g, "/");

/** Join a relative specifier onto a directory. `null` means it escaped the repository root. The
 *  specifier arrives SEPARATOR-NORMALISED (above), so splitting on `/` sees every segment there is. */
function joinRel(fromDir: string, spec: string): string | null {
  const parts = fromDir === "" ? [] : fromDir.split("/");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Emitted-name → source-name substitutions, exactly the pairs TypeScript itself performs. */
const EXT_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/* ─────────────────────────────── resolution ─────────────────────────────── */

type Resolution =
  | { kind: "node"; rel: string }
  | { kind: "excluded"; rel: string }
  | { kind: "asset" }
  | { kind: "outside" }
  | { kind: "missing" }
  /** The reference base carries a package manifest. UNSUPPORTED — refused, never resolved. */
  | { kind: "manifest"; manifest: string };

/** The one filename a directory manifest can have. Named once and EXPORTED because two modules must
 *  agree on it: the refusal below probes for exactly this under exactly the reference base, and the
 *  evidence host in `entry-surface-discovery` refuses to answer about anything else. */
export const MANIFEST_NAME = "package.json";

/**
 * NODES come from the SUPPLIED FILES ONLY — but RESOLUTION does not, and conflating the two is a bug
 * this resolver used to have (Astra code round 2).
 *
 * The two questions are different. **"Which file does this specifier name?"** is a fact about the
 * repository: TypeScript's rules pick ONE winner out of everything on disk, and a file the walk
 * dropped still wins if it outranks the ones the walk kept. **"May that winner be a graph node?"** is
 * this guard's own policy, and it is answered AFTERWARDS. Deciding the first question against the
 * supplied set alone silently answers a DIFFERENT question — "which of the files I kept could this
 * name?" — and hands back a file the runtime would never load.
 *
 * That was not hypothetical. With `lib/bridge.test.ts` on disk (excluded: a test source) and
 * `lib/bridge.test/index.ts` supplied, a supplied-only host resolved `@/lib/bridge.test` to the
 * DIRECTORY INDEX — an unrelated module — and, having "found" something, never looked for the
 * excluded file that actually wins. The reference into the excluded source passed in silence, hidden
 * by a lower-priority file that merely happened to survive the walk.
 *
 * So there is ONE existence view (`existsInView`: supplied files ∪ the caller's resolution evidence),
 * both resolution paths consult it, and the winner is CLASSIFIED once it is known. Neither ordering
 * of the two sets is a policy here: no supplied-first tier, and no excluded-first tier either — an
 * excluded-first rule would answer the first question wrongly in the other direction, refusing an
 * ordinary included file because some lower-priority excluded name exists beside it.
 *
 * Three properties survive that unification, and each is pinned by a control:
 *
 * - **Fixture isolation.** With no evidence host the view IS the supplied set, so a virtual fixture
 *   naming `@/lib/query/retrieve` still comes back UNRESOLVED even though that file genuinely exists
 *   on this disk, and touches no filesystem at all reaching that answer.
 * - **Evidence never admits a node.** `classifyTarget` reads the SUPPLIED map, not the view: a file
 *   only evidence knows about is `excluded` whatever its suffix or location.
 * - **Evidence is never parsed or traversed.** The host answers `fileExists` from the view but
 *   `readFile` from the supplied contents alone, and lists no directories.
 *
 * TypeScript's own bundler resolution decides first (the spec pins the repo's `moduleResolution` and
 * `paths`); a deterministic candidate enumeration — the same rules written out, in the same priority
 * order, against the same view — runs second. It exists because a resolver behaviour that shifts
 * between TypeScript releases would otherwise silently delete edges rather than fail loudly.
 */
function createResolver(
  byRel: ReadonlyMap<string, string>,
  sourceFileExists?: (rel: string) => boolean,
  manifestExists?: (rel: string) => boolean
) {
  const VROOT = "/aios-entry-surface-vfs";
  const absOf = (rel: string) => `${VROOT}/${rel}`;

  const hostFiles = new Map<string, string>();
  for (const [rel, code] of byRel) hostFiles.set(absOf(rel), code);

  const normaliseAbs = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split(/[\\/]/)) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        out.pop();
        continue;
      }
      out.push(seg);
    }
    return `/${out.join("/")}`;
  };

  /** A host path back to a repo-relative one. `null` = not under the virtual root; `""` = the root
   *  itself, which is a directory and therefore never a file. */
  const relOf = (p: string): string | null => {
    const abs = normaliseAbs(p);
    if (abs === VROOT) return "";
    return abs.startsWith(`${VROOT}/`) ? abs.slice(VROOT.length + 1) : null;
  };

  /**
   * THE ONE EXISTENCE VIEW: supplied files, plus whatever resolution evidence the caller supplied.
   *
   * The evidence half is narrow by construction, and the narrowness is what keeps this honest rather
   * than merely permissive — the host in `entry-surface-discovery` answers only for SOURCE spellings
   * inside the walked root and never inside `node_modules`. That is what keeps a genuine
   * `docs/bridge.css` stylesheet a terminal ASSET instead of an "excluded source", and a dependency
   * file unresolved instead of a repository source somebody deliberately excluded.
   */
  const existsInView = (rel: string): boolean => byRel.has(rel) || (sourceFileExists?.(rel) ?? false);

  /**
   * SUPPLIED METADATA: a file the caller handed over that is not spelled like a source (Astra final
   * round 2, P2). It is IN the view — that is how a virtual fixture lets `manifestUnder` answer
   * without a filesystem — and it must never be a MODULE NAME, because admission excludes anything
   * the walk did not yield, so an ordinary `import pkg from "@/package.json"` came back as a
   * reference into an EXCLUDED SOURCE. Availability for the one existence question and availability
   * as a source candidate are different things, and this is the line between them.
   *
   * Only the SUPPLIED half needs the clause. The evidence half answers for source spellings by
   * contract (`isProbeablePath` in `entry-surface-discovery`, which is what keeps a genuine
   * stylesheet a terminal asset). The root-scoped evidence host owns that source-only contract;
   * supplied virtual inputs separately allow metadata and are filtered here.
   */
  const isSuppliedMetadata = (rel: string): boolean => byRel.has(rel) && !isSourceSpelling(rel);

  /**
   * Does the reference BASE carry a package manifest? The whole of the directory-manifest rule.
   *
   * EXACTLY the base, never an ancestor: this repository's own root `package.json` sits above every
   * import in the tree, so an ancestor walk would refuse the entire codebase. `base` arrives
   * NORMALISED from `joinRel` — separators, `.`, `..` and trailing-slash segments are already gone —
   * so `@/lib/bridge/`, `./bridge`, `../lib/./bridge` and `..\lib\bridge` ask about ONE path, not
   * four. That last one is the point: the probe is only a boundary if a different spelling of the
   * same directory cannot walk around it. The empty base is the repository root itself, which is a
   * directory reference like any other.
   *
   * Both halves of the existence view answer, for the same reason `existsInView` has two: a virtual
   * fixture supplies the manifest as a file, the on-disk seam supplies it as evidence. Neither can
   * make it a NODE — `isGraphSourceFile` rejects the spelling, and the nodes list is built from the
   * supplied files, so this metadata is looked at and never entered.
   */
  const manifestUnder = (base: string): string | null => {
    const rel = base === "" ? MANIFEST_NAME : `${base}/${MANIFEST_NAME}`;
    return byRel.has(rel) || (manifestExists?.(rel) ?? false) ? rel : null;
  };

  const host: ts.ModuleResolutionHost = {
    // Supplied METADATA is withheld from the compiler for the same reason `candidates` does not
    // offer it: it is in the view so `manifestUnder` can answer without a filesystem, not so that
    // something can be resolved TO it. Under these options TypeScript would not load a `.json` name
    // anyway (`resolveJsonModule` is off), so this states the rule where the view is served rather
    // than leaving it to a setting that is not the rule.
    fileExists: (f) => {
      const rel = relOf(f);
      return rel !== null && rel !== "" && !isSuppliedMetadata(rel) && existsInView(rel);
    },
    // SUPPLIED CONTENT ONLY — never the view. The evidence host refuses non-source spellings, so
    // nothing it knows about is ever readable here, and `fileExists` above withholds supplied
    // metadata, so a manifest is not readable through this either: the manifest rule is an EXISTENCE
    // question (`manifestUnder`) and never a content one. A file the walk dropped stays metadata: it
    // is resolved TO, never read, parsed or traversed.
    readFile: (f) => hostFiles.get(normaliseAbs(f)),
    // Directory existence is a PRUNING optimisation inside TypeScript: answering "no" stops it
    // looking for files there at all. Enumerating only the supplied files' directories therefore
    // pruned every excluded root — `docs/`, `test/`, a hidden `.generated/` — before `fileExists`
    // was ever consulted, which would leave the evidence half unreachable through TypeScript. So
    // this is deliberately CONSERVATIVE: any path inside the root is assumed to exist and
    // `fileExists` remains the authority. It scans nothing (`getDirectories` is empty), and
    // `node_modules` is refused outright so dependency crawling cannot start.
    directoryExists: (d) => {
      const rel = relOf(d);
      return rel !== null && !rel.split("/").includes("node_modules");
    },
    getDirectories: () => [],
    getCurrentDirectory: () => VROOT,
    realpath: (p) => p,
    useCaseSensitiveFileNames: true,
  };

  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    noEmit: true,
    // Explicit `./x.ts` spellings must RESOLVE here even where the compiler would flag them; a
    // resolver that refused them would report a real edge as missing.
    allowImportingTsExtensions: true,
    resolveJsonModule: false,
    baseUrl: VROOT,
    paths: Object.fromEntries(Object.entries(PINNED_TS_PATHS).map(([k, v]) => [k, [...v]])),
  };

  /**
   * ADMISSION, decided only once the winning target is known — never as part of finding it.
   *
   * A SUPPLIED file gets the graph's ordinary eligibility test. Anything else exists only because the
   * evidence host said so, and is excluded BY CONSTRUCTION: the walk saw the tree and did not hand
   * this file over, which is the whole fact being reported. `isGraphSourceFile` is deliberately not
   * consulted for it — a `.ts` under a non-walked root passes every suffix test there and must still
   * never be a node.
   */
  const classifyTarget = (rel: string): Resolution =>
    byRel.has(rel)
      ? rel === CANONICAL_WRITER_MODULE || isGraphSourceFile(rel)
        ? { kind: "node", rel }
        : { kind: "excluded", rel }
      : { kind: "excluded", rel };

  const candidates = (base: string): string[] => {
    // The BARE BASE, unless it is supplied METADATA (Astra final round 2, P2): a fixture's
    // `package.json` is in the view for `manifestUnder` and is not a module name, and enumerating it
    // here is what made an ordinary JSON data import read as a reference into an excluded source.
    // Real discovery cannot show this — the walk yields sources, so nothing supplies JSON there.
    //
    // It is a refusal to treat that ONE name as source, not a JSON short circuit: every candidate
    // below still runs, so `./config.json` finds the source `config.json.ts` exactly as `./x.css`
    // finds `x.css.ts`, and only a base that resolves to no source at all reaches asset handling.
    // Declaration and test spellings end in `.ts`, so they still resolve and still fail admission.
    const out = isSuppliedMetadata(base) ? [] : [base];
    for (const ext of GRAPH_SOURCE_EXT) out.push(`${base}${ext}`);
    // Declaration targets are enumerated ON PURPOSE. The graph must RECOGNISE a reference into a
    // `.d.ts` in order to refuse it as an excluded source; leaving it out would report the same
    // reference as merely "unresolved" and lose the reason.
    for (const ext of [".d.ts", ".d.mts", ".d.cts"]) out.push(`${base}${ext}`);
    for (const [emitted, replacements] of Object.entries(EXT_SUBSTITUTIONS)) {
      if (base.endsWith(emitted)) for (const s of replacements) out.push(`${base.slice(0, -emitted.length)}${s}`);
    }
    for (const ext of GRAPH_SOURCE_EXT) out.push(`${base}/index${ext}`);
    return out;
  };

  const cache = new Map<string, Resolution>();

  return function resolve(fromRel: string, rawSpec: string): Resolution {
    // ONE local identity for everything below — the manifest probe, the outside-root check, the
    // candidate enumeration and TypeScript itself — so two spellings of one reference cannot get two
    // answers, and the cache cannot hold both. The specifier AS WRITTEN is what the caller quotes in
    // its diagnostics, so normalising here changes no message's spelling.
    const spec = normaliseSeparators(rawSpec);
    const key = cacheKey(dirOf(fromRel), spec);
    const hit = cache.get(key);
    if (hit) return hit;

    const base = spec.startsWith("@/") ? joinRel("", spec.slice(2)) : joinRel(dirOf(fromRel), spec);
    // Asked BEFORE anything is resolved, so the refusal below cannot be reached by any fallback.
    const manifest = base === null ? null : manifestUnder(base);
    let result: Resolution;
    if (base === null) {
      // The specifier climbed out of the repository. Nothing inside the analysed set can satisfy it.
      result = { kind: "outside" };
    } else if (manifest !== null) {
      // DIRECTORY MANIFEST — refused before source, index or asset handling gets a turn (Astra final
      // adjudication, P1). Deliberately unconditional: the manifest's CONTENTS are never read, so
      // "it only declares a `types` field" and "a same-base source file would have won anyway" are
      // both claims this refusal declines to evaluate. The alternative is to guess which redirect
      // field wins and silently choose an index when the guess is wrong — which is the escape that
      // produced this rule, with a manifest redirecting into an ingestion wrapper while a harmless
      // sibling index took the edge. An explicit source-file reference makes the edge unambiguous.
      result = { kind: "manifest", manifest };
    } else {
      // WHICH FILE the specifier names, decided against the whole view — installed TypeScript first,
      // the written-out rules second. Neither is filtered by admission: a target that is filtered out
      // of the search is a target whose refusal can never be reported. Neither half may name supplied
      // METADATA, though: the host withholds it and `candidates` does not offer it, so the
      // `package.json` a fixture hands over for `manifestUnder` cannot come back as a module.
      const viaTs = ts.resolveModuleName(spec, absOf(fromRel), options, host).resolvedModule?.resolvedFileName;
      const tsRel = viaTs === undefined ? null : relOf(viaTs);
      const target =
        (tsRel !== null && tsRel !== "" && existsInView(tsRel) ? tsRel : null) ??
        candidates(base).find((c) => existsInView(c)) ??
        null;

      // …and only then, WHAT IT IS. Source resolution is complete before an asset suffix may
      // terminate anything (Astra adjudication 2 and medium 1 together), so `./x.css` still finds
      // the source `./x.css.ts` — supplied or merely evidenced — rather than dying as a stylesheet.
      if (target !== null) result = classifyTarget(target);
      else if (ASSET_EXT.some((e) => base.endsWith(e))) result = { kind: "asset" };
      else result = { kind: "missing" };
    }
    cache.set(key, result);
    return result;
  };
}

/* ───────────────────────── module references in one file ───────────────────────── */

interface ModuleRef {
  spec: string;
  line: number;
}

/** Which loading form ran. Kept because an exception is written for ONE of them: `require` is a
 *  synchronous CommonJS load with different semantics, and the reviewed E2B reason is about a
 *  dynamic `import(...)`. Without this the two are indistinguishable to the matcher (Astra
 *  medium 3) — same binding, same function, same count. */
type LoaderKind = "import" | "require";

/** The only loader a `ComputedLoadException` can excuse. Not configurable, on purpose. */
const EXCEPTION_LOADER: LoaderKind = "import";

interface ComputedLoad {
  line: number;
  loader: LoaderKind;
  /** The identifier passed as the whole argument, when the argument is exactly one identifier. */
  bindingArg: string | null;
  /** That identifier's NODE. Kept because an exception has to establish which DECLARATION the
   *  argument refers to; the spelling alone is satisfied by any shadow of the same name. */
  argId: ts.Identifier | null;
  fn: string | null;
  text: string;
}

const isWhollyTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause;
  if (!clause) return false; // a side-effect import is a value dependency
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // a default binding is a value
  const named = clause.namedBindings;
  if (named && ts.isNamedImports(named)) {
    return named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
  }
  return false;
};

const isWhollyTypeOnlyExport = (node: ts.ExportDeclaration): boolean => {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
  }
  return false;
};

/** The function a node sits inside, by the name a reviewer would use. */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) {
      return p.name && ts.isIdentifier(p.name) ? p.name.text : null;
    }
    if (ts.isFunctionExpression(p) || ts.isArrowFunction(p)) {
      if (ts.isFunctionExpression(p) && p.name) return p.name.text;
      if (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
      return null;
    }
  }
  return null;
}

/* ────────── lexical binding, ONLY for the computed-load exception ──────────
 *
 * The exception's entire justification is "external package — it can never resolve to a repo
 * module", and that claim is about ONE declaration: the top-level `const`. Matching the argument's
 * SPELLING never establishes it. A `defaultLoader(E2B_MODULE: string)` parameter supplies a
 * caller-chosen specifier while the untouched top-level const goes on satisfying the allow rule, so
 * the load has to be tied to the DECLARATION it names.
 *
 * What follows is a deliberately small walk over the ancestors of ONE identifier — the argument of
 * one recognised load — not a program-wide scope engine and not a type checker. It answers one
 * question ("which declaration does this reference resolve to?") and answers "uncertain" as soon as
 * the construct is outside what it models; an uncertain load is refused, never excused.
 */

/** Does this binding name bind `name` — plainly, or anywhere inside a destructuring pattern? A
 *  renamed destructure (`const { pkg: NAME } = …`) binds NAME, so the BOUND name is what counts. */
function bindsName(bn: ts.BindingName | undefined, name: string): boolean {
  if (!bn) return false;
  if (ts.isIdentifier(bn)) return bn.text === name;
  // Object and array patterns hold different element unions; widen once so this is one traversal.
  const elements: readonly ts.Node[] = bn.elements;
  return elements.some((el) => ts.isBindingElement(el) && bindsName(el.name, name));
}

/** The function-like forms that own parameter and `var` bindings. A type predicate, so `.parameters`
 *  and `.body` stay reachable without re-testing the kind. */
const isFunctionScope = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** `let`/`const` bind where they are written; anything else in a declaration list is `var`-like and
 *  hoists to the enclosing function (or file) scope. */
const isLexicalList = (list: ts.VariableDeclarationList): boolean =>
  (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;

/**
 * The declarations THIS scope node itself binds for `name` — never the ones its parents bind, and
 * never the ones a nested scope binds. Sources here are modules and therefore always strict, so a
 * function declaration is block-scoped and is found through the Block it sits in; only `var` hoists.
 */
function bindingsIn(scope: ts.Node, name: string): ts.Node[] {
  const hits: ts.Node[] = [];
  const push = (bn: ts.BindingName | undefined, decl: ts.Node): void => {
    if (bindsName(bn, name)) hits.push(decl);
  };

  const lexicalStatements = (statements: readonly ts.Statement[]): void => {
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        if (isLexicalList(st.declarationList)) for (const d of st.declarationList.declarations) push(d.name, d);
      } else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
        if (st.name && st.name.text === name) hits.push(st);
      } else if (ts.isImportEqualsDeclaration(st)) {
        if (st.name.text === name) hits.push(st);
      } else if (ts.isImportDeclaration(st) && st.importClause) {
        const clause = st.importClause;
        if (clause.name && clause.name.text === name) hits.push(clause);
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named) && named.name.text === name) hits.push(named);
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) if (el.name.text === name) hits.push(el);
        }
      }
    }
  };

  /** `var` hoists out of blocks to the function/file scope — but never out of a nested function. */
  const hoistedVars = (root: ts.Node): void => {
    const visit = (n: ts.Node): void => {
      if (isFunctionScope(n) || ts.isClassLike(n)) return;
      if (ts.isVariableDeclarationList(n) && !isLexicalList(n)) {
        for (const d of n.declarations) push(d.name, d);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(root, visit);
  };

  if (ts.isSourceFile(scope)) {
    lexicalStatements(scope.statements);
    hoistedVars(scope);
  } else if (isFunctionScope(scope)) {
    for (const p of scope.parameters) push(p.name, p);
    if (ts.isFunctionExpression(scope) && scope.name && scope.name.text === name) hits.push(scope);
    if (scope.body) hoistedVars(scope.body);
  } else if (ts.isBlock(scope)) {
    lexicalStatements(scope.statements);
  } else if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) lexicalStatements(clause.statements);
  } else if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) push(scope.variableDeclaration.name, scope.variableDeclaration);
  } else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    if (init && ts.isVariableDeclarationList(init)) for (const d of init.declarations) push(d.name, d);
  } else if (ts.isClassLike(scope)) {
    if (scope.name && scope.name.text === name) hits.push(scope);
  }
  return hits;
}

/** Where a value reference's binding lives: exactly one declaration, none, or "this walk cannot say". */
type BindingSite = { kind: "declaration"; node: ts.Node } | { kind: "unbound" } | { kind: "uncertain" };

/**
 * The declaration `id` refers to, by ordinary lexical scoping: the nearest enclosing scope that
 * binds the spelling wins, wherever in that scope it is WRITTEN. A `let` below the reference (a TDZ
 * error) or a `var` below it still owns the whole scope, so "the top-level declaration comes first"
 * is never an argument for excusing a load.
 */
function resolveValueBinding(id: ts.Identifier): BindingSite {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    // `with` and `namespace` make the target depend on a runtime object or on declaration merging,
    // neither of which this walk models. Refuse rather than approximate safety.
    if (ts.isWithStatement(scope) || ts.isModuleDeclaration(scope) || ts.isModuleBlock(scope)) {
      return { kind: "uncertain" };
    }
    const hits = bindingsIn(scope, id.text);
    if (hits.length === 1) return { kind: "declaration", node: hits[0] };
    if (hits.length > 1) return { kind: "uncertain" }; // one scope, two declarations of the name
  }
  return { kind: "unbound" };
}

/**
 * The UNIQUE top-level `const NAME = "…"` — the only binding shape a computed-load exception may
 * cite. Returns the DECLARATION as well as the value, because the exception has to establish that
 * the load's argument RESOLVES to this declaration, not merely that something spelled that way
 * exists. Null when the name is absent, is not that shape, or is bound MORE THAN ONCE at file
 * scope: ambiguity is refused, not guessed.
 */
function topLevelStringConst(
  src: ts.SourceFile,
  name: string
): { decl: ts.VariableDeclaration; value: string } | null {
  const hits = bindingsIn(src, name);
  if (hits.length !== 1) return null;
  const decl = hits[0];
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  if (!ts.isVariableDeclarationList(decl.parent) || !(decl.parent.flags & ts.NodeFlags.Const)) return null;
  if (!decl.initializer || !ts.isStringLiteralLike(decl.initializer)) return null;
  return { decl, value: decl.initializer.text };
}

/**
 * Every RUNTIME module reference in one file, plus every load whose specifier is not a literal.
 *
 * Recognised: static imports (default, named, namespace, side-effect), export-from (named, renamed,
 * star, namespace), `import x = require(…)`, literal `import(…)` awaited or not, and literal
 * `require(…)` anywhere in the AST. The edge is followed regardless of the imported symbol's
 * spelling or whether anything calls it — this analysis decides REACHABILITY, not execution.
 *
 * Excluded: `import type` / `export type`, wholly type-only named specifiers, and `import(…)` TYPE
 * expressions. A MIXED value/type import keeps its edge. A no-substitution template literal is a
 * literal module name; a template with a substitution is not.
 */
function referencesOf(src: ts.SourceFile): { refs: ModuleRef[]; computed: ComputedLoad[] } {
  const refs: ModuleRef[] = [];
  const computed: ComputedLoad[] = [];
  const lineOf = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;

  const visit = (node: ts.Node): void => {
    // `typeof import("x")` / `import("x").Foo` are TYPES. They never carry a runtime edge, and
    // their argument is a literal type rather than a call, so the loader rules below never see them.
    if (ts.isImportTypeNode(node)) return;

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !isWhollyTypeOnlyImport(node)) {
      refs.push({ spec: node.moduleSpecifier.text, line: lineOf(node) });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !isWhollyTypeOnlyExport(node)
    ) {
      refs.push({ spec: node.moduleSpecifier.text, line: lineOf(node) });
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      refs.push({ spec: node.moduleReference.expression.text, line: lineOf(node) });
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          refs.push({ spec: arg.text, line: lineOf(node) });
        } else {
          const argId = arg && ts.isIdentifier(arg) ? arg : null;
          computed.push({
            line: lineOf(node),
            loader: isDynamicImport ? "import" : "require",
            bindingArg: argId ? argId.text : null,
            argId,
            fn: enclosingFunctionName(node),
            text: node.getText(src).slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { refs, computed };
}

/* ───────────────────────── the `use server` directive ───────────────────────── */

/**
 * A REAL directive prologue entry — an ExpressionStatement whose expression is a StringLiteral,
 * appearing before any other statement. A quoted string in a comment, a type, an arbitrary
 * expression or a non-prologue position is not a directive, and a no-substitution TEMPLATE is not a
 * directive either: ECMAScript's directive prologue is StringLiteral-only, even though this graph
 * does accept a template as a module NAME (Astra adjudication 3).
 */
function prologueHasUseServer(statements: readonly ts.Statement[]): boolean {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st)) return false;
    if (st.expression.kind !== ts.SyntaxKind.StringLiteral) return false;
    if ((st.expression as ts.StringLiteral).text === "use server") return true;
  }
  return false;
}

/**
 * The function-like forms that can CARRY a directive prologue — i.e. the ones with a `body`.
 * `ts.isFunctionLike` also admits bodiless signatures (call/construct/index/method signatures, and
 * function/constructor TYPE nodes), which is why it narrows only to `ts.SignatureDeclaration`. This
 * enumerates the body-bearing subset with public type guards, so the `.body` read below is sound
 * without a cast; the set the directive walk actually visits is unchanged.
 */
type BodyBearingFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isBodyBearingFunction(node: ts.Node): node is BodyBearingFunction {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function hasUseServerDirective(src: ts.SourceFile): boolean {
  if (prologueHasUseServer(src.statements)) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // An arrow's body is a ConciseBody, so the `isBlock` check carries an expression body out too.
    if (isBodyBearingFunction(node) && node.body && ts.isBlock(node.body) && prologueHasUseServer(node.body.statements)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/**
 * A reached file that a human must classify.
 *
 * Deliberately NOT keyed on filenames: pages, layouts, read-only consumers, script helpers and
 * client components all count, because each is a place a new caller can appear. Other reached
 * `lib/` modules are intermediate nodes and need no entry record — a plain lib direct writer keeps
 * the obligation it already has under the direct-call inventory and does not acquire a second one
 * (Astra adjudication 1).
 */
function isSurfaceFile(rel: string, src: ts.SourceFile): boolean {
  if (rel === CANONICAL_WRITER_MODULE) return false;
  if (rel.startsWith("app/") || rel.startsWith("components/") || rel.startsWith("scripts/")) return true;
  if (!rel.includes("/")) return true; // a root-level source ships too
  if (rel.startsWith("lib/")) return hasUseServerDirective(src);
  return false;
}

/* ─────────────────────────────── the analysis ─────────────────────────────── */

/**
 * THE SEAM. Build the reverse-import closure of the canonical writer over `files`, decide which
 * reached files are SURFACES, and check them against `inventory`.
 *
 * **Graph.** For a runtime module reference in A resolving to B, record A → B. Start at the seed
 * alone and add importers until nothing is new; a visited worklist over a finite file set
 * terminates. Traverse THROUGH wrappers, barrels, surfaces and cycles — stopping at an
 * already-classified module is exactly how the omitted caller hides. **Never seed from either
 * inventory:** an omitted writer would then erase its own callers.
 *
 * **Records.** One per surface, exact-key. Missing record, unknown class or blank reason fails.
 * A record whose file vanished, lost its path to the writer, or stopped meeting the predicate fails
 * as STALE. Removing one edge while another path survives is NOT staleness — reachability decides,
 * not the witness, or an ordinary refactor would fail a guard nobody can act on.
 *
 * **Fail-closed loads.** A non-literal `import(...)` or `require(...)` anywhere in the scanned
 * sources is refused EVEN OUTSIDE the current closure: ignoring it there is precisely how a hidden
 * edge prevents its own discovery. Only an exact `ComputedLoadException` clears one, and only for a
 * dynamic `import(...)` (`EXCEPTION_LOADER`). This is fail-closed for these recognised loading forms
 * — not a proof against eval, aliased loaders or bundler plugins. Parse errors are reported, never
 * swallowed.
 *
 * **References that resolve to nothing analysable.** An absolute path spelling and a `file:` module
 * URL are refused as local references the graph does not resolve; a reference base carrying a
 * `package.json` is refused as an unsupported directory manifest BEFORE any source/index/asset
 * fallback; a specifier naming a source the WALK dropped is refused as an `excluded-ref` when the
 * caller supplied `sourceFileExists`. Local path separators are canonicalised before any of that
 * (`normaliseSeparators`), so these rules key on the path a specifier NAMES and not on how it was
 * punctuated. None is ever admitted as a node. Each of these is a REFUSAL
 * rather than a resolution, and the reason is always the same one: the alternative is to terminate
 * a local reference as though it were an external package, which deletes the edge and every surface
 * behind it while reporting nothing at all.
 */
export function analyseEntrySurfaces(
  files: readonly SourceFile[],
  inventory: Readonly<Record<string, EntryRecord>>,
  options: EntryAnalysisOptions = {}
): EntrySurfaceAnalysis {
  const violations: EntryViolation[] = [];
  const excludedRefs: ExcludedRef[] = [];
  const exceptions = options.exceptions ?? [];

  // ── the analysed set. The SEED is added explicitly: the direct-call walk excludes it, so without
  // this every `@/lib/ingest` reference in the real tree would read as unresolved and the graph
  // would have no root at all.
  const byRel = new Map<string, string>();
  for (const f of files) byRel.set(f.rel, f.code);
  if (!byRel.has(CANONICAL_WRITER_MODULE)) byRel.set(CANONICAL_WRITER_MODULE, "");

  const nodes = [...byRel.keys()].filter((rel) => rel === CANONICAL_WRITER_MODULE || isGraphSourceFile(rel));
  const resolve = createResolver(byRel, options.sourceFileExists, options.manifestExists);
  const sources = new Map<string, ts.SourceFile>();
  const imports = new Map<string, Set<string>>();
  const exceptionUsed = new Array<boolean>(exceptions.length).fill(false);

  for (const rel of nodes) {
    const src = parseGraphSource(rel, byRel.get(rel) ?? "");
    sources.set(rel, src);

    const parseErrors = parseErrorsOf(src);
    if (parseErrors.length > 0) {
      // ONE per file: a broken file produces a cascade of syntactic diagnostics, and a hundred lines
      // of them buries every other violation in the same run.
      const first = parseErrors[0];
      const line = src.getLineAndCharacterOfPosition(first.start ?? 0).line + 1;
      violations.push({
        kind: "parse",
        message:
          `${rel}:${line} could not be parsed — ${ts.flattenDiagnosticMessageText(first.messageText, " ")}. ` +
          `Its module edges are therefore unknown; fix the source rather than excluding the file.`,
      });
    }

    const { refs, computed } = referencesOf(src);

    // ── computed loads: refused unless an exception matches this file EXACTLY.
    for (let i = 0; i < exceptions.length; i++) {
      const e = exceptions[i];
      if (e.file !== rel) continue;
      // The occurrence count is a property of the APPROVED LOADER, not of the identifier: an
      // unrelated `require` of the same const must not be able to invalidate the reviewed import by
      // inflating its count, any more than it may borrow the exception below.
      const bound = computed.filter((c) => c.loader === EXCEPTION_LOADER && c.bindingArg === e.binding);
      const approved = topLevelStringConst(src, e.binding);
      const valueOk = approved !== null && approved.value === e.value;
      if (!approved || !valueOk || bound.length !== e.occurrences || e.occurrences === 0) continue;
      // The binding IDENTITY, not the spelling: every excused load's argument must resolve to that
      // one approved declaration. A parameter, a local, a hoisted `var`, a block or catch binding of
      // the same name — or any construct this walk cannot resolve — leaves the load unexcused, and
      // the exception then fits nothing and goes stale.
      const approvedDecl = approved.decl;
      const bindsApproved = (c: ComputedLoad): boolean => {
        if (!c.argId) return false;
        const site = resolveValueBinding(c.argId);
        return site.kind === "declaration" && site.node === approvedDecl;
      };
      if (bound.every((c) => c.fn === e.functionName && bindsApproved(c))) exceptionUsed[i] = true;
    }
    for (const load of computed) {
      const excused = exceptions.some(
        (e, i) =>
          exceptionUsed[i] &&
          e.file === rel &&
          load.loader === EXCEPTION_LOADER &&
          load.bindingArg === e.binding &&
          load.fn === e.functionName
      );
      if (excused) continue;
      violations.push({
        kind: "refused-load",
        message:
          `${rel}:${load.line} loads a module through a NON-LITERAL specifier (\`${load.text}\`). ` +
          `The graph cannot see where that edge goes, so it is refused even outside the current ` +
          `closure — a hidden edge is exactly what would prevent its own discovery. Use a literal ` +
          `specifier, or add a narrow COMPUTED_LOAD_EXCEPTIONS entry with a concrete reason` +
          (load.loader === EXCEPTION_LOADER
            ? "."
            : ` — noting that an exception covers a dynamic \`import(...)\` only, so this ` +
              `\`${load.loader}\` cannot borrow one written for the import beside it.`),
      });
    }

    // ── module edges.
    for (const ref of refs) {
      const loc = `${rel}:${ref.line}`;
      if (ref.spec.startsWith("#")) {
        violations.push({
          kind: "unsupported-alias",
          message:
            `${loc} imports "${ref.spec}" — a package-import alias (#…). This slice does not resolve ` +
            `package.json "imports", and treating it as an external package would erase the edge and ` +
            `every surface behind it. Refused as UNSUPPORTED, whether or not a mapping exists today.`,
        });
        continue;
      }
      // A `file:` MODULE URL is a local reference wearing a scheme. The local test below keys on
      // `.` and `@/`, so `file:///tmp/bridge.mjs` falls through to the external-package branch and
      // terminates in silence — the same erasure an absolute path used to get, and reproduced the
      // same way. Matched case-INSENSITIVELY because URL schemes are: `FILE:` and `File:` name the
      // identical protocol, and a case-sensitive test would refuse the lowercase spelling while
      // waving its shouted twin through. Nothing here decodes or resolves the URL — percent-escapes,
      // hosts and query strings are not this slice's problem; refusing the SPELLING is.
      if (/^file:/i.test(ref.spec)) {
        violations.push({
          kind: "unsupported-file-url",
          message:
            `${loc} imports "${ref.spec}" — a \`file:\` MODULE URL. That is a LOCAL code reference, ` +
            `not an external package: this graph resolves relative and "@/" references inside the ` +
            `repository only, and it does not decode or resolve URLs. Refused as UNSUPPORTED, ` +
            `because terminating it as a package would erase the edge — and every surface behind ` +
            `it — in silence. Spell it "@/…" or relatively.`,
        });
        continue;
      }
      if (isAbsoluteSpecifier(ref.spec)) {
        violations.push({
          kind: "unresolved",
          message:
            `${loc} imports "${ref.spec}" — an ABSOLUTE PATH spelling, which is a LOCAL code ` +
            `reference and never a package name. This graph resolves relative and "@/" references ` +
            `inside the repository only, so the reference is refused as UNSUPPORTED/outside that ` +
            `boundary: terminating it as an external package would erase the edge, and every ` +
            `surface behind it, in silence. Spell it "@/…" or relatively.`,
        });
        continue;
      }
      const isLocal = ref.spec.startsWith(".") || ref.spec.startsWith("@/");
      if (!isLocal) continue; // an external package or a node builtin is a terminal dependency

      const target = resolve(rel, ref.spec);
      if (target.kind === "node") {
        let set = imports.get(rel);
        if (!set) imports.set(rel, (set = new Set<string>()));
        set.add(target.rel);
      } else if (target.kind === "excluded") {
        excludedRefs.push({ from: rel, specifier: ref.spec, at: loc, target: target.rel });
        violations.push({
          kind: "excluded-ref",
          message:
            `${loc} imports "${ref.spec}", which resolves to ${target.rel} — a source this guard ` +
            `EXCLUDES (a type declaration, a test source, the in-memory PostgREST double, or a file ` +
            `the walk never yields: a non-walked root, a hidden/generated directory). A runtime ` +
            `reference across that boundary is a hole in the closure, not a note: remove the ` +
            `reference, make it \`import type\`, or change what the walk excludes deliberately.`,
        });
      } else if (target.kind === "manifest") {
        violations.push({
          kind: "unsupported-directory-manifest",
          message:
            `${loc} imports "${ref.spec}", whose reference base carries a package manifest ` +
            `(${target.manifest}). LOCAL DIRECTORY-MANIFEST resolution is UNSUPPORTED here: this ` +
            `guard does not read manifest contents, follow "main"/"exports" redirects, consult ` +
            `ancestor manifests or crawl dependencies, so it cannot say which file the runtime ` +
            `would load — and choosing a directory index instead would silently take the edge away ` +
            `from a redirect target that may be an ingestion wrapper. The refusal is deliberate ` +
            `even if the manifest is benign or a same-base source file would have won. Import the ` +
            `source file explicitly (e.g. "${ref.spec}/<file>"), or remove the manifest.`,
        });
      } else if (target.kind === "outside") {
        violations.push({
          kind: "unresolved",
          message:
            `${loc} imports "${ref.spec}", which resolves OUTSIDE the repository root. The graph ` +
            `keeps local resolution inside the repository, so this edge cannot be followed.`,
        });
      } else if (target.kind === "missing") {
        violations.push({
          kind: "unresolved",
          message:
            `${loc} imports "${ref.spec}" — no analysed source resolves it, and it is not a ` +
            `recognised non-code asset. An unresolved local reference is a MISSING EDGE, so it fails ` +
            `rather than disappearing.`,
        });
      }
      // `asset`: a recognised non-code dependency, terminal by design — and only after local source
      // resolution has been tried, so `./x.css` still finds the source `./x.css.ts`.
    }
  }

  for (let i = 0; i < exceptions.length; i++) {
    if (exceptionUsed[i]) continue;
    const e = exceptions[i];
    violations.push({
      kind: "stale-exception",
      message:
        `the computed-load exception for ${e.file} (${e.functionName} / ${e.binding}) matches NOTHING ` +
        `in the analysed sources. An exception nobody needs is a hole nobody is watching — remove it, ` +
        `or restore the load it was written for.`,
    });
  }

  // ── the reverse closure: importers of the seed, to a fixpoint. Never seeded from an inventory.
  const importers = new Map<string, Set<string>>();
  for (const [from, targets] of imports) {
    for (const to of targets) {
      let set = importers.get(to);
      if (!set) importers.set(to, (set = new Set<string>()));
      set.add(from);
    }
  }
  const dist = new Map<string, number>([[CANONICAL_WRITER_MODULE, 0]]);
  const queue: string[] = [CANONICAL_WRITER_MODULE];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const depth = dist.get(cur) ?? 0;
    for (const importer of importers.get(cur) ?? []) {
      if (dist.has(importer)) continue;
      dist.set(importer, depth + 1);
      queue.push(importer);
    }
  }

  const closure = [...dist.keys()].sort();

  // ── one deterministic witness per reached file: shortest chain, ties broken on the
  // lexicographically smallest next hop, so the diagnostic does not flap between runs or with the
  // order files happen to arrive in.
  const witness: Record<string, string[]> = {};
  for (const rel of closure) {
    const chain = [rel];
    let cur = rel;
    while (cur !== CANONICAL_WRITER_MODULE) {
      const depth = dist.get(cur) ?? 0;
      const next = [...(imports.get(cur) ?? [])].filter((t) => dist.get(t) === depth - 1).sort()[0];
      if (!next) break;
      chain.push(next);
      cur = next;
    }
    witness[rel] = chain;
  }

  const surfaces = closure.filter((rel) => {
    const src = sources.get(rel);
    return src ? isSurfaceFile(rel, src) : false;
  });

  // ── the records. Exact-key, both directions.
  for (const rel of surfaces) {
    const record = inventory[rel];
    if (!record) {
      violations.push({
        kind: "unclassified-entry",
        message:
          `${rel} can reach the item writer and carries NO entry record. Chain: ` +
          `${(witness[rel] ?? [rel]).join(" → ")}. Add it to ENTRY_INVENTORY with a class ` +
          `(${ENTRY_CLASSES.join(" | ")}) and a concrete reason — do not silence this.`,
      });
      continue;
    }
    if (!(ENTRY_CLASSES as readonly string[]).includes(record.class)) {
      violations.push({
        kind: "unknown-class",
        message: `${rel} is classified \`${record.class}\`, which is not one of ${ENTRY_CLASSES.join(" | ")}.`,
      });
    }
    if (!record.reason.trim()) {
      violations.push({
        kind: "blank-reason",
        message: `${rel} has an entry record with no reason. A bare class is a shrug, not a review.`,
      });
    }
  }

  const surfaceSet = new Set(surfaces);
  for (const rel of Object.keys(inventory)) {
    if (surfaceSet.has(rel)) continue;
    violations.push({
      kind: "stale-entry",
      message:
        `${rel} carries an entry record but is no longer a discovered entry surface — the file is ` +
        `gone, it no longer reaches the item writer, or it no longer meets the surface predicate. ` +
        `Re-read why it was classified, then remove the stale entry.`,
    });
  }

  return { violations, surfaces, closure, witness, excludedRefs };
}

/**
 * The reviewed entry inventory — one record per surface the real tree discovers.
 *
 * Every record here was written after reading the import that puts its file in the closure. The
 * three classes are REVIEW DECLARATIONS, not machine-certified execution facts: `RECONCILES` says a
 * human read an orchestration and named it, `SWEEP_DEPENDENT` says a real ingestion entry depends
 * on later repair, `IMPORT_ONLY` says no ingest operation was identified AT THIS SURFACE and names
 * the import responsible for the inclusion. None of them asserts that an ingest runs, or does not.
 */
export const ENTRY_INVENTORY: Record<string, EntryRecord> = {
  /* ── HTTP entries that write, or start something that writes ─────────────────────────────── */
  "app/api/v1/items/route.ts": {
    class: "RECONCILES",
    reason:
      "the workspace CLI push path — the one surface that calls ingestItem itself, and reconciles " +
      "AFTER THE RESPONSE inside after(). A failure there is not surfaced to the pusher; the item " +
      "waits for the sweep",
  },
  "app/api/v1/codebases/route.ts": {
    class: "SWEEP_DEPENDENT",
    reason:
      "POST /api/v1/codebases → ingestCodebaseScan → projectCommitsToItems → ingestItem. Reconciling " +
      "at push was specced and DECLINED (spec §6b): it needs an admission allocation, not a budget. " +
      "⚠️ 64% of ingested volume, and with INGEST_POLL_ENABLED=false there is no backstop at all",
  },
  "app/api/v1/actions/route.ts": {
    class: "SWEEP_DEPENDENT",
    reason:
      "runAction → lib/actions → handlerRegistry: the note.create handler writes an item from an " +
      "HTTP request OUTSIDE the scheduler chain, with no reconcile of its own — next tick or later",
  },
  "app/api/dashboard/query/route.ts": {
    class: "RECONCILES",
    reason:
      "the dashboard's manual-sync command (isSyncCommand → runManualSync). Since AUDITFIX-14 it " +
      "awaits ONE bounded 25-candidate context pass, so a small import is partitioned before the " +
      "response and a larger backlog reports PENDING and needs repeated runs",
  },

  /* ── server actions that write, or start something that writes ───────────────────────────── */
  "app/t/[team]/admin/integrations/actions.ts": {
    class: "RECONCILES",
    reason:
      "the FOUR connector 'Run now' actions (syncSlackNow / syncPlaneNow / syncLinearNow / " +
      "syncGithubNow) go through runNowThenReconcile, so since AUDITFIX-14 each awaits one bounded " +
      "manual context pass; a backlog larger than that pass reports pending, and with the poller off " +
      "repeated runs are the only progress there is. projectToGraphNow is in this file but is NOT " +
      "part of that: it awaits runGraphProjection and records the run, which pushes graph episodes " +
      "and writes no item, so there is nothing for it to reconcile",
  },
  "app/t/[team]/admin/approvals/actions.ts": {
    class: "SWEEP_DEPENDENT",
    reason:
      "resolveApproval → lib/actions → handlers: approving a queued note.create writes an item on the " +
      "admin's request, with no reconcile on that path — it waits for the sweep like the HTTP route",
  },
  "app/t/[team]/meetings/actions.ts": {
    class: "RECONCILES",
    reason:
      "the meeting upload/merge/import actions. lib/meetings/notes and lib/meetings/merge reconcile " +
      "INLINE on purpose — the uploader's own meeting would 404 until the sweep otherwise — and the " +
      "upload returns visible:false when the inline reconcile did not complete",
  },

  /* ── the boot hook that starts the scheduler ─────────────────────────────────────────────── */
  "instrumentation.ts": {
    class: "SWEEP_DEPENDENT",
    reason:
      "dynamically imports lib/ingest/scheduler (and lib/graph/scheduler) at boot. The tick's four " +
      "connector legs run BEFORE runContextBackfill and are swept in their own tick; with " +
      "INGEST_POLL_ENABLED=false this entry starts nothing and no sweep exists to depend on",
  },

  /* ── CLI scripts ─────────────────────────────────────────────────────────────────────────── */
  "scripts/seed-demo.ts": {
    class: "SWEEP_DEPENDENT",
    reason:
      "demo seeding calls ingestItem directly and is drained ONLY under docker/bootstrap.mjs; " +
      "npm run dev:seed, scripts/e2e.sh and scripts/dev-test-setup.sh invoke it with no drain, which " +
      "leaves those items unpartitioned indefinitely when the poller is off",
  },
  "scripts/connectors.ts": {
    class: "RECONCILES",
    reason:
      "the connectors CLI `verify` leg calls runManualSync, which since AUDITFIX-14 awaits the same " +
      "bounded 25-candidate pass as the dashboard command — pending is reported, not hidden",
  },
  "scripts/backfill-meeting-summaries.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports refreshMeetingNoteExtraction from lib/meetings/refresh, which re-extracts summaries and " +
      "attendees onto EXISTING meeting_notes rows through lib/meetings/notes. No ingest at this surface",
  },
  "scripts/admin.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports purgeItemIds from lib/ingest/purge — the REMOVAL path. It enters the closure only " +
      "because purge dynamically imports bustTeamLearningCaches from lib/ingest/reconcile-attribution; " +
      "nothing on this surface creates an item",
  },
  "scripts/graph-window-battery/run-projection.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports runGraphProjection from lib/graph/run, which reaches the closure through " +
      "purgeExternalTierCaches in lib/cache/tier-invalidation. Graph projection READS items and " +
      "writes episodes to the sidecar; it never writes an item",
  },

  /* ── read-only HTTP surfaces pulled in by the work-timeline / attribution readers ─────────── */
  "app/api/dashboard/timeline/route.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports getCachedWorkTimeline (lib/dashboard/timeline-cache) and getWorkTimeline/WINDOW_DAYS " +
      "(lib/dashboard/work-timeline); work-timeline reaches the writer only through canSeeMeetingNotes " +
      "in lib/meetings/notes, a visibility READER",
  },
  "app/api/dashboard/team-work/route.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports getCachedWorkTimeline from lib/dashboard/timeline-cache — the same cached read as the " +
      "dashboard timeline route, no write path of its own",
  },
  "app/api/v1/timeline/route.ts": {
    class: "IMPORT_ONLY",
    reason:
      "the public timeline read: getCachedWorkTimeline from lib/dashboard/timeline-cache. The cache " +
      "recompute it can trigger is a timeline recompute, not an item ingest",
  },
  "app/api/v1/attribution/route.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports getAttributionHealth and getMemberItems from lib/attribution/health, which reaches the " +
      "closure via parseAuthorIdentity in lib/codebases/commits-to-items — a parser shared with the " +
      "commit writer, read-only here",
  },

  /* ── admin server actions that mutate ATTRIBUTION, not the item set ──────────────────────── */
  "app/t/[team]/admin/members/actions.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports reattributeItems (lib/ingest/reattribute) and reconcileAttribution/bustTeamLearningCaches " +
      "(lib/ingest/reconcile-attribution). Both REWRITE the author of existing items and bust caches; " +
      "neither creates one, so there is no ingest here to reconcile or sweep",
  },
  "app/t/[team]/admin/attribution/actions.ts": {
    class: "IMPORT_ONLY",
    reason:
      "imports getMemberItems (lib/attribution/health) and bustTeamLearningCaches " +
      "(lib/ingest/reconcile-attribution): the correction preview/apply path edits attribution on " +
      "existing items — no item is created at this surface",
  },

  /* ── pages and layouts: server components that render closure readers ────────────────────── */
  "app/t/[team]/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "the Pulse home renders <TimelinePanel/>, which reads getCachedWorkTimeline. The page itself " +
      "performs no ingest; it is in the closure because the panel it renders is",
  },
  "app/t/[team]/meetings/layout.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports the meetings loaders (loadMeetingNotes/sortedMeetingNotes) and renders the upload and " +
      "import BUTTONS. The write happens in app/t/[team]/meetings/actions.ts, which those buttons call",
  },
  "app/t/[team]/meetings/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports loadTeamId/loadViewer/loadMeetingNotes from lib/meetings/loaders and renders " +
      "MeetingDetailView — a read of meeting_notes, no write path",
  },
  "app/t/[team]/meetings/[id]/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports loadTeamId/loadViewer from lib/meetings/loaders and renders MeetingDetailView for one " +
      "meeting. Read-only; the tab actions it renders live in the meetings actions file",
  },
  "app/t/[team]/admin/approvals/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "renders ApprovalsQueue and ManagedGatewayApprovals, both of which call the approvals actions. " +
      "The page reads the queue; the write is the action's",
  },
  "app/t/[team]/admin/integrations/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "renders IntegrationsManager / GithubReposPanel / OpenrouterPanel / MemberOnboardingPanel, each " +
      "bound to the integrations actions. The 'Run now' write is the action's, not the page's",
  },
  "app/t/[team]/admin/members/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "renders the member row controls (identities, role, manager, reattribute, reset, remove, " +
      "provisioning) which call app/t/[team]/admin/members/actions.ts. The page itself only reads",
  },
  "app/t/[team]/admin/attribution/page.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports getAttributionHealth from lib/attribution/health and renders AttributionHealthView plus " +
      "AttributionCorrectionBox; the correction write is the attribution action's",
  },

  /* ── client components: in the closure because they import a server action or a reader ───── */
  "components/meetings/meeting-detail-view.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports getMeetingNote from lib/meetings/notes (a reader exported by a module that ALSO writes) " +
      "and renders MeetingDetailTabs. Importing a reader from a writer-bearing module is a " +
      "conservative inclusion, not evidence of a write",
  },
  "components/meetings/meeting-detail-tabs.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "a client component importing regenerateMeetingSummaryAction from the meetings actions file. " +
      "The reconcile obligation lives with that action; this surface only invokes it from the UI",
  },
  "components/meetings/new-meeting-note-button.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports uploadMeetingNoteAction from the meetings actions file. The upload's INLINE reconcile " +
      "is that action's contract; the button is the caller",
  },
  "components/meetings/import-pushed-meetings-button.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports importPushedMeetingsAction from the meetings actions file — the backfill-from-items " +
      "trigger. The write and its reconcile are the action's",
  },
  "components/learning/timeline-panel.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports getCachedWorkTimeline (lib/dashboard/timeline-cache) and WINDOW_DAYS/MAX_WINDOW_DAYS " +
      "(lib/dashboard/work-timeline) to render the Pulse timeline — a read",
  },
  "components/admin/approvals-queue.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports decideApproval from the admin approvals actions. Approving can write an item, but that " +
      "happens in the action; this component supplies the decision",
  },
  "components/admin/managed-gateway-approvals.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports decideManagedGatewayApproval from the admin approvals actions — the gateway half of the " +
      "same queue, same division of responsibility",
  },
  "components/admin/integrations-manager.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports the four connector sync actions, projectToGraphNow and the provider-model setters " +
      "from the integrations actions file. The connector syncs await a bounded manual context pass " +
      "inside the ACTION, not here; projectToGraphNow triggers graph projection, which ingests no " +
      "item and awaits no such pass. This surface only invokes them",
  },
  "components/admin/github-repos-panel.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports addGithubRepo / removeGithubRepo / syncGithubNow / estimateGithubImportAction from the " +
      "integrations actions file; the GitHub ingestion leg they trigger runs inside that action",
  },
  "components/admin/openrouter-panel.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports saveOpenrouter from the integrations actions file — a settings write that shares the " +
      "module with the ingestion triggers, which is why it is in the closure at all",
  },
  "components/admin/member-onboarding-panel.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports saveProvisioningSettings from the integrations actions file; provisioning settings, not " +
      "ingestion, are what this panel writes",
  },
  "components/admin/member-identities.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports addMemberEmail/removeMemberEmail from the admin members actions and renders the GitHub " +
      "and provider link controls. Identity edits, not item writes",
  },
  "components/admin/member-github-link.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports linkMemberGithub from the admin members actions — linking an identity can change future " +
      "attribution, but writes no item",
  },
  "components/admin/provider-identity-link.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports linkMemberIdentity/unlinkMemberIdentity from the admin members actions; the same " +
      "identity-edit path as the GitHub link control",
  },
  "components/admin/member-role-select.tsx": {
    class: "IMPORT_ONLY",
    reason: "imports setMemberRole from the admin members actions — a role write on the members module",
  },
  "components/admin/manager-select.tsx": {
    class: "IMPORT_ONLY",
    reason: "imports setMemberManager from the admin members actions — a reporting-line write",
  },
  "components/admin/member-provisioning-cell.tsx": {
    class: "IMPORT_ONLY",
    reason: "imports retryProvisioning from the admin members actions — provisioning retry, no ingest",
  },
  "components/admin/remove-member-button.tsx": {
    class: "IMPORT_ONLY",
    reason: "imports removeMember from the admin members actions — a membership write, no item write",
  },
  "components/admin/reset-password-button.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports resetMemberPassword from the admin members actions; it shares that module with " +
      "reattributeIdentitiesNow, which is the edge that puts it in the closure",
  },
  "components/admin/reattribute-button.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports reattributeIdentitiesNow from the admin members actions — it re-runs attribution over " +
      "EXISTING items; no item is created by pressing it",
  },
  "components/admin/attribution-health-view.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "renders MemberDrilldown and takes AttributionHealth/SourceAttribution as TYPES from " +
      "lib/attribution/health; the value edge is the drilldown component it renders",
  },
  "components/admin/member-drilldown.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports getMemberItemsAction/previewCorrectionPlanAction/applyAttributionCorrectionAction from " +
      "the admin attribution actions — an on-demand read plus the correction path, both server-side",
  },
  "components/admin/attribution-correction-box.tsx": {
    class: "IMPORT_ONLY",
    reason:
      "imports the preview/apply correction actions from the admin attribution actions file — the NL " +
      "correction box; corrections edit attribution on existing items",
  },
};
