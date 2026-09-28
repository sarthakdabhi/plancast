import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { groundedDialogue, type JsonRequester } from "./grounded.js";
import { PlancastError, interrupted } from "../domain/errors.js";
import type { ScriptProvider } from "./contracts.js";
import { LLAMA_VERSION, modelAsset } from "../runtime/assets.js";
import { llamaEngine, type LocalEngine } from "../runtime/llama.js";
export const LOCAL_PROMPT_VERSION = "dialogue-v11-llama-v1";
export function llamaScript(
  model: string,
  transport: typeof fetch = fetch,
  progress?: (message: string) => void,
  engine: LocalEngine = llamaEngine(model),
): ScriptProvider {
  const requestJson: JsonRequester = async (
    schema,
    name,
    prompt,
    data,
    signal,
  ) => {
    // Limit source size before any request: reserve context for schema and output.
    const payload = JSON.stringify(data);
    if (payload.length > 65000)
      throw new PlancastError(
        "LOCAL_CONTEXT",
        "Consolidated evidence exceeds the local model context. Use a smaller source set.",
        2,
      );
    progress?.(
      name === "plancast_evidence"
        ? "Extracting source evidence with local Qwen…"
        : name === "plancast_consolidation"
          ? "Consolidating source evidence with local Qwen…"
          : "Writing the local two-host dialogue…",
    );
    const { url, token } = await engine.start(signal);
    const wireSchema = z.toJSONSchema(schema);
    const passages = name === "plancast_passages";
    if (passages) {
      const properties = wireSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      for (const topic of Object.values(properties)) {
        if (topic.properties?.text) {
          const description =
            (topic.properties.text as { description?: string }).description ??
            "";
          const allocation = /Write (\d+) to (\d+)/.exec(description);
          const sentenceCount =
            Number((data as { targetWords?: number }).targetWords) > 400 &&
            allocation &&
            Number(allocation[2]) >= 50
              ? 4
              : 2;
          const minSentenceWords = allocation
            ? Math.ceil(Number(allocation[1]) / sentenceCount)
            : 20;
          const maxSentenceWords = allocation
            ? Math.max(
                minSentenceWords,
                Math.floor(Number(allocation[2]) / sentenceCount),
              )
            : 30;
          const fields =
            sentenceCount === 4
              ? ["point", "explanation", "detail", "qualification"]
              : ["point", "explanation"];
          topic.properties.text = {
            type: "object",
            properties: Object.fromEntries(
              fields.map((field) => [
                field,
                {
                  type: "string",
                  description: `A complete ${minSentenceWords}–${maxSentenceWords} word sentence: ${field === "point" ? "state this topic's main point" : field === "explanation" ? "explain its source-supported context" : field === "detail" ? "explain a distinct source-supported detail or mechanism" : "preserve the source-supported condition, scope or caveat"}. Do not repeat the other sentences.`,
                },
              ]),
            ),
            required: fields,
            additionalProperties: false,
          };
        }
      }
    }
    const localPrompt = passages
      ? `${prompt} For each text object, write every required sentence field. A four-field text needs point, explanation, detail and qualification sentences; a two-field text needs point and explanation. Use the word ranges as drafting guidance, but always finish grammatical sentences. Never join words, truncate a thought, or add filler to hit a count. Explain using the evidence without inventing facts. Do not merely copy short source lines.`
      : prompt;
    for (let attempt = 0; attempt < 3; attempt++) {
      interrupted(signal);
      let response: Response;
      try {
        response = await transport(`${url}/v1/chat/completions`, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            model: "plancast",
            stream: false,

            messages: [
              {
                role: "system",
                content: `${localPrompt} Required JSON schema: ${JSON.stringify(wireSchema)}`,
              },
              { role: "user", content: payload },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name, strict: true, schema: wireSchema },
            },
            temperature: 0,
            max_tokens: 4096,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
        });
      } catch {
        interrupted(signal);
        throw new PlancastError(
          "LOCAL_PROVIDER",
          "Managed llama.cpp stopped or generation timed out. Check available memory and retry.",
          4,
        );
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(250 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PlancastError(
          "LOCAL_PROVIDER",
          `llama.cpp returned HTTP ${response.status}. Check that the selected model is downloaded with plancast setup-local.`,
          4,
        );
      }
      try {
        const result = (await response.json()) as {
          choices?: {
            finish_reason?: string;
            message?: { content?: string };
          }[];
        };
        const choice = result.choices?.[0];
        if (choice?.finish_reason !== "stop" || !choice.message?.content)
          throw new Error();
        const parsed = JSON.parse(choice.message.content);
        if (passages) {
          const properties = wireSchema.properties as Record<
            string,
            { properties?: { text?: { required?: string[] } } }
          >;
          for (const [key, value] of Object.entries(parsed) as [
            string,
            { text?: unknown } | null,
          ][]) {
            const fields = properties[key]?.properties?.text?.required;
            if (!value || !fields) continue;
            const sentence = z
              .object(
                Object.fromEntries(
                  fields.map((field) => [field, z.string().min(1)]),
                ),
              )
              .strict()
              .parse(value.text);
            value.text = fields
              .map((field) => sentence[field]!.replace(/\s+/gu, " ").trim())
              .join(" ");
          }
        }
        return schema.parse(parsed);
      } catch {
        throw new PlancastError(
          "DIALOGUE_SCHEMA",
          "Local model returned incomplete or invalid structured output. No speech was requested.",
          4,
        );
      }
    }
    throw new PlancastError(
      "LOCAL_PROVIDER",
      "Local llama.cpp retries exhausted.",
      4,
    );
  };
  return {
    id: "llama.cpp",
    runtimeVersion: LLAMA_VERSION,
    modelSha256: modelAsset(model).sha256,
    dispose: () => engine.dispose(),
    model,
    async generateDialogue(request) {
      return groundedDialogue(request, requestJson, false);
    },
  };
}
