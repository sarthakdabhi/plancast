import { managedFfmpeg } from "../runtime/tools.js";
import { playAudio } from "./play.js";
import { release } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, stat, writeFile, readFile } from "node:fs/promises";
import { PlancastError, interrupted } from "../domain/errors.js";
const exec = promisify(execFile);
export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function assemble(turns: Buffer[]): Buffer {
  if (!turns.length || turns.some((t) => !t.length || t.length % 2))
    throw new PlancastError(
      "AUDIO",
      "Speech provider returned invalid PCM audio.",
      5,
    );
  return Buffer.concat(
    turns.flatMap((t, i) => (i ? [Buffer.alloc(14400), t] : [t])),
  );
}
export interface AudioTools {
  preflight(): Promise<void>;
  convert(
    pcm: Buffer,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ path: string; duration: number }>;
  pace?(
    directory: string,
    rate: number,
    signal: AbortSignal,
  ): Promise<{ path: string; duration: number }>;
  play(path: string, signal: AbortSignal): Promise<void>;
}
export const localAudio: AudioTools = {
  async preflight() {
    if (process.platform !== "darwin" || Number(release().split(".")[0]) < 23)
      throw new PlancastError(
        "PLATFORM",
        "Audio generation requires macOS 14 or later.",
        3,
      );
    for (const tool of ["/usr/bin/afconvert", "/usr/bin/afinfo"])
      await access(tool).catch(() => {
        throw new PlancastError(
          "PLATFORM",
          "Install macOS audio tools before generating.",
          3,
        );
      });
  },
  async convert(pcm, directory, signal) {
    const path = `${directory}/audio.m4a`;
    await writeFile(`${directory}/audio.wav`, wav(pcm), { mode: 0o600 });
    try {
      await exec(
        "/usr/bin/afconvert",
        [`${directory}/audio.wav`, "-f", "m4af", "-d", "aac@48000", path],
        { signal, timeout: 30_000 },
      );
      const { stdout } = await exec("/usr/bin/afinfo", [path], {
        signal,
        timeout: 10_000,
        env: { ...process.env, LC_ALL: "C" },
      });
      const duration = Number(
        /estimated duration:\s*([\d.]+)\s*sec/i.exec(stdout)?.[1],
      );
      if (
        !Number.isFinite(duration) ||
        !/aac/i.test(stdout) ||
        !/48000 Hz/.test(stdout) ||
        (await stat(path)).size < 1024 ||
        Math.abs(duration - pcm.length / 48000) > 1
      )
        throw new Error("Invalid audio");
      return { path, duration };
    } catch {
      interrupted(signal);
      throw new PlancastError(
        "AUDIO",
        "M4A conversion or afinfo validation failed.",
        5,
      );
    }
  },
  async pace(directory, rate, signal) {
    if (!Number.isFinite(rate) || rate < 0.85 || rate > 1.15)
      throw new PlancastError(
        "AUDIO",
        "Local pacing adjustment exceeds the allowed range.",
        5,
      );
    try {
      await exec(
        managedFfmpeg(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          `${directory}/audio.wav`,
          "-filter:a",
          `atempo=${rate}`,
          "-f",
          "s16le",
          "-ar",
          "24000",
          "-ac",
          "1",
          `${directory}/paced.pcm`,
        ],
        { signal, timeout: 30000 },
      );
      return await localAudio.convert(
        await readFile(`${directory}/paced.pcm`),
        directory,
        signal,
      );
    } catch {
      interrupted(signal);
      throw new PlancastError(
        "AUDIO",
        "Local pacing needs the managed FFmpeg runtime. Run plancast setup-local and retry.",
        5,
      );
    }
  },
  play: playAudio,
};
