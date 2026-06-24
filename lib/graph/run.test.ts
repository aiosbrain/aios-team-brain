import { describe, expect, it, vi } from "vitest";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import { runGraphProjection } from "@/lib/graph/run";

// Spec: the runner is the on-ramp for projection, but it must be INERT where Graphiti isn't
// configured (prod has no GRAPHITI_URL) — a clean skip, never a DB hit or a throw. The configured
// aggregation path is covered against real Postgres in the data-mechanics tier.
describe("runGraphProjection (configured gate)", () => {
  it("is a clean no-op when Graphiti is not configured — and never touches the DB", async () => {
    const client = new GraphitiClient({ baseUrl: "" });
    const from = vi.fn(() => {
      throw new Error("DB must not be touched when Graphiti is unconfigured");
    });
    const res = await runGraphProjection({ client, supabase: { from } as never });

    expect(res.configured).toBe(false);
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ teams: 0, scanned: 0, projected: 0, skipped: 0, errors: [] });
    expect(from).not.toHaveBeenCalled();
  });
});
