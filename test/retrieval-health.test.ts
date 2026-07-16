import { describe, expect, it } from "vitest";
import { deriveDenseState, deriveGraphState, graphConfigured } from "@/lib/query/retrieval-health";

// Spec: the dense-leg state machine must separate off / building / degraded / healthy so the admin
// card tells the truth — especially "degraded" (erroring or stalled, red) vs "building" (catching
// up, amber). This is the logic that would have flagged the silent OpenAI-quota outage.

const base = {
  configured: true,
  pgvectorLoaded: true,
  embeddable: 100,
  embedded: 100,
  lastRunFailed: false,
  lastEmbeddedAtMs: Date.parse("2026-07-09T12:00:00Z"),
  nowMs: Date.parse("2026-07-09T12:10:00Z"),
};

describe("deriveDenseState", () => {
  it("off when embeddings aren't configured or pgvector isn't loaded", () => {
    expect(deriveDenseState({ ...base, configured: false })).toBe("off");
    expect(deriveDenseState({ ...base, pgvectorLoaded: false })).toBe("off");
  });

  it("degraded when the most recent embedding run failed (the quota/outage case)", () => {
    expect(deriveDenseState({ ...base, lastRunFailed: true })).toBe("degraded");
  });

  it("healthy at ≥90% coverage, or when there's nothing to embed", () => {
    expect(deriveDenseState({ ...base, embeddable: 100, embedded: 95 })).toBe("healthy");
    expect(deriveDenseState({ ...base, embeddable: 0, embedded: 0 })).toBe("healthy");
  });

  it("building when incomplete but recently progressing (amber, not red)", () => {
    expect(deriveDenseState({ ...base, embeddable: 100, embedded: 40 })).toBe("building");
  });

  it("degraded when incomplete AND stalled (no recent embed activity)", () => {
    expect(deriveDenseState({ ...base, embeddable: 100, embedded: 40, lastEmbeddedAtMs: null })).toBe("degraded");
    const stale = Date.parse("2026-07-09T09:00:00Z"); // >2h before now
    expect(deriveDenseState({ ...base, embeddable: 100, embedded: 40, lastEmbeddedAtMs: stale })).toBe("degraded");
  });
});

describe("graphConfigured", () => {
  it("false for the malformed 'http://' that prod actually had", () => {
    expect(graphConfigured("http://")).toBe(false);
  });
  it("false for unset or garbage", () => {
    expect(graphConfigured(undefined)).toBe(false);
    expect(graphConfigured("not a url")).toBe(false);
  });
  it("true for a real http(s) URL with a host", () => {
    expect(graphConfigured("http://graphiti.railway.internal:8000")).toBe(true);
    expect(graphConfigured("https://graph.example.com")).toBe(true);
  });
});

describe("deriveGraphState", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");
  const fresh = Date.parse("2026-07-15T11:00:00Z"); // 1h ago
  const stale = Date.parse("2026-07-08T12:00:00Z"); // 7d ago
  it("off when not configured (regardless of reachability)", () => {
    expect(deriveGraphState({ configured: false, reachable: false, lastProjectedAtMs: null, nowMs: now })).toBe("off");
    expect(deriveGraphState({ configured: false, reachable: true, lastProjectedAtMs: fresh, nowMs: now })).toBe("off");
  });
  it("on when reachable AND recently projected", () => {
    expect(deriveGraphState({ configured: true, reachable: true, lastProjectedAtMs: fresh, nowMs: now })).toBe("on");
  });
  it("on when reachable and nothing has projected yet (null = fresh install, not a stall)", () => {
    expect(deriveGraphState({ configured: true, reachable: true, lastProjectedAtMs: null, nowMs: now })).toBe("on");
  });
  it("degraded when configured BUT unreachable — the silent-failure case reviving must surface", () => {
    expect(deriveGraphState({ configured: true, reachable: false, lastProjectedAtMs: fresh, nowMs: now })).toBe("degraded");
  });
  it("degraded when reachable BUT projector stalled — the 2026-07 healthcheck-only blind spot", () => {
    // /healthcheck answers (reachable) yet no episode has landed in a week → writes are failing silently.
    expect(deriveGraphState({ configured: true, reachable: true, lastProjectedAtMs: stale, nowMs: now })).toBe("degraded");
  });
});
