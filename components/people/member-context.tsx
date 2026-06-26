import { Clock, MapPin, MessageSquare, Plane, Target, FolderGit2 } from "lucide-react";
import type { MemberContext } from "@/lib/identity/context";

const WEEKDAYS: { key: keyof NonNullable<MemberContext["profile"]>["workingHours"]; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

const GOAL_STATUS_STYLE: Record<string, string> = {
  on_track: "bg-emerald-500/10 text-emerald-400",
  at_risk: "bg-amber-500/10 text-amber-400",
  off_track: "bg-rose-500/10 text-rose-400",
  done: "bg-violet/10 text-violet",
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">{children}</h2>
  );
}

function ProfileFacts({ profile }: { profile: NonNullable<MemberContext["profile"]> }) {
  const days = WEEKDAYS.filter((d) => profile.workingHours[d.key]);
  return (
    <section className="prism-card flex flex-col gap-4 p-5">
      <SectionHeading>Working context</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {profile.timezone ? (
          <div className="flex items-center gap-2 text-sm text-ink-secondary">
            <Clock className="size-4 text-ink-tertiary" />
            <span>{profile.timezone.replace(/_/g, " ")}</span>
          </div>
        ) : null}
        {profile.location ? (
          <div className="flex items-center gap-2 text-sm text-ink-secondary">
            <MapPin className="size-4 text-ink-tertiary" />
            <span>{profile.location}</span>
          </div>
        ) : null}
        {profile.preferredChannels.length ? (
          <div className="flex items-center gap-2 text-sm text-ink-secondary">
            <MessageSquare className="size-4 text-ink-tertiary" />
            <span className="capitalize">{profile.preferredChannels.join(" › ").replace(/_/g, " ")}</span>
          </div>
        ) : null}
      </div>

      {days.length ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] uppercase tracking-wider text-ink-tertiary">Working hours</p>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d) => {
              const span = profile.workingHours[d.key]!;
              return (
                <span
                  key={d.key}
                  className="rounded-md bg-surface-inset px-2 py-1 text-xs text-ink-secondary"
                >
                  <span className="font-medium text-ink">{d.label}</span> {span[0]}–{span[1]}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {profile.bio ? <p className="text-sm leading-relaxed text-ink-secondary">{profile.bio}</p> : null}
    </section>
  );
}

function Goals({ goals }: { goals: MemberContext["goals"] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Goals &amp; OKRs</SectionHeading>
      <div className="prism-card divide-y divide-border-subtle">
        {goals.map((g) => (
          <div key={g.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <Target className="mt-0.5 size-4 shrink-0 text-ink-tertiary" />
              <div>
                <p className="text-sm font-medium text-ink">
                  {g.kind === "okr" ? <span className="text-ink-tertiary">OKR · </span> : null}
                  {g.title}
                </p>
                {g.detail ? <p className="mt-0.5 text-xs text-ink-tertiary">{g.detail}</p> : null}
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-tertiary">
                  {g.targetDate ? <span>due {g.targetDate}</span> : null}
                  {g.source !== "manual" ? <span className="uppercase">· {g.source}</span> : null}
                </div>
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                GOAL_STATUS_STYLE[g.status] ?? "bg-surface-inset text-ink-tertiary"
              }`}
            >
              {g.status.replace(/_/g, " ")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Projects({ projects }: { projects: MemberContext["projects"] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Projects</SectionHeading>
      <div className="prism-card divide-y divide-border-subtle">
        {projects.map((p) => (
          <div key={p.slug} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="flex items-center gap-2 font-medium text-ink">
              <FolderGit2 className="size-4 text-ink-tertiary" />
              {p.name}
            </span>
            <span className="text-ink-secondary">
              {p.open} open
              <span className="ml-2 text-ink-tertiary">of {p.total}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TimeOff({ timeOff }: { timeOff: MemberContext["timeOff"] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Time off</SectionHeading>
      <div className="prism-card divide-y divide-border-subtle">
        {timeOff.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-ink-secondary">
              <Plane className="size-4 text-ink-tertiary" />
              {t.startsOn === t.endsOn ? t.startsOn : `${t.startsOn} → ${t.endsOn}`}
              {t.note ? <span className="text-ink-tertiary">· {t.note}</span> : null}
            </span>
            <span className="text-[11px] uppercase tracking-wider text-ink-tertiary">{t.kind}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Renders a member's identity context. Renders nothing when there is no context to show. */
export function MemberContextPanel({ context }: { context: MemberContext }) {
  const hasProfile = !!context.profile;
  const hasAnything =
    hasProfile || context.goals.length > 0 || context.projects.length > 0 || context.timeOff.length > 0;
  if (!hasAnything) return null;

  return (
    <>
      {context.profile ? <ProfileFacts profile={context.profile} /> : null}
      {context.goals.length ? <Goals goals={context.goals} /> : null}
      {context.projects.length ? <Projects projects={context.projects} /> : null}
      {context.timeOff.length ? <TimeOff timeOff={context.timeOff} /> : null}
    </>
  );
}
