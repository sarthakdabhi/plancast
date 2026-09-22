import { createInterface } from "node:readline/promises";
import { config } from "../config.js";
import { PlancastError, interrupted } from "../domain/errors.js";
import { saveLocalModel } from "../local-settings.js";
import { installLocal } from "../providers/setup-local.js";
import { modelAsset, modelCatalog } from "../runtime/assets.js";

type SetupOptions = { model?: string; yes?: boolean };

export async function chooseLocalModel(
  current: string,
  question: (prompt: string) => Promise<string>,
  write: (text: string) => void,
): Promise<string> {
  const ids = Object.keys(modelCatalog);
  const notes: Record<string, string> = {
    "qwen3:4b": "smallest; experimental",
    "qwen3:8b": "smaller alternative; not benchmarked",
    "qwen3:14b": "built-in default; tested on M2 Max with 64 GB RAM",
  };
  write(
    "Choose the model that writes both speakers' conversation. Voices stay Jane and George unless overridden.\n",
  );
  ids.forEach((id, index) =>
    write(
      `  ${index + 1}. ${id} — ${(modelAsset(id).bytes / 1e9).toFixed(1)} GB download; ${notes[id]}${id === current ? " [selected]" : ""}\n`,
    ),
  );
  write(
    "Download size is not RAM usage. Speech assets and dependencies need additional space.\n",
  );
  for (;;) {
    const answer = (
      await question(`Choose 1–${ids.length} or a model ID [${current}]: `)
    ).trim();
    const model =
      answer === ""
        ? current
        : ids.find(
            (id, index) => answer === id || answer === String(index + 1),
          );
    if (model) return model;
    write(
      "Choose a listed number or model ID, or press Enter to keep the selected model.\n",
    );
  }
}

export async function setupLocal(options: SetupOptions, signal: AbortSignal) {
  interrupted(signal);
  const explicit = options.model ?? process.env.PLANCAST_LOCAL_SCRIPT_MODEL;
  let model = config(
    {
      ...process.env,
      ...(explicit !== undefined
        ? { PLANCAST_LOCAL_SCRIPT_MODEL: explicit }
        : {}),
    },
    "local",
  ).scriptModel;
  if (explicit === undefined && !options.yes) {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new PlancastError(
        "LOCAL_SETUP",
        "Non-interactive setup needs --model qwen3:4b, --model qwen3:8b, --model qwen3:14b, or --yes to use the selected/default model.",
        2,
      );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const closed = new AbortController();
    prompt.once("close", () => closed.abort());
    prompt.once("SIGINT", () => prompt.close());
    const promptSignal = AbortSignal.any([signal, closed.signal]);
    try {
      model = await chooseLocalModel(
        model,
        (text) => prompt.question(text, { signal: promptSignal }),
        (text) => process.stderr.write(text),
      );
    } catch (error) {
      if (promptSignal.aborted)
        throw new PlancastError(
          "INTERRUPTED",
          "Setup cancelled; no model choice was saved.",
          130,
        );
      throw error;
    } finally {
      prompt.close();
    }
  }
  interrupted(signal);
  process.stderr.write(
    `Writing model: ${model}. No document content is sent during setup.\n`,
  );
  await installLocal(model, signal);
  interrupted(signal);
  await saveLocalModel(model);
  process.stderr.write(
    `Saved writing model: ${model}. Run plancast PLAN.md --play.\n`,
  );
  if (process.env.PLANCAST_LOCAL_SCRIPT_MODEL !== undefined)
    process.stderr.write(
      "PLANCAST_LOCAL_SCRIPT_MODEL overrides the saved choice during generation. Unset it to use the saved model.\n",
    );
}
