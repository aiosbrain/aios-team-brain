import { describe, expect, it } from "vitest";
import { GraphitiClient } from "@/lib/graph/graphiti-client";

// Spec (diagnosability): a non-2xx from Graphiti must carry the response BODY in the thrown error —
// a FastAPI 422 on POST /messages includes the exact Pydantic validation detail (which field/why).
// Without it, a wedged projector is an undiagnosable "→ 422". This is what surfaces the real cause
// in the graph_project ingest_runs error + logs.

function clientWithFetch(status: number, body: string): GraphitiClient {
  const fetchImpl = (async () =>
    new Response(body, { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  return new GraphitiClient({ baseUrl: "http://graphiti.test", fetchImpl });
}

describe("GraphitiClient error surfacing", () => {
  it("includes the 422 response body (Pydantic detail) in the thrown error", async () => {
    const detail = '{"detail":[{"loc":["body","messages",0,"timestamp"],"msg":"Input should be a valid datetime","type":"datetime_type"}]}';
    const client = clientWithFetch(422, detail);
    await expect(
      client.addEpisodes("aios:team", [
        { name: "items:1", content: "hi", timestamp: "not-a-date", sourceDescription: "x" },
      ])
    ).rejects.toThrow(/422.*timestamp|422.*Input should be a valid datetime/);
  });
});
