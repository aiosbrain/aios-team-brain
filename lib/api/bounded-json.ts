/**
 * A bounded JSON body reader for untrusted HTTP input (AUDITFIX-17 / AIO-1136).
 *
 * WHY NOT `req.json()` PLUS A SIZE CHECK: by the time `json()`, `text()` or `arrayBuffer()`
 * resolves, the whole body has already been buffered and decoded — checking afterwards bounds
 * nothing. WHY NOT `Content-Length`: a chunked request does not send one, so a gate that trusts
 * the header is not a bound at all. This counts each chunk's `byteLength` BEFORE retaining it and
 * stops the moment the running total crosses the cap.
 *
 * Technique borrowed from `lib/gateway/http.readGatewayJson`, deliberately NOT its policy: the
 * gateway has its own status codes, its own 415 content-encoding rule and a strict (`fatal: true`)
 * decoder. This reader reports an outcome and lets the caller own the envelope, and it decodes the
 * way `Request.json()` does so bounding a body cannot smuggle in a new rejection class.
 *
 * ON CANCELLATION — this reader RELEASES the reader lock and never cancels. Cancelling a server
 * request body is a lifecycle the application does not need to own: the HTTP runtime owns
 * unread-body and connection cleanup and may drain the remainder. Releasing on every path
 * (overflow, success, read failure) leaves the stream unlocked for whatever the runtime does next.
 *
 * The installed Next route guide confirms Route Handlers use the standard Web `Request` API and
 * that Pages Router `bodyParser` configuration is inapplicable, so `Request.body` is the whole
 * surface there is to bound here.
 */

export type BoundedJsonFailure = "payload_too_large" | "unreadable_body";

export type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: BoundedJsonFailure };

const TOO_LARGE: BoundedJsonResult = Object.freeze({
  ok: false,
  failure: "payload_too_large",
});
const UNREADABLE: BoundedJsonResult = Object.freeze({
  ok: false,
  failure: "unreadable_body",
});

/**
 * True when the caller DECLARED more than the cap in a syntactically usable way.
 *
 * This is an optimization and nothing more: it lets an oversized push be refused without reading
 * a single byte. It is never the measurement. A missing, non-decimal or misleadingly low
 * declaration is simply ignored at application level — unusable input gets no new error contract
 * of its own, and the stream counter below is what actually decides.
 */
function declaredLengthExceeds(headers: Headers, maxBytes: number): boolean {
  const declared = headers.get("content-length");
  return declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes;
}

/**
 * Read `req.body` up to an INCLUSIVE `maxBytes` and parse it as JSON.
 *
 * - exactly `maxBytes` is admitted; `maxBytes + 1` is `payload_too_large`;
 * - the crossing chunk is never retained and the oversized prefix is never parsed;
 * - an absent body, a read failure and malformed JSON are all `unreadable_body`, which the caller
 *   maps onto its existing invalid-body response rather than a new one.
 */
export async function readBoundedJson(
  req: Request,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  if (declaredLengthExceeds(req.headers, maxBytes)) return TOO_LARGE;

  const body = req.body;
  if (!body) return UNREADABLE;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Count the chunk BEFORE storing it, so retention is bounded by the cap rather than by the
      // cap plus one chunk. (A single delivered chunk may already exceed the cap; that is the
      // platform's allocation, not this reader's.)
      total += value.byteLength;
      if (total > maxBytes) return TOO_LARGE;
      chunks.push(value);
    }
  } catch {
    return UNREADABLE;
  } finally {
    // Every read above is awaited, so no read is ever pending here and this cannot throw.
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    // `Request.json()` is "UTF-8 decode, then JSON.parse". A default `TextDecoder` is exactly that
    // decode: non-fatal (invalid sequences become U+FFFD, they do not reject) and BOM-stripping.
    // Decoding the CONCATENATED bytes is what makes a multibyte character split across two chunks
    // round-trip; per-chunk decoding would replace both halves.
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return UNREADABLE;
  }
}
