import { describe, expect, it } from "vitest";
import { renderDecisionBody } from "@/lib/decisions/service";
import { parseSubmitRequest } from "@/lib/actions/governed/contract";

const request = (params = {}) => ({
  contract_version: "mcp-next/1", type: "decision.record",
  destination: { project_id: "project" },
  params: { operation_id: "op", title: "Choose orbit", rationale: "Because it fits", impact: "", ...params },
});
describe("governed decision accepted content", () => {
  it("keeps every accepted character in its source representation", () => {
    const fields = { title: "\u00a0Orbit | \\\n", rationale: "\tReason\r\n$& &#10; <tag>\u2003", impact: " 😀 " };
    const body = renderDecisionBody(fields);
    for (const value of Object.values(fields)) expect(body).toContain(value);
  });
  it("accepts code-point limits and required empty impact without normalizing", () => {
    const r = parseSubmitRequest(request({ title: "😀".repeat(500), rationale: "r".repeat(25000) }));
    expect(r.params).toMatchObject({ title: "😀".repeat(500), impact: "" });
    expect(() => parseSubmitRequest(request({ rationale: "r".repeat(25001) }))).toThrow();
    expect(() => parseSubmitRequest(request({ title: "  " }))).toThrow();
  });
  it("refuses additional attribution, access and date fields", () => {
    for (const field of ["actor", "created_by", "decided_by", "audience", "decided_at", "row_key"])
      expect(() => parseSubmitRequest(request({ [field]: "forged" }))).toThrow();
  });
});
