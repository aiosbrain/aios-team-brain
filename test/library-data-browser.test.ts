import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  team_id: string;
  path: string;
  kind: string;
  access: string;
  actor: string;
  synced_at: string;
  body: string;
  frontmatter: { channel?: string };
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  visibleIds: [] as string[],
  queries: [] as { filters: { col: string; op: string; value: unknown }[]; from: number; count: number }[],
}));

function sqlLike(value: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "%") {
      regex += ".*";
    } else if (char === "_") {
      regex += ".";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`).test(value);
}

function itemQuery() {
  const filters: { col: string; op: string; value: unknown }[] = [];
  const orders: { col: string; ascending: boolean }[] = [];
  let from = 0;
  let count = Infinity;
  const query = {
    select: () => query,
    eq: (col: string, value: unknown) => { filters.push({ col, op: "eq", value }); return query; },
    like: (col: string, value: string) => { filters.push({ col, op: "like", value }); return query; },
    in: (col: string, value: unknown[]) => { filters.push({ col, op: "in", value }); return query; },
    order: (col: string, opts: { ascending: boolean }) => { orders.push({ col, ascending: opts.ascending }); return query; },
    limit: (value: number) => { count = value; return query; },
    range: (start: number, end: number) => { from = start; count = end - start + 1; return query; },
    then: (resolve: (value: { data: Row[] }) => unknown) => {
      if (filters.some((filter) => filter.col === "path")) {
        state.queries.push({ filters: [...filters], from, count });
      }
      const rows = state.rows.filter((row) => filters.every((filter) => {
        const field = row[filter.col as keyof Row];
        if (filter.op === "eq") return field === filter.value;
        if (filter.op === "like") return sqlLike(String(field), String(filter.value));
        return (filter.value as unknown[]).includes(field);
      })).sort((a, b) => {
        for (const order of orders) {
          const comparison = String(a[order.col as keyof Row]).localeCompare(String(b[order.col as keyof Row]));
          if (comparison) return order.ascending ? comparison : -comparison;
        }
        return 0;
      });
      return Promise.resolve({ data: rows.slice(from, from + count) }).then(resolve);
    },
  };
  return query;
}

vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from: (table: string) => table === "teams"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "team-1" } }) }) }) }
      : itemQuery(),
  }),
}));
vi.mock("@/lib/auth/guard", () => ({ currentMember: async () => ({ id: "viewer", tier: "external" }) }));
vi.mock("@/lib/access/enforce", () => ({
  visibleItemIds: async () => ({ ids: new Set(state.visibleIds), error: null }),
}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/components/library/channel-rail", () => ({ ChannelRail: () => null }));

import { DataBrowser } from "@/components/library/data-browser";

function row(id: string, path: string, access = "external", at = "2026-09-19T12:00:00Z"): Row {
  return { id, team_id: "team-1", path, kind: "note", access, actor: "", synced_at: at, body: `# ${id}`, frontmatter: { channel: "general" } };
}

async function page(channel: string, limitParam?: string): Promise<string> {
  return renderToStaticMarkup(await DataBrowser({
    teamSlug: "demo", basePath: "/t/demo/admin/data", channelParam: channel, limitParam,
  }));
}

beforeEach(() => {
  state.rows = [];
  state.visibleIds = [];
  state.queries = [];
});

describe("DataBrowser scoped feed", () => {
  it("does not offer a Load more link beyond the 500-item feed cap", async () => {
    state.rows = Array.from({ length: 501 }, (_, index) =>
      row(`item-${index}`, `slack/t1/c1/1718900000.${String(index).padStart(6, "0")}.md`));
    state.visibleIds = state.rows.map((item) => item.id);
    const html = await page("slack/t1/c1", "500");
    expect(html).not.toContain("Load more");
    expect((html.match(/<li(?:\s|>)/g) ?? [])).toHaveLength(500);
  });

  it("isolates the same channel ID across workspaces and retains both visibility gates", async () => {
    state.rows = [
      row("workspace-one", "slack/t1/c1/1718900000.000100.md"),
      row("workspace-two", "slack/t2/c1/1718900000.000100.md"),
      row("legacy", "slack/c1/1718900000.000100.md"),
      row("tier-hidden", "slack/t1/c1/1718900001.000100.md", "team"),
      row("oracle-hidden", "slack/t1/c1/1718900002.000100.md"),
    ];
    state.visibleIds = ["workspace-one", "workspace-two", "legacy", "tier-hidden"];

    const html = await page("slack/t1/c1");
    expect(html).toContain("workspace-one");
    expect(html).toContain("1718900000.000100.md");
    for (const hidden of ["workspace-two", "legacy", "tier-hidden", "oracle-hidden"]) {
      expect(html).not.toContain(hidden);
    }
    expect(state.queries[0].filters).toEqual(expect.arrayContaining([
      { col: "path", op: "like", value: "slack/t1/c1/%" },
      { col: "access", op: "eq", value: "external" },
      { col: "id", op: "in", value: state.visibleIds },
    ]));
  });

  it("fills a legacy page after scoped rows sharing its SQL prefix", async () => {
    state.rows = Array.from({ length: 51 }, (_, index) =>
      row(`scoped-${index}`, `slack/t1/c1/1718900000.${String(index).padStart(6, "0")}.md`,
        "external", "2026-09-19T13:00:00Z"));
    state.rows.push(...Array.from({ length: 51 }, (_, index) =>
      row(`legacy-${index}`, `slack/t1/1718900001.${String(index).padStart(6, "0")}.md`)));
    state.visibleIds = state.rows.map((item) => item.id);

    const html = await page("slack/t1");
    expect(html).toContain("legacy-50");
    expect(html).not.toContain("legacy-0");
    expect(html).not.toContain("scoped-0");
    expect(html).toContain("Load more");
    expect(state.queries.length).toBe(2);
    expect(state.queries.map((query) => query.from)).toEqual([0, 51]);
    for (const query of state.queries) {
      expect(query.filters).toEqual(expect.arrayContaining([
        { col: "access", op: "eq", value: "external" },
        { col: "id", op: "in", value: state.visibleIds },
      ]));
    }
  });

  it("escapes non-Slack channel wildcards before SQL pagination", async () => {
    state.rows = Array.from({ length: 51 }, (_, index) =>
      row(`decoy-${index}`, `github/myXrepoYarchive/${index}.md`,
        "external", "2026-09-19T13:00:00Z"));
    state.rows.push(row("actual-repo", "github/my_repo%archive/file.md"));
    state.visibleIds = state.rows.map((item) => item.id);

    const html = await page("github/my_repo%archive");
    expect(html).toContain("actual-repo");
    expect(html).not.toContain("decoy-0");
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].filters).toContainEqual({
      col: "path", op: "like", value: "github/my\\_repo\\%archive/%",
    });
  });
});
