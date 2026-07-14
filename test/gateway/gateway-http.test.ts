import { describe, expect, it } from "vitest";
import {
  exactObject,
  gatewayDisabled,
  readGatewayJson,
} from "@/lib/gateway/http";

describe("gateway raw request boundary", () => {
  it("accepts exactly 65,536 raw bytes", async () => {
    const body = `"${"a".repeat(65_534)}"`;
    const result = await readGatewayJson(
      new Request("http://local", { method: "POST", body }),
    );
    expect(typeof result).toBe("string");
  });
  it("rejects byte 65,537 with no-store", async () => {
    const body = `"${"a".repeat(65_535)}"`;
    const result = await readGatewayJson(
      new Request("http://local", { method: "POST", body }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect((result as Response).headers.get("cache-control")).toBe("no-store");
  });
  it("rejects an oversized declared length before reading", async () => {
    const req = {
      headers: new Headers({ "content-length": "65537" }),
      get body(): never {
        throw new Error("body accessed");
      },
    } as Request;
    expect(((await readGatewayJson(req)) as Response).status).toBe(413);
  });
  it("counts a lying smaller content-length and rejects overflow", async () => {
    const req = new Request("http://local", {
      method: "POST",
      body: `"${"a".repeat(65_535)}"`,
      headers: { "content-length": "2" },
    });
    expect(((await readGatewayJson(req)) as Response).status).toBe(413);
  });
  it("counts a chunked/missing-length stream and rejects overflow", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65_000));
        controller.enqueue(new Uint8Array(537));
        controller.close();
      },
    });
    const req = new Request("http://local", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.has("content-length")).toBe(false);
    expect(((await readGatewayJson(req)) as Response).status).toBe(413);
  });
  it("rejects content encoding before parsing", async () => {
    const result = await readGatewayJson(
      new Request("http://local", {
        method: "POST",
        body: "{}",
        headers: { "content-encoding": "gzip" },
      }),
    );
    expect((result as Response).status).toBe(415);
  });
  it("requires exact object fields", () => {
    expect(exactObject({ a: 1 }, ["a"])).toBe(true);
    expect(exactObject({ a: 1, b: 2 }, ["a"])).toBe(false);
  });
  it("is disabled unless the value is exactly true", () => {
    const prior = process.env.AIOS_GATEWAY_INTERNAL_ENABLED;
    delete process.env.AIOS_GATEWAY_INTERNAL_ENABLED;
    expect(gatewayDisabled()?.status).toBe(404);
    process.env.AIOS_GATEWAY_INTERNAL_ENABLED = "TRUE";
    expect(gatewayDisabled()?.status).toBe(404);
    process.env.AIOS_GATEWAY_INTERNAL_ENABLED = "true";
    expect(gatewayDisabled()).toBeNull();
    if (prior === undefined) delete process.env.AIOS_GATEWAY_INTERNAL_ENABLED;
    else process.env.AIOS_GATEWAY_INTERNAL_ENABLED = prior;
  });
});
