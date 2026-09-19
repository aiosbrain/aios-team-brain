import { IntakeValidationError, validateIntakeRequest, type IntakeRequest } from './debt-intake-validation';

export const MAX_INTAKE_BYTES = 1024 * 1024;
/** Parse JSON without silently overwriting decoded duplicate keys or rounding numbers. */
export function strictIntakeJson(text: string): unknown {
  let pos = 0;
  const fail = (): never => { throw new IntakeValidationError('Invalid JSON encoding'); };
  const whitespace = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  function string(): string {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, pos)) as string; } catch { return fail(); }
      }
      if (char === '\\') pos++;
    }
    return fail();
  }
  function value(depth: number): unknown {
    if (depth > 32) return fail();
    whitespace();
    const char = text[pos];
    if (char === '"') return string();
    if (char === '{') {
      pos++; whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[pos] === '}') { pos++; return result; }
      while (pos < text.length) {
        whitespace(); if (text[pos] !== '"') return fail();
        const key = string(); if (Object.hasOwn(result, key)) return fail();
        whitespace(); if (text[pos++] !== ':') return fail();
        result[key] = value(depth + 1); whitespace();
        const separator = text[pos++]; if (separator === '}') return result;
        if (separator !== ',') return fail();
      }
      return fail();
    }
    if (char === '[') {
      pos++; whitespace(); const result: unknown[] = [];
      if (text[pos] === ']') { pos++; return result; }
      while (pos < text.length) {
        result.push(value(depth + 1)); whitespace();
        const separator = text[pos++]; if (separator === ']') return result;
        if (separator !== ',') return fail();
      }
      return fail();
    }
    for (const [token, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, pos)) { pos += token.length; return literal; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(pos));
    if (!match) return fail();
    pos += match[0].length;
    // A decimal/exponent/leading zero remains unconsumed and invalidates framing.
    const number = Number(match[0]); if (!Number.isSafeInteger(number)) return fail();
    return number;
  }
  const result = value(0); whitespace(); if (pos !== text.length) return fail(); return result;
}

export async function parseIntakeBody(request: Request): Promise<IntakeRequest> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) throw new IntakeValidationError('Expected application/json UTF-8');
  const tooLarge = () => new IntakeValidationError('Payload too large', 413, 'payload_too_large');
  const advertised = request.headers.get('content-length');
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > MAX_INTAKE_BYTES) throw tooLarge();
  if (!request.body) throw new IntakeValidationError('Missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_INTAKE_BYTES) { void reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof IntakeValidationError) throw error;
    throw new IntakeValidationError('Unreadable body');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // TextDecoder strips a leading UTF-8 BOM by default, so reject it first.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new IntakeValidationError('BOM is forbidden');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new IntakeValidationError('Invalid UTF-8'); }
  const result = strictIntakeJson(text);
  validateIntakeRequest(result);
  return result;
}
