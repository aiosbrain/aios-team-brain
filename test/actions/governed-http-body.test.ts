import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: vi.fn(async () => ({ memberId: "member" })),
}));
import { createGovernedActionHttp } from "@/lib/actions/governed/http";
import { governedActions } from "@/lib/actions/governed";

describe("governed HTTP body bounds", () => {
  it("stops oversized streaming input and closes its connection without cancelling before response", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulls === 32) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const submit = vi.fn();
    const http = createGovernedActionHttp({ ...governedActions, submit });
    const request = new Request("http://local/api/v1/actions/submit", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await http.submit(request);
    expect(response.status).toBe(422);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_payload" },
    });
    expect(submit).not.toHaveBeenCalled();
    expect(pulls).toBeLessThanOrEqual(6); // one buffered chunk plus the first over-limit chunk
    expect(cancelled).toBe(false);
  });

  it("does not force-close a fully consumed malformed JSON request", async () => {
    const submit = vi.fn();
    const http = createGovernedActionHttp({ ...governedActions, submit });
    const response = await http.submit(
      new Request("http://local/api/v1/actions/submit", {
        method: "POST",
        body: "{",
      }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("connection")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});
