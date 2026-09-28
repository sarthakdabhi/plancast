import { expect, it } from "vitest";
import { speechSegments } from "../src/audio/segments.js";
it("keeps long speech requests bounded without losing or rearranging words", () => {
  const sentences = Array.from(
    { length: 35 },
    (_, i) =>
      `Sentence ${i} explains this particular part of the source and preserves its caveat.`,
  );
  const text = sentences.join(" ");
  const segments = speechSegments(text);
  expect(segments.length).toBeGreaterThan(2);
  expect(segments.join(" ")).toBe(text);
  for (const segment of segments) {
    expect(segment.split(/\s+/).length).toBeLessThanOrEqual(180);
    expect(segment.length).toBeLessThanOrEqual(2400);
    expect(segment).toMatch(/\.$/);
  }
});
it("bounds unpunctuated text and preserves short turns", () => {
  const text = Array.from({ length: 400 }, (_, i) => `item${i}`).join(" ");
  expect(speechSegments(text).join(" ")).toBe(text);
  expect(speechSegments("A short question?")).toEqual(["A short question?"]);
});
it("rejects an oversized unbroken token instead of splitting its meaning", () => {
  expect(() => speechSegments("x".repeat(2401))).toThrow(/token is too long/);
});
