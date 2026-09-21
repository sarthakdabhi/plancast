import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlancastError, interrupted } from "../domain/errors.js";
import type { SpeechProvider } from "./contracts.js";
export const POCKET_VERSION = "3.1.0";
export const pocketDirectory = () =>
  join(
    homedir(),
    "Library",
    "Application Support",
    "Plancast",
    `pocket-tts-${POCKET_VERSION}-managed`,
  );
export const pocketPython = () => join(pocketDirectory(), "bin", "python");
export const pocketWorker = () =>
  fileURLToPath(new URL("../../runtime/pocket.py", import.meta.url));
export function pocketSpeech(
  runtime = { python: pocketPython(), worker: pocketWorker() },
): SpeechProvider {
  let child: ChildProcessWithoutNullStreams | undefined;
  let lines: Interface | undefined;
  let ready: Promise<void> | undefined;
  let pending:
    | { resolve: (value: Buffer) => void; reject: (error: Error) => void }
    | undefined;
  const error = () =>
    new PlancastError(
      "LOCAL_SPEECH",
      "Pocket TTS failed or is not installed. Run plancast setup-local. No cloud fallback was used.",
      4,
    );
  const dispose = async () => {
    const process = child;
    if (!process) return;
    child = undefined;
    ready = undefined;
    lines?.close();
    pending?.reject(error());
    pending = undefined;
    if (process.exitCode !== null || process.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => process.kill("SIGKILL"), 1000);
      process.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      process.kill("SIGTERM");
    });
  };
  const start = () => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      child = spawn(runtime.python, [runtime.worker], {
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Consume, but never log third-party diagnostics or spoken text.
      child.stderr.resume();
      child.stdin.on("error", () => {
        reject(error());
        pending?.reject(error());
        pending = undefined;
      });
      child.on("error", () => {
        reject(error());
        pending?.reject(error());
        pending = undefined;
      });
      child.on("close", () => {
        reject(error());
        pending?.reject(error());
        pending = undefined;
      });
      lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          if (line.length > 12000000) throw new Error();
          const response = JSON.parse(line) as {
            ready?: boolean;
            pcm?: string;
            error?: string;
          };
          if (response.error) throw new Error();
          if (response.ready) {
            resolve();
            return;
          }
          if (typeof response.pcm !== "string") throw new Error();
          const pcm = Buffer.from(response.pcm, "base64");
          if (!pcm.length || pcm.length % 2 || pcm.length > 24000 * 2 * 180)
            throw new Error();
          pending?.resolve(pcm);
          pending = undefined;
        } catch {
          reject(error());
          pending?.reject(error());
          pending = undefined;
        }
      });
    });
    return ready;
  };
  return {
    id: "pocket-tts",
    model: `pocket-tts-${POCKET_VERSION}`,
    dispose,
    async synthesize({ text, voice, signal }) {
      interrupted(signal);
      const timeout = setTimeout(() => {
        void dispose();
      }, 180000);
      const abort = () => {
        void dispose();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await start();
        interrupted(signal);
        if (pending)
          throw new PlancastError(
            "LOCAL_SPEECH",
            "Concurrent speech requests are not supported.",
            4,
          );
        return await new Promise<Buffer>((resolve, reject) => {
          pending = { resolve, reject };
          child!.stdin.write(JSON.stringify({ text, voice }) + "\n");
        });
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        interrupted(signal);
      }
    },
  };
}
