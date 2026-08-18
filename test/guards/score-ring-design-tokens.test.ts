import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ScoreRing } from "@/components/codebases/score-ring";
import { PRISM } from "@/components/charts/palette";

const RAW_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb|color|device-cmyk)\s*\(/gi;
const COLOR_PROPERTY_VALUE =
  /(?:\[\s*)?["']?\b(?:color|background|background-color|backgroundColor|border|border-color|borderColor|fill|stroke)\b["']?(?:\s*\])?\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^;\n}>]*)(?=;|}|>|$))/gi;
const PAINT_ATTRIBUTE_VALUE =
  /\b(?:fill|stroke)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*([\s\S]*?)\s*\}|([^\s>]+))/gi;
const COLOR_KEYWORD =
  /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen|currentcolor|transparent|inherit|initial|revert-layer|revert|unset|none|accentcolor|accentcolortext|activeborder|activecaption|activetext|appworkspace|background|buttonborder|buttonface|buttonhighlight|buttonshadow|buttontext|canvas|canvastext|captiontext|field|fieldtext|graytext|highlight|highlighttext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|linktext|mark|marktext|menu|menutext|scrollbar|selecteditem|selecteditemtext|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|visitedtext|window|windowframe|windowtext)\b(?!\s*\()/gi;
const ALLOWED_COLOR_KEYWORDS = new Set(["currentcolor", "transparent"]);
const CSS_WIDE_KEYWORDS = new Set([
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "unset",
]);
const NON_COLOR_PAINT_KEYWORDS = new Set(["none"]);
const GOVERNED_SYSTEM_KEYWORDS = new Set(["graytext", "buttonborder"]);
const SYSTEM_KEYWORDS = new Set([
  "accentcolor",
  "accentcolortext",
  "activeborder",
  "activecaption",
  "activetext",
  "appworkspace",
  "background",
  "buttonborder",
  "buttonface",
  "buttonhighlight",
  "buttonshadow",
  "buttontext",
  "canvas",
  "canvastext",
  "captiontext",
  "field",
  "fieldtext",
  "graytext",
  "highlight",
  "highlighttext",
  "inactiveborder",
  "inactivecaption",
  "inactivecaptiontext",
  "infobackground",
  "infotext",
  "linktext",
  "mark",
  "marktext",
  "menu",
  "menutext",
  "scrollbar",
  "selecteditem",
  "selecteditemtext",
  "threeddarkshadow",
  "threedface",
  "threedhighlight",
  "threedlightshadow",
  "threedshadow",
  "visitedtext",
  "window",
  "windowframe",
  "windowtext",
]);
const UI_SOURCE_FILE = /\.(?:css|html|ts|tsx|astro|mdx|svg|js|mjs)$/;
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
const literals = (source: string) =>
  stripComments(source).match(RAW_COLOR) ?? [];
const keywordsFromValue = (value: string) => {
  if (
    /^(?:(?:dark:)?(?:text|bg|border)-[^\s]+)(?:\s+(?:dark:)?(?:text|bg|border)-[^\s]+)*$/i.test(
      value.trim(),
    )
  ) {
    return [];
  }
  return (
    value
      .replace(/\burl\(\s*(?:"[^"]*"|'[^']*'|[^)])*\)/gi, "")
      .replace(/--[\w-]+/g, "")
      .replace(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/g, "")
      .replace(/\b[a-z][\w-]*\s*(?=\()/gi, "")
      .match(COLOR_KEYWORD) ?? []
  );
};
const colorKeywords = (source: string) =>
  [
    ...[...stripComments(source).matchAll(COLOR_PROPERTY_VALUE)].flatMap(
      (match) =>
        keywordsFromValue(match[1] ?? match[2] ?? match[3] ?? match[4]),
    ),
    ...[...stripComments(source).matchAll(PAINT_ATTRIBUTE_VALUE)].flatMap(
      (match) =>
        keywordsFromValue(match[1] ?? match[2] ?? match[3] ?? match[4]),
    ),
  ].map((value) => value.toLowerCase());
const classifyColorKeywords = (source: string) => {
  const values = colorKeywords(source);
  const governedSystem = values.filter((value) =>
    GOVERNED_SYSTEM_KEYWORDS.has(value),
  );
  return {
    allowed: values.filter((value) => ALLOWED_COLOR_KEYWORDS.has(value)),
    cssWide: values.filter((value) => CSS_WIDE_KEYWORDS.has(value)),
    nonColorPaint: values.filter((value) =>
      NON_COLOR_PAINT_KEYWORDS.has(value),
    ),
    governedSystem,
    disallowed: values.filter(
      (value) =>
        !ALLOWED_COLOR_KEYWORDS.has(value) &&
        !CSS_WIDE_KEYWORDS.has(value) &&
        !NON_COLOR_PAINT_KEYWORDS.has(value) &&
        !GOVERNED_SYSTEM_KEYWORDS.has(value),
    ),
  };
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return UI_SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

describe("ScoreRing design-token contract", () => {
  test("uses canonical semantic colors and no vendored color literals", () => {
    const source = readFileSync("components/codebases/score-ring.tsx", "utf8");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    for (const token of [
      "emerald",
      "violet",
      "amber",
      "destructive",
      "border",
    ]) {
      expect(source).toContain(`var(--aios-${token})`);
    }
    expect(renderToStaticMarkup(ScoreRing({ value: 80 }))).toContain(
      'stroke="var(--aios-emerald)"',
    );
  });

  test("central chart palette exports canonical runtime colors", () => {
    const source = readFileSync("components/charts/palette.ts", "utf8");
    expect(literals(source)).toEqual([]);
    for (const token of [
      "violet",
      "accent",
      "cyan",
      "emerald",
      "amber",
      "destructive",
      "fuchsia",
      "fg-muted",
      "border",
      "shadow-overlay",
    ]) {
      expect(source).toContain(`var(--aios-${token})`);
    }
    expect(PRISM.accent).toBe("var(--aios-accent)");
  });

  test("all Brain UI raw colors are exact named provider identities", () => {
    expect(UI_SOURCE_FILE.test("index.html")).toBe(true);
    for (const mutation of [
      "#abc",
      "rgb(1 2 3)",
      "rgba(1 2 3 / .5)",
      "hsl(1 2% 3%)",
      "hsla(1 2% 3% / .5)",
      "oklch(60% .2 20)",
      "oklab(60% .2 .1)",
      "lab(60% .2 .1)",
      "lch(60% .2 20)",
      "hwb(20 30% 40%)",
      "color(display-p3 1 0 0)",
      "device-cmyk(0 1 1 0)",
    ]) {
      expect(literals(`const mutation = '${mutation}'`).length).toBeGreaterThan(
        0,
      );
    }
    expect(
      classifyColorKeywords(
        'color: currentColor; background-color: transparent; fill="none"; color: inherit; color: initial; color: unset; color: revert; color: revert-layer;',
      ),
    ).toEqual({
      allowed: ["currentcolor", "transparent"],
      cssWide: ["inherit", "initial", "unset", "revert", "revert-layer"],
      nonColorPaint: ["none"],
      governedSystem: [],
      disallowed: [],
    });
    expect(
      classifyColorKeywords(
        'const styles = { color: "GrayText", borderColor: "ButtonBorder" }',
      ).governedSystem,
    ).toEqual(["graytext", "buttonborder"]);
    expect(
      classifyColorKeywords(
        '<div style="color: GrayText; border: 1px solid ButtonBorder"><svg fill="GrayText" stroke={"ButtonBorder"} /></div>',
      ).governedSystem,
    ).toEqual(["graytext", "buttonborder", "graytext", "buttonborder"]);
    expect(
      classifyColorKeywords("color: GrayText; background: GrayText;")
        .governedSystem,
    ).toEqual(["graytext", "graytext"]);
    for (const keyword of SYSTEM_KEYWORDS) {
      const classified = classifyColorKeywords(`color: ${keyword};`);
      if (GOVERNED_SYSTEM_KEYWORDS.has(keyword)) {
        expect(classified.governedSystem).toEqual([keyword]);
        expect(classified.disallowed).toEqual([]);
      } else {
        expect(classified.governedSystem).toEqual([]);
        expect(classified.disallowed).toEqual([keyword]);
      }
    }
    for (const [mutation, expected] of [
      ["color: red;", ["red"]],
      ["background: blue;", ["blue"]],
      ["border: rebeccapurple;", ["rebeccapurple"]],
      ["background-color: CanvasText;", ["canvastext"]],
      ["border-color: ButtonFace;", ["buttonface"]],
      ["border: 1px solid red;", ["red"]],
      ["background: url(x) blue;", ["blue"]],
      ["background: url(red.svg) blue; color: var(--red);", ["blue"]],
      ["border: var(--missing, 1px solid red);", ["red"]],
      ["background: var(--missing, url(x) CanvasText);", ["canvastext"]],
      ["background: linear-gradient(red, blue);", ["red", "blue"]],
      ["<div style=color:red>", ["red"]],
      ["color: red", ["red"]],
      ["fill={`red`}", ["red"]],
      ["const style = { background: `${value} red` }", ["red"]],
      ['fill={ ok ? "red" : "blue" }', ["red", "blue"]],
      ['const style = { background: ok ? "red" : "blue" }', ["red", "blue"]],
      ['const x = { "background": "red" }', ["red"]],
      ['const x = { ["border"]: "1px solid blue" }', ["blue"]],
      ["background: theme.value red;", ["red"]],
      ["color: Palette.value blue;", ["blue"]],
      ['color: "text-ink red";', ["red"]],
      ['const style = { border: "1px solid red" }', ["red"]],
      [
        'const style = { background: "url(x) blue", border: "1px solid red" }',
        ["blue", "red"],
      ],
      ["border: 1px solid CanvasText;", ["canvastext"]],
      ['<div style="color: red; background: blue"></div>', ["red", "blue"]],
      [
        '<div style="border: 1px solid red; background: url(x) blue"></div>',
        ["red", "blue"],
      ],
      ['fill="red" stroke={"CanvasText"}', ["red", "canvastext"]],
      ["fill=red stroke=CanvasText", ["red", "canvastext"]],
      [
        'fill="var(--missing, red)" stroke=var(--missing,CanvasText)',
        ["red", "canvastext"],
      ],
      [
        'const styles = { background: "red", backgroundColor: "blue", border: "rebeccapurple", borderColor: "CanvasText", color: "ButtonFace" }',
        ["red", "blue", "rebeccapurple", "canvastext", "buttonface"],
      ],
      ["color: var(--missing-color, blue);", ["blue"]],
    ] as const) {
      expect(classifyColorKeywords(mutation).disallowed).toEqual(expected);
    }
    expect(classifyColorKeywords("background: gray(1);").disallowed).toEqual(
      [],
    );
    const found = Object.fromEntries(
      [...sourceFiles("app"), ...sourceFiles("components")]
        .map((path) => [path, literals(readFileSync(path, "utf8"))] as const)
        .filter(([, values]) => values.length > 0),
    );
    expect(found).toEqual({
      // The AIOS prism gradient on the app icon. A favicon is a fixed artwork asset —
      // it cannot resolve a runtime CSS custom property, and it must not follow the
      // page theme. Copied verbatim from @aios-alpha/design (DESIGN.md § Brand & Logo),
      // which is the only place these three stops may be authored.
      "app/icon.svg": ["#8b5cf6", "#10b981", "#84cc16"],
      "components/charts/cost-charts.tsx": ["#3b82f6"],
      "components/icons/source-icon.tsx": [
        "#5E6AD2",
        "#3f76ff",
        "#611f69",
        "#e01e5a",
        "#1868db",
        "#1a73e8",
      ],
    });
    const named = Object.fromEntries(
      [...sourceFiles("app"), ...sourceFiles("components")]
        .map(
          (path) =>
            [
              path,
              classifyColorKeywords(readFileSync(path, "utf8")).disallowed,
            ] as const,
        )
        .filter(([, values]) => values.length > 0),
    );
    expect(named).toEqual({});
    const system = Object.fromEntries(
      [...sourceFiles("app"), ...sourceFiles("components")]
        .map(
          (path) =>
            [
              path,
              classifyColorKeywords(readFileSync(path, "utf8")).governedSystem,
            ] as const,
        )
        .filter(([, values]) => values.length > 0),
    );
    expect(system).toEqual({
      "app/global-error.tsx": ["graytext", "buttonborder"],
    });
    expect(readFileSync("components/charts/cost-charts.tsx", "utf8")).toContain(
      "Governed provider-identity exception",
    );
    expect(readFileSync("components/icons/source-icon.tsx", "utf8")).toContain(
      "Governed provider-identity exceptions",
    );
  });
});
