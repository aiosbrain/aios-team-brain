/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { decodeNeo4jValue, encodeNeo4jValue } from "../scripts/staging-ops/neo4j-codec.mjs";

describe("Neo4j lossless typed codec", () => {
  it("roundtrips integers beyond JS safe range, temporal, duration, point, bytes and nested arrays", () => {
    const values = [
      neo4j.int("9223372036854775806"),
      new neo4j.types.Date(neo4j.int(2026), neo4j.int(9), neo4j.int(7)),
      new neo4j.types.DateTime(neo4j.int(2026), neo4j.int(9), neo4j.int(7), neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4), neo4j.int(0)),
      new neo4j.types.Duration(neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4)),
      new neo4j.types.Point(neo4j.int(4326), 10.25, -20.5),
      Buffer.from([0, 1, 254, 255]),
      [neo4j.int("9007199254740993"), "x", null],
    ];
    for (const value of values) {
      const decoded = decodeNeo4jValue(encodeNeo4jValue(value));
      if (neo4j.isInt(value)) expect(decoded.toString()).toBe(value.toString());
      else if (Buffer.isBuffer(value)) expect(Buffer.from(decoded)).toEqual(value);
      else if (Array.isArray(value)) expect(decoded.map((v: any) => v?.toString?.() ?? v)).toEqual(value.map((v: any) => v?.toString?.() ?? v));
      else expect(decoded.toString()).toBe(value.toString());
    }
  });

  it("rejects unsupported values rather than silently coercing them", () => {
    expect(() => encodeNeo4jValue(new Map())).toThrow(/unsupported/i);
    expect(() => encodeNeo4jValue(Symbol("x"))).toThrow(/unsupported/i);
  });
});
