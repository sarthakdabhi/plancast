// Run from the source checkout with Node. End users need no Node/npm installation.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  cp,
  readFile,
  writeFile,
  chmod,
  readdir,
  rm,
  rename,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { downloadVerified } from "../dist/runtime/assets.js";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const arch = process.argv[2] ?? process.arch;
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch))
  throw Error("Build on macOS for arm64 or x64.");
const nodeVersion = "v24.21.0";
const nodeHash =
  arch === "arm64"
    ? "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
    : "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097";
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releases = join(root, "releases");
await mkdir(releases, { recursive: true });
const stage = await mkdtemp(join(releases, ".build-"));
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const name = `plancast-${pkg.version}-macos-${arch}`;
  const bundle = join(stage, name);
  const app = join(bundle, "app");
  await mkdir(app, { recursive: true });
  for (const path of [
    "dist",
    "runtime",
    "README.md",
    "LICENSE",
    "docs",
    "prd_outputs/Plancast CLI/plancast_cli_PRD.md",
    "package.json",
    "package-lock.json",
  ]) {
    await mkdir(resolve(app, path, ".."), { recursive: true });
    await cp(join(root, path), join(app, path), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__"),
    });
  }
  // Install exactly the lockfile's production dependencies, with lifecycle scripts disabled.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw Error("Run npm run package:standalone [-- arm64|x64].");
  await exec(
    process.execPath,
    [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: app, signal: abort.signal, maxBuffer: 1024 * 1024 },
  );
  const archive = join(stage, "node.tar.gz");
  console.error(`Downloading verified Node ${nodeVersion} (${arch})…`);
  await downloadVerified(
    `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-darwin-${arch}.tar.gz`,
    archive,
    nodeHash,
    abort.signal,
  );
  await exec("/usr/bin/tar", ["-xzf", archive, "-C", stage], {
    signal: abort.signal,
  });
  const nodeSource = join(stage, `node-${nodeVersion}-darwin-${arch}`);
  await mkdir(join(bundle, "node", "bin"), { recursive: true });
  await cp(
    join(nodeSource, "bin", "node"),
    join(bundle, "node", "bin", "node"),
  );
  await cp(join(nodeSource, "LICENSE"), join(bundle, "node", "LICENSE"));
  await writeFile(
    join(bundle, "plancast"),
    `#!/bin/sh
set -eu
script=$0
while [ -L "$script" ]; do
  target=$(/usr/bin/readlink "$script")
  case "$target" in /*) script=$target ;; *) script="$(/usr/bin/dirname "$script")/$target" ;; esac
done
root=$(CDPATH= cd -- "$(/usr/bin/dirname "$script")" && pwd)
exec "$root/node/bin/node" "$root/app/dist/cli.js" "$@"
`,
  );
  await chmod(join(bundle, "plancast"), 0o755);
  const identity = createHash("sha256")
    .update(nodeHash)
    .update(await readFile(join(root, "scripts", "install-standalone.sh")))
    .update(await readFile(join(bundle, "plancast")));
  for (const path of await fileList(app))
    identity.update(path).update(await readFile(join(app, path)));
  const releaseId = `${pkg.version}-${arch}-${identity.digest("hex").slice(0, 16)}`;
  await writeFile(
    join(bundle, "release.json"),
    JSON.stringify(
      {
        version: pkg.version,
        arch,
        node: nodeVersion,
        nodeArchiveSha256: nodeHash,
        releaseId,
      },
      null,
      2,
    ) + "\n",
  );
  const installer = await readFile(
    join(root, "scripts", "install-standalone.sh"),
    "utf8",
  );
  await writeFile(
    join(bundle, "install.command"),
    installer.replaceAll("@RELEASE_ID@", releaseId).replaceAll("@ARCH@", arch),
  );
  await chmod(join(bundle, "install.command"), 0o755);
  const sums = [];
  for (const path of await fileList(bundle)) {
    if (/[\r\n\\]/.test(path)) throw Error("Unsupported checksum filename");
    const h = createHash("sha256");
    for await (const chunk of createReadStream(join(bundle, path)))
      h.update(chunk);
    sums.push(`${h.digest("hex")}  ${path}`);
  }
  await writeFile(join(bundle, "SHA256SUMS"), sums.join("\n") + "\n");
  const tar = join(stage, `${name}.tar.gz`);
  await exec("/usr/bin/tar", ["-czf", tar, "-C", stage, name], {
    signal: abort.signal,
    maxBuffer: 1024 * 1024,
  });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(tar)) hash.update(chunk);
  const destination = join(releases, `${name}.tar.gz`);
  await rename(tar, destination);
  await writeFile(
    destination + ".sha256",
    `${hash.digest("hex")}  ${name}.tar.gz\n`,
  );
  console.log(destination);
} finally {
  await rm(stage, { recursive: true, force: true });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
async function fileList(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      for (const child of await fileList(join(directory, entry.name)))
        paths.push(`${entry.name}/${child}`);
    else if (entry.isFile()) paths.push(entry.name);
    else if (entry.isSymbolicLink()) {
      /* npm's optional .bin links are not launch dependencies */
    } else throw Error("Unsupported release file type");
  }
  return paths.sort();
}
