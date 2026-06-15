import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  type PolicyRequest,
  type PolicyRule,
} from "@/lib/policy/evaluate";

let seq = 0;
function rule(over: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: `r${seq++}`,
    priority: 0,
    subjectRole: null,
    subjectTier: null,
    subjectActor: null,
    action: "*",
    resource: "*",
    effect: "allow",
    enabled: true,
    ...over,
  };
}

const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  principal: { role: "member", tier: "team", actor: "alex" },
  action: "item.write",
  resource: "project:acme/tasks.md",
  ...over,
});

describe("evaluatePolicy", () => {
  it("defaults to deny when no rule matches", () => {
    const d = evaluatePolicy([], req());
    expect(d.effect).toBe("deny");
    expect(d.matchedRuleId).toBeNull();
  });

  it("allows when a matching allow rule exists", () => {
    const d = evaluatePolicy([rule({ id: "a", effect: "allow" })], req());
    expect(d.effect).toBe("allow");
    expect(d.matchedRuleId).toBe("a");
  });

  it("higher priority wins over lower", () => {
    const d = evaluatePolicy(
      [rule({ effect: "allow", priority: 1 }), rule({ id: "deny-hi", effect: "deny", priority: 5 })],
      req()
    );
    expect(d.effect).toBe("deny");
    expect(d.matchedRuleId).toBe("deny-hi");
  });

  it("breaks priority ties with the most restrictive effect (deny > require_approval > allow)", () => {
    const d = evaluatePolicy(
      [
        rule({ effect: "allow", priority: 3 }),
        rule({ id: "appr", effect: "require_approval", priority: 3 }),
        rule({ id: "deny", effect: "deny", priority: 3 }),
      ],
      req()
    );
    expect(d.effect).toBe("deny");
    expect(d.matchedRuleId).toBe("deny");
  });

  it("respects subject matchers (role/tier/actor)", () => {
    const adminOnly = rule({ id: "admin", effect: "allow", subjectRole: "admin", action: "agent.spawn" });
    const spawn = req({ action: "agent.spawn", resource: "*" });
    expect(evaluatePolicy([adminOnly], spawn).effect).toBe("deny"); // member, no match → default deny
    expect(
      evaluatePolicy([adminOnly], { ...spawn, principal: { role: "admin", tier: "team", actor: "boss" } }).effect
    ).toBe("allow");
  });

  it("matches action and resource globs", () => {
    const r = rule({ id: "g", effect: "require_approval", action: "email.*", resource: "project:acme/*" });
    expect(evaluatePolicy([r], req({ action: "email.send", resource: "project:acme/x" })).effect).toBe(
      "require_approval"
    );
    expect(evaluatePolicy([r], req({ action: "email.send", resource: "project:other/x" })).effect).toBe(
      "deny"
    ); // resource glob misses → default deny
  });

  it("ignores disabled rules", () => {
    const d = evaluatePolicy([rule({ id: "off", effect: "allow", enabled: false })], req());
    expect(d.effect).toBe("deny");
  });

  it("does not let glob metachars in patterns match literally", () => {
    // 'item.write' must not be matched by a pattern intended as a literal 'item_write'
    const r = rule({ id: "lit", effect: "allow", action: "item.read" });
    expect(evaluatePolicy([r], req({ action: "itemxread" })).effect).toBe("deny");
  });
});
