import { describe, it, expect } from "vitest";
import { dialogueComposer, type Evidence } from "../src/dialogue/compose.js";
import { categories, validateDialogue } from "../src/dialogue/validate.js";
import type { Source } from "../src/input/markdown.js";
const evidence: Evidence = {
  summary: {
    problem: "Slow search",
    proposal: "Use an index",
    rationale: "Reduce latency",
    stages: "Benchmark then implement",
    risks: "Stale index",
    uncertainty: "Unmeasured performance",
    openQuestions: "Encrypted notebooks?",
    nextAction: "Benchmark now",
  },
  facts: categories.map((category, i) => ({
    id: category,
    category,
    claim: category,
    quote: category,
    startLine: i + 1,
    endLine: i + 1,
  })),
};
const source: Source = {
  path: "plan.md",
  text: categories.join("\n"),
  lines: [...categories],
  sha256: "test",
  sections: [],
};
function draft(words = 25) {
  const fields = Object.fromEntries(
    categories.map((category) => [
      category,
      {
        text: Array(words).fill(category).join(" ") + ".",
        factId: category,
        interpretation: false,
      },
    ]),
  );
  return {
    ...fields,
    questions: {
      opening: "Why propose an index for search?",
      details: "What are the index tradeoffs?",
      uncertainty: "What remains unknown about performance?",
      recap: "What should listeners take away?",
    },
    recap: {
      text: Array(words).fill("proposal").join(" ") + ".",
      factId: "proposal",
      interpretation: false,
    },
  };
}
describe("required spoken topic composition", () => {
  it("always places a cited next action in the final spoken turn", () => {
    const composer = dialogueComposer(evidence, 280);
    const result = validateDialogue(composer.compose(draft()), source);
    expect(result.turns).toHaveLength(8);
    expect(result.turns.at(-1)?.text).toContain("nextAction");
    expect(result.turns.at(-1)?.factIds).toContain("nextAction");
    for (const category of categories)
      expect(
        result.turns.some(
          (t) => t.speaker === "HOST_B" && t.factIds.includes(category),
        ),
      ).toBe(true);
  });
  it("rejects omitted nextAction rather than attaching a citation to unrelated text", () => {
    const { nextAction: omitted, ...missing } = draft() as Record<
      string,
      unknown
    >;
    expect(omitted).toBeDefined();
    expect(() => dialogueComposer(evidence, 280).compose(missing)).toThrow();
  });
  it("rejects a nextAction passage citing a different category", () => {
    const invalid = {
      ...draft(),
      nextAction: {
        text: Array(27).fill("nextAction").join(" ") + ".",
        factId: "proposal",
        interpretation: false,
      },
    };
    expect(() => dialogueComposer(evidence, 280).compose(invalid)).toThrow();
  });
  it("rejects whitespace-only nextAction even with a valid reference", () => {
    const invalid = {
      ...draft(),
      nextAction: { text: "  ", factId: "nextAction", interpretation: false },
    };
    expect(() => dialogueComposer(evidence, 280).compose(invalid)).toThrow();
  });
  it("requires every present category, not only nextAction", () => {
    for (const category of categories) {
      const invalid: Record<string, unknown> = { ...draft(), [category]: null };
      expect(() => dialogueComposer(evidence, 280).compose(invalid)).toThrow();
    }
  });
  it("does not invent a next action when the source has none", () => {
    const partial = {
      ...evidence,
      summary: { ...evidence.summary, nextAction: "" },
      facts: evidence.facts.filter((f) => f.category !== "nextAction"),
    };
    const result = dialogueComposer(partial, 280).compose({
      ...draft(29),
      nextAction: null,
    });
    expect(result.turns.at(-2)?.text).toBe("What should listeners take away?");
    expect(result.turns.at(-1)?.factIds).not.toContain("nextAction");
  });
});

it("rejects overlong passage text through the response schema", () => {
  const invalid = {
    ...draft(),
    nextAction: {
      text: Array(60).fill("word").join(" ") + ".",
      factId: "nextAction",
      interpretation: false,
    },
  };
  expect(() => dialogueComposer(evidence, 280).compose(invalid)).toThrow(
    /word limit/,
  );
});

it("rejects missing and overlong host questions before speech", () => {
  const original = draft();
  for (const opening of [
    null,
    "",
    "Why?",
    Array(13).fill("word").join(" ") + "?",
  ]) {
    expect(() =>
      dialogueComposer(evidence, 280).compose({
        ...original,
        questions: { ...original.questions, opening },
      }),
    ).toThrow();
  }
});

it("keeps passage constraints feasible at the smallest correction budget", () => {
  const composer = dialogueComposer(evidence, 180);
  expect(composer.schema.safeParse(draft(13)).success).toBe(true);
});
