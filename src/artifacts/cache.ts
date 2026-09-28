import { homedir } from "node:os";
import { join } from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hash } from "../input/markdown.js";
export const cacheDirectory = () =>
  join(homedir(), "Library", "Caches", "Plancast", "generation-v1");
export function cacheKey(value: unknown) {
  return hash(JSON.stringify(value));
}
export async function readCache(
  key: string,
  directory = cacheDirectory(),
): Promise<unknown | undefined> {
  try {
    const path = join(directory, `${key}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 100 * 1024 * 1024) return undefined;
    const entry = JSON.parse(await readFile(path, "utf8"));
    if (
      entry.key !== key ||
      entry.sha256 !== hash(JSON.stringify(entry.payload))
    )
      return undefined;
    return entry.payload;
  } catch {
    return undefined;
  }
}
export async function writeCache(
  key: string,
  payload: unknown,
  directory = cacheDirectory(),
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(directory, ".write-"));
  try {
    await writeFile(
      join(temp, "entry.json"),
      JSON.stringify({ key, sha256: hash(JSON.stringify(payload)), payload }),
      { mode: 0o600 },
    );
    await rename(join(temp, "entry.json"), join(directory, `${key}.json`));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function clearCache() {
  // Fixed application-owned directory, never an arbitrary user-supplied path.
  await rm(cacheDirectory(), { recursive: true, force: true });
}
