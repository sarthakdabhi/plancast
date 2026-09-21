import { lstat, link, rename, rm, mkdir } from "node:fs/promises";
import { PlancastError } from "../domain/errors.js";
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function checkOutputs(
  paths: string[],
  force: boolean,
): Promise<void> {
  for (const path of paths)
    if (await exists(path)) {
      if (!force)
        throw new PlancastError(
          "OVERWRITE",
          "Output or sidecar already exists. Choose another --output or pass --force.",
          6,
        );
      if (!(await lstat(path)).isFile())
        throw new PlancastError(
          "OVERWRITE",
          "Refusing to replace a directory or symbolic link.",
          6,
        );
    }
}
// Publish the manifest last as the commit marker. Hard links prevent racing writers
// from clobbering a destination. Roll back this transaction on ordinary failures.
export async function publish(
  staged: string[],
  destinations: string[],
  force: boolean,
): Promise<void> {
  const lock = `${destinations[0]!}.plancast-lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new PlancastError(
        "OVERWRITE",
        "Another publication holds the output lock. If no Plancast process is running, remove the .plancast-lock directory beside the audio and retry.",
        6,
      );
    throw error;
  }
  const published: string[] = [];
  const backups: { path: string; backup: string }[] = [];
  try {
    await checkOutputs(destinations, force);
    for (let i = destinations.length - 1; i >= 0; i--) {
      const path = destinations[i]!;
      if (force && (await exists(path))) {
        const backup = `${staged[i]!}.backup`;
        await rename(path, backup);
        backups.push({ path, backup });
      }
    }
    for (let i = 0; i < destinations.length; i++) {
      const path = destinations[i]!;
      await link(staged[i]!, path);
      published.push(path);
    }
  } catch (error) {
    try {
      for (const path of published.reverse()) await rm(path, { force: true });
      for (const { path, backup } of backups.reverse())
        await rename(backup, path);
    } catch {
      throw new PlancastError(
        "RECOVERY",
        "Output rollback failed. Staged originals have been retained; recover them before retrying.",
        6,
      );
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new PlancastError(
        "OVERWRITE",
        "Another process created an output; nothing was overwritten.",
        6,
      );
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
