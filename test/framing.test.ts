import { expect, it } from "vitest";
import {
  groundedDialogue,
  type JsonRequester,
} from "../src/providers/grounded.js";
import { normalizedSource } from "../src/input/markdown.js";
import type { Framing } from "../src/providers/contracts.js";

async function brief(
  kind: "markdown" | "text" | "pdf" | "article",
  framing: Framing = "auto",
  plan = false,
) {
  const prompts: string[] = [];
  const source = normalizedSource(
    plan
      ? "Search is slow.\nAdd an index.\nNext step: benchmark the prototype."
      : "A pilot studied summaries.\nThe authors found better recall.\nThe sample was small.",
    "source",
    { kind },
  );
  const request: JsonRequester = async (schema, name, instructions) => {
    prompts.push(instructions);
    if (name === "plancast_evidence") {
      const evidence = (summary: string, sourceLineId: string) => ({
        summary,
        facts: [{ claim: summary, sourceLineId }],
      });
      return schema.parse({
        problem: evidence(plan ? "Slow search" : "Summary pilot", "L1"),
        proposal: evidence(plan ? "Add an index" : "Improved recall", "L2"),
        rationale: null,
        stages: null,
        risks: null,
        uncertainty: null,
        openQuestions: null,
        nextAction: plan ? evidence("Benchmark the prototype", "L3") : null,
      });
    }
    const passage = (factId: string, text: string) => ({
      text,
      factId,
      interpretation: false,
    });
    return schema.parse({
      questions: {
        opening: plan
          ? "Why add an index to search?"
          : "What did the summary pilot find?",
        details: null,
        uncertainty: null,
        recap: plan
          ? "What is the next benchmark step?"
          : "What should listeners take away?",
      },
      problem: passage(
        "problem_1",
        plan ? "Search is slow." : "A pilot studied summaries.",
      ),
      proposal: passage(
        "proposal_1",
        plan ? "Add an index." : "The authors found better recall.",
      ),
      rationale: null,
      stages: null,
      risks: null,
      uncertainty: null,
      openQuestions: null,
      nextAction: plan
        ? passage("nextAction_1", "Benchmark the prototype.")
        : null,
      recap: passage(
        "proposal_1",
        plan ? "Try an index." : "The authors reported improved recall.",
      ),
    });
  };
  return {
    dialogue: await groundedDialogue(
      {
        source,
        framing,
        targetWords: 280,
        signal: new AbortController().signal,
      },
      request,
      false,
    ),
    prompts,
  };
}

it("uses identical content-based prompts for Markdown, text, PDF, and URLs", async () => {
  const md = await brief("markdown");
  for (const kind of ["text", "pdf", "article"] as const) {
    const other = await brief(kind);
    expect(other).toEqual(md);
  }
  expect(md.prompts[0]).not.toContain("plan summary");
  expect(md.prompts[0]).toContain("File format does not determine");
  expect(md.prompts[0]).toContain(
    "Only populate nextAction if the source explicitly",
  );
  expect(md.dialogue.summary.nextAction).toBe("");
  expect(md.dialogue.turns[0]!.text).toBe("What did the summary pilot find?");
});
it("preserves explicit pending actions in a plain-text plan", async () => {
  const { dialogue } = await brief("text", "auto", true);
  expect(dialogue.turns.at(-1)!.text).toContain("Benchmark the prototype.");
  expect(dialogue.turns.at(-1)!.factIds).toContain("nextAction_1");
});
it.each(["plan", "document"] as const)(
  "honors %s framing without allowing invented facts",
  async (framing) => {
    const { prompts, dialogue } = await brief("markdown", framing);
    for (const prompt of prompts)
      expect(prompt).toContain(`The user selected ${framing} framing`);
    expect(prompts[0]).toContain("Never invent a problem");
    expect(prompts[1]).toContain("source-supported facts");
    expect(dialogue.summary.nextAction).toBe("");
  },
);
