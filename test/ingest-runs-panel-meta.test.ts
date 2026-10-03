import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMetaValue, IngestRunsPanel } from "@/components/admin/ingest-runs-panel";
import type { IngestRunRow } from "@/lib/ingest/runs";

// GRAPHSAT-1 (Codex design round 2 H2): the runs panel rendered object meta values as `[object Object]`
// — `partialDetail` already did, and `deepRequeueSample` is a list of structured identities.
describe("RunMeta value formatting", () => {
  it("renders objects and arrays as compact JSON, scalars as before", () => {
    expect(formatMetaValue({ g: 2 })).toBe('{"g":2}');
    expect(formatMetaValue([{ itemId: "i" }])).toBe('[{"itemId":"i"}]');
    expect(formatMetaValue(3)).toBe("3");
    expect(formatMetaValue("x")).toBe("x");
    expect(formatMetaValue(false)).toBe("false");
  });
});

/**
 * AUDITFIX-25 (AIO-1062) AC08 — the failed-row disclosure, at the CONSUMER.
 *
 * The panel rendered metadata only when a row had no errors (`errors.length > 0 ? error : meta`), so
 * the one row that has something to disclose showed none of it. It now keeps the error AND adds a
 * closed native `<details>` for a recognized version-1 envelope on a non-NULL `access_bootstrap` row.
 *
 * These envelopes are FABRICATED on purpose: this file owns what the decoder must REFUSE (malformed,
 * oversized, future, mismatched, healthy-shaped) and what it must never dump. The normal states are
 * proven end to end — real producer → jsonb → reader → this panel — in
 * `test/datamechanics/bootstrap-evidence.datamechanics.test.ts`; a fabricated envelope alone is not
 * acceptance evidence for those.
 */

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const G1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const G2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const AT = "2026-10-03T07:00:00.000Z";
/** U+202E RIGHT-TO-LEFT OVERRIDE, from its code point so the source carries no invisible control. */
const RLO = String.fromCodePoint(0x202e);

const CENSUS_MESSAGE = "23 unsanctioned edge(s) on system projects: general→vendors, legacy-system→contr…";
const CONVERGENCE_MESSAGE = "general: wedged";
const COMPOUND = `census: ${CENSUS_MESSAGE}; convergence: ${CONVERGENCE_MESSAGE}`;

type Envelope = Record<string, unknown>;

/** A consistent version-1 envelope: 23 findings, two sampled, 21 omitted. */
function envelope(over: Envelope = {}): Envelope {
  return {
    version: 1,
    teamId: TEAM,
    convergence: { status: "failed", error: { message: CONVERGENCE_MESSAGE, truncated: false } },
    census: { status: "complete", total: 23, error: { message: CENSUS_MESSAGE, truncated: true } },
    sample: [
      { projectId: P1, groupId: G1, projectSlug: '<script>alert("p")</script>', groupSlug: "vendors & 'friends'", projectSlugTruncated: false, groupSlugTruncated: false },
      { projectId: P2, groupId: G2, projectSlug: `${"x".repeat(93)}…`, groupSlug: `${RLO}evil-rtl`, projectSlugTruncated: true, groupSlugTruncated: false },
    ],
    omitted: 21,
    ...over,
  };
}

function run(over: Partial<Omit<IngestRunRow, "meta">> & { meta?: unknown } = {}): IngestRunRow {
  return {
    id: 1,
    team_id: TEAM,
    source: "access_bootstrap",
    trigger: "scheduler",
    ok: false,
    created: 0,
    updated: 0,
    unchanged: 0,
    error_count: 1,
    errors: [COMPOUND],
    meta: {},
    started_at: AT,
    finished_at: AT,
    duration_ms: 5,
    ...over,
  } as IngestRunRow;
}

const evidenceRun = (over: Envelope = {}) => run({ meta: { accessBootstrapEvidence: envelope(over) } });

function render(runs: IngestRunRow[]) {
  const html = renderToStaticMarkup(IngestRunsPanel({ runs }));
  const text = (fragment: string) => fragment.replace(/<[^>]+>/g, " ");
  const blocks = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].map((m) => ({
    attrs: m[1],
    html: m[2],
    text: text(m[2]),
    summary: text(/<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(m[2])?.[1] ?? ""),
  }));
  return { html, blocks };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Tag-stripped text with its whitespace collapsed, so a phrase can be matched across elements. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** The panel's OWN census statement: what follows its `Census:` label, up to the stored reason. The
 *  reason repeats the count head (`23 unsanctioned edge(s) …`) and must not stand in for a label. */
const censusStatement = (text: string) => /Census:\s*(.*?)(?:\s—\s|$)/.exec(squash(text))?.[1] ?? "";

/** The pre-existing failed-row presentation: pill, 120-character preview, full error as the title. */
function expectLegacyErrorPresentation(html: string, error: string): void {
  expect(html).toContain("failed (1)");
  expect(html, "the short error preview").toContain(escapeHtml(error.slice(0, 120)));
  expect(html, "the full error as the title").toContain(`title="${escapeHtml(error)}"`);
}

describe("AUDITFIX-25 AC08: a failed access_bootstrap row discloses its typed evidence beside its error", () => {
  it("keeps the error and ADDS a closed <details> with exact counts, ids and sampled labels", () => {
    const { html, blocks } = render([evidenceRun()]);

    expectLegacyErrorPresentation(html, COMPOUND);
    // The base's error-versus-meta ternary renders nothing more for a row that has errors.
    expect(blocks, "one disclosure for the one evidence row").toHaveLength(1);
    expect(blocks[0].attrs, "closed by default").not.toMatch(/\bopen\b/);
    expect(blocks[0].summary, "a concise Evidence summary").toMatch(/evidence/i);
    expect(blocks[0].text, "phase status is shown for both phases").toMatch(/convergence/i);
    expect(blocks[0].text).toMatch(/census/i);
    expect(blocks[0].text, "the exact full count").toMatch(/\b23\b/);
    expect(blocks[0].text, "and the omitted count").toMatch(/\b21\b/);
    expect(blocks[0].text, "samples are labelled as samples, never as the complete set").toMatch(/sample/i);
    for (const id of [P1, G1, P2, G2]) expect(blocks[0].text, "exact UUID identities").toContain(id);
    expect(blocks[0].text, "an available census never reads as unavailable").not.toMatch(/unavailable/i);
  });

  it("renders hostile names as escaped React text — never markup, never a command", () => {
    const { html, blocks } = render([evidenceRun()]);

    expect(blocks).toHaveLength(1);
    expect(html, "no raw element from a slug").not.toContain("<script");
    expect(blocks[0].html).toContain("&lt;script&gt;alert(&quot;p&quot;)&lt;/script&gt;");
    expect(blocks[0].html).toContain("vendors &amp; &#x27;friends&#x27;");
    expect(html, "no HTML injection sink").not.toMatch(/dangerouslySetInnerHTML|__html/);
    // Display labels are not exact repair commands, and the panel must not compose one from them.
    expect(blocks[0].text).not.toMatch(/repair-system-edge|admin\.ts|npx|--actor/);
  });

  it("isolates each display label's direction from the UUID beside it", () => {
    const { blocks } = render([evidenceRun()]);

    expect(blocks).toHaveLength(1);
    // A slug is attacker-influenced text sitting next to an identifier an operator will copy: an RLO
    // in the label must not be able to reorder the UUID. `<bdi>`, `dir`, or `unicode-bidi: isolate`.
    const label = blocks[0].html.indexOf("evil-rtl");
    expect(label, "the RTL-override label is rendered").toBeGreaterThan(-1);
    const opening = blocks[0].html.slice(blocks[0].html.lastIndexOf("<", label), label);
    expect(opening, "its own element isolates it").toMatch(/^<bdi\b|\bdir="(auto|ltr|rtl)"|unicode-bidi:\s*isolate/);
  });

  it("makes every shortening VISIBLE: a truncated flag changes what is rendered", () => {
    const sample = (projectSlugTruncated: boolean) => [
      { projectId: P1, groupId: G1, projectSlug: `${"x".repeat(93)}…`, groupSlug: "vendors", projectSlugTruncated, groupSlugTruncated: false },
    ];
    const census = (truncated: boolean) => ({ status: "complete", total: 23, error: { message: CENSUS_MESSAGE, truncated } });
    const flagged = render([evidenceRun({ sample: sample(true), omitted: 22 })]).blocks;
    const unflagged = render([evidenceRun({ sample: sample(false), omitted: 22 })]).blocks;
    const errorFlagged = render([evidenceRun({ census: census(true) })]).blocks;
    const errorUnflagged = render([evidenceRun({ census: census(false) })]).blocks;

    for (const b of [flagged, unflagged, errorFlagged, errorUnflagged]) expect(b).toHaveLength(1);
    // The copy is not pinned; that a flag is rendered at all is. Identical labels, different flags.
    expect(flagged[0].html, "a shortened display slug carries an indicator").not.toBe(unflagged[0].html);
    expect(errorFlagged[0].html, "a shortened phase error carries an indicator").not.toBe(errorUnflagged[0].html);
  });

  it("says a sample is every finding of the tick ONLY when nothing was omitted", () => {
    const TWO = "2 unsanctioned edge(s) on system projects: general→vendors, legacy-system→contractors";
    const complete = render([evidenceRun({ census: { status: "complete", total: 2, error: { message: TWO, truncated: false } }, omitted: 0 })]).blocks;
    const partial = render([evidenceRun()]).blocks;
    for (const b of [complete, partial]) expect(b).toHaveLength(1);

    // omitted = 0: the two sampled findings ARE the tick's findings. "Not the complete set" was false here.
    expect(squash(complete[0].text)).toMatch(/Sample — 2 of 2, all findings for this tick/);
    expect(complete[0].text, "a complete sample is not called partial").not.toMatch(/not the complete set/i);
    expect(censusStatement(complete[0].text), "the total, on its own label").toMatch(/\b2 unsanctioned edges\b/);
    expect(censusStatement(complete[0].text), "the sampled count, on its own label").toMatch(/\b2 sampled\b/);
    expect(censusStatement(complete[0].text), "and nothing omitted, on its own label").toMatch(/\b0 omitted\b/);

    // omitted > 0: the same two samples beside 21 more findings are NOT everything.
    expect(squash(partial[0].text)).toMatch(/Sample — 2 of 23, not the complete set/);
    expect(partial[0].text, "a partial sample never claims completeness").not.toMatch(/all findings/i);
    expect(censusStatement(partial[0].text)).toMatch(/\b23 unsanctioned edges\b/);
    expect(censusStatement(partial[0].text)).toMatch(/\b2 sampled\b/);
    expect(censusStatement(partial[0].text)).toMatch(/\b21 omitted\b/);
  });

  it("a sample trimmed to nothing makes neither claim: the counts alone say what was left out", () => {
    const { blocks } = render([evidenceRun({ sample: [], omitted: 23 })]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toMatch(/all findings|not the complete set/i);
    expect(censusStatement(blocks[0].text)).toMatch(/\b23 unsanctioned edges\b/);
    expect(censusStatement(blocks[0].text)).toMatch(/\b0 sampled\b/);
    expect(censusStatement(blocks[0].text)).toMatch(/\b23 omitted\b/);
  });

  it("puts the table in ONE labelled, keyboard-focusable region, ahead of the native Evidence toggle", () => {
    const { html } = render([evidenceRun(), run({ id: 2, source: "pm_sync", ok: true, error_count: 0, errors: [], meta: { provider: "linear" } })]);

    // Semantics a keyboard and a screen reader depend on. Whether the region actually scrolls and
    // the content actually fits is a BROWSER observation (AC11), not something markup can prove.
    const regions = [...html.matchAll(/<div\b([^>]*\brole="region"[^>]*)>/g)];
    expect(regions, "one region for the whole table, not one per row").toHaveLength(1);
    expect(regions[0].index, "the region is the panel's root").toBe(0);
    expect(regions[0][1]).toContain('aria-label="Recent runs"');
    expect(regions[0][1], "a tab stop, so the keyboard can scroll what does not fit").toContain('tabindex="0"');
    expect(html.endsWith("</table></div>"), "the table is the region's content").toBe(true);

    const summary = /<summary\b([^>]*)>/.exec(html);
    expect(summary, "the disclosure toggle is still a native summary").not.toBeNull();
    expect(summary!.index, "reached after the region, in document order").toBeGreaterThan(html.indexOf("<table"));
    expect(summary![1], "with the browser's own focus and Enter/Space handling").not.toMatch(/tabindex|role=/);
    expect((html.match(/tabindex=/g) ?? []).length, "and no other tab stop is added").toBe(1);
  });

  it("renders every validated label and reason IN FULL — long unbroken text is left to wrap, never cut here", () => {
    const LABEL = `${"x".repeat(93)}…`; // a 96-byte display label with no break opportunity
    const REASON = `general:${"w".repeat(213)}`; // a 221-byte reason with none either
    const { blocks } = render([
      evidenceRun({
        convergence: { status: "failed", error: { message: REASON, truncated: false } },
        sample: [{ projectId: P1, groupId: G1, projectSlug: LABEL, groupSlug: LABEL, projectSlugTruncated: true, groupSlugTruncated: true }],
        omitted: 22,
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text, "the whole reason").toContain(REASON);
    expect(blocks[0].text.split(LABEL), "both whole labels").toHaveLength(3);
    expect(blocks[0].text, "the whole project UUID").toContain(P1);
    expect(blocks[0].text, "the whole group UUID").toContain(G1);
    expect(censusStatement(blocks[0].text), "and the counts").toMatch(/\b23 unsanctioned edges\b.*\b1 sampled\b.*\b22 omitted\b/);
  });

  it("an error longer than the preview keeps its 120-character preview, its cue and its full title", () => {
    const long = `linear 500: ${"e".repeat(300)}`;
    const { html, blocks } = render([run({ source: "pm_sync", trigger: "manual", errors: [long, "second error"], error_count: 2, meta: { provider: "linear" } })]);

    expect(blocks).toEqual([]);
    expect(html).toContain("failed (2)");
    expect(html, "exactly the first 120 characters, then the cue").toMatch(new RegExp(`>${long.slice(0, 120)}(<!-- -->)?…</span>`));
    expect(html, "every error, in full, as the title").toContain(`title="${long}\nsecond error"`);
    expect(html.split(long), "the full text is the title ONLY — the cell shows the preview").toHaveLength(2);
  });

  it("says UNAVAILABLE for a failed census — an unknown count is never shown as zero", () => {
    const { html, blocks } = render([
      run({
        errors: ["census: failed: census exploded"],
        meta: {
          accessBootstrapEvidence: {
            version: 1,
            teamId: TEAM,
            convergence: { status: "ok" },
            census: { status: "failed", total: null, error: { message: "failed: census exploded", truncated: false } },
            sample: [],
            omitted: null,
          },
        },
      }),
    ]);

    expectLegacyErrorPresentation(html, "census: failed: census exploded");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toMatch(/unavailable/i);
    expect(blocks[0].text, "no invented zero beside a count label").not.toMatch(
      /\b0\s+(unsanctioned|findings?|edges?|omitted)|(total|omitted|findings?|edges?)\D{0,12}\b0\b/i
    );
    expect(blocks[0].text).not.toMatch(/null|undefined|NaN/);
  });

  it("decodes a LEGACY JSON-string meta identically to the object form", () => {
    const meta = { accessBootstrapEvidence: envelope() };
    const fromObject = render([run({ meta })]);
    const fromString = render([run({ meta: JSON.stringify(meta) })]);

    expect(fromObject.blocks).toHaveLength(1);
    // An explicit legacy JSON-string FIXTURE: it exercises the decoder's compatibility branch, and
    // claims nothing about what the current adapter returns.
    expect(fromString.blocks, "the legacy JSON-string fixture is recognized too").toHaveLength(1);
    expect(fromString.html).toBe(fromObject.html);
  });

  it("projects only known fields: unknown envelope and sibling keys are never rendered", () => {
    const { html, blocks } = render([
      run({
        meta: {
          accessBootstrapEvidence: envelope({
            stack: "UNKNOWN-ENVELOPE-FIELD-MARKER",
            sample: [
              { projectId: P1, groupId: G1, projectSlug: "general", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false, sql: "UNKNOWN-SAMPLE-FIELD-MARKER" },
            ],
            omitted: 22,
          }),
          threw: "SIBLING-META-MARKER",
        },
      }),
    ]);

    expect(blocks, "known fields still disclose").toHaveLength(1);
    for (const marker of ["UNKNOWN-ENVELOPE-FIELD-MARKER", "UNKNOWN-SAMPLE-FIELD-MARKER", "SIBLING-META-MARKER"]) {
      expect(html, `arbitrary failed-row metadata must not be dumped: ${marker}`).not.toContain(marker);
    }
  });

  // ── What the decoder must REFUSE ────────────────────────────────────────────────────────────────
  //
  // Every one of these falls back to the existing error presentation: no disclosure, and nothing of
  // the rejected payload rendered. Each envelope carries the marker in a field that WOULD be shown.

  const MARKER = "REJECTED-ENVELOPE-MARKER";
  const marked = (over: Envelope = {}) =>
    envelope({
      sample: [{ projectId: P1, groupId: G1, projectSlug: MARKER, groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false }],
      omitted: 22,
      ...over,
    });
  const markedSample = (over: Record<string, unknown>) => [
    { projectId: P1, groupId: G1, projectSlug: MARKER, groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false, ...over },
  ];

  it.each<{ name: string; row: () => IngestRunRow }>([
    { name: "a FUTURE version", row: () => run({ meta: { accessBootstrapEvidence: marked({ version: 2 }) } }) },
    { name: "a version of the wrong type", row: () => run({ meta: { accessBootstrapEvidence: marked({ version: "1" }) } }) },
    { name: "an envelope naming ANOTHER team", row: () => run({ meta: { accessBootstrapEvidence: marked({ teamId: OTHER_TEAM }) } }) },
    { name: "an envelope on a NULL-team row", row: () => run({ team_id: null, meta: { accessBootstrapEvidence: marked() } }) },
    { name: "an envelope on another source's row", row: () => run({ source: "pm_sync", meta: { accessBootstrapEvidence: marked() } }) },
    { name: "an envelope on the fleet-liveness source", row: () => run({ source: "access_bootstrap_all", meta: { accessBootstrapEvidence: marked() } }) },
    { name: "an unparseable string meta", row: () => run({ meta: `{"accessBootstrapEvidence": {"sample": "${MARKER}"` }) },
    {
      // Well-formed and otherwise valid — refused on SIZE alone, before any parse.
      name: "a string meta above 8,192 UTF-8 bytes",
      row: () => run({ meta: JSON.stringify({ accessBootstrapEvidence: marked(), padding: "p".repeat(8192) }) }),
    },
    { name: "an envelope that is not an object", row: () => run({ meta: { accessBootstrapEvidence: [MARKER] } }) },
    { name: "a null envelope", row: () => run({ meta: { accessBootstrapEvidence: null } }) },
    { name: "a sample that is not an array", row: () => run({ meta: { accessBootstrapEvidence: marked({ sample: { 0: MARKER, length: 1 } }) } }) },
    {
      name: "more than sixteen samples",
      row: () =>
        run({
          meta: {
            accessBootstrapEvidence: marked({
              census: { status: "complete", total: 40, error: { message: CENSUS_MESSAGE, truncated: true } },
              sample: Array.from({ length: 17 }, () => markedSample({})[0]),
              omitted: 23,
            }),
          },
        }),
    },
    { name: "a display slug above 96 UTF-8 bytes", row: () => run({ meta: { accessBootstrapEvidence: marked({ sample: markedSample({ groupSlug: "g".repeat(97) }) }) } }) },
    { name: "a sample id that is not a UUID", row: () => run({ meta: { accessBootstrapEvidence: marked({ sample: markedSample({ groupId: "not-a-uuid" }) }) } }) },
    { name: "a truncation flag of the wrong type", row: () => run({ meta: { accessBootstrapEvidence: marked({ sample: markedSample({ groupSlugTruncated: "no" }) }) } }) },
    { name: "an omitted count that is not total − sample.length", row: () => run({ meta: { accessBootstrapEvidence: marked({ omitted: 0 }) } }) },
    { name: "a non-integer total", row: () => run({ meta: { accessBootstrapEvidence: marked({ census: { status: "complete", total: 23.5, error: { message: CENSUS_MESSAGE, truncated: true } } }) } }) },
    {
      name: "a FAILED census claiming a numeric total",
      row: () => run({ meta: { accessBootstrapEvidence: marked({ census: { status: "failed", total: 0, error: { message: MARKER, truncated: false } }, sample: [], omitted: 0 }) } }),
    },
    {
      name: "a failed census carrying samples",
      row: () => run({ meta: { accessBootstrapEvidence: marked({ census: { status: "failed", total: null, error: { message: "failed", truncated: false } }, omitted: null }) } }),
    },
    { name: "a failed convergence with no error object", row: () => run({ meta: { accessBootstrapEvidence: marked({ convergence: { status: "failed" } }) } }) },
    { name: "findings with no census error object", row: () => run({ meta: { accessBootstrapEvidence: marked({ census: { status: "complete", total: 23 } }) } }) },
    { name: "an unknown phase status", row: () => run({ meta: { accessBootstrapEvidence: marked({ convergence: { status: "degraded", error: { message: MARKER, truncated: false } } }) } }) },
    {
      // The producer NEVER emits this: a wholly clean state is ok with no evidence at all.
      name: "a fabricated healthy complete-zero envelope",
      row: () =>
        run({
          meta: {
            accessBootstrapEvidence: {
              version: 1,
              teamId: TEAM,
              convergence: { status: "ok" },
              census: { status: "complete", total: 0 },
              sample: [],
              omitted: 0,
              note: MARKER,
            },
          },
        }),
    },
  ])("rejects $name and keeps the existing error presentation", ({ row }) => {
    const { html, blocks } = render([row()]);

    expect(blocks, "no evidence disclosure for an unrecognized envelope").toEqual([]);
    expect(html, "and nothing of the rejected payload is rendered").not.toContain(MARKER);
    expectLegacyErrorPresentation(html, COMPOUND);
  });

  // ── Unchanged presentation ──────────────────────────────────────────────────────────────────────

  it("an older failed row keeps its presentation and its metadata stays undisclosed", () => {
    const legacy = "census: 2 unsanctioned edge(s) on system projects: general→vendors +1 more";
    const { html, blocks } = render([run({ errors: [legacy], meta: { threw: "LEGACY-FAILED-META-MARKER", teams: 3 } })]);

    expectLegacyErrorPresentation(html, legacy);
    expect(blocks).toEqual([]);
    // The control for "dump arbitrary failed metadata": a failed row's unrecognized meta stays hidden.
    expect(html).not.toContain("LEGACY-FAILED-META-MARKER");
  });

  it("the builder-fault fallback row — a fixed named error and NO evidence — stays legacy-readable", () => {
    const fallback = "census: 3 unsanctioned edge(s) on system projects (evidence unavailable); convergence: failed (evidence unavailable)";
    const { html, blocks } = render([run({ errors: [fallback], meta: {} })]);

    expectLegacyErrorPresentation(html, fallback);
    expect(blocks, "there is no envelope to disclose").toEqual([]);
  });

  it("the shared pm_sync consumer is untouched: successful RunMeta and failed rows render as before", () => {
    const { html, blocks } = render([
      run({ id: 1, source: "pm_sync", trigger: "api", ok: true, error_count: 0, errors: [], created: 2, updated: 1, meta: { provider: "linear", projected: 3, detail: { skipped: 1 } } }),
      run({ id: 2, source: "pm_sync", trigger: "manual", ok: false, errors: ["linear 401: token revoked"], meta: { provider: "linear" } }),
      run({ id: 3, team_id: null, source: "access_bootstrap_all", ok: true, error_count: 0, errors: [], meta: { teams: 2, failedTeams: 1, fleetOk: true } }),
      run({ id: 4, ok: true, error_count: 0, errors: [], meta: {} }),
    ]);

    expect(blocks, "no disclosure on any of them").toEqual([]);
    expect(html, "successful RunMeta is the compact key: value list").toContain("provider: linear · projected: 3 · detail: {&quot;skipped&quot;:1}");
    expect(html).toContain("teams: 2 · failedTeams: 1 · fleetOk: true");
    expect(html, "an ok row with empty meta still shows the dash").toContain("<span>—</span>");
    expect(html, "the failed pm_sync row shows its error").toContain('title="linear 401: token revoked"');
    expect(html, "and not its metadata").not.toMatch(/token revoked<\/span>[^<]*provider: linear/);
    expect((html.match(/provider: linear/g) ?? []).length, "provider appears once — on the successful row only").toBe(1);
    expect(html).toContain("+2 ~1");
  });

  it("a mixed panel discloses ONLY the recognized row", () => {
    const { blocks, html } = render([
      evidenceRun(),
      run({ id: 2, meta: { accessBootstrapEvidence: marked({ teamId: OTHER_TEAM }) } }),
      run({ id: 3, source: "pm_sync", ok: true, error_count: 0, errors: [], meta: { provider: "plane" } }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain(P2);
    expect(html).not.toContain(MARKER);
    expect(html).toContain("provider: plane");
  });
});
