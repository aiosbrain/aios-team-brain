import { describe, expect, it, vi } from "vitest";
import { buildBootstrapEvidence, decodeBootstrapEvidence, extractBootstrapFailureMessage } from "@/lib/access/bootstrap-evidence";

/**
 * AUDITFIX-25 (AIO-1062) — accepted spec v3.2, the PURE half: the typed builder, the guarded message
 * extraction and the fail-closed decoder. No database, no ledger, no panel.
 *
 * ⚠️ `lib/access/bootstrap-evidence` does not exist yet and this file imports it STATICALLY, on
 * purpose. Until the module lands the whole file is a missing-module COLLECTION red. That red is
 * recorded separately from the behavioural reds the page/panel unit files and the real-ledger file
 * already produce — those deliberately do not import the module, so this file cannot take them down.
 *
 * Expected values are the spec's literal contracts: spelled-out strings, byte counts from its budget
 * list, and tables transcribed from its state/extraction tables. The helpers below only MEASURE (UTF-8
 * bytes, the serialized wrapper) or ORDER (a plain full sort of the tuple); none is the production
 * module's, and no expectation is a snapshot of its output. Where a fixture's arithmetic matters, the
 * fixture asserts it first (`fixture: …`) so a miscounted fixture reads as that, not as a product red.
 *
 * NOT here, by design: the caller's third guard and its fixed no-evidence fallback. That belongs to
 * `ensureAccessBootstrapAllTeams` and is pinned on the real ledger path by mocking this module's
 * ordinary builder export — the builder itself has no fault flag to test.
 */

// ── Reference contract (spec §Typed contract and budgets) ────────────────────────────────────────

type PhaseError = { message: string; truncated: boolean };
type Sample = {
  projectId: string;
  groupId: string;
  projectSlug: string;
  groupSlug: string;
  projectSlugTruncated: boolean;
  groupSlugTruncated: boolean;
};
type Evidence = {
  version: 1;
  teamId: string;
  convergence: { status: "ok" | "failed"; error?: PhaseError };
  census: { status: "complete" | "failed"; total: number | null; error?: PhaseError };
  sample: Sample[];
  omitted: number | null;
};
type Edge = { projectId: string; projectSlug: string; groupId: string; groupSlug: string };
/** The builder's input: FULL safe-extracted messages and the RAW finding edges — never a summary. */
type Input = {
  teamId: string;
  convergence: { status: "ok" } | { status: "failed"; message: string };
  census: { status: "complete"; edges: readonly Edge[] } | { status: "failed"; message: string };
};
type Failed = { ok: false; error: string; evidence: Evidence };
type Built = { ok: true } | Failed;
type Failure = { kind: "returned"; result: unknown } | { kind: "thrown"; value: unknown };
type Row = { source: unknown; team_id: unknown; ok: unknown; meta: unknown };

const BUDGET = {
  metaBytes: 8192,
  samples: 16,
  slugBytes: 96,
  compoundBytes: 480,
  armReserve: 224,
  dualPool: 457, // 480 − `census: ` (8) − `; convergence: ` (15)
  loneCensus: 472, // 480 − `census: `
  loneConvergence: 467, // 480 − `convergence: `
  writerClampChars: 500, // lib/ingest/runs MAX_ERROR_CHARS — must never bite
} as const;
/** U+FFFD, built from its code point so the source never carries a literal replacement character. */
const REPLACEMENT = String.fromCodePoint(0xfffd);
const head = (n: number) => `${n} unsanctioned edge(s) on system projects: `;

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const pid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
const gid = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;
const pad2 = (i: number) => String(i).padStart(2, "0");

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** The measured wrapper is the WHOLE namespace object — its key and braces included. */
const wrapperBytes = (evidence: unknown) => bytes(JSON.stringify({ accessBootstrapEvidence: evidence }));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Full tuple order — slugs first, IDs breaking ties. A whole-array sort is fine in a test. */
const byTuple = (a: Edge, b: Edge) =>
  cmp(a.projectSlug, b.projectSlug) || cmp(a.groupSlug, b.groupSlug) || cmp(a.projectId, b.projectId) || cmp(a.groupId, b.groupId);
/** The sample entry of an edge whose slugs need neither normalizing nor shortening. */
const plain = (e: Edge): Sample => ({
  projectId: e.projectId,
  groupId: e.groupId,
  projectSlug: e.projectSlug,
  groupSlug: e.groupSlug,
  projectSlugTruncated: false,
  groupSlugTruncated: false,
});
const compound = (e: Evidence) =>
  [e.census.error ? `census: ${e.census.error.message}` : null, e.convergence.error ? `convergence: ${e.convergence.error.message}` : null]
    .filter((s): s is string => s !== null)
    .join("; ");

/** A fixed permutation of 0..19 — neither sorted nor reversed. */
const SHUFFLE_20 = [13, 2, 19, 7, 0, 16, 5, 11, 9, 18, 3, 14, 1, 17, 6, 10, 4, 15, 8, 12];
const shuffled = <T>(xs: readonly T[]): T[] => SHUFFLE_20.map((i) => xs[i]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const build = (input: Input): Built => buildBootstrapEvidence(input) as Built;

/** Relationships every failed result must satisfy, whatever its inputs were. */
function expectInvariants({ error, evidence: e }: Failed): void {
  expect(e.version).toBe(1);
  expect(error, "the compound IS the labelled arms the evidence carries").toBe(compound(e));
  expect(bytes(error), "compound error ≤ 480 UTF-8 bytes").toBeLessThanOrEqual(BUDGET.compoundBytes);
  expect(error.length, "and inside the writer's 500-character clamp").toBeLessThanOrEqual(BUDGET.writerClampChars);
  expect(wrapperBytes(e), "JSON.stringify({accessBootstrapEvidence}) ≤ 8,192 bytes").toBeLessThanOrEqual(BUDGET.metaBytes);
  expect(e.convergence.error !== undefined, "a failed phase carries its error; a clean one omits it").toBe(e.convergence.status === "failed");
  expect(e.sample.length).toBeLessThanOrEqual(BUDGET.samples);
  if (e.census.status === "failed") {
    expect(e.census.total, "unavailable is never zero").toBeNull();
    expect(e.omitted).toBeNull();
    expect(e.sample).toEqual([]);
    expect(e.census.error).toBeDefined();
  } else {
    expect(Number.isInteger(e.census.total)).toBe(true);
    expect(e.omitted, "omitted = total − sample.length").toBe((e.census.total as number) - e.sample.length);
    expect(e.census.error !== undefined, "findings carry the census summary; zero findings carry none").toBe((e.census.total as number) > 0);
  }
  expect(e.convergence.error !== undefined || e.census.error !== undefined, "a wholly healthy state has no envelope").toBe(true);
  const strings = [error, e.convergence.error?.message, e.census.error?.message, ...e.sample.flatMap((s) => [s.projectSlug, s.groupSlug])];
  for (const s of strings) {
    if (s === undefined) continue;
    expect(s.isWellFormed(), "no isolated surrogate survives").toBe(true);
    expect(s.includes("\u0000"), "no NUL survives").toBe(false);
  }
  for (const s of e.sample) {
    expect(bytes(s.projectSlug), "display slug ≤ 96 bytes including its cue").toBeLessThanOrEqual(BUDGET.slugBytes);
    expect(bytes(s.groupSlug)).toBeLessThanOrEqual(BUDGET.slugBytes);
  }
}

function failed(input: Input): Failed {
  const built = build(input);
  if (built.ok) throw new Error("expected a failed result carrying evidence, got { ok: true }");
  expectInvariants(built);
  return built;
}

const census = (edges: readonly Edge[]): Input["census"] => ({ status: "complete", edges });
const loneCensus = (edges: readonly Edge[]): Input => ({ teamId: TEAM, convergence: { status: "ok" }, census: census(edges) });
const loneConvergence = (message: string): Input => ({ teamId: TEAM, convergence: { status: "failed", message }, census: census([]) });

const WEDGED = "general: wedged";
/** What the real adoption refusal reads like (lib/access/groups + the bootstrap's slug prefix). */
const REFUSAL =
  "general: refusing to adopt 'general': it already carries unsanctioned grant(s) to vendors-and-contractors-emea. " +
  "Promoting it would turn those into grants over the whole system corpus. The team stays " +
  "un-bootstrapped until the edge is removed (repair: AUDITFIX-21).";

// ── The exact-boundary fixture, shared by the builder and the decoder ────────────────────────────
//
// Twenty findings on one enormous control-character project, so the census arm is cut inside the
// FIRST project slug and no group slug can change it. Group 00 is plain ASCII of a chosen length
// (one serialized byte per character); every other group is `NN` plus control characters (six
// serialized bytes each). Calibrating those two lengths lands the six-sample wrapper on exactly
// 8,192 bytes — and one more `a` on 8,193.

const BOUNDARY_TOTAL = 20;
const BOUNDARY_KEEP = 6;
const BOUNDARY_PROJECT = `!${"\u0001".repeat(600)}`;
const BOUNDARY_PROJECT_DISPLAY = `!${"\u0001".repeat(92)}…`;
const BOUNDARY_MESSAGE = `${head(BOUNDARY_TOTAL)}!${"\u0001".repeat(BUDGET.loneCensus - bytes(head(BOUNDARY_TOTAL)) - 1 - 3)}…`;
const boundaryGroup = (i: number, heavy: number, filler: number) =>
  i === 0 ? `00${"a".repeat(filler)}` : `${pad2(i)}${"\u0001".repeat(heavy)}`;

function boundaryInput(heavy: number, filler: number): Input {
  const edges = Array.from({ length: BOUNDARY_TOTAL }, (_, i) => ({
    projectId: pid(1),
    projectSlug: BOUNDARY_PROJECT,
    groupId: gid(i),
    groupSlug: boundaryGroup(i, heavy, filler),
  }));
  return loneCensus(shuffled(edges));
}

/** The expected envelope holding the first `keep` ordered samples — built from literals alone. */
function boundaryCandidate(heavy: number, filler: number, keep: number): Evidence {
  return {
    version: 1,
    teamId: TEAM,
    convergence: { status: "ok" },
    census: { status: "complete", total: BOUNDARY_TOTAL, error: { message: BOUNDARY_MESSAGE, truncated: true } },
    sample: Array.from({ length: keep }, (_, i) => ({
      projectId: pid(1),
      groupId: gid(i),
      projectSlug: BOUNDARY_PROJECT_DISPLAY,
      groupSlug: boundaryGroup(i, heavy, filler),
      projectSlugTruncated: true,
      groupSlugTruncated: false,
    })),
    omitted: BOUNDARY_TOTAL - keep,
  };
}

/** Lengths (each slug stays ≤ 96 bytes, so no display is shortened) that hit 8,192 exactly. */
function calibrateBoundary(): { heavy: number; filler: number } {
  for (let heavy = 0; heavy <= 94; heavy++) {
    const filler = BUDGET.metaBytes - wrapperBytes(boundaryCandidate(heavy, 0, BOUNDARY_KEEP));
    // ≤ 93 leaves room for the one extra `a` of the 8,193-byte neighbour.
    if (filler >= 0 && filler <= 93) return { heavy, filler };
  }
  throw new Error("fixture: no calibration puts six samples on exactly 8,192 bytes");
}

// ── State table ──────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC01/AC02 (pure): the state table, spelled out", () => {
  const general: Edge = { projectId: pid(1), projectSlug: "general", groupId: gid(1), groupSlug: "vendors" };
  const externalShared: Edge = { projectId: pid(2), projectSlug: "external-shared", groupId: gid(1), groupSlug: "vendors" };

  it("wholly clean phases return EXACTLY { ok: true } — no evidence, no error, no undefined placeholders", () => {
    const built = buildBootstrapEvidence({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "complete", edges: [] } });

    // The caller spreads teamId onto this; the pre-existing clean outcome is exactly { teamId, ok: true }.
    expect(built).toStrictEqual({ ok: true });
    expect(Object.keys(built), "not even an undefined-valued evidence/error key").toEqual(["ok"]);
  });

  it.each<{ name: string; input: Input; error: string; evidence: Evidence }>([
    {
      name: "convergence failed + census complete with ZERO findings → convergence only, a KNOWN zero",
      input: { teamId: TEAM, convergence: { status: "failed", message: WEDGED }, census: census([]) },
      error: "convergence: general: wedged",
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: "general: wedged", truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    },
    {
      name: "convergence ok + census complete with findings → census summary only",
      input: { teamId: TEAM, convergence: { status: "ok" }, census: census([general]) },
      error: "census: 1 unsanctioned edge(s) on system projects: general→vendors",
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "ok" },
        census: { status: "complete", total: 1, error: { message: "1 unsanctioned edge(s) on system projects: general→vendors", truncated: false } },
        sample: [{ projectId: pid(1), groupId: gid(1), projectSlug: "general", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false }],
        omitted: 0,
      },
    },
    {
      name: "convergence failed + census complete with findings → BOTH arms, census first",
      input: { teamId: TEAM, convergence: { status: "failed", message: WEDGED }, census: census([externalShared]) },
      error: "census: 1 unsanctioned edge(s) on system projects: external-shared→vendors; convergence: general: wedged",
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: "general: wedged", truncated: false } },
        census: { status: "complete", total: 1, error: { message: "1 unsanctioned edge(s) on system projects: external-shared→vendors", truncated: false } },
        sample: [{ projectId: pid(2), groupId: gid(1), projectSlug: "external-shared", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false }],
        omitted: 0,
      },
    },
    {
      name: "convergence ok + census FAILED → the census reason, counts UNAVAILABLE (never zero)",
      input: { teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: "failed: census exploded" } },
      error: "census: failed: census exploded",
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "ok" },
        census: { status: "failed", total: null, error: { message: "failed: census exploded", truncated: false } },
        sample: [],
        omitted: null,
      },
    },
    {
      name: "convergence failed + census FAILED → both reasons, counts unavailable",
      input: { teamId: TEAM, convergence: { status: "failed", message: WEDGED }, census: { status: "failed", message: "system-edge census threw: census exploded" } },
      error: "census: system-edge census threw: census exploded; convergence: general: wedged",
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: "general: wedged", truncated: false } },
        census: { status: "failed", total: null, error: { message: "system-edge census threw: census exploded", truncated: false } },
        sample: [],
        omitted: null,
      },
    },
  ])("$name", ({ input, error, evidence }) => {
    const built = build(input);

    // Strict: a clean phase OMITS `error` rather than carrying an undefined one.
    expect(built).toStrictEqual({ ok: false, error, evidence });
    expectInvariants(built as Failed);
  });

  it("forty findings: the count is the FULL count, sixteen are sampled, twenty-four are omitted", () => {
    const edges = Array.from({ length: 40 }, (_, i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(i), groupSlug: `g${pad2(i)}` }));
    const message = `40 unsanctioned edge(s) on system projects: ${edges.slice(0, 16).map((e) => `sys→${e.groupSlug}`).join(", ")}`;
    expect(bytes(message), "fixture: sixteen short pairs fit the lone census arm whole").toBeLessThanOrEqual(BUDGET.loneCensus);

    // Descending input: taking the first sixteen as they arrive would sample g39..g24.
    const built = failed(loneCensus([...edges].reverse()));

    expect(built).toStrictEqual({
      ok: false,
      error: `census: ${message}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "ok" },
        census: { status: "complete", total: 40, error: { message, truncated: false } },
        sample: edges.slice(0, 16).map(plain),
        omitted: 24,
      },
    });
    expect(built.error, "the seventeenth pair is never named, and nothing promises a remainder").not.toMatch(/g16|\+\d+ more/);
  });

  it("the same forty findings beside a convergence failure keep the full count in BOTH the head and the evidence", () => {
    const edges = Array.from({ length: 40 }, (_, i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(i), groupSlug: `g${pad2(i)}` }));
    const message = `40 unsanctioned edge(s) on system projects: ${edges.slice(0, 16).map((e) => `sys→${e.groupSlug}`).join(", ")}`;
    expect(bytes(message), "fixture: the summary fits its 224-byte reservation whole").toBeLessThanOrEqual(BUDGET.armReserve);

    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: WEDGED }, census: census(shuffled(edges.slice(0, 20)).concat(edges.slice(20))) });

    expect(built.error).toBe(`census: ${message}; convergence: general: wedged`);
    expect(built.evidence.census).toStrictEqual({ status: "complete", total: 40, error: { message, truncated: false } });
    expect(built.evidence.convergence).toStrictEqual({ status: "failed", error: { message: "general: wedged", truncated: false } });
    expect(built.evidence.sample).toStrictEqual(edges.slice(0, 16).map(plain));
    expect(built.evidence.omitted).toBe(24);
  });
});

// ── Deterministic samples ────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC05 (pure): the sample is the first 16 by FULL normalized tuple, whatever order the edges arrive in", () => {
  it("equal slug pairs tie-break on projectId, then groupId — and are NOT deduplicated", () => {
    const edges: Edge[] = [
      { projectId: pid(3), projectSlug: "dup", groupId: gid(1), groupSlug: "dup" },
      { projectId: pid(1), projectSlug: "dup", groupId: gid(9), groupSlug: "dup" },
      { projectId: pid(1), projectSlug: "dup", groupId: gid(2), groupSlug: "dup" },
      { projectId: pid(2), projectSlug: "dup", groupId: gid(5), groupSlug: "dup" },
    ];

    const built = failed(loneCensus(edges));

    expect(built.evidence.sample.map((s) => [s.projectId, s.groupId])).toEqual([
      [pid(1), gid(2)],
      [pid(1), gid(9)],
      [pid(2), gid(5)],
      [pid(3), gid(1)],
    ]);
    expect(built.evidence.census.total).toBe(4);
    expect(built.evidence.omitted).toBe(0);
    expect(built.error, "four findings, four pairs").toBe("census: 4 unsanctioned edge(s) on system projects: dup→dup, dup→dup, dup→dup, dup→dup");
  });

  it("two findings identical in every field are still two findings", () => {
    const twin: Edge = { projectId: pid(1), projectSlug: "general", groupId: gid(1), groupSlug: "vendors" };

    const built = failed(loneCensus([twin, { ...twin }]));

    expect(built.evidence.census.total).toBe(2);
    expect(built.evidence.sample).toStrictEqual([plain(twin), plain(twin)]);
    expect(built.evidence.omitted).toBe(0);
  });

  it("slugs that differ only PAST the 96-byte display cut still order — and are selected — by the full slug", () => {
    const COMMON = "x".repeat(120); // every display of these is the same 96 bytes
    const edges: Edge[] = Array.from({ length: 20 }, (_, i) =>
      i < 10
        ? // Ten equal pairs whose projectId DEscends as the index AScends.
          { projectId: pid(100 - i), projectSlug: "dup-project", groupId: gid(i), groupSlug: "dup-group" }
        : // Ten long slugs whose suffix DEscends as the id AScends: id order and input order are both wrong.
          { projectId: pid(1), projectSlug: "legacy-system", groupId: gid(i), groupSlug: `${COMMON}-${29 - i}` }
    );
    // Ten equal pairs by ascending projectId (index 9..0), then the six smallest FULL slugs (suffix 10..15 ⇒ index 19..14).
    const order = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 19, 18, 17, 16, 15, 14];
    const cutDisplay = `${"x".repeat(93)}…`;
    const want: Sample[] = order.map((i) =>
      i < 10
        ? plain(edges[i])
        : { projectId: pid(1), groupId: gid(i), projectSlug: "legacy-system", groupSlug: cutDisplay, projectSlugTruncated: false, groupSlugTruncated: true }
    );

    const forward = failed(loneCensus(edges));
    const reversed = failed(loneCensus([...edges].reverse()));
    const scrambled = failed(loneCensus(shuffled(edges)));

    expect(forward.evidence.sample).toStrictEqual(want);
    expect(reversed, "permuted input, identical result").toStrictEqual(forward);
    expect(scrambled).toStrictEqual(forward);
    expect(forward.evidence.census.total).toBe(20);
    expect(forward.evidence.omitted).toBe(4);
    expect(new Set(forward.evidence.sample.slice(10).map((s) => s.groupSlug)).size, "their displays are IDENTICAL — truncation cannot have ordered them").toBe(1);
    // The summary is cut from FULL normalized pairs, not from the 96-byte display labels.
    const message = forward.evidence.census.error!.message;
    const dupPairs = Array.from({ length: 10 }, () => "dup-project→dup-group").join(", ");
    expect(message.startsWith(`${head(20)}${dupPairs}, legacy-system→${COMMON}-10, legacy-system→x`), "the whole 123-byte slug is named").toBe(true);
    expect(forward.evidence.census.error!.truncated).toBe(true);
    expect(bytes(message), "an ASCII tail fills the lone arm exactly, cue included").toBe(BUDGET.loneCensus);
    expect(message.endsWith("…")).toBe(true);
  });

  it("the comparison is plain JavaScript string order — not locale, not numeric collation", () => {
    const projects = ["alpha", "Zeta", "9", "_under", "10"].map((slug, i) => ({ projectId: pid(i), projectSlug: slug, groupId: gid(1), groupSlug: "g" }));
    const groups = ["b", "B", "a"].map((slug, i) => ({ projectId: pid(50), projectSlug: "zz-groups", groupId: gid(10 + i), groupSlug: slug }));

    const built = failed(loneCensus([...projects, ...groups]));

    expect(built.evidence.sample.map((s) => `${s.projectSlug}→${s.groupSlug}`)).toEqual([
      "10→g",
      "9→g",
      "Zeta→g",
      "_under→g",
      "alpha→g",
      "zz-groups→B",
      "zz-groups→a",
      "zz-groups→b",
    ]);
  });

  it("slugs are normalized BEFORE they are ordered", () => {
    // Raw, the NUL slug sorts first and the lone surrogate before U+E000. Normalized, both become
    // a?b with U+FFFD — after `aab` and after U+E000 — and tie, so the IDs decide between them.
    const edges: Edge[] = [
      { projectId: pid(9), projectSlug: "a\u0000b", groupId: gid(1), groupSlug: "g" },
      { projectId: pid(1), projectSlug: "aab", groupId: gid(1), groupSlug: "g" },
      { projectId: pid(3), projectSlug: "a\uD83Db", groupId: gid(1), groupSlug: "g" },
      { projectId: pid(2), projectSlug: "ab", groupId: gid(1), groupSlug: "g" },
    ];

    const built = failed(loneCensus(edges));

    expect(built.evidence.sample.map((s) => [s.projectSlug, s.projectId])).toEqual([
      ["aab", pid(1)],
      ["ab", pid(2)],
      [`a${REPLACEMENT}b`, pid(3)],
      [`a${REPLACEMENT}b`, pid(9)],
    ]);
  });

  it("seventeen findings: the smallest arriving LAST is sampled, the largest arriving FIRST is not", () => {
    const slug = (i: number) => `g${pad2(i)}`;
    const arrival = [16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0];
    const edges = arrival.map((i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(i), groupSlug: slug(i) }));

    const built = failed(loneCensus(edges));

    expect(built.evidence.sample.map((s) => s.groupSlug)).toEqual(Array.from({ length: 16 }, (_, i) => slug(i)));
    expect(built.evidence.census.total).toBe(17);
    expect(built.evidence.omitted).toBe(1);
  });

  it("exactly sixteen findings are all sampled, with nothing omitted", () => {
    const edges = Array.from({ length: 16 }, (_, i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(i), groupSlug: `g${pad2(i)}` }));

    const built = failed(loneCensus([...edges].reverse()));

    expect(built.evidence.sample).toStrictEqual(edges.map(plain));
    expect(built.evidence.census.total).toBe(16);
    expect(built.evidence.omitted).toBe(0);
  });

  it("never mutates its input: deeply FROZEN edges build, and the caller's array keeps its order", () => {
    const make = (): Input => ({
      teamId: TEAM,
      convergence: { status: "failed", message: WEDGED },
      census: census(shuffled(Array.from({ length: 20 }, (_, i) => ({ projectId: pid(i), projectSlug: `p\u0000${pad2(i)}`, groupId: gid(i), groupSlug: "g".repeat(120) })))),
    });
    const frozen = deepFreeze(make());
    const loose = make();

    // An in-place sort, or writing a normalized/shortened slug back onto an edge, throws here.
    const fromFrozen = failed(frozen);
    const fromLoose = failed(loose);

    expect(loose, "the caller's edges are untouched — order, slugs and all").toStrictEqual(make());
    expect(fromFrozen).toStrictEqual(fromLoose);
    expect(fromFrozen.evidence.sample).toHaveLength(16);
  });

  it("five thousand tied and scattered findings: the sixteen kept are exactly the head of a full sort", () => {
    // A fixed-seed generator, so the case is identical on every run. This pins WHICH sixteen a bounded
    // top-k must keep; it makes no memory or timing claim (the census still materializes every edge).
    let state = 25;
    const next = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * n);
    };
    const edges: Edge[] = Array.from({ length: 5000 }, (_, i) => ({
      projectId: pid(next(40)),
      projectSlug: `p-${next(6)}`,
      groupId: gid(i),
      groupSlug: `g-${next(300)}`,
    }));
    const first = [...edges].sort(byTuple).slice(0, 16);
    const message = `5000 unsanctioned edge(s) on system projects: ${first.map((e) => `${e.projectSlug}→${e.groupSlug}`).join(", ")}`;
    expect(new Set(first.map((e) => `${e.projectSlug}→${e.groupSlug}`)).size, "fixture: the head of the order contains slug ties").toBeLessThan(16);

    const built = failed(loneCensus(edges));

    expect(built.evidence.sample).toStrictEqual(first.map(plain));
    expect(built.evidence.census).toStrictEqual({ status: "complete", total: 5000, error: { message, truncated: false } });
    expect(built.evidence.omitted).toBe(4984);
  });
});

// ── Display slugs ────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC04 (pure): every display slug is ≤ 96 UTF-8 bytes, cut on a code point, with a truthful flag", () => {
  it.each<{ name: string; slug: string; display: string; truncated: boolean }>([
    { name: "96 ASCII bytes are kept whole", slug: "s".repeat(96), display: "s".repeat(96), truncated: false },
    { name: "97 ASCII bytes become 93 + the cue", slug: "s".repeat(97), display: `${"s".repeat(93)}…`, truncated: true },
    { name: "48 two-byte characters (96 bytes) are kept whole", slug: "é".repeat(48), display: "é".repeat(48), truncated: false },
    { name: "49 two-byte characters (98 bytes, 49 characters) are cut to 46 + the cue", slug: "é".repeat(49), display: `${"é".repeat(46)}…`, truncated: true },
    { name: "24 non-BMP characters (96 bytes) are kept whole", slug: "😀".repeat(24), display: "😀".repeat(24), truncated: false },
    { name: "25 non-BMP characters are cut to 23 whole pairs + the cue", slug: "😀".repeat(25), display: `${"😀".repeat(23)}…`, truncated: true },
    { name: "a cut that lands exactly on a pair boundary fills all 96 bytes", slug: `a${"😀".repeat(24)}`, display: `a${"😀".repeat(23)}…`, truncated: true },
    { name: "a cut that would split a pair stops BEFORE it", slug: `ab${"😀".repeat(24)}`, display: `ab${"😀".repeat(22)}…`, truncated: true },
    { name: "a short slug that itself ends in an ellipsis is NOT flagged", slug: "ends-with-an-ellipsis…", display: "ends-with-an-ellipsis…", truncated: false },
    { name: "the budget is UTF-8 bytes, not serialized bytes: 96 control characters are kept whole", slug: "\u0001".repeat(96), display: "\u0001".repeat(96), truncated: false },
    { name: "32 NULs normalize to 96 bytes of U+FFFD — replaced, not shortened, not flagged", slug: "\u0000".repeat(32), display: REPLACEMENT.repeat(32), truncated: false },
    { name: "33 NULs are measured AFTER normalization (99 bytes) and cut", slug: "\u0000".repeat(33), display: `${REPLACEMENT.repeat(31)}…`, truncated: true },
    { name: "33 isolated high surrogates likewise", slug: "\uD83D".repeat(33), display: `${REPLACEMENT.repeat(31)}…`, truncated: true },
  ])("$name", ({ slug, display, truncated }) => {
    expect(bytes(display), "fixture: the expected display fits the budget").toBeLessThanOrEqual(BUDGET.slugBytes);

    const built = failed(loneCensus([{ projectId: pid(1), projectSlug: slug, groupId: gid(1), groupSlug: slug }]));

    expect(built.evidence.sample).toStrictEqual([
      { projectId: pid(1), groupId: gid(1), projectSlug: display, groupSlug: display, projectSlugTruncated: truncated, groupSlugTruncated: truncated },
    ]);
  });

  it("the two flags are independent, and the UUID identities stay exact", () => {
    const long = "L".repeat(200);
    const edges: Edge[] = [
      { projectId: pid(0xabcdef), projectSlug: "a-short-project", groupId: gid(0x123456), groupSlug: long },
      { projectId: pid(0xfedcba), projectSlug: long, groupId: gid(0x654321), groupSlug: "a-short-group" },
    ];

    const built = failed(loneCensus(edges));

    expect(built.evidence.sample).toStrictEqual([
      { projectId: pid(0xfedcba), groupId: gid(0x654321), projectSlug: `${"L".repeat(93)}…`, groupSlug: "a-short-group", projectSlugTruncated: true, groupSlugTruncated: false },
      { projectId: pid(0xabcdef), groupId: gid(0x123456), projectSlug: "a-short-project", groupSlug: `${"L".repeat(93)}…`, projectSlugTruncated: false, groupSlugTruncated: true },
    ]);
  });
});

// ── Error budgets ────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC03 (pure): a LONE failing arm uses 480 bytes minus its label", () => {
  it("convergence: 467 bytes are kept whole and the compound is exactly 480", () => {
    const message = "v".repeat(467);

    const built = failed(loneConvergence(message));

    expect(built.evidence.convergence.error).toStrictEqual({ message, truncated: false });
    expect(built.error).toBe(`convergence: ${message}`);
    expect(bytes(built.error)).toBe(480);
  });

  it("convergence: 468 bytes are cut to 464 + the cue — 467 bytes, flagged", () => {
    const built = failed(loneConvergence("v".repeat(468)));

    expect(built.evidence.convergence.error).toStrictEqual({ message: `${"v".repeat(464)}…`, truncated: true });
    expect(bytes(built.error)).toBe(480);
  });

  it("census read failure: 472 bytes are kept whole, 473 are cut to 469 + the cue", () => {
    const whole = failed({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: "c".repeat(472) } });
    const cut = failed({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: "c".repeat(473) } });

    expect(whole.evidence.census.error).toStrictEqual({ message: "c".repeat(472), truncated: false });
    expect(bytes(whole.error)).toBe(480);
    expect(cut.evidence.census.error).toStrictEqual({ message: `${"c".repeat(469)}…`, truncated: true });
    expect(bytes(cut.error)).toBe(480);
    expect(cut.evidence.census.total, "shortening a reason never invents a count").toBeNull();
  });

  it("census findings: the summary is measured as a whole — 472 bytes kept, 473 cut inside the display name", () => {
    const fit = BUDGET.loneCensus - bytes(`${head(1)}p→`);
    const edge = (n: number): Edge => ({ projectId: pid(1), projectSlug: "p", groupId: gid(1), groupSlug: "g".repeat(n) });
    expect(fit, "fixture: 472 − the 43-byte head − `p→`").toBe(425);

    const whole = failed(loneCensus([edge(fit)]));
    const cut = failed(loneCensus([edge(fit + 1)]));

    expect(whole.evidence.census.error).toStrictEqual({ message: `1 unsanctioned edge(s) on system projects: p→${"g".repeat(425)}`, truncated: false });
    expect(bytes(whole.error)).toBe(480);
    expect(cut.evidence.census.error).toStrictEqual({ message: `1 unsanctioned edge(s) on system projects: p→${"g".repeat(422)}…`, truncated: true });
    expect(bytes(cut.error)).toBe(480);
    // The 96-byte display label is a separate budget from the summary's.
    expect(whole.evidence.sample[0].groupSlug).toBe(`${"g".repeat(93)}…`);
    expect(whole.evidence.sample[0].groupSlugTruncated).toBe(true);
  });

  it("cuts land on code-point boundaries: never half a pair, and never past the first character that does not fit", () => {
    // 469 bytes: `a` + 115 pairs is 461; a 116th would need 465 of the 464 available before the cue.
    const pairs = failed(loneConvergence(`a${"😀".repeat(117)}`));
    // The pair straddles the cut; the cut stops before it rather than skipping ahead to `tail`.
    const straddle = failed(loneConvergence(`${"a".repeat(463)}😀tail`));
    // 474 bytes of two-byte characters against the 472-byte census arm.
    const twoByte = failed({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: "é".repeat(237) } });

    expect(pairs.evidence.convergence.error).toStrictEqual({ message: `a${"😀".repeat(115)}…`, truncated: true });
    expect(bytes(pairs.evidence.convergence.error!.message)).toBe(464);
    expect(straddle.evidence.convergence.error).toStrictEqual({ message: `${"a".repeat(463)}…`, truncated: true });
    expect(twoByte.evidence.census.error).toStrictEqual({ message: `${"é".repeat(234)}…`, truncated: true });
    expect(bytes(twoByte.evidence.census.error!.message)).toBe(471);
  });

  it("a raw finding PAST the legacy 200-character preclamp is still named, with no '+N more'", () => {
    const SENTINEL = "zz-sentinel-past-legacy-200";
    const groups = [..."abcdefg"].map((c) => `grp-${c}-padding-0123456789`).concat(SENTINEL);
    const edges = groups.map((slug, i) => ({ projectId: pid(1), projectSlug: "legacy-system", groupId: gid(i), groupSlug: slug }));
    const message = `8 unsanctioned edge(s) on system projects: ${groups.map((g) => `legacy-system→${g}`).join(", ")}`;
    // Fixture preconditions — MULTIPLE pairs, none enormous (the old first-pair fallback could exceed
    // 200 by itself), the sentinel beyond the old budget, and the whole summary inside the lone cap.
    expect(message.indexOf(SENTINEL), "fixture: the sentinel sits past the legacy 200-character summary").toBeGreaterThan(200);
    expect(bytes(message), "fixture: and inside the 472-byte lone census arm").toBeLessThanOrEqual(BUDGET.loneCensus);

    const built = failed(loneCensus([...edges].reverse()));

    expect(built.evidence.census.error).toStrictEqual({ message, truncated: false });
    expect(built.error).toBe(`census: ${message}`);
    expect(built.error, "all eight pairs are named").not.toMatch(/\+\d+ more/);
  });

  it("a real adoption refusal with a clean census keeps its repair suffix inside the 467-byte lone cap", () => {
    expect(REFUSAL.length, "fixture: the refusal is plain ASCII").toBe(bytes(REFUSAL));
    expect(bytes(REFUSAL), "fixture: longer than one 224-byte reservation").toBeGreaterThan(BUDGET.armReserve);
    expect(bytes(REFUSAL)).toBeLessThanOrEqual(BUDGET.loneConvergence);

    const built = build(loneConvergence(REFUSAL));

    expect(built).toStrictEqual({
      ok: false,
      error: `convergence: ${REFUSAL}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: REFUSAL, truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
    expect((built as Failed).error.endsWith("(repair: AUDITFIX-21)."), "a 224-byte arm or the old 200 preclamp cuts this").toBe(true);
  });
});

describe("AUDITFIX-25 AC03 (pure): when BOTH phases fail, 224 bytes are reserved per arm and the spare goes census-first", () => {
  // Start each arm at min(full, 224); the pool is 457; spend what is left on census, then convergence.
  it.each([
    { c: 2000, v: 2000, census: 233, convergence: 224 }, // 9 spare bytes: 233 / 224 — not 228 / 229, not 224 / 233
    { c: 224, v: 224, census: 224, convergence: 224 }, // two whole reservations: 471 with labels
    { c: 233, v: 224, census: 233, convergence: 224 }, // the pool exactly: both whole, 480
    { c: 234, v: 224, census: 233, convergence: 224 }, // one byte over: census is the arm that is cut
    { c: 2000, v: 224, census: 233, convergence: 224 }, // a long census cannot erase a whole 224-byte arm
    { c: 2000, v: 225, census: 233, convergence: 224 }, // …and census is extended before convergence
    { c: 224, v: 2000, census: 224, convergence: 233 }, // census needs nothing: all 9 go to convergence
    { c: 225, v: 2000, census: 225, convergence: 232 },
    { c: 233, v: 2000, census: 233, convergence: 224 },
    { c: 234, v: 2000, census: 233, convergence: 224 },
    { c: 228, v: 229, census: 228, convergence: 229 }, // 4 to census, 5 to convergence: both whole
    { c: 229, v: 229, census: 229, convergence: 228 }, // 5 to census leaves 4: convergence is cut
    { c: 58, v: 2000, census: 58, convergence: 399 }, // a short census: its unused reservation is redistributed
    { c: 2000, v: 15, census: 442, convergence: 15 }, // a short convergence: likewise
    { c: 1, v: 2000, census: 1, convergence: 456 },
    { c: 2000, v: 1, census: 456, convergence: 1 },
    { c: 100, v: 357, census: 100, convergence: 357 }, // the pool exactly, far from 224 / 233
    { c: 100, v: 358, census: 100, convergence: 357 },
  ])("census $c bytes + convergence $v bytes → $census / $convergence", ({ c, v, census: censusCap, convergence: convergenceCap }) => {
    const wantCensus = c <= censusCap ? "C".repeat(c) : `${"C".repeat(censusCap - 3)}…`;
    const wantConvergence = v <= convergenceCap ? "V".repeat(v) : `${"V".repeat(convergenceCap - 3)}…`;

    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: "V".repeat(v) }, census: { status: "failed", message: "C".repeat(c) } });

    expect(built.evidence.census.error).toStrictEqual({ message: wantCensus, truncated: c > censusCap });
    expect(built.evidence.convergence.error).toStrictEqual({ message: wantConvergence, truncated: v > convergenceCap });
    expect(built.error, "census first, both named").toBe(`census: ${wantCensus}; convergence: ${wantConvergence}`);
    expect(bytes(built.error)).toBe(8 + Math.min(c, censusCap) + 15 + Math.min(v, convergenceCap));
  });

  it("both arms long and multi-byte: each is cut on a code point inside its own allocation", () => {
    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: "😀".repeat(500) }, census: { status: "failed", message: "é".repeat(1000) } });

    // Census 233: 115 two-byte characters + the cue. Convergence 224: 55 pairs (220) + the cue — a 56th would need 227.
    expect(built.evidence.census.error).toStrictEqual({ message: `${"é".repeat(115)}…`, truncated: true });
    expect(built.evidence.convergence.error).toStrictEqual({ message: `${"😀".repeat(55)}…`, truncated: true });
    expect(bytes(built.error)).toBe(8 + 233 + 15 + 223);
  });

  const slugs = Array.from({ length: 20 }, (_, i) => `g${pad2(i)}-${"m".repeat(36)}`);
  const pair = (i: number) => `legacy-system→${slugs[i]}`;
  const manyFindings = () => shuffled(slugs.map((slug, i) => ({ projectId: pid(1), projectSlug: "legacy-system", groupId: gid(i), groupSlug: slug })));

  it("MANY raw findings + a short convergence failure: the census arm is cut from RAW pairs, sentinel past 200 intact", () => {
    const SENTINEL = slugs[3];
    const message = `${head(20)}${[0, 1, 2, 3, 4, 5].map(pair).join(", ")}, legacy-system→g06-${"m".repeat(27)}…`;
    expect(bytes(message), "fixture: 457 − the 15-byte convergence arm").toBe(442);
    expect(message.indexOf(SENTINEL), "fixture: the sentinel pair starts past the legacy 200").toBeGreaterThan(200);

    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: WEDGED }, census: census(manyFindings()) });

    expect(built.evidence.census.error, "restoring the 200-character preformatter drops this pair").toStrictEqual({ message, truncated: true });
    expect(built.evidence.convergence.error).toStrictEqual({ message: "general: wedged", truncated: false });
    expect(built.error).toBe(`census: ${message}; convergence: general: wedged`);
    expect(bytes(built.error), "the pool is fully spent").toBe(480);
    expect(built.error, "no promise of a complete list").not.toMatch(/\+\d+ more/);
    expect(built.evidence.census.total, "the count is exact").toBe(20);
    expect(built.evidence.sample.map((s) => s.groupSlug)).toEqual(slugs.slice(0, 16));
    expect(built.evidence.omitted).toBe(4);
  });

  it("MANY raw findings + a LONG convergence failure: the exact count head survives inside the 233-byte census arm", () => {
    const message = `${head(20)}${[0, 1, 2].map(pair).join(", ")}, legacy-syste…`;
    expect(bytes(message), "fixture: 224 reserved + the 9 spare bytes").toBe(233);

    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: "V".repeat(2000) }, census: census(manyFindings()) });

    expect(built.evidence.census.error).toStrictEqual({ message, truncated: true });
    expect(built.evidence.convergence.error).toStrictEqual({ message: `${"V".repeat(221)}…`, truncated: true });
    expect(bytes(built.error)).toBe(480);
    expect(built.evidence.census.total).toBe(20);
    expect(built.evidence.omitted).toBe(4);
  });

  it("a SHORT census beside the real refusal: the unused census reservation is redistributed and the repair suffix survives", () => {
    const summary = "1 unsanctioned edge(s) on system projects: legacy-system→vendors-and-contractors-emea";
    expect(bytes(summary) + bytes(REFUSAL), "fixture: both whole arms fit the 457-byte pool").toBeLessThanOrEqual(BUDGET.dualPool);

    const built = build({
      teamId: TEAM,
      convergence: { status: "failed", message: REFUSAL },
      census: census([{ projectId: pid(7), projectSlug: "legacy-system", groupId: gid(7), groupSlug: "vendors-and-contractors-emea" }]),
    });

    expect(built).toStrictEqual({
      ok: false,
      // A flat 224-byte arm cap would cut the refusal before `(repair: AUDITFIX-21).`
      error: `census: ${summary}; convergence: ${REFUSAL}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: REFUSAL, truncated: false } },
        census: { status: "complete", total: 1, error: { message: summary, truncated: false } },
        sample: [
          { projectId: pid(7), groupId: gid(7), projectSlug: "legacy-system", groupSlug: "vendors-and-contractors-emea", projectSlugTruncated: false, groupSlugTruncated: false },
        ],
        omitted: 0,
      },
    });
  });

  it("the refusal's suffix survives up to the pool's last byte, and is cut — visibly — one byte later", () => {
    const room = BUDGET.dualPool - bytes(REFUSAL);
    expect(REFUSAL.length, "fixture: the refusal is plain ASCII, so a character cut is a byte cut").toBe(bytes(REFUSAL));
    expect(bytes(REFUSAL), "fixture: the census arm that completes the pool is under its own reservation").toBeGreaterThan(233);
    const beside = (c: number): Input => ({ teamId: TEAM, convergence: { status: "failed", message: REFUSAL }, census: { status: "failed", message: "C".repeat(c) } });

    const fits = failed(beside(room));
    const over = failed(beside(room + 1));

    expect(fits.evidence.convergence.error).toStrictEqual({ message: REFUSAL, truncated: false });
    expect(bytes(fits.error)).toBe(480);
    // Census stays first and whole; the one missing byte comes out of convergence.
    expect(over.evidence.census.error).toStrictEqual({ message: "C".repeat(room + 1), truncated: false });
    expect(over.evidence.convergence.error).toStrictEqual({ message: `${REFUSAL.slice(0, bytes(REFUSAL) - 4)}…`, truncated: true });
    expect(bytes(over.error)).toBe(480);
  });

  it("a LONG census beside the refusal leaves it exactly its 224-byte reservation", () => {
    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: REFUSAL }, census: { status: "failed", message: "C".repeat(2000) } });

    expect(built.evidence.census.error).toStrictEqual({ message: `${"C".repeat(230)}…`, truncated: true });
    expect(built.evidence.convergence.error).toStrictEqual({ message: `${REFUSAL.slice(0, 221)}…`, truncated: true });
    expect(built.evidence.convergence.error!.message.startsWith("general: refusing to adopt 'general'"), "the reservation still names the refusal").toBe(true);
  });
});

// ── Serialized metadata budget ───────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC04 (pure): the SERIALIZED namespace is at most 8,192 bytes, trimmed from the end of the order", () => {
  it("keeps the last sample that fits EXACTLY 8,192 wrapper bytes, and drops it at 8,193", () => {
    const { heavy, filler } = calibrateBoundary();
    const at = boundaryCandidate(heavy, filler, BOUNDARY_KEEP);
    const over = boundaryCandidate(heavy, filler + 1, BOUNDARY_KEEP);
    expect(bytes(BOUNDARY_MESSAGE), "fixture: the census arm is the full lone 472 bytes").toBe(BUDGET.loneCensus);
    expect(bytes(BOUNDARY_PROJECT_DISPLAY), "fixture: the project display is the full 96 bytes").toBe(BUDGET.slugBytes);
    expect(wrapperBytes(at), "fixture: six samples serialize to exactly the budget").toBe(8192);
    expect(wrapperBytes(over), "fixture: one more ASCII byte in sample 0 is one byte over").toBe(8193);
    expect(wrapperBytes(boundaryCandidate(heavy, filler, BOUNDARY_KEEP + 1)), "fixture: a seventh sample does not fit").toBeGreaterThan(8192);
    // Raw text looks small; only a measurement of the ESCAPED wrapper — key and braces included
    // (28 bytes) — puts the boundary here.
    const sixteen = boundaryCandidate(heavy, filler, 16);
    const rawText = [BOUNDARY_MESSAGE, ...sixteen.sample.flatMap((s) => [s.projectSlug, s.groupSlug])].reduce((n, s) => n + bytes(s), 0);
    expect(rawText, "fixture: sixteen samples' unescaped text is under half the budget").toBeLessThan(4000);
    expect(wrapperBytes(sixteen), "fixture: but sixteen escaped samples overflow").toBeGreaterThan(8192);

    const fits = build(boundaryInput(heavy, filler));
    const trimmed = build(boundaryInput(heavy, filler + 1));

    expect(fits, "8,192 bytes is inside the budget").toStrictEqual({ ok: false, error: `census: ${BOUNDARY_MESSAGE}`, evidence: at });
    expect(trimmed, "8,193 is not: the LAST ordered sample goes, and omitted is recomputed").toStrictEqual({
      ok: false,
      error: `census: ${BOUNDARY_MESSAGE}`,
      evidence: boundaryCandidate(heavy, filler + 1, BOUNDARY_KEEP - 1),
    });
    expect((trimmed as Failed).evidence.omitted).toBe(BOUNDARY_TOTAL - BOUNDARY_KEEP + 1);
    expectInvariants(fits as Failed);
    expectInvariants(trimmed as Failed);
  });

  it("quote/backslash/control/non-BMP slugs with an enormous first slug: trimmed to the last fitting sample, truthful flags", () => {
    const PREFIX = `!"quoted"\\back\\slash\ttab\nline-😀-`;
    const project = `${PREFIX}${"p".repeat(1500)}`;
    const projectDisplay = `${PREFIX}${"p".repeat(93 - bytes(PREFIX))}…`;
    // Forty control characters (240 bytes once serialized), then a pair run that straddles byte 93.
    const group = (i: number) => `${"\u0001".repeat(40)}"\\${"😀".repeat(20)}-${pad2(i)}`;
    const groupDisplay = `${"\u0001".repeat(40)}"\\${"😀".repeat(12)}…`;
    const message = `${head(20)}${PREFIX}${"p".repeat(BUDGET.loneCensus - 3 - bytes(head(20)) - bytes(PREFIX))}…`;
    // Group ids DEscend as the slug AScends, and the slugs differ only past the display cut.
    const edges = Array.from({ length: 20 }, (_, i) => ({ projectId: pid(1), projectSlug: project, groupId: gid(100 - i), groupSlug: group(i) }));
    const candidate = (keep: number): Evidence => ({
      version: 1,
      teamId: TEAM,
      convergence: { status: "ok" },
      census: { status: "complete", total: 20, error: { message, truncated: true } },
      sample: Array.from({ length: keep }, (_, i) => ({
        projectId: pid(1),
        groupId: gid(100 - i),
        projectSlug: projectDisplay,
        groupSlug: groupDisplay,
        projectSlugTruncated: true,
        groupSlugTruncated: true,
      })),
      omitted: 20 - keep,
    });
    let keep = 16;
    while (keep > 0 && wrapperBytes(candidate(keep)) > BUDGET.metaBytes) keep--;
    expect(bytes(projectDisplay), "fixture: the project display fills 96 bytes").toBe(96);
    expect(bytes(groupDisplay), "fixture: twelve whole pairs — a thirteenth would need 97 bytes").toBe(93);
    expect(bytes(message), "fixture: the enormous first pair alone fills the arm").toBe(BUDGET.loneCensus);
    expect(16 * (projectDisplay.length + groupDisplay.length), "fixture: raw label characters look small").toBeLessThan(4000);
    expect(wrapperBytes(candidate(16)), "fixture: but sixteen escaped samples overflow").toBeGreaterThan(BUDGET.metaBytes);
    expect(keep, "fixture: the trim is partial").toBeGreaterThan(0);
    expect(keep).toBeLessThan(16);

    const built = build(loneCensus(shuffled(edges)));

    expect(built).toStrictEqual({ ok: false, error: `census: ${message}`, evidence: candidate(keep) });
    expectInvariants(built as Failed);
    // The LAST FITTING sample: one more, in order, would not fit. Not an accidental sample size.
    const e = (built as Failed).evidence;
    expect(wrapperBytes({ ...e, sample: [...e.sample, candidate(keep + 1).sample[keep]], omitted: (e.omitted as number) - 1 }), "the next ordered sample would exceed 8,192 bytes").toBeGreaterThan(BUDGET.metaBytes);
    expect(e.census.total, "the count is still the full count").toBe(20);
    for (const s of e.sample) {
      expect(s.groupSlug.slice(0, -1).isWellFormed(), "never half of a surrogate pair").toBe(true);
      expect(group(0).startsWith(s.groupSlug.slice(0, -1)), "a code-point prefix of the raw slug").toBe(true);
    }
  });

  it("BOTH error arms serialize heavily too: the same budget covers them, so they shrink the room for samples", () => {
    const group = (i: number) => `${pad2(i)}${"\u0001".repeat(94)}`; // exactly 96 UTF-8 bytes, 566 serialized
    const edges = Array.from({ length: 20 }, (_, i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(i), groupSlug: group(i) }));
    const censusMessage = `${head(20)}sys→${group(0)}, sys→01${"\u0001".repeat(74)}…`;
    const convergenceMessage = `${"\u0001".repeat(221)}…`;
    const candidate = (keep: number): Evidence => ({
      version: 1,
      teamId: TEAM,
      convergence: { status: "failed", error: { message: convergenceMessage, truncated: true } },
      census: { status: "complete", total: 20, error: { message: censusMessage, truncated: true } },
      sample: edges.slice(0, keep).map(plain),
      omitted: 20 - keep,
    });
    let keep = 16;
    while (keep > 0 && wrapperBytes(candidate(keep)) > BUDGET.metaBytes) keep--;
    expect(bytes(censusMessage), "fixture: 224 reserved + the 9 spare bytes").toBe(233);
    expect(keep, "fixture: the trim is partial").toBeGreaterThan(0);
    expect(keep).toBeLessThan(16);
    expect(wrapperBytes(candidate(keep + 1)), "fixture: one more ordered sample does not fit").toBeGreaterThan(BUDGET.metaBytes);

    const built = build({ teamId: TEAM, convergence: { status: "failed", message: "\u0001".repeat(2000) }, census: census(shuffled(edges)) });

    expect(built).toStrictEqual({ ok: false, error: `census: ${censusMessage}; convergence: ${convergenceMessage}`, evidence: candidate(keep) });
    expectInvariants(built as Failed);
    expect(bytes((built as Failed).error), "control characters are one UTF-8 byte each: the compound is still full").toBe(480);
  });
});

// ── Normalization ────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC04 (pure): NUL and isolated surrogates become U+FFFD; valid pairs and other text are preserved", () => {
  const HOSTILE = "bad\u0000nul \uD83D lone-high \uDE00 lone-low ok 😀 pair";
  const CLEAN = `bad${REPLACEMENT}nul ${REPLACEMENT} lone-high ${REPLACEMENT} lone-low ok 😀 pair`;

  it("a convergence message carrying NUL and isolated surrogates is stored clean, in the error AND the evidence", () => {
    expect(HOSTILE.isWellFormed(), "fixture: the message really carries isolated surrogates").toBe(false);
    expect(CLEAN.isWellFormed()).toBe(true);

    const built = build(loneConvergence(HOSTILE));

    expect(built).toStrictEqual({
      ok: false,
      error: `convergence: ${CLEAN}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: CLEAN, truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
  });

  it("the census reason and the convergence reason are normalized alike", () => {
    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: HOSTILE }, census: { status: "failed", message: `failed: ${HOSTILE}` } });

    expect(built.error).toBe(`census: failed: ${CLEAN}; convergence: ${CLEAN}`);
    expect(built.evidence.census.error).toStrictEqual({ message: `failed: ${CLEAN}`, truncated: false });
    expect(built.evidence.convergence.error).toStrictEqual({ message: CLEAN, truncated: false });
  });

  it("slugs are normalized in the sample AND in the summary; a replacement is not a shortening", () => {
    const built = failed(loneCensus([{ projectId: pid(1), projectSlug: "sys\u0000tem", groupId: gid(1), groupSlug: "grp\uD83D-😀" }]));

    expect(built.error).toBe(`census: 1 unsanctioned edge(s) on system projects: sys${REPLACEMENT}tem→grp${REPLACEMENT}-😀`);
    expect(built.evidence.sample).toStrictEqual([
      { projectId: pid(1), groupId: gid(1), projectSlug: `sys${REPLACEMENT}tem`, groupSlug: `grp${REPLACEMENT}-😀`, projectSlugTruncated: false, groupSlugTruncated: false },
    ]);
    expect(built.evidence.census.error!.truncated).toBe(false);
  });

  it.each<{ name: string; raw: string; clean: string }>([
    { name: "a lone NUL", raw: "\u0000", clean: REPLACEMENT },
    { name: "adjacent NULs, one replacement each", raw: "a\u0000\u0000b", clean: `a${REPLACEMENT}${REPLACEMENT}b` },
    { name: "a REVERSED pair (low then high) is two isolated units", raw: "\uDE00\uD83D", clean: `${REPLACEMENT}${REPLACEMENT}` },
    { name: "high, high, low: only the first high is isolated", raw: "\uD83D😀", clean: `${REPLACEMENT}😀` },
    { name: "high, low, low: only the trailing low is isolated", raw: "😀\uDE00", clean: `😀${REPLACEMENT}` },
    { name: "a high surrogate at the very end", raw: "x\uD83D", clean: `x${REPLACEMENT}` },
    { name: "a low surrogate at the very start", raw: "\uDE00x", clean: `${REPLACEMENT}x` },
    { name: "valid pairs, including a modifier sequence, are untouched", raw: "ok 😀 👍🏽 done", clean: "ok 😀 👍🏽 done" },
    { name: "an existing U+FFFD is untouched", raw: `already ${REPLACEMENT}`, clean: `already ${REPLACEMENT}` },
    {
      // PG16 jsonb rejects NUL and unpaired surrogates and accepts these; they are escaped, not replaced.
      name: "other controls, quotes and backslashes are preserved verbatim",
      raw: 'line1\nline2\ttab "quoted" back\\slash \u0001\u001f\u007f',
      clean: 'line1\nline2\ttab "quoted" back\\slash \u0001\u001f\u007f',
    },
  ])("$name", ({ raw, clean }) => {
    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: raw }, census: { status: "failed", message: raw } });

    expect(built.evidence.convergence.error).toStrictEqual({ message: clean, truncated: false });
    expect(built.evidence.census.error).toStrictEqual({ message: clean, truncated: false });
    expect(built.error).toBe(`census: ${clean}; convergence: ${clean}`);
  });

  it("messages are measured AFTER normalization: a NUL costs the three bytes of its replacement", () => {
    // 155 NULs are 155 raw bytes and 465 normalized: inside the 467-byte arm. 156 are 468: one over.
    const whole = failed(loneConvergence("\u0000".repeat(155)));
    const cut = failed(loneConvergence("\u0000".repeat(156)));

    expect(whole.evidence.convergence.error).toStrictEqual({ message: REPLACEMENT.repeat(155), truncated: false });
    expect(cut.evidence.convergence.error).toStrictEqual({ message: `${REPLACEMENT.repeat(154)}…`, truncated: true });
  });
});

// ── Extraction ───────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC06 (pure): guarded message extraction (spec §Flow extraction table)", () => {
  const extract = (phase: "convergence" | "census", failure: Failure): string => extractBootstrapFailureMessage(phase, failure);
  const returned = (result: unknown): Failure => ({ kind: "returned", result });
  const thrown = (value: unknown): Failure => ({ kind: "thrown", value });

  /** A returned `{ ok: false }` whose `error` accessor throws — the helper gets the WHOLE result so it can guard this. */
  const errorGetterFault = () =>
    Object.defineProperty({ ok: false, edges: [] }, "error", {
      enumerable: true,
      get() {
        throw new Error("RETURNED-GETTER-TEXT");
      },
    });
  const everyAccessThrows = () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error("PROXY-GET-TEXT");
        },
      }
    );
  const messageGetterFault = (): Error => {
    const e = new Error("replaced below");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error("MESSAGE-GETTER-TEXT");
      },
    });
    return e;
  };
  const nonStringMessage = (): Error => Object.assign(new Error("replaced below"), { message: 42 as unknown as string });
  /** An object that would yield text under ANY coercion, and records that it was asked. */
  const coercible = () => {
    const calls: string[] = [];
    const answer = (via: string) => () => {
      calls.push(via);
      return "COERCED-TEXT";
    };
    const value = { message: "MINED-OBJECT-MESSAGE", toString: answer("toString"), valueOf: answer("valueOf"), toJSON: answer("toJSON"), [Symbol.toPrimitive]: answer("toPrimitive") };
    return { value, calls };
  };

  const UNUSABLE_RETURNS: { name: string; make: () => unknown }[] = [
    { name: "no error property", make: () => ({ ok: false, edges: [] }) },
    { name: "an EMPTY error", make: () => ({ ok: false, error: "", edges: [] }) },
    { name: "a numeric error", make: () => ({ ok: false, error: 42, edges: [] }) },
    { name: "a null error", make: () => ({ ok: false, error: null, edges: [] }) },
    { name: "an object error carrying a string .message", make: () => ({ ok: false, error: { message: "MINED-OBJECT-MESSAGE" } }) },
    { name: "an Error instance as the error", make: () => ({ ok: false, error: new Error("MINED-ERROR-INSTANCE") }) },
    { name: "an array error", make: () => ({ ok: false, error: ["ARRAY-ERROR-TEXT"] }) },
    { name: "a sibling .message and no error", make: () => ({ ok: false, message: "MINED-SIBLING-MESSAGE" }) },
    { name: "an error ACCESSOR that throws", make: errorGetterFault },
    { name: "a result whose every property access throws", make: everyAccessThrows },
    { name: "a null result", make: () => null },
    { name: "an undefined result", make: () => undefined },
    { name: "a bare string result", make: () => "RETURNED-STRING-TEXT" },
    { name: "a numeric result", make: () => 42 },
  ];
  const UNUSABLE_THROWS: { name: string; make: () => unknown }[] = [
    { name: "a plain object carrying a string .message", make: () => ({ message: "MINED-OBJECT-MESSAGE" }) },
    { name: "an Error LOOKALIKE with name, message and stack", make: () => ({ name: "Error", message: "LOOKALIKE-MESSAGE", stack: "Error: LOOKALIKE-MESSAGE\n    at x" }) },
    { name: "a string", make: () => "THROWN-STRING-TEXT" },
    { name: "a number", make: () => 42 },
    { name: "null", make: () => null },
    { name: "undefined", make: () => undefined },
    { name: "an Error with an EMPTY message", make: () => new Error("") },
    { name: "an Error whose message is not a string", make: nonStringMessage },
    { name: "an Error whose message GETTER throws", make: messageGetterFault },
  ];

  describe.each([
    { phase: "convergence" as const, returnedFallback: "unknown", thrownFallback: "threw" },
    { phase: "census" as const, returnedFallback: "failed", thrownFallback: "system-edge census threw: threw" },
  ])("$phase — fixed fallbacks", ({ phase, returnedFallback, thrownFallback }) => {
    it.each(UNUSABLE_RETURNS)(`returned failure with $name → '${returnedFallback}'`, ({ make }) => {
      // Never the green-making empty string, never exception text, never a mined property.
      expect(extract(phase, returned(make()))).toBe(returnedFallback);
    });

    it.each(UNUSABLE_THROWS)(`thrown $name → '${thrownFallback}'`, ({ make }) => {
      expect(extract(phase, thrown(make()))).toBe(thrownFallback);
    });

    it("never coerces an arbitrary object to text — as a returned error or as a thrown value", () => {
      const asError = coercible();
      const asThrown = coercible();

      expect(extract(phase, returned({ ok: false, error: asError.value, edges: [] }))).toBe(returnedFallback);
      expect(extract(phase, thrown(asThrown.value))).toBe(thrownFallback);
      expect(asError.calls, "no String(), template, JSON or valueOf call reached the returned error").toEqual([]);
      expect(asThrown.calls, "nor the thrown value").toEqual([]);
    });
  });

  it("convergence: a returned nonempty string error is that string, whole", () => {
    const long = `groups read failed: ${"x".repeat(3000)}`;

    expect(extract("convergence", returned({ ok: false, error: "general: wedged" }))).toBe("general: wedged");
    expect(extract("convergence", returned({ ok: false, error: REFUSAL }))).toBe(REFUSAL);
    // The builder owns every budget: the extractor hands it the FULL message.
    expect(extract("convergence", returned({ ok: false, error: long }))).toBe(long);
    // The census prefix rule is the census phase's alone.
    expect(extract("convergence", returned({ ok: false, error: "system-edge census failed: x" }))).toBe("system-edge census failed: x");
  });

  it("convergence: a thrown Error contributes its nonempty string message — and nothing else of itself", () => {
    class AdapterError extends Error {}
    const decorated = Object.assign(new Error("only this message"), { stack: "STACK-TEXT", code: "CODE-TEXT", detail: "DETAIL-TEXT", cause: new Error("CAUSE-TEXT") });

    expect(extract("convergence", thrown(new Error("convergence exploded")))).toBe("convergence exploded");
    expect(extract("convergence", thrown(new TypeError("typed failure")))).toBe("typed failure");
    expect(extract("convergence", thrown(new AdapterError("subclass failure")))).toBe("subclass failure");
    expect(extract("convergence", thrown(decorated)), "no stack, name, code or cause").toBe("only this message");
  });

  it("census: a returned string error loses ONE leading 'system-edge census ' and nothing else", () => {
    const strip = (error: string) => extract("census", returned({ ok: false, error, edges: [] }));

    // What the real census returns: `system-edge census failed: <adapter text>`.
    expect(strip("system-edge census failed: census exploded")).toBe("failed: census exploded");
    expect(strip("system-edge census system-edge census failed"), "one prefix, not every prefix").toBe("system-edge census failed");
    expect(strip("census exploded"), "an unprefixed reason is kept").toBe("census exploded");
    expect(strip("read failed: system-edge census unreadable"), "only a LEADING prefix").toBe("read failed: system-edge census unreadable");
    expect(strip("system-edge census"), "the prefix includes its trailing space").toBe("system-edge census");
    expect(strip("system-edge census "), "nothing left after the strip is not a reason").toBe("failed");
  });

  it("census: a thrown Error is named 'system-edge census threw: MESSAGE', verbatim", () => {
    expect(extract("census", thrown(new Error("census exploded")))).toBe("system-edge census threw: census exploded");
    // The strip rule belongs to RETURNED errors: a thrown message is carried as it is.
    expect(extract("census", thrown(new Error("system-edge census boom")))).toBe("system-edge census threw: system-edge census boom");
  });

  it("phase labels are the BUILDER's: extracted reasons carry none, and the builder adds exactly one each", () => {
    const censusReason = extract("census", thrown(new Error("census exploded")));
    const convergenceReason = extract("convergence", returned({ ok: false, error: "general: wedged" }));
    expect(censusReason.startsWith("census: ")).toBe(false);
    expect(convergenceReason.startsWith("convergence: ")).toBe(false);

    const built = failed({ teamId: TEAM, convergence: { status: "failed", message: convergenceReason }, census: { status: "failed", message: censusReason } });

    expect(built.error).toBe("census: system-edge census threw: census exploded; convergence: general: wedged");
  });

  // Safe extraction is NOT a builder fault: a fallback reason still yields NORMAL typed evidence,
  // with truncated=false. (The no-evidence fallback is the caller's third guard — not this file's.)
  it.each([
    { name: "returned with no usable error", failure: () => returned({ ok: false }), fallback: "unknown" },
    { name: "returned with a throwing error accessor", failure: () => returned(errorGetterFault()), fallback: "unknown" },
    { name: "threw a non-Error", failure: () => thrown({ message: "MINED-OBJECT-MESSAGE" }), fallback: "threw" },
    { name: "threw an Error with a throwing message getter", failure: () => thrown(messageGetterFault()), fallback: "threw" },
  ])("convergence $name → 'convergence: $fallback' WITH evidence and a known-zero census", ({ failure, fallback }) => {
    const built = build(loneConvergence(extract("convergence", failure())));

    expect(built).toStrictEqual({
      ok: false,
      error: `convergence: ${fallback}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "failed", error: { message: fallback, truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
  });

  it.each([
    { name: "returned with no usable error", failure: () => returned({ ok: false, edges: [] }), fallback: "failed" },
    { name: "returned ONLY the stripped prefix", failure: () => returned({ ok: false, error: "system-edge census ", edges: [] }), fallback: "failed" },
    { name: "returned with a throwing error accessor", failure: () => returned(errorGetterFault()), fallback: "failed" },
    { name: "threw a non-Error", failure: () => thrown("THROWN-STRING-TEXT"), fallback: "system-edge census threw: threw" },
    { name: "threw an Error with an empty message", failure: () => thrown(new Error("")), fallback: "system-edge census threw: threw" },
  ])("census $name → 'census: $fallback' WITH unavailable-count evidence", ({ failure, fallback }) => {
    const built = build({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: extract("census", failure()) } });

    expect(built).toStrictEqual({
      ok: false,
      error: `census: ${fallback}`,
      evidence: {
        version: 1,
        teamId: TEAM,
        convergence: { status: "ok" },
        census: { status: "failed", total: null, error: { message: fallback, truncated: false } },
        sample: [],
        omitted: null,
      },
    });
  });

  it("a hostile thrown message is classified as a real message, then normalized by the builder", () => {
    const reason = extract("convergence", thrown(new Error("bad\u0000nul \uD83D lone-high")));

    const built = failed(loneConvergence(reason));

    expect(built.error, "a NUL-bearing message is nonempty: it is not a fallback").toBe(`convergence: bad${REPLACEMENT}nul ${REPLACEMENT} lone-high`);
  });
});

// ── Decoder ──────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC07/AC08 (pure): the decoder recognizes exactly a valid version-1 envelope on its own failed team row", () => {
  const decode = (r: Row) => decodeBootstrapEvidence(r) as Evidence | null;
  const row = (meta: unknown, over: Partial<Row> = {}): Row => ({ source: "access_bootstrap", team_id: TEAM, ok: false, meta, ...over });
  const meta = (evidence: unknown, siblings: Record<string, unknown> = {}) => ({ accessBootstrapEvidence: evidence, ...siblings });

  const CENSUS_MESSAGE = "23 unsanctioned edge(s) on system projects: general→vendors, legacy-system→contr…";
  const sampleA = (): Sample => ({ projectId: pid(1), groupId: gid(1), projectSlug: "general", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false });
  const sampleB = (): Sample => ({ projectId: pid(2), groupId: gid(2), projectSlug: `${"x".repeat(93)}…`, groupSlug: `q"uote\\back\nline 😀`, projectSlugTruncated: true, groupSlugTruncated: false });
  const samples = (n: number, slug = "a-slug"): Sample[] =>
    Array.from({ length: n }, (_, i) => ({ projectId: pid(i + 1), groupId: gid(i + 1), projectSlug: slug, groupSlug: slug, projectSlugTruncated: false, groupSlugTruncated: false }));
  const convergenceFailed = (message = "general: wedged") => ({ status: "failed", error: { message, truncated: false } });
  const censusFound = (over: Record<string, unknown> = {}) => ({ status: "complete", total: 23, error: { message: CENSUS_MESSAGE, truncated: true }, ...over });
  const censusFailed = (message = "failed: census exploded") => ({ status: "failed", total: null, error: { message, truncated: false } });
  /** Both phases failing, 23 findings, two sampled, 21 omitted — the base every refusal below is one edit away from. */
  const findings = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    teamId: TEAM,
    convergence: convergenceFailed(),
    census: censusFound(),
    sample: [sampleA(), sampleB()],
    omitted: 21,
    ...over,
  });
  const lone = (message: string) => findings({ census: { status: "complete", total: 0 }, convergence: convergenceFailed(message), sample: [], omitted: 0 });
  const unavailable = (message: string) => findings({ convergence: { status: "ok" }, census: censusFailed(message), sample: [], omitted: null });
  const dual = (c: number, v: number) => findings({ convergence: convergenceFailed("V".repeat(v)), census: censusFailed("C".repeat(c)), sample: [], omitted: null });

  // Every state the producer can emit. A decoder that returns null for everything fails all of these.
  const VALID: { name: string; make: () => Record<string, unknown> }[] = [
    { name: "convergence failed, census complete with a KNOWN ZERO", make: () => lone("general: wedged") },
    { name: "convergence ok, census complete with findings", make: () => findings({ convergence: { status: "ok" } }) },
    { name: "convergence failed, census complete with findings", make: () => findings() },
    { name: "convergence ok, census failed — total and omitted UNAVAILABLE", make: () => unavailable("failed: census exploded") },
    { name: "convergence failed, census failed", make: () => findings({ census: censusFailed("system-edge census threw: census exploded"), sample: [], omitted: null }) },
    { name: "findings whose every sample was trimmed away", make: () => findings({ sample: [], omitted: 23 }) },
    { name: "sixteen samples and nothing omitted", make: () => findings({ census: censusFound({ total: 16 }), sample: samples(16), omitted: 0 }) },
    { name: "sixteen samples whose slugs are 96 ASCII bytes each", make: () => findings({ census: censusFound({ total: 40 }), sample: samples(16, "a".repeat(96)), omitted: 24 }) },
    { name: "a display slug of 48 two-byte characters (96 bytes)", make: () => findings({ sample: [sampleA(), { ...sampleB(), groupSlug: "é".repeat(48) }] }) },
    // Flags and messages are validated as typed, bounded values — the decoder cannot and does not
    // reconstruct the raw text they were cut from, nor the summary grammar.
    { name: "a SHORT message flagged truncated", make: () => findings({ convergence: { status: "failed", error: { message: "short", truncated: true } } }) },
    { name: "a SHORT slug flagged truncated", make: () => findings({ sample: [{ ...sampleA(), projectSlugTruncated: true }, sampleB()] }) },
    { name: "a 96-byte slug ending in the cue, NOT flagged", make: () => findings({ sample: [sampleA(), { ...sampleB(), projectSlugTruncated: false }] }) },
    { name: "a census summary that does not follow the count-head grammar", make: () => findings({ census: censusFound({ error: { message: "an older wording", truncated: false } }) }) },
    { name: "a lone convergence reason of exactly 467 bytes", make: () => lone("v".repeat(467)) },
    { name: "a lone convergence reason of 233 two-byte characters (466 bytes)", make: () => lone("é".repeat(233)) },
    { name: "a lone census reason of exactly 472 bytes", make: () => unavailable("c".repeat(472)) },
    { name: "two arms that fill the 457-byte pool at 233 + 224", make: () => dual(233, 224) },
    { name: "two arms that fill the pool by redistribution, 100 + 357", make: () => dual(100, 357) },
  ];

  it.each(VALID)("accepts $name — as an object and as a legacy JSON string, identically", ({ make }) => {
    const fromObject = decode(row(meta(make())));
    const fromString = decode(row(JSON.stringify(meta(make()))));

    expect(fromObject).toStrictEqual(make());
    expect(fromString).toStrictEqual(make());
  });

  it("returns a FRESH projection and leaves a frozen row untouched", () => {
    const source = deepFreeze(findings()) as unknown as Evidence;

    const decoded = decode(deepFreeze(row(meta(source))));

    expect(decoded).toStrictEqual(findings());
    expect(decoded, "never the stored object itself").not.toBe(source);
    expect(decoded!.convergence).not.toBe(source.convergence);
    expect(decoded!.convergence.error).not.toBe(source.convergence.error);
    expect(decoded!.census).not.toBe(source.census);
    expect(decoded!.census.error).not.toBe(source.census.error);
    expect(decoded!.sample).not.toBe(source.sample);
    expect(decoded!.sample[0]).not.toBe(source.sample[0]);
  });

  it("accepts a pretty-printed legacy string: the bound is its bytes, not its formatting", () => {
    expect(decode(row(JSON.stringify(meta(findings()), null, 2)))).toStrictEqual(findings());
  });

  it("projects KNOWN fields only: unknown envelope, phase, error, sample and sibling keys are dropped, never serialized", () => {
    const serialized: string[] = [];
    const spy = (label: string) => ({
      toJSON() {
        serialized.push(label);
        return `${label}-TOJSON-MARKER`;
      },
    });
    // A cycle cannot be stringified at all: a decoder that measures or dumps the whole meta object,
    // the whole envelope or a whole sample throws (or refuses) instead of projecting.
    const cyclic: Record<string, unknown> = { marker: "CYCLIC-MARKER" };
    cyclic.self = cyclic;
    const envelope = findings({
      stack: "UNKNOWN-ENVELOPE-FIELD-MARKER",
      loop: cyclic,
      raw: spy("envelope"),
      convergence: { status: "failed", error: { message: "general: wedged", truncated: false, stack: "UNKNOWN-ERROR-FIELD-MARKER", cause: cyclic }, sql: "UNKNOWN-PHASE-FIELD-MARKER" },
      census: { ...censusFound(), rows: spy("census"), loop: cyclic },
      sample: [{ ...sampleA(), sql: "UNKNOWN-SAMPLE-FIELD-MARKER", loop: cyclic, raw: spy("sample") }, sampleB()],
    });

    const decoded = decode(row(meta(envelope, { threw: "SIBLING-META-MARKER", loop: cyclic, raw: spy("sibling") })));

    expect(decoded, "the known envelope is still recognized, not rejected for its neighbours").toStrictEqual(findings());
    expect(serialized, "no unknown value was ever handed to JSON").toEqual([]);
    const rendered = JSON.stringify(decoded);
    for (const marker of ["UNKNOWN-ENVELOPE-FIELD-MARKER", "UNKNOWN-ERROR-FIELD-MARKER", "UNKNOWN-PHASE-FIELD-MARKER", "UNKNOWN-SAMPLE-FIELD-MARKER", "SIBLING-META-MARKER", "CYCLIC-MARKER", "TOJSON-MARKER"]) {
      expect(rendered, `arbitrary failed-row metadata must not be carried: ${marker}`).not.toContain(marker);
    }
  });

  it("projects known fields from a legacy STRING too", () => {
    const envelope = findings({ stack: "UNKNOWN-ENVELOPE-FIELD-MARKER", sample: [{ ...sampleA(), sql: "UNKNOWN-SAMPLE-FIELD-MARKER" }, sampleB()] });

    const decoded = decode(row(JSON.stringify(meta(envelope, { threw: "SIBLING-META-MARKER" }))));

    expect(decoded).toStrictEqual(findings());
  });

  it("a clean phase never surfaces an error object", () => {
    const strayConvergence = decode(row(meta(findings({ convergence: { status: "ok", error: { message: "STRAY-CLEAN-PHASE-MARKER", truncated: false } } }))));
    const strayCensus = decode(row(meta(findings({ census: { status: "complete", total: 0, error: { message: "STRAY-CLEAN-PHASE-MARKER", truncated: false } }, sample: [], omitted: 0 }))));

    // Refusing the envelope and projecting the stray error away are both fail-closed; rendering it is not.
    expect(JSON.stringify(strayConvergence)).not.toContain("STRAY-CLEAN-PHASE-MARKER");
    expect(JSON.stringify(strayCensus)).not.toContain("STRAY-CLEAN-PHASE-MARKER");
  });

  // ── What the decoder must REFUSE ────────────────────────────────────────────────────────────────

  const REFUSED: { name: string; row: () => Row }[] = [
    // Row identity: only a FAILED, non-NULL-team `access_bootstrap` row can carry evidence.
    { name: "the fleet-liveness source", row: () => row(meta(findings()), { source: "access_bootstrap_all" }) },
    { name: "another source's row", row: () => row(meta(findings()), { source: "pm_sync" }) },
    { name: "a row with no source", row: () => row(meta(findings()), { source: undefined }) },
    { name: "a NULL-team (global) row", row: () => row(meta(findings()), { team_id: null }) },
    { name: "a row with no team", row: () => row(meta(findings()), { team_id: undefined }) },
    { name: "an envelope naming ANOTHER team", row: () => row(meta(findings({ teamId: OTHER_TEAM }))) },
    { name: "ANOTHER team's row carrying this envelope", row: () => row(meta(findings()), { team_id: OTHER_TEAM }) },
    { name: "a matching team identity that is not a UUID", row: () => row(meta(findings({ teamId: "not-a-uuid" })), { team_id: "not-a-uuid" }) },
    { name: "an OK row", row: () => row(meta(findings()), { ok: true }) },
    { name: "a row whose ok is missing", row: () => row(meta(findings()), { ok: undefined }) },
    { name: "a row whose ok is the string 'false'", row: () => row(meta(findings()), { ok: "false" }) },
    // Metadata shape.
    { name: "null meta", row: () => row(null) },
    { name: "undefined meta", row: () => row(undefined) },
    { name: "numeric meta", row: () => row(42) },
    { name: "array meta", row: () => row([meta(findings())]) },
    { name: "meta without the namespace", row: () => row({ teams: 3, threw: "bootstrap threw" }) },
    { name: "an empty string meta", row: () => row("") },
    { name: "an unparseable string meta", row: () => row('{"accessBootstrapEvidence": {"sample": "x"') },
    { name: "a string meta that parses to null", row: () => row("null") },
    { name: "a string meta that parses to a number", row: () => row("42") },
    { name: "a string meta that parses to an array", row: () => row(JSON.stringify([meta(findings())])) },
    { name: "a null envelope", row: () => row(meta(null)) },
    { name: "an array envelope", row: () => row(meta([findings()])) },
    { name: "a numeric envelope", row: () => row(meta(1)) },
    { name: "a DOUBLE-encoded envelope (a JSON string inside an object)", row: () => row(meta(JSON.stringify(findings()))) },
    // Version and identity.
    { name: "a FUTURE version", row: () => row(meta(findings({ version: 2 }))) },
    { name: "version zero", row: () => row(meta(findings({ version: 0 }))) },
    { name: "a version of the wrong type", row: () => row(meta(findings({ version: "1" }))) },
    { name: "no version", row: () => row(meta(findings({ version: undefined }))) },
    { name: "no teamId", row: () => row(meta(findings({ teamId: undefined }))) },
    { name: "a numeric teamId", row: () => row(meta(findings({ teamId: 42 }))) },
    // Phases.
    { name: "no convergence phase", row: () => row(meta(findings({ convergence: undefined }))) },
    { name: "a null convergence phase", row: () => row(meta(findings({ convergence: null }))) },
    { name: "an unknown convergence status", row: () => row(meta(findings({ convergence: { status: "degraded", error: { message: "x", truncated: false } } }))) },
    { name: "a failed convergence with no error object", row: () => row(meta(findings({ convergence: { status: "failed" } }))) },
    { name: "a failed convergence whose error is null", row: () => row(meta(findings({ convergence: { status: "failed", error: null } }))) },
    { name: "a failed convergence whose error is a bare string", row: () => row(meta(findings({ convergence: { status: "failed", error: "general: wedged" } }))) },
    { name: "an error message that is not a string", row: () => row(meta(findings({ convergence: { status: "failed", error: { message: 42, truncated: false } } }))) },
    { name: "an error with no message", row: () => row(meta(findings({ convergence: { status: "failed", error: { truncated: false } } }))) },
    { name: "an error truncation flag of the wrong type", row: () => row(meta(findings({ convergence: { status: "failed", error: { message: "x", truncated: "false" } } }))) },
    { name: "an error with no truncation flag", row: () => row(meta(findings({ convergence: { status: "failed", error: { message: "x" } } }))) },
    { name: "no census phase", row: () => row(meta(findings({ census: undefined }))) },
    { name: "an unknown census status", row: () => row(meta(findings({ census: censusFound({ status: "partial" }) }))) },
    { name: "findings with no census error object", row: () => row(meta(findings({ census: { status: "complete", total: 23 } }))) },
    { name: "a failed census with no error object", row: () => row(meta(findings({ census: { status: "failed", total: null }, sample: [], omitted: null }))) },
    // Counts.
    { name: "a COMPLETE census with a null total", row: () => row(meta(findings({ census: censusFound({ total: null }), sample: [], omitted: null }))) },
    { name: "a complete census with a null omitted", row: () => row(meta(findings({ omitted: null }))) },
    { name: "a non-integer total (and a consistent non-integer omitted)", row: () => row(meta(findings({ census: censusFound({ total: 23.5 }), omitted: 21.5 }))) },
    { name: "a total of the wrong type that still subtracts", row: () => row(meta(findings({ census: censusFound({ total: "23" }) }))) },
    { name: "an omitted of the wrong type that still compares loosely", row: () => row(meta(findings({ omitted: "21" }))) },
    { name: "a negative total (and a consistent negative omitted)", row: () => row(meta(findings({ census: censusFound({ total: -1 }), sample: [], omitted: -1 }))) },
    { name: "a NaN total", row: () => row(meta(findings({ census: censusFound({ total: Number.NaN }), sample: [], omitted: Number.NaN }))) },
    { name: "an infinite total (and a consistent infinite omitted)", row: () => row(meta(findings({ census: censusFound({ total: Infinity }), omitted: Infinity }))) },
    { name: "an omitted count that is not total − sample.length", row: () => row(meta(findings({ omitted: 0 }))) },
    { name: "no omitted count", row: () => row(meta(findings({ omitted: undefined }))) },
    { name: "MORE samples than findings (omitted −1)", row: () => row(meta(findings({ census: censusFound({ total: 1 }), omitted: -1 }))) },
    { name: "a FAILED census claiming a numeric total", row: () => row(meta(findings({ census: { ...censusFailed(), total: 0 }, sample: [], omitted: 0 }))) },
    { name: "a failed census with a numeric omitted", row: () => row(meta(findings({ census: censusFailed(), sample: [], omitted: 0 }))) },
    { name: "a failed census carrying samples", row: () => row(meta(findings({ census: censusFailed(), omitted: null }))) },
    // The producer NEVER emits these: a wholly clean state is ok with no evidence at all.
    { name: "a fabricated HEALTHY complete-zero envelope", row: () => row(meta(findings({ convergence: { status: "ok" }, census: { status: "complete", total: 0 }, sample: [], omitted: 0 }))) },
    { name: "a fabricated healthy envelope with an extra note", row: () => row(meta(findings({ convergence: { status: "ok" }, census: { status: "complete", total: 0 }, sample: [], omitted: 0, note: "looks fine" }))) },
    {
      name: "a fabricated healthy envelope dressed with error objects on its clean phases",
      row: () =>
        row(
          meta(
            findings({
              convergence: { status: "ok", error: { message: "x", truncated: false } },
              census: { status: "complete", total: 0, error: { message: "x", truncated: false } },
              sample: [],
              omitted: 0,
            })
          )
        ),
    },
    // Samples.
    { name: "no sample", row: () => row(meta(findings({ sample: undefined }))) },
    { name: "a sample that is an array-LIKE object", row: () => row(meta(findings({ sample: { 0: sampleA(), 1: sampleB(), length: 2 } }))) },
    { name: "a sample that is a string", row: () => row(meta(findings({ sample: "ab" }))) },
    { name: "seventeen samples", row: () => row(meta(findings({ census: censusFound({ total: 40 }), sample: samples(17), omitted: 23 }))) },
    { name: "a null sample entry", row: () => row(meta(findings({ sample: [sampleA(), null] }))) },
    { name: "a string sample entry", row: () => row(meta(findings({ sample: [sampleA(), "general→vendors"] }))) },
    { name: "a sample with no groupId", row: () => row(meta(findings({ sample: [sampleA(), { ...sampleB(), groupId: undefined }] }))) },
    { name: "a sample id that is not a UUID", row: () => row(meta(findings({ sample: [sampleA(), { ...sampleB(), groupId: "not-a-uuid" }] }))) },
    { name: "a numeric sample id", row: () => row(meta(findings({ sample: [{ ...sampleA(), projectId: 7 }, sampleB()] }))) },
    { name: "a slug that is not a string", row: () => row(meta(findings({ sample: [{ ...sampleA(), projectSlug: 42 }, sampleB()] }))) },
    { name: "a display slug of 97 ASCII bytes", row: () => row(meta(findings({ sample: [sampleA(), { ...sampleB(), groupSlug: "g".repeat(97) }] }))) },
    { name: "a display slug of 49 two-byte characters (98 bytes, 49 characters)", row: () => row(meta(findings({ sample: [sampleA(), { ...sampleB(), groupSlug: "é".repeat(49) }] }))) },
    { name: "a slug truncation flag of the wrong type", row: () => row(meta(findings({ sample: [sampleA(), { ...sampleB(), groupSlugTruncated: "no" }] }))) },
    { name: "a sample with no truncation flag", row: () => row(meta(findings({ sample: [{ ...sampleA(), projectSlugTruncated: undefined }, sampleB()] }))) },
    // Contextual error budgets — the labelled compound these arms came from is at most 480 bytes.
    { name: "a lone convergence reason of 468 bytes", row: () => row(meta(lone("v".repeat(468)))) },
    { name: "a lone convergence reason of 234 two-byte characters (468 bytes, 234 characters)", row: () => row(meta(lone("é".repeat(234)))) },
    { name: "a lone census reason of 473 bytes", row: () => row(meta(unavailable("c".repeat(473)))) },
    { name: "two arms one byte over the 457-byte pool at 234 + 224", row: () => row(meta(dual(234, 224))) },
    { name: "two arms one byte over the pool at 100 + 358", row: () => row(meta(dual(100, 358))) },
    // Serialized size.
    {
      // Sixteen samples, every slug within its own 96-byte budget — and 576 bytes once escaped.
      name: "an OBJECT namespace whose escaped serialization exceeds 8,192 bytes",
      row: () => row(meta(findings({ census: censusFound({ total: 16 }), sample: samples(16, "\u0001".repeat(96)), omitted: 0 }))),
    },
    {
      // 8,000 bytes in 4,000 characters: a `.length` bound would let this through.
      name: "a string meta above 8,192 UTF-8 BYTES but under 8,192 characters",
      row: () => row(JSON.stringify(meta(findings(), { padding: "é".repeat(4000) }))),
    },
  ];

  it.each(REFUSED)("refuses $name", ({ row: make }) => {
    expect(decode(make())).toBeNull();
  });

  it("refuses the same malformed envelopes when they arrive as a legacy string", () => {
    for (const envelope of [findings({ version: 2 }), findings({ teamId: OTHER_TEAM }), findings({ omitted: 0 }), dual(234, 224), findings({ sample: [sampleA(), { ...sampleB(), groupSlug: "g".repeat(97) }] })]) {
      expect(decode(row(JSON.stringify(meta(envelope))))).toBeNull();
    }
  });

  it("the object-namespace fixture above is refused for its ESCAPED size alone", () => {
    const heavy = findings({ census: censusFound({ total: 16 }), sample: samples(16, "\u0001".repeat(96)), omitted: 0 });
    const light = findings({ census: censusFound({ total: 16 }), sample: samples(16, "a".repeat(96)), omitted: 0 });
    expect(wrapperBytes(heavy), "fixture: the escaped wrapper is over budget").toBeGreaterThan(BUDGET.metaBytes);
    expect(wrapperBytes(light), "fixture: the same shape in plain ASCII — the heavy one's UNescaped size — is inside it").toBeLessThanOrEqual(BUDGET.metaBytes);

    expect(decode(row(meta(light))), "raw-character accounting would accept both").toStrictEqual(light);
    expect(decode(row(meta(heavy)))).toBeNull();
  });

  it("accepts a known-field namespace of EXACTLY 8,192 bytes and refuses 8,193, object or string", () => {
    const { heavy, filler } = calibrateBoundary();
    const at = boundaryCandidate(heavy, filler, BOUNDARY_KEEP);
    const over = boundaryCandidate(heavy, filler + 1, BOUNDARY_KEEP);
    expect(wrapperBytes(at), "fixture: exactly the budget").toBe(8192);
    expect(wrapperBytes(over), "fixture: one byte over, every field still inside its own budget").toBe(8193);

    expect(decode(row(meta(at)))).toStrictEqual(boundaryCandidate(heavy, filler, BOUNDARY_KEEP));
    expect(decode(row(JSON.stringify(meta(at))))).toStrictEqual(boundaryCandidate(heavy, filler, BOUNDARY_KEEP));
    expect(decode(row(meta(over)))).toBeNull();
    expect(decode(row(JSON.stringify(meta(over))))).toBeNull();
  });

  it("bounds a legacy string at 8,192 bytes BEFORE parsing it", () => {
    const json = JSON.stringify(meta(findings()));
    // Trailing whitespace keeps the text valid JSON and the envelope untouched: only the size differs.
    const at = json + " ".repeat(BUDGET.metaBytes - bytes(json));
    const over = `${at} `;
    expect(bytes(at)).toBe(8192);
    expect(bytes(over)).toBe(8193);

    expect(decode(row(at)), "8,192 bytes is inside the bound").toStrictEqual(findings());

    // Observe, restore, THEN assert: nothing but the decoder runs while JSON.parse is watched.
    const parse = vi.spyOn(JSON, "parse");
    let refused: Evidence | null;
    let parsed: number;
    try {
      refused = decode(row(over));
      parsed = parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }
    expect(refused, "well-formed and otherwise valid — refused on size alone").toBeNull();
    expect(parsed, "and never handed to the parser").toBe(0);
  });

  it("checks the sample's length BEFORE touching any entry", () => {
    const guarded = (length: number, indexes: number[]) => {
      const touched: number[] = [];
      const sample = new Array(length);
      for (const i of indexes) {
        Object.defineProperty(sample, i, {
          enumerable: true,
          get() {
            touched.push(i);
            return samples(1)[0];
          },
        });
      }
      return { sample, touched };
    };
    const seventeen = guarded(17, Array.from({ length: 17 }, (_, i) => i));
    const enormous = guarded(100_000, [0, 1, 99_999]);

    expect(decode(row(meta(findings({ census: censusFound({ total: 40 }), sample: seventeen.sample, omitted: 23 }))))).toBeNull();
    expect(decode(row(meta(findings({ census: censusFound({ total: 100_000 }), sample: enormous.sample, omitted: 0 }))))).toBeNull();
    expect(seventeen.touched, "an over-long sample is refused unread").toEqual([]);
    expect(enormous.touched).toEqual([]);
  });

  // ── Producer → decoder ──────────────────────────────────────────────────────────────────────────

  it.each<{ name: string; input: () => Input }>([
    { name: "convergence failed, known-zero census", input: () => loneConvergence(REFUSAL) },
    { name: "convergence ok, census findings", input: () => loneCensus([{ projectId: pid(1), projectSlug: "general", groupId: gid(1), groupSlug: "vendors" }]) },
    {
      name: "both failed, forty findings",
      input: () => ({
        teamId: TEAM,
        convergence: { status: "failed", message: WEDGED },
        census: census(Array.from({ length: 40 }, (_, i) => ({ projectId: pid(1), projectSlug: "sys", groupId: gid(40 - i), groupSlug: `g${pad2(i)}` }))),
      }),
    },
    { name: "convergence ok, census unavailable", input: () => ({ teamId: TEAM, convergence: { status: "ok" }, census: { status: "failed", message: "failed: census exploded" } }) },
    { name: "both failed, census unavailable, both arms cut", input: () => ({ teamId: TEAM, convergence: { status: "failed", message: "V".repeat(2000) }, census: { status: "failed", message: "C".repeat(2000) } }) },
    { name: "a hostile message normalized to U+FFFD", input: () => loneConvergence("bad\u0000nul \uD83D lone-high \uDE00 lone-low ok 😀 pair") },
    {
      name: "a byte-trimmed sample at exactly 8,192 bytes",
      input: () => {
        const { heavy, filler } = calibrateBoundary();
        return boundaryInput(heavy, filler);
      },
    },
  ])("round-trips what the builder emits for $name — object and string", ({ input }) => {
    const built = failed(input());
    const stored = meta(built.evidence);

    expect(decode(row(stored))).toStrictEqual(built.evidence);
    expect(decode(row(JSON.stringify(stored)))).toStrictEqual(built.evidence);
    // The same envelope on anyone else's row, on a global row or on an ok row is not evidence.
    expect(decode(row(stored, { team_id: OTHER_TEAM }))).toBeNull();
    expect(decode(row(stored, { team_id: null }))).toBeNull();
    expect(decode(row(stored, { ok: true }))).toBeNull();
  });
});
