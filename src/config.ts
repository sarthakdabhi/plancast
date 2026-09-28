import { modelAsset } from "./runtime/assets.js";
import { readLocalModel } from "./local-settings.js";
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
const geminiVoices = z.enum([
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
]);
const pocketVoices = z.enum(["jane", "george", "alba", "marius"]);
export function config(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
  role?: "script" | "speech",
) {
  const provider = z
    .enum(["local", "openai", "gemini"])
    .safeParse(override ?? env.PLANCAST_PROVIDER ?? "local");
  if (!provider.success)
    throw new PlancastError(
      "CONFIG",
      "Choose --provider local, openai, or gemini.",
      3,
    );
  const gemini = provider.data === "gemini";
  const local = provider.data === "local";
  const schema = z.object({
    scriptModel: z.string().min(1),
    speechModel: z.string().min(1),
    voiceA: local ? pocketVoices : gemini ? geminiVoices : voices,
    voiceB: local ? pocketVoices : gemini ? geminiVoices : voices,
  });
  const raw = {
    scriptModel:
      role === "speech"
        ? "unused"
        : local
          ? (env.PLANCAST_LOCAL_SCRIPT_MODEL ?? readLocalModel() ?? "qwen3:14b")
          : gemini
            ? (env.PLANCAST_GEMINI_SCRIPT_MODEL ?? "gemini-3.8-flash")
            : (env.PLANCAST_SCRIPT_MODEL ?? "gpt-4.1-mini"),
    speechModel: local
      ? "pocket-tts-3.1.0"
      : gemini
        ? (env.PLANCAST_GEMINI_SPEECH_MODEL ?? "gemini-3.1-flash-tts-preview")
        : (env.PLANCAST_SPEECH_MODEL ?? "gpt-4o-mini-tts"),
    voiceA: local
      ? (env.PLANCAST_LOCAL_VOICE_A ?? "jane")
      : gemini
        ? (env.PLANCAST_GEMINI_VOICE_A ?? "Kore")
        : (env.PLANCAST_VOICE_A ?? "alloy"),
    voiceB: local
      ? (env.PLANCAST_LOCAL_VOICE_B ?? "george")
      : gemini
        ? (env.PLANCAST_GEMINI_VOICE_B ?? "Puck")
        : (env.PLANCAST_VOICE_B ?? "nova"),
  };
  if (role === "script") {
    raw.voiceA = local ? "jane" : gemini ? "Kore" : "alloy";
    raw.voiceB = local ? "george" : gemini ? "Puck" : "nova";
    raw.speechModel = "unused";
  }
  if (role === "speech") raw.scriptModel = "unused";
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.voiceA === parsed.data.voiceB)
    throw new PlancastError(
      "CONFIG",
      "Set valid distinct voices and nonempty model names for the selected provider.",
      3,
    );
  if (local && role !== "speech") modelAsset(parsed.data.scriptModel);
  return { provider: provider.data, ...parsed.data };
}
export type Config = ReturnType<typeof config>;

export function pipelineConfig(
  env: NodeJS.ProcessEnv,
  options: {
    provider?: string;
    scriptProvider?: string;
    speechProvider?: string;
    transcriptOnly?: boolean;
  },
  renderOnly = false,
) {
  const base = options.provider ?? env.PLANCAST_PROVIDER ?? "local";
  const scriptChoice =
    options.scriptProvider ??
    (options.provider ? base : (env.PLANCAST_SCRIPT_PROVIDER ?? base));
  const speechChoice =
    options.speechProvider ??
    (options.provider ? base : (env.PLANCAST_SPEECH_PROVIDER ?? base));
  const speech = options.transcriptOnly
    ? {
        provider: "local" as const,
        speechModel: "unused",
        voiceA: "jane",
        voiceB: "george",
      }
    : config(env, speechChoice, "speech");
  const script = renderOnly
    ? { provider: "local" as const, scriptModel: "unused" }
    : config(env, scriptChoice, "script");
  return {
    provider: base,
    scriptProvider: script.provider,
    speechProvider: speech.provider,
    scriptModel: script.scriptModel,
    speechModel: speech.speechModel,
    voiceA: speech.voiceA,
    voiceB: speech.voiceB,
  };
}
