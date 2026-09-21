import { access, chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { downloadVerified, localDirectory } from "./assets.js";
import { PlancastError, interrupted } from "../domain/errors.js";
export const UV_VERSION = "0.12.17";
export const FFMPEG_VERSION = "7.1-imageio-0.6.0";
export const PYTHON_VERSION = "3.12.13";
export function toolAsset(tool: "uv" | "ffmpeg") {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new PlancastError(
      "LOCAL_SETUP",
      "Managed tools require macOS arm64 or x64.",
      3,
    );
  const arm = process.arch === "arm64";
  const version = tool === "uv" ? UV_VERSION : FFMPEG_VERSION;
  const directory = join(
    localDirectory(),
    "tools",
    `${tool}-${version}-${process.arch}`,
  );
  const triple = `${arm ? "aarch64" : "x86_64"}-apple-darwin`;
  return {
    directory,
    path:
      tool === "uv"
        ? join(directory, `uv-${triple}`, "uv")
        : join(
            directory,
            "imageio_ffmpeg",
            "binaries",
            arm ? "ffmpeg-macos-aarch64-v7.1" : "ffmpeg-macos-x86_64-v7.1",
          ),
    url:
      tool === "uv"
        ? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`
        : arm
          ? "https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl"
          : "https://files.pythonhosted.org/packages/da/58/87ef68ac83f4c7690961bce288fd8e382bc5f1513860fc7f90a9c1c1c6bf/imageio_ffmpeg-0.6.0-py3-none-macosx_10_9_intel.macosx_10_9_x86_64.whl",
    sha256:
      tool === "uv"
        ? arm
          ? "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b"
          : "8dcf05a8c809bb3c471d2b614788ba27a6e41298fc8c31ac84b5f4339fd468e5"
        : arm
          ? "b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742"
          : "9d2baaf867088508d4a3458e61eeb30e945c4ad8016025545f66c4b5aaef0a61",
    bytes:
      tool === "uv" ? (arm ? 16929004 : 20592896) : arm ? 21113891 : 24932969,
  };
}
export const managedFfmpeg = () => toolAsset("ffmpeg").path;
export const pythonDirectory = () => join(localDirectory(), "python");
export const setupEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  UV_PYTHON_INSTALL_DIR: pythonDirectory(),
  UV_CACHE_DIR: join(localDirectory(), "cache", "uv"),
  UV_MANAGED_PYTHON: "1",
  UV_NO_CONFIG: "1",
  UV_NO_PROGRESS: "1",
});
export async function setupTools(signal: AbortSignal) {
  const root = join(localDirectory(), "tools");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".setup.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new PlancastError(
      "LOCAL_SETUP",
      `Another tool setup may be active. If none is running, remove ${lock} and retry.`,
      3,
    );
  }
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(root, ".install-"));
    for (const tool of ["uv", "ffmpeg"] as const) {
      interrupted(signal);
      const asset = toolAsset(tool);
      if (
        !(await access(asset.path).then(
          () => true,
          () => false,
        ))
      ) {
        process.stderr.write(`Installing private ${tool}…\n`);
        const download = join(stage, `${tool}.download`);
        await downloadVerified(
          asset.url,
          download,
          asset.sha256,
          signal,
          asset.bytes,
        );
        const unpack = join(stage, tool);
        await mkdir(unpack);
        if (tool === "uv")
          await promisify(execFile)(
            "/usr/bin/tar",
            ["-xzf", download, "-C", unpack],
            { signal },
          );
        else {
          await promisify(execFile)(
            "/usr/bin/ditto",
            ["-xk", download, unpack],
            { signal },
          );
          await chmod(
            join(
              unpack,
              "imageio_ffmpeg",
              "binaries",
              process.arch === "arm64"
                ? "ffmpeg-macos-aarch64-v7.1"
                : "ffmpeg-macos-x86_64-v7.1",
            ),
            0o755,
          );
        }
        const previous = join(stage, `${tool}-previous`);
        const exists = await access(asset.directory).then(
          () => true,
          () => false,
        );
        if (exists) await rename(asset.directory, previous);
        try {
          await rename(unpack, asset.directory);
        } catch (error) {
          if (exists) await rename(previous, asset.directory);
          throw error;
        }
      }
      await promisify(execFile)(
        asset.path,
        [tool === "uv" ? "--version" : "-version"],
        { signal, timeout: 30000 },
      );
    }
  } catch (error) {
    interrupted(signal);
    if (error instanceof PlancastError) throw error;
    throw new PlancastError(
      "LOCAL_SETUP",
      "Private tool installation failed. Check available disk space and retry plancast setup-local.",
      3,
    );
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
