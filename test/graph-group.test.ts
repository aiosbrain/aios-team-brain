import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { projectGroupId, graphGroupIdsForVisibleProjects, episodeGroupId, visibleGroupIds } from "@/lib/graph/group";

// Phase C slice 1 (spec §6) — the per-project graph partition-key scheme. The load-bearing proofs:
// the key is charset-valid (Graphiti's validate_group_id gotcha) and compact; it's collision-free per
// (team, project); the oracle→group-id mapping dedups and fails CLOSED on an empty visible set; and
// the existing tier scheme is UNCHANGED (additive slice).

const CHARSET = /^[A-Za-z0-9_-]+$/;

describe("projectGroupId (per-project graph partition key)", () => {
  it("is g_<teamId-hex>_p_<projectId-hex> — hyphen-stripped, charset-valid, compact", () => {
    const team = randomUUID();
    const project = randomUUID();
    const id = projectGroupId(team, project);
    expect(id).toBe(`g_${team.replace(/-/g, "")}_p_${project.replace(/-/g, "")}`);
    expect(id, "must satisfy Graphiti's validate_group_id charset").toMatch(CHARSET);
    expect(id).not.toContain("-"); // hyphens stripped
    expect(id.length).toBe(2 + 32 + 3 + 32); // g_ + 32 + _p_ + 32 = 69
  });

  it("is collision-free: different (team, project) pairs → different ids", () => {
    const t1 = randomUUID(), t2 = randomUUID(), p1 = randomUUID(), p2 = randomUUID();
    const ids = new Set([
      projectGroupId(t1, p1), projectGroupId(t1, p2), projectGroupId(t2, p1), projectGroupId(t2, p2),
    ]);
    expect(ids.size, "four distinct pairs → four distinct group ids").toBe(4);
    // Distinct even when the two uuids are swapped between the team and project slots.
    expect(projectGroupId(t1, p1)).not.toBe(projectGroupId(p1, t1));
  });

  it("fails LOUD on a non-UUID input that leaves an invalid char (would kill the ingest worker)", () => {
    expect(() => projectGroupId("team:with:colons", randomUUID())).toThrow(/invalid/i);
    expect(() => projectGroupId(randomUUID(), "proj with spaces")).toThrow(/invalid/i);
  });
});

describe("graphGroupIdsForVisibleProjects (oracle → searchable graphs)", () => {
  it("maps each visible project to its group id, deduped", () => {
    const team = randomUUID();
    const p1 = randomUUID(), p2 = randomUUID();
    const got = graphGroupIdsForVisibleProjects(team, [p1, p2, p1]); // p1 duplicated
    expect(got.sort()).toEqual([projectGroupId(team, p1), projectGroupId(team, p2)].sort());
  });

  it("an EMPTY visible set → [] (searches nothing — fail closed, never 'search everything')", () => {
    expect(graphGroupIdsForVisibleProjects(randomUUID(), [])).toEqual([]);
    expect(graphGroupIdsForVisibleProjects(randomUUID(), new Set())).toEqual([]);
  });
});

describe("the tier scheme is UNCHANGED (additive slice)", () => {
  it("episodeGroupId / visibleGroupIds still produce the tier-suffixed ids", () => {
    expect(episodeGroupId("acme", "team")).toBe("acme_team");
    expect(episodeGroupId("acme", "external")).toBe("acme_external");
    expect(visibleGroupIds("acme", "team")).toEqual(["acme_team", "acme_external"]);
    expect(visibleGroupIds("acme", "external")).toEqual(["acme_external"]);
  });
});
