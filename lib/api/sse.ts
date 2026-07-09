/**
 * SSE frame formatter for the streaming query endpoints.
 *
 * This is the single source of the Server-Sent-Events wire format that the workspace client
 * (`aios-workspace/scripts/brain-client.mjs`, `parseSseBlock`) parses. The format is pinned by the
 * shared conformance fixture `docs/contract/brain-contract.json` (vendored here under
 * `test/fixtures/contract/`) and guarded on both sides (AIO-314). Change the frame shape here and the
 * conformance guards on both repos go red — that's the point.
 */
export function formatSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
