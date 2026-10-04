import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: vi.fn(async () => ({ memberId: "member" })),
}));
import { authenticateApiKey } from "@/lib/api/auth";
import { createGovernedActionHttp } from "@/lib/actions/governed/http";
import { governedActions } from "@/lib/actions/governed";
import { POST as submitRoute } from "@/app/api/v1/actions/submit/route";
import { GET as statusRoute } from "@/app/api/v1/actions/[action_id]/route";

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

// AIO-1208 AC-07: the route-auth inventory registers `governedActionHttp.submit`/`.status` as the
// guard of their two routes. That registration is only sound if the wrapper authenticates BEFORE
// it reads the body or reaches the service. The authenticator's own refusals (missing, invalid,
// revoked, inactive owner) are proved against the real owner in test/auth-wrapper-evidence.test.ts.
describe("governed HTTP wrappers authenticate before dispatch", () => {
  const ACTION_ID = "11111111-2222-4333-8444-555555555555";
  const authenticator = vi.mocked(authenticateApiKey);
  const submitUrl = "http://local/api/v1/actions/submit";
  const statusUrl = `http://local/api/v1/actions/${ACTION_ID}`;

  /** A well-formed submit body whose stream records whether the wrapper ever read it. */
  function countedSubmit() {
    let pulls = 0;
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "task.create" }));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = new Request(submitUrl, { method: "POST", body, duplex: "half" } as RequestInit & {
      duplex: "half";
    });
    return { request, pulls: () => pulls };
  }
  const services = () => ({ submit: vi.fn(), status: vi.fn() });
  const wrapper = (service: ReturnType<typeof services>) => createGovernedActionHttp({ ...governedActions, ...service });

  afterEach(() => {
    authenticator.mockClear();
    vi.restoreAllMocks();
  });

  it("submit refuses a failed authentication with 401 — body unread, service never called", async () => {
    authenticator.mockResolvedValueOnce(null);
    const service = services();
    const { request, pulls } = countedSubmit();
    const response = await wrapper(service).submit(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(request, { recordUsage: false, preserveErrors: true });
    expect(pulls()).toBe(0);
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
  });

  it("status refuses a failed authentication with 401 before the status service", async () => {
    authenticator.mockResolvedValueOnce(null);
    const service = services();
    const request = new Request(statusUrl);
    const response = await wrapper(service).status(request, ACTION_ID);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(request, { recordUsage: false, preserveErrors: true });
    expect(service.status).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("an authenticator fault is a retryable 503, never a dispatch or a default admission", async () => {
    const service = services();
    authenticator.mockRejectedValueOnce(new Error("Authentication unavailable"));
    const { request, pulls } = countedSubmit();
    const submitted = await wrapper(service).submit(request);
    expect(submitted.status).toBe(503);
    expect(submitted.headers.get("retry-after")).toBe("1");
    expect(await submitted.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(pulls()).toBe(0);

    authenticator.mockRejectedValueOnce(new Error("Authentication unavailable"));
    const status = await wrapper(service).status(new Request(statusUrl), ACTION_ID);
    expect(status.status).toBe(503);
    expect(JSON.stringify(await status.json())).not.toContain("Authentication unavailable");
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
  });

  it("admitted control: both wrappers dispatch with exactly the authenticated principal", async () => {
    const principal = { memberId: "member-7", teamId: "team-7" };
    const service = services();
    service.submit.mockResolvedValue({ status: "succeeded", action_id: ACTION_ID });
    service.status.mockResolvedValue({ status: "succeeded", action_id: ACTION_ID });

    authenticator.mockResolvedValueOnce(principal as never);
    const { request } = countedSubmit();
    const submitted = await wrapper(service).submit(request);
    expect(submitted.status).toBe(200);
    expect(service.submit).toHaveBeenCalledExactlyOnceWith(principal, { type: "task.create" });

    authenticator.mockResolvedValueOnce(principal as never);
    const status = await wrapper(service).status(new Request(statusUrl), ACTION_ID);
    expect(status.status).toBe(200);
    expect(service.status).toHaveBeenCalledExactlyOnceWith(principal, ACTION_ID);
  });

  it("the shipped route handlers refuse through the same wrapper before the production service", async () => {
    const submit = vi.spyOn(governedActions, "submit");
    const status = vi.spyOn(governedActions, "status");

    authenticator.mockResolvedValueOnce(null);
    const { request, pulls } = countedSubmit();
    const submitted = await submitRoute(request);
    expect(submitted.status).toBe(401);
    expect(pulls()).toBe(0);

    authenticator.mockResolvedValueOnce(null);
    const read = await statusRoute(new Request(statusUrl), { params: Promise.resolve({ action_id: ACTION_ID }) });
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ error: { code: "unauthorized" } });

    expect(submit).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
