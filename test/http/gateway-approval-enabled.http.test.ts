import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL } from "./http-helpers";

describe.runIf(process.env.AIOS_GATEWAY_INTERNAL_ENABLED === "true")(
  "gateway approval routes while enabled (HTTP)",
  () => {
    it("requires a gateway service credential for resume", async () => {
      const response = await fetch(
        `${BASE_URL}/api/internal/executor-gateway/v1/executions/${randomUUID()}/resume-claim`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer deliberately-invalid",
            "Content-Type": "application/json",
          },
          body: "{malformed",
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("gateway_unauthorized");
    });

    it("requires an authenticated admin session before parsing admin requests", async () => {
      const response = await fetch(
        `${BASE_URL}/api/internal/executor-gateway/v1/admin/team/approvals/${randomUUID()}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{malformed",
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("gateway_unauthorized");
    });
  },
);
