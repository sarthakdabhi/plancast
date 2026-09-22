import { z } from "zod";
import { type Dialogue, type categories, wordCount } from "./validate.js";
import { PlancastError } from "../domain/errors.js";
type Category = (typeof categories)[number];
export type Evidence = Pick<Dialogue, "summary" | "facts">;

// Required named passages encode coverage in the response contract. Citations
// must be selected from the facts for that specific topic, not added afterward.
export function dialogueComposer(
  evidence: Evidence,
  targetWords: number,
  strictPassageLengths = true,
  document = false,
) {
  const opening = document
    ? "What is this about, and what does the source say?"
    : "What's the problem, and what's proposed?";
  const details = document
    ? "What happens, and what are the limitations?"
    : "How will it work, and what could go wrong?";
  const presentCount =
    Object.values(evidence.summary).filter((value) => value.trim()).length + 1;
  const questionWords =
    wordCount(opening) +
    (evidence.summary.stages.trim() || evidence.summary.risks.trim()
      ? wordCount(details)
      : 0) +
    (evidence.summary.uncertainty.trim() ||
    evidence.summary.openQuestions.trim()
      ? wordCount("What remains uncertain?")
      : 0) +
    wordCount(
      evidence.summary.nextAction.trim()
        ? "What's the takeaway and the next action?"
        : "What's the takeaway?",
    );
  const passageWords = Math.min(
    Math.floor((targetWords - questionWords) / presentCount),
    Math.floor(
      (Math.floor(targetWords * 1.15) - questionWords - 4 * presentCount) /
        presentCount,
    ),
  );
  const minWords = Math.max(
    1,
    Math.ceil((Math.ceil(targetWords * 0.85) - questionWords) / presentCount),
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
  const schema = z
    .object({
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
  type Draft = z.infer<typeof schema>;
  const groups: { question: string; keys: (keyof Draft)[] }[] = [
    {
      question: opening,
      keys: ["problem", "proposal", "rationale"],
    },
    {
      question: details,
      keys: ["stages", "risks"],
    },
    {
      question: "What remains uncertain?",
      keys: ["uncertainty", "openQuestions"],
    },
    {
      question: evidence.summary.nextAction.trim()
        ? "What's the takeaway and the next action?"
        : "What's the takeaway?",
      keys: ["recap", "nextAction"],
    },
  ];
  const activeGroups = groups.filter((group) =>
    group.keys.some((key) => key === "recap" || evidence.summary[key].trim()),
  );
  const bodyWords =
    targetWords - activeGroups.reduce((n, g) => n + wordCount(g.question), 0);
  return {
    schema,
    instructions: `Write complete grammatical sentences for each required topic, using only its evidence. Null topics are absent and must stay null. Each passage's factId must support its text; select the strongest matching fact. Never put IDs or citations in text. Keep interpretations explicitly qualified, and use interpretation=false for direct source paraphrases. The passages will be assembled locally into a two-host dialogue with fixed short questions. ALL passage texts combined must total approximately ${bodyWords} words, within 10%; this is one briefing, not that many words per topic. Each non-null passage MUST contain ${minWords}–${passageWords} words; these per-field limits include recap and nextAction. ${document ? "Recap restates the central argument and evidence. Only discuss next actions explicitly recommended by the source; never invent an action for an article." : "Recap restates the proposal and rationale briefly. Put the concrete immediate next action in nextAction."} Summarize at a high level when needed; never begin a list item or sentence you cannot finish within the limit. In stages, summarize the sequence rather than enumerating every phase. Avoid repeated explanations across passages, stage directions and filler. Preserve material risks, exclusions, quantities and uncertainty.`,
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
          text: group.question,
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
