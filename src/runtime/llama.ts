import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { access } from "node:fs/promises";
import { runtimeAsset, modelAsset, verifyGguf, sha256File } from "./assets.js";
import { PlancastError, interrupted } from "../domain/errors.js";

export interface LocalEngine {
  start(signal: AbortSignal): Promise<{ url: string; token: string }>;
  dispose(): Promise<void>;
}
export function llamaEngine(model: string): LocalEngine {
  let child: ChildProcess | undefined;
  let endpoint: { url: string; token: string } | undefined;
  let closing: Promise<void> | undefined;
  let detach: (() => void) | undefined;
  const dispose = () => {
    if (closing) return closing;
    detach?.();
    endpoint = undefined;
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null)
      return Promise.resolve();
    closing = new Promise<void>((resolve) => {
      current.once("close", resolve);
      current.stdin?.end();
    });
    return closing;
  };
  return {
    dispose,
    async start(signal) {
      interrupted(signal);
      if (endpoint) return endpoint;
      if (closing) await closing;
      closing = undefined;
      const asset = modelAsset(model);
      const runtime = runtimeAsset();
      await verifyGguf(asset.path, asset.bytes);
      if ((await sha256File(asset.path, signal)) !== asset.sha256)
        throw new PlancastError(
          "LOCAL_MODEL",
          "Local model checksum does not match the pinned weights. Run plancast setup-local to repair it.",
          3,
        );
      if (
        !(await access(runtime.binary).then(
          () => true,
          () => false,
        ))
      )
        throw new PlancastError(
          "LOCAL_RUNTIME",
          "The managed llama.cpp runtime is missing. Run plancast setup-local.",
          3,
        );
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port =
            typeof address === "object" && address ? address.port : 0;
          server.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      interrupted(signal);
      const token = randomBytes(32).toString("hex");
      const url = `http://127.0.0.1:${port}`;
      // Never inherit LLAMA_ARG_*, remote RPC settings, or provider credentials.
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../runtime/llama-supervisor.mjs", import.meta.url),
          ),
          runtime.binary,
          "--model",
          asset.path,
          "--alias",
          "plancast",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--ctx-size",
          "32768",
          "--parallel",
          "1",
          "--n-gpu-layers",
          "99",
          "--offline",
          "--no-webui",
          "--log-disable",
          "--reasoning",
          "off",
          "--jinja",
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            LLAMA_API_KEY: token,
          },
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      let failed = false;
      child.on("error", () => {
        failed = true;
      });
      child.stdin?.on("error", () => {
        failed = true;
      });
      const stop = () => {
        void dispose();
      };
      signal.addEventListener("abort", stop, { once: true });
      detach = () => signal.removeEventListener("abort", stop);
      try {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          interrupted(signal);
          if (failed || child?.exitCode !== null || child?.signalCode !== null)
            break;
          try {
            const response = await fetch(`${url}/v1/models`, {
              headers: { Authorization: `Bearer ${token}` },
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
            });
            const result = response.ok
              ? ((await response.json()) as { data?: { id: string }[] })
              : undefined;
            if (result?.data?.some((item) => item.id === "plancast")) {
              endpoint = { url, token };
              return endpoint;
            }
            await response.body?.cancel().catch(() => {});
          } catch {
            interrupted(signal);
          }
          await delay(250, undefined, { signal });
        }
        throw new PlancastError(
          "LOCAL_RUNTIME",
          "Managed llama.cpp failed to load within two minutes. Check available memory and run plancast setup-local to verify assets.",
          3,
        );
      } catch (error) {
        await dispose();
        interrupted(signal);
        throw error;
      }
    },
  };
}
