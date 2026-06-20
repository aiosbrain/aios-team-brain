const KEY_RE = /\b(?:AIOS-Work:\s*)?([A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)\b/g;

function cleanKey(key: string): string {
  return key.trim().replace(/[),.;:]+$/, "");
}

export function extractWorkKeys(input: {
  title?: string | null;
  body?: string | null;
  branch?: string | null;
}): string[] {
  const text = [input.title, input.body, input.branch].filter(Boolean).join("\n");
  const keys = new Set<string>();
  for (const match of text.matchAll(KEY_RE)) {
    keys.add(cleanKey(match[1]));
  }
  return [...keys];
}
