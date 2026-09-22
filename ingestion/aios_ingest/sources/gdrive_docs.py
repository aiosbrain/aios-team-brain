"""Complete, provenance-preserving Google Docs extraction.

The LlamaHub Drive reader is retained for legacy configurations, but it does not expose
the Docs tabs contract.  This module consumes ``documents.get(includeTabsContent=true)``
responses directly and produces readable Markdown plus an explicit completeness report.
Unknown elements are disclosed without making otherwise-readable extraction incomplete;
malformed/missing required content and configured limits do make it incomplete.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable


@dataclass(frozen=True)
class ExtractionIssue:
    code: str
    location: str
    detail: str
    blocking: bool = False


@dataclass(frozen=True)
class DocsExtraction:
    text: str
    complete: bool
    tabs: list[dict[str, Any]]
    issues: list[ExtractionIssue] = field(default_factory=list)


class _Renderer:
    def __init__(self, *, max_chars: int):
        self.max_chars = max_chars
        self.parts: list[str] = []
        self.issues: list[ExtractionIssue] = []
        self.length = 0
        self.truncated = False

    def add(self, text: str, location: str) -> None:
        if not text or self.truncated:
            return
        remaining = self.max_chars - self.length
        if remaining <= 0:
            self.truncated = True
            self.issue("limit_exceeded", location, f"document exceeded {self.max_chars} characters", True)
            return
        if len(text) > remaining:
            self.parts.append(text[:remaining])
            self.length += remaining
            self.truncated = True
            self.issue("limit_exceeded", location, f"document exceeded {self.max_chars} characters", True)
            return
        self.parts.append(text)
        self.length += len(text)

    def issue(self, code: str, location: str, detail: str, blocking: bool = False) -> None:
        self.issues.append(ExtractionIssue(code, location, detail, blocking))

    def render_content(
        self,
        content: Any,
        *,
        location: str,
        footnotes: dict[str, Any] | None = None,
    ) -> None:
        if not isinstance(content, list):
            self.issue("missing_content", location, "body.content is missing or malformed", True)
            return
        for index, element in enumerate(content):
            loc = f"{location}/block:{index}"
            if not isinstance(element, dict):
                self.issue("malformed_block", loc, "structural element is not an object", True)
                continue
            if "paragraph" in element:
                self.render_paragraph(element["paragraph"], location=loc, footnotes=footnotes or {})
            elif "table" in element:
                self.render_table(element["table"], location=loc, footnotes=footnotes or {})
            elif "tableOfContents" in element:
                toc = element["tableOfContents"]
                self.render_content(toc.get("content") if isinstance(toc, dict) else None,
                                    location=f"{loc}/toc", footnotes=footnotes)
            elif "sectionBreak" in element:
                continue
            else:
                self.issue("unsupported_element", loc, f"unsupported structural keys: {sorted(element)}")

    def render_paragraph(self, paragraph: Any, *, location: str, footnotes: dict[str, Any]) -> None:
        if not isinstance(paragraph, dict):
            self.issue("malformed_paragraph", location, "paragraph is not an object", True)
            return
        style = paragraph.get("paragraphStyle") or {}
        named = str(style.get("namedStyleType") or "")
        heading = {f"HEADING_{n}": "#" * n for n in range(1, 7)}.get(named)
        if heading:
            self.add(f"{heading} ", location)
        bullet = paragraph.get("bullet")
        if isinstance(bullet, dict):
            level = bullet.get("nestingLevel", 0)
            level = level if isinstance(level, int) and level >= 0 else 0
            self.add(f"{'  ' * level}- ", location)
        elements = paragraph.get("elements")
        if not isinstance(elements, list):
            self.issue("malformed_paragraph", location, "paragraph.elements is missing", True)
            return
        for i, inline in enumerate(elements):
            iloc = f"{location}/inline:{i}"
            if not isinstance(inline, dict):
                self.issue("malformed_inline", iloc, "inline element is not an object", True)
                continue
            if "textRun" in inline:
                text_run = inline["textRun"]
                if not isinstance(text_run, dict):
                    self.issue(
                        "malformed_text_run", f"{iloc}/textRun",
                        "recognized textRun must be an object", True,
                    )
                    continue
                text = text_run.get("content")
                if not isinstance(text, str):
                    self.issue(
                        "malformed_text", f"{iloc}/textRun/content",
                        "textRun.content is missing or not a string", True,
                    )
                    continue
                link = (text_run.get("textStyle") or {}).get("link")
                url = link.get("url") if isinstance(link, dict) else None
                clean = text.rstrip("\n")
                suffix = text[len(clean):]
                self.add(f"[{clean}]({url}){suffix}" if url and clean else text, iloc)
                continue
            if "footnoteReference" in inline:
                ref = inline["footnoteReference"]
                if not isinstance(ref, dict):
                    self.issue(
                        "malformed_footnote_reference", f"{iloc}/footnoteReference",
                        "recognized footnoteReference must be an object", True,
                    )
                    continue
                fid = ref.get("footnoteId")
                if not isinstance(fid, str) or not fid.strip():
                    self.issue(
                        "malformed_footnote_id", f"{iloc}/footnoteReference/footnoteId",
                        "footnoteReference.footnoteId is missing or not a non-empty string", True,
                    )
                    continue
                self.add(f"[^{fid}]", iloc)
                footnote = footnotes.get(fid)
                if not isinstance(footnote, dict):
                    self.issue("missing_footnote", iloc, f"footnote {fid!r} was referenced but not returned", True)
                continue
            if "inlineObjectElement" in inline:
                self.issue("unsupported_inline_object", iloc, "inline object omitted")
                self.add("[unsupported inline object]", iloc)
            else:
                self.issue("unsupported_inline", iloc, f"unsupported inline keys: {sorted(inline)}")
        if self.parts and not self.parts[-1].endswith("\n"):
            self.add("\n", location)

    def render_table(self, table: Any, *, location: str, footnotes: dict[str, Any]) -> None:
        rows = table.get("tableRows") if isinstance(table, dict) else None
        if not isinstance(rows, list):
            self.issue("malformed_table", location, "tableRows is missing", True)
            return
        rendered_rows: list[list[str]] = []
        for r_index, row in enumerate(rows):
            cells = row.get("tableCells") if isinstance(row, dict) else None
            if not isinstance(cells, list):
                self.issue("malformed_table_row", f"{location}/row:{r_index}", "tableCells is missing", True)
                continue
            rendered: list[str] = []
            for c_index, cell in enumerate(cells):
                nested = _Renderer(max_chars=max(0, self.max_chars - self.length))
                cell_content = cell.get("content") if isinstance(cell, dict) else None
                nested.render_content(cell_content, location=f"{location}/row:{r_index}/cell:{c_index}", footnotes=footnotes)
                self.issues.extend(nested.issues)
                rendered.append(" ".join("".join(nested.parts).strip().splitlines()).replace("|", "\\|"))
            rendered_rows.append(rendered)
        if not rendered_rows:
            return
        width = max(len(row) for row in rendered_rows)
        padded = [row + [""] * (width - len(row)) for row in rendered_rows]
        self.add("| " + " | ".join(padded[0]) + " |\n", location)
        self.add("| " + " | ".join(["---"] * width) + " |\n", location)
        for row in padded[1:]:
            self.add("| " + " | ".join(row) + " |\n", location)
        self.add("\n", location)


def _walk_tabs(
    tabs: Iterable[Any], renderer: _Renderer, *, location: str
) -> Iterable[tuple[dict[str, Any], str]]:
    for index, tab in enumerate(tabs):
        tab_location = f"{location}/{index}"
        if not isinstance(tab, dict):
            renderer.issue("malformed_tab", tab_location, "tab is not an object", True)
            continue
        yield tab, tab_location
        if "childTabs" not in tab:
            continue
        children = tab.get("childTabs")
        if not isinstance(children, list):
            renderer.issue(
                "malformed_child_tabs", f"{tab_location}/childTabs",
                "present childTabs must be a list", True,
            )
            continue
        yield from _walk_tabs(children, renderer, location=f"{tab_location}/childTabs")


def extract_google_doc(document: dict[str, Any], *, max_chars: int = 2_000_000) -> DocsExtraction:
    """Render every root/child tab in provider order from a Docs API response."""
    renderer = _Renderer(max_chars=max_chars)
    tabs_supplied = "tabs" in document
    tabs_raw = document.get("tabs")
    tab_manifest: list[dict[str, Any]] = []
    if tabs_supplied:
        if not isinstance(tabs_raw, list):
            renderer.issue("malformed_tabs", "document/tabs", "supplied tabs must be a list", True)
            tabs: list[tuple[dict[str, Any], str]] = []
        elif not tabs_raw:
            renderer.issue("missing_tabs", "document/tabs", "supplied tabs is empty", True)
            tabs = []
        else:
            tabs = list(_walk_tabs(tabs_raw, renderer, location="document/tabs"))
    else:
        # Legacy single-tab responses remain readable, but a response explicitly requested with
        # includeTabsContent should normally carry tabs. The fallback applies only when the field is
        # absent; a supplied null/scalar/empty value is malformed and must never hide behind root body.
        renderer.issue("legacy_root_body", "document", "Docs response contained no tabs; used root body")
        tabs = [({"tabProperties": {"tabId": "root", "title": document.get("title") or "Document"},
                  "documentTab": {"body": document.get("body"), "footnotes": document.get("footnotes") or {}}},
                 "document/root")]

    for order, (tab, supplied_location) in enumerate(tabs):
        raw_props = tab.get("tabProperties")
        if not isinstance(raw_props, dict):
            renderer.issue(
                "malformed_tab_properties", f"{supplied_location}/tabProperties",
                "tabProperties is missing or not an object", True,
            )
            props: dict[str, Any] = {}
        else:
            props = raw_props
        tab_id = str(props.get("tabId") or "")
        title = str(props.get("title") or f"Tab {order + 1}")
        location = f"{supplied_location}/tab:{tab_id or order}"
        if not tab_id:
            renderer.issue("missing_tab_id", location, "tab id is missing", True)
        doc_tab = tab.get("documentTab")
        if not isinstance(doc_tab, dict):
            renderer.issue("missing_tab_content", location, "documentTab is missing", True)
            continue
        tab_manifest.append({
            "id": tab_id,
            "title": title,
            "order": order,
            "parent_id": str(props.get("parentTabId") or "") or None,
            "nesting_level": props.get("nestingLevel") if isinstance(props.get("nestingLevel"), int) else 0,
        })
        renderer.add(f"\n## {title}\n\n", location)
        footnotes_supplied = "footnotes" in doc_tab
        raw_footnotes = doc_tab.get("footnotes")
        if footnotes_supplied and not isinstance(raw_footnotes, dict):
            renderer.issue(
                "malformed_footnotes", f"{location}/footnotes",
                "present footnotes must be an object", True,
            )
            footnotes: dict[str, Any] = {}
        else:
            footnotes = raw_footnotes or {}
        body = doc_tab.get("body")
        renderer.render_content(body.get("content") if isinstance(body, dict) else None,
                                location=location, footnotes=footnotes)
        for fid, footnote in footnotes.items():
            renderer.add(f"\n[^{fid}]: ", f"{location}/footnote:{fid}")
            renderer.render_content(footnote.get("content") if isinstance(footnote, dict) else None,
                                    location=f"{location}/footnote:{fid}", footnotes={})

    complete = bool(tab_manifest) and not any(issue.blocking for issue in renderer.issues)
    return DocsExtraction("".join(renderer.parts).strip(), complete, tab_manifest, renderer.issues)
