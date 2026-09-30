import type { EvidenceItem, PersonDay, SignalGroup, SourceGroup, TaskGroup, TimelineDay } from "./timeline-group";
import { MEETING_SOURCE } from "./timeline-group";

/**
 * Merge one page of Slack-only groups into an already authorized Timeline snapshot. The caller owns
 * asOf, view, visibility and generation checks; this function does not authorize either input.
 * `EvidenceItem.id` must be the stable source-evidence ID (not merely a thread/item ID).
 * Continuation groups contain only their newly returned rows; their supplied counts are ignored.
 */
export function mergeTimelineSlackContinuation(existing: TimelineDay[], page: TimelineDay[]): TimelineDay[] {
  if (!Array.isArray(existing) || !Array.isArray(page)) throw new Error("Invalid timeline continuation arrays");

  const days = new Map<string, DayState>();
  for (const day of existing) {
    checkDay(day);
    if (days.has(day.date)) throw new Error(`Duplicate initial timeline date: ${day.date}`);
    const state: DayState = { date: day.date, label: day.label, people: new Map() };
    days.set(day.date, state);
    for (const person of day.people) {
      checkPerson(person);
      if (state.people.has(person.memberId)) throw new Error(`Duplicate initial timeline person: ${person.memberId}`);
      const tasks = new Map<string, TaskGroup>();
      let changed = false;
      for (const task of person.tasks) {
        checkTask(task);
        if (tasks.has(task.taskId)) throw new Error(`Duplicate initial timeline task: ${task.taskId}`);
        const sources = copyInitialGroups(task.sources);
        changed ||= slackCount(task.sources) !== slackCount(sources);
        tasks.set(task.taskId, { ...task, sources });
      }
      const other = copyInitialGroups(person.other);
      changed ||= slackCount(person.other) !== slackCount(other);
      state.people.set(person.memberId, {
        base: { ...person, signals: copySignals(person.signals) },
        tasks,
        other,
        changed,
      });
    }
  }

  // Validate the entire page before mutating the local copy. A caller can retry after any rejection.
  for (const day of page) {
    checkDay(day);
    if (day.date === "unknown") fail("undated Slack continuation");
    if (day.people.length === 0) throw new Error("Continuation day has no people");
    const priorDay = days.get(day.date);
    if (priorDay && priorDay.label !== day.label) throw new Error(`Conflicting timeline label: ${day.date}`);
    for (const person of day.people) {
      checkPerson(person);
      if (person.summary !== undefined || person.signals.length !== 0) throw new Error("Continuation contains synopsis or signals");
      if (person.tasks.length === 0 && person.other.length === 0) throw new Error("Continuation person has no Slack evidence");
      const prior = priorDay?.people.get(person.memberId);
      if (prior && !samePerson(prior.base, person)) throw new Error(`Conflicting timeline person: ${person.memberId}`);
      for (const task of person.tasks) {
        checkTask(task);
        if (task.sources.length === 0) fail("empty continuation task");
        const oldTask = prior?.tasks.get(task.taskId);
        if (oldTask && !sameTask(oldTask, task)) throw new Error(`Conflicting timeline task: ${task.taskId}`);
        checkPageGroups(task.sources, day.date);
      }
      if (person.other.length) checkPageGroups(person.other, day.date);
    }
  }

  for (const day of page) {
    let target = days.get(day.date);
    if (!target) {
      target = { date: day.date, label: day.label, people: new Map() };
      days.set(day.date, target);
    }
    for (const person of day.people) {
      let p = target.people.get(person.memberId);
      if (!p) {
        p = { base: { ...person, avatarUrl: person.avatarUrl ?? null, summary: undefined, signals: [] },
          tasks: new Map(), other: [], changed: true };
        target.people.set(person.memberId, p);
      }
      if (!samePerson(p.base, person)) throw new Error(`Conflicting timeline person: ${person.memberId}`);
      for (const task of person.tasks) {
        let t = p.tasks.get(task.taskId);
        if (!t) {
          t = { ...task, sources: [],
            ...(task.assignee ? { assignee: { name: task.assignee.name, avatarUrl: task.assignee.avatarUrl ?? null } } : {}) };
          p.tasks.set(task.taskId, t);
          p.changed = true;
        }
        if (!sameTask(t, task)) throw new Error(`Conflicting timeline task: ${task.taskId}`);
        p.changed = unionSlack(t.sources, task.sources) || p.changed;
      }
      p.changed = unionSlack(p.other, person.other) || p.changed;
    }
  }

  return [...days.values()]
    .sort((a, b) => compareDate(a.date, b.date))
    .map((day) => ({
      date: day.date,
      label: day.label,
      people: [...day.people.values()]
        .map(finishPerson)
        .sort((a, b) => b.total - a.total || compare(a.name, b.name) || compare(a.memberId, b.memberId)),
    }));
}

interface PersonState {
  base: PersonDay;
  tasks: Map<string, TaskGroup>;
  other: SourceGroup[];
  changed: boolean;
}
interface DayState { date: string; label: string; people: Map<string, PersonState> }

function fail(field: string): never { throw new Error(`Malformed timeline continuation: ${field}`); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareDate(a: string, b: string): number {
  return a === "unknown" ? (b === "unknown" ? 0 : 1) : b === "unknown" ? -1 : compare(b, a);
}
function checkDay(day: TimelineDay): void {
  if (!day || !nonempty(day.date) || !nonempty(day.label) || !Array.isArray(day.people) ||
      (day.date !== "unknown" && (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        Number.isNaN(Date.parse(`${day.date}T00:00:00Z`)) ||
        new Date(`${day.date}T00:00:00Z`).toISOString().slice(0, 10) !== day.date))) fail("day");
}
function checkPerson(p: PersonDay): void {
  if (!p || !nonempty(p.memberId) || !nonempty(p.name) || typeof p.handle !== "string" ||
      !count(p.total) || !count(p.unlinked) || !Array.isArray(p.tasks) ||
      !Array.isArray(p.other) || !Array.isArray(p.signals) ||
      (p.avatarUrl != null && typeof p.avatarUrl !== "string")) fail("person");
}
function checkTask(t: TaskGroup): void {
  if (!t || !nonempty(t.taskId) || !nonempty(t.title) || typeof t.status !== "string" ||
      !nonempty(t.source) || !count(t.evidenceCount) || !Array.isArray(t.sources) ||
      (t.assignee !== undefined && (!t.assignee || !nonempty(t.assignee.name) ||
        (t.assignee.avatarUrl != null && typeof t.assignee.avatarUrl !== "string")))) fail("task");
}
function checkPageGroups(groups: SourceGroup[], date: string): void {
  if (groups.length === 0) fail("Slack source groups");
  for (const group of groups) {
    if (!group || group.source !== "slack" || !count(group.count) || !Array.isArray(group.items) ||
        group.items.length === 0) fail("non-Slack or empty continuation group");
    for (const item of group.items) {
      checkSlackItem(item);
      if (item.at.slice(0, 10) !== date) fail("Slack item day");
    }
  }
}
function checkSlackItem(item: EvidenceItem): void {
  if (!item || !nonempty(item.id) || !nonempty(item.title) || item.source !== "slack" ||
      !nonempty(item.kind) || !nonempty(item.at) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(item.at) ||
      Number.isNaN(Date.parse(item.at)) || (item.url !== undefined && typeof item.url !== "string") ||
      (item.linkVia !== undefined && !["commit-text", "pr", "inferred"].includes(item.linkVia)) ||
      (item.via !== undefined && item.via !== "submitter") ||
      (item.linkedTask !== undefined && (!item.linkedTask || !nonempty(item.linkedTask.key) ||
        !nonempty(item.linkedTask.title) || typeof item.linkedTask.status !== "string"))) fail("Slack item");
}
function copyInitialGroups(groups: SourceGroup[]): SourceGroup[] {
  if (!Array.isArray(groups)) fail("initial source groups");
  const out: SourceGroup[] = [];
  for (const g of groups) {
    if (!g || !nonempty(g.source) || !count(g.count) || !Array.isArray(g.items)) fail("initial source group");
    if (g.source === "slack") {
      if (g.count !== g.items.length) fail("capped initial Slack group");
      g.items.forEach(checkSlackItem);
      unionSlack(out, [g]);
    } else {
      out.push({ ...g, items: [...g.items] });
    }
  }
  return out;
}
function slackCount(groups: SourceGroup[]): number {
  return groups.filter((g) => g.source === "slack").reduce((n, g) => n + g.items.length, 0);
}
function copySignals(groups: SignalGroup[]): SignalGroup[] {
  return groups.map((g) => ({ ...g, items: [...g.items] }));
}
function samePerson(a: PersonDay, b: PersonDay): boolean {
  return a.name === b.name && a.handle === b.handle && (a.avatarUrl ?? null) === (b.avatarUrl ?? null);
}
function sameTask(a: TaskGroup, b: TaskGroup): boolean {
  return a.title === b.title && a.status === b.status && a.source === b.source &&
    (a.assignee?.name ?? null) === (b.assignee?.name ?? null) &&
    (a.assignee?.avatarUrl ?? null) === (b.assignee?.avatarUrl ?? null);
}
function sameItem(a: EvidenceItem, b: EvidenceItem): boolean {
  return a.id === b.id && a.title === b.title && a.at === b.at && a.kind === b.kind &&
    (a.url ?? null) === (b.url ?? null) && (a.linkVia ?? null) === (b.linkVia ?? null) &&
    (a.via ?? null) === (b.via ?? null) && (a.linkedTask?.key ?? null) === (b.linkedTask?.key ?? null) &&
    (a.linkedTask?.title ?? null) === (b.linkedTask?.title ?? null) &&
    (a.linkedTask?.status ?? null) === (b.linkedTask?.status ?? null);
}
function unionSlack(target: SourceGroup[], incoming: SourceGroup[]): boolean {
  let changed = false;
  for (const group of incoming) {
    let current = target.find((g) => g.source === "slack");
    if (!current) {
      current = { source: "slack", count: 0, items: [] };
      target.push(current);
    }
    const byId = new Map(current.items.map((item) => [item.id, item]));
    for (const item of group.items) {
      const old = byId.get(item.id);
      if (old && !sameItem(old, item)) throw new Error(`Conflicting Slack evidence: ${item.id}`);
      if (!old) {
        current.items.push(item);
        byId.set(item.id, item);
        changed = true;
      }
    }
    current.count = current.items.length;
  }
  return changed;
}
function sortGroups(groups: SourceGroup[]): SourceGroup[] {
  return groups.map((g) => ({ ...g, items: [...g.items].sort((a, b) => compare(b.at, a.at) || compare(a.id, b.id)) }))
    .sort((a, b) => b.count - a.count || compare(a.source, b.source));
}
function finishPerson(p: PersonState): PersonDay {
  const tasks = [...p.tasks.values()].map((t) => {
    const sources = sortGroups(t.sources);
    return { ...t, sources, evidenceCount: sources.reduce((sum, g) => sum + g.count, 0) };
  }).sort((a, b) => b.evidenceCount - a.evidenceCount || compare(a.title, b.title) || compare(a.taskId, b.taskId));
  const other = sortGroups(p.other);
  const slackIds = new Set<string>();
  const slackItemById = new Map<string, EvidenceItem>();
  for (const group of [...tasks.flatMap((t) => t.sources), ...other]) {
    if (group.source === "slack") for (const item of group.items) {
      const previous = slackItemById.get(item.id);
      if (previous && (previous.title !== item.title || previous.at !== item.at ||
          previous.kind !== item.kind || (previous.url ?? null) !== (item.url ?? null))) {
        throw new Error(`Conflicting Slack source evidence: ${item.id}`);
      }
      slackItemById.set(item.id, item);
      slackIds.add(item.id);
    }
  }
  const nonSlackTotal = [...tasks.flatMap((t) => t.sources), ...other]
    .filter((g) => g.source !== "slack").reduce((sum, g) => sum + g.count, 0);
  const unlinked = other.reduce((sum, g) => sum + (g.source === MEETING_SOURCE ? 0 : g.count), 0);
  return {
    ...p.base,
    tasks,
    other,
    total: nonSlackTotal + slackIds.size,
    unlinked,
    ...(p.changed ? { summary: undefined } : {}),
  };
}
