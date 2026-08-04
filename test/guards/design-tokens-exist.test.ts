import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A colour class that names an UNDEFINED design token renders nothing — silently.
 *
 * The failure this exists for: the admin "cheap model for simple graph calls" card shipped using
 * `text-muted`, `bg-surface` and `border-line/60`. None is a token in `app/globals.css`, Tailwind
 * emits no rule for them, TypeScript can't see them, and no test rendered the component — so the
 * card's help paragraph, both of its status lines and its border were **invisible in production**.
 * The user saw a title, a blank gap and an input.
 *
 * Precisely (an earlier draft of this file got it wrong): the inert-state warning used `text-amber`,
 * which IS a defined token, so that line would have rendered. What vanished was the muted text.
 *
 * SCOPE IS DELIBERATELY NARROW. It checks the files this bug touched — the admin integrations
 * surface — rather than the whole app, because a repo-wide sweep surfaces pre-existing undefined
 * tokens (`text-ink-subtle`, `bg-surface-sunken`) in several other components. Those are real and
 * worth fixing, but silently widening this guard would turn one bug's lesson into an unrelated
 * red build. Widen the file list deliberately, with the fixes.
 */

const TOKENS = (() => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  return new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
})();

/** Tailwind's built-in palette families and non-colour values that share the prefixes. */
const BUILT_IN = new Set([
  "white", "black", "transparent", "current", "inherit",
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime",
  "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
]);
/**
 * `text-xs`, `border-t`, `bg-gradient-prism` (an explicit `.class` in globals.css), etc.
 *
 * FULLY ANCHORED, and that is not tidiness. An earlier version left these prefix-matched, so the
 * single-letter `l` (from `border-l`) matched the START of `line` — and `border-line/60`, the actual
 * class from the bug this guard exists for, sailed through green. A guard that cannot catch its own
 * originating bug is decoration.
 */
const NON_COLOUR = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl",
  "left", "right", "center", "justify", "start", "end", "top", "bottom",
  "balance", "pretty", "nowrap", "wrap", "clip", "ellipsis",
  "mono", "sans", "serif", "thin", "light", "normal", "medium", "semibold", "bold",
  "solid", "dashed", "dotted", "hidden", "none", "auto", "full", "screen", "fit", "min", "max",
  "px", "b", "t", "l", "r", "x", "y", "gradient-prism",
]);
const isNonColour = (base: string) =>
  NON_COLOUR.has(base) ||
  /^\d+$/.test(base) ||
  base.startsWith("[") ||
  // `border-t-0`, `border-x-2` — a side plus a width, not a colour at all.
  /^(?:b|t|l|r|x|y|s|e)-\d+$/.test(base);

const FILES = ["components/admin/integrations-manager.tsx"];

describe("design tokens referenced by the admin integrations surface actually exist", () => {
  it("globals.css yields a non-trivial token set (guard is not vacuous)", () => {
    expect(TOKENS.size).toBeGreaterThan(10);
    for (const t of ["ink", "ink-secondary", "border-subtle", "violet"]) expect(TOKENS.has(t)).toBe(true);
    // The tokens the bug invented must NOT be present — otherwise this guard proves nothing.
    for (const t of ["muted", "surface", "line"]) expect(TOKENS.has(t)).toBe(false);
  });

  for (const rel of FILES) {
    it(`${rel} uses only defined colour tokens`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const bad: string[] = [];
      // Only look inside className="..." so prose in comments/strings can't trip it.
      // Both quoted and template-literal classNames — the file uses each, and a bug hiding in a
      // template literal is no less invisible than one in a quoted string.
      const chunks = [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].map((m) => m[1] ?? m[2]);
      for (const chunk of chunks) {
        for (const raw of chunk.split(/\s+/)) {
          // Strip variant prefixes (`focus:`, `dark:`, `hover:md:`…) — a bad token behind one is
          // just as dead as a bare one.
          const cls = raw.replace(/^(?:[a-z-]+:)+/, "");
          // …and allow an opacity modifier. Without this the guard misses `border-line/60`, which is
          // the ACTUAL class from the bug it was written for — the reason to mutate with the real
          // shape rather than a convenient one.
          const hit = /^(?:text|bg|border)-([a-z][a-z0-9-]*)(?:\/[0-9.]+)?$/.exec(cls);
          if (!hit) continue;
          const base = hit[1];
          if (TOKENS.has(base) || BUILT_IN.has(base.split("-")[0]) || isNonColour(base)) continue;
          bad.push(cls);
        }
      }
      expect(bad, `undefined design tokens (they render as nothing): ${bad.join(", ")}`).toEqual([]);
    });
  }
});
