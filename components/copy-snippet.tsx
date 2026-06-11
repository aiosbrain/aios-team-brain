"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Monospace snippet with a copy-to-clipboard button. */
export function CopySnippet({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — leave the text selectable
    }
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface-overlay px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-ink-secondary">
        {label ? <span className="text-ink-tertiary">{label} </span> : null}
        {text}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md p-1.5 text-ink-tertiary transition-colors hover:bg-violet/10 hover:text-violet"
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
