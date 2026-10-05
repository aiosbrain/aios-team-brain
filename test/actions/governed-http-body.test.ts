import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: vi.fn(async () => ({ memberId: "member" })),
}));
import { authenticateApiKey } from "@/lib/api/auth";
import { createGovernedActionHttp } from "@/lib/actions/governed/http";
import { governedActions } from "@/lib/actions/governed";
import { POST as submitRoute } from "@/app/api/v1/actions/submit/route";
import { GET as statusRoute } from "@/app/api/v1/actions/[action_id]/route";

const authenticator = vi.mocked(authenticateApiKey);

// The authenticator mock is shared by EVERY test in this file, the body-bound ones included. Each
// test starts from empty call history, no queued one-shot verdict and the admitted default, so an
// exact-once assertion counts its own request only.
beforeEach(() => {
  authenticator.mockReset();
  authenticator.mockResolvedValue({ memberId: "member" } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

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
  const submitUrl = "http://local/api/v1/actions/submit";
  const statusUrl = `http://local/api/v1/actions/${ACTION_ID}`;
  const AUTH_OPTIONS = { recordUsage: false, preserveErrors: true };

  /**
   * A well-formed submit body that records whether the wrapper ever read it. The stream is
   * demand-driven (`highWaterMark: 0`): a default-strategy stream is pulled once to fill its queue
   * before any reader exists, so only here does a pull mean a consumer asked for bytes. `getReader`
   * is spied on the very stream the wrapper receives as `req.body`.
   */
  function countedSubmit() {
    let pulls = 0;
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "task.create" }));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(submitUrl, { method: "POST", body, duplex: "half" } as RequestInit & {
      duplex: "half";
    });
    const stream = request.body;
    if (!stream) throw new Error("fixture request has no body stream");
    const getReader = vi.spyOn(stream, "getReader");
    return { request, stream, getReader, pulls: () => pulls };
  }
  /** No reader was taken, no chunk was requested, and the request still reports its body unused. */
  function expectBodyUnread({ request, stream, getReader, pulls }: ReturnType<typeof countedSubmit>) {
    expect(getReader).not.toHaveBeenCalled();
    expect(pulls()).toBe(0);
    expect(request.bodyUsed).toBe(false);
    expect(stream.locked).toBe(false);
  }
  /** The control for `expectBodyUnread`: the same instruments DO register a real read. */
  function expectBodyRead({ request, getReader, pulls }: ReturnType<typeof countedSubmit>) {
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(pulls()).toBe(1);
    expect(request.bodyUsed).toBe(true);
  }
  const services = () => ({ submit: vi.fn(), status: vi.fn() });
  const wrapper = (service: ReturnType<typeof services>) => createGovernedActionHttp({ ...governedActions, ...service });

  it("the body fixture is demand-driven: untouched until a reader actually reads it", async () => {
    const submit = countedSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0)); // an eager producer would have pulled by now
    expectBodyUnread(submit);
    expect(await submit.request.json()).toEqual({ type: "task.create" });
    expect(submit.pulls()).toBe(1);
    expect(submit.request.bodyUsed).toBe(true);
  });

  it("submit refuses a failed authentication with 401 — body unread, service never called", async () => {
    authenticator.mockResolvedValueOnce(null);
    const service = services();
    const submit = countedSubmit();
    const response = await wrapper(service).submit(submit.request);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(submit.request, AUTH_OPTIONS);
    expectBodyUnread(submit);
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
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(request, AUTH_OPTIONS);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("an authenticator fault is a retryable 503, never a dispatch or a default admission", async () => {
    const service = services();
    authenticator.mockRejectedValueOnce(new Error("Authentication unavailable"));
    const submit = countedSubmit();
    const submitted = await wrapper(service).submit(submit.request);
    expect(submitted.status).toBe(503);
    expect(submitted.headers.get("retry-after")).toBe("1");
    expect(await submitted.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(submit.request, AUTH_OPTIONS);
    expectBodyUnread(submit);

    authenticator.mockRejectedValueOnce(new Error("Authentication unavailable"));
    const statusRequest = new Request(statusUrl);
    const status = await wrapper(service).status(statusRequest, ACTION_ID);
    expect(status.status).toBe(503);
    expect(JSON.stringify(await status.json())).not.toContain("Authentication unavailable");
    expect(authenticator).toHaveBeenCalledTimes(2);
    expect(authenticator).toHaveBeenLastCalledWith(statusRequest, AUTH_OPTIONS);
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
  });

  it("admitted control: both wrappers dispatch with exactly the authenticated principal", async () => {
    const principal = { memberId: "member-7", teamId: "team-7" };
    const service = services();
    service.submit.mockResolvedValue({ status: "succeeded", action_id: ACTION_ID });
    service.status.mockResolvedValue({ status: "succeeded", action_id: ACTION_ID });

    authenticator.mockResolvedValueOnce(principal as never);
    const submit = countedSubmit();
    const submitted = await wrapper(service).submit(submit.request);
    expect(submitted.status).toBe(200);
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(submit.request, AUTH_OPTIONS);
    expectBodyRead(submit);
    expect(service.submit).toHaveBeenCalledExactlyOnceWith(principal, { type: "task.create" });

    authenticator.mockResolvedValueOnce(principal as never);
    const status = await wrapper(service).status(new Request(statusUrl), ACTION_ID);
    expect(status.status).toBe(200);
    expect(authenticator).toHaveBeenCalledTimes(2);
    expect(service.status).toHaveBeenCalledExactlyOnceWith(principal, ACTION_ID);
  });

  it("the shipped route handlers refuse through the same wrapper before the production service", async () => {
    const submit = vi.spyOn(governedActions, "submit");
    const status = vi.spyOn(governedActions, "status");

    authenticator.mockResolvedValueOnce(null);
    const refused = countedSubmit();
    const submitted = await submitRoute(refused.request);
    expect(submitted.status).toBe(401);
    expect(await submitted.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(refused.request, AUTH_OPTIONS);
    expectBodyUnread(refused);

    authenticator.mockResolvedValueOnce(null);
    const read = await statusRoute(new Request(statusUrl), { params: Promise.resolve({ action_id: ACTION_ID }) });
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(authenticator).toHaveBeenCalledTimes(2);

    expect(submit).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  // The shipped wrapper holds the `governedActions` OBJECT and looks `submit`/`status` up on it per
  // request, so the property spies above sit on the real dispatch path. This control pins that: if
  // the wrapper ever captured the functions instead, the stubs would be bypassed and this fails.
  it("admitted control: the shipped route handlers dispatch to the spied production service", async () => {
    const principal = { memberId: "member-7", teamId: "team-7" };
    const result = { status: "succeeded", action_id: ACTION_ID };
    const submit = vi.spyOn(governedActions, "submit").mockResolvedValue(result as never);
    const status = vi.spyOn(governedActions, "status").mockResolvedValue(result as never);

    authenticator.mockResolvedValueOnce(principal as never);
    const admitted = countedSubmit();
    const submitted = await submitRoute(admitted.request);
    expect(submitted.status).toBe(200);
    expect(authenticator).toHaveBeenCalledExactlyOnceWith(admitted.request, AUTH_OPTIONS);
    expectBodyRead(admitted);
    expect(submit).toHaveBeenCalledExactlyOnceWith(principal, { type: "task.create" });

    authenticator.mockResolvedValueOnce(principal as never);
    const read = await statusRoute(new Request(statusUrl), { params: Promise.resolve({ action_id: ACTION_ID }) });
    expect(read.status).toBe(200);
    expect(authenticator).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledExactlyOnceWith(principal, ACTION_ID);
  });
});
