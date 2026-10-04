import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/staging-build-metadata/route";
import { stagingBuildMetadataResponse } from "@/lib/staging/build-metadata";
import { migrationSetIdentity } from "@/scripts/staging-ops/build-identity.mjs";

// AIO-1208 AC-04: the route-auth inventory registers `stagingBuildMetadataResponse` as this
// route's guard. Registration is a trust decision, not proof — this pins the owner's actual
// protocol: an independent service token gates the metadata, and a refusal carries none of it.

const TOKEN = "m".repeat(40);
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ENDPOINT = "http://brain/api/internal/staging-build-metadata";

const request = (token?: string) =>
  new Request(ENDPOINT, token === undefined ? {} : { headers: { "x-aios-build-metadata-token": token } });
const env = (over: Record<string, string | undefined> = {}) =>
  ({ SOURCE_BUILD_METADATA_TOKEN: TOKEN, RAILWAY_GIT_COMMIT_SHA: COMMIT, ...over }) as NodeJS.ProcessEnv;

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ ok: false });
  expect(text).not.toContain(COMMIT);
  expect(text).not.toContain("migrationSet");
}

describe("staging build metadata owner protocol", () => {
  it("refuses an absent token with 401 and no metadata", async () => {
    await expectRefused(stagingBuildMetadataResponse(request(), env()));
  });

  it.each([
    ["a wrong token of the same length", "x".repeat(40)],
    ["a prefix of the real token", TOKEN.slice(0, 39)],
    ["the real token with a suffix", `${TOKEN}m`],
    ["an empty token", ""],
  ])("refuses %s with 401 and no metadata", async (_name, presented) => {
    await expectRefused(stagingBuildMetadataResponse(request(presented), env()));
  });

  it("refuses every caller when the deployment has no token, or only a weak one", async () => {
    await expectRefused(stagingBuildMetadataResponse(request(TOKEN), env({ SOURCE_BUILD_METADATA_TOKEN: undefined })));
    await expectRefused(stagingBuildMetadataResponse(request("undefined"), env({ SOURCE_BUILD_METADATA_TOKEN: undefined })));
    const weak = "w".repeat(31);
    await expectRefused(stagingBuildMetadataResponse(request(weak), env({ SOURCE_BUILD_METADATA_TOKEN: weak })));
  });

  it("returns the commit and migration-set identity to the valid token, uncached", async () => {
    const response = stagingBuildMetadataResponse(request(TOKEN), env());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ commit: COMMIT, migrationSet: migrationSetIdentity() });
  });

  it("authenticates before it reports a missing commit — the token is checked first", async () => {
    const noCommit = { RAILWAY_GIT_COMMIT_SHA: "not-a-sha" };
    await expectRefused(stagingBuildMetadataResponse(request("x".repeat(40)), env(noCommit)));
    const response = stagingBuildMetadataResponse(request(TOKEN), env(noCommit));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});

describe("GET /api/internal/staging-build-metadata", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the owner's verdict: anonymous and wrong-token 401, valid token 200", async () => {
    vi.stubEnv("SOURCE_BUILD_METADATA_TOKEN", TOKEN);
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", COMMIT);
    await expectRefused(GET(request()));
    await expectRefused(GET(request("x".repeat(40))));
    const admitted = GET(request(TOKEN));
    expect(admitted.status).toBe(200);
    expect((await admitted.json()).commit).toBe(COMMIT);
  });
});
