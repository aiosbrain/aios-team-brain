/**
 * AIO-1112 round 8 — THE TWO AUTHORITIES the audit's path work runs under, kept apart on purpose.
 *
 * WHY THEY ARE SEPARATE. The merge used ONE step counter as a proxy for both work and memory, and that
 * boundary is invalid: a single accepted ancestor relation can retain hundreds of bytes while a million
 * steps allocate nothing, so a 64-million-step ceiling could admit an index larger than the heap.
 * Lowering that constant without naming the actual retained allocations would repeat the mistake.
 *
 *   `RetainedStateBudget` — LOGICAL BYTES of state the run keeps. Monotonic for the whole run.
 *   `WorkBudget`         — CPU steps and the wall-clock deadline. Independent of memory.
 *
 * THE CEILING IS A SUPPORTED-INPUT BOUNDARY, NOT A HEAP GUARANTEE. 256 MiB of logical charge leaves
 * more than 3.5 GiB under the observed ~4.1 GiB Node heap for the runtime, module graph, buffers and
 * allocator overhead this model does not attempt to predict. The per-item charges below are deliberate
 * over-estimates of V8's real object sizes; they are an accounting contract, not a measurement.
 *
 * MONOTONIC, WITH NO REFUNDS. Deleting a key, overwriting a path or finishing a layer never returns
 * budget. Churn (insert → delete → reinsert) therefore cannot be used to keep the audit under the
 * ceiling while driving real allocator high-water state up, and an emptied container that survives a
 * removal stays charged for what it cost to create.
 */

/** The production ceilings. `maxRelations` is a SECONDARY cardinality invariant, never the heap authority. */
export const RETAINED_STATE_LIMITS = Object.freeze({
  maxLogicalBytes: 256 * 1024 * 1024,
  maxRelations: 500_000,
});

/** The conservative charge schedule, in logical bytes. Shared by every caller so nothing re-invents one. */
export const RETAINED_CHARGES = Object.freeze({
  /** Two bytes per UTF-16 unit (the worst representation) plus header/pointer headroom. */
  string: (text) => 128 + 2 * String(text ?? "").length,
  /** One array/Set/Map membership, or one scalar record field retaining a reference. */
  membership: 256,
  /** One retained object/record, in addition to its own string and reference charges. */
  record: 1024,
});

/**
 * THE PRIVATE MARKER that says "the RUN'S OWN shared authority is exhausted", as distinct from a tar
 * reader limit (a path, a metadata record, a header count) that belongs to one archive.
 *
 * Both surface publicly as the same fixed `AUDIT_TAR_LIMIT_EXCEEDED` code — the public contract does not
 * change and nothing internal leaks — but only THIS category may escape nested-archive handling as a run
 * refusal. A reader limit inside a nested archive stays what it has always been: a recorded
 * `nested-archive-undecodable` coverage gap.
 */
const SHARED_AUTHORITY = Symbol.for("aios.image-audit.shared-authority-exhausted");

const refuse = (message) => {
  throw Object.assign(new Error(message), { name: "TarLimitError", code: "AUDIT_TAR_LIMIT_EXCEEDED", [SHARED_AUTHORITY]: true });
};

/** Is this the run's shared retained-state/work authority refusing, rather than a per-archive limit? */
export function isSharedAuthorityExhaustion(error) {
  return Boolean(error && typeof error === "object" && error[SHARED_AUTHORITY] === true);
}

/** A ceiling must be a real, finite, non-negative number — `NaN`/`Infinity` are not budgets. */
function finiteCeiling(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative safe integer`);
  }
  return value;
}

/** An interval must be a positive integer: a zero or fractional interval never fires. */
function positiveInterval(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

/**
 * The run's retained-state authority. Created once by `inspectExport`, passed into every layer
 * inventory and into the merge, so one ceiling covers everything the run keeps at once.
 *
 * Every method CHARGES BEFORE the caller allocates, inserts, copies or opens anything — a refusal must
 * happen while the state is still small, not after the allocation that would have exhausted the heap.
 */
export function createRetainedStateBudget({
  maxLogicalBytes = RETAINED_STATE_LIMITS.maxLogicalBytes,
  maxRelations = RETAINED_STATE_LIMITS.maxRelations,
} = {}) {
  finiteCeiling(maxLogicalBytes, "maxLogicalBytes");
  finiteCeiling(maxRelations, "maxRelations");
  let used = 0;
  let relations = 0;
  const take = (bytes) => {
    // MONOTONIC BY CONSTRUCTION: a refund cannot be expressed through this API at all, so no caller can
    // "give back" budget on delete, overwrite or layer completion and then reuse it.
    if (!Number.isFinite(bytes) || bytes <= 0) throw new TypeError("a retained-state charge must be a positive number of bytes");
    if (used + bytes > maxLogicalBytes) {
      refuse(`retained audit state would exceed the ${maxLogicalBytes}-byte supported bound`);
    }
    used += bytes;
  };
  return {
    get used() { return used; },
    get limit() { return maxLogicalBytes; },
    get relations() { return relations; },
    get relationLimit() { return maxRelations; },
    /** One retained string occurrence. */
    string(text) { take(RETAINED_CHARGES.string(text)); },
    /** One membership in an array/Set/Map, or one reference-holding field. */
    membership(count = 1) { take(RETAINED_CHARGES.membership * count); },
    /** One retained object/record, plus `fields` reference-holding fields. */
    record(fields = 0) { take(RETAINED_CHARGES.record + RETAINED_CHARGES.membership * fields); },
    /** A string stored in a container: the string itself plus its membership. */
    path(text) { this.string(text); this.membership(); },
    /** A newly created container (Set/Map entry) keyed by a string. */
    container(key) { this.record(); this.string(key); },
    /**
     * One ancestor relation. `alreadyMember` may only be `true` when the caller has PROVEN the exact
     * membership already exists; a deletion followed by a reinsertion is charged again, by design.
     */
    relation(ancestor, { alreadyMember = false } = {}) {
      if (alreadyMember) return;
      relations += 1;
      if (relations > maxRelations) refuse(`retained ancestor relations exceed the ${maxRelations} bound`);
      this.string(ancestor);
      this.membership();
    },
  };
}

/** The CPU/deadline defaults. Finite for every caller, including direct ones. */
export const WORK_LIMITS = Object.freeze({ maxSteps: 64_000_000, deadlineEvery: 1024 });

/**
 * The run's CPU authority: a finite step ceiling and the run's wall-clock deadline, consulted at a
 * fixed small interval. Every entry validation, filter pass, marker dispatch, placement, removal,
 * ancestor visit and candidate comparison takes a step — including names with NO ancestors, so a
 * workload of shallow or root-level paths cannot bypass both counters.
 */
export function createWorkBudget({ maxSteps = WORK_LIMITS.maxSteps, deadlineEvery = WORK_LIMITS.deadlineEvery, deadline } = {}) {
  finiteCeiling(maxSteps, "maxSteps");
  positiveInterval(deadlineEvery, "deadlineEvery");
  let steps = 0;
  return {
    get steps() { return steps; },
    get limit() { return maxSteps; },
    step(operation = "path work") {
      steps += 1;
      if (steps > maxSteps) refuse(`audit path work exceeds the ${maxSteps}-step bound`);
      if (deadline && steps % deadlineEvery === 0) deadline.assert(operation);
    },
  };
}

/**
 * THE ONE CHARGED WRITER for coverage limitations.
 *
 * Every limitation the audit records is retained for the whole run, so every one of them is charged —
 * and routing them all through this object is what makes bypassing the authority structurally hard
 * rather than a rule to remember at nineteen call sites. `record` reserves a limitation's record and
 * its string fields BEFORE the object is stored; `adopt` takes an already-charged limitation from a
 * nested collector and charges only the new membership.
 */
export function createLimitationCollector(retained) {
  const items = [];
  return {
    get items() { return items; },
    get length() { return items.length; },
    record(limitation) {
      retained.record(1);
      for (const value of Object.values(limitation)) if (typeof value === "string") retained.string(value);
      items.push(limitation);
      return limitation;
    },
    adopt(limitation) {
      retained.membership();
      items.push(limitation);
      return limitation;
    },
  };
}
