import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { localDirectory, modelAsset } from "./runtime/assets.js";
import { PlancastError } from "./domain/errors.js";

export const settingsPath = () => join(localDirectory(), "settings.json");

export function readLocalModel(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(settingsPath(), "utf8"));
    if (typeof value.localScriptModel !== "string") throw new Error();
    modelAsset(value.localScriptModel);
    return value.localScriptModel;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PlancastError(
      "CONFIG",
      `Cannot read the saved writing model in ${settingsPath()}. Run plancast setup-local --model qwen3:14b to replace it.`,
      3,
    );
  }
}

export async function saveLocalModel(model: string) {
  modelAsset(model);
  const path = settingsPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({ localScriptModel: model }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, path);
  } catch {
    throw new PlancastError(
      "CONFIG",
      `Setup finished, but the model choice could not be saved to ${path}. Check permissions and rerun setup.`,
      3,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
