import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pocketSpeech } from "../src/providers/pocket.js";
async function worker(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "plancast-pocket-test-"));
  const path = join(dir, "worker.mjs");
  await writeFile(path, body);
  return {
    dir,
    speech: pocketSpeech({ python: process.execPath, worker: path }),
  };
}
it("keeps a worker alive across turns and transfers exact PCM", async () => {
  const { dir, speech } =
    await worker(`import {createInterface} from 'node:readline';
  console.log(JSON.stringify({ready:true}));let n=0;
  createInterface({input:process.stdin}).on('line',()=>{n++;console.log(JSON.stringify({pcm:Buffer.from([n,0]).toString('base64')}));});`);
  try {
    for (let n = 1; n <= 2; n++)
      expect(
        await speech.synthesize({
          text: "Hello",
          voice: "alba",
          signal: new AbortController().signal,
        }),
      ).toEqual(Buffer.from([n, 0]));
  } finally {
    await speech.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});
it("abort terminates a stuck speech worker", async () => {
  const { dir, speech } = await worker(
    `console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(
      speech.synthesize({
        text: "Hello",
        voice: "alba",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "INTERRUPTED" });
  } finally {
    clearTimeout(timer);
    await speech.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});
it("worker errors are redacted", async () => {
  const { dir, speech } = await worker(
    `console.log(JSON.stringify({error:'private dialogue or credential'}));`,
  );
  try {
    await expect(
      speech.synthesize({
        text: "Hello",
        voice: "alba",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Pocket TTS failed/);
  } finally {
    await speech.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});
