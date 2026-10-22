/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The staging object store talks S3 through the real AWS SDK, and every S3 response body it cares
 * about — the list page, the error document — is XML the SDK hands to `fast-xml-parser`. The pinned
 * transitive `fast-xml-parser@4.4.1` carries six advisories, so `package.json` overrides it to the
 * patched 4.5.7 for `@aws-sdk/core`.
 *
 * A dependency bump is only safe if the thing it bumps still parses. These tests therefore drive the
 * REAL `S3Client` and the REAL deserializers over a scripted HTTP transport, so an incompatible
 * parser shows up here as a failed list/read rather than in staging. They assert the properties a
 * parser swap actually breaks: entity decoding, `IsTruncated` as a boolean (not the truthy string
 * "false"), a single repeated element coerced to an array, and the error `<Code>` reaching the
 * thrown error's name.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { S3PrivateStore, canonicalObjectId } from "../scripts/staging-ops/object-store.mjs";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Canned = { statusCode: number; headers?: Record<string, string>; body?: string | Buffer };

/**
 * A real `S3Client` whose only substitution is the HTTP transport: signing, serialization,
 * deserialization and XML parsing are the shipped code paths.
 */
function scriptedS3(responses: Canned[]) {
  const requests: any[] = [];
  const pending = [...responses];
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://object-store.invalid",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      async handle(request: any) {
        requests.push(request);
        const next = pending.shift();
        if (!next) throw new Error(`unscripted S3 request: ${request.method} ${request.path}`);
        return {
          response: {
            statusCode: next.statusCode,
            headers: { "content-type": "application/xml", ...(next.headers ?? {}) },
            body: Readable.from([Buffer.from(next.body ?? "")]),
          },
        };
      },
    },
  } as any);
  return { client, requests, pending };
}

const store = (client: any, role: string) =>
  new S3PrivateStore({ endpoint: "https://object-store.invalid", region: "us-east-1", bucket: "bundles", prefix: "staging", role, client });

const contents = (key: string, etag: string) =>
  `<Contents><Key>${key}</Key><Size>7</Size><ETag>&quot;${etag}&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`;

const listPage = ({ truncated, token, keys, etag = "etag" }: { truncated: boolean; token?: string; keys: string[]; etag?: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bundles</Name>
  <Prefix>staging/</Prefix>
  <KeyCount>${keys.length}</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>${truncated}</IsTruncated>
  ${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}
  ${keys.map((key) => contents(key, etag)).join("\n  ")}
</ListBucketResult>`;

const errorXml = (code: string, message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>${message}</Message><RequestId>REQ-1</RequestId><HostId>HOST-1</HostId></Error>`;

const idFor = (runId: string, payload: string) => canonicalObjectId(runId, sha256(payload));

describe("S3 XML deserialization through the real SDK", () => {
  it("parses a paginated ListObjectsV2 result, including a single-element page", async () => {
    const first = [idFor("run-1", "one"), idFor("run-2", "two")];
    const second = [idFor("run-3", "three")];
    const { client, requests, pending } = scriptedS3([
      // `IsTruncated` must deserialize as a BOOLEAN. Parsed as the string "false" it is truthy, the
      // store asks for a third page, and the transport rejects the unscripted request.
      { statusCode: 200, body: listPage({ truncated: true, token: "PAGE-2", keys: first.map((id) => `staging/${id}.bundle`) }) },
      // One `<Contents>` element: `fast-xml-parser` yields an object, and the SDK is responsible for
      // coercing it to a single-item array. A parser whose shape drifts loses this object entirely.
      { statusCode: 200, body: listPage({ truncated: false, keys: second.map((id) => `staging/${id}.bundle`) }) },
    ]);

    const ids = await store(client, "source-reader").list();

    expect(ids).toEqual([...first, ...second].sort());
    expect(pending).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(String(requests[1].query?.["continuation-token"] ?? "")).toBe("PAGE-2");
  });

  it("decodes XML entities and scalar types in the deserialized list page", async () => {
    const key = `staging/${idFor("run-4", "entity")}.bundle`;
    const { client } = scriptedS3([{ statusCode: 200, body: listPage({ truncated: false, keys: [key], etag: "a&amp;b" }) }]);

    const page = await client.send(new ListObjectsV2Command({ Bucket: "bundles", Prefix: "staging/" }));

    // `&quot;` and the nested `&amp;` must arrive decoded, once. Raw entities here would mean the
    // parser stopped decoding; double-decoded output would mean it decoded twice.
    expect(page.Contents?.[0]?.ETag).toBe('"a&b"');
    expect(page.Contents?.[0]?.Key).toBe(key);
    expect(page.IsTruncated).toBe(false);
    expect(page.KeyCount).toBe(1);
    expect(page.Contents?.[0]?.Size).toBe(7);
  });

  it("returns the exact bytes of a successful GetObject", async () => {
    const payload = "sealed-bundle-bytes";
    const id = idFor("run-5", payload);
    const { client, requests } = scriptedS3([
      { statusCode: 200, headers: { "content-type": "application/octet-stream", etag: '"deadbeef"' }, body: payload },
    ]);

    const bytes = await store(client, "source-reader").read(id);

    expect(bytes.toString("utf8")).toBe(payload);
    expect(requests[0].path).toContain(`staging/${id}.bundle`);
  });

  it("surfaces the S3 error document's <Code> as the thrown error's name", async () => {
    const id = idFor("run-6", "absent");
    const { client } = scriptedS3([{ statusCode: 404, body: errorXml("NoSuchKey", "The specified key does not exist.") }]);

    const error: any = await store(client, "source-reader").read(id).then(() => null, (thrown: any) => thrown);

    // Both of these exist only because the XML body parsed; an unparsed body degrades to a generic
    // status-derived exception carrying neither the code nor the message.
    expect(error?.name).toBe("NoSuchKey");
    expect(String(error?.message)).toContain("The specified key does not exist.");
    expect(error?.$metadata?.httpStatusCode).toBe(404);
  });

  it("treats a PreconditionFailed on the canonical key as a safe re-put, and a digest change as a conflict", async () => {
    const payload = Buffer.from("sealed-bundle-bytes");
    const matching = canonicalObjectId("run-7", sha256(payload));
    const conflicting = canonicalObjectId("run-7", sha256("other bytes entirely"));
    const precondition = { statusCode: 412, body: errorXml("PreconditionFailed", "At least one of the pre-conditions you specified did not hold") };

    const same = scriptedS3([precondition]);
    await expect(store(same.client, "publisher").putImmutable(matching, payload)).resolves.toBe(matching);

    const different = scriptedS3([precondition]);
    await expect(store(different.client, "publisher").putImmutable(conflicting, payload)).rejects.toThrow(/different digest/);
  });
});

describe("fast-xml-parser advisory override", () => {
  const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const PATCHED = [4, 5, 7];

  const atLeast = (version: string, minimum: number[]) => {
    const parts = String(version).split(".").map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < minimum.length; index += 1) {
      if ((parts[index] ?? 0) > minimum[index]) return true;
      if ((parts[index] ?? 0) < minimum[index]) return false;
    }
    return true;
  };

  it("resolves every locked fast-xml-parser to the patched release", () => {
    const installed = Object.entries(lock.packages as Record<string, any>)
      .filter(([location]) => location === "node_modules/fast-xml-parser" || location.endsWith("/node_modules/fast-xml-parser"));

    // Without this the loop below is vacuous: a lock with no fast-xml-parser at all would pass while
    // the dependency the store's XML parsing rides on had silently disappeared.
    expect(installed.length).toBeGreaterThan(0);
    for (const [location, entry] of installed) {
      expect(`${location}@${entry.version}`).not.toContain("@4.4.1");
      expect(atLeast(entry.version, PATCHED), `${location} resolved fast-xml-parser ${entry.version}`).toBe(true);
    }
  });

  it("keeps the override narrowed to @aws-sdk/core", () => {
    expect(manifest.overrides?.["@aws-sdk/core"]?.["fast-xml-parser"]).toBe("4.5.7");
    expect(Object.keys(manifest.overrides ?? {})).toEqual(["@aws-sdk/core"]);
  });
});
