import { it, expect } from "vitest";
import { balanceSpeech } from "../src/audio/speech.js";
function tone(amplitude: number) {
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++)
    pcm.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000)),
      i * 2,
    );
  return pcm;
}
function rms(pcm: Buffer) {
  let sum = 0;
  for (let i = 480; i < pcm.length - 480; i += 2)
    sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / ((pcm.length - 960) / 2));
}
it("balances different speaker levels without changing duration or source buffers", () => {
  const quiet = tone(3000),
    loud = tone(9000);
  const original = Buffer.from(quiet);
  expect(
    Math.abs(rms(balanceSpeech(quiet)) - rms(balanceSpeech(loud))),
  ).toBeLessThan(1);
  expect(balanceSpeech(quiet).length).toBe(quiet.length);
  expect(quiet).toEqual(original);
});
it("retains headroom, fades boundaries, and does not amplify silence", () => {
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++)
    pcm.writeInt16LE(i % 2 ? 32767 : -32768, i * 2);
  const out = balanceSpeech(pcm);
  expect(out.readInt16LE(0)).toBe(0);
  expect(out.readInt16LE(out.length - 2)).toBe(0);
  for (let i = 0; i < out.length; i += 2)
    expect(Math.abs(out.readInt16LE(i))).toBeLessThanOrEqual(29203);
  expect(balanceSpeech(Buffer.alloc(48000))).toEqual(Buffer.alloc(48000));
});
it("bounds quiet speech gain and rejects malformed PCM", () => {
  const quiet = tone(100);
  expect(rms(balanceSpeech(quiet)) / rms(quiet)).toBeLessThanOrEqual(2.01);
  expect(() => balanceSpeech(Buffer.alloc(1))).toThrow();
  expect(() => balanceSpeech(Buffer.alloc(0))).toThrow();
});
