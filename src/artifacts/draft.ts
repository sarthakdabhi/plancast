import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { normalizedSource, hash } from "../input/markdown.js";
import {
  dialogueSchema,
  validateDialogue,
  scriptText,
} from "../dialogue/validate.js";
import { PlancastError } from "../domain/errors.js";
export const draftSchema = z.object({
  version: z.literal(1),
  source: z.object({
    path: z.string(),
    text: z.string(),
    sha256: z.string(),
    kind: z.enum(["markdown", "text", "article", "pdf", "bundle"]).optional(),
    sources: z
      .array(
        z.object({
          id: z.string(),
          path: z.string(),
          kind: z.string(),
          sha256: z.string(),
          text: z.string(),
          startLine: z.number().int(),
          endLine: z.number().int(),
          pages: z
            .array(
              z.object({
                page: z.number().int(),
                startLine: z.number().int(),
                endLine: z.number().int(),
              }),
            )
            .optional(),
          originalSha256: z.string().optional(),
        }),
      )
      .optional(),
    title: z.string().optional(),
    originalSha256: z.string().optional(),
    pages: z
      .array(
        z.object({
          page: z.number().int(),
          startLine: z.number().int(),
          endLine: z.number().int(),
        }),
      )
      .optional(),
  }),
  dialogue: dialogueSchema,
  targetWords: z.number().int().min(100).max(1600),
  targetLength: z.enum(["2m", "5m"]),
  audience: z
    .enum(["general", "technical", "plain-English", "executive"])
    .default("general"),
  focus: z.string().max(500).optional(),
  framing: z.enum(["auto", "plan", "document"]),
  promptVersion: z.string(),
  scriptProvider: z.string(),
  scriptModel: z.string(),
  scriptRuntimeVersion: z.string().optional(),
  scriptModelSha256: z.string().optional(),
  scriptSha256: z.string(),
});
export type Draft = z.infer<typeof draftSchema>;
export function validateDraft(raw: unknown): Draft {
  const draft = draftSchema.parse(raw);
  const source = normalizedSource(
    draft.source.text,
    draft.source.path,
    draft.source,
  );
  if (
    source.sha256 !== draft.source.sha256 ||
    hash(scriptText(draft.dialogue)) !== draft.scriptSha256
  )
    throw new Error("Changed draft");
  for (const member of source.sources ?? []) {
    if (
      hash(member.text) !== member.sha256 ||
      source.lines.slice(member.startLine - 1, member.endLine).join("\n") !==
        member.text
    )
      throw new Error("Changed source map");
  }
  const dialogue = validateDialogue(draft.dialogue, source, draft.targetWords);
  if (hash(scriptText(dialogue)) !== draft.scriptSha256)
    throw new Error("Noncanonical draft");
  return { ...draft, dialogue };
}
export async function readDraft(path: string): Promise<Draft> {
  try {
    if ((await stat(path)).size > 20 * 1024 * 1024)
      throw new Error("Large draft");
    const artifact = JSON.parse(await readFile(path, "utf8"));
    if (artifact.draftSha256 !== hash(JSON.stringify(artifact.draft)))
      throw new Error("Changed draft");
    const draft = validateDraft(artifact.draft);
    if (/\.json$/i.test(path)) {
      try {
        const text = await readFile(path.replace(/\.json$/i, ".txt"), "utf8");
        if (hash(text) !== draft.scriptSha256)
          throw new Error("Edited transcript");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return draft;
  } catch {
    throw new PlancastError(
      "DRAFT",
      "Draft is invalid or has changed. Regenerate it from the source before rendering; edited text is not treated as validated dialogue.",
      4,
    );
  }
}
export function draftEnvelope(draft: Draft) {
  return { draft, draftSha256: hash(JSON.stringify(draft)) };
}
