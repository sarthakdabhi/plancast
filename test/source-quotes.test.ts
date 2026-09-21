import { describe, it, expect } from "vitest";
import { sourceQuoteResolver } from "../src/dialogue/source-quotes.js";
import { readSource, type Source } from "../src/input/markdown.js";
function source(text: string): Source {
  return {
    path: "test.md",
    text,
    lines: text.split("\n"),
    sha256: "test",
    sections: [],
  };
}
describe("source quotation resolution", () => {
  it("repairs wrong model line numbers using a unique exact passage", () => {
    expect(
      sourceQuoteResolver(source("# Plan\n\nDo not upload notes.\n"))(
        "Do not upload notes.",
        1,
        1,
      ),
    ).toEqual({ quote: "Do not upload notes.", startLine: 3, endLine: 3 });
  });
  it("repairs out-of-range model references without trusting them", () => {
    expect(
      sourceQuoteResolver(source("First\nGrounded fact\nLast"))(
        "Grounded fact",
        500,
        600,
      ),
    ).toMatchObject({ startLine: 2, endLine: 2 });
  });
  it("normalizes whitespace and restores the exact original quotation and lines", () => {
    const text = "# Plan\n\nKeep  notes\n\tlocal.\n";
    expect(
      sourceQuoteResolver(source(text))("Keep notes local.", 3, 4),
    ).toEqual({ quote: "Keep  notes\n\tlocal.", startLine: 3, endLine: 4 });
  });
  it("combines whitespace differences and incorrect line hints", () => {
    expect(
      sourceQuoteResolver(source("# Plan\n\nKeep  notes\n\tlocal.\n"))(
        "Keep notes local.",
        1,
        1,
      ),
    ).toMatchObject({ startLine: 3, endLine: 4 });
  });
  it("preserves Unicode offsets and blank lines", () => {
    expect(
      sourceQuoteResolver(source("🎧 Intro\n\nDécision:  café\n\nnext"))(
        "Décision: café",
        1,
        1,
      ),
    ).toEqual({ quote: "Décision:  café", startLine: 3, endLine: 3 });
  });
  it("disambiguates repeated text using correct line hints", () => {
    expect(
      sourceQuoteResolver(source("Repeated fact\nother\nRepeated fact"))(
        "Repeated fact",
        3,
        3,
      ),
    ).toMatchObject({ startLine: 3, endLine: 3 });
  });
  it("rejects repeated quotations when the hints do not disambiguate them", () => {
    expect(() =>
      sourceQuoteResolver(source("Repeated fact\nother\nRepeated fact"))(
        "Repeated fact",
        2,
        2,
      ),
    ).toThrow(/ambiguous/);
  });
  it.each([
    "Upload notes.",
    "Keep notes in the cloud.",
    "Keep notes locally.",
    "Keep notes...local.",
    "keep notes local.",
  ])("rejects altered wording: %s", (quote) => {
    expect(() =>
      sourceQuoteResolver(source("Keep notes local."))(quote, 1, 1),
    ).toThrow();
  });
  it("does not erase punctuation, negation, numbers or word boundaries", () => {
    for (const [text, quote] of [
      ["Do not upload notes.", "Do upload notes."],
      ["Retry twice.", "Retry three times."],
      ["Use note books.", "Use notebooks."],
    ])
      expect(() => sourceQuoteResolver(source(text!))(quote!, 1, 1)).toThrow();
  });
  it("rejects empty and all-whitespace quotations", () => {
    expect(() => sourceQuoteResolver(source("Plan"))(" \n ", 1, 1)).toThrow();
  });
  it("resolves a multi-line quotation from the actual long PRD", async () => {
    const plan = await readSource(
      "prd_outputs/Plancast CLI/plancast_cli_PRD.md",
    );
    const start = plan.lines.findIndex((line) =>
      line.includes("## 5. Product Principles"),
    );
    const quote = plan.lines
      .slice(start, start + 5)
      .join("\n")
      .replace(/\s+/g, " ");
    const result = sourceQuoteResolver(plan)(quote, 1, 2);
    expect(result.startLine).toBe(start + 1);
    expect(
      plan.lines.slice(result.startLine - 1, result.endLine).join("\n"),
    ).toContain(result.quote);
  });
});

it("resolves all four quotations rejected in the captured PRD reproduction", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readSource(
    "prd_outputs/Plancast CLI/plancast_cli_PRD.md",
  );
  const quotes = JSON.parse(
    await readFile("test/fixtures/prd-quotation-regression.json", "utf8"),
  ) as { quote: string; startLine: number; endLine: number }[];
  const resolve = sourceQuoteResolver(source);
  for (const fact of quotes) {
    expect(
      source.lines.slice(fact.startLine - 1, fact.endLine).join("\n"),
    ).not.toContain(fact.quote);
    const result = resolve(fact.quote, fact.startLine, fact.endLine);
    expect(
      source.lines.slice(result.startLine - 1, result.endLine).join("\n"),
    ).toContain(result.quote);
    expect(result.quote.replace(/\*\*/g, "").replace(/\s+/g, " ").trim()).toBe(
      fact.quote.replace(/\*\*/g, "").replace(/\s+/g, " ").trim(),
    );
  }
});

it("matches displayed emphasis while restoring the exact source bytes", () => {
  const text = "**Risk:** Keep **all** notes local.\n*Next action:* Test.";
  const result = sourceQuoteResolver(source(text))(
    "Risk: Keep all notes local. Next action: Test.",
    1,
    2,
  );
  expect(result.quote).toBe(
    "Risk:** Keep **all** notes local.\n*Next action:* Test.",
  );
  expect(result).toMatchObject({ startLine: 1, endLine: 2 });
});
it("preserves literal Markdown inside fenced or inline code and strikethrough", () => {
  for (const text of [
    "`Keep **all** notes local.`",
    "```\nKeep **all** notes local.\n```",
    "Keep ~~all~~ notes local.",
  ])
    expect(() =>
      sourceQuoteResolver(source(text))("Keep all notes local.", 1, 3),
    ).toThrow();
});
it("does not combine separate source passages after ignoring formatting", () => {
  expect(() =>
    sourceQuoteResolver(
      source("**First** step.\nDo not skip this.\n**Last** step."),
    )("First step. Last step.", 1, 3),
  ).toThrow();
});
