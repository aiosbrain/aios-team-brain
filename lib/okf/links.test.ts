import { describe, expect, it } from "vitest";
import { extractLinks, extractTitle, resolveLink } from "@/lib/okf/links";

describe("extractLinks", () => {
  it("extracts relative .md and .yaml links, deduped", () => {
    const body = "see [a](./docs/a.md) and [b](../b.yaml) and [a again](./docs/a.md)";
    expect(extractLinks(body).sort()).toEqual(["../b.yaml", "./docs/a.md"]);
  });
  it("ignores anchors and URLs", () => {
    const body = "[x](#section) [y](https://ex.com/z.md) [ok](rel.md)";
    expect(extractLinks(body)).toEqual(["rel.md"]);
  });
  it("ignores non-md/yaml targets", () => {
    expect(extractLinks("[img](pic.png) [doc](notes.md)")).toEqual(["notes.md"]);
  });
});

describe("extractTitle", () => {
  it("returns the first H1", () => {
    expect(extractTitle("intro\n# The Title\nmore")).toBe("The Title");
  });
  it("returns null when there is no H1", () => {
    expect(extractTitle("## sub only\ntext")).toBeNull();
  });
});

describe("resolveLink", () => {
  it("resolves a sibling link", () => {
    expect(resolveLink("docs/a.md", "b.md")).toBe("docs/b.md");
  });
  it("resolves parent traversal", () => {
    expect(resolveLink("docs/sub/a.md", "../b.md")).toBe("docs/b.md");
  });
  it("normalizes current-dir segments", () => {
    expect(resolveLink("docs/a.md", "./c/d.md")).toBe("docs/c/d.md");
  });
  it("handles a root-level source", () => {
    expect(resolveLink("a.md", "b.md")).toBe("b.md");
  });
});
