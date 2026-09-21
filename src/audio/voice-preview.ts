import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { pocketSpeech } from "../providers/pocket.js";
import { assemble, localAudio } from "./local.js";
import { balanceSpeech } from "./speech.js";
import { interrupted } from "../domain/errors.js";

export const PREVIEW_TURNS = [
  "Let's walk through the plan together. What's changing, and why does it matter?",
  "We're making search faster while keeping your notes on this Mac. The first step is to measure how the current search performs.",
  "That makes sense. What should we be careful about?",
  "A faster search still needs to return the right results. We'll compare both versions before switching, and keep the old search available as a fallback.",
];
export async function previewVoices(signal: AbortSignal, play = false) {
  const settings = config(process.env, "local");
  await localAudio.preflight();
  const root = join(
    homedir(),
    "Library",
    "Caches",
    "Plancast",
    "voice-previews",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "preview-"));
  const speech = pocketSpeech();
  let complete = false;
  try {
    process.stderr.write(
      `Local AI voice preview: Host A = ${settings.voiceA}; Host B = ${settings.voiceB}. No plan or cloud API is used.\n`,
    );
    const turns: Buffer[] = [];
    for (const [index, text] of PREVIEW_TURNS.entries()) {
      interrupted(signal);
      const voice = index % 2 ? settings.voiceB : settings.voiceA;
      process.stderr.write(
        `Rendering preview ${index + 1}/${PREVIEW_TURNS.length} (${voice})…\n`,
      );
      turns.push(
        balanceSpeech(await speech.synthesize({ text, voice, signal })),
      );
    }
    const audio = await localAudio.convert(assemble(turns), directory, signal);
    await writeFile(
      join(directory, "transcript.txt"),
      PREVIEW_TURNS.map((text, i) => `HOST_${i % 2 ? "B" : "A"}: ${text}`).join(
        "\n\n",
      ) + "\n",
      { mode: 0o600 },
    );
    interrupted(signal);
    complete = true;
    if (play) await localAudio.play(audio.path, signal);
    return audio;
  } finally {
    await speech.dispose?.();
    if (!complete) await rm(directory, { recursive: true, force: true });
  }
}
