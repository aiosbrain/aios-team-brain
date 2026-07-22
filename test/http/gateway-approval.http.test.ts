import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL } from "./http-helpers";

describe.runIf(process.env.AIOS_GATEWAY_INTERNAL_ENABLED !== "true")(
  "gateway approval routes while disabled (HTTP)",
  () => {
    it("keeps resume and every admin route non-enumerating before auth or parsing", async () => {
      const executionId = randomUUID();
      const approvalId = randomUUID();
      const serviceId = randomUUID();
      const policyId = randomUUID();
      const credentialId = "ICEiIyQlJicoKSorLC0uLw";
      const requests: Array<[string, string]> = [
        ["POST", `/api/internal/executor-gateway/v1/executions/${executionId}/resume-claim`],
        ["GET", "/api/internal/executor-gateway/v1/admin/team/approvals"],
        ["POST", `/api/internal/executor-gateway/v1/admin/team/approvals/${approvalId}/decision`],
        ["GET", "/api/internal/executor-gateway/v1/admin/team/policies"],
        ["POST", "/api/internal/executor-gateway/v1/admin/team/policies"],
        ["PATCH", `/api/internal/executor-gateway/v1/admin/team/policies/${policyId}`],
        ["DELETE", `/api/internal/executor-gateway/v1/admin/team/policies/${policyId}`],
        ["GET", `/api/internal/executor-gateway/v1/admin/team/service-identities/${serviceId}/credentials`],
        ["POST", `/api/internal/executor-gateway/v1/admin/team/service-identities/${serviceId}/credentials`],
        ["POST", `/api/internal/executor-gateway/v1/admin/team/service-identities/${serviceId}/credentials/${credentialId}/revoke`],
      ];
      expect(requests).toHaveLength(10);
      for (const [method, path] of requests) {
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: "Bearer deliberately-invalid",
            "Content-Type": "application/json",
          },
          body: method === "GET" ? undefined : "{malformed",
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect((await response.json()).error.code).toBe("gateway_not_found");
      }
    });
  },
);
