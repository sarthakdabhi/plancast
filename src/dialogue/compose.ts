import { z } from "zod";
import type { Framing } from "../providers/contracts.js";
import { type Dialogue, type categories } from "./validate.js";
import { PlancastError } from "../domain/errors.js";
type Category = (typeof categories)[number];
export type Evidence = Pick<Dialogue, "summary" | "facts">;

// Required named passages encode coverage in the response contract. Citations
// must be selected from the facts for that specific topic, not added afterward.
export function dialogueComposer(
  evidence: Evidence,
  targetWords: number,
  strictPassageLengths = true,
  framing: Framing = "auto",
) {
  type PassageKey = Category | "recap";
  const groups: {
    id: "opening" | "details" | "uncertainty" | "recap";
    keys: PassageKey[];
  }[] = [
    { id: "opening", keys: ["problem", "proposal", "rationale"] },
    { id: "details", keys: ["stages", "risks"] },
    { id: "uncertainty", keys: ["uncertainty", "openQuestions"] },
    { id: "recap", keys: ["recap", "nextAction"] },
  ];
  const activeGroups = groups.filter((group) =>
    group.keys.some((key) => key === "recap" || evidence.summary[key].trim()),
  );
  const presentCount =
    Object.values(evidence.summary).filter((value) => value.trim()).length + 1;
  // Reserve the maximum question length so tailored questions fit the total budget.
  const questionWords = activeGroups.length * 12;
  const passageWords = Math.min(
    Math.floor((targetWords - questionWords) / presentCount),
    Math.floor(
      (Math.floor(targetWords * 1.15) - questionWords - 4 * presentCount) /
        presentCount,
    ),
  );
  const minWords = Math.min(
    passageWords,
    Math.max(
      1,
      Math.ceil(
        (Math.ceil(targetWords * 0.85) - activeGroups.length * 4) /
          presentCount,
      ),
    ),
  );
  const passage = (ids: string[]) =>
    z
      .object({
        text: (strictPassageLengths
          ? z
              .string()
              .regex(
                new RegExp(
                  `^\\S+(?: \\S+){${minWords - 1},${passageWords - 1}}[.!?]$`,
                ),
              )
          : z.string().min(1)
        ).describe(
          `Write ${minWords} to ${passageWords} space-separated words in a complete grammatical sentence ending with punctuation.`,
        ),
        factId: z.enum(ids),
        interpretation: z.boolean(),
      })
      .strict();
  const slot = (category: Category) => {
    if (!evidence.summary[category].trim()) return z.null();
    const ids = evidence.facts
      .filter((f) => f.category === category)
      .map((f) => f.id);
    if (!ids.length)
      throw new PlancastError(
        "DIALOGUE_GROUNDING",
        `Missing source evidence for ${category}.`,
        4,
      );
    return passage(ids);
  };
  const allIds = evidence.facts.map((f) => f.id);
  if (!allIds.length)
    throw new PlancastError(
      "DIALOGUE_GROUNDING",
      "No source evidence is available.",
      4,
    );
  const question = (id: (typeof groups)[number]["id"]) =>
    activeGroups.some((group) => group.id === id)
      ? z
          .string()
          .regex(/^[^ \t\r\n"\\]+( [^ \t\r\n"\\]+){3,11}\?$/)
          .describe(
            "One source-grounded question, 4–12 space-separated words, ending with a question mark.",
          )
      : z.null();
  const schema = z
    .object({
      questions: z
        .object({
          opening: question("opening"),
          details: question("details"),
          uncertainty: question("uncertainty"),
          recap: question("recap"),
        })
        .strict(),
      problem: slot("problem"),
      proposal: slot("proposal"),
      rationale: slot("rationale"),
      stages: slot("stages"),
      risks: slot("risks"),
      uncertainty: slot("uncertainty"),
      openQuestions: slot("openQuestions"),
      nextAction: slot("nextAction"),
      recap: passage(allIds),
    })
    .strict();
  const bodyWords = targetWords - questionWords;
  return {
    schema,
    instructions: `Write complete grammatical sentences for each required topic, using only its evidence. Null topics are absent and must stay null. Each passage's factId must support its text; select the strongest matching fact. Never put IDs or citations in text. Keep interpretations explicitly qualified, and use interpretation=false for direct source paraphrases. Write a tailored question for each active group in questions: opening covers topic and main ideas; details covers supported sequence and limitations; uncertainty covers unresolved issues; recap invites the takeaway and any explicit next action. Each question must be 4–12 words and answerable from that group’s evidence. Never smuggle unsupported claims, false premises, or implied recommendations into a question. Use null for inactive groups. These questions and passages will be assembled locally into an alternating two-host dialogue. ALL passage texts combined must total approximately ${bodyWords} words, within 10%; this is one briefing, not that many words per topic. Each non-null passage MUST contain ${minWords}–${passageWords} words; these per-field limits include recap and nextAction. ${framing === "plan" ? "Recap restates the source-supported proposal and rationale." : "Recap restates the central ideas, findings, events, or proposal and supporting evidence."} Only discuss next actions explicitly stated in the source; never invent an action. Summarize at a high level when needed; never begin a list item or sentence you cannot finish within the limit. In stages, summarize the sequence rather than enumerating every phase. Avoid repeated explanations across passages, stage directions and filler. Preserve material risks, exclusions, quantities and uncertainty.`,
    compose(raw: unknown): Dialogue {
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        throw new PlancastError(
          "DIALOGUE_SCHEMA",
          "The dialogue draft violates a required topic, source reference, or passage word limit. No speech was requested.",
          4,
        );
      const draft = parsed.data;
      const turns: Dialogue["turns"] = [];
      for (const group of activeGroups) {
        const passages = group.keys
          .map((key) => draft[key])
          .filter((p) => p !== null);
        if (passages.some((p) => !p.text.trim()))
          throw new PlancastError(
            "DIALOGUE_GROUNDING",
            "A required dialogue topic has empty spoken text. No speech was requested.",
            4,
          );
        const factIds = [...new Set(passages.map((p) => p.factId))];
        turns.push({
          speaker: "HOST_A",
          text: draft.questions[group.id]!,
          factIds,
          interpretation: false,
        });
        turns.push({
          speaker: "HOST_B",
          text: passages
            .map((p) =>
              p.interpretation
                ? `Our interpretation is: ${p.text.trim()}`
                : p.text.trim(),
            )
            .join(" "),
          factIds,
          interpretation: passages.some((p) => p.interpretation),
        });
      }
      return { ...evidence, turns };
    },
  };
}
