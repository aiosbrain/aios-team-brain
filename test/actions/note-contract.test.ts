import { describe, expect, it } from "vitest";
import { operationKey, parseSubmitRequest } from "@/lib/actions/governed/contract";

const request = (title = "A note", body = "A body") => ({
  contract_version: "mcp-next/1",
  type: "note.append",
  destination: { project_id: "00000000-0000-4000-8000-000000000001" },
  params: { title, body },
});

describe("note accepted-content contract", () => {
  it.each(["x", "📝", "e\u0301"])("counts Unicode code points rather than UTF-16 or graphemes: %s", (unit) => {
    const title = unit.repeat(Math.floor(200 / [...unit].length));
    const body = unit.repeat(Math.floor(25000 / [...unit].length));
    expect(parseSubmitRequest(request(title, body)).params).toEqual({ title, body });
    expect(() => parseSubmitRequest(request(title + "x", body))).toThrow();
    expect(() => parseSubmitRequest(request(title, body + "x"))).toThrow();
  });

  it.each(["", " \t\r\n", "\u2003"])("rejects blank title and body: %j", (blank) => {
    expect(() => parseSubmitRequest(request(blank))).toThrow();
    expect(() => parseSubmitRequest(request("Title", blank))).toThrow();
  });

  it.each(["bad\ud800", "bad\udfff", "bad\u0000"])("rejects invalid storage/scalar text before acceptance: %j", (bad) => {
    expect(() => parseSubmitRequest(request(bad))).toThrow();
    expect(() => parseSubmitRequest(request("Title", bad))).toThrow();
  });

  it.each(["actor", "path", "access", "kind", "operation_id", "project_id", "resource"])(
    "rejects caller %s in note params", (field) => {
      const value = request();
      expect(() => parseSubmitRequest({ ...value, params: { ...value.params, [field]: "forged" } })).toThrow();
    },
  );

  it("does not normalize accepted strings and binds their identity to the authenticated destination", () => {
    const value = parseSubmitRequest(request("  Cafe\u0301 📝  ", "\r\nbody\r\n"));
    expect(value.params).toEqual({ title: "  Cafe\u0301 📝  ", body: "\r\nbody\r\n" });
    const key = operationKey(value, "member", "team", "project");
    expect(operationKey(value, "member", "team", "project")).toBe(key);
    expect(operationKey(value, "other-member", "team", "project")).not.toBe(key);
    expect(operationKey(value, "member", "team", "other-project")).not.toBe(key);
    expect(operationKey(parseSubmitRequest(request("  Café 📝  ", "\r\nbody\r\n")), "member", "team", "project")).not.toBe(key);
    expect(operationKey(parseSubmitRequest(request("  Cafe\u0301 📝  ", "\nbody\n")), "member", "team", "project")).not.toBe(key);
  });
});
