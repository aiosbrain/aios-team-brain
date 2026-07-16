import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGatewayPolicyInput } from "@/lib/gateway/admin-validation";
import {
  evaluateGatewayPolicy,
  type GatewayPolicyRow,
} from "@/lib/gateway/policy";

let id = 0;
const row = (over: Partial<GatewayPolicyRow> = {}): GatewayPolicyRow => ({
  id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  subject_role: null,
  subject_tier: null,
  subject_actor: null,
  action: "gateway.aios-github-readonly.*",
  resource: "github.repository:*",
  priority: 0,
  effect: "allow",
  updated_at: "2026-07-16T00:00:00.000Z",
  ...over,
});
const principal = {
  actor: "alex",
  role: "member" as const,
  tier: "team" as const,
};
const input = { principal, tool: "github.repository.get", owner: "octo", repo: "project" };

describe("gateway approval policy administration", () => {
  it("implements the exhaustive precedence dimensions", () => {
    const cases: Array<[string, GatewayPolicyRow[], "allow" | "block" | "require_approval"]> = [
      ["actor beats role", [
        row({ subject_role: "member", effect: "deny" }),
        row({ subject_actor: "alex", effect: "allow" }),
      ], "allow"],
      ["role beats tier", [
        row({ subject_tier: "team", effect: "deny" }),
        row({ subject_role: "member", effect: "allow" }),
      ], "allow"],
      ["tier beats team", [
        row({ effect: "deny" }),
        row({ subject_tier: "team", effect: "allow" }),
      ], "allow"],
      ["exact tool beats wildcard", [
        row({ effect: "deny" }),
        row({ action: "gateway.aios-github-readonly.github.repository.get", effect: "allow" }),
      ], "allow"],
      ["exact repository beats wildcard", [
        row({ effect: "deny" }),
        row({ resource: "github.repository:octo/project", effect: "allow" }),
      ], "allow"],
      ["numeric priority", [
        row({ priority: 1, effect: "deny" }),
        row({ priority: 2, effect: "allow" }),
      ], "allow"],
      ["block is most restrictive", [
        row({ effect: "allow" }),
        row({ effect: "require_approval" }),
        row({ effect: "deny" }),
      ], "block"],
      ["approval beats allow", [
        row({ effect: "allow" }),
        row({ effect: "require_approval" }),
      ], "require_approval"],
      ["no match blocks", [], "block"],
    ];
    expect(cases).toHaveLength(9);
    for (const [name, policies, expected] of cases)
      expect(evaluateGatewayPolicy(policies, input).decision, name).toBe(expected);
  });

  it("accepts exactly one tagged subject selector", () => {
    const valid = {
      subject: { type: "team" },
      tool: "github.repository.get",
      resource: "github.repository:octo/project",
      effect: "require_approval",
      priority: 5,
      enabled: true,
      correlationId: "11111111-1111-4111-8111-111111111111",
    };
    expect(parseGatewayPolicyInput(valid)?.subject).toEqual({ type: "team" });
    expect(
      parseGatewayPolicyInput({
        ...valid,
        subject: { type: "role", role: "member", tier: "team" },
      }),
    ).toBeNull();
  });

  it("discovers all nine admin operations and the resume route", () => {
    const root = join(process.cwd(), "app/api/internal/executor-gateway/v1");
    const sources = [
      ["admin/[teamSlug]/approvals/route.ts", ["GET"]],
      ["admin/[teamSlug]/approvals/[approvalId]/decision/route.ts", ["POST"]],
      ["admin/[teamSlug]/policies/route.ts", ["GET", "POST"]],
      ["admin/[teamSlug]/policies/[policyId]/route.ts", ["PATCH", "DELETE"]],
      [
        "admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/route.ts",
        ["GET", "POST"],
      ],
      [
        "admin/[teamSlug]/service-identities/[serviceIdentityId]/credentials/[credentialId]/revoke/route.ts",
        ["POST"],
      ],
    ] as const;
    let operations = 0;
    for (const [file, methods] of sources) {
      const source = readFileSync(join(root, file), "utf8");
      for (const method of methods) {
        expect(source).toContain(`export async function ${method}`);
        operations++;
      }
    }
    expect(operations).toBe(9);
    expect(
      readFileSync(
        join(root, "executions/[executionId]/resume-claim/route.ts"),
        "utf8",
      ),
    ).toContain("export async function POST");
  });

  it("keeps the managed queue recursively free of secret-bearing fields", () => {
    const sources = [
      "components/admin/managed-gateway-approvals.tsx",
      "app/t/[team]/admin/approvals/page.tsx",
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8").toLowerCase());
    for (const source of sources) {
      expect(source).not.toContain("credentialciphertext");
      expect(source).not.toContain("encryptedrequestenvelope");
      expect(source).not.toContain("sealedcredential");
      expect(source).not.toContain("lease");
      expect(source).not.toContain("requesthash:");
    }
    const component = sources[0];
    expect(component).toContain('aria-labelledby="managed-gateway-heading"');
    expect(component).toContain("window.confirm");
    expect(component).toContain("focus-visible:ring-2");
    expect(component).toContain('role="alert"');
    expect(component).toContain("sm:grid-cols-3");
  });
});
