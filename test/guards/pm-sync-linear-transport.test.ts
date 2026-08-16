import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { linearGraphql, linearMutation, isMutationDocument } from "@/lib/pm-sync/linear-client";

/**
 * PMSUCCESS-1 — two layers, two DIFFERENT properties, and the second one exists because the first two
 * designs for it were broken in review before any code was written.
 *
 *   LAYER 1 (runtime): `linearGraphql` refuses a `mutation` document unless it came through
 *     `linearMutation`. It sees the string actually being sent, so const-hoisting, concatenation,
 *     re-export, namespace import, `await import()` and `require` all fail at once.
 *   LAYER 2 (static): only an allowlist of files may import the raw transport at all. This bounds the
 *     blast radius; it does NOT prove writes are checked, and the history of this ticket is why that
 *     distinction is written down:
 *
 * A draft specced the import allowlist as the PRIMARY guard, modelled on `llm-single-caller`. Both
 * reviewers produced the same fatal counter-example: that guard skips allowlisted files WHOLESALE, and
 * `lib/pm-sync/linear.ts` must be allowlisted for its read-only queries while also being the file that
 * holds every projection mutation — so a new mutation added there introduces no new import and reddens
 * nothing. The runtime test below is exactly that case.
 *
 * The two layers are mutation-tested SEPARATELY. A sibling layer that catches the same outcome is how a
 * mutation survives while looking caught, so neither is allowed to stand in for the other.
 */

const ROOT = process.cwd();
const KEY = "lin_test";
const never: typeof fetch = (() => {
  throw new Error("the transport must refuse before it reaches the network");
}) as unknown as typeof fetch;

const ok = (payload: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ data: payload }), { status: 200 })) as unknown as typeof fetch;

describe("PMSUCCESS-1 layer 1 — the transport refuses an unverified mutation AT RUNTIME", () => {
  it("refuses a mutation document sent through the raw transport", async () => {
    await expect(
      linearGraphql(never, KEY, `mutation Bypass($id: String!) { issueArchive(id: $id) { success } }`, {})
    ).rejects.toThrow(/raw transport/i);
  });

  it("THE CASE THE IMPORT ALLOWLIST MISSED: a mutation assembled by concatenation is still refused", () => {
    // A source-text parser cannot see this document, and a file-level import allowlist does not care
    // that it exists. Built the way an evader would build it, not the way a happy path would.
    const verb = "muta" + "tion";
    const doc = `${verb} Sneaky($id: String!) { issueUpdate(id: $id, input: {}) { success issue { id } } }`;
    expect(isMutationDocument(doc)).toBe(true);
    return expect(linearGraphql(never, KEY, doc, {})).rejects.toThrow(/raw transport/i);
  });

  it("a QUERY still goes through untouched — the guard must not fail closed on reads", async () => {
    const data = await linearGraphql<{ viewer: { id: string } }>(
      ok({ viewer: { id: "u1" } }),
      KEY,
      `query Viewer { viewer { id } }`,
      {}
    );
    expect(data.viewer.id).toBe("u1");
  });

  it("an anonymous shorthand document is a QUERY, not a mutation — GraphQL's own default", async () => {
    const data = await linearGraphql<{ viewer: { id: string } }>(ok({ viewer: { id: "u2" } }), KEY, `{ viewer { id } }`, {});
    expect(data.viewer.id).toBe("u2");
  });

  it("the word `mutation` inside a COMMENT does not make a query a mutation", async () => {
    // Prose is not an invocation. Without this, documenting that a file sends no mutations is what
    // gets you flagged — which teaches people to delete the explanation.
    const data = await linearGraphql<{ viewer: { id: string } }>(
      ok({ viewer: { id: "u3" } }),
      KEY,
      // `} mutation` INSIDE the comment: the previous fixture said "not a mutation", whose `mutation`
      // is preceded by a space, so the anchor already rejected it and the comment-stripping term was
      // never exercised — deleting `stripGraphqlComments` left all 21 tests green (found by mutation).
      `# see the } mutation note below\nquery Viewer { viewer { id } }`,
      {}
    );
    expect(data.viewer.id).toBe("u3");
  });

  it("A COMMA is not a loophole: `,mutation …` is valid GraphQL and is still refused", async () => {
    // GraphQL treats commas as ignorable tokens, so Linear executes this document. The first version of
    // the regex used `\s*` and did not match it — one byte defeated the guard (found by review).
    await expect(
      linearGraphql(never, KEY, `,mutation Evil { issueDelete(id: "x") { success } }`, {})
    ).rejects.toThrow(/raw transport/i);
    await expect(
      linearGraphql(never, KEY, `query A { viewer { id } } , mutation B { issueDelete(id: "x") { success } }`, {})
    ).rejects.toThrow(/raw transport/i);
  });

  it("CONCURRENCY: a raw mutation is refused WHILE a verified mutation's fetch is in flight", async () => {
    // The original design raised a module-level boolean before awaiting the network and lowered it in
    // `finally`, so for the whole round-trip ANY concurrent raw mutation was waved through. Both
    // reviewers built this interleaving independently. There is no shared state now — the unguarded
    // transport is private — so this asserts the property rather than the implementation.
    let release: (r: Response) => void = () => {};
    const gated: typeof fetch = (async () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;

    const inFlight = linearMutation(
      gated,
      KEY,
      `mutation Good { issueCreate(input: {}) { success issue { id } } }`,
      {},
      { payload: "issueCreate", entity: "issue" }
    );

    // …while that one is parked on the network, a raw mutation must still be refused.
    await expect(
      linearGraphql(never, KEY, `mutation Evil { issueDelete(id: "x") { success } }`, {})
    ).rejects.toThrow(/raw transport/i);

    release(Response.json({ data: { issueCreate: { success: true, issue: { id: "i1" } } } }));
    await expect(inFlight).resolves.toBeDefined();
  });

  it("linearMutation refuses a NON-mutation document — the wrapper is not a way to smuggle reads", async () => {
    await expect(
      linearMutation(never, KEY, `query Viewer { viewer { id } }`, {}, { payload: "viewer", entity: "x" })
    ).rejects.toThrow(/non-mutation document/i);
  });
});

// ── LAYER 2 ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Files permitted to import the raw transport. Read-only callers plus the client's own module.
 * This bounds who can reach it; layer 1 is what makes a write through it impossible.
 */
const ALLOWLIST = new Set([
  "lib/pm-sync/linear.ts", // five read-only queries (bootstrap, members, states, issues)
  "lib/pm-sync/inbound.ts", // inbound issue reads
  "lib/ingest/sources/linear.ts", // the ingestion source — reads only
  "scripts/brain-tasks.ts", // an operator script — reads only
]);

const SCAN_DIRS = ["lib", "app", "scripts"];

function* walk(dir: string): Generator<string> {
  // `withFileTypes` rather than a `statSync` per entry: the naive version took ~50s over `app/`.
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
  }
}

/**
 * Comments are stripped before matching, for the reason the sibling guard already learned: the FIRST
 * run of this test flagged `lib/provisioning/linear.ts` because a comment there EXPLAINS that
 * `linearGraphql` refuses mutations now. Prose is not an import, and a guard that punishes the
 * explanation teaches people to delete the explanation.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const importers = (): string[] => {
  const hits: string[] = [];
  for (const d of SCAN_DIRS)
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === "lib/pm-sync/linear-client.ts") continue; // defines it
      if (/\blinearGraphql\b/.test(stripComments(readFileSync(file, "utf8")))) hits.push(rel);
    }
  return hits.sort();
};

describe("PMSUCCESS-1 layer 2 — only an allowlist may reach the raw transport", () => {
  it("no file outside the allowlist imports linearGraphql", () => {
    expect(importers().filter((f) => !ALLOWLIST.has(f))).toEqual([]);
  });

  it("every allowlist entry still exists AND still imports it — a rename cannot silently empty this", () => {
    // Without this, deleting or renaming every listed file leaves the assertion above quantifying over
    // nothing and passing. The allowlist is only a guard while its population is real.
    expect(ALLOWLIST.size).toBeGreaterThan(0);
    const live = new Set(importers());
    for (const rel of ALLOWLIST) {
      expect(() => statSync(join(ROOT, rel)), `${rel} is allowlisted but missing`).not.toThrow();
      expect(live.has(rel), `${rel} is allowlisted but no longer imports linearGraphql — drop it`).toBe(true);
    }
  });

  it("every lib/pm-sync mutation names an ENTITY — the entityless form may not spread into projection", () => {
    // `entityless` exists for one call site outside pm-sync whose payload entity could not be verified
    // from this repo. Inside pm-sync every payload returns an entity, so an `expect` that checks only
    // `success` there would be a weaker check arriving by omission.
    for (const file of walk(join(ROOT, "lib/pm-sync"))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === "lib/pm-sync/linear-client.ts") continue; // DEFINES the form; using it is the ban
      const src = stripComments(readFileSync(file, "utf8"));
      expect(src.includes("entityless"), `${rel} uses the entityless form inside lib/pm-sync`).toBe(false);
    }
  });
});
