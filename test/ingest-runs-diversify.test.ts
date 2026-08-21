import { describe, expect, it } from "vitest";
import { diversifyBySource } from "@/lib/ingest/runs";

// GRAPHSAT-1 (Codex diff review L3): hourly graph measurement rows must not bury connector history on
// the 30-row Integrations panel.
const row = (source: string, i: number) => ({ source, finished_at: `2026-01-01T${String(23 - i).padStart(2, "0")}:00:00Z`, i });

describe("diversifyBySource", () => {
  it("caps a chatty source at half the panel while other sources have rows, keeping newest-first order", () => {
    const graph = Array.from({ length: 20 }, (_, i) => row("graph_project", i)); // newest 20 are all graph
    const slack = Array.from({ length: 5 }, (_, i) => row("slack", 20 + i)); // older
    const sorted = [...graph, ...slack];
    const out = diversifyBySource(sorted, 10);
    expect(out.filter((r) => r.source === "graph_project")).toHaveLength(5);
    expect(out.filter((r) => r.source === "slack")).toHaveLength(5);
    expect(out.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 20, 21, 22, 23, 24]); // global newest-first preserved
  });
  it("lifts the cap once other sources are exhausted — the panel is never left short", () => {
    const graph = Array.from({ length: 20 }, (_, i) => row("graph_project", i));
    const slack = [row("slack", 30)];
    const out = diversifyBySource([...graph, ...slack], 10);
    expect(out).toHaveLength(10);
    expect(out.filter((r) => r.source === "graph_project")).toHaveLength(9);
  });
  it("a single-source history is unchanged (no cap applies when nothing is displaced)", () => {
    const graph = Array.from({ length: 8 }, (_, i) => row("graph_project", i));
    expect(diversifyBySource(graph, 10).map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
