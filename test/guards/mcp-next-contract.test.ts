import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

// Proposed contracts only. These checks do not assert runtime route conformance.
const directory = join(import.meta.dirname, "..", "fixtures", "mcp-next-v1");
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(directory, name), "utf8"));
const manifest = readJson("manifest.json") as {
  version: string;
  status: string;
  files: Record<string, string>;
};
const files = readdirSync(directory)
  .filter((name) => name !== "manifest.json")
  .sort();
const schemas = files.filter((name) => name.endsWith(".schema.json"));
const fixtureFiles = files.filter((name) => name.endsWith("-fixtures.json"));
type Vector = { name: string; schema: string; value: unknown };

describe("proposed MCP next contract companion", () => {
  it("keeps a separate proposed version and a complete content-addressed inventory", () => {
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.status).toBe("proposed");
    expect(Object.keys(manifest.files).sort()).toEqual(files);
    expect(schemas.length).toBeGreaterThan(0);
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(name).toMatch(/^[a-z0-9-]+(?:\.schema)?\.json$/);
      const digest = createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex");
      expect(manifest.files[name], name).toBe(digest);
    }
  });

  it("compiles every schema and checks every positive and negative shape vector", () => {
    const ajv = new Ajv({ allErrors: true, jsonPointers: true });
    for (const name of schemas) ajv.addSchema(readJson(name));
    for (const name of schemas) {
      const schema = readJson(name);
      expect(ajv.getSchema(schema.$id), name).toBeTypeOf("function");
    }
    for (const name of fixtureFiles) {
      const fixture = readJson(name) as {
        version: string;
        valid: Vector[];
        invalid: Vector[];
      };
      expect(fixture.version, name).toBe(manifest.version);
      expect(fixture.valid.length, name).toBeGreaterThan(0);
      expect(fixture.invalid.length, name).toBeGreaterThan(0);
      for (const [key, expected] of [
        ["valid", true],
        ["invalid", false],
      ] as const) {
        for (const vector of fixture[key]) {
          const validate = ajv.getSchema(vector.schema);
          expect(validate, `${name}: ${vector.schema}`).toBeTypeOf("function");
          expect(
            validate!(vector.value),
            `${name}: ${vector.name}: ${JSON.stringify(validate!.errors)}`,
          ).toBe(expected);
        }
      }
    }
  });
});
