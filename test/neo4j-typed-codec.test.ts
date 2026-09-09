/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { decodeNeo4jValue, encodeNeo4jValue } from "../scripts/staging-ops/neo4j-codec.mjs";

/**
 * AC-05 requires the copied graph to keep the ACTUAL driver types, not values that print the same.
 *
 * What this file used to assert was `decoded.toString() === value.toString()`, which is satisfied by
 * a codec that returns a plain string, a plain number, or the wrong temporal class entirely — every
 * one of which would be written back to Neo4j as a different property type. So every row below
 * asserts the driver's own PUBLIC TYPE PREDICATE plus the exact field values, and the expected
 * values are written down INDEPENDENTLY rather than read back off the encoder's output.
 */

const roundtrip = (value: unknown) => decodeNeo4jValue(encodeNeo4jValue(value));

/** Integer field equality without going through `toString` on both sides of the comparison. */
const intIs = (actual: unknown, expected: string) => {
  expect(neo4j.isInt(actual), `expected a driver Integer, got ${String((actual as any)?.constructor?.name)}`).toBe(true);
  expect((actual as any).toString()).toBe(expected);
};

describe("Neo4j lossless typed codec — types, not just representations", () => {
  it("keeps an Integer beyond the JS safe range as a driver Integer", () => {
    const decoded = roundtrip(neo4j.int("9223372036854775806"));
    intIs(decoded, "9223372036854775806");
    // The failure this excludes: `Number("9223372036854775806")` is 9223372036854775808. A codec
    // that round-tripped through a JS number would pass a `toString` comparison against ITSELF and
    // still have changed the value.
    expect(typeof decoded).not.toBe("number");
    const integer = decoded as ReturnType<typeof neo4j.int>;
    // Exact driver representation, independently written down. Calling `toNumber()` here would
    // itself round the value, and the numeric literal on the other side would be rounded by JS too.
    expect(integer.high).toBe(2_147_483_647);
    expect(integer.low).toBe(-2);
    expect(integer.inSafeRange()).toBe(false);
    expect(integer.equals(neo4j.int("9223372036854775806"))).toBe(true);
  });

  it("keeps a Date as a driver Date with its exact fields", () => {
    const decoded: any = roundtrip(new neo4j.types.Date(neo4j.int(2026), neo4j.int(9), neo4j.int(7)));
    expect(neo4j.isDate(decoded)).toBe(true);
    intIs(decoded.year, "2026");
    intIs(decoded.month, "9");
    intIs(decoded.day, "7");
  });

  it("keeps a LocalTime as a driver LocalTime with its exact fields", () => {
    const decoded: any = roundtrip(new neo4j.types.LocalTime(neo4j.int(13), neo4j.int(45), neo4j.int(6), neo4j.int(123456789)));
    expect(neo4j.isLocalTime(decoded)).toBe(true);
    expect(neo4j.isTime(decoded), "a LocalTime must not decode as a zoned Time").toBe(false);
    intIs(decoded.hour, "13");
    intIs(decoded.minute, "45");
    intIs(decoded.second, "6");
    intIs(decoded.nanosecond, "123456789");
  });

  it("keeps a Time as a driver Time, including its zone offset", () => {
    const decoded: any = roundtrip(new neo4j.types.Time(neo4j.int(13), neo4j.int(45), neo4j.int(6), neo4j.int(7), neo4j.int(-3600)));
    expect(neo4j.isTime(decoded)).toBe(true);
    intIs(decoded.hour, "13");
    intIs(decoded.nanosecond, "7");
    // The offset is the whole difference between Time and LocalTime; dropping it silently would
    // shift every zoned time in the copy.
    intIs(decoded.timeZoneOffsetSeconds, "-3600");
  });

  it("keeps a LocalDateTime as a driver LocalDateTime with its exact fields", () => {
    const decoded: any = roundtrip(new neo4j.types.LocalDateTime(neo4j.int(2026), neo4j.int(9), neo4j.int(7), neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4)));
    expect(neo4j.isLocalDateTime(decoded)).toBe(true);
    expect(neo4j.isDateTime(decoded), "a LocalDateTime must not decode as a zoned DateTime").toBe(false);
    intIs(decoded.year, "2026");
    intIs(decoded.second, "3");
    intIs(decoded.nanosecond, "4");
  });

  it("keeps an offset DateTime as a driver DateTime with its offset", () => {
    const decoded: any = roundtrip(new neo4j.types.DateTime(neo4j.int(2026), neo4j.int(9), neo4j.int(7), neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4), neo4j.int(7200)));
    expect(neo4j.isDateTime(decoded)).toBe(true);
    intIs(decoded.year, "2026");
    intIs(decoded.timeZoneOffsetSeconds, "7200");
    expect(decoded.timeZoneId ?? null).toBeNull();
  });

  it("keeps a ZONE-ID DateTime as a driver DateTime carrying the zone name", () => {
    // The named-zone form is a DIFFERENT construction from the offset form, and the codec has its
    // own branch for it (`f.timeZoneId ?? null`). A zone that decoded as an offset would be a real
    // data change — the offset is only correct for one instant of the year.
    const decoded: any = roundtrip(new neo4j.types.DateTime(neo4j.int(2026), neo4j.int(9), neo4j.int(7), neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4), undefined, "Europe/Berlin"));
    expect(neo4j.isDateTime(decoded)).toBe(true);
    expect(decoded.timeZoneId).toBe("Europe/Berlin");
    intIs(decoded.day, "7");
  });

  it("keeps a Duration as a driver Duration with all four components", () => {
    const decoded: any = roundtrip(new neo4j.types.Duration(neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4)));
    expect(neo4j.isDuration(decoded)).toBe(true);
    intIs(decoded.months, "1");
    intIs(decoded.days, "2");
    intIs(decoded.seconds, "3");
    intIs(decoded.nanoseconds, "4");
  });

  it("keeps a 2D Point as a driver Point with no z", () => {
    const decoded: any = roundtrip(new neo4j.types.Point(neo4j.int(4326), 10.25, -20.5));
    expect(neo4j.isPoint(decoded)).toBe(true);
    intIs(decoded.srid, "4326");
    expect(decoded.x).toBe(10.25);
    expect(decoded.y).toBe(-20.5);
    expect(decoded.z).toBeUndefined();
  });

  it("keeps a 3D Point as a driver Point WITH z", () => {
    // A 3D point that decoded as 2D loses a coordinate and still passes `isPoint`.
    const decoded: any = roundtrip(new neo4j.types.Point(neo4j.int(9157), 1.5, 2.5, 3.5));
    expect(neo4j.isPoint(decoded)).toBe(true);
    intIs(decoded.srid, "9157");
    expect(decoded.z).toBe(3.5);
  });

  it("keeps bytes as a Buffer with identical content", () => {
    const value = Buffer.from([0, 1, 254, 255]);
    const decoded = roundtrip(value) as Buffer;
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.equals(value)).toBe(true);
    expect([...decoded]).toEqual([0, 1, 254, 255]);
    // A NEW buffer, not the same reference — the codec must not alias the caller's memory into the
    // decoded graph, or a later mutation of one would silently change the other.
    expect(decoded).not.toBe(value);
  });

  it("preserves driver values nested inside plain objects and arrays", () => {
    const decoded: any = roundtrip({
      label: "acme",
      counts: [neo4j.int("9007199254740993"), null, 2.5],
      when: { at: new neo4j.types.Date(neo4j.int(2026), neo4j.int(1), neo4j.int(31)) },
    });
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded.label).toBe("acme");
    intIs(decoded.counts[0], "9007199254740993");
    expect(decoded.counts[1]).toBeNull();
    expect(decoded.counts[2]).toBe(2.5);
    expect(neo4j.isDate(decoded.when.at)).toBe(true);
    intIs(decoded.when.at.day, "31");
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("refuses %s rather than writing a value Neo4j cannot hold", (_label, value) => {
    expect(() => encodeNeo4jValue(value)).toThrow(/unsupported non-finite/i);
  });

  it("refuses a non-finite number nested inside a supported container", () => {
    // The refusal must not be reachable only at the top level: one bad leaf in a property map is
    // exactly how a silent coercion would get in.
    expect(() => encodeNeo4jValue({ ok: 1, bad: Number.NaN })).toThrow(/unsupported non-finite/i);
    expect(() => encodeNeo4jValue([1, [Number.POSITIVE_INFINITY]])).toThrow(/unsupported non-finite/i);
  });

  it("rejects unsupported values rather than silently coercing them", () => {
    expect(() => encodeNeo4jValue(new Map())).toThrow(/unsupported/i);
    expect(() => encodeNeo4jValue(Symbol("x"))).toThrow(/unsupported/i);
  });

  it("refuses an unknown codec tag on decode instead of returning a plain object", () => {
    expect(() => decodeNeo4jValue({ $neo4j: "NotAType", fields: {} })).toThrow(/unsupported Neo4j codec tag/i);
  });
});
