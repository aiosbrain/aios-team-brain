import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * PRET-4 AC4 (docs/design/pret4-tier-wall-teardown.md §3.3/§4.4): `members.tier` is the
 * invite-default RECORD — no production read path may consult it for access. This guard pins
 * the REAL record-read shapes (the mutate-with-the-real-shape rule, cold-read M1):
 *
 *  - the adapter shape: a `.from("members")` chain whose `.select(...)` string names `tier`
 *    (incl. the api-keys embed `members(... tier ...)`);
 *  - the raw-SQL shape: `m.tier` / `members.tier` on a line that is actually SQL (carries a
 *    SQL keyword) — the gateway lease predicate's shape.
 *
 * Downstream PROPERTY access (`me.tier`, `memberTier`) is deliberately NOT scanned: since the
 * §1a boundary swap those values ARE posture — the guard polices where the value is BORN, not
 * where it flows. Comments are stripped before scanning so prose about tier can't trip it.
 *
 * The allowlist entries carry their §3.3 reasons verbatim — a new entry without a reason is a
 * review flag by construction.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** §3.3's sanctioned consumers, exhaustively, with reasons. */
const ALLOWLIST: Record<string, string> = {
  "lib/access/groups.ts": "the single writer: materialization's one-time read + the M3 tier mirror write",
  "lib/admin/members.ts": "createMember writes the invite default; upsert change-detection read",
  "lib/admin/invite.ts": "invite plumbing passes the invite-default through to provisioning",
  "lib/admin/access-health.ts": "BlindPrincipal.tier — a DIAGNOSTIC payload field in the health report (PRET-6 re-home)",
  "lib/provisioning/linear.ts": "external-system seat mapping (Linear guest/user) — non-access",
  "lib/access/agent-tokens.ts": "token mint/verify semantics — program §8, untouched",
  "lib/gateway/persistence.ts": "gateway lease predicate — delegated-token semantics, program §8",
  "lib/gateway/admin-persistence.ts": "gateway policy persistence — program §8",
  "lib/gateway/policy.ts": "gateway policy evaluation — program §8",
  "lib/graph/company-actors.ts": "actor attrs mirror the roster record — metadata, not an access input",
  "lib/metrics/codebases.ts": "roster-metadata read (display fields incl. the record)",
  "app/api/v1/members/route.ts": "SERVES tier as a roster wire field (the record as metadata)",
  "app/api/v1/members/invite/route.ts": "re-invite reuses the stored invite-default record",
  "app/api/v1/identities/resolve/route.ts": "serves the record as roster metadata in its payload",
  "app/t/[team]/admin/members/actions.ts": "re-invite passes the stored record to the invite core",
  "app/t/[team]/admin/members/page.tsx": "displays the record on the admin roster",
  "scripts/admin.ts": "CLI writes + list-members display",
};

/** Directories that hold production source. test/ is exempt by construction. */
const SCAN_DIRS = ["lib", "app", "scripts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/[^"'`]*$/gm, "");
}

/** The record-read shapes that actually exist in this repo. */
const MEMBERS_SELECT_SHAPE = /\.from\("members"\)[\s\S]{0,200}?\.select\(\s*["'`][^"'`]*\btier\b[^"'`]*["'`]/;
const EMBED_SHAPE = /\.select\(\s*["'`][^"'`]*members\([^)]*\btier\b[^)]*\)[^"'`]*["'`]/;
const RAW_SQL_SHAPE = /^.*\b(?:select|update|where|and|join|from)\b.*\b(?:m|members)\.tier\b.*$/im;

describe("guard: members.tier is never an access input outside the sanctioned files (PRET-4 AC4)", () => {
  const offenders: Array<{ file: string; shape: string }> = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, abs).replaceAll("\\", "/");
      if (rel in ALLOWLIST) continue;
      const src = stripComments(readFileSync(abs, "utf8"));
      if (MEMBERS_SELECT_SHAPE.test(src)) offenders.push({ file: rel, shape: "members-select" });
      else if (EMBED_SHAPE.test(src)) offenders.push({ file: rel, shape: "members-embed" });
      else if (RAW_SQL_SHAPE.test(src)) offenders.push({ file: rel, shape: "raw-sql" });
    }
  }

  it("no production source reads the members.tier record outside the allowlist", () => {
    expect(
      offenders,
      "a new tier consumer must be added to the allowlist WITH its §3.3 reason — or, far more likely, should read posture (lib/access/posture) instead"
    ).toEqual([]);
  });

  it("every allowlist entry still exists and still references tier (no stale ceremony rows)", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const src = readFileSync(join(ROOT, rel), "utf8"); // throws if the file is gone → stale entry
      expect(/\btier\b/.test(src), `${rel} no longer references tier — remove its allowlist row`).toBe(true);
    }
  });

  it("the guard's shapes are non-vacuous: each matches a real, still-existing sanctioned read", () => {
    // Self-test (one-condition-per-fixture): each shape regex individually matches a known
    // sanctioned read, so an emptied/broken regex cannot pass silently.
    const groups = stripComments(readFileSync(join(ROOT, "lib/access/groups.ts"), "utf8"));
    expect(MEMBERS_SELECT_SHAPE.test(groups), "members-select shape matches the materialization's one-time read").toBe(true);
    const gateway = stripComments(readFileSync(join(ROOT, "lib/gateway/persistence.ts"), "utf8"));
    expect(RAW_SQL_SHAPE.test(gateway), "raw-sql shape matches the gateway lease predicate").toBe(true);
    const auth = stripComments(readFileSync(join(ROOT, "lib/api/auth.ts"), "utf8"));
    expect(EMBED_SHAPE.test(auth), "embed shape matches the api-key join — which must stay allowlist-OUT (its tier field is dead weight) or be re-argued").toBe(false);
  });
});
