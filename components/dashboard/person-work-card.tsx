"use client";

// `Gavel` is the decisions glyph — the SAME one the Pulse "Recent decisions" card and the decisions page
// use, so a decision reads identically wherever it appears (the Context lane used to diverge on `Scale`).
import { GitBranch, Gavel } from "lucide-react";
import { MemberAvatar } from "@/components/people/member-avatar";
import { SourceIcon, sourceLabel } from "@/components/icons/source-icon";
import { isBareDate, type PersonDay, type SignalGroup, type SourceGroup, type TaskGroup } from "@/lib/dashboard/timeline-group";
import { headlineTask, sourceCounts } from "@/lib/dashboard/pulse-digest";

/**
 * One person's work card — the shared presentational unit behind BOTH the Pulse Timeline panel
 * (day → person → work) and the Home → "Working on" section (each person's most recent day). Keeping a
 * single component is what makes the two surfaces identical. Pure/client-safe: renders a `PersonDay`,
 * no data fetching. Evidence (commits, docs, …) nests under the task it contributes to, with an "Other"
 * bucket for evidence tied to no active task.
 */

function timeOf(at: string): string {
  // A BARE DATE has no time to show. `meeting_notes.occurred_at` is a `date` column, so a meeting
  // genuinely has no clock time; `Date.parse("2026-07-22")` reads it as UTC midnight and would render
  // a confident, wrong "12:00 AM" (or the local-timezone shift of it). Signals already render
  // bare-date rows with no timestamp for the same reason — this makes the rule general.
  if (isBareDate(at)) return "";
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "3 tasks · 12 items · 2 decisions" — activity at a glance. Decisions are SIGNAL (context), so they're a
 *  SEPARATE, labelled count — never folded into the work "items" tally (that would credit signal as work). */
export function personSummary(p: PersonDay): string {
  // Counts what the card SHOWS — tasks plus the unlinked lane below them. The header and the body must
  // agree: "23 items" above five visible rows is how a summary stops being trusted.
  const items = p.tasks.reduce((n, t) => n + t.evidenceCount, 0) + p.other.reduce((n, g) => n + g.count, 0);
  const decisions = p.signals.reduce((n, g) => n + g.count, 0);
  const parts: string[] = [];
  if (p.tasks.length) parts.push(`${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"}`);
  parts.push(`${items} item${items === 1 ? "" : "s"}`);
  if (decisions) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  backlog: { label: "Backlog", cls: "text-ink-tertiary bg-ink-tertiary/10" },
  ready: { label: "Ready", cls: "text-sky-700 bg-sky-500/10" },
  in_progress: { label: "In progress", cls: "text-violet bg-violet/10" },
  in_review: { label: "In review", cls: "text-amber-700 bg-amber-500/10" },
  blocked: { label: "Blocked", cls: "text-red-700 bg-red-500/10" },
  done: { label: "Done", cls: "text-emerald-700 bg-emerald-500/10" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { label: status || "—", cls: "text-ink-tertiary bg-ink-tertiary/10" };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`}>{s.label}</span>;
}

/** The evidence items of one source (nested under a task or in Other), newest-first with "+N more". */
function EvidenceList({ group }: { group: SourceGroup }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
        <SourceIcon source={group.source} className="size-3.5" />
        {sourceLabel(group.source)}
        <span className="font-normal text-ink-tertiary/70">· {group.count}</span>
      </div>
      <ul className="flex flex-col gap-1 border-l border-border-subtle pl-3">
        {group.items.map((it) => (
          <li key={it.id} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-3">
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer" className="truncate text-sm text-ink hover:text-violet">
                  {it.title}
                </a>
              ) : (
                <span className="truncate text-sm text-ink">{it.title}</span>
              )}
              <span className="shrink-0 text-[11px] text-ink-tertiary">{timeOf(it.at)}</span>
            </div>
            {it.linkedTask ? (
              <span
                className="inline-flex max-w-full items-center gap-1 self-start rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary"
                title={`References ${it.linkedTask.key} (${it.linkedTask.status}): ${it.linkedTask.title}`}
              >
                <GitBranch className="size-3 shrink-0 text-ink-tertiary" />
                <span className="shrink-0 font-medium text-ink-secondary">{it.linkedTask.key}</span>
                <span className="truncate text-ink-tertiary">· {it.linkedTask.title}</span>
                {it.linkedTask.status ? <span className="shrink-0 text-ink-tertiary/70">· {it.linkedTask.status}</span> : null}
              </span>
            ) : null}
          </li>
        ))}
        {group.count > group.items.length ? (
          <li className="text-[11px] text-ink-tertiary">+{group.count - group.items.length} more</li>
        ) : null}
      </ul>
    </div>
  );
}

/** A task header (source icon + title + status) with its evidence nested. */
function TaskCard({ task }: { task: TaskGroup }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-subtle/60 p-2.5">
      <div className="flex items-center gap-2">
        {/* WHOSE task — shown only when it ISN'T yours. The timeline credits work to whoever DID it, so a
            teammate's ticket legitimately lands on your day, and nothing distinguished it from your own.
            A miniature avatar on the left reads as "this one is theirs" at a glance, without a row of
            explanatory text on every task. Carries a title + SR-only name because a face is not text. */}
        {task.assignee ? (
          <span className="flex shrink-0 items-center" title={`${task.assignee.name}'s task`}>
            <MemberAvatar
              person={{ displayName: task.assignee.name, avatarUrl: task.assignee.avatarUrl }}
              size={16}
              className="ring-1 ring-border-subtle"
            />
            <span className="sr-only">{task.assignee.name}&rsquo;s task —</span>
          </span>
        ) : null}
        <SourceIcon source={task.source} className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{task.title}</span>
        <StatusPill status={task.status} />
      </div>
      {task.sources.length ? (
        <div className="flex flex-col gap-2 pl-6">
          {task.sources.map((g) => (
            <EvidenceList key={g.source} group={g} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** How many source chips a snapshot row shows before collapsing the rest into "+N". */
const ROW_SOURCE_CHIPS = 2;

/**
 * The SNAPSHOT row — one person at reading density, not the full card's evidence tree.
 *
 * The first cut of this was task-centric (headline task + status pill, summary as a one-line
 * `truncate` fallback) and it was wrong about the data: on prod EVERY person had `tasks: 0`, so the
 * task line never rendered and the row always fell through to a 190-char synopsis clipped to ~45
 * characters — in a column that had ~250px of unused vertical space. Compressing vertically in the one
 * place with room to spare, while destroying the only informative field, is the opposite of the trade
 * that was wanted.
 *
 * So the synopsis is now PRIMARY and gets four lines; the task line is the optional extra shown when
 * linking actually resolves one. Both variants still render the same `PersonDay` (the #358 invariant) —
 * one component, two densities, not a second implementation.
 */
function PersonWorkRow({ person }: { person: PersonDay }) {
  const p = person;
  const lead = headlineTask(p);
  const sources = sourceCounts(p);
  const chips = sources.slice(0, ROW_SOURCE_CHIPS);
  const restChips = sources.length - chips.length;
  return (
    <div className="flex gap-2.5 rounded-md border border-border-subtle/60 px-3 py-2.5">
      <MemberAvatar person={{ displayName: p.name, avatarUrl: p.avatarUrl }} size={24} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-ink">{p.name}</p>
          {/* Where the work happened — the cheap signal that survives when no task resolves. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {chips.map((s) => (
              // The brand glyphs are aria-hidden, so without a label the chip announces as a bare
              // number ("10"). Matches the sr-only precedent on the TaskCard assignee avatar.
              <span
                key={s.source}
                className="flex items-center gap-1 text-[11px] text-ink-tertiary"
                title={`${sourceLabel(s.source)}: ${s.count}`}
                aria-label={`${sourceLabel(s.source)}: ${s.count} items`}
              >
                <SourceIcon source={s.source} className="size-3" />
                {s.count}
              </span>
            ))}
            {/* Counts SOURCES, while its siblings count items — "+1" beside "github 10" otherwise reads
                as one more item. */}
            {restChips > 0 ? (
              <span
                className="text-[11px] text-ink-tertiary"
                title={`${restChips} more source${restChips > 1 ? "s" : ""}`}
                aria-label={`${restChips} more source${restChips > 1 ? "s" : ""}`}
              >
                +{restChips}
              </span>
            ) : null}
          </div>
        </div>

        {lead ? (
          <div className="flex items-center gap-1.5">
            <SourceIcon source={lead.source} className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">{lead.title}</span>
            <StatusPill status={lead.status} />
          </div>
        ) : null}

        {/* The LLM synopsis — the actual answer to "what is this person doing". Clamped, not truncated.
            Four lines, not three: measured against the real payload at this column's width (~40% of
            max-w-6xl), prod's longest summary (190 chars) needs four lines and was still losing its last
            clause at three. The synopsis is 1–3 sentences by construction, so this fits essentially all
            of them; the clamp stays as the backstop against one long outlier, not as the normal case. */}
        {p.summary ? (
          <p className="line-clamp-4 text-[13px] leading-snug text-ink-secondary">{p.summary}</p>
        ) : !lead ? (
          <p className="text-[12px] text-ink-tertiary">{personSummary(p)}</p>
        ) : null}
      </div>
    </div>
  );
}

export function PersonWorkCard({ person, variant = "full" }: { person: PersonDay; variant?: "full" | "row" }) {
  const p = person;
  if (variant === "row") return <PersonWorkRow person={p} />;
  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2.5">
        <MemberAvatar person={{ displayName: p.name, avatarUrl: p.avatarUrl }} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{p.name}</p>
          <p className="text-[11px] text-ink-tertiary">{personSummary(p)}</p>
        </div>
      </div>

      {p.summary ? <p className="text-[13px] leading-snug text-ink-secondary">{p.summary}</p> : null}

      {p.tasks.length ? (
        <div className="flex flex-col gap-2">
          {p.tasks.map((t) => (
            <TaskCard key={t.taskId} task={t} />
          ))}
        </div>
      ) : null}

      {p.other.length ? (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary/80">
            Other · not yet linked to a task
          </div>
          <div className="flex flex-col gap-2 pl-1">
            {p.other.map((g) => (
              <EvidenceList key={g.source} group={g} />
            ))}
          </div>
        </div>
      ) : null}

      {p.signals.length ? <ContextLane signals={p.signals} /> : null}
    </div>
  );
}

/** The Context lane — data ABOUT work (decisions), shown dimmer + clearly separate from the work above, so
 *  it's never read as the person's output. No timestamp (signals are bare-date). */
function ContextLane({ signals }: { signals: SignalGroup[] }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary/70">
        Context · not counted as work
      </div>
      <ul className="flex flex-col gap-1 pl-1">
        {signals.flatMap((g) => g.items).map((s) => (
          <li key={s.id} className="flex items-start gap-1.5 text-[13px] text-ink-tertiary">
            <Gavel className="mt-0.5 size-3 shrink-0 text-amber" />
            <span className="truncate">
              decided:{" "}
              {s.url ? (
                <a href={s.url} className="text-ink-secondary hover:text-violet">{s.title}</a>
              ) : (
                <span className="text-ink-secondary">{s.title}</span>
              )}
              {s.stillValid === false ? <span className="text-ink-tertiary/60"> · superseded</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
