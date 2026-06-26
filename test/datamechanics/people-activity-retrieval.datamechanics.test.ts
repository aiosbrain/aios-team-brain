import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam, sha } from "./helpers";

// Spec: the payoff of the attribution work — once items carry the author's member_id, "what is each
// person doing" is answerable across Slack/PM/docs (not just git). The digest counts each person's
// attributed items by source, excludes git (its own digest) and connector members, team-tier only.

async function addMember(teamId: string, email: string, name: string): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: teamId, email, display_name: name, actor_handle: `h-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function put(
  teamId: string,
  actorMemberId: string,
  authorMemberId: string | null,
  o: { project: string; path: string; kind: string; source: string; body: string }
) {
  const payload = {
    project: o.project,
    path: o.path,
    kind: o.kind as "transcript" | "deliverable" | "artifact",
    actor: "",
    content_sha256: sha(o.body),
    access: "team" as const,
    frontmatter: { source: o.source },
    body: o.body,
  };
  return ingestItem(db(), { teamId, memberId: actorMemberId, apiKeyId: randomUUID() }, payload, "team", { authorMemberId });
}

describe("people-activity digest in retrieval (real Postgres)", () => {
  it("summarizes each person's attributed activity by source; excludes git + connector members", async () => {
    const seed = await seedTeam();
    const alex = await addMember(seed.teamId, "alex@corp.com", "Alex Rivera");
    const connector = await addMember(seed.teamId, "slack-sync@connector.local", "Slack Sync");

    // Alex's attributed activity across tools (ingested BY the connector, attributed TO Alex).
    await put(seed.teamId, connector, alex, { project: "slack", path: "slack/eng/1.md", kind: "transcript", source: "slack", body: "a" });
    await put(seed.teamId, connector, alex, { project: "slack", path: "slack/eng/2.md", kind: "transcript", source: "slack", body: "b" });
    await put(seed.teamId, connector, alex, { project: "linear-eng", path: "linear/eng/ENG-1.md", kind: "deliverable", source: "linear", body: "c" });
    // A git commit attributed to Alex — must NOT be counted here (git has its own digest).
    await put(seed.teamId, connector, alex, { project: "commits", path: "commits/r/x.md", kind: "artifact", source: "git", body: "d" });
    // An UNATTRIBUTED slack item → stays on the connector member; must be excluded.
    await put(seed.teamId, connector, null, { project: "slack", path: "slack/eng/3.md", kind: "transcript", source: "slack", body: "e" });

    const ctx = await retrieve(db(), seed.teamId, "team", "what is everyone doing?");
    expect(ctx.structured).toContain("## Activity by person");
    expect(ctx.structured).toContain("Alex Rivera (alex@corp.com)");
    expect(ctx.structured).toContain("2 slack, 1 linear"); // git excluded (else it'd be "…, 1 git")
    expect(ctx.structured).not.toContain("Slack Sync"); // connector member excluded
  });

  it("is hidden from an external-tier viewer", async () => {
    const seed = await seedTeam();
    const alex = await addMember(seed.teamId, "alex@corp.com", "Alex Rivera");
    await put(seed.teamId, seed.memberId, alex, { project: "slack", path: "slack/eng/1.md", kind: "transcript", source: "slack", body: "a" });
    const ext = await retrieve(db(), seed.teamId, "external", "what is everyone doing?");
    expect(ext.structured).not.toContain("Activity by person");
  });
});
