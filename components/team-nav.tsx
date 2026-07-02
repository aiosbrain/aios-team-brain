"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Blocks,
  Brain,
  FolderKanban,
  Gauge,
  Database,
  Gavel,
  GitBranch,
  Home,
  ListTodo,
  Shield,
  Sparkles,
  Wrench,
} from "lucide-react";

const ICONS = {
  home: Home,
  tasks: ListTodo,
  projects: FolderKanban,
  decisions: Gavel,
  library: Database,
  skills: Blocks,
  codebases: GitBranch,
  maturity: Gauge,
  teamtools: Wrench,
  query: Sparkles,
  learning: Brain,
  admin: Shield,
} as const;

export type NavLeaf = {
  icon: keyof typeof ICONS;
  label: string;
  href: string; // absolute path
  exact?: boolean;
};

/** A non-clickable section header that groups related leaf items beneath it. */
export type NavSection = { label: string; children: NavLeaf[] };

export type NavEntry = NavLeaf | NavSection;

function isSection(entry: NavEntry): entry is NavSection {
  return (entry as NavSection).children !== undefined;
}

function Leaf({ item, indent = false }: { item: NavLeaf; indent?: boolean }) {
  const pathname = usePathname();
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-2.5 rounded-lg py-2 text-[13px] font-medium tracking-wide transition-all ${
        indent ? "pl-5 pr-3" : "px-3"
      } ${
        active
          ? "bg-violet/10 text-violet"
          : "text-ink-secondary hover:bg-surface-card-hover hover:text-ink"
      }`}
    >
      <Icon className="size-4" strokeWidth={active ? 2 : 1.5} />
      {item.label}
    </Link>
  );
}

export function TeamNav({ items }: { items: NavEntry[] }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((entry) =>
        isSection(entry) ? (
          <div key={`section-${entry.label}`} className="mt-3 first:mt-0">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-tertiary">
              {entry.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {entry.children.map((c) => (
                <Leaf key={c.href} item={c} indent />
              ))}
            </div>
          </div>
        ) : (
          <Leaf key={entry.href} item={entry} />
        )
      )}
      <div className="mt-3 border-t border-border-subtle pt-2">
        <ThemeToggle />
      </div>
    </nav>
  );
}
