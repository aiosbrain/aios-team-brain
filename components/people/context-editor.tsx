"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import {
  CHANNEL_KINDS,
  WEEKDAYS,
  GOAL_KINDS,
  GOAL_STATUSES,
  TIME_OFF_KINDS,
  type Weekday,
  type WorkingHours,
} from "@/lib/identity/profile-constants";
import type { MemberContext } from "@/lib/identity/context";
import {
  saveProfile,
  addMemberTimeOff,
  deleteMemberTimeOff,
  saveMemberGoal,
  deleteMemberGoal,
} from "@/app/t/[team]/people/[handle]/actions";

interface EditorProps {
  teamSlug: string;
  memberId: string;
  context: MemberContext;
}

const TZ_OPTIONS: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

const inputCls =
  "rounded-md border border-border-subtle bg-surface-inset px-2.5 py-1.5 text-sm text-ink outline-none focus:border-violet";
const labelCls = "text-[11px] uppercase tracking-wider text-ink-tertiary";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-md bg-violet px-3 py-1.5 text-sm font-medium text-white hover:bg-violet/90 disabled:opacity-50";

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="text-xs text-rose-400">{msg}</p>;
}

// ── Profile form ──────────────────────────────────────────────────────────────

type HoursState = Record<Weekday, { on: boolean; start: string; end: string }>;

function initHours(wh: WorkingHours): HoursState {
  const out = {} as HoursState;
  for (const d of WEEKDAYS) {
    const span = wh[d];
    out[d] = { on: !!span, start: span?.[0] ?? "09:00", end: span?.[1] ?? "17:00" };
  }
  return out;
}

function ProfileForm({ teamSlug, memberId, context }: EditorProps) {
  const router = useRouter();
  const p = context.profile;
  const [timezone, setTimezone] = useState(p?.timezone ?? "");
  const [location, setLocation] = useState(p?.location ?? "");
  const [bio, setBio] = useState(p?.bio ?? "");
  const [channels, setChannels] = useState<string[]>(p?.preferredChannels ?? []);
  const [hours, setHours] = useState<HoursState>(initHours(p?.workingHours ?? {}));
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggleChannel(c: string) {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  function submit() {
    setErr(null);
    const workingHours: WorkingHours = {};
    for (const d of WEEKDAYS) {
      if (hours[d].on) workingHours[d] = [hours[d].start, hours[d].end];
    }
    start(async () => {
      const res = await saveProfile(teamSlug, memberId, {
        timezone,
        location,
        bio,
        preferredChannels: channels,
        workingHours,
      });
      if (!res.ok) setErr(res.error ?? "could not save");
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Timezone</span>
          <input
            className={inputCls}
            list="tz-options"
            value={timezone}
            placeholder="America/Los_Angeles"
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="tz-options">
            {TZ_OPTIONS.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Location</span>
          <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>Preferred channels (click in priority order)</span>
        <div className="flex flex-wrap gap-1.5">
          {CHANNEL_KINDS.map((c) => {
            const idx = channels.indexOf(c);
            const active = idx >= 0;
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggleChannel(c)}
                className={`rounded-full px-2.5 py-1 text-xs capitalize ${
                  active ? "bg-violet text-white" : "bg-surface-inset text-ink-secondary hover:text-ink"
                }`}
              >
                {active ? `${idx + 1}. ` : ""}
                {c.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>Working hours</span>
        <div className="flex flex-col gap-1">
          {WEEKDAYS.map((d) => (
            <div key={d} className="flex items-center gap-2 text-sm">
              <label className="flex w-20 items-center gap-1.5 capitalize text-ink-secondary">
                <input
                  type="checkbox"
                  checked={hours[d].on}
                  onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], on: e.target.checked } }))}
                />
                {d}
              </label>
              <input
                type="time"
                disabled={!hours[d].on}
                value={hours[d].start}
                onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], start: e.target.value } }))}
                className={`${inputCls} disabled:opacity-40`}
              />
              <span className="text-ink-tertiary">–</span>
              <input
                type="time"
                disabled={!hours[d].on}
                value={hours[d].end}
                onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], end: e.target.value } }))}
                className={`${inputCls} disabled:opacity-40`}
              />
            </div>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Bio</span>
        <textarea className={`${inputCls} min-h-20`} value={bio} onChange={(e) => setBio(e.target.value)} />
      </label>

      <Err msg={err} />
      <div>
        <button type="button" className={btnCls} disabled={pending} onClick={submit}>
          {pending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}

// ── Goals ─────────────────────────────────────────────────────────────────────

function GoalsEditor({ teamSlug, memberId, context }: EditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<(typeof GOAL_KINDS)[number]>("goal");
  const [status, setStatus] = useState<(typeof GOAL_STATUSES)[number]>("on_track");
  const [targetDate, setTargetDate] = useState("");
  const [detail, setDetail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function add() {
    setErr(null);
    start(async () => {
      const res = await saveMemberGoal(teamSlug, memberId, {
        title,
        kind,
        status,
        detail,
        targetDate: targetDate || null,
      });
      if (!res.ok) return setErr(res.error ?? "could not save");
      setTitle("");
      setDetail("");
      setTargetDate("");
      router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      const res = await deleteMemberGoal(teamSlug, memberId, id);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {context.goals.length ? (
        <div className="prism-card divide-y divide-border-subtle">
          {context.goals.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="text-ink-secondary">
                {g.kind === "okr" ? <span className="text-ink-tertiary">OKR · </span> : null}
                {g.title}
                <span className="ml-2 text-[11px] text-ink-tertiary">{g.status.replace(/_/g, " ")}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(g.id)}
                className="text-ink-tertiary hover:text-rose-400"
                aria-label="Delete goal"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
        <input
          className={inputCls}
          placeholder="Goal or OKR title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {GOAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            {GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <input
            type="date"
            className={inputCls}
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
        <input
          className={inputCls}
          placeholder="Detail (optional)"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
        <Err msg={err} />
        <div>
          <button type="button" className={btnCls} disabled={pending || !title.trim()} onClick={add}>
            <Plus className="size-4" /> Add goal
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Time off ──────────────────────────────────────────────────────────────────

function TimeOffEditor({ teamSlug, memberId, context }: EditorProps) {
  const router = useRouter();
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [kind, setKind] = useState<(typeof TIME_OFF_KINDS)[number]>("pto");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function add() {
    setErr(null);
    start(async () => {
      const res = await addMemberTimeOff(teamSlug, memberId, {
        startsOn,
        endsOn: endsOn || startsOn,
        kind,
        note,
      });
      if (!res.ok) return setErr(res.error ?? "could not save");
      setStartsOn("");
      setEndsOn("");
      setNote("");
      router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      const res = await deleteMemberTimeOff(teamSlug, memberId, id);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {context.timeOff.length ? (
        <div className="prism-card divide-y divide-border-subtle">
          {context.timeOff.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="text-ink-secondary">
                {t.startsOn === t.endsOn ? t.startsOn : `${t.startsOn} → ${t.endsOn}`}
                <span className="ml-2 text-[11px] uppercase text-ink-tertiary">{t.kind}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(t.id)}
                className="text-ink-tertiary hover:text-rose-400"
                aria-label="Delete time off"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="date"
            className={inputCls}
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
          <span className="text-ink-tertiary">→</span>
          <input type="date" className={inputCls} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {TIME_OFF_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <input
          className={inputCls}
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Err msg={err} />
        <div>
          <button type="button" className={btnCls} disabled={pending || !startsOn} onClick={add}>
            <Plus className="size-4" /> Add time off
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "goals", label: "Goals & OKRs" },
  { key: "timeoff", label: "Time off" },
] as const;

/** Self-or-admin editor for a member's identity context. Collapsed by default. */
export function ContextEditor(props: EditorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("profile");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-sm text-ink-secondary hover:text-ink"
      >
        <Pencil className="size-3.5" /> Edit context
      </button>
    );
  }

  return (
    <section className="prism-card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                tab === t.key ? "bg-surface-inset text-ink" : "text-ink-tertiary hover:text-ink-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ink-tertiary hover:text-ink"
          aria-label="Close editor"
        >
          <X className="size-4" />
        </button>
      </div>

      {tab === "profile" ? <ProfileForm {...props} /> : null}
      {tab === "goals" ? <GoalsEditor {...props} /> : null}
      {tab === "timeoff" ? <TimeOffEditor {...props} /> : null}
    </section>
  );
}
