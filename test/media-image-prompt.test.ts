import { describe, expect, it } from "vitest";
import { buildImagePrompt, DAILY_IMAGE_CAP } from "@/lib/media/generate-image";

/**
 * Spec for the image prompt + the cap default. Derived from intent: the prompt names the topic and
 * forbids embedded text (platforms overlay their own); the default daily cap is 10 (Chetan).
 */
describe("image generation basics", () => {
  it("prompt includes the title and forbids text in the image", () => {
    const p = buildImagePrompt("Shipped the durable job queue");
    expect(p).toContain("Shipped the durable job queue");
    expect(p.toLowerCase()).toContain("no");
    expect(p.toLowerCase()).toMatch(/text|words|letters/);
  });

  it("defaults the daily image cap to 10", () => {
    expect(DAILY_IMAGE_CAP).toBe(10);
  });
});
