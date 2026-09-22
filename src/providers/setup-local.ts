import {
  setupTools,
  toolAsset,
  setupEnvironment,
  PYTHON_VERSION,
} from "../runtime/tools.js";
import { setupLlama } from "../runtime/assets.js";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import {
  pocketDirectory,
  pocketPython,
  pocketWorker,
  POCKET_VERSION,
} from "./pocket.js";
import { PlancastError, interrupted } from "../domain/errors.js";
export async function installLocal(model: string, signal: AbortSignal) {
  const run = async (command: string, args: string[], inherit = true) => {
    interrupted(signal);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        signal,
        env: setupEnvironment(),
        stdio: inherit ? "inherit" : "ignore",
      });
      child.on("error", () =>
        reject(
          new PlancastError(
            "LOCAL_SETUP",
            `Could not run a private setup tool. Retry plancast setup-local.`,
            3,
          ),
        ),
      );
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new PlancastError(
                "LOCAL_SETUP",
                "Local model setup failed. Check downloads and retry plancast setup-local.",
                3,
              ),
            ),
      );
    });
  };
  process.stderr.write(
    "Downloading local models and Python dependencies. No plan content is sent.\n",
  );
  await setupTools(signal);
  const uv = toolAsset("uv").path;
  await setupLlama(model, signal);
  if (
    !(await access(pocketPython()).then(
      () => true,
      () => false,
    ))
  )
    await run(uv, [
      "venv",
      "--managed-python",
      "--python",
      PYTHON_VERSION,
      pocketDirectory(),
    ]);
  await run(uv, [
    "pip",
    "install",
    "--python",
    pocketPython(),
    `pocket-tts==${POCKET_VERSION}`,
  ]);
  await run(pocketPython(), [pocketWorker(), "--download"], false);
  process.stderr.write("Local models and voices are ready.\n");
}
