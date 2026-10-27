"""Complete, provenance-preserving Google Docs extraction.

The LlamaHub Drive reader is retained for legacy configurations, but it does not expose
the Docs tabs contract.  This module consumes ``documents.get(includeTabsContent=true)``
responses directly and produces readable Markdown plus an explicit completeness report.
Unknown elements are disclosed without making otherwise-readable extraction incomplete;
malformed/missing required content and configured limits do make it incomplete.

Provenance. Every tab boundary in the text is a stable anchor line, ``<!-- gdrive-tab:<id> -->``,
written before the tab's title heading, so a tab is told apart from an ordinary heading and from
another tab with the same title by its Docs tab id. The tab manifest is the authoritative map from
text back to the document: per tab, where its anchor, content and end fall in the text, and per
top-level structural block (and footnote) its text span plus its position in the tab's
``body.content`` and the provider's own ``startIndex``. Offsets count Unicode code points of the
returned text. The block map is bounded; a document past the bound says so explicitly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import quote

# Block-span entries recorded per document. Past this the map is disclosed as incomplete (a
# non-blocking issue): the text itself is unaffected, and frontmatter stays bounded.
MAX_BLOCK_ENTRIES = 5000

# Every inline element kind the Docs API returns; each one's payload may carry suggestion ids.
_INLINE_KINDS = (
    "textRun", "footnoteReference", "richLink", "person", "dateElement", "inlineObjectElement",
    "autoText", "pageBreak", "columnBreak", "horizontalRule", "equation",
)


def _inline_payload(inline: dict[str, Any]) -> Any:
    """The payload of one inline element (the value under its kind key), or None if unknown."""
    for kind in _INLINE_KINDS:
        if kind in inline:
            return inline[kind]
    return None


def _proposed_insertion(payload: Any) -> bool:
    return isinstance(payload, dict) and bool(payload.get("suggestedInsertionIds"))


def _footnote_ids(node: Any) -> set[str]:
    """Every footnote id referenced anywhere under ``node`` — what a skipped proposed element
    (table, row, cell, table of contents) would have referenced."""
    found: set[str] = set()
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            ref = current.get("footnoteReference")
            fid = ref.get("footnoteId") if isinstance(ref, dict) else None
            if isinstance(fid, str) and fid.strip():
                found.add(fid)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return found


def tab_anchor(tab_id: str) -> str:
    """The text marker for one tab boundary. The id is percent-encoded (``-`` included), so an
    anchor can never close its HTML comment or be confused with another tab's."""
    return "gdrive-tab:" + quote(tab_id, safe="._~").replace("-", "%2D")


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
    # False when the bounded block map stopped recording (see ``MAX_BLOCK_ENTRIES``).
    block_map_complete: bool = True


class _Renderer:
    def __init__(self, *, max_chars: int):
        self.max_chars = max_chars
        self.parts: list[str] = []
        self.issues: list[ExtractionIssue] = []
        self.length = 0
        self.truncated = False
        self.block_entries = 0
        self.block_map_truncated = False
        # Footnotes referenced by current content, and those referenced only by a proposed insertion.
        self.referenced_footnotes: set[str] = set()
        self.proposed_footnotes: set[str] = set()

    def suggested(self, payload: Any, location: str, what: str) -> bool:
        """The canonical view is the document's CURRENT content, without proposed edits (AIO-1167
        R44 S6a). The request asks for PREVIEW_WITHOUT_SUGGESTIONS; should a suggestion still arrive on
        any element, a proposed insertion is not content yet (True: omit it, disclosed) while content
        proposed for deletion is still current (False: keep it, disclosed)."""
        if _proposed_insertion(payload):
            self.issue("suggested_insertion_omitted", location, f"proposed (unaccepted) {what} omitted")
            # Whatever footnotes the omitted element referenced are proposed with it.
            self.proposed_footnotes |= _footnote_ids(payload)
            return True
        if isinstance(payload, dict) and payload.get("suggestedDeletionIds"):
            self.issue("suggested_deletion_retained", location, f"{what} proposed for deletion is still current content")
        return False

    def record_span(self, sink: list[list[Any]] | None, entry: list[Any], location: str) -> None:
        """Append one bounded provenance span; past the bound, disclose once and stop."""
        if sink is None:
            return
        if self.block_entries >= MAX_BLOCK_ENTRIES:
            if not self.block_map_truncated:
                self.block_map_truncated = True
                self.issue("block_map_truncated", location,
                           f"block provenance recorded for the first {MAX_BLOCK_ENTRIES} blocks only")
            return
        self.block_entries += 1
        sink.append(entry)

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
        blocks: list[list[Any]] | None = None,
    ) -> None:
        """Render structural elements; with ``blocks``, record each rendered top-level element as
        ``[index in content, text start, text end, provider startIndex or None]``."""
        if not isinstance(content, list):
            self.issue("missing_content", location, "body.content is missing or malformed", True)
            return
        for index, element in enumerate(content):
            loc = f"{location}/block:{index}"
            if not isinstance(element, dict):
                self.issue("malformed_block", loc, "structural element is not an object", True)
                continue
            start = self.length
            if "paragraph" in element:
                self.render_paragraph(element["paragraph"], location=loc, footnotes=footnotes or {})
            elif "table" in element:
                self.render_table(element["table"], location=loc, footnotes=footnotes or {})
            elif "tableOfContents" in element:
                toc = element["tableOfContents"]
                if not self.suggested(toc, f"{loc}/toc", "table of contents"):
                    self.render_content(toc.get("content") if isinstance(toc, dict) else None,
                                        location=f"{loc}/toc", footnotes=footnotes)
            elif "sectionBreak" in element:
                continue
            else:
                self.issue("unsupported_element", loc, f"unsupported structural keys: {sorted(element)}")
            if self.length > start:
                provider_start = element.get("startIndex")
                self.record_span(blocks, [
                    index, start, self.length,
                    provider_start if isinstance(provider_start, int) else None,
                ], loc)

    def render_paragraph(self, paragraph: Any, *, location: str, footnotes: dict[str, Any]) -> None:
        if not isinstance(paragraph, dict):
            self.issue("malformed_paragraph", location, "paragraph is not an object", True)
            return
        elements = paragraph.get("elements")
        if not isinstance(elements, list):
            self.issue("malformed_paragraph", location, "paragraph.elements is missing", True)
            return
        # A paragraph whose every element is a proposed insertion is a proposed paragraph: nothing of
        # it — not even its heading or bullet marker — is current content (S6a).
        if elements and all(isinstance(inline, dict) and _proposed_insertion(_inline_payload(inline))
                            for inline in elements):
            for i, inline in enumerate(elements):
                payload = _inline_payload(inline)
                if isinstance(inline.get("footnoteReference"), dict):
                    self.note_proposed_footnote(payload)
                self.suggested(payload, f"{location}/inline:{i}", "paragraph content")
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
                if self.suggested(text_run, iloc, "text"):
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
                if self.suggested(ref, iloc, "footnote reference"):
                    self.note_proposed_footnote(ref)
                    continue
                self.referenced_footnotes.add(fid)
                self.add(f"[^{fid}]", iloc)
                footnote = footnotes.get(fid)
                if not isinstance(footnote, dict):
                    self.issue("missing_footnote", iloc, f"footnote {fid!r} was referenced but not returned", True)
                continue
            if "richLink" in inline:
                if not self.suggested(inline["richLink"], iloc, "rich link"):
                    self.render_rich_link(inline["richLink"], location=f"{iloc}/richLink")
                continue
            if "person" in inline:
                if not self.suggested(inline["person"], iloc, "person chip"):
                    self.render_chip_text(
                        inline["person"], "personProperties", ("name", "email"), location=f"{iloc}/person",
                        kind="person",
                    )
                continue
            if "dateElement" in inline:
                if not self.suggested(inline["dateElement"], iloc, "date chip"):
                    self.render_chip_text(
                        inline["dateElement"], "dateElementProperties", ("displayText",),
                        location=f"{iloc}/dateElement", kind="date",
                    )
                continue
            if "inlineObjectElement" in inline:
                if self.suggested(inline["inlineObjectElement"], iloc, "inline object"):
                    continue
                self.issue("unsupported_inline_object", iloc, "inline object omitted")
                self.add("[unsupported inline object]", iloc)
            else:
                self.issue("unsupported_inline", iloc, f"unsupported inline keys: {sorted(inline)}")
        if self.parts and not self.parts[-1].endswith("\n"):
            self.add("\n", location)

    def note_proposed_footnote(self, ref: Any) -> None:
        """A footnote reference that is itself a proposed insertion proposes its footnote too."""
        fid = ref.get("footnoteId") if isinstance(ref, dict) else None
        if isinstance(fid, str) and fid.strip():
            self.proposed_footnotes.add(fid)

    def render_rich_link(self, chip: Any, *, location: str) -> None:
        """A rich-link chip IS a readable link (AIO-1167 R44 C9): render the title and URI Google
        returned, never fetching the target. Without a usable returned link the required content is
        missing, so the extraction is incomplete rather than silently link-less. Only http(s) targets
        become links; another scheme keeps its title and is disclosed."""
        props = chip.get("richLinkProperties") if isinstance(chip, dict) else None
        uri = props.get("uri") if isinstance(props, dict) else None
        title = props.get("title") if isinstance(props, dict) else None
        if not isinstance(uri, str) or not uri.strip():
            self.issue("malformed_rich_link", location, "rich link has no returned URI", True)
            return
        uri = uri.strip()
        label = title.strip() if isinstance(title, str) and title.strip() else uri
        if not uri.lower().startswith(("https://", "http://")):
            self.issue("rich_link_scheme_omitted", location, "rich link target is not an http(s) URL; title kept")
            self.add(label, location)
            return
        self.add(f"[{label}]({uri})", location)

    def render_chip_text(
        self, chip: Any, properties_key: str, fields: tuple[str, ...], *, location: str, kind: str,
    ) -> None:
        """Person and date chips: their returned readable text, or a specific disclosure. Full chip
        semantics are not required content (accepted spec: disclosed unsupported elements)."""
        props = chip.get(properties_key) if isinstance(chip, dict) else None
        values = [props.get(field) for field in fields] if isinstance(props, dict) else []
        readable = [value.strip() for value in values if isinstance(value, str) and value.strip()]
        if not readable:
            self.issue(f"unsupported_{kind}_chip", location, f"{kind} chip carried no readable text")
            self.add(f"[{kind}]", location)
            return
        self.add(readable[0] if len(readable) == 1 else f"{readable[0]} <{readable[1]}>", location)

    def render_table(self, table: Any, *, location: str, footnotes: dict[str, Any]) -> None:
        if self.suggested(table, location, "table"):
            return
        rows = table.get("tableRows") if isinstance(table, dict) else None
        if not isinstance(rows, list):
            self.issue("malformed_table", location, "tableRows is missing", True)
            return
        rendered_rows: list[list[str]] = []
        for r_index, row in enumerate(rows):
            row_location = f"{location}/row:{r_index}"
            if self.suggested(row, row_location, "table row"):
                continue
            cells = row.get("tableCells") if isinstance(row, dict) else None
            if not isinstance(cells, list):
                self.issue("malformed_table_row", row_location, "tableCells is missing", True)
                continue
            rendered: list[str] = []
            for c_index, cell in enumerate(cells):
                cell_location = f"{row_location}/cell:{c_index}"
                # A proposed cell (a proposed column) is empty in the current table: keep the column
                # position so the remaining cells stay under their headers.
                if self.suggested(cell, cell_location, "table cell"):
                    rendered.append("")
                    continue
                nested = _Renderer(max_chars=max(0, self.max_chars - self.length))
                cell_content = cell.get("content") if isinstance(cell, dict) else None
                nested.render_content(cell_content, location=cell_location, footnotes=footnotes)
                self.issues.extend(nested.issues)
                self.referenced_footnotes |= nested.referenced_footnotes
                self.proposed_footnotes |= nested.proposed_footnotes
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


def _render_segments(
    renderer: _Renderer, doc_tab: dict[str, Any], segment: str, *, location: str, footnotes: dict[str, Any],
) -> list[list[Any]]:
    """Render a tab's header or footer segments (AIO-1167 R44 F2).

    `DocumentTab.headers`/`footers` are maps keyed by segment id, OUTSIDE the body: their text is
    readable content the body traversal never sees. Each segment is rendered once (sections that
    reuse a header reference the same id), in provider order, with a `[segment id, start, end]` span.
    A malformed map or segment is blocking: the document stays incomplete and retryable rather than
    reported complete without that text.
    """
    spans: list[list[Any]] = []
    if segment not in doc_tab:
        return spans
    raw = doc_tab.get(segment)
    if not isinstance(raw, dict):
        renderer.issue(f"malformed_{segment}", f"{location}/{segment}", f"present {segment} must be an object", True)
        return spans
    label = segment[:-1]
    for segment_id, value in raw.items():
        seg_location = f"{location}/{label}:{segment_id}"
        start = renderer.length
        renderer.add(f"\n<!-- {label}:{segment_id} -->\n", seg_location)
        renderer.render_content(value.get("content") if isinstance(value, dict) else None,
                                location=seg_location, footnotes=footnotes)
        renderer.record_span(spans, [str(segment_id), start, renderer.length], seg_location)
    return spans


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
        legacy_tab: dict[str, Any] = {"body": document.get("body"), "footnotes": document.get("footnotes") or {}}
        for segment in ("headers", "footers"):
            if segment in document:
                legacy_tab[segment] = document.get(segment)
        tabs = [({"tabProperties": {"tabId": "root", "title": document.get("title") or "Document"},
                  "documentTab": legacy_tab},
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
        anchor = tab_anchor(tab_id or str(order))
        entry: dict[str, Any] = {
            "id": tab_id,
            "title": title,
            "order": order,
            "parent_id": str(props.get("parentTabId") or "") or None,
            "nesting_level": props.get("nestingLevel") if isinstance(props.get("nestingLevel"), int) else 0,
            "anchor": anchor,
        }
        tab_manifest.append(entry)
        # The boundary is the anchor line, not the heading: a body heading, or another tab with the
        # same title, renders the same heading but never this tab's anchor.
        entry["text_start"] = renderer.length + 1
        renderer.add(f"\n<!-- {anchor} -->\n## {title}\n\n", location)
        entry["content_start"] = renderer.length
        blocks: list[list[Any]] = []
        footnote_spans: list[list[Any]] = []
        entry["blocks"] = blocks
        entry["footnotes"] = footnote_spans
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
                                location=location, footnotes=footnotes, blocks=blocks)
        for fid, footnote in footnotes.items():
            # A footnote only a proposed reference points to is itself proposed content (S6a).
            if fid in renderer.proposed_footnotes and fid not in renderer.referenced_footnotes:
                continue
            footnote_start = renderer.length
            renderer.add(f"\n[^{fid}]: ", f"{location}/footnote:{fid}")
            renderer.render_content(footnote.get("content") if isinstance(footnote, dict) else None,
                                    location=f"{location}/footnote:{fid}", footnotes={})
            renderer.record_span(footnote_spans, [str(fid), footnote_start, renderer.length],
                                 f"{location}/footnote:{fid}")
        for segment in ("headers", "footers"):
            entry[segment] = _render_segments(renderer, doc_tab, segment, location=location, footnotes=footnotes)
        entry["text_end"] = renderer.length

    raw = "".join(renderer.parts)
    text = raw.strip()
    # Offsets were taken against the unstripped text; rebase them onto what is returned.
    lead = len(raw) - len(raw.lstrip())

    def rebase(offset: int) -> int:
        return max(0, min(len(text), offset - lead))

    for entry in tab_manifest:
        for key in ("text_start", "content_start", "text_end"):
            entry[key] = rebase(entry[key])
        entry["blocks"] = [[index, rebase(start), rebase(end), provider]
                           for index, start, end, provider in entry["blocks"]]
        entry["footnotes"] = [[fid, rebase(start), rebase(end)] for fid, start, end in entry["footnotes"]]
        for segment in ("headers", "footers"):
            entry[segment] = [[sid, rebase(start), rebase(end)] for sid, start, end in entry.get(segment, [])]

    complete = bool(tab_manifest) and not any(issue.blocking for issue in renderer.issues)
    return DocsExtraction(text, complete, tab_manifest, renderer.issues,
                          block_map_complete=not renderer.block_map_truncated)
