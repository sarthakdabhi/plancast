import OpenAI from "openai";
import { z } from "zod";
import { groundedDialogue } from "./grounded.js";
import { zodResponseFormat } from "openai/helpers/zod";
import { PlancastError, interrupted } from "../domain/errors.js";
import type {
  ScriptProvider,
  SpeechProvider,
  DialogueRequest,
} from "./contracts.js";
export { PROMPT_VERSION, SYSTEM_PROMPT } from "./grounded.js";
function normalize(error: unknown, signal: AbortSignal): never {
  interrupted(signal);
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    throw new PlancastError(
      "PROVIDER",
      status === 401
        ? "OpenAI rejected the API key. Check OPENAI_API_KEY."
        : `OpenAI request failed${status ? ` (HTTP ${status})` : ""}. Check account access, quota, and connectivity.`,
      4,
    );
  }
  throw new PlancastError(
    "PROVIDER",
    "OpenAI request or response failed. Check connectivity and model configuration.",
    4,
  );
}
export function openaiProviders(
  apiKey: string,
  scriptModel: string,
  speechModel: string,
  transport?: typeof fetch,
): { script: ScriptProvider; speech: SpeechProvider } {
  const client = new OpenAI({
    apiKey,
    timeout: 30_000,
    maxRetries: 2,
    ...(transport ? { fetch: transport } : {}),
  });
  async function requestJson<T extends z.ZodType>(
    schema: T,
    name: string,
    prompt: string,
    data: unknown,
    signal: AbortSignal,
  ): Promise<z.infer<T>> {
    const response = await client.chat.completions.create(
      {
        model: scriptModel,
        store: false,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(data) },
        ],
        response_format: zodResponseFormat(schema, name),
      },
      { signal },
    );
    const choice = response.choices[0];
    if (
      choice?.finish_reason !== "stop" ||
      choice.message.refusal ||
      !choice.message.content
    )
      throw new Error("Incomplete");
    return schema.parse(JSON.parse(choice.message.content));
  }
  return {
    script: {
      id: "openai",
      model: scriptModel,
      async generateDialogue({
        source,
        targetWords,
        signal,
        feedback,
      }: DialogueRequest) {
        try {
          return await groundedDialogue(
            { source, targetWords, signal, ...(feedback ? { feedback } : {}) },
            requestJson,
          );
        } catch (error) {
          normalize(error, signal);
        }
      },
    },
    speech: {
      id: "openai",
      model: speechModel,
      async synthesize({ text, voice, signal }) {
        try {
          const response = await client.audio.speech.create(
            {
              model: speechModel,
              voice: voice as "alloy",
              input: text,
              response_format: "pcm",
              instructions:
                "Read exactly the supplied words, without additions. Speak clearly and naturally at approximately 140 words per minute, with restrained conversational expression.",
            },
            { signal },
          );
          const pcm = Buffer.from(await response.arrayBuffer());
          if (!pcm.length || pcm.length % 2 || pcm.length > 24_000 * 2 * 180)
            throw new Error("Invalid PCM");
          return pcm;
        } catch (error) {
          normalize(error, signal);
        }
      },
    },
  };
}
