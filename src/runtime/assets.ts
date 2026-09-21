import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  open,
  stat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  access,
  copyFile,
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PlancastError, interrupted } from "../domain/errors.js";

export const LLAMA_VERSION = "b11080";
export const localDirectory = () =>
  join(homedir(), "Library", "Application Support", "Plancast");
export const modelCatalog = {
  "qwen3:4b": {
    size: "4B",
    bytes: 2497280256,
    revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  },
  "qwen3:8b": {
    size: "8B",
    bytes: 5027783488,
    revision: "7c41481f57cb95916b40956ab2f0b139b296d974",
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
  },
  "qwen3:14b": {
    size: "14B",
    bytes: 9276184896,
    revision:
      "sha256:a8cc1361f3145dc01f6d77c6c82c9116b9ffe3c97b34716fe20418455876c40e",
    sha256: "a8cc1361f3145dc01f6d77c6c82c9116b9ffe3c97b34716fe20418455876c40e",
  },
} as const;
export function modelAsset(model: string) {
  const entry = modelCatalog[model as keyof typeof modelCatalog];
  if (!Object.hasOwn(modelCatalog, model) || !entry)
    throw new PlancastError(
      "LOCAL_MODEL",
      "Choose qwen3:4b, qwen3:8b, or qwen3:14b with PLANCAST_LOCAL_SCRIPT_MODEL.",
      3,
    );
  const name = `Qwen3-${entry.size}-Q4_K_M.gguf`;
  return {
    ...entry,
    name,
    path: join(localDirectory(), "models", name),
    url:
      model === "qwen3:14b"
        ? `https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:${entry.sha256}`
        : `https://huggingface.co/Qwen/Qwen3-${entry.size}-GGUF/resolve/${entry.revision}/${name}`,
  };
}
export function runtimeAsset() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new PlancastError(
      "LOCAL_RUNTIME",
      "The managed llama.cpp runtime supports macOS arm64 and x64 only.",
      3,
    );
  const arch = process.arch;
  const name = `llama-${LLAMA_VERSION}-bin-macos-${arch}.tar.gz`;
  const directory = join(
    localDirectory(),
    `llama.cpp-${LLAMA_VERSION}-${arch}`,
  );
  return {
    directory,
    binary: join(directory, `llama-${LLAMA_VERSION}`, "llama-server"),
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${name}`,
    bytes: arch === "arm64" ? 11192543 : 11223310,
    sha256:
      arch === "arm64"
        ? "314556ebc20cbab8906c3ecbaf48aee74b224a178a20f57fbbe697858f3f83f4"
        : "b830d45bf19ebaa451b190e5b9917107fe9069ac454af3b693f5b7090fab7f20",
  };
}
export async function verifyGguf(path: string, bytes?: number) {
  try {
    const info = await stat(path);
    if (
      !info.isFile() ||
      info.size < 8 ||
      (bytes !== undefined && info.size !== bytes)
    )
      throw new Error();
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4);
      await file.read(header, 0, 4, 0);
      if (header.toString() !== "GGUF") throw new Error();
    } finally {
      await file.close();
    }
  } catch {
    throw new PlancastError(
      "LOCAL_MODEL",
      "Local GGUF model is missing or incomplete. Run plancast setup-local.",
      3,
    );
  }
}
export async function sha256File(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}
export async function downloadVerified(
  url: string,
  destination: string,
  expected: string,
  signal: AbortSignal,
  bytes?: number,
) {
  interrupted(signal);
  try {
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(3600000),
    ]);
    const response = await fetch(url, { signal: boundedSignal });
    if (!response.ok || !response.body)
      throw new PlancastError(
        "LOCAL_SETUP",
        `Asset download failed (HTTP ${response.status}). Retry plancast setup-local.`,
        3,
      );
    const hash = createHash("sha256");
    let count = 0;
    let lastProgress = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        count += chunk.length;
        if (bytes !== undefined && count > bytes) {
          callback(
            new PlancastError(
              "LOCAL_SETUP",
              "Download exceeds its pinned size.",
              3,
            ),
          );
          return;
        }
        if (bytes && bytes > 100000000) {
          const percent = Math.floor(((count / bytes) * 100) / 10) * 10;
          if (percent > lastProgress) {
            lastProgress = percent;
            process.stderr.write(`Model download: ${percent}%\n`);
          }
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      digest,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal: boundedSignal },
    );
    if (
      hash.digest("hex") !== expected ||
      (bytes !== undefined && count !== bytes)
    ) {
      await rm(destination, { force: true });
      throw new PlancastError(
        "LOCAL_SETUP",
        "Downloaded asset failed its pinned SHA-256 check. Retry plancast setup-local.",
        3,
      );
    }
  } catch (error) {
    interrupted(signal);
    if (error instanceof PlancastError) throw error;
    throw new PlancastError(
      "LOCAL_SETUP",
      "Asset download failed or timed out. Check your connection and free disk space, then retry plancast setup-local.",
      3,
    );
  }
}
export async function setupLlama(model: string, signal: AbortSignal) {
  const runtime = runtimeAsset();
  const asset = modelAsset(model);
  await mkdir(localDirectory(), { recursive: true, mode: 0o700 });
  // A lock prevents concurrent installers from replacing each other's files.
  const lock = join(localDirectory(), ".setup-llama.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new PlancastError(
      "LOCAL_SETUP",
      `Another setup may be running. If no setup is active, remove ${lock} and retry.`,
      3,
    );
  }
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(localDirectory(), ".llama-setup-"));
    if (
      !(await access(runtime.binary).then(
        () => true,
        () => false,
      ))
    ) {
      process.stderr.write(
        `Downloading verified llama.cpp ${LLAMA_VERSION}…\n`,
      );
      const archive = join(stage, "runtime.tar.gz");
      await downloadVerified(
        runtime.url,
        archive,
        runtime.sha256,
        signal,
        runtime.bytes,
      );
      const unpack = join(stage, "runtime");
      await mkdir(unpack);
      await promisify(execFile)(
        "/usr/bin/tar",
        ["-xzf", archive, "-C", unpack],
        { signal },
      );
      // Preserve any incomplete old installation until its replacement is ready.
      const backup = join(stage, "previous-runtime");
      const existing = await access(runtime.directory).then(
        () => true,
        () => false,
      );
      if (existing) await rename(runtime.directory, backup);
      try {
        await rename(unpack, runtime.directory);
      } catch (error) {
        if (existing) await rename(backup, runtime.directory);
        throw error;
      }
    }
    await promisify(execFile)(runtime.binary, ["--version"], {
      signal,
      timeout: 60000,
    });
    const exists = await access(asset.path).then(
      () => true,
      () => false,
    );
    if (exists && (await sha256File(asset.path, signal)) === asset.sha256) {
      process.stderr.write(`Verified existing ${asset.name}.\n`);
    } else {
      process.stderr.write(
        `Preparing ${asset.name} (${(asset.bytes / 1e9).toFixed(1)} GB)…\n`,
      );
      const target = join(stage, asset.name);
      const previous = join(
        homedir(),
        ".ollama",
        "models",
        "blobs",
        `sha256-${asset.sha256}`,
      );
      const canImport = await access(previous).then(
        () => true,
        () => false,
      );
      if (canImport && (await sha256File(previous, signal)) === asset.sha256) {
        process.stderr.write(
          "Reusing checksum-verified local GGUF weights; no model download needed.\n",
        );
        interrupted(signal);
        await copyFile(previous, target, constants.COPYFILE_FICLONE);
      } else {
        await downloadVerified(
          asset.url,
          target,
          asset.sha256,
          signal,
          asset.bytes,
        );
      }
      await verifyGguf(target, asset.bytes);
      await mkdir(join(localDirectory(), "models"), { recursive: true });
      await rename(target, asset.path);
    }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
