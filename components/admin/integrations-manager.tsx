"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plug, Plus, Trash2, KeyRound, RefreshCw, Network, Sparkles, ListChecks } from "lucide-react";
import {
  saveIntegration,
  toggleIntegration,
  rotateSecret,
  removeIntegration,
  syncSlackNow,
  syncPlaneNow,
  syncLinearNow,
  syncGithubNow,
  projectToGraphNow,
  setPrimaryPmProvider,
  saveProviderModel,
  setAnsweringProvider,
  setAnsweringModel,
  setReasoningModel,
  setExtractionModel,
  setExtractionSmallModel,
  setEmbeddingModel,
  setMeetingTaskStatus,
  type PrimaryPmProvider,
} from "@/app/t/[team]/admin/integrations/actions";
import type { AnsweringProvider, ExtractionProvider } from "@/lib/query/llm-backend";
import { EMBEDDING_MODELS, EMBEDDING_PROVIDER_TYPES, type EmbeddingProvider } from "@/lib/api/schemas";
import {
  MEETING_TASK_STATUSES,
  MEETING_CATEGORY_LABEL,
  type MeetingTaskStatus,
} from "@/lib/meetings/target-status";

/** Answering + reasoning model state computed server-side (page.tsx) from the team's config + env. */
export interface AnsweringState {
  /** The explicit answering override (teams.answering_provider), or null for auto precedence. */
  provider: AnsweringProvider | null;
  /** Saved answer-model slug per editable provider key (null → provider default). */
  models: Record<"anthropic" | "openai" | "openrouter", string | null>;
  /** The backend actually resolved (provider + model) — what's answering right now. */
  effective: { provider: AnsweringProvider; model: string };
  /** True when the answering override wasn't configured and the resolver fell back to auto. */
  usedFallback: boolean;
  /** Whether each provider is configured (drives selectability + hints). */
  localConfigured: boolean;
  anthropicConfigured: boolean;
  openrouterConfigured: boolean;
  openaiConfigured: boolean;
  /** The distinct reasoning role (teams.reasoning_provider + reasoning_model). */
  reasoning: {
    /** Chosen reasoning provider, or null = "same as answering". */
    provider: AnsweringProvider | null;
    /** Chosen reasoning model (teams.reasoning_model), or null = reuse the answering model. */
    model: string | null;
    /** The backend reasoning resolves to, or null when no distinct reasoning model is set. */
    effective: { provider: AnsweringProvider; model: string } | null;
    /** True when the requested reasoning provider wasn't configured and it fell back. */
    usedFallback: boolean;
  };
  /**
   * The distinct EXTRACTION role (teams.extraction_provider + extraction_model) — the model that does
   * the high-volume machine work (today the knowledge graph), where nearly all the LLM spend is.
   */
  extraction: {
    /** Chosen extraction provider, or null = "same as answering". Never `anthropic` (see ExtractionProvider). */
    provider: ExtractionProvider | null;
    /** Chosen extraction model (teams.extraction_model), or null = reuse the answering model. */
    model: string | null;
    /** The backend extraction resolves to, or null when no distinct extraction model is set. */
    effective: { provider: AnsweringProvider; model: string } | null;
    /** True when the requested extraction provider wasn't configured and it fell back WHOLE to answering. */
    usedFallback: boolean;
    /** Cheaper model for the calls Graphiti marks `ModelSize.small` (teams.extraction_small_model). */
    smallModel: string | null;
    /** Is that cheap model configured for those calls? Runtime evidence is `smallRouting`. */
    smallEnabled: boolean;
    /** Set, but NOT in effect — the extraction role is off or it fell back. A reverted cost control. */
    smallInert: boolean;
    /** AIO-983: what the LEDGER says the small model actually served. null = not enabled.
     *  Discriminated so "nothing to judge" can never render as "it isn't working". */
    smallRouting:
      | { state: "not_configured" }
      | { state: "unavailable" }
      | { state: "no_traffic" }
      | { state: "inconclusive"; eligible: number }
      | { state: "not_routing"; eligible: number }
      | { state: "routing"; servedSmall: number; eligible: number }
      | null;
  };
}

const PROVIDER_LABEL: Record<AnsweringProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  local: "Local (LLM_BASE_URL)",
};

/** Embeddings state computed server-side (page.tsx) from teams.embedding_provider + provider keys + env. */
export interface EmbeddingState {
  provider: EmbeddingProvider | null; // teams.embedding_provider (null = auto: env / off)
  model: string | null; // teams.embedding_model
  effective: { provider: EmbeddingProvider | "env"; model: string } | null; // resolved backend, or null = off
  usedFallback: boolean;
  openaiConfigured: boolean;
  openrouterConfigured: boolean;
}

const EMBEDDING_PROVIDER_LABEL: Record<EmbeddingProvider, string> = { openai: "OpenAI", openrouter: "OpenRouter" };

/** The embeddings-model control: provider dropdown + a CURATED model dropdown (not free text, so a
 *  dim-incompatible model can't be typed) + Save. Only OpenAI/OpenRouter because the vector index is
 *  fixed at 1536 dims — the inline note explains that so users know why the list is short. */
function EmbeddingPicker(props: {
  provider: EmbeddingProvider | null;
  model: string;
  configured: Record<EmbeddingProvider, boolean>;
  onProvider: (p: EmbeddingProvider | null) => void;
  onModel: (m: string) => void;
  onSave: () => void;
  pending: boolean;
  effective: string;
  fallback: boolean;
}) {
  const models = props.provider ? EMBEDDING_MODELS[props.provider] : [];
  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        <Sparkles className="size-4 text-violet" /> Embeddings model (semantic search)
      </p>
      <p className="text-xs text-ink-secondary">
        The model that powers <strong>semantic (vector) search</strong>. <strong>Only OpenAI and OpenRouter
        are listed</strong> because the semantic index is built at <strong>1536 dimensions</strong>: both
        serve OpenAI&apos;s <code>text-embedding-3-small</code> (1536d), which is the only model that fits
        the existing index. Other providers (Anthropic has no embeddings; Google&apos;s are 768d) or a
        different-dimension model would require re-indexing every document. Switching OpenAI ↔ OpenRouter on
        the same model is safe (identical vectors) and doesn&apos;t re-embed anything. &ldquo;Auto&rdquo;
        uses the server&apos;s <code>EMBEDDINGS_URL</code> (self-host) or turns semantic search off.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={props.provider ?? ""}
          disabled={props.pending}
          onChange={(e) => props.onProvider(e.target.value ? (e.target.value as EmbeddingProvider) : null)}
          className="rounded-md border border-ink/15 bg-transparent px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink/30 disabled:opacity-50"
        >
          <option value="">Auto (env / off)</option>
          {EMBEDDING_PROVIDER_TYPES.map((p) => (
            <option key={p} value={p}>
              {EMBEDDING_PROVIDER_LABEL[p]}
              {props.configured[p] ? "" : " · no key"}
            </option>
          ))}
        </select>
        <select
          value={props.model}
          disabled={props.pending || !props.provider}
          onChange={(e) => props.onModel(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-ink/15 bg-transparent px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-ink/30 disabled:opacity-50"
        >
          {props.provider ? (
            models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.label}
              </option>
            ))
          ) : (
            <option value="">—</option>
          )}
        </select>
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.pending}
          className="btn-prism shrink-0 text-xs disabled:opacity-50"
        >
          Save
        </button>
      </div>
      <p className="text-xs text-ink-secondary">
        Effective: <span className="font-medium text-violet">{props.effective}</span>
        {props.fallback ? (
          <span className="ml-1 text-amber-700">· requested provider has no key, fell back</span>
        ) : null}
      </p>
    </div>
  );
}

const ROLE_PROVIDERS: AnsweringProvider[] = ["anthropic", "openai", "openrouter", "local"];
/** Extraction's narrower list — Anthropic can't serve the OpenAI structured-output call extraction is.
 *  Typed as the narrow role type so the picker's callback needs no cast to stay honest. */
const EXTRACTION_PROVIDERS: ExtractionProvider[] = ["openai", "openrouter", "local"];
/** Narrow a picker choice to the extraction set. A real check rather than a cast: the select only
 *  offers these three, so anything else (a stale render, a later edit to the option list) becomes
 *  "same as answering" instead of a value the role's type says is impossible. */
const asExtractionProvider = (p: AnsweringProvider | null): ExtractionProvider | null =>
  p !== null && (EXTRACTION_PROVIDERS as AnsweringProvider[]).includes(p) ? (p as ExtractionProvider) : null;

/** One role's control: a provider dropdown + model input + Save, with the effective backend shown.
 *  Used for both the Answering and Reasoning roles so they read identically. `local`'s model is
 *  env-driven (LLM_MODEL), so its model box is disabled. */
function RolePicker(props: {
  title: string;
  help: string;
  autoLabel: string; // label for the null option ("Auto" / "Same as answering")
  provider: AnsweringProvider | null;
  model: string;
  configured: Record<AnsweringProvider, boolean>;
  onProvider: (p: AnsweringProvider | null) => void;
  onModel: (m: string) => void;
  onSave: () => void;
  pending: boolean;
  effective: string;
  fallback: boolean;
  /** Selectable providers. Defaults to all four; the extraction role narrows it (Anthropic can't serve
   *  OpenAI structured outputs, so offering it would only produce a refusal on every call). */
  providers?: AnsweringProvider[];
  /** Amber note under the picker — used to explain a narrowed option list. */
  note?: string;
}) {
  const modelEditable = props.provider !== null && props.provider !== "local";
  const providers = props.providers ?? ROLE_PROVIDERS;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3 first:border-t-0 first:pt-0">
      <p className="text-xs font-medium text-ink">{props.title}</p>
      <p className="text-xs text-ink-secondary">{props.help}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={props.provider ?? ""}
          disabled={props.pending}
          onChange={(e) => props.onProvider(e.target.value ? (e.target.value as AnsweringProvider) : null)}
          className="rounded-md border border-ink/15 bg-transparent px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink/30 disabled:opacity-50"
        >
          <option value="">{props.autoLabel}</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
              {props.configured[p] ? "" : " · not set"}
            </option>
          ))}
        </select>
        <input
          value={modelEditable ? props.model : ""}
          onChange={(e) => props.onModel(e.target.value)}
          placeholder={
            modelEditable
              ? "model id, e.g. qwen/qwen3.6-plus"
              : props.provider === "local"
                ? "set via LLM_MODEL env"
                : "—"
          }
          disabled={props.pending || !modelEditable}
          className="min-w-0 flex-1 rounded-md border border-ink/15 bg-transparent px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-ink/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.pending}
          className="btn-prism shrink-0 text-xs disabled:opacity-50"
        >
          Save
        </button>
      </div>
      <p className="text-xs text-ink-secondary">
        Effective: <span className="font-medium text-violet">{props.effective}</span>
        {props.fallback ? (
          <span className="ml-1 text-amber-700">· requested backend not configured, fell back</span>
        ) : null}
      </p>
      {props.note ? <p className="text-xs text-amber-700">{props.note}</p> : null}
    </div>
  );
}

type IntegrationType =
  | "github"
  | "slack"
  | "linear"
  | "plane"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "google"
  | "notion"
  | "clickup";

export interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  status: "enabled" | "disabled";
  hasSecret: boolean;
}

// Data-source connectors shown in the generic "Add an integration" form. Provider keys get their
// own panel (PROVIDER_TYPES); GitHub gets its own repo panel (GithubReposPanel) — so both are
// excluded here to avoid two places to manage the same thing.
const TYPES: IntegrationType[] = ["slack", "notion", "linear", "plane", "clickup"];

// LLM provider API keys — one set for the team, managed in the dedicated "AI provider keys" panel.
const PROVIDER_TYPES = ["anthropic", "openai", "google"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];
const PROVIDER_META: Record<ProviderType, { label: string; note: string; placeholder: string }> = {
  anthropic: { label: "Anthropic", note: "Powers the AI query box (Claude).", placeholder: "sk-ant-…" },
  openai: { label: "OpenAI", note: "Embeddings & local/OpenAI-compatible LLMs.", placeholder: "sk-…" },
  google: { label: "Google", note: "Stored for Gemini — not wired into queries yet.", placeholder: "AIza…" },
};

// What the single "selection" field means per type (hint text + how config renders back).
// Keyed to the data-source TYPES only; provider keys use the dedicated panel, not this form.
const SELECTION_HINT: Partial<Record<IntegrationType, string>> = {
  slack: "channel IDs (comma-separated)",
  github: "repos owner/name (comma-separated)",
  // The Notion connector (ingestion/aios_ingest/sources/notion.py) needs a token (stored as the secret)
  // plus EITHER page ids or a database id. Pages are the common case, so that's what this field holds;
  // a `databaseId=<id>` entry is accepted for the whole-database case.
  notion: "page IDs (comma-separated), or databaseId=<id>",
  linear: "teamId=..., projectId=..., doneStateName=Done",
  plane: "workspaceSlug=..., projectId=..., doneStateName=DONE, externalSource=aios-backlog",
  // `,` separates entries, so a multi-value entry uses `|` (see lib/integrations/build-config).
  clickup: "workspaceId=..., listIds=101|202, docIds=doc-a|doc-b",
};

function summarizeConfig(type: IntegrationType, config: Record<string, unknown>): string {
  const arr = (k: string) => (Array.isArray(config[k]) ? (config[k] as string[]) : []);
  if (type === "slack") return `${arr("channelIds").length} channel(s)`;
  if (type === "github") return `${arr("repos").length} repo(s)`;
  if (type === "notion") {
    if (config.databaseId) return `database ${config.databaseId}`;
    return `${arr("pageIds").length} page(s)`;
  }
  if (type === "linear") {
    return [
      config.teamId ? `team ${config.teamId}` : null,
      config.projectId ? `project ${config.projectId}` : null,
      config.doneStateName ? `done ${config.doneStateName}` : null,
      config.inboundApply === true ? "inbound ✓" : null,
    ].filter(Boolean).join(" · ") || "—";
  }
  if (type === "clickup") {
    return [
      config.workspaceId ? `workspace ${config.workspaceId}` : null,
      `${arr("listIds").length} list(s)`,
      arr("docIds").length ? `${arr("docIds").length} doc(s)` : null,
    ].filter(Boolean).join(" · ") || "—";
  }
  if (type === "plane") {
    return [
      config.workspaceSlug ? `workspace ${config.workspaceSlug}` : null,
      config.projectId ? `project ${config.projectId}` : null,
      config.doneStateName ? `done ${config.doneStateName}` : null,
      config.externalSource ? `source ${config.externalSource}` : null,
    ].filter(Boolean).join(" · ") || "—";
  }
  return Object.values(config)[0] ? String(Object.values(config)[0]) : "—";
}

export function IntegrationsManager({
  teamSlug,
  integrations,
  primaryPmProvider,
  meetingTaskStatus,
  answering,
  embedding,
}: {
  teamSlug: string;
  integrations: IntegrationRow[];
  primaryPmProvider: PrimaryPmProvider;
  meetingTaskStatus: MeetingTaskStatus;
  answering: AnsweringState;
  embedding: EmbeddingState;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** A save that SUCCEEDED but has a consequence worth naming — rendered amber, never emerald. */
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const SYNCABLE: Partial<Record<IntegrationType, (slug: string) => Promise<{ ok: boolean; error?: string; message?: string }>>> = {
    slack: syncSlackNow,
    plane: syncPlaneNow,
    linear: syncLinearNow,
    github: syncGithubNow,
  };
  const SYNC_TITLES: Partial<Record<IntegrationType, string>> = {
    slack: "Pull this team's Slack channels into the brain now",
    plane: "Import this Plane project's work-items into the brain now",
    linear: "Import this Linear team's issues into the brain now",
    github: "Import this GitHub repo's issues into the brain now",
  };

  function syncNow(type: IntegrationType) {
    const fn = SYNCABLE[type];
    if (!fn) return;
    setError(null);
    setNotice(null);
    setWarning(null);
    startTransition(async () => {
      const res = await fn(teamSlug);
      if (!res.ok) setError(res.error ?? "sync failed");
      else {
        setNotice(res.message ?? "Synced.");
        router.refresh();
      }
    });
  }
  const [form, setForm] = useState<{
    type: IntegrationType;
    name: string;
    selection: string;
    secret: string;
    inboundApply: boolean;
  }>({
    type: "slack",
    name: "",
    selection: "",
    secret: "",
    inboundApply: false,
  });

  function projectToGraph() {
    setError(null);
    setNotice(null);
    setWarning(null);
    startTransition(async () => {
      const res = await projectToGraphNow(teamSlug);
      if (!res.ok) setError(res.error ?? "projection failed");
      else {
        setNotice(res.message ?? "Projected to graph.");
        router.refresh();
      }
    });
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>) {
    setError(null);
    setNotice(null);
    setWarning(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "something went wrong");
      else {
        // A SUCCESSFUL save can still carry a warning — currently "this model can't do structured
        // outputs, so graph extraction will stop producing facts". Shown here, at the moment of the
        // choice: the alternative is discovering it as blank narrative arcs hours later. Kept OUT of
        // `notice`, which renders emerald — a caution styled as success reads as "all good" and would
        // defeat the point of surfacing it at all.
        setWarning(res.warning ?? null);
        router.refresh();
      }
    });
  }

  // Provider keys and GitHub each render in their own dedicated panel; keep them out of this list.
  const sources = integrations.filter(
    (i) =>
      i.type !== "github" &&
      i.type !== "openrouter" && // OpenRouter has its own dedicated panel (key + model)
      !(PROVIDER_TYPES as readonly string[]).includes(i.type)
  );

  // Answer-model drafts for the editable provider keys (anthropic/openai), seeded from saved config.
  const [modelDraft, setModelDraft] = useState<Record<"anthropic" | "openai", string>>({
    anthropic: answering.models.anthropic ?? "",
    openai: answering.models.openai ?? "",
  });

  function saveModel(p: "anthropic" | "openai") {
    run(() => saveProviderModel(teamSlug, p, modelDraft[p].trim()));
  }

  // Provider configured-state shared by both role pickers.
  const providerConfigured: Record<AnsweringProvider, boolean> = {
    anthropic: answering.anthropicConfigured,
    openai: answering.openaiConfigured,
    openrouter: answering.openrouterConfigured,
    local: answering.localConfigured,
  };

  // Answering role (provider + model). Switching provider seeds the model box from that provider's
  // saved model (each provider has its own); "Auto" (null) clears the override — no model to set.
  const [ansProvider, setAnsProvider] = useState<AnsweringProvider | null>(answering.provider);
  const [ansModel, setAnsModel] = useState(
    answering.provider && answering.provider !== "local" ? (answering.models[answering.provider] ?? "") : ""
  );
  function chooseAnsProvider(p: AnsweringProvider | null) {
    setAnsProvider(p);
    setAnsModel(p && p !== "local" ? (answering.models[p] ?? "") : "");
  }
  function saveAnswering() {
    if (!ansProvider) run(() => setAnsweringProvider(teamSlug, null)); // Auto → clear override
    else run(() => setAnsweringModel(teamSlug, ansProvider, ansModel.trim()));
  }

  // Reasoning role (own provider + model). Provider null = "same as answering"; the model is a single
  // team value (teams.reasoning_model), so switching provider doesn't reseed it. Blank model clears both.
  const [resProvider, setResProvider] = useState<AnsweringProvider | null>(answering.reasoning.provider);
  const [resModel, setResModel] = useState(answering.reasoning.model ?? "");
  function saveReasoning() {
    run(() => setReasoningModel(teamSlug, resProvider, resModel.trim()));
  }

  // Extraction role (own provider + model). Same shape as reasoning: provider null = "same as
  // answering", blank model clears both. Anthropic is absent from this picker's options — Graphiti
  // extracts with OpenAI structured outputs, so an Anthropic extraction backend would refuse every call.
  const [extProvider, setExtProvider] = useState<ExtractionProvider | null>(answering.extraction.provider);
  const [extModel, setExtModel] = useState(answering.extraction.model ?? "");
  function saveExtraction() {
    run(() => setExtractionModel(teamSlug, extProvider, extModel.trim()));
  }

  // The cheap model for the two calls Graphiti itself marks simple. No provider pair — it rides the
  // extraction backend's provider and key, because a second provider would reintroduce the half-swap
  // the extraction role's WHOLE fallback exists to prevent.
  const [extSmallModel, setExtSmallModel] = useState(answering.extraction.smallModel ?? "");
  function saveExtractionSmall() {
    run(() => setExtractionSmallModel(teamSlug, extSmallModel.trim()));
  }

  // Embeddings role (provider + curated 1536-dim model). "Auto" (null) clears both → env/off. Switching
  // provider seeds the model to that provider's single curated model. Blank provider sends "" model.
  const embConfigured: Record<EmbeddingProvider, boolean> = {
    openai: embedding.openaiConfigured,
    openrouter: embedding.openrouterConfigured,
  };
  const [embProvider, setEmbProvider] = useState<EmbeddingProvider | null>(embedding.provider);
  const [embModel, setEmbModel] = useState(
    embedding.provider ? (embedding.model ?? EMBEDDING_MODELS[embedding.provider][0].model) : ""
  );
  function chooseEmbProvider(p: EmbeddingProvider | null) {
    setEmbProvider(p);
    setEmbModel(p ? EMBEDDING_MODELS[p][0].model : "");
  }
  function saveEmbedding() {
    run(() => setEmbeddingModel(teamSlug, embProvider, embProvider ? embModel : ""));
  }
  const embEffective = embedding.effective
    ? `${embedding.effective.provider === "env" ? "Env (EMBEDDINGS_URL)" : EMBEDDING_PROVIDER_LABEL[embedding.effective.provider]} · ${embedding.effective.model}`
    : "off — semantic search disabled";

  function setProviderKey(p: ProviderType, existing: IntegrationRow | undefined) {
    const key = window.prompt(`${PROVIDER_META[p].label} API key (${PROVIDER_META[p].placeholder}):`);
    if (!key) return;
    run(() =>
      existing
        ? rotateSecret(teamSlug, existing.id, key)
        : saveIntegration(teamSlug, { type: p, name: p, selection: "", secret: key })
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="prism-card flex flex-col gap-4 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Sparkles className="size-4 text-violet" /> Answering, reasoning &amp; extraction models
        </p>
        <p className="text-xs text-ink-secondary">
          Pick the <strong>provider and model</strong> for each role. The <strong>answering</strong> model
          runs the Query box + in-app extraction (summaries, action items, drafts) with reasoning off. The
          optional <strong>reasoning</strong> model runs reasoning-heavy work (narrative arc synthesis).
          The optional <strong>extraction</strong> model runs the knowledge graph — high volume, and
          nearly all of the bill. Each can use a different provider. If a chosen backend isn&apos;t
          configured, the role falls back to answering (shown below the picker).
        </p>

        <RolePicker
          title="Answering model"
          help="Provider that answers + does extraction. “Auto” picks the highest configured (OpenRouter → Local → Anthropic)."
          autoLabel="Auto"
          provider={ansProvider}
          model={ansModel}
          configured={providerConfigured}
          onProvider={chooseAnsProvider}
          onModel={setAnsModel}
          onSave={saveAnswering}
          pending={pending}
          effective={`${PROVIDER_LABEL[answering.effective.provider]} · ${answering.effective.model}`}
          fallback={answering.usedFallback}
        />

        <RolePicker
          title="Reasoning model (optional)"
          help="A distinct model for reasoning-heavy tasks (narrative arc synthesis). Leave the model blank to reuse the answering model. “Same as answering” keeps the answering provider."
          autoLabel="Same as answering"
          provider={resProvider}
          model={resModel}
          configured={providerConfigured}
          onProvider={setResProvider}
          onModel={setResModel}
          onSave={saveReasoning}
          pending={pending}
          effective={
            answering.reasoning.effective
              ? `${PROVIDER_LABEL[answering.reasoning.effective.provider]} · ${answering.reasoning.effective.model}`
              : "reuses the answering model"
          }
          fallback={answering.reasoning.usedFallback}
        />

        <RolePicker
          title="Extraction model (optional) — where the spend is"
          help="The model that does the high-volume machine work: building the knowledge graph from every ingested document. This is ~99% of the LLM bill, and it is mechanical — a cheap model that supports structured outputs is the right pick here, while answering keeps a strong one. Prefer OpenRouter: it reports the real per-call cost, so the saving shows up on the Costs page (an OpenAI-cloud or local pick is recorded as $0-estimated and the change becomes unmeasurable). Leave the model blank to reuse the answering model. “Same as answering” keeps the answering provider."
          autoLabel="Same as answering"
          provider={extProvider}
          model={extModel}
          configured={providerConfigured}
          providers={EXTRACTION_PROVIDERS}
          note="Anthropic isn’t offered: graph extraction is an OpenAI structured-output call, which Anthropic’s API doesn’t speak."
          onProvider={(p) => setExtProvider(asExtractionProvider(p))}
          onModel={setExtModel}
          onSave={saveExtraction}
          pending={pending}
          effective={
            answering.extraction.effective
              ? `${PROVIDER_LABEL[answering.extraction.effective.provider]} · ${answering.extraction.effective.model}`
              : "reuses the answering model"
          }
          fallback={answering.extraction.usedFallback}
        />

        {/* The cheap model for the calls Graphiti itself marks simple. Deliberately not a RolePicker:
            there is no provider to choose — it rides the extraction backend's provider and key.
            Markup mirrors RolePicker's tokens EXACTLY. The first version invented `text-muted`,
            `bg-surface` and `border-line`, none of which is a token in `app/globals.css` (which
            defines `--color-ink-secondary`, `--color-border-subtle`, …). Tailwind emits no rule for
            an undefined token, so the help paragraph, both status lines and the card border rendered
            INVISIBLE — title, blank gap, input, as a screenshot of the live page showed.
            (The inert-state warning used `text-amber`, which IS a real token, so that one line would
            have rendered. An earlier version of this comment claimed otherwise.) */}
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
          <p className="text-xs font-medium text-ink">Cheap model for simple graph calls (optional)</p>
          <p className="text-xs text-ink-secondary">
            Graphiti asks for a cheaper model on some of its calls — filling in entity attributes or
            summaries, picking between duplicate facts, and dating them. Each only refines work the
            extraction model already did, so a weak model here can’t reduce what the graph knows about.
            Runs on the extraction model’s provider and key; blank = the extraction model serves every
            call. Requires an extraction model above.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={extSmallModel}
              onChange={(e) => setExtSmallModel(e.target.value)}
              placeholder="model id, e.g. mistralai/mistral-small-3.2-24b-instruct"
              disabled={pending}
              className="min-w-0 flex-1 rounded-md border border-ink/15 bg-transparent px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-ink/30 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={saveExtractionSmall}
              disabled={pending}
              className="btn-prism shrink-0 text-xs disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {answering.extraction.smallEnabled ? (
            <>
              <p className="text-xs text-ink-secondary">
                Effective: <span className="font-medium text-violet">{answering.extraction.smallModel}</span>
                <span className="ml-1">· configured for the simple graph calls</span>
              </p>
              {/* "Configured and resolvable" is not "working" — this line is the difference, and it
                  is the whole point of AIO-983. It reports the ABSENCE of routing as loudly as the
                  presence, and stays silent when there is nothing to judge rather than guessing. */}
              {answering.extraction.smallRouting?.state === "not_routing" ? (
                <p className="text-xs text-amber-700">
                  Enabled, but <span className="font-medium">none</span> of the{" "}
                  {answering.extraction.smallRouting.eligible} simple graph calls since it was set were
                  actually served by it —
                  every one went to the extraction model. The graph service and this brain disagree about
                  which calls are cheap. If the graph service reaches this brain&apos;s LLM proxy, rebuild its
                  image so the canonical proxy route sends the <code className="font-mono">aios-small</code>{" "}
                  sentinel.
                </p>
              ) : answering.extraction.smallRouting?.state === "routing" ? (
                /* Neutral, not "confirmed" (review Low 3): 1-of-50 is partial drift — a mixed fleet
                   where one image migrated and one did not — and a confirmation framing would read
                   past it. The ratio is shown so an operator can see which it is. */
                <p className="text-xs text-ink-secondary">
                  Serving {answering.extraction.smallRouting.servedSmall} of the last{" "}
                  {answering.extraction.smallRouting.eligible} simple graph calls.
                </p>
              ) : answering.extraction.smallRouting?.state === "unavailable" ? (
                <p className="text-xs text-ink-secondary">
                  Could not verify routing from the audited usage data, so no routing claim is being made.
                </p>
              ) : answering.extraction.smallRouting?.state === "inconclusive" ? (
                <p className="text-xs text-ink-secondary">
                  Only {answering.extraction.smallRouting.eligible} recent simple graph calls — not enough to
                  confirm it is serving them yet.
                </p>
              ) : answering.extraction.smallRouting?.state === "no_traffic" ? (
                <p className="text-xs text-ink-secondary">
                  No eligible metered graph calls have run since this was set, so there is nothing to check yet.
                </p>
              ) : null}
              {/* These calls cannot change WHICH entities or facts are extracted — that is what makes
                  downgrading them a different risk class — but they do decide duplicate-fact and
                  summary quality. Say so where the choice is made, not in a ticket. */}
              <p className="text-xs text-ink-secondary">
                These are the simple calls only (de-duplication, summaries). They never affect which
                entities or facts are extracted, but they do affect duplicate-fact and summary quality.
              </p>
            </>
          ) : answering.extraction.smallInert ? (
            <p className="text-xs text-amber-700">
              Saved but NOT in effect — every call is still served by the extraction model. Set an
              extraction model above, and make sure its provider is configured (a fallback switches this
              off deliberately).
            </p>
          ) : (
            <p className="text-xs text-ink-secondary">Not set — the extraction model serves every graph call.</p>
          )}
        </div>
      </div>

      <EmbeddingPicker
        provider={embProvider}
        model={embModel}
        configured={embConfigured}
        onProvider={chooseEmbProvider}
        onModel={setEmbModel}
        onSave={saveEmbedding}
        pending={pending}
        effective={embEffective}
        fallback={embedding.usedFallback}
      />

      <div className="prism-card flex flex-col gap-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <KeyRound className="size-4 text-violet" /> AI provider keys
        </p>
        <p className="text-xs text-ink-secondary">
          One set of LLM provider keys for the team. Stored encrypted (AES-256-GCM); never shown
          again after saving. Unset providers fall back to the server&apos;s environment key.
        </p>
        <div className="flex flex-col gap-2">
          {PROVIDER_TYPES.map((p) => {
            const row = integrations.find((i) => i.type === p);
            const isSet = !!row?.hasSecret;
            const hasModel = p === "anthropic" || p === "openai";
            const savedModel = hasModel ? (answering.models[p] ?? "") : "";
            const modelDirty = hasModel && modelDraft[p].trim() !== savedModel.trim();
            return (
              <div
                key={p}
                className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-ink">{PROVIDER_META[p].label}</span>
                  <span className="text-xs text-ink-tertiary">{PROVIDER_META[p].note}</span>
                  <span className={`text-xs ${isSet ? "text-emerald-700" : "text-ink-tertiary"}`}>
                    {isSet ? "key set ✓" : "not set"}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setProviderKey(p, row)}
                      className="rounded-lg border border-violet/40 bg-violet/10 px-3 py-1 text-xs font-medium text-violet disabled:opacity-50"
                    >
                      {isSet ? "Replace key" : "Set key"}
                    </button>
                    {row ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`Remove ${PROVIDER_META[p].label} key?`)) {
                            run(() => removeIntegration(teamSlug, row.id));
                          }
                        }}
                        className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-red"
                        aria-label={`Remove ${PROVIDER_META[p].label} key`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
                {hasModel ? (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-ink-tertiary" htmlFor={`model-${p}`}>
                      model
                    </label>
                    <input
                      id={`model-${p}`}
                      className="prism-input flex-1 font-mono text-xs"
                      placeholder={p === "anthropic" ? "claude-opus-4-8 (default)" : "gpt-4o (default)"}
                      value={modelDraft[p]}
                      onChange={(e) => setModelDraft({ ...modelDraft, [p]: e.target.value })}
                      aria-label={`${PROVIDER_META[p].label} answer model`}
                    />
                    <button
                      type="button"
                      disabled={pending || !modelDirty}
                      onClick={() => saveModel(p)}
                      className="rounded-lg border border-border-default px-3 py-1 text-xs font-medium text-ink-secondary disabled:opacity-40 hover:text-ink"
                    >
                      Save model
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="prism-card flex flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plug className="size-4 text-violet" /> Primary PM tool
        </p>
        <p className="text-xs text-ink-secondary">
          The single project-management tool the brain projects tasks into (epics, sub-issues,
          status). The brain stays the source of truth; the chosen board is a downstream projection.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: null, label: "None" },
              { value: "plane", label: "Plane" },
              { value: "linear", label: "Linear" },
            ] as { value: PrimaryPmProvider; label: string }[]
          ).map((opt) => {
            const active = primaryPmProvider === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                disabled={pending || active}
                onClick={() => run(() => setPrimaryPmProvider(teamSlug, opt.value))}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  active
                    ? "border-violet bg-violet/10 text-ink"
                    : "border-ink/15 text-ink-secondary hover:border-ink/30"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="prism-card flex flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <ListChecks className="size-4 text-violet" /> Meeting action items → category
        </p>
        <p className="text-xs text-ink-secondary">
          Which category extracted meeting action items land in when pushed to your PM tool. The
          meeting page shows this default and lets the pusher change it per meeting.
        </p>
        <div className="flex flex-col gap-1.5">
          {MEETING_TASK_STATUSES.map((s) => {
            const active = meetingTaskStatus === s;
            return (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="meeting-task-status"
                  checked={active}
                  disabled={pending || active}
                  onChange={() => run(() => setMeetingTaskStatus(teamSlug, s))}
                  className="accent-violet"
                />
                {MEETING_CATEGORY_LABEL[s]}
              </label>
            );
          })}
        </div>
      </div>

      <div className="prism-card flex flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Network className="size-4 text-violet" /> Graph memory (Graphiti)
        </p>
        <p className="text-xs text-ink-secondary">
          Project the brain&apos;s ingested content (Phase 1: Slack transcripts) into the Graphiti
          temporal knowledge graph for natural-language queries. Idempotent — re-running only pushes
          changed content. Also runs automatically on a schedule when the graph is configured.
        </p>
        <div>
          <button
            type="button"
            onClick={projectToGraph}
            disabled={pending}
            className="flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet disabled:opacity-50"
            title="Project this team's brain content into the Graphiti graph now"
          >
            <Network className={`size-3.5 ${pending ? "animate-pulse" : ""}`} /> Project to graph now
          </button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const res = await saveIntegration(teamSlug, form);
            if (res.ok)
              setForm({ type: form.type, name: "", selection: "", secret: "", inboundApply: false });
            return res;
          });
        }}
        className="prism-card flex flex-col gap-3 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plus className="size-4 text-violet" /> Add an integration
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as IntegrationType })}
            className="prism-input"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="prism-input"
            placeholder="name (e.g. eng-slack)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <input
          className="prism-input"
          placeholder={SELECTION_HINT[form.type]}
          value={form.selection}
          onChange={(e) => setForm({ ...form, selection: e.target.value })}
        />
        {form.type === "linear" ? (
          <label className="flex items-start gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.inboundApply}
              onChange={(e) => setForm({ ...form, inboundApply: e.target.checked })}
            />
            <span>
              Apply inbound Linear changes back to the brain (two-way sync). Off by default — the
              brain stays the source of truth; enabling lets a status change made directly in Linear
              flow back. Reversible; re-save with this unchecked to turn it off.
            </span>
          </label>
        ) : null}
        {form.type === "clickup" ? (
          <p className="text-xs text-amber-700">
            The token is a ClickUp personal API token (<code>pk_…</code>), from ClickUp → Settings →
            Apps. Saving it connects the workspace and stores it encrypted — but ClickUp does{" "}
            <strong>not import yet</strong>: the scheduled ingestion run is not built, so there is no
            &ldquo;Sync now&rdquo; button on this row and nothing will appear in the brain until it
            lands.
          </p>
        ) : null}
        <input
          className="prism-input"
          type="password"
          autoComplete="off"
          placeholder="secret token (e.g. xoxb-… for Slack) — stored encrypted, never shown again"
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
        />
        <button type="submit" disabled={pending} className="btn-prism justify-center">
          <Plug className="size-4" /> Save integration
        </button>
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </form>

      {notice ? (
        <p className="rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {warning ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No source integrations yet. Add one above.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((i) => (
            <div key={i.id} className="prism-card flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="rounded-full bg-violet/10 px-2 py-0.5 font-mono text-xs text-violet">{i.type}</span>
              <span className="font-medium text-ink">{i.name}</span>
              <span className="text-xs text-ink-tertiary">
                {summarizeConfig(i.type, i.config)}
                {i.hasSecret ? " · secret set" : " · no secret"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {SYNC_TITLES[i.type] ? (
                  <button
                    onClick={() => syncNow(i.type)}
                    disabled={pending}
                    className="flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1 text-xs font-medium text-violet disabled:opacity-50"
                    title={SYNC_TITLES[i.type]}
                  >
                    <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Sync now
                  </button>
                ) : null}
                <button
                  onClick={() => run(() => toggleIntegration(teamSlug, i.id, i.status === "enabled" ? "disabled" : "enabled"))}
                  disabled={pending}
                  className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                    i.status === "enabled"
                      ? "border-violet/40 bg-violet/10 text-violet"
                      : "border-border-default text-ink-tertiary"
                  }`}
                >
                  {i.status === "enabled" ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => {
                    const s = window.prompt(`New secret for ${i.name}:`);
                    if (s) run(() => rotateSecret(teamSlug, i.id, s));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-ink"
                  aria-label="Rotate secret"
                >
                  <KeyRound className="size-4" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete integration "${i.name}"?`)) run(() => removeIntegration(teamSlug, i.id));
                  }}
                  disabled={pending}
                  className="rounded-lg border border-border-default p-1.5 text-ink-secondary hover:text-red"
                  aria-label="Delete integration"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
