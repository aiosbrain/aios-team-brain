import { describe, it, expect } from "vitest";
import { normalizeGithubFiles, type NormalizeGithubFilesInput } from "@/lib/ingest/sources/github-files-normalize";
import { itemPayloadSchema } from "@/lib/api/schemas";

// Spec (GitHub repo-file import): each text file → its own kind="deliverable" item keyed by a stable
// path, idempotent via sha256 (the native port of the Python sidecar's GitHub source).

const base: NormalizeGithubFilesInput = { owner: "acme", repo: "App", ref: "main", files: [] };

describe("normalizeGithubFiles", () => {
  it("maps each file to one valid deliverable ItemPayload with provenance frontmatter", () => {
    const items = normalizeGithubFiles({
      ...base,
      files: [
        { path: "README.md", body: "# Hello", htmlUrl: "https://github.com/acme/App/blob/main/README.md" },
        { path: "docs/guide.md", body: "guide body" },
      ],
    });
    expect(items).toHaveLength(2);
    for (const it of items) expect(() => itemPayloadSchema.parse(it)).not.toThrow();

    const readme = items[0];
    expect(readme.kind).toBe("deliverable");
    expect(readme.project).toBe("github-acme-app");
    expect(readme.path).toBe("github/acme-app/README.md");
    expect(readme.access).toBe("team");
    expect(readme.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readme.frontmatter.source).toBe("github");
    expect(readme.frontmatter.repo).toBe("acme/App");
    expect(readme.frontmatter.repo_path).toBe("README.md");
    expect(readme.body).toBe("# Hello");

    expect(items[1].path).toBe("github/acme-app/docs/guide.md"); // nested path preserved
  });

  it("changing a file's body shifts its content_sha256 (not a no-op at the writer)", () => {
    const mk = (body: string) => normalizeGithubFiles({ ...base, files: [{ path: "a.md", body }] })[0];
    expect(mk("v1").content_sha256).not.toBe(mk("v2").content_sha256);
  });

  it("carries the file's last-commit author into actor + frontmatter (the resolution keys)", () => {
    const [it] = normalizeGithubFiles({
      ...base,
      files: [{ path: "docs/x.md", body: "b", authorName: "Chetan", authorEmail: "c@acme.dev", authorLogin: "chetan-gh" }],
    });
    expect(it.actor).toBe("Chetan");
    expect(it.frontmatter.author_email).toBe("c@acme.dev"); // reliable member-resolution key
    expect(it.frontmatter.author_login).toBe("chetan-gh");
    expect(() => itemPayloadSchema.parse(it)).not.toThrow();
  });

  it("omits author frontmatter keys when the commit-author lookup came up empty (unattributed, not connector)", () => {
    const [it] = normalizeGithubFiles({ ...base, files: [{ path: "a.md", body: "b" }] });
    expect(it.actor).toBe("");
    expect(it.frontmatter.author_email).toBeUndefined();
  });
});
