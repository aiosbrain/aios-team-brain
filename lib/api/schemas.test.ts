import { describe, expect, it } from "vitest";
import {
  codebaseRecordSchema,
  itemPayloadSchema,
  normalizeTier,
  normalizeTaskStatus,
  TASK_STATUSES,
  taskRowSchema,
} from "@/lib/api/schemas";

describe("normalizeTier", () => {
  it("passes team through", () => {
    expect(normalizeTier("team")).toBe("team");
  });
  it("maps outward labels to external", () => {
    expect(normalizeTier("external")).toBe("external");
    expect(normalizeTier("client")).toBe("external");
    expect(normalizeTier("company")).toBe("external");
  });
  it("rejects admin/private/unknown as null (never stored)", () => {
    expect(normalizeTier("admin")).toBeNull();
    expect(normalizeTier("private")).toBeNull();
    expect(normalizeTier("wat")).toBeNull();
  });
});

describe("normalizeTaskStatus", () => {
  it("accepts canonical statuses, clearing raw_status", () => {
    expect(normalizeTaskStatus("in_progress")).toEqual({ status: "in_progress", raw_status: null });
    expect(normalizeTaskStatus("done")).toEqual({ status: "done", raw_status: null });
  });
  it("normalizes spacing/case/dashes", () => {
    expect(normalizeTaskStatus("In Progress")).toEqual({ status: "in_progress", raw_status: null });
    expect(normalizeTaskStatus("IN-PROGRESS")).toEqual({ status: "in_progress", raw_status: null });
  });
  it("falls back to backlog, preserving the original in raw_status", () => {
    expect(normalizeTaskStatus("waiting on legal")).toEqual({
      status: "backlog",
      raw_status: "waiting on legal",
    });
  });

  // brain-api v1.21 (AIO-950): `in_review` joins the canonical set, between `in_progress` and
  // `blocked`. The WIRE shape is unchanged — `status` is still a free string the server folds —
  // so this adds a normalization TARGET; it rejects nothing that used to be accepted.
  describe("in_review (brain-api v1.21)", () => {
    it("folds every spelling of In Review onto in_review, clearing raw_status", () => {
      for (const spelling of ["in_review", "In Review", "in-review", "IN REVIEW", "  In  Review  "]) {
        expect(normalizeTaskStatus(spelling)).toEqual({ status: "in_review", raw_status: null });
      }
    });

    it("sits between in_progress and blocked in the canonical order", () => {
      expect([...TASK_STATUSES]).toEqual([
        "backlog",
        "ready",
        "in_progress",
        "in_review",
        "blocked",
        "done",
      ]);
    });

    it("leaves the other five statuses exactly as they were", () => {
      for (const s of ["backlog", "ready", "in_progress", "blocked", "done"]) {
        expect(normalizeTaskStatus(s)).toEqual({ status: s, raw_status: null });
        expect(normalizeTaskStatus(s.replace(/_/g, " ").toUpperCase())).toEqual({
          status: s,
          raw_status: null,
        });
      }
    });

    it("an unknown status still behaves exactly as before (backlog + raw_status)", () => {
      expect(normalizeTaskStatus("in reviewing")).toEqual({
        status: "backlog",
        raw_status: "in reviewing",
      });
      expect(normalizeTaskStatus("todo")).toEqual({ status: "backlog", raw_status: "todo" });
      expect(normalizeTaskStatus("")).toEqual({ status: "backlog", raw_status: "" });
    });
  });
});

describe("itemPayloadSchema", () => {
  const valid = {
    project: "p",
    path: "github/o/r/x.md",
    kind: "deliverable",
    content_sha256: "a".repeat(64),
    access: "team",
    body: "hello",
  };
  it("accepts a minimal valid payload and applies defaults", () => {
    const parsed = itemPayloadSchema.parse(valid);
    expect(parsed.actor).toBe("");
    expect(parsed.frontmatter).toEqual({});
  });
  it("rejects a non-hex sha", () => {
    expect(itemPayloadSchema.safeParse({ ...valid, content_sha256: "NOTHEX" }).success).toBe(false);
  });
  it("rejects an unknown kind", () => {
    expect(itemPayloadSchema.safeParse({ ...valid, kind: "email" }).success).toBe(false);
  });
});

describe("taskRowSchema", () => {
  it("requires a non-empty row_key", () => {
    expect(taskRowSchema.safeParse({ row_key: "", title: "t" }).success).toBe(false);
    expect(taskRowSchema.safeParse({ row_key: "T-1", title: "t" }).success).toBe(true);
  });
});

describe("codebaseRecordSchema.slug route-safety", () => {
  // slug becomes a /codebases/[slug] path segment, so the ingest boundary must
  // reject anything that would break or mis-route a detail link.
  it("accepts real repo names", () => {
    for (const slug of ["aios-team-brain", "llama_index", "Next.js", "repo123"]) {
      expect(codebaseRecordSchema.safeParse({ slug }).success, slug).toBe(true);
    }
  });
  it("rejects slugs that would break the route segment", () => {
    for (const slug of ["evil/../x", "a?b", "a#frag", "has space", "", "a/b"]) {
      expect(codebaseRecordSchema.safeParse({ slug }).success, slug).toBe(false);
    }
  });
});
