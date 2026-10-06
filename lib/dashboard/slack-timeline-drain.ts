import {
  SLACK_TIMELINE_PAGE_SIZE,
  SlackTimelineError,
  assertAssembledSlackDays,
  assertComposedSlackDays,
  assertSlackTimelineBinding,
  assertSlackTimelineBindingUnchanged,
  assertSlackTimelinePageProtocol,
  isSlackTimelineError,
  mergeSlackTimelineDays,
  type SlackAggregateTuple,
  type SlackTimelineBinding,
  type SlackTimelineCursorPayload,
  type SlackTimelinePage,
} from "./slack-timeline-page-contract";
import type { TimelineDay } from "./timeline-group";

/**
 * AIO-1170 AC-09 — the INACTIVE complete-drain adapter for aggregate Slack pagination.
 *
 * It turns authenticated Slack aggregate pages into the legacy `{ window_days: 7, days }` answer, and
 * it returns that answer only after verified terminal exhaustion and a fresh final validation. Every
 * other outcome is one fresh whole attempt (after `restart_required`, once) or an error. There is no
 * partial-return path: nothing accumulated ever leaves this function on failure.
 *
 * It takes page FACTORIES, never an externally cached first page, so an overtaken attempt can be
 * discarded and restarted. Nothing in the application imports this module yet.
 */

export const SLACK_TIMELINE_DRAIN_BUDGETS = Object.freeze({
  /** Page requests across BOTH attempts, first-page calls included. Final validation is not a page. */
  maxPageRequests: 1000,
  /** UTF-8 bytes of the JSON of the normalized accumulated days. */
  maxOutputBytes: 64 * 1024 * 1024,
  /** Monotonic time across both attempts and final validation. */
  maxElapsedMs: 120_000,
});

export type SlackTimelineDrainBudgets = { -readonly [K in keyof typeof SLACK_TIMELINE_DRAIN_BUDGETS]: number };

export interface SlackTimelineCallContext {
  /** Aborted when the shared deadline ends the call. A callback must stop its work when it fires. */
  signal: AbortSignal;
}

export interface SlackTimelineDrainDependencies {
  /** One authorized first page with a fresh clock. v1 drains seven days only. */
  startPage: (input: { windowDays: 7; pageSize: number }, context: SlackTimelineCallContext) => Promise<SlackTimelinePage>;
  nextPage: (cursor: string, context: SlackTimelineCallContext) => Promise<SlackTimelinePage>;
  /** The fresh read-only final check of bindings, expiry and the non-Slack backing-ID subset. */
  validateFinal: (
    input: { binding: SlackTimelineBinding; initialNonSlackSourceItemIds: string[] },
    context: SlackTimelineCallContext
  ) => Promise<void>;
  /** The cursor validator: authenticates a token and returns its payload, or throws. */
  decodeCursor: (token: string) => SlackTimelineCursorPayload;
  /** Fixed across every page and both attempts. Default 128. */
  pageSize?: number;
  budgets?: Partial<SlackTimelineDrainBudgets>;
  /** Milliseconds on a monotonic clock, independent of wall-clock expiry. */
  monotonicNow?: () => number;
  /** Arms the deadline of a pending call and returns its cancel function. Default: the platform timer. */
  scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}

export interface SlackTimelineDrainResult {
  window_days: 7;
  days: TimelineDay[];
}

const DRAIN_WINDOW_DAYS = 7;
const MAX_ATTEMPTS = 2;
/** The largest delay a platform timer honours (signed 32-bit milliseconds). One more fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unavailable(reason: string): never {
  throw new SlackTimelineError("unavailable", reason);
}

function platformTimer(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function resolveBudgets(overrides: unknown): SlackTimelineDrainBudgets {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    return unavailable("drain budgets are misconfigured");
  }
  const budgets: SlackTimelineDrainBudgets = { ...SLACK_TIMELINE_DRAIN_BUDGETS };
  for (const key of Object.keys(SLACK_TIMELINE_DRAIN_BUDGETS) as (keyof SlackTimelineDrainBudgets)[]) {
    const value = (overrides as Record<string, unknown> | undefined)?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return unavailable("drain budgets are misconfigured");
    budgets[key] = value;
  }
  // A longer elapsed budget is not a deadline any timer can hold: it is refused as configuration.
  if (budgets.maxElapsedMs > MAX_TIMER_MS) return unavailable("drain budgets are misconfigured");
  return budgets;
}

/** Whatever a dependency threw, as one of the four failures. Only a real contract error keeps its class. */
function classified(error: unknown): SlackTimelineError {
  return isSlackTimelineError(error) ? error : new SlackTimelineError("unavailable", "a page dependency failed");
}

interface AttemptState {
  pinned: SlackTimelineBinding;
  initialNonSlackSourceItemIds: string[];
  days: TimelineDay[];
}

/**
 * Drain every Slack aggregate page of one fixed seven-day snapshot and return the legacy DTO.
 *
 * Failure classes pass through unchanged, with two exceptions: a first `restart_required` discards
 * the whole attempt (days, cursor and the frozen non-Slack snapshot) and starts one fresh attempt,
 * and anything a dependency throws that is not a contract error is `unavailable`. All budgets are
 * shared by both attempts and never reset.
 */
export async function drainSlackTimeline(dependencies: SlackTimelineDrainDependencies): Promise<SlackTimelineDrainResult> {
  const deps = dependencies as unknown as Record<string, unknown> | null | undefined;
  if (typeof deps !== "object" || deps === null) return unavailable("drain dependencies are missing");
  const { startPage, nextPage, validateFinal, decodeCursor } = dependencies;
  if (typeof startPage !== "function" || typeof nextPage !== "function" || typeof validateFinal !== "function" ||
      typeof decodeCursor !== "function") return unavailable("drain dependencies are missing");
  const monotonicNow = dependencies.monotonicNow ?? ((): number => performance.now());
  const scheduleDeadline = dependencies.scheduleDeadline ?? platformTimer;
  if (typeof monotonicNow !== "function" || typeof scheduleDeadline !== "function") {
    return unavailable("drain dependencies are misconfigured");
  }
  const budgets = resolveBudgets(dependencies.budgets);
  const pageSize = dependencies.pageSize === undefined ? SLACK_TIMELINE_PAGE_SIZE.default : dependencies.pageSize;
  if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < SLACK_TIMELINE_PAGE_SIZE.min ||
      pageSize > SLACK_TIMELINE_PAGE_SIZE.max) {
    throw new SlackTimelineError("invalid_request", "unsupported page size");
  }

  /** One monotonic reading. A clock that throws or misreports is a failed dependency, never a raw error. */
  const readClock = (): number => {
    let now: unknown;
    try {
      now = monotonicNow();
    } catch {
      return unavailable("monotonic clock failed");
    }
    if (typeof now !== "number" || !Number.isFinite(now)) return unavailable("monotonic clock is misconfigured");
    return now;
  };
  const startedAt = readClock();
  let pageRequests = 0;

  const elapsed = (): number => readClock() - startedAt;
  const exhausted = (reason: string): SlackTimelineError =>
    new SlackTimelineError("budget_exhausted", reason, { pageRequests, maxPageRequests: budgets.maxPageRequests });

  /**
   * Run one opaque call under the remaining shared deadline. The call gets its own AbortSignal; when
   * the deadline fires first the signal is aborted and the drain rejects at once, without waiting
   * for the abandoned call. The deadline is always cancelled, and a late firing is inert.
   */
  async function guarded<T>(invoke: (context: SlackTimelineCallContext) => Promise<T> | T): Promise<T> {
    const remaining = budgets.maxElapsedMs - elapsed();
    if (remaining < 0) throw exhausted("drain exceeded its elapsed budget");
    const controller = new AbortController();
    let settled = false;
    let cancel: unknown;
    let schedulerFailed = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      try {
        cancel = scheduleDeadline(() => {
          if (settled) return;
          settled = true;
          controller.abort();
          reject(exhausted("drain exceeded its elapsed budget while a call was pending"));
        }, Math.max(1, Math.ceil(remaining)));
      } catch {
        schedulerFailed = true;
      }
    });
    deadline.catch(() => undefined);
    if (schedulerFailed || typeof cancel !== "function") {
      settled = true;
      if (typeof cancel === "function") (cancel as () => void)();
      return unavailable("deadline scheduler is misconfigured");
    }
    const release = cancel as () => void;
    try {
      const work = Promise.resolve().then(() => invoke({ signal: controller.signal }));
      // The abandoned call may still settle after the deadline; that outcome is deliberately ignored.
      work.catch(() => undefined);
      let result: T;
      try {
        result = await Promise.race([work, deadline]);
      } catch (error) {
        const failure = classified(error);
        // Out of time outranks an overtake: a restart cannot be afforded once the budget is spent.
        if (failure.code === "restart_required" && elapsed() > budgets.maxElapsedMs) {
          throw exhausted("drain exceeded its elapsed budget");
        }
        throw failure;
      }
      if (elapsed() > budgets.maxElapsedMs) throw exhausted("drain exceeded its elapsed budget");
      return result;
    } finally {
      settled = true;
      release();
    }
  }

  async function requestPage(invoke: (context: SlackTimelineCallContext) => Promise<SlackTimelinePage>): Promise<unknown> {
    if (pageRequests + 1 > budgets.maxPageRequests) throw exhausted("drain exceeded its page-request budget");
    pageRequests++;
    return guarded(invoke);
  }

  /**
   * Check one returned page against the protocol and the attempt's pinned snapshot, and return the
   * authenticated tuple of its next cursor (null for a terminal page). Malformed or contradictory
   * pages are `unavailable`; a well-formed page of another snapshot needs restart.
   */
  function accept(raw: unknown, requestTuple: SlackAggregateTuple | null, pinned: SlackTimelineBinding | null): {
    page: SlackTimelinePage;
    binding: SlackTimelineBinding;
    nextTuple: SlackAggregateTuple | null;
  } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unavailable("page is malformed");
    // A detached deep snapshot, taken in the step the page arrived and before anything is judged or
    // kept. The page service may retain the graph it returned and go on changing it while the next
    // page or final validation is awaited; everything validated, merged and published from here on
    // is this copy, which shares no object with it. The service's page is neither frozen nor kept.
    let page: SlackTimelinePage;
    try {
      page = structuredClone(raw) as SlackTimelinePage;
    } catch {
      return unavailable("page is malformed");
    }
    const binding = assertSlackTimelineBinding(page.binding);
    if (pinned === null && (page.window_days !== DRAIN_WINDOW_DAYS || binding.windowDays !== DRAIN_WINDOW_DAYS ||
        binding.pageSize !== pageSize)) {
      return unavailable("first page does not answer the request that was made");
    }

    let cursorPayload: SlackTimelineCursorPayload | null = null;
    if (page.nextSlackCursor !== null && page.nextSlackCursor !== undefined) {
      if (typeof page.nextSlackCursor !== "string" || page.nextSlackCursor.length === 0) return unavailable("page cursor is malformed");
      try {
        cursorPayload = decodeCursor(page.nextSlackCursor);
      } catch {
        // A page service that hands out a cursor its own validator refuses has broken the protocol.
        return unavailable("page cursor cannot be verified");
      }
      if (typeof cursorPayload !== "object" || cursorPayload === null) return unavailable("page cursor cannot be verified");
    }
    const nextTuple = cursorPayload?.lastAggregateTuple ?? null;
    assertSlackTimelinePageProtocol({ page, requestTuple, nextTuple });

    // Only a well-formed, self-consistent page reaches the snapshot comparison.
    if (pinned !== null) assertSlackTimelineBindingUnchanged(pinned, binding);
    if (cursorPayload !== null) assertSlackTimelineBindingUnchanged(binding, cursorPayload);
    // The validated tuple is kept across the next request as a copy: the payload is the decoder's.
    return { page, binding, nextTuple: nextTuple === null ? null : { ...nextTuple } };
  }

  function backingIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !LOWER_UUID.test(id)) ||
        new Set(value).size !== value.length) {
      return unavailable("first page does not declare its non-Slack backing items");
    }
    return [...(value as string[])];
  }

  function withinOutputBudget(days: TimelineDay[]): TimelineDay[] {
    if (Buffer.byteLength(JSON.stringify(days), "utf8") > budgets.maxOutputBytes) {
      throw exhausted("drain exceeded its output budget");
    }
    return days;
  }

  async function attempt(): Promise<SlackTimelineDrainResult> {
    const first = accept(
      await requestPage((context) => startPage({ windowDays: DRAIN_WINDOW_DAYS, pageSize }, context)), null, null
    );
    const state: AttemptState = {
      pinned: first.binding,
      initialNonSlackSourceItemIds: backingIds(first.page.initialNonSlackSourceItemIds),
      days: [],
    };
    // The assembled first page holds the frozen non-Slack snapshot and its own Slack groups. It is
    // ALWAYS normalized through the shared merger, so one-page and multi-page drains count alike.
    assertAssembledSlackDays({ aggregates: first.page.aggregates, days: first.page.days });
    state.days = withinOutputBudget(mergeSlackTimelineDays(first.page.days, []));

    let cursor = first.page.nextSlackCursor;
    let requestTuple = first.nextTuple;
    while (cursor !== null) {
      const token = cursor;
      const next = accept(await requestPage((context) => nextPage(token, context)), requestTuple, state.pinned);
      // A continuation holds only its newly returned Slack groups, exactly covering its aggregates.
      assertComposedSlackDays({ aggregates: next.page.aggregates, days: next.page.days });
      state.days = withinOutputBudget(mergeSlackTimelineDays(state.days, next.page.days));
      cursor = next.page.nextSlackCursor;
      requestTuple = next.nextTuple;
    }

    // Verified terminal exhaustion. The fresh final validation is mandatory — also for one page.
    await guarded((context) => validateFinal(
      { binding: { ...state.pinned }, initialNonSlackSourceItemIds: [...state.initialNonSlackSourceItemIds] }, context
    ));
    return { window_days: DRAIN_WINDOW_DAYS, days: state.days };
  }

  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      const failure = classified(error);
      // One fresh WHOLE attempt after an overtake; it suppresses any nested first-page retry. Every
      // accumulated day, cursor and non-Slack row of the failed attempt is dropped with its scope.
      if (failure.code === "restart_required" && attemptNumber < MAX_ATTEMPTS) continue;
      throw failure;
    }
  }
}
