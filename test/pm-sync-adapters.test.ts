import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { planeAdapter } from "@/lib/pm-sync/plane";
import type { IntegrationWithSecret } from "@/lib/integrations/manage";
import type { TaskPmLink } from "@/lib/pm-sync/provider";

const link: TaskPmLink = {
  id: "link-1",
  team_id: "team-1",
  project_id: "project-1",
  task_id: "task-1",
  row_key: "P0",
  provider: "plane",
  provider_resource_id: null,
  provider_external_source: "aios-backlog",
  provider_external_id: "P0",
  provider_url: "",
};

describe("Plane PM adapter", () => {
  it("resolves a completed state and patches the linked work item", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/states/")) {
        return Response.json([{ id: "done-state", name: "DONE", group: "completed" }]);
      }
      if (url.includes("/work-items/?")) {
        return Response.json({ results: [{ id: "wi-1", external_id: "P0", external_source: "aios-backlog", state: "todo-state" }] });
      }
      if (url.endsWith("/work-items/wi-1/")) {
        bodies.push(String(init?.body));
        return Response.json({ id: "wi-1" });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await planeAdapter.moveToDone({
      link,
      integration: {
        id: "int-1",
        type: "plane",
        name: "plane",
        secret: "plane-key",
        config: { workspaceSlug: "aios", projectId: "plane-project", doneStateName: "DONE" },
      } as IntegrationWithSecret,
      fetchImpl,
    });

    expect(result).toMatchObject({ provider: "plane", status: "synced", providerResourceId: "wi-1" });
    expect(JSON.parse(bodies[0])).toEqual({ state: "done-state" });
  });
});

describe("Linear PM adapter", () => {
  it("updates an issue to the team's completed workflow state", async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      queries.push(body.query);
      if (body.query.includes("IssueForPmSync")) {
        return Response.json({
          data: { issue: { id: "issue-uuid", identifier: "ENG-123", url: "https://linear.app/ENG-123", team: { id: "team-uuid" }, state: { id: "todo", name: "Todo", type: "unstarted" } } },
        });
      }
      if (body.query.includes("TeamDoneStates")) {
        return Response.json({ data: { team: { states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } } } });
      }
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } });
    }) as unknown as typeof fetch;

    const result = await linearAdapter.moveToDone({
      link: { ...link, provider: "linear", provider_external_source: "linear", provider_external_id: "ENG-123" },
      integration: {
        id: "int-1",
        type: "linear",
        name: "linear",
        secret: "lin_api_x",
        config: {},
      } as IntegrationWithSecret,
      fetchImpl,
    });

    expect(result).toMatchObject({ provider: "linear", status: "synced", providerResourceId: "issue-uuid" });
    expect(queries.some((q) => q.includes("issueUpdate"))).toBe(true);
  });
});
