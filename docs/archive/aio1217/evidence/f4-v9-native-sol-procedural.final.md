PROCEDURAL_REPAIR_READY

The nine declared inputs are regular non-symlink files and match their declared SHA-256 values. The record supports a safe fresh-grant procedure without revising the accepted specification or architecture.

## Adjudication

The prior attempt completed exactly one `fileUpload` mutation. It is consumed and non-retryable. Its signed URL must never be recovered, reused, or reconstructed.

The script then failed at:

```js
ensure(
  f.filename === expectedFilename &&
  f.contentType === expectedContentType &&
  f.size === expectedSize,
  'Upload source metadata mismatch'
);
```

That assertion precedes header construction, `fetch(...PUT...)`, and `attachmentCreate`. Together with the terminal record and absence of `signedPUT` or attachment records, this proves the parent performed no client PUT and no `attachmentCreate`. The immediate readback proves no AIO-1217 attachment existed at that point.

This does not prove whether the provider created any placeholder or internal grant state. The old URLs are unavailable, no cleanup route is authorized, and no assertion about that possible state is permitted.

The mismatch’s cause remains unknown because the actual returned filename, content type, and size were not retained.

## Schema versus policy

The live schema establishes:

- `fileUpload` requires `filename:String!`, `contentType:String!`, and `size:Int!`.
- `UploadPayload.success` is non-null; `uploadFile` itself is nullable.
- When present, `UploadFile.filename`, `contentType`, `size`, `uploadUrl`, and `assetUrl` are non-null.
- `UploadFile.headers` is a non-null list of non-null `UploadFileHeader` objects whose `key` and `value` are non-null.
- `attachmentCreate` requires `AttachmentCreateInput!`; `issueId`, `url`, and `title` are required input fields.
- `AttachmentPayload.attachment` and the relevant returned attachment identity fields are non-null.

None of that proves that returned filename, content type, or size must echo the request byte-for-byte. Exact echo equality may remain a conservative host qualification rule, but it must be labelled host policy—not schema semantics or evidence of provider failure.

## Observed procedural defects and corrections

1. **Safe metadata was captured after the failing guard.**  
   The script recorded the raw response SHA and byte count, but did not persist success, returned filename/content type/size, host classifications, or header names until after exact echo equality passed.

   **Impact:** The mismatch cannot be diagnosed, and no particular field or value is known.

   **Correction:** Define and persist the sanitized response summary immediately after complete JSON parsing and before any URL, equality, or header guard.

2. **URL capture was only partially ordered correctly.**  
   URL hashes were retained, but only after both URLs parsed successfully. Host evidence was held in memory and lost when the later equality guard failed.

   **Impact:** The record lacks the actual safe host classifications and would also lose URL hashes on an earlier URL-parsing failure.

   **Correction:** Hash returned URL strings before parsing them, then separately record parsing success and normalized host classes. Never retain either URL value or query text.

3. **Header evidence was evaluated too late.**  
   Header-name capture and credential-header checks followed the equality assertion.

   **Impact:** The record cannot show what header names the successful grant returned or whether they would have qualified for a credential-free PUT.

   **Correction:** Record normalized header names before echo-policy evaluation. Keep values only in process memory. Reject `authorization`, `proxy-authorization`, `cookie`, credential material, unsafe hop-by-hop headers, malformed names, and conflicting duplicates.

4. **Phase state was conflated.**  
   A single `attempted`/`externalWriteAttempted` flag covered the grant request but did not distinguish grant completion, PUT attempt, PUT qualification, attachment attempt, and attachment qualification.

   **Impact:** Absence of later operations must be reconstructed from source ordering instead of an explicit durable phase journal.

   **Correction:** Persist monotonic fields such as `fileUploadIssued`, `fileUploadCompleted`, `putAttempted`, `putQualified`, `attachmentCreateAttempted`, and `attachmentQualified`, with counters capped at one and timestamps written before each operation.

5. **Failure recovery performed only ticket readback.**  
   The catch path reran `issueRead`, but performed no asset readback when an asset URL was available in memory.

   **Impact:** It correctly proves no attachment, but cannot characterize asset availability or bytes. It must not be interpreted as proof that no provider placeholder existed.

   **Correction:** After every external-write attempt or uncertain outcome, perform both the guarded ticket readback and—only when the asset URL is qualified as Linear HTTPS—an authenticated, no-redirect asset readback. Persist only status, byte count, hash, and host class.

6. **The error label overstates the evidence.**  
   `Upload source metadata mismatch` sounds causal even though only an unrecorded echo inequality is known.

   **Impact:** It invites unsupported conclusions about normalization, nulls, limits, body contents, or provider behavior.

   **Correction:** Use a factual terminal such as `RETURNED_UPLOAD_METADATA_FAILED_HOST_EQUALITY_POLICY`, accompanied by the captured actual safe scalars and per-field comparison booleans.

## Safe fresh-grant contract

1. Preserve the prior result as a consumed-grant tombstone. Never retry that request, reuse either URL hash as authority, or attempt cleanup.

2. Before new authorization, freshly verify:

   - AIO-1217 identity, UUID, `In Progress` state, description SHA `fa17678…c9ac`, complete exact v6/v7 content, zero v9 description marker, and no target v9 attachment.
   - The prior script/result pair proves no client PUT or `attachmentCreate`; make no stronger provider-state claim.
   - Clean guarded worktree, expected branch, local and fresh remote head `9cd357…c108`, staging base `c5e832…a1ed9`, and canonical v9 size `203946` and SHA `0a19dd…985f`.
   - A new authorization explicitly permits exactly one new `fileUpload`, at most one PUT, and at most one `attachmentCreate`.

3. Before issuing the grant, declare the durable allowlist:

   - Success boolean.
   - Returned filename, content type, and size.
   - URL SHA-256 values, parsing results, and normalized host classes.
   - Normalized header names only.
   - Raw-response SHA-256 and byte count—not raw response contents.
   - Phase flags/counters, exit/status, timestamps, and sanitized errors.

   Never retain URL values, URL queries, header values, credentials, or another copy of the v9 body.

4. After the sole fresh `fileUpload`, atomically sanitize and persist all allowed evidence before applying any guard. Require `success === true`, an `uploadFile` object, valid schema-shaped scalars and headers, absolute HTTPS URLs without userinfo, a non-local/non-private upload destination, and an asset host equal to `linear.app` or a true subdomain.

5. Compare returned filename/content type/size only after capture. Exact equality may be retained as a conservative host policy. If it fails, stop before PUT with the observed values and comparison results; do not characterize the provider or response cause.

6. Before any PUT, construct headers solely from the fresh grant in memory. Add canonical `Content-Type` only if absent; reject a conflicting returned value. Send no API credential, Authorization, cookie, or ambient authentication. Use `redirect: "manual"` and exact bytes read from the existing canonical v9 path.

7. Set `putAttempted` durably before the request. Execute at most one PUT. Never retry an uncertain or failed PUT. Require direct non-redirecting 2xx plus authenticated, no-redirect asset readback proving exactly 203946 bytes and SHA `0a19dd…985f`. Also reread the ticket. Without both, no attachment write is qualified.

8. Only after that qualified PUT may the process issue at most one `attachmentCreate`. Set its attempt flag first. Use only the in-memory fresh asset URL and the already approved metadata.

9. After `attachmentCreate`, including any uncertain response, rerun ticket and asset readbacks. Require exactly one matching attachment identity, expected title/subtitle/metadata and URL hash, unchanged ticket state and description, intact v6/v7, zero v9 description marker, and exact asset bytes/hash. Never retry attachment creation.

10. Any malformed response, unsafe asset host, lost URL, failed readback, or unresolved network outcome terminates the run. The narrow next boundary is readback only; another write requires separately reviewed authorization.

Finally, even a fully verified v9 attachment earns only this isolated attachment evidence. It does not satisfy the specification’s separate exact-v6 attachment obligation and grants no runtime, E4, E6 UI/action-wire, historical-gap, PM acceptance, PR, merge, deployment, or final-task credit.