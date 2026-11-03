import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GoogleDrivePanel, type GoogleDrivePanelProps } from "@/components/admin/google-drive-panel";
import type { IntegrationRow } from "@/components/admin/integrations-manager";
import {
  driveConnections, latchDriveSelection, resolveDriveSelection, valueFor,
} from "@/lib/integrations/gdrive-admin-selection";
import type { GdriveRunRow, GdriveRunStatus } from "@/lib/integrations/gdrive-run-status";

/**
 * AIO-1167 r38 — Admin controls EVERY named Drive connection, one selected connection at a time.
 *
 * Spec. A team with several Drive connections can choose any of them; the coordinator status, the
 * reconnect links, the Picker, the preview, Run now / Retry and connector-key provisioning then act
 * on exactly that connection's immutable id (or its name, for the name-keyed authorization routes).
 * A choice that no longer exists falls back to NOTHING — never to a neighbour. A team with one Drive
 * connection sees and controls it exactly as before.
 *
 * The panel is stateless, so it is rendered (markup) and its handlers are invoked straight from its
 * element tree — no browser — and the parent's call sites are pinned to the connection they are given.
 */

const FIRST: IntegrationRow = {
  id: "11111111-1111-4111-8111-111111111101", type: "gdrive", name: "team-docs", status: "enabled",
  hasSecret: true, config: { authMode: "oauth", authenticatedAccount: "first@example.com", fileIds: ["A"] },
};
const SECOND: IntegrationRow = {
  id: "22222222-2222-4222-8222-222222222202", type: "gdrive", name: "client-docs", status: "enabled",
  hasSecret: true, config: { authMode: "oauth", authenticatedAccount: "second@example.com", fileIds: ["B"] },
};
const SLACK: IntegrationRow = {
  id: "33333333-3333-4333-8333-333333333303", type: "slack", name: "slack", status: "enabled",
  hasSecret: true, config: {},
};

const attempt = (integrationId: string, error: string): GdriveRunRow => ({
  id: `run-${error}`, integration_id: integrationId, trigger: "scheduler", status: "failed",
  created_at: "2026-10-24T10:00:00Z", started_at: "2026-10-24T10:00:00Z", finished_at: "2026-10-24T10:01:00Z",
  summary: {}, error,
});
const STATUS: Record<string, GdriveRunStatus> = {
  [FIRST.id]: { latestAttempt: attempt(FIRST.id, "first_only_marker"), latestReport: null, latestSuccess: null },
  [SECOND.id]: { latestAttempt: attempt(SECOND.id, "second_only_marker"), latestReport: null, latestSuccess: null },
};

function panelProps(
  connections: IntegrationRow[], selectedId: string | null,
  over: Partial<Pick<GoogleDrivePanelProps, "pickerConfigured" | "previewContinuation">> = {},
) {
  return {
    // Resolved exactly as the parent resolves it: through the latch.
    teamSlug: "acme", connections,
    selection: resolveDriveSelection(connections, latchDriveSelection(selectedId, connections)),
    gdriveStatus: STATUS, pickerConfigured: false, pending: false,
    testMessage: null, previewContinuation: null, connectorKey: null,
    summarize: (config: Record<string, unknown>) => `files=${String((config.fileIds as string[] | undefined)?.join("|"))}`,
    onSelect: vi.fn(), onChooseFiles: vi.fn(), onRun: vi.fn(), onTest: vi.fn(), onProvision: vi.fn(),
    ...over,
  } satisfies GoogleDrivePanelProps;
}

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function elements(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node as El).props.children);
  return "";
}

/** The panel's element tree — it is hook-free, so it can be called like the pure function it is. */
const tree = (props: GoogleDrivePanelProps) => elements(GoogleDrivePanel(props));
const button = (props: GoogleDrivePanelProps, label: string) => {
  const found = tree(props).find((el) => el.type === "button" && text(el.props.children).includes(label));
  if (!found) throw new Error(`no "${label}" button`);
  return found;
};
const click = (el: El) => (el.props.onClick as () => void)();
const html = (props: GoogleDrivePanelProps) => renderToStaticMarkup(createElement(GoogleDrivePanel, props));

describe("which Drive connection Admin acts on", () => {
  it("lists only Drive connections, in Admin order", () => {
    expect(driveConnections([FIRST, SLACK, SECOND]).map((c) => c.id)).toEqual([FIRST.id, SECOND.id]);
  });

  it("nothing chosen latches the first connection shown, by id; a choice is that exact connection", () => {
    expect(latchDriveSelection(null, [FIRST, SECOND])).toBe(FIRST.id);
    expect(resolveDriveSelection([FIRST, SECOND], FIRST.id)).toEqual({ kind: "selected", connection: FIRST });
    expect(resolveDriveSelection([FIRST, SECOND], SECOND.id)).toEqual({ kind: "selected", connection: SECOND });
    // No connection yet: nothing is latched, and the panel offers to connect one.
    expect(latchDriveSelection(null, [])).toBeNull();
    expect(resolveDriveSelection([], null)).toEqual({ kind: "none" });
  });

  it("the latch fires once — from the first non-empty list — and never moves an id", () => {
    // Nothing connected, then the first connect + refresh: latched at that moment.
    expect(latchDriveSelection(latchDriveSelection(null, []), [SECOND])).toBe(SECOND.id);
    // A latched or chosen id is kept whatever the list now holds, including a list without it.
    expect(latchDriveSelection(FIRST.id, [SECOND, FIRST])).toBe(FIRST.id);
    expect(latchDriveSelection(FIRST.id, [SECOND])).toBe(FIRST.id);
    expect(latchDriveSelection(FIRST.id, [])).toBe(FIRST.id);
  });

  it("a choice that no longer exists is missing — never a neighbour", () => {
    expect(resolveDriveSelection([FIRST], SECOND.id)).toEqual({ kind: "missing", selectedId: SECOND.id });
  });

  it("a per-connection result is shown only for the connection it belongs to", () => {
    const key = { connectionId: FIRST.id, value: "aios_one_time_key" };
    expect(valueFor(key, resolveDriveSelection([FIRST, SECOND], FIRST.id))).toBe("aios_one_time_key");
    expect(valueFor(key, resolveDriveSelection([FIRST, SECOND], SECOND.id))).toBeNull();
    expect(valueFor(key, resolveDriveSelection([SECOND], FIRST.id))).toBeNull();
  });
});

describe("the Drive panel with a NON-first connection selected", () => {
  const props = () => panelProps([FIRST, SECOND], SECOND.id);

  it("shows that connection's own status, account and reconnect links, and none of the first's", () => {
    const markup = html(props());
    expect(markup).toContain("second_only_marker");
    expect(markup).toContain("Connected as second@example.com");
    expect(markup).toContain("name=client-docs&amp;mode=files");
    expect(markup).toContain("name=client-docs&amp;mode=folders");
    expect(markup).not.toContain("first_only_marker");
    expect(markup).not.toContain("first@example.com");
    expect(markup).not.toContain("name=team-docs");
  });

  it("offers every connection in the selector, with the chosen one selected", () => {
    const select = tree(props()).find((el) => el.type === "select")!;
    expect(select.props.value).toBe(SECOND.id);
    const options = tree(props()).filter((el) => el.type === "option").map((el) => el.props.value);
    expect(options).toEqual([FIRST.id, SECOND.id]);
    const p = props();
    (elements(GoogleDrivePanel(p)).find((el) => el.type === "select")!.props.onChange as
      (event: { target: { value: string } }) => void)({ target: { value: FIRST.id } });
    expect(p.onSelect).toHaveBeenCalledWith(FIRST.id);
  });

  it("binds Run now, Retry, preview and connector provisioning to the selected connection's id", () => {
    const p = props();
    click(button(p, "Run now"));
    click(button(p, "Retry pending work"));
    click(button(p, "Test connection and preview scope"));
    click(button(p, "Provision / rotate connector key"));
    expect(p.onRun.mock.calls.map(([c, trigger]) => [c.id, trigger])).toEqual([[SECOND.id, "manual"], [SECOND.id, "retry"]]);
    expect(p.onTest.mock.calls.map(([c, continuation]) => [c.id, continuation])).toEqual([[SECOND.id, 0]]);
    expect(p.onProvision.mock.calls.map(([c]) => c.id)).toEqual([SECOND.id]);
  });

  it("binds the Picker and a preview continuation to the selected connection", () => {
    const p = panelProps([FIRST, SECOND], SECOND.id, { pickerConfigured: true, previewContinuation: 40 });
    click(button(p, "Choose Google Docs"));
    click(button(p, "Continue preview at"));
    expect(p.onChooseFiles.mock.calls.map(([c]) => c.id)).toEqual([SECOND.id]);
    expect(p.onTest.mock.calls.map(([c, continuation]) => [c.id, continuation])).toEqual([[SECOND.id, 40]]);
  });

  it("gates Run now on the SELECTED connection's own state, not the first's", () => {
    const paused = { ...SECOND, status: "disabled" as const };
    const p = panelProps([FIRST, paused], paused.id);
    expect(button(p, "Run now").props.disabled).toBe(true);
    expect(button(panelProps([{ ...FIRST, status: "disabled" }, SECOND], SECOND.id), "Run now").props.disabled).toBe(false);
  });
});

describe("a selected Drive connection that no longer exists", () => {
  it("shows no other connection's status or links and acts on nothing", () => {
    const p = panelProps([FIRST], SECOND.id);
    const markup = html(p);
    expect(markup).toContain("no longer listed");
    expect(markup).not.toContain("first_only_marker");
    expect(markup).not.toContain("gdrive/start");
    for (const label of ["Run now", "Retry pending work", "Test connection and preview scope", "Provision / rotate connector key"]) {
      const el = button(p, label);
      expect(el.props.disabled, label).toBe(true);
      click(el);
    }
    expect([p.onRun, p.onTest, p.onProvision, p.onChooseFiles].every((fn) => fn.mock.calls.length === 0)).toBe(true);
    // The selector stays, so the Admin can choose again.
    expect(tree(p).some((el) => el.type === "select")).toBe(true);
  });
});

describe("the DEFAULT selection across a refresh (no user change)", () => {
  it("the first connection shown, once removed, is missing — the second is never selected silently", () => {
    // The parent's selection state, driven exactly as the parent drives it on each render:
    // `latchDriveSelection(selectedDriveId, drives)`, with no dropdown change in between.
    let selectedDriveId: string | null = null;
    const render = (connections: IntegrationRow[]) => {
      selectedDriveId = latchDriveSelection(selectedDriveId, connections);
      return panelProps(connections, selectedDriveId);
    };

    const shown = render([FIRST, SECOND]);
    expect(selectedDriveId).toBe(FIRST.id);
    expect(html(shown)).toContain("first_only_marker");

    // Refresh after the first connection was disconnected elsewhere: only the second is listed.
    const refreshed = render([SECOND]);
    expect(selectedDriveId).toBe(FIRST.id);
    expect(refreshed.selection).toEqual({ kind: "missing", selectedId: FIRST.id });
    const markup = html(refreshed);
    expect(markup).toContain("no longer listed");
    // No neighbour's status, account or authorization links…
    expect(markup).not.toContain("second_only_marker");
    expect(markup).not.toContain("second@example.com");
    expect(markup).not.toContain("gdrive/start");
    // …and no action reaches any connection.
    for (const label of ["Run now", "Retry pending work", "Test connection and preview scope", "Provision / rotate connector key"]) {
      const el = button(refreshed, label);
      expect(el.props.disabled, label).toBe(true);
      click(el);
    }
    expect([refreshed.onRun, refreshed.onTest, refreshed.onProvision, refreshed.onChooseFiles, refreshed.onSelect]
      .every((fn) => fn.mock.calls.length === 0)).toBe(true);

    // Only an explicit choice selects the remaining connection.
    const select = tree(refreshed).find((el) => el.type === "select")!;
    expect(select.props.value).toBe("");
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: SECOND.id } });
    expect(refreshed.onSelect).toHaveBeenCalledWith(SECOND.id);
  });
});

describe("a team with ONE Drive connection (unchanged behaviour)", () => {
  it("needs no selector and binds everything to its only connection", () => {
    const p = panelProps([FIRST], null);
    expect(tree(p).some((el) => el.type === "select")).toBe(false);
    const markup = html(p);
    expect(markup).toContain("first_only_marker");
    expect(markup).toContain("name=team-docs&amp;mode=files");
    click(button(p, "Run now"));
    click(button(p, "Provision / rotate connector key"));
    expect(p.onRun.mock.calls.map(([c]) => c.id)).toEqual([FIRST.id]);
    expect(p.onProvision.mock.calls.map(([c]) => c.id)).toEqual([FIRST.id]);
  });

  it("with no connection, offers to connect one and acts on nothing", () => {
    const p = panelProps([], null);
    expect(html(p)).toContain("No Google Drive account is connected yet.");
    expect(button(p, "Run now").props.disabled).toBe(true);
    expect(button(p, "Provision / rotate connector key").props.disabled).toBe(true);
  });
});

describe("the parent's Drive actions use the connection the panel hands them", () => {
  // The panel test above proves WHICH connection reaches the handler; this pins that each handler
  // sends THAT connection to its server action — and that nothing re-derives "the first gdrive".
  const src = readFileSync(join(process.cwd(), "components", "admin", "integrations-manager.tsx"), "utf8");

  it("calls every Drive server action with the handed connection's id or name", () => {
    expect(src).toContain("runGoogleDriveNow(teamSlug, drive.id, trigger)");
    expect(src).toContain("provisionGoogleDriveConnector(teamSlug, drive.id)");
    expect(src).toContain("testGoogleDriveConnection(teamSlug, drive.name, continuation)");
    expect(src).toContain("saveGoogleDrivePickerSelection(teamSlug, drive.name, ids)");
  });

  it("latches the default selection through the same helper the lifecycle test drives", () => {
    expect(src).toContain("useState<string | null>(() => latchDriveSelection(null, drives))");
    expect(src).toContain("const latchedDriveId = latchDriveSelection(selectedDriveId, drives);");
    expect(src).toContain("if (latchedDriveId !== selectedDriveId) setSelectedDriveId(latchedDriveId);");
    expect(src).toContain("resolveDriveSelection(drives, latchedDriveId)");
    // Resolving the raw (possibly un-latched) state would re-pick "the first" on every refresh.
    expect(src).not.toContain("resolveDriveSelection(drives, selectedDriveId)");
  });

  it("never picks a Drive connection by type alone", () => {
    expect(src).not.toMatch(/\.find\(\(\w+\) => \w+\.type === "gdrive"\)/);
    expect(src).not.toContain("driveIntegration");
  });
});
