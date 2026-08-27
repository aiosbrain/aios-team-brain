import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TAGS, nextTagPolicy } from "../../scripts/migrate-from-existing.mjs";

/**
 * RELPTR-1 — cutting a release used to be impossible without freezing the repo.
 * Spec: `docs/design/release-pointer-stable-branch.md`, criteria 1–9.
 *
 * THE DEADLOCK, because the assertions below only make sense against it. Two rules ran back to back
 * in `scripts/migrate-from-existing.mjs`:
 *
 *   - every declared tag must exist            → extend `DEFAULT_TAGS` first and the extension's own
 *                                                 PR throws `unknown git tag`
 *   - the newest existing tag must be declared → cut the tag first and EVERY open PR throws
 *                                                 `DEFAULT_TAGS is stale`, because this lane runs in
 *                                                 `ci.yml` on `pull_request`
 *
 * No ordering avoids a red window. The fix widens the first rule by EXACTLY ONE tag — the newest
 * declared one, i.e. a release being prepared — and the tests below are mostly about that boundary,
 * because a wider hole would delete the anti-rot property the staleness rule exists for.
 */

const ROOT = join(__dirname, "..", "..");
const REAL_TAGS = ["v0.10.0", "v0.9.0", "v0.8.0", "v0.7.0"]; // newest-first, as git reports them

/** A fully-CUT declared list, for policy semantics. Deliberately NOT `DEFAULT_TAGS`: the live list
 *  legitimately carries a declared-but-uncut release during preparation, and assertions that assumed
 *  otherwise turned red the moment a release was declared. */
const CUT_FIXTURE = ["v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"];

/**
 * Does THIS checkout have the release tags?
 *
 * It cannot be assumed. `ci.yml`'s "Brain unit tests" job checks out shallow and tagless — only the
 * migration lane asks for `fetch-depth: 0` — so the first version of this file called `git tag` and
 * `git cat-file` unconditionally, passed locally against a full clone, and FAILED on CI. A unit test
 * that needs history the unit tier does not fetch is a broken test, not a broken tier.
 *
 * So the guarantees below are carried by FIXTURE assertions that always run; the real-corpus checks are
 * an extra that runs where the history exists (a developer's clone, and the migration job's
 * environment). They are gated, never silently skipped in a way that could read as a pass.
 */
const gitTags = (() => {
  try {
    return execFileSync("git", ["tag", "--sort=-v:refname"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
})();
const HAS_RELEASE_TAGS = REAL_TAGS.every((t) => gitTags.includes(t));
const itWithTags = HAS_RELEASE_TAGS ? it : it.skip;

describe("release tag policy — the prepared release (criteria 1, 2, 5)", () => {
  it("ALLOWS the newest declared tag to be absent, and says so instead of throwing", () => {
    // FIXTURE list, not DEFAULT_TAGS. Two assertions here used to read the live declared list, so the
    // moment a release was DECLARED (`pending` stops being null, `usable` stops equalling the list)
    // they went red — the guard that exists to make releases possible would have blocked one. Policy
    // semantics are tested against fixtures; the live list gets its own legal-state check below.
    const res = nextTagPolicy([...CUT_FIXTURE, "v9.9.9"], REAL_TAGS);
    expect(res.pending).toBe("v9.9.9");
    expect(res.usable).toEqual(CUT_FIXTURE);
    expect(res.notice).toMatch(/declared but not yet cut/);
  });

  it("THROWS on a hole in the MIDDLE — the fix must not hide a typo", () => {
    // The whole risk of widening rule one is that `v0.8.5` (never existed) reads as "pending" forever
    // and the lane silently stops upgrading from it. Only the newest may be absent.
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.5", "v0.10.0"], REAL_TAGS)).toThrow(/unknown git tag: v0\.8\.5/);
  });

  it("REJECTS a leading-zero version as a release tag, so it cannot steal the exemption", () => {
    // `v01.2.3` and `v1.2.3` compare EQUAL through Number(), so a loose `\d+` grammar would let
    // `v01.2.3` rank as the newest declared release and take the exemption from the real one. With the
    // strict grammar it is not a release tag at all, so an absent one is a hole and throws.
    // (This assertion exists because the mutation that loosened the grammar SURVIVED without it.)
    expect(() => nextTagPolicy(["v0.10.0", "v01.2.3"], ["v0.10.0"])).toThrow(/unknown git tag: v01\.2\.3/);
  });

  it("picks the exempt tag by VERSION, not by list position", () => {
    // `v0.9.0` > `v0.10.0` under string sort. A list written out of order must not change which tag
    // is allowed to be missing, or the exemption moves under a harmless reformat.
    const res = nextTagPolicy(["v0.11.0", "v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"], REAL_TAGS);
    expect(res.pending).toBe("v0.11.0");
    expect(() => nextTagPolicy(["v0.11.0", "v0.9.5", "v0.10.0"], [...REAL_TAGS, "v0.11.0"])).toThrow(
      /unknown git tag: v0\.9\.5/
    );
  });
});

describe("release tag policy — the anti-rot rule survives (criteria 3, 4, 5)", () => {
  it("THROWS when a tag EXISTS that is newer than everything declared", () => {
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.0"], REAL_TAGS)).toThrow(/DEFAULT_TAGS is stale: v0\.10\.0/);
  });

  it("is NON-VACUOUS in both directions against the SHIPPED list", () => {
    // A check that only ever passes is indistinguishable from one that matches nothing — this repo has
    // shipped that failure before. Fixture-based, so it runs in every environment including a tagless
    // CI checkout.
    expect(() => nextTagPolicy(CUT_FIXTURE, REAL_TAGS)).not.toThrow();
    expect(() => nextTagPolicy(CUT_FIXTURE, ["v0.99.0", ...REAL_TAGS])).toThrow(/stale: v0\.99\.0/);
  });

  itWithTags("the LIVE declared list is in a legal state — the only thing that stays true mid-release", () => {
    // This is what replaced "nothing is pending". A declared-but-uncut tag is a legal state (it is how
    // a release is prepared); an illegal one is a middle hole or a stale list. Asserting legality holds
    // between releases AND during one, so declaring a release can never redden this file.
    expect(gitTags).toContain("v0.10.0");
    expect(() => nextTagPolicy(DEFAULT_TAGS, gitTags)).not.toThrow();
    // …and still non-vacuous against live git: a newer real tag nobody declared is a stale list.
    expect(() => nextTagPolicy(DEFAULT_TAGS, ["v0.99.0", ...gitTags])).toThrow(/stale: v0\.99\.0/);
  });

  it("DECLARES v0.11.0 — the intermediate release the PRET-6 upgrade path passes through", () => {
    // The mutation that removed it SURVIVED, which meant the entire point of the declaring PR was
    // pinned by nothing. Stated as the durable invariant rather than "is pending", because that is
    // true both before the tag is cut and forever after: `v0.11.0` is the release a pre-flip
    // installation must run before the retirement, so the migration lane has to keep exercising the
    // upgrade FROM it. Dropping it silently stops testing the path the fleet actually takes.
    expect(DEFAULT_TAGS).toContain("v0.11.0");
  });

  it("declares AT MOST ONE pending tag — two would reintroduce the middle-hole throw", () => {
    // GREEN BY CONSTRUCTION, first spelling: it built the "existing" set as DEFAULT_TAGS-minus-the-
    // newest, so declaring TWO uncut tags made the fixture pretend the older one existed and the
    // assertion passed. A guard that manufactures the very state it is checking for proves nothing —
    // and a sibling test caught the mutation, which is exactly how a vacuous layer hides.
    //
    // Counted against a STATIC known-cut fixture, not live git and not a set derived from DEFAULT_TAGS.
    // Both reviewers landed here: gating it on live tags would skip it in CI's TAGLESS unit job — the
    // one place it most needs to run — and deriving the set from DEFAULT_TAGS is what made it vacuous.
    // CUT_FIXTURE grows by one each time a release is actually cut, which is a deliberate edit.
    const declaredButAbsent = DEFAULT_TAGS.filter((t) => !CUT_FIXTURE.includes(t));
    expect(declaredButAbsent.length, `pending: ${declaredButAbsent.join(", ") || "none"}`).toBeLessThanOrEqual(1);
  });

  it("compares by version, so a newer tag cannot hide behind string ordering", () => {
    // `v0.9.0` sorts after `v0.10.0` as a string. If the stale check used string order it would miss
    // a real newer release, which is the exact silence the rule exists to prevent.
    expect(() => nextTagPolicy(["v0.9.0"], ["v0.10.0", "v0.9.0"])).toThrow(/stale: v0\.10\.0/);
  });

  it("REFUSES when every declared tag is pending — a lane that tests nothing must not report success", () => {
    // Found by attacking the function, not by review. `main()` gates runUpgrades on `usableTags.length`,
    // so an all-pending list makes the whole upgrade block vanish and the lane print success having
    // exercised no upgrade at all. Reachable with `--tags v0.11.0` against a checkout without tags.
    expect(() => nextTagPolicy(["v0.11.0"], [])).toThrow(/no usable upgrade tags/);
    expect(() => nextTagPolicy(["v0.11.0"], [])).toThrow(/reported success without testing/);
  });

  it("still ALLOWS an empty declared list — --mirror-only and --deletion-sweep-only pass one on purpose", () => {
    // The refusal above must not swallow the legitimate no-upgrades modes; that would break two flags
    // while fixing a fail-open, which is how a fix acquires its own regression.
    expect(nextTagPolicy([], ["v0.10.0"])).toEqual({ usable: [], pending: null, notice: null });
  });

  it("each outcome fires ALONE for an input that triggers only it", () => {
    expect(nextTagPolicy(CUT_FIXTURE, REAL_TAGS)).toEqual({ usable: CUT_FIXTURE, pending: null, notice: null });
    expect(nextTagPolicy([...CUT_FIXTURE, "v9.9.9"], REAL_TAGS).pending).toBe("v9.9.9");
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.5", "v0.10.0"], REAL_TAGS)).toThrow(/unknown git tag/);
    expect(() => nextTagPolicy(["v0.7.0"], REAL_TAGS)).toThrow(/stale/);
  });
});

describe("release tag policy — the real corpus is MIXED (criterion 6)", () => {
  it("the policy is NAME-based, so a mixed corpus cannot change its answer", () => {
    // Deterministic counterpart to the live check below: whatever object type a tag is, nextTagPolicy
    // sees a name. This is the property the lane relies on, and it holds in a tagless checkout too.
    expect(nextTagPolicy(["v0.9.0", "v0.10.0"], ["v0.10.0", "v0.9.0"])).toEqual({
      usable: ["v0.9.0", "v0.10.0"],
      pending: null,
      notice: null,
    });
  });

  itWithTags("this repo has both annotated and lightweight tags, which is why nothing may compare raw ref ids", () => {
    // Measured, not assumed: v0.7.0/v0.9.0 are annotated (the ref names a tag OBJECT), v0.8.0/v0.10.0
    // are lightweight (the ref names the commit). Any future check that compares a tag's ref id to a
    // commit id would silently miss half the releases — so this pins the property that makes peeling
    // mandatory, next to the policy that will need it.
    const typeOf = (t: string) =>
      execFileSync("git", ["cat-file", "-t", t], { cwd: ROOT, encoding: "utf8" }).trim();
    const types = Object.fromEntries(["v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"].map((t) => [t, typeOf(t)]));
    expect(new Set(Object.values(types))).toEqual(new Set(["tag", "commit"]));
    // …and `--points-at` peels both, which is the one gathering idiom that is safe.
    const peeled = execFileSync("git", ["tag", "--points-at", "v0.9.0^{commit}"], { cwd: ROOT, encoding: "utf8" });
    expect(peeled).toContain("v0.9.0");
  });
});

describe("release: the operator-facing commands must actually run (criteria 5, 6, 7)", () => {
  /** Fenced code blocks only — what a reader COPIES. Prose that discusses a command (including this
   *  file's own criteria, and the spec that describes this guard) must not trip it: the first spelling
   *  of a sibling guard in this program failed on the sentence explaining it. */
  function fencedCommands(md: string): string[] {
    // BOTH fence styles, and line CONTINUATIONS joined first. Review found four evasions of the first
    // spelling: a `~~~` fence, `npx tsx \` wrapped onto the next line, `pnpm dlx tsx`, and a false PASS
    // when `--conditions react-server` appeared AFTER the entrypoint — where node ignores it.
    // The info string may be anything (` ```SQL `, ` ```bash title=x `). The first spelling required
    // `[a-z]*`, so such a fence never matched — and worse, its CLOSING fence then paired with the NEXT
    // block's opener, inverting inside/outside for the rest of the file and letting later commands
    // escape the scan entirely. Match any info string, both fence styles.
    const blocks = [
      ...[...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]),
      ...[...md.matchAll(/~~~[^\n]*\n([\s\S]*?)~~~/g)].map((m) => m[1]),
    ];
    return blocks.flatMap((b) => b.replace(/\\\n\s*/g, " ").split("\n"));
  }

  /** A command that will throw on `server-only` before it reaches the database. */
  function throwsOnServerOnly(line: string): boolean {
    // Any runner that reaches tsx: npx / pnpm dlx / bunx / `npx --yes tsx` / a bare `tsx`. Keyed on the
    // ENTRYPOINT rather than the launcher, because the launcher list is exactly what rots.
    if (!/\btsx\b/.test(line) || !/scripts\/admin\.ts/.test(line)) return false;
    if (/\bnpm\s+run\s+admin\b/.test(line)) return false;
    // The condition must come BEFORE the entrypoint; after it, node never sees it. Space AND equals
    // forms are both valid and both accepted — flagging `--conditions=react-server` would be a false
    // positive on a correct command.
    const beforeEntry = line.slice(0, line.indexOf("scripts/admin.ts"));
    return !/--conditions[= ]react-server/.test(beforeEntry);
  }

  it("no doc publishes a bare `npx tsx scripts/admin.ts` — it throws on server-only before reaching the DB", () => {
    // `scripts/admin.ts` pulls in `lib/access/posture.ts`, which imports "server-only"; without
    // `--conditions react-server` the import throws. Every other invocation in this repo carries it
    // (`package.json`'s `admin` script, the admin skill, docs/CI-ARCHITECTURE.md) — but
    // docs/RELEASE-NOTES-pret6.md published the bare form on the MANDATORY PRET-6 upgrade path, where
    // an operator would hit the throw while trying to satisfy a deployment precondition.
    const docs = readdirSync(join(ROOT, "docs"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, md: readFileSync(join(ROOT, "docs", f), "utf8") }));
    const offenders: string[] = [];
    for (const { f, md } of docs) {
      for (const line of fencedCommands(md)) {
        if (throwsOnServerOnly(line)) offenders.push(`docs/${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is NON-VACUOUS: it flags the exact form that shipped", () => {
    // The guard above reports zero today. Prove the detector fires rather than matching nothing.
    const hits = (md: string) => fencedCommands(md).filter(throwsOnServerOnly);
    // The exact form that shipped…
    expect(hits("```bash\nnpx tsx scripts/admin.ts set-access-enforcement acme enforcing\n```")).toHaveLength(1);
    // …and each evasion review found. All four must be caught.
    expect(hits("~~~bash\nnpx tsx scripts/admin.ts list-members\n~~~"), "tilde fence").toHaveLength(1);
    expect(hits("```bash\nnpx tsx \\\n  scripts/admin.ts list-members\n```"), "continuation").toHaveLength(1);
    expect(hits("```bash\npnpm dlx tsx scripts/admin.ts list-members\n```"), "pnpm dlx").toHaveLength(1);
    expect(
      hits("```bash\nnpx tsx scripts/admin.ts list-members --conditions react-server\n```"),
      "condition AFTER the entrypoint is ignored by node"
    ).toHaveLength(1);
    // …and the correct forms stay clean.
    expect(hits("```bash\nnpm run admin -- set-access-enforcement acme enforcing\n```")).toHaveLength(0);
    expect(hits("```bash\nnpx tsx --conditions react-server scripts/admin.ts list-members\n```")).toHaveLength(0);
    expect(hits("```bash\nnpx tsx --conditions=react-server scripts/admin.ts list-members\n```"), "equals form is valid").toHaveLength(0);
    // …and the fence-pairing inversion an info string used to cause: the BAD command sits in a later
    // block, which the old regex stopped seeing entirely.
    expect(
      hits("```SQL\nselect 1;\n```\n\n```bash\nnpx tsx scripts/admin.ts list-members\n```"),
      "an info-string fence must not blind the scan to later blocks"
    ).toHaveLength(1);
    expect(hits("```bash\nbunx tsx scripts/admin.ts x\n```"), "bunx").toHaveLength(1);
  });

  it("no doc still teaches a verb PRET-6 DELETED", () => {
    // docs/OPS.md's "Rolling back" section published `set-access-enforcement … permissive` — a command
    // the retirement removed from the CLI. The prose prefix `… scripts/admin.ts` hid it from the
    // runner-based detector above, which is why this keys on the VERB instead. A stale rollback
    // instruction is worse than an absent one: it is found during an incident.
    const retired = "set-access-enforcement";
    expect(readFileSync(join(ROOT, "scripts", "admin.ts"), "utf8"), "the verb is retired at HEAD").not.toContain(retired);
    const docs = readdirSync(join(ROOT, "docs"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, md: readFileSync(join(ROOT, "docs", f), "utf8") }));
    const offenders: string[] = [];
    for (const { f, md } of docs) {
      for (const line of fencedCommands(md)) {
        // RELEASE-NOTES/RELEASING legitimately publish it for the v0.11.0 RELEASE, where it exists.
        if (line.includes(retired) && !/RELEASE-NOTES-pret6|RELEASING/.test(f)) offenders.push(`docs/${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("RELEASING.md gates the PRET-6 upgrade on a QUERY, not a log line", () => {
    // The boot retry lives in the scheduler, which only starts when ingestion is enabled — so a log
    // line is not evidence. Both preconditions must be checked directly.
    const doc = readFileSync(join(ROOT, "docs", "RELEASING.md"), "utf8");
    expect(doc).toMatch(/pret4_builtin_materialize/);
    expect(doc).toMatch(/access_enforcement\s*=\s*'permissive'/);
    expect(doc).toMatch(/INGEST_POLL_ENABLED/);
    expect(doc).toMatch(/release\/v0\.11\.0/);
    // …and says WHERE those steps run. Both the flip command and the column the gate reads are
    // DELETED by the retirement (`set-access-enforcement` absent at HEAD; `teams.access_enforcement`
    // dropped), so an operator running them after upgrading gets an error rather than a warning.
    expect(doc).toMatch(/not after the upgrade/);
  });
});

describe("release tag policy — the CALL SITE, not just the function (criterion 10)", () => {
  // BOTH reviewers led with this, and it is this repo's own recorded lesson: 14 green tests over a
  // pure function say nothing about whether anything CALLS it. Delete the `nextTagPolicy` call and
  // restore the old inline checks, or pass `tags` instead of `usableTags`, and every assertion above
  // stays green while the deadlock comes back — and it would surface only during a pending window,
  // i.e. on release day, the one day this fix exists for.
  const SRC = readFileSync(join(ROOT, "scripts", "migrate-from-existing.mjs"), "utf8");

  it("main() routes the declared tags THROUGH the policy", () => {
    expect(SRC).toMatch(/const policy = nextTagPolicy\(tags, known, \{ allowPending: usingDeclaration \}\)/);
  });

  it("main() upgrades from policy.usable — not from the raw declared list", () => {
    // `runUpgrades(tags, …)` would re-introduce `fatal: invalid object name` on a pending tag, which
    // is precisely the failure the policy removes.
    expect(SRC).toMatch(/if \(usableTags\.length\)/);
    expect(SRC).toMatch(/await runUpgrades\(usableTags,/);
    // The CALL, not the declaration: `async function runUpgrades(tags, …)` legitimately names `tags`,
    // and a first spelling of this assertion matched that and failed on correct code.
    expect(SRC).not.toMatch(/await runUpgrades\(tags,/);
  });

  it("the old inline checks are GONE, not merely bypassed", () => {
    // A revert that leaves the policy call in place but restores the throws above it would deadlock
    // exactly as before while this file stayed green.
    expect(SRC).not.toMatch(/for \(const tag of tags\) if \(!knownSet\.has\(tag\)\)/);
  });

  it("the pending exemption is reserved for the DECLARATION, not for --tags", () => {
    expect(SRC).toMatch(/const usingDeclaration = !argv\.includes\("--tags"\)/);
  });
});

describe("release tag policy — the lane's preconditions (criteria 7, 8, 9)", () => {
  it("ci.yml gives THE MIGRATION JOB full history and tags", () => {
    // The policy is meaningless against a shallow, tagless checkout: every declared tag would look
    // absent. Scoped to the migration job's own block rather than grepping the whole file — an
    // existential "some job has fetch-depth: 0" is satisfied by a sibling job and would survive the
    // exact regression it claims to catch (this repo's ∃-guard lesson).
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    // Split on job keys (two-space indent under `jobs:`) and take the whole job that runs the lane,
    // rather than guessing at offsets — a hand-computed slice got this wrong and read an adjacent job.
    const jobs = ci.split(/\n  (?=[a-z0-9_-]+:\n)/);
    const migrationJob = jobs.find((j) => j.includes("migrate-from-existing"));
    expect(migrationJob, "ci.yml must still run the migration lane").toBeTruthy();
    expect(migrationJob!, "the migration job itself needs fetch-depth: 0").toMatch(/fetch-depth:\s*0/);
    // Non-vacuity: a job that does NOT ask for full history must not satisfy this.
    const shallow = jobs.find((j) => !j.includes("fetch-depth: 0") && j.includes("steps:"));
    if (shallow) expect(shallow).not.toMatch(/fetch-depth:\s*0/);
  });

  it("docs/RELEASING.md records the cutover constraints, each pointing at a file that resolves", () => {
    // A constraint that names a file which no longer exists has rotted into prose. Six were found by
    // three review rounds; the guard keeps each anchored to something real.
    const doc = readFileSync(join(ROOT, "docs", "RELEASING.md"), "utf8");
    const anchors = [
      ".github/workflows/pr-review-gate.yml",
      ".github/dependabot.yml",
      ".github/workflows/aios-work-sync.yml",
      "CLAUDE.md",
      "scripts/migrate-from-existing.mjs",
      "docs/CI-ARCHITECTURE.md",
    ];
    for (const a of anchors) {
      expect(doc, `RELEASING.md must cite ${a}`).toContain(a);
      expect(() => readFileSync(join(ROOT, a), "utf8"), `${a} must resolve`).not.toThrow();
    }
  });

  it("no CURRENT-STATE prose hardcodes a brain-api version — history may, and must", () => {
    // Two live false claims were found while specifying: docs/OPS.md said v1.21 and CHANGELOG.md's
    // preamble said v1.22 while lib/api/version.ts declared 1.23.
    //
    // The first spelling of this guard scanned WHOLE files and failed on `**v1.15**` inside a dated
    // CHANGELOG entry — which is correct history, not drift. A guard that forbids a changelog from
    // recording what a past release implemented is a guard that would be deleted. So it is scoped to
    // the prose that speaks in the PRESENT tense: the CHANGELOG preamble (before the first release
    // heading) and OPS's contract paragraph. Both now DEFER to the declaration instead of copying it,
    // which is the only form that cannot drift.
    const declared = readFileSync(join(ROOT, "lib", "api", "version.ts"), "utf8").match(
      /BRAIN_API_VERSION\s*=\s*"([\d.]+)"/
    )?.[1];
    expect(declared, "lib/api/version.ts must declare a version").toBeTruthy();

    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const preamble = changelog.slice(0, changelog.indexOf("## ["));
    expect(preamble).toContain("lib/api/version.ts");
    const preambleClaims = [...preamble.matchAll(/\bv(1\.\d+)\b/g)].map((m) => m[1]);
    expect(preambleClaims, "the CHANGELOG preamble must not restate a contract revision").toEqual([]);

    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    const para = ops.slice(ops.indexOf("The brain-api wire contract is versioned"), ops.indexOf("### Where the version is pinned"));
    expect(para).toContain("lib/api/version.ts");
    const opsClaims = [...para.matchAll(/\*\*v(1\.\d+)\*\*/g)].map((m) => m[1]);
    for (const c of opsClaims) {
      expect(c, `docs/OPS.md states brain-api v${c}; lib/api/version.ts declares ${declared}`).toBe(declared);
    }
  });

  it("install.sh states that its default is trunk, and how to install a release instead", () => {
    // The old comment said the served copy "fetches a pinned ref" — a property the file does not have:
    // it pins whatever AIOS_REF is, and the default is `main`.
    //
    // The first spelling of THIS guard asserted the phrase was absent, and then failed on the
    // correction itself, which quotes the old claim in order to explain it. Quoting a corrected claim
    // is good documentation; a guard that punishes it is teaching the wrong lesson. So the invariant
    // is the one that actually helps a reader: the file says what the default is and how to pin.
    const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
    // The ASSIGNMENT, not just the prose: a guard that only reads comments passes while the default
    // silently becomes something else, which is the regression this file is about.
    expect(sh, "the default ref must still be main and still be overridable").toMatch(
      /REF="\$\{AIOS_REF:-main\}"/
    );
    expect(sh).toMatch(/--branch "\$REF"/);
    expect(sh, "must say the default is trunk").toMatch(/default is trunk/);
    expect(sh, "must show how to install a release").toMatch(/AIOS_REF=vX\.Y\.Z/);
    expect(sh, "must point at the release process").toMatch(/docs\/RELEASING\.md/);
  });
});
