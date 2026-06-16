"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Blocks,
  FolderKanban,
  Gavel,
  Home,
  Library,
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
  library: Library,
  skills: Blocks,
  teamtools: Wrench,
  query: Sparkles,
  admin: Shield,
} as const;

export type NavItem = {
  icon: keyof typeof ICONS;
  label: string;
  href: string; // absolute path
  exact?: boolean;
};

export function TeamNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = ICONS[item.icon];
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium tracking-wide transition-all ${
              active
                ? "bg-violet/10 text-violet"
                : "text-ink-secondary hover:bg-surface-card-hover hover:text-ink"
            }`}
          >
            <Icon className="size-4" strokeWidth={active ? 2 : 1.5} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
