# Finding observations v1

**Normative contract — AIO-1098.** Artifact: `finding-observations.v1.jsonl`.
Schema: [`schemas/finding-observations.v1.schema.json`](schemas/finding-observations.v1.schema.json)
(JSON Schema Draft 2020-12). The words MUST, MUST NOT, and MAY are requirements.
This is a separate reusable core contract, not an extension of `observations.v1.jsonl`.
This change implements no producer, uploader, endpoint, database, or dashboard.

## Acceptance boundary and privacy

Acceptance requires **all** of: strict JSON parsing, schema validation with calendar
validation, trusted configuration checks, identity verification, lifecycle/replay checks,
and summary reconciliation. Schema validation alone is insufficient. Reject the entire
input on failure; never strip unknown fields, repair values, or normalize unsafe content
into an accepted record. Malformed source candidates are counted through a sanitized
summary, never copied as malformed event records into this artifact.

Both variants are recursively closed (`additionalProperties: false`). Values are enums,
bounded integers, UTC timestamps, digests, typed identifiers, and configured producer or
codebase identifiers. No free-text description, arbitrary URL, path, excerpt, patch,
prompt, transcript, credential, or contributor field exists. Strings containing such
content fail validation; negative fixtures and value-channel tests pin this boundary.
Missing links MUST be explicit JSON null, not omitted keys, empty strings, or fabricated IDs.

The consumer supplies a trusted registry of producer namespaces and permitted software
versions, codebase slugs, and Linear team keys. It MUST come from reviewed configuration,
never the artifact, source report, or automatic registration of incoming values. Registry
changes must preserve historical entries needed to validate replay. The test registry in
`fixtures/finding-observations.v1/trusted-config.json` is synthetic, not production config.
All codebase memberships and PR/merge codebases must resolve against that registry; scanner
names resolve against producer namespaces. Producer version syntax does not authorize a version.

Digests and typed IDs are **not proof of sanitization or authenticity**. A malicious writer
could encode data in any numeric or digest channel. Trusted producers must derive hashes
from sanitized artifacts, counters from their declared inventory, and identifiers from the
named systems, not user prose or raw location strings. Source IDs that carry sensitive
material cannot be made safe merely by hashing them. Configuration plus authenticated
provenance is required at a future transfer boundary. The conformance oracle checks the
contract, not the truth of external evidence or existence of external Linear/Git objects.

The artifact is machine-local and declares `visibility_tier: "team"` as its permitted
future tier, not upload authorization. Machine-to-team transfer is default-deny until the
whole boundary above succeeds. Downstream API work must return HTTP 422 for malformed or
unsafe records. No API or transfer implementation belongs in this slice.

## Wire representation and fields

Each nonblank line is one UTF-8 JSON object; LF terminates every line, including the last.
An empty artifact is not a finalized run: a summary is required. Reject CR/CRLF and Unicode
line separators as record boundaries; never translate newlines before parsing. Reject BOM,
invalid UTF-8, blank lines, duplicate JSON keys at any depth, non-finite numbers, and numeric
tokens with decimal/exponent syntax. Integers are 0..2147483647; attempts and issue/PR
numbers are 1..2147483647. Booleans exist only in detector completion. Timestamps have the
exact UTC form `YYYY-MM-DDTHH:MM:SSZ` and must be actual calendar instants (years 0001..9999,
no leap seconds). Do not depend on optional JSON Schema format plugins for calendar checks.
All hex digests/SHA values are lowercase, without prefixes. Schema string patterns reject
trailing newline characters as well as interior unsafe characters.

Both variants require:

| Field | Meaning |
|---|---|
| `schema_version` | Exactly `finding-observations.v1` |
| `record_type` | `candidate` or `run_summary` |
| `visibility_tier` | Exactly `team` |
| `event_id` | SHA-256 of the complete canonical record excluding this field |
| `producer` | Configured `name`, permitted `version`, opaque SHA-256 `run_id` |
| `attribution` | SHA-256 `program_id`, SHA-256 harness `run_id`, positive `attempt`, nullable typed `issue` |
| `observed_at` | Original evidence observation time, preserved during replay |
| `evidence_status` | `complete`, `incomplete`, or `unknown` |

Producer run and harness attribution run are distinct namespaces. All records in one
producer `(name, run_id)` must share attribution. Later lifecycle work uses a new producer
run and its own summary, retaining the candidate's original program ID and discovery identity.
Software versions may change across events without renaming the candidate.

A candidate additionally requires `candidate_id`, frozen `identity`, `codebases`,
`taxonomy`, `state`, `disposition`, `sequence`, `predecessor_event_id`, `episode`,
`duplicate_target`, and `links`. Membership is a nonempty, lexicographically sorted,
unique set of at most 32 configured slugs. A cross-repository discovery has one identity
and multiple memberships. `cross-repo` is forbidden as a substitute for actual codebases.
Memberships and taxonomy may be corrected by a legal later lifecycle event; they do not
form discovery identity. Do not emit a same-state edit with an invented transition.

The AIO-999 vocabulary is pinned from the hub's canonical
[`docs/finding-taxonomy.md`](https://github.com/johnellison/aios/blob/main/docs/finding-taxonomy.md):

| Dimension | Accepted values |
|---|---|
| `severity` | `critical`, `high`, `medium`, `low`, `unknown` |
| `defect_class` | `logic`, `security`, `gate-integrity`, `test-integrity`, `verifiability`, `contract-drift`, `docs`, `perf`, `unknown` |
| `determinism` | `deterministic`, `flaky`, `unverified`, `unknown` |
| `fences` | sorted unique nonempty set of `none`, `migration`, `credential`, `schema`, `public-api`, `release`, `unknown` |

`none` and `unknown` must each occur alone. Telemetry `unknown` values add no Linear
labels and do not remap unknown severity to low. `unverified` is a known assessment that
verification has not occurred; `unknown` means the assessment itself was not captured.

`links` has exactly five nullable slots:

| Slot | Non-null shape |
|---|---|
| `linear` | `{type: "linear", team: <configured key>, number: <positive integer>}` |
| `scanner` | `{type: "scanner", producer: <configured namespace>, finding_id: <SHA-256 opaque ID>}` |
| `pull_request` | `{type: "pull_request", codebase: <membership>, number: <positive integer>}` |
| `merge` | `{type: "merge", codebase: <membership>, sha: <40 lowercase hex digits>}` |
| `resolution` | `{type: "resolution", sha256: <sanitized verification evidence digest>}` |

Attribution `issue` uses the same typed Linear reference. Scalar URLs and raw scanner
strings are invalid. An upstream scanner must supply/derive a stable sanitized opaque
SHA-256 identifier, not stuff its arbitrary original string into this slot.

## Discovery identity and replay

The exact identity object contains:

```
version: "discovery.v1"
producer_namespace: <configured producer name>
original_run_id: <original producer run SHA-256 ID>
source_artifact_sha256: <sanitized original candidate-inventory artifact digest>
source_record_key: {kind: "structural_sha256", value: <sanitized stable finding-record ID digest>}
                  OR {kind: "position", value: <zero-based original finding-record position>}
```

One source record represents **one discovery**, not one source-code location. Two defects
at the same location must be separate finding records with distinct stable structural IDs
or distinct original positions. A structural ID must identify a finding record uniquely
within the artifact. If upstream records bundle findings, the sanitized inventory must
first split them into distinct finding records with frozen original positions. Never use
file/line, defect class alone, or the position in a combined/reordered input list as the key.
This inventory design is a producer obligation; no splitter is implemented here.

Canonicalization is recursive sorted object keys, UTF-8, no ASCII escaping, compact `,`
and `:` separators, integer decimal tokens, and lowercase JSON booleans/null. Set arrays
must already be sorted/unique and are rejected otherwise. The schema permits ASCII-only
string content, so Unicode ordering and normalization differences cannot affect v1 IDs.
No trailing LF is part of the hashed object. The domain bytes are ASCII followed by a
single NUL byte, then the canonical JSON bytes:

```
candidate_id = SHA256("aios.finding.candidate.discovery.v1" + NUL + canonical(identity))
event_id     = SHA256("aios.finding.event.v1" + NUL + canonical(record without event_id))
```

Both IDs are 64 lowercase hex digits. `known-answers.json` pins canonical bytes and IDs.
Changing taxonomy, links, observation software version, or later producer-run identity
does not change the frozen discovery identity. Discovery must name its original producer
run; later events retain that identity and the same producer namespace. Identity changes
require a new identity algorithm version and contract support, never silent reinterpretation.

Exact replay preserves every original field, including times, provenance, sequence,
episode, and predecessor. Deduplicate byte-equivalent canonical events by `event_id`.
Two different events for the same `(candidate_id, sequence)` are a conflict even if both
hashes are valid. An invalid claimed ID, changed frozen identity, or conflicting summary
fails the entire ledger. Hash collisions must fail closed, never merge differing payloads.

A replay/merge operation MUST NOT assign new sequences or recompute original provenance.
Sequences are allocated by the original single writer when it records evidence. Independent
candidates can arrive in any input order; they have separate sequence spaces and no shared
tie-break requirement. Two concurrent proposed children of one predecessor are a conflict,
not a timestamp race to resolve. Future writers must serialize through one writer or an
exclusive lock and publish atomically. This contract implements no writing/locking mechanism.

## Lifecycle

Validate a complete ledger, including earlier-run history referenced by later events.
Input line order is not lifecycle order. Group by candidate and validate contiguous
`sequence` values starting at 0, each with the exact previous `event_id`. Discovery is
sequence 0, episode 0, with null predecessor; no child is valid without that discovery.
Timestamps never decide transitions. No absent event implies a transition or resolution.

The table is exhaustive. Same-state repeats with changed content are not transitions.
Exact repeated events are replay, not new lifecycle events.

| Current state | Permitted next states |
|---|---|
| `discovered` | `verified`, `duplicate`, `rejected`, `incomplete` |
| `verified` | `filed`, `duplicate`, `rejected`, `incomplete` |
| `filed` | `queue_eligible`, `duplicate`, `rejected`, `incomplete` |
| `queue_eligible` | `selected`, `duplicate`, `rejected`, `incomplete` |
| `selected` | `remediation_started`, `duplicate`, `rejected`, `incomplete` |
| `remediation_started` | `merged`, `duplicate`, `rejected`, `incomplete` |
| `merged` | `resolved`, `incomplete` |
| `resolved` | `escaped`, `reopened` |
| `escaped` | `reopened`, `incomplete` |
| `duplicate`, `rejected`, `incomplete` | `reopened` |
| `reopened` | `verified`, `duplicate`, `rejected`, `incomplete` |

`reopened` increments episode by exactly one. Every other event preserves episode.
Reopening preserves history and starts assessment again; filing/remediation follow their
normal prerequisites. `escaped` explicitly records a verified resolution that did not hold;
it clears the resolved disposition but does not itself start another episode.

`disposition` is `duplicate`, `rejected`, or `resolved` only in the matching state,
`unknown` for `incomplete`, and `open` otherwise. These are mutually exclusive current
outcomes; historical outcomes remain visible. `duplicate_target` is non-null only for
`duplicate`: it must be a different candidate whose discovery is present in the ledger.
Reject self-links, unknown targets and cycles in the complete historical duplicate graph,
including edges from prior episodes. Reopening cannot erase a duplicate-cycle violation.

All transitions other than `discovered`/`incomplete` require complete explicit evidence.
`incomplete` requires incomplete or unknown evidence and is not a rejection. Filing through
resolution requires a Linear or scanner reference. Merge and resolution require a merge
reference. Resolution additionally requires a resolution-evidence digest and complete
evidence: a merged commit alone never proves resolution. Verification need not have any
external link; it is not equivalent to filing, and filing is not queue eligibility.

## Run completion and denominator

A run summary is finalized evidence for exactly one producer `(name, run_id)` and one
stage. A finalized run has exactly one logical summary; identical replay deduplicates,
any differing summary fails. A later run appends its own summary rather than revising an
old one. Every represented candidate run must have its summary in a complete ledger.
Intermediate growing streams are not finalized ledgers and are outside this test oracle.

`stage` is `discovery`, `filing`, `remediation`, or `resolution`. Take the highest-sequence
event **in that run** for each candidate. Terminal stage states are:

| Stage | Terminal states |
|---|---|
| discovery | `verified`, `filed`, `queue_eligible`, `selected`, `remediation_started`, `merged`, `resolved`, `duplicate`, `rejected` |
| filing | `filed`, `queue_eligible`, `selected`, `remediation_started`, `merged`, `resolved`, `duplicate`, `rejected` |
| remediation | `merged`, `resolved`, `duplicate`, `rejected` |
| resolution | `resolved`, `duplicate`, `rejected` |

Every other state is incomplete for that stage. Thus a verified finding handed to filing
can finish discovery work while remaining unresolved. A later escaped event in another
run does not rewrite the original run's completion evidence.

`counts` always contains `raw_candidates`, `emitted_candidates`, `terminal_stage`,
`incomplete`, and `malformed`, with no other fields. For known capture:

```
raw_candidates = terminal_stage + incomplete
emitted_candidates = distinct candidate IDs with evidence in this run
raw_candidates - emitted_candidates = malformed
incomplete = emitted_candidates - terminal_stage + malformed
```

Raw is the trusted producer's sanitized inventory of distinct discovery records (or
existing candidate work items for later lifecycle runs), before malformed items are
excluded. It is not a count of JSONL lines or tool invocations. The detector evidence hash
must bind a sanitized inventory, its raw count, capture status and detector-completion
result. Consumers verify arithmetic here; external authenticity and inventory completeness
must be verified against trusted evidence by future producers/ingestion. A digest alone
cannot prove that a producer disclosed every discovery.

Malformed inventory entries have no accepted candidate event and are a subset of incomplete,
never an extra addend to raw. In v1 the only permitted known raw/emitted gap is malformed
entries; `emission_gap_reason` must be `malformed` for a positive gap and `none` for no gap.
No filtering, silent dropped valid candidates, or additional unexplained gap is allowed.
A downstream consumer must not mistake this strict contract for a claim that sanitization
of malformed candidates is implemented in this PR.

Independent duplicate discoveries count separately in raw and emitted and can each have a
terminal stage outcome. Exact repeated discoveries/events count once. Multiple memberships
never multiply candidates. For later runs, an existing candidate touched in that run counts
once in that run's denominator; this does not create a new global discovery.

| Capture | Counts | `detector_completed` | Detector evidence | Evidence status |
|---|---|---|---|---|
| `complete` | all known | true | required SHA-256 | `complete` |
| `partial` | all known within the captured inventory | false | required SHA-256 | `incomplete` |
| `unknown` | all null | null | null | `unknown` |

Partial capture asserts only the enumerated inventory, not a whole-detector denominator.
Unknown capture uses `emission_gap_reason: "unknown"`; some individual candidate events
may survive even though the denominator is unknown. Zero raw candidates is valid only for
complete capture with explicit completion evidence. Provider failure is unknown capture,
not a successful empty capture. Complete capture does not mean all candidates resolved;
it means the detector finished and the inventory is known.

## Five-candidate worked example

`positive/five-candidate-worked-example.jsonl` is the sanitized example. All five records
come from one sanitized inventory with positions frozen before any consolidation:

| Original position | Latest state | Memberships | Discovery-stage outcome |
|---|---|---|---|
| 0 | verified | harness | terminal, unlinked and unresolved |
| 1 | duplicate of position 0 | harness | terminal, distinct candidate ID |
| 2 | rejected | harness | terminal |
| 3 | verified | devtools, harness | terminal, one cross-repository candidate |
| 4 | incomplete | harness | incomplete, not rejected |

Each row has one identity and one stage outcome. Raw 5 = terminal 4 + incomplete 1;
emitted 5; malformed 0. Ten lifecycle event lines plus one summary do not mean eleven
candidates. Replaying the entire example yields the same five candidates and eleven logical
records. The malformed-accounted variant adds one omitted malformed inventory item:
raw 6 = terminal 4 + incomplete 2, emitted 5, malformed 1.

## Executable conformance and downstream pinning

Run from the Harness root (the files use `*.test.py`, not dotted unittest modules):

```sh
python3 evals/observations.test.py
python3 evals/finding_observations_contract.test.py
bash evals/conformance.test.sh
./check
```

`finding_observations_test_support.py` is a test-only lifecycle/replay oracle. It imports
the existing development-only `jsonschema` package, not a runtime dependency. Missing
schema tooling prints `SKIPPED` and exits 77 from the suite; `./check` records a skip,
never a full pass. CI installs jsonschema and must execute the suite. Deterministic
schema/fixture/compatibility results precede model contract/privacy review.

Positive fixtures cover full lifecycle, five-candidate accounting, unlinked/cross-repository
verification, duplicate/rejection/incomplete, structural identities, partial/missing/empty
capture, and resolved → escaped → reopened across runs. Negative fixtures and dynamic
perturbations cover strict parsing, recursive field/value smuggling, membership/link types,
identity/replay conflicts, ordering/episodes, duplicate cycles, evidence and summary errors.

AIO-1099, AIO-1100 and AIO-1101 must consume the merged revision with the contract and
schema SHA-256 fingerprints published in its PR and issue closeout. Any incompatible
identity, field or lifecycle interpretation needs a new contract version.
