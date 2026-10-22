#!/usr/bin/env node
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({ endpoint: process.env.PROBE_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: process.env.PROBE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.PROBE_S3_SECRET_ACCESS_KEY }, maxAttempts: 1,
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
const command = process.argv[2];
const input = { Bucket: process.env.PROBE_S3_BUCKET, Key: process.env.PROBE_S3_KEY };
const operation = command.endsWith("get") ? () => client.send(new GetObjectCommand(input)) : () => client.send(new PutObjectCommand({ ...input, Body: Buffer.from("probe") }));
if (command === "get" || command === "put") {
  const response = await operation();
  if (command === "get") await response.Body.transformToByteArray();
  console.log(JSON.stringify({ status: "authorized", operation: command }));
} else if (command === "expect-access-denied-get" || command === "expect-access-denied-put") {
  try { await operation(); throw new Error("forbidden object operation unexpectedly succeeded"); }
  catch (error) {
    if (error?.$metadata?.httpStatusCode !== 403 || error?.name !== "AccessDenied") throw error;
    console.log(JSON.stringify({ status: "verified-access-denied", operation: command.endsWith("get") ? "get" : "put" }));
  }
} else throw new Error("probe command must be get, put, expect-access-denied-get, or expect-access-denied-put");
