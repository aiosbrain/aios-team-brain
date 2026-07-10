"use client";

import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/actions/account";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1 text-xs text-ink-secondary hover:border-red-300 hover:text-red-600"
      >
        <LogOut className="size-3.5" strokeWidth={1.75} />
        Sign out
      </button>
    </form>
  );
}
