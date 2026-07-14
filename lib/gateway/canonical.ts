import "server-only";
import { createHash } from "node:crypto";

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function jsonString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("unpaired Unicode surrogate");
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new TypeError("unpaired Unicode surrogate");
  }
  return JSON.stringify(value);
}

/** Small RFC 8785/JCS serializer for the JSON-only gateway domain. */
export function canonicalize(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("non-plain JSON object");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${jsonString(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function canonicalSha256(value: CanonicalJson): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
