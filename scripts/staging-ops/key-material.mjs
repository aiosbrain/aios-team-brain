import { readFileSync } from "node:fs";

/** Resolve a key from an environment secret or a mounted secret file. */
export function keyMaterial(env, name) {
  const inline = env[name];
  if (inline) return inline;
  const filename = env[`${name}_FILE`];
  if (!filename) throw new Error(`${name} or ${name}_FILE is required`);
  return readFileSync(filename, "utf8");
}
