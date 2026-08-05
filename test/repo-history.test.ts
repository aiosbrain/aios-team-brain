import { describe, expect, it, vi } from "vitest";
import { commitSinceIso, linkGithubRepo, resolveRepoHistory, type RepoHistoryEntry } from "@/lib/integrations/github-link";
import { fetchGithubRepoIssues } from "@/lib/ingest/sources/github";
import { validateIntegrationConfig } from "@/lib/api/schemas";

/**
 * The per-repo history window's storage semantics (AIO-798). Two contracts carry the whole design:
 *
 * 1. THE ANCHOR IS READ BACK VERBATIM. `sinceIso` is resolved once at link; if the importer ever
 *    recomputed `now − days`, the window would SLIDE — and because a repo's issues are one
 *    diff-synced item, issues aging out of a sliding fetch are diff-DELETED from the brain, tick
 *    after tick (the plan-review blocker on this design's first draft).
 * 2. ABSENT MEANS ABSENT. A repo with no entry imports exactly as before this feature existed —
 *    `.optional()` at the schema, null from the resolver, and the importer's optional-chaining
 *    passes `undefined` through to today's defaults.
 */

describe("resolveRepoHistory", () => {
  const entry = { repo: "Acme/Widgets", days: 14, sinceIso: "2026-08-04T01:02:03.000Z" };

  it("returns the stored anchor VERBATIM — never recomputed", () => {
    const hit = resolveRepoHistory({ repoHistory: [entry] }, "acme/widgets");
    expect(hit?.sinceIso).toBe("2026-08-04T01:02:03.000Z");
    expect(hit?.days).toBe(14);
  });

  it("matches case-insensitively, like every other repo comparison in this panel", () => {
    expect(resolveRepoHistory({ repoHistory: [entry] }, "ACME/WIDGETS")).not.toBeNull();
  });

  it("no entry → null → the pre-window behaviour (the existing-behaviour pin)", () => {
    expect(resolveRepoHistory({}, "acme/widgets")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: [] }, "acme/widgets")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: [entry] }, "other/repo")).toBeNull();
  });

  it("malformed entries are ignored, not thrown on — config is external data", () => {
    expect(resolveRepoHistory({ repoHistory: [{ repo: "a/b" }] }, "a/b")).toBeNull();
    expect(resolveRepoHistory({ repoHistory: "nonsense" }, "a/b")).toBeNull();
  });
});

/**
 * The COMMIT leg's cutoff (AIO-807). AIO-798 threaded the window into both windowed fetches, but by
 * two different routes: issues got the stored anchor, commits got `days` re-resolved to `now − days`
 * on every tick. At `days: 0` that is `since = now` every hour, so a commit pushed BETWEEN two
 * scheduler runs is newer than run N's cutoff and older than run N+1's — never fetched by either, and
 * the repo's contributor graphs stay permanently empty while nothing reports an error.
 *
 * `commitSinceIso` resolves it from the anchor instead, floored at the repo's own window so the walk
 * stays bounded on a link that is years old.
 */
describe("commitSinceIso (AIO-807)", () => {
  const T0 = Date.parse("2026-08-01T00:00:00.000Z");
  const DAY = 86_400_000;
  const at = (ms: number) => new Date(ms).toISOString();
  const entry = (days: number, anchorMs: number): RepoHistoryEntry => ({
    repo: "acme/widgets",
    days,
    sinceIso: at(anchorMs),
  });

  it("THE BUG: at days=0 a commit pushed between two ticks is inside the next tick's window", () => {
    // Linked at T0 with "No history"; the importer ticks two hours later. A commit authored at
    // T0 + 1h must be fetched. The shipped expression yields `now` (T0 + 2h) and misses it forever.
    const since = commitSinceIso(entry(0, T0), T0 + 2 * 3_600_000);
    expect(Date.parse(since)).toBeLessThanOrEqual(T0 + 3_600_000);
  });

  it("days=0 asks for NO backfill — the cutoff is the link instant, not earlier", () => {
    expect(commitSinceIso(entry(0, T0), T0 + 2 * 3_600_000)).toBe(at(T0));
  });

  it("no entry → the 90-day sliding window, byte-identical to the pre-window behaviour", () => {
    expect(commitSinceIso(null, T0)).toBe(at(T0 - 90 * DAY));
  });

  it("an anchor older than the floor is bounded by it — a 200-day-old link walks 90 days, not 200", () => {
    expect(commitSinceIso(entry(0, T0 - 200 * DAY), T0)).toBe(at(T0 - 90 * DAY));
  });

  it("a recent anchor is honoured exactly — days=14 linked 5 days ago fetches from link − 14d", () => {
    const linkedAt = T0 - 5 * DAY;
    expect(commitSinceIso(entry(14, linkedAt - 14 * DAY), T0)).toBe(at(linkedAt - 14 * DAY));
  });

  it("the floor NEVER widens a narrow choice: days=14 linked 200 days ago floors at 90, not at link − 14d", () => {
    expect(commitSinceIso(entry(14, T0 - 214 * DAY), T0)).toBe(at(T0 - 90 * DAY));
  });

  it("a window WIDER than 90 days floors at its own width — the estimate quoted 365 days of commits", () => {
    // `days` is capped at 3650 by the action + schema, not at the panel's 90 (actions.ts, schemas.ts).
    // A flat 90-day floor would silently truncate this repo's backfill on its very first sync.
    expect(commitSinceIso(entry(365, T0 - 365 * DAY), T0)).toBe(at(T0 - 365 * DAY));
  });

  it("an anchor in the FUTURE falls back to the floor — never to `now`, which would rebuild the bug", () => {
    // Clock skew at link time, or any non-panel config write. `since` in the future returns [] forever.
    expect(commitSinceIso(entry(0, T0 + 30 * DAY), T0)).toBe(at(T0 - 90 * DAY));
  });

  it("an unparseable anchor degrades to the floor rather than propagating NaN", () => {
    const broken = { repo: "acme/widgets", days: 0, sinceIso: "not-a-date" } as RepoHistoryEntry;
    expect(commitSinceIso(broken, T0)).toBe(at(T0 - 90 * DAY));
  });
});

describe("github config schema — repoHistory (AIO-798)", () => {
  it("accepts the anchored array shape", () => {
    const out = validateIntegrationConfig("github", {
      repos: ["acme/widgets"],
      repoHistory: [{ repo: "acme/widgets", days: 14, sinceIso: "2026-08-04T01:02:03.000Z" }],
    }) as { repoHistory?: unknown[] };
    expect(out.repoHistory).toHaveLength(1);
  });

  it("an absent repoHistory stays ABSENT — legacy rows must remain byte-identical", () => {
    // `.optional()`, never `.default([])`: this is also the existing normalization pin.
    expect(validateIntegrationConfig("github", {})).toEqual({ repos: [] });
  });

  it("a repo whose NAME looks like a secret survives the secret-key scan (array shape, not Record keys)", () => {
    // The Record<full_name, days> shape died here: the scan walks nested object KEYS, so
    // `acme/token-service` in key position made the whole config unsavable (plan-review blocker).
    const out = validateIntegrationConfig("github", {
      repos: ["acme/token-service"],
      repoHistory: [{ repo: "acme/token-service", days: 30, sinceIso: "2026-08-04T00:00:00.000Z" }],
    }) as { repoHistory?: unknown[] };
    expect(out.repoHistory).toHaveLength(1);
  });

  it("rejects a malformed anchor and unknown entry keys", () => {
    expect(() =>
      validateIntegrationConfig("github", {
        repoHistory: [{ repo: "a/b", days: 14, sinceIso: "not-a-date" }],
      })
    ).toThrow();
    expect(() =>
      validateIntegrationConfig("github", {
        repoHistory: [{ repo: "a/b", days: 14, sinceIso: "2026-08-04T00:00:00.000Z", extra: 1 }],
      })
    ).toThrow();
  });
});

describe("linkGithubRepo — history-entry attribution (the re-add blocker)", () => {
  /** Minimal DbClient double: one existing github row; captures what upsertIntegration would write.
   *  Mirrors only the two call shapes github-link makes — enough to observe the config payload. */
  function dbWith(config: Record<string, unknown>, captured: { config?: Record<string, unknown> }) {
    const row = { name: "github", status: "enabled", config };
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle: async () => ({ data: table === "integrations" ? row : null }) }),
              }),
            }),
          }),
        }),
        upsert: (payload: { config: Record<string, unknown> }) => {
          captured.config = payload.config;
          return { select: () => ({ single: async () => ({ data: { id: "x", status: "enabled" }, error: null }) }) };
        },
        insert: async () => ({ error: null }),
      }),
    };
  }

  it("re-adding an ALREADY-LINKED repo re-anchors THAT repo — never the last repo in the list", async () => {
    // The blocker this pins: addRepo de-dups, so on a re-add `repos` returns unchanged and its last
    // element is some OTHER repo. Positional attribution re-anchored + narrowed the innocent repo's
    // window — whose next sync would diff-delete its imported issues.
    const innocent: RepoHistoryEntry = { repo: "acme/web", days: 90, sinceIso: "2026-01-01T00:00:00.000Z" };
    const captured: { config?: Record<string, unknown> } = {};
    const db = dbWith({ repos: ["acme/api", "acme/web"], repoHistory: [innocent] }, captured);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await linkGithubRepo(db as any, { teamId: "t", memberId: "m" }, "acme/api", 14);
    const history = captured.config?.repoHistory as RepoHistoryEntry[];
    const web = history.find((e) => e.repo === "acme/web");
    const api = history.find((e) => e.repo === "acme/api");
    expect(web, "the untouched repo keeps its entry").toEqual(innocent);
    expect(api?.days).toBe(14);
  });
});

describe("fetchGithubRepoIssues — the anchor reaches the wire", () => {
  it("sends since= ALONGSIDE state=all, verbatim", async () => {
    // Closing an issue bumps updated_at, so closed-in-window issues import only because BOTH params
    // are on the URL; and the anchor must be the stored value, not a recomputed one.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await fetchGithubRepoIssues({
      owner: "acme",
      repo: "api",
      sinceIso: "2026-07-21T00:00:00.000Z",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[0]).toContain("state=all");
    expect(seen[0]).toContain(`since=${encodeURIComponent("2026-07-21T00:00:00.000Z")}`);
  });

  it("no anchor → no since param (the pre-window fetch, byte-identical)", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await fetchGithubRepoIssues({ owner: "acme", repo: "api", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seen[0]).not.toContain("since=");
  });
});
