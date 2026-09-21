import { z } from "zod";
import { sourceQuoteResolver } from "./source-quotes.js";
import type { Source } from "../input/markdown.js";
import { PlancastError } from "../domain/errors.js";
export const categories = [
  "problem",
  "proposal",
  "rationale",
  "stages",
  "risks",
  "uncertainty",
  "openQuestions",
  "nextAction",
] as const;
const fact = z
  .object({
    id: z.string(),
    category: z.enum(categories),
    claim: z.string(),
    quote: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
  })
  .strict();
export const dialogueSchema = z
  .object({
    summary: z
      .object({
        problem: z.string(),
        proposal: z.string(),
        rationale: z.string(),
        stages: z.string(),
        risks: z.string(),
        uncertainty: z.string(),
        openQuestions: z.string(),
        nextAction: z.string(),
      })
      .strict(),
    facts: z.array(fact),
    turns: z
      .array(
        z
          .object({
            speaker: z.enum(["HOST_A", "HOST_B"]),
            text: z.string(),
            factIds: z.array(z.string()),
            interpretation: z.boolean(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type Dialogue = z.infer<typeof dialogueSchema>;
export const wordCount = (text: string) =>
  text.trim().split(/\s+/u).filter(Boolean).length;
export function validateDialogue(
  raw: unknown,
  source: Source,
  targetWords = 280,
): Dialogue {
  const parsed = dialogueSchema.safeParse(raw);
  if (!parsed.success)
    throw new PlancastError(
      "DIALOGUE_SCHEMA",
      "Script provider returned an invalid structure. No speech was requested.",
      4,
    );
  const d = parsed.data;
  const fail = (message: string): never => {
    throw new PlancastError("DIALOGUE_GROUNDING", message, 4);
  };
  if (
    d.turns.length < 4 ||
    d.turns.length > 8 ||
    new Set(d.turns.map((t) => t.speaker)).size !== 2
  )
    fail("Script must contain both hosts and 4–8 turns.");
  const ids = new Set<string>();
  const resolveQuote = sourceQuoteResolver(source);
  for (const f of d.facts) {
    if (!f.id.trim() || ids.has(f.id) || !f.claim.trim() || !f.quote.trim())
      fail("Script has invalid source references.");
    Object.assign(f, resolveQuote(f.quote, f.startLine, f.endLine));
    ids.add(f.id);
  }
  for (const t of d.turns) {
    // Fact IDs belong in metadata, never in the spoken script. Strip only
    // citations that are already present in this turn's validated references.
    t.text = t.text
      .replace(/\[([^\]]+)\]/g, (citation, id: string) =>
        ids.has(id) && t.factIds.includes(id) ? "" : citation,
      )
      .replace(/ {2,}/g, " ")
      .trim();
    if (
      !t.text.trim() ||
      t.text.length > 4000 ||
      /[\u0000-\u001f]|HOST_[AB]:|\[[^\]]+\]|<[^>]+>/.test(t.text)
    )
      fail("Script contains empty text, control text, or stage directions.");
    if (!t.factIds.length || t.factIds.some((id) => !ids.has(id)))
      fail("Every turn must reference verified source facts.");
    if (
      t.interpretation &&
      !/interpretation|may|might|could|suggests/i.test(t.text)
    )
      t.text = `Our interpretation is: ${t.text}`;
  }
  for (const category of categories) {
    const facts = d.facts.filter((f) => f.category === category);
    if (
      d.summary[category].trim() &&
      (!facts.length ||
        !d.turns.some((t) =>
          t.factIds.some((id) => facts.some((f) => f.id === id)),
        ))
    )
      fail(`Script omits grounded coverage for ${category}.`);
  }
  if (!d.summary.problem.trim() || !d.summary.proposal.trim())
    fail("Source must support a problem and proposal.");
  const words = wordCount(d.turns.map((t) => t.text).join(" "));
  if (words < targetWords * 0.85 || words > targetWords * 1.15)
    throw new PlancastError(
      "WORD_BUDGET",
      `Script has ${words} words; expected ${Math.ceil(targetWords * 0.85)}–${Math.floor(targetWords * 1.15)}.`,
      4,
    );
  return d;
}
export const scriptText = (d: Dialogue) =>
  d.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n") + "\n";
