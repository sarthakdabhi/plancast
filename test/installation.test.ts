import { it, expect } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  chmod,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  setupEnvironment,
  toolAsset,
  pythonDirectory,
} from "../src/runtime/tools.js";
const exec = promisify(execFile);
it("uses private tool and Python paths rather than PATH resolution", () => {
  if (process.platform !== "darwin") return;
  expect(toolAsset("uv").path).toMatch(/\/Plancast\/tools\/uv-/);
  expect(toolAsset("ffmpeg").path).toMatch(/\/Plancast\/tools\/ffmpeg-/);
  expect(setupEnvironment()).toMatchObject({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    UV_MANAGED_PYTHON: "1",
    UV_PYTHON_INSTALL_DIR: pythonDirectory(),
  });
});
it("installer handles spaces, repeat installation, unrelated launchers, and tampering", async () => {
  if (process.platform !== "darwin") return;
  const dir = await mkdtemp(join(tmpdir(), "plancast install test "));
  const bundle = join(dir, "bundle");
  const prefix = join(dir, "prefix with spaces");
  await mkdir(bundle);
  const installer = (
    await readFile(resolve("scripts/install-standalone.sh"), "utf8")
  )
    .replaceAll("@RELEASE_ID@", "test-release")
    .replaceAll("@ARCH@", process.arch);
  await writeFile(join(bundle, "install.command"), installer);
  await writeFile(join(bundle, "plancast"), "#!/bin/sh\necho 0.1.0\n");
  await chmod(join(bundle, "plancast"), 0o755);
  const sums = [];
  for (const name of ["install.command", "plancast"])
    sums.push(
      `${createHash("sha256")
        .update(await readFile(join(bundle, name)))
        .digest("hex")}  ${name}`,
    );
  await writeFile(join(bundle, "SHA256SUMS"), sums.join("\n") + "\n");
  const install = () =>
    exec("/bin/sh", [join(bundle, "install.command")], {
      env: {
        ...process.env,
        PLANCAST_INSTALL_PREFIX: prefix,
        PATH: "/usr/bin:/bin",
      },
    });
  try {
    await install();
    const link = join(prefix, "bin", "plancast");
    const target = await readlink(link);
    expect(target).toBe(
      join(prefix, "share", "plancast", "cli", "test-release", "plancast"),
    );
    await install();
    expect(await readlink(link)).toBe(target);
    await writeFile(join(bundle, "plancast"), "tampered");
    await expect(install()).rejects.toThrow();
    expect(await readlink(link)).toBe(target);
    await writeFile(join(bundle, "plancast"), "#!/bin/sh\necho 0.1.0\n");
    await rm(link);
    await writeFile(link, "user-owned command");
    await expect(install()).rejects.toThrow(/Will not replace/);
    expect(await readFile(link, "utf8")).toBe("user-owned command");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
