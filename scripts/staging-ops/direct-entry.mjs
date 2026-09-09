import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is THIS module the process entry point?
 *
 * The naive spellings both fail OPEN — they answer "no" for an invocation that really is direct, so
 * the CLI body never runs and the process exits **0 having printed nothing**, which is
 * indistinguishable from a check that ran and passed:
 *
 *  - `import.meta.url === 'file://' + process.argv[1]` compares an ENCODED URL against a raw path,
 *    so any directory containing a space (or any character URL-encoding touches) never matches.
 *    `release-candidate-guard.mjs` documents that shipping once.
 *  - `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` fixes the encoding but not
 *    the SYMLINK: Node resolves a module's own path through symlinks, so a script invoked through a
 *    symlinked path compares the real file against the link and never matches.
 *
 * Resolved on both sides instead: `fileURLToPath` undoes the encoding, `realpathSync` undoes the
 * link. `path.resolve` is the fallback for a path that does not exist on disk — that cannot match a
 * real module file, so the failure stays CLOSED.
 *
 * Extracted so a second CLI cannot re-derive the fragile version; it is a helper, not a framework.
 * Callers pass their own `import.meta.url` because a shared module cannot default to the importer's.
 *
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @param {string|undefined} [entry] the process entry path, normally `process.argv[1]`
 */
export function isDirectEntry(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  const resolved = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  return resolved(fileURLToPath(moduleUrl)) === resolved(entry);
}
