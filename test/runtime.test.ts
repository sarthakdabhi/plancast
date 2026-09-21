import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  downloadVerified,
  modelAsset,
  verifyGguf,
} from "../src/runtime/assets.js";
import { createHash } from "node:crypto";
afterEach(() => vi.unstubAllGlobals());
it("only resolves curated, revision-pinned models", () => {
  expect(modelAsset("qwen3:14b").url).toContain("sha256:a8cc1361");
  expect(() => modelAsset("https://cloud.example/model")).toThrow();
  expect(() => modelAsset("../../model")).toThrow();
});
it("rejects invalid, missing, and truncated GGUF assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plancast-model-test-"));
  try {
    const path = join(dir, "model");
    await expect(verifyGguf(path)).rejects.toMatchObject({
      code: "LOCAL_MODEL",
    });
    await writeFile(path, "NOTGGUF!");
    await expect(verifyGguf(path)).rejects.toMatchObject({
      code: "LOCAL_MODEL",
    });
    await writeFile(path, "GGUF1234");
    await expect(verifyGguf(path, 12)).rejects.toMatchObject({
      code: "LOCAL_MODEL",
    });
    await expect(verifyGguf(path, 8)).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("checks downloaded content against pinned hash and size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plancast-download-test-"));
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("GGUF1234")),
    );
    const signal = new AbortController().signal;
    await expect(
      downloadVerified(
        "https://example.com",
        join(dir, "bad"),
        "0".repeat(64),
        signal,
        8,
      ),
    ).rejects.toMatchObject({ code: "LOCAL_SETUP" });
    await expect(readFile(join(dir, "bad"))).rejects.toThrow();
    const hash = createHash("sha256").update("GGUF1234").digest("hex");
    await downloadVerified(
      "https://example.com",
      join(dir, "good"),
      hash,
      signal,
      8,
    );
    expect(await readFile(join(dir, "good"), "utf8")).toBe("GGUF1234");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("supervisor terminates its server when the owning CLI pipe closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plancast-supervisor-test-"));
  let pid: number | undefined;
  const script = join(dir, "fake.mjs");
  await writeFile(
    script,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
  );
  const owner = spawn(
    process.execPath,
    [resolve("runtime/llama-supervisor.mjs"), process.execPath, script],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  try {
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await readFile(join(dir, "pid"), "utf8"));
        break;
      } catch {
        await delay(20);
      }
    }
    expect(pid).toBeGreaterThan(0);
    const closed = once(owner, "close");
    owner.stdin.end();
    await closed;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    owner.kill();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 6000);
