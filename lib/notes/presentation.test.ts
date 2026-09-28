import { describe, expect, it } from "vitest";
import { noteTitle } from "./presentation";

describe("stored note title presentation", () => {
  it("preserves accepted whitespace, line endings, Unicode and literal markup", () => {
    const title = "  <script>literal</script>\r\nCafe\u0301 📝  ";
    expect(noteTitle("note", { title })).toBe(title);
  });

  it.each([null, undefined, {}, { title: [] }, { title: "" }, { title: " \t\r\n" }])(
    "falls back to the item path when no usable title is stored: %j",
    (frontmatter) => expect(noteTitle("note", frontmatter)).toBeNull(),
  );

  it("does not change existing item kinds or interpret a frontmatter kind as authority", () => {
    expect(noteTitle("deliverable", { kind: "note", title: "Caller marker" })).toBeNull();
    expect(noteTitle("future-kind", { title: "Future" })).toBeNull();
  });
});
