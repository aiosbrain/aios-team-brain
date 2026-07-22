import "server-only";
import { canonicalSha256, type CanonicalJson } from "./canonical";

export const GATEWAY_TOOLS = [
  "github.repository.get",
  "github.contents.get",
  "github.issues.list",
  "github.issue.get",
  "github.pull_requests.list",
  "github.pull_request.get",
  "github.pull_request.files.list",
] as const;
export type GatewayTool = (typeof GATEWAY_TOOLS)[number];
export type NormalizedArgs = Record<string, string | number>;

export class GatewayArgumentError extends Error {
  readonly code = "gateway_invalid_arguments";
  constructor() {
    super("Invalid gateway arguments");
  }
}

const ASCII_EDGE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const CONTROL = /[\u0000-\u001f\u007f]/;
const fail = (): never => {
  throw new GatewayArgumentError();
};
const plain = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  return value as Record<string, unknown>;
};
const exact = (obj: Record<string, unknown>, fields: readonly string[]) => {
  if (Object.keys(obj).some((key) => !fields.includes(key))) fail();
};
const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(ASCII_EDGE, "") : fail();
const owner = (value: unknown): string => {
  const v = text(value);
  if (
    v.length < 1 ||
    v.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(v) ||
    v.includes("--")
  )
    fail();
  return v;
};
const repo = (value: unknown): string => {
  const v = text(value);
  const length = [...v].length;
  if (
    length < 1 ||
    length > 100 ||
    CONTROL.test(v) ||
    /[\\/]/.test(v) ||
    /^\.+$/.test(v)
  )
    fail();
  return v;
};
const pathValue = (value: unknown): string => {
  const v = text(value);
  if (
    Buffer.byteLength(v, "utf8") > 1024 ||
    v.includes("\0") ||
    v.includes("\\") ||
    v.startsWith("/") ||
    v.split("/").some((s) => s === "." || s === "..")
  )
    fail();
  return v;
};
const refValue = (value: unknown): string => {
  const v = text(value);
  if (!v || Buffer.byteLength(v, "utf8") > 255 || CONTROL.test(v)) fail();
  return v;
};
const integer = (
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail();
  return value as number;
};
const listFields = ["owner", "repo", "state", "page", "perPage"] as const;
const list = (obj: Record<string, unknown>) => ({
  owner: owner(obj.owner),
  repo: repo(obj.repo),
  state:
    obj.state === undefined
      ? "open"
      : ["open", "closed", "all"].includes(text(obj.state))
        ? text(obj.state)
        : fail(),
  page: obj.page === undefined ? 1 : integer(obj.page, 1, 10_000),
  perPage: obj.perPage === undefined ? 30 : integer(obj.perPage, 1, 100),
});

export function normalizeGatewayArgs(
  tool: string,
  input: unknown,
): NormalizedArgs {
  const obj = plain(input);
  switch (tool as GatewayTool) {
    case "github.repository.get":
      exact(obj, ["owner", "repo"]);
      return { owner: owner(obj.owner), repo: repo(obj.repo) };
    case "github.contents.get":
      exact(obj, ["owner", "repo", "path", "ref"]);
      return {
        owner: owner(obj.owner),
        repo: repo(obj.repo),
        path: pathValue(obj.path),
        ref: refValue(obj.ref),
      };
    case "github.issues.list":
    case "github.pull_requests.list":
      exact(obj, listFields);
      return list(obj);
    case "github.issue.get":
      exact(obj, ["owner", "repo", "issueNumber"]);
      return {
        owner: owner(obj.owner),
        repo: repo(obj.repo),
        issueNumber: integer(obj.issueNumber, 1),
      };
    case "github.pull_request.get":
      exact(obj, ["owner", "repo", "pullNumber"]);
      return {
        owner: owner(obj.owner),
        repo: repo(obj.repo),
        pullNumber: integer(obj.pullNumber, 1),
      };
    case "github.pull_request.files.list":
      exact(obj, ["owner", "repo", "pullNumber", "page", "perPage"]);
      return {
        owner: owner(obj.owner),
        repo: repo(obj.repo),
        pullNumber: integer(obj.pullNumber, 1),
        page: obj.page === undefined ? 1 : integer(obj.page, 1, 10_000),
        perPage: obj.perPage === undefined ? 30 : integer(obj.perPage, 1, 100),
      };
    default:
      return fail();
  }
}

export function gatewayRequestHash(args: NormalizedArgs): string {
  return canonicalSha256(args as CanonicalJson);
}
