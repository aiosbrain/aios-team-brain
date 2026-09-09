#!/usr/bin/env node
const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
const date = now.slice(0, 8);
const response = await fetch(process.env.PROBE_S3_URL, {
  headers: {
    authorization: `AWS4-HMAC-SHA256 Credential=source-control/${date}/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${"0".repeat(64)}`,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": now,
  },
});
const body = await response.text();
if (response.status !== 403 || !body.includes("AccessDenied")) throw new Error(`forged S3 identity did not receive AccessDenied (${response.status})`);
console.log(JSON.stringify({ status: "verified-forged-signature-denial" }));
