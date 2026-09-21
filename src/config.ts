import { modelAsset } from "./runtime/assets.js";
import { z } from "zod";
import { PlancastError } from "./domain/errors.js";
const voices = z.enum([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);
const pocketVoices = z.enum(["jane", "george", "alba", "marius"]);
export function config(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
) {
  const provider = z
    .enum(["local", "openai"])
    .safeParse(override ?? env.PLANCAST_PROVIDER ?? "local");
  if (!provider.success)
    throw new PlancastError(
      "CONFIG",
      "Choose --provider local or --provider openai.",
      3,
    );
  const local = provider.data === "local";
  const schema = z.object({
    scriptModel: z.string().min(1),
    speechModel: z.string().min(1),
    voiceA: local ? pocketVoices : voices,
    voiceB: local ? pocketVoices : voices,
  });
  const parsed = schema.safeParse({
    scriptModel: local
      ? (env.PLANCAST_LOCAL_SCRIPT_MODEL ?? "qwen3:14b")
      : (env.PLANCAST_SCRIPT_MODEL ?? "gpt-4.1-mini"),
    speechModel: local
      ? "pocket-tts-3.1.0"
      : (env.PLANCAST_SPEECH_MODEL ?? "gpt-4o-mini-tts"),
    voiceA: local
      ? (env.PLANCAST_LOCAL_VOICE_A ?? "jane")
      : (env.PLANCAST_VOICE_A ?? "alloy"),
    voiceB: local
      ? (env.PLANCAST_LOCAL_VOICE_B ?? "george")
      : (env.PLANCAST_VOICE_B ?? "nova"),
  });
  if (!parsed.success || parsed.data.voiceA === parsed.data.voiceB)
    throw new PlancastError(
      "CONFIG",
      "Set valid distinct voices and nonempty model names for the selected provider.",
      3,
    );
  if (local) modelAsset(parsed.data.scriptModel);
  return { provider: provider.data, ...parsed.data };
}
export type Config = ReturnType<typeof config>;
