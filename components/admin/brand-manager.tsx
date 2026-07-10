"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Save } from "lucide-react";
import { saveBrand } from "@/app/t/[team]/admin/brand/actions";
import type { BrandProfileInput } from "@/lib/brand/schema";

type FieldType = "list" | "text" | "enum";
interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: string[]; // for enum
  placeholder?: string;
  hint?: string;
}

const SECTIONS: { key: "voice" | "knowledge" | "governance"; title: string; blurb: string; fields: Field[] }[] = [
  {
    key: "voice",
    title: "Voice",
    blurb: "How the brand sounds. Lists are one item per line.",
    fields: [
      { key: "vocabulary", label: "Vocabulary", type: "list", placeholder: "words/terms to favor" },
      { key: "sentenceLength", label: "Sentence length", type: "enum", options: ["short", "medium", "long", "varied"] },
      { key: "humor", label: "Humor", type: "enum", options: ["none", "dry", "playful", "bold"] },
      { key: "formality", label: "Formality", type: "enum", options: ["casual", "neutral", "formal"] },
      { key: "emojiUsage", label: "Emoji usage", type: "enum", options: ["none", "sparing", "liberal"] },
      { key: "punctuation", label: "Punctuation notes", type: "text", placeholder: "e.g. no em dashes" },
      { key: "formatting", label: "Formatting preferences", type: "text", placeholder: "e.g. short paragraphs, no hashtags" },
      { key: "ctas", label: "Preferred CTAs", type: "list", placeholder: "one call-to-action per line" },
      { key: "preferredPhrases", label: "Preferred phrases", type: "list" },
      { key: "prohibitedPhrases", label: "Prohibited phrases", type: "list" },
    ],
  },
  {
    key: "knowledge",
    title: "Company knowledge",
    blurb: "What the brand may say about itself.",
    fields: [
      { key: "products", label: "Products", type: "list" },
      { key: "positioning", label: "Positioning", type: "text" },
      { key: "audiences", label: "Target audiences", type: "list" },
      { key: "competitors", label: "Competitors", type: "list" },
      { key: "history", label: "Company history", type: "text" },
      { key: "claimsAllowed", label: "Claims that may be made", type: "list" },
      { key: "claimsNeedingVerification", label: "Claims requiring verification", type: "list" },
      { key: "roadmapVisibility", label: "Roadmap visibility", type: "enum", options: ["public", "hint", "private"] },
    ],
  },
  {
    key: "governance",
    title: "Governance",
    blurb: "Guardrails validated before content is approved or published.",
    fields: [
      { key: "confidentialTopics", label: "Confidential topics", type: "list" },
      { key: "legalRestrictions", label: "Legal restrictions", type: "list" },
      { key: "pricingRules", label: "Pricing rules", type: "text" },
      { key: "disclosureRequirements", label: "Disclosure requirements", type: "list" },
      { key: "requiredMentions", label: "Required mentions", type: "list" },
      { key: "approvalThresholds", label: "Approval thresholds", type: "text", placeholder: "when human approval is required" },
      { key: "platformPolicies", label: "Platform-specific policies", type: "text" },
    ],
  },
];

type Values = Record<string, string>;

/** Flatten a stored profile into "section.field" string values for the form. */
function toValues(profile: BrandProfileInput | null): Values {
  const v: Values = {};
  if (!profile) return v;
  for (const section of SECTIONS) {
    const obj = (profile[section.key] ?? {}) as Record<string, unknown>;
    for (const f of section.fields) {
      const raw = obj[f.key];
      if (Array.isArray(raw)) v[`${section.key}.${f.key}`] = raw.join("\n");
      else if (typeof raw === "string") v[`${section.key}.${f.key}`] = raw;
    }
  }
  return v;
}

/** Assemble the nested BrandProfileInput from the flat form values (omitting empties). */
function toProfile(values: Values): BrandProfileInput {
  const out: Record<string, Record<string, unknown>> = {};
  for (const section of SECTIONS) {
    const obj: Record<string, unknown> = {};
    for (const f of section.fields) {
      const raw = (values[`${section.key}.${f.key}`] ?? "").trim();
      if (!raw) continue;
      if (f.type === "list") {
        const arr = raw.split("\n").map((s) => s.trim()).filter(Boolean);
        if (arr.length) obj[f.key] = arr;
      } else {
        obj[f.key] = raw;
      }
    }
    if (Object.keys(obj).length) out[section.key] = obj;
  }
  return out as BrandProfileInput;
}

export function BrandManager({ teamSlug, profile }: { teamSlug: string; profile: BrandProfileInput | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const initial = useMemo(() => toValues(profile), [profile]);
  const [values, setValues] = useState<Values>(initial);

  function set(key: string, val: string) {
    setSaved(false);
    setValues((v) => ({ ...v, [key]: val }));
  }

  function submit() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveBrand(teamSlug, toProfile(values));
      if (!res.ok) return setError(res.error ?? "something went wrong");
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-4">
      {SECTIONS.map((section) => (
        <div key={section.key} className="prism-card flex flex-col gap-3 p-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <Sparkles className="size-4 text-violet" /> {section.title}
            </p>
            <p className="text-xs text-ink-tertiary">{section.blurb}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {section.fields.map((f) => {
              const id = `${section.key}.${f.key}`;
              return (
                <label key={id} className="flex flex-col gap-1 text-xs text-ink-tertiary">
                  {f.label}
                  {f.type === "enum" ? (
                    <select className="prism-input" value={values[id] ?? ""} onChange={(e) => set(id, e.target.value)}>
                      <option value="">—</option>
                      {f.options!.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <textarea
                      className="prism-input min-h-[38px] resize-y"
                      rows={f.type === "list" ? 3 : 2}
                      placeholder={f.placeholder}
                      value={values[id] ?? ""}
                      onChange={(e) => set(id, e.target.value)}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn-prism justify-center">
          <Save className="size-4" /> {pending ? "Saving…" : "Save brand profile"}
        </button>
        {saved ? <p className="text-sm text-emerald-700">Saved.</p> : null}
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </div>
    </form>
  );
}
