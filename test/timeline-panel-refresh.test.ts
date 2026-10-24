import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";

const { cached } = vi.hoisted(() => ({ cached: vi.fn() }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/dashboard/timeline-cache", () => ({ getCachedWorkTimeline: cached }));
vi.mock("@/lib/dashboard/work-timeline", () => ({ WINDOW_DAYS: 7, MAX_WINDOW_DAYS: 30 }));
vi.mock("@/components/dashboard/timeline-days", async () => {
  const { createElement } = await import("react");
  return { TimelineDays: ({ days }: { days: TimelineDay[] }) =>
    createElement("div", null, days.map((day) => createElement("span", { key: day.date }, day.label))) };
});
vi.mock("lucide-react", async () => {
  const { createElement } = await import("react");
  return { ChevronDown: () => createElement("span"), Loader2: () => createElement("span") };
});

import { TimelinePanel } from "@/components/learning/timeline-panel";

// This small DOM host lets React's actual client reconciler exercise the server element's key
// without adding a browser-only test dependency to the Node unit suite.
class HostNode {
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  ownerDocument!: HostDocument;
  nodeType = 0;
  nodeName = "";
  nodeValue: string | null = null;
  private listeners = new Map<string, Set<(event: HostEvent) => void>>();

  appendChild(child: HostNode) { return this.insertBefore(child, null); }
  insertBefore(child: HostNode, before: HostNode | null) {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (before && index < 0) throw new Error("missing sibling");
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: HostNode) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("missing child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string {
    return this.nodeType === 3 ? this.nodeValue ?? "" : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes.forEach((child) => { child.parentNode = null; });
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  addEventListener(type: string, listener: (event: HostEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: HostEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: HostEvent) {
    event.target = this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    for (let current = this.parentNode; current; current = current.parentNode) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(event.type) ?? []) listener(event);
    }
    return true;
  }
  find(tagName: string): HostNode | undefined {
    if (this.nodeName === tagName.toUpperCase()) return this;
    for (const child of this.childNodes) {
      const found = child.find(tagName);
      if (found) return found;
    }
  }
}

class HostEvent {
  target!: HostNode;
  currentTarget!: HostNode;
  bubbles = true;
  cancelable = true;
  defaultPrevented = false;
  constructor(readonly type: string) {}
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

class HostElement extends HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  style = {};
  attributes = new Map<string, string>();
  constructor(name: string, document: HostDocument) {
    super();
    this.nodeName = name.toUpperCase();
    this.ownerDocument = document;
  }
  get tagName() { return this.nodeName; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttributeNS(_namespace: string, name: string) { this.removeAttribute(name); }
}

class HostDocument extends HostNode {
  nodeType = 9;
  nodeName = "#document";
  documentElement = new HostElement("html", this);
  body = new HostElement("body", this);
  activeElement = this.body;
  defaultView = { document: this, HTMLIFrameElement: class {} };
  constructor() {
    super();
    this.ownerDocument = this;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  createElement(name: string) { return new HostElement(name, this); }
  createElementNS(namespace: string, name: string) {
    const element = this.createElement(name);
    element.namespaceURI = namespace;
    return element;
  }
  createTextNode(value: string) {
    const node = new HostNode();
    node.nodeType = 3;
    node.nodeName = "#text";
    node.nodeValue = value;
    node.ownerDocument = this;
    return node;
  }
}

const props = { teamId: "team-1", teamSlug: "example", tier: "team" as const, memberId: "viewer-1" };
const day = (label: string): TimelineDay => ({ date: "2026-09-19", label, people: [] });

describe("timeline same-viewer refresh", () => {
  let document: HostDocument;
  let container: HostElement;
  let root: import("react-dom/client").Root;
  let previousDocument: typeof globalThis.document | undefined;
  let previousWindow: typeof globalThis.window | undefined;

  beforeEach(async () => {
    cached.mockReset();
    document = new HostDocument();
    container = document.createElement("div");
    document.body.appendChild(container);
    previousDocument = globalThis.document;
    previousWindow = globalThis.window;
    Object.assign(globalThis, { document, window: document.defaultView, IS_REACT_ACT_ENVIRONMENT: true });
    // Node 25 exposes navigator globally, but CI's Node runtime does not. React DOM reads it
    // during its first import, before this custom host has rendered anything.
    vi.stubGlobal("navigator", { userAgent: "timeline-test" });
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    vi.unstubAllGlobals();
  });

  const refresh = async (root: import("react-dom/client").Root) => {
    const panel = await TimelinePanel(props);
    await act(async () => root.render(panel as ReactElement));
    return panel;
  };

  it("remounts on a changed authorized snapshot before revoked evidence can render", async () => {
    cached.mockResolvedValueOnce({ days: [day("Private title and evidence")] });
    const first = await refresh(root);
    expect(container.textContent).toContain("Private title and evidence");

    cached.mockResolvedValueOnce({ days: [] });
    const second = await refresh(root);
    expect(container.textContent).not.toContain("Private title and evidence");
    expect(container.textContent).toContain("No work in the last 7 days");
    expect(first.props.children.key).toMatch(/^[a-f0-9]{64}$/);
    expect(first.props.children.key).not.toBe(second.props.children.key);
  });

  it("aborts an expansion during revocation and ignores its late response", async () => {
    cached.mockResolvedValueOnce({ days: [day("Private title and evidence")] });
    await refresh(root);
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const fetchMock = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      expect(options.signal.aborted).toBe(false);
      return pending;
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => container.find("button")!.dispatchEvent(new HostEvent("click")));
    expect(fetchMock).toHaveBeenCalledOnce();
    const signal = fetchMock.mock.calls[0][1].signal;

    cached.mockResolvedValueOnce({ days: [] });
    await refresh(root);
    expect(signal.aborted).toBe(true);
    expect(container.textContent).not.toContain("Private title and evidence");

    await act(async () => finish({ ok: true, json: async () => ({ days: [day("Late private evidence")] }) }));
    expect(container.textContent).not.toContain("Late private evidence");
    expect(container.textContent).toContain("No work in the last 7 days");
  });

  it("clears revoked older expansion even when the new seven-day snapshot is identical", async () => {
    cached.mockResolvedValueOnce({ days: [] });
    const first = await refresh(root);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ days: [day("Revoked older evidence")] }),
    })));
    await act(async () => container.find("button")!.dispatchEvent(new HostEvent("click")));
    expect(container.textContent).toContain("Revoked older evidence");

    cached.mockResolvedValueOnce({ days: [] });
    const second = await refresh(root);
    expect(container.textContent).not.toContain("Revoked older evidence");
    expect(container.textContent).toContain("No work in the last 7 days");
    expect(first.props.children.key).not.toBe(second.props.children.key);
  });
});
