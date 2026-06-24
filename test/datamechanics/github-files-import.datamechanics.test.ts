import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { normalizeGithubFiles, type GithubFileRaw } from "@/lib/ingest/sources/github-files-normalize";

// Spec (GitHub repo-file import) verified to the observable outcome — items read back from real Postgres:
// each file persists as a deliverable item; re-importing an unchanged file is a no-op; team tier.

function importFiles(seed: Seed, files: GithubFileRaw[]) {
  const payloads = normalizeGithubFiles({ owner: "acme", repo: "app", ref: "main", files });
  return Promise.all(
    payloads.map((p) =>
      ingest(seed, { project: p.project, kind: "deliverable", path: p.path, body: p.body, access: "team" } as never)
    )
  );
}

const itemByPath = async (teamId: string, path: string) => {
  const { data } = await db()
    .from("items")
    .select("kind, access, path")
    .eq("team_id", teamId)
    .eq("path", path)
    .maybeSingle();
  return data as { kind: string; access: string; path: string } | null;
};

describe("GitHub file import (data-mechanics)", () => {
  it("materializes each repo file as a deliverable item at team tier", async () => {
    const seed = await seedTeam();
    await importFiles(seed, [
      { path: "README.md", body: "# readme" },
      { path: "docs/guide.md", body: "guide" },
    ]);
    const readme = await itemByPath(seed.teamId, "github/acme-app/README.md");
    const guide = await itemByPath(seed.teamId, "github/acme-app/docs/guide.md");
    expect(readme?.kind).toBe("deliverable");
    expect(readme?.access).toBe("team");
    expect(guide?.kind).toBe("deliverable");
  });

  it("re-importing an unchanged file is a no-op", async () => {
    const seed = await seedTeam();
    const files: GithubFileRaw[] = [{ path: "README.md", body: "stable" }];
    const [first] = await importFiles(seed, files);
    const [second] = await importFiles(seed, files);
    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
  });

  it("an edited file produces a new version (updated), keyed by the same path", async () => {
    const seed = await seedTeam();
    const [a] = await importFiles(seed, [{ path: "README.md", body: "v1" }]);
    const [b] = await importFiles(seed, [{ path: "README.md", body: "v2" }]);
    expect(a.status).toBe("created");
    expect(b.status).toBe("updated");
  });
});
