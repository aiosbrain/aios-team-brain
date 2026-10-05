import { describe, it, expect } from "vitest";
import {
  parseSubmitRequest,
  operationKey,
  canonicalRequest,
  validateStatus,
} from "@/lib/actions/governed/contract";
import { TASK_STATUSES } from "@/lib/api/schemas";
import schema from "../fixtures/mcp-next-v1/actions.schema.json";
import fixtures from "../fixtures/mcp-next-v1/actions-fixtures.json";
const note = {
  contract_version: "mcp-next/1",
  type: "note.append",
  destination: { project_id: "p" },
  params: { title: " Exact ", body: "a\r\nb" },
};
describe("governed contract from mcp-next/1", () => {
  it("pins shared task vocabulary to the contract", () => {
    expect([...TASK_STATUSES].sort()).toEqual(
      [...schema.definitions.TaskFields.properties.status.enum].sort(),
    );
  });
  it("keeps accepted bytes and canonicalizes object order", () => {
    expect(parseSubmitRequest(note)).toEqual(note);
    expect(canonicalRequest(note)).toBe(
      canonicalRequest({
        ...note,
        params: { body: "a\r\nb", title: " Exact " },
      }),
    );
    expect(operationKey(parseSubmitRequest(note), "m", "t", "p")).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it("rejects forged authority, unknown action and invalid scalar unicode", () => {
    for (const value of [
      { ...note, actor: "admin" },
      { ...note, type: "code.run" },
      { ...note, params: { ...note.params, title: "\ud800" } },
    ])
      expect(() => parseSubmitRequest(value)).toThrow();
  });
  it("counts Unicode code points and enforces calendar dates", () => {
    expect(() =>
      parseSubmitRequest({
        ...note,
        params: { title: "🚀".repeat(200), body: "x" },
      }),
    ).not.toThrow();
    expect(() =>
      parseSubmitRequest({
        ...note,
        params: { title: "🚀".repeat(201), body: "x" },
      }),
    ).toThrow();
    const task = {
      ...note,
      type: "task.create",
      params: {
        operation_id: "op",
        title: "x",
        assignee: null,
        status: "ready",
        due: "2026-02-29",
      },
    };
    expect(() => parseSubmitRequest(task)).toThrow();
    expect(() =>
      parseSubmitRequest({
        ...task,
        params: { ...task.params, due: "2024-02-29" },
      }),
    ).not.toThrow();
  });
  it("accepts pinned request and outcome vectors", () => {
    for (const f of fixtures.valid) {
      if (f.schema.endsWith("/SubmitRequest"))
        expect(() => parseSubmitRequest(f.value), f.name).not.toThrow();
      if (/\/(ActionOutcome|ActionStatus)$/.test(f.schema))
        expect(() => validateStatus(f.value), f.name).not.toThrow();
    }
    for (const f of fixtures.invalid) {
      if (f.schema.endsWith("/SubmitRequest"))
        expect(() => parseSubmitRequest(f.value), f.name).toThrow();
      if (/\/(ActionOutcome|ActionStatus)$/.test(f.schema))
        expect(() => validateStatus(f.value), f.name).toThrow();
    }
  });
});
