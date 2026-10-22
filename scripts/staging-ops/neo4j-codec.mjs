import neo4j from "neo4j-driver";

const TEMPORAL = ["Date", "DateTime", "Duration", "LocalDateTime", "LocalTime", "Time", "Point"];

export function encodeNeo4jValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("unsupported non-finite Neo4j number");
    return value;
  }
  if (neo4j.isInt(value)) return { $neo4j: "Integer", value: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $neo4j: "Bytes", value: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encodeNeo4jValue);
  if (value && typeof value === "object") {
    const kind = value.constructor?.name;
    if (TEMPORAL.includes(kind)) {
      return {
        $neo4j: kind,
        fields: Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined).map(([key, field]) => [key, encodeNeo4jValue(field)])),
      };
    }
    if (Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, encodeNeo4jValue(field)]));
    }
  }
  throw new Error(`unsupported Neo4j property value: ${value?.constructor?.name ?? typeof value}`);
}

const d = (fields, key) => decodeNeo4jValue(fields[key]);

export function decodeNeo4jValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeNeo4jValue);
  if (!value.$neo4j) return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, decodeNeo4jValue(field)]));
  if (value.$neo4j === "Integer") return neo4j.int(value.value);
  if (value.$neo4j === "Bytes") return Buffer.from(value.value, "base64");
  const f = value.fields ?? {};
  switch (value.$neo4j) {
    case "Date": return new neo4j.types.Date(d(f, "year"), d(f, "month"), d(f, "day"));
    case "LocalTime": return new neo4j.types.LocalTime(d(f, "hour"), d(f, "minute"), d(f, "second"), d(f, "nanosecond"));
    case "Time": return new neo4j.types.Time(d(f, "hour"), d(f, "minute"), d(f, "second"), d(f, "nanosecond"), d(f, "timeZoneOffsetSeconds"));
    case "LocalDateTime": return new neo4j.types.LocalDateTime(d(f, "year"), d(f, "month"), d(f, "day"), d(f, "hour"), d(f, "minute"), d(f, "second"), d(f, "nanosecond"));
    case "DateTime": return new neo4j.types.DateTime(d(f, "year"), d(f, "month"), d(f, "day"), d(f, "hour"), d(f, "minute"), d(f, "second"), d(f, "nanosecond"), d(f, "timeZoneOffsetSeconds"), f.timeZoneId ?? null);
    case "Duration": return new neo4j.types.Duration(d(f, "months"), d(f, "days"), d(f, "seconds"), d(f, "nanoseconds"));
    case "Point": return f.z === undefined ? new neo4j.types.Point(d(f, "srid"), f.x, f.y) : new neo4j.types.Point(d(f, "srid"), f.x, f.y, f.z);
    default: throw new Error(`unsupported Neo4j codec tag: ${value.$neo4j}`);
  }
}
