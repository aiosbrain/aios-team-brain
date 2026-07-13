// 5 brand-ish avatar colors chosen from a name hash — matches components/learning/events-feed.tsx's
// scheme so a person always gets the same fallback color everywhere they appear.
const AVATAR_BG = ["bg-violet", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
}

function colorFor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_BG[h % AVATAR_BG.length];
}

export interface MemberAvatarPerson {
  displayName: string;
  /** Self-uploaded photo (member_profiles.avatar_data_url) — wins over the GitHub avatar. */
  avatarDataUrl?: string | null;
  /** GitHub-synced avatar (members.avatar_url). */
  avatarUrl?: string | null;
}

const SIZE_CLASS: Record<number, string> = {
  16: "size-4 text-[8px]",
  20: "size-5 text-[9px]",
  24: "size-6 text-[10px]",
  32: "size-8 text-xs",
  40: "size-10 text-sm",
  48: "size-12 text-base",
  56: "size-14 text-lg",
};

/**
 * The ONE place a person's picture is resolved and rendered: uploaded photo → GitHub avatar →
 * initials-on-a-hashed-color fallback. Use this instead of an inline `<img>`/initials ternary
 * everywhere a person is named in the UI — previously duplicated independently in ~5 places.
 */
export function MemberAvatar({ person, size = 32, className = "" }: {
  person: MemberAvatarPerson;
  size?: 16 | 20 | 24 | 32 | 40 | 48 | 56;
  className?: string;
}) {
  const src = person.avatarDataUrl || person.avatarUrl || null;
  const sizeClass = SIZE_CLASS[size] ?? SIZE_CLASS[32];

  if (src) {
    // data: URLs and arbitrary GitHub hosts aren't a fit for next/image's fixed-domain optimizer;
    // these are small (avatar-sized) either way.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={person.displayName}
        className={`${sizeClass} shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${colorFor(person.displayName)} ${className}`}
      title={person.displayName}
    >
      {initialsFor(person.displayName)}
    </span>
  );
}
