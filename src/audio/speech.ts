import { PlancastError } from "../domain/errors.js";
export const SPEECH_PROCESSING_VERSION = "balanced-speech-v1";
/** Gentle per-turn gain, peak headroom, and 5 ms boundary fades. No pitch change. */
export function balanceSpeech(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2)
    throw new PlancastError("AUDIO", "Invalid speech PCM.", 5);
  const count = pcm.length / 2;
  let energy = 0;
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * 2);
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / count);
  // Do not amplify silence/noise; cap ordinary gain changes to six decibels.
  const desired = rms > 32 ? Math.min(2, Math.max(0.5, 3276.7 / rms)) : 1;
  const gain = peak ? Math.min(desired, 29203 / peak) : 1;
  const output = Buffer.alloc(pcm.length);
  const fade = Math.min(120, Math.floor(count / 2));
  for (let i = 0; i < count; i++) {
    const envelope =
      fade > 1 ? Math.min(1, i / (fade - 1), (count - 1 - i) / (fade - 1)) : 1;
    output.writeInt16LE(
      Math.round(pcm.readInt16LE(i * 2) * gain * envelope),
      i * 2,
    );
  }
  return output;
}
