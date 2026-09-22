import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ directory: "", install: vi.fn() }));
vi.mock("../src/runtime/assets.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/assets.js")>()),
  localDirectory: () => state.directory,
}));
vi.mock("../src/providers/setup-local.js", () => ({
  installLocal: state.install,
}));
import { chooseLocalModel, setupLocal } from "../src/commands/setup-local.js";
import { config } from "../src/config.js";
import {
  readLocalModel,
  saveLocalModel,
  settingsPath,
} from "../src/local-settings.js";

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "plancast-settings-"));
  state.install.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("PLANCAST_LOCAL_SCRIPT_MODEL", undefined);
  vi.stubEnv("PLANCAST_LOCAL_VOICE_A", undefined);
  vi.stubEnv("PLANCAST_LOCAL_VOICE_B", undefined);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(state.directory, { recursive: true, force: true });
});
it("selects by number or ID, retains Enter default, and retries invalid input", async () => {
  const question = vi
    .fn()
    .mockResolvedValueOnce("other")
    .mockResolvedValueOnce("2");
  const write = vi.fn();
  expect(await chooseLocalModel("qwen3:14b", question, write)).toBe("qwen3:8b");
  expect(question).toHaveBeenCalledTimes(2);
  expect(write.mock.calls.flat().join("")).toContain("not RAM usage");
  expect(await chooseLocalModel("qwen3:4b", async () => "", write)).toBe(
    "qwen3:4b",
  );
  expect(
    await chooseLocalModel("qwen3:4b", async () => "qwen3:14b", write),
  ).toBe("qwen3:14b");
});
it("saves after successful setup and resolves the saved choice on future runs", async () => {
  state.install.mockImplementation(async () =>
    expect(readLocalModel()).toBeUndefined(),
  );
  await setupLocal({ model: "qwen3:8b" }, new AbortController().signal);
  expect(state.install).toHaveBeenCalledWith(
    "qwen3:8b",
    expect.any(AbortSignal),
  );
  expect(config({}).scriptModel).toBe("qwen3:8b");
  expect(config({ PLANCAST_LOCAL_SCRIPT_MODEL: "qwen3:4b" }).scriptModel).toBe(
    "qwen3:4b",
  );
  expect(config({}, "openai").scriptModel).toBe("gpt-4.1-mini");
});
it("keeps the previous choice if downloads fail or setup is interrupted", async () => {
  await saveLocalModel("qwen3:4b");
  state.install.mockRejectedValueOnce(new Error("download failed"));
  await expect(
    setupLocal({ model: "qwen3:8b" }, new AbortController().signal),
  ).rejects.toThrow("download failed");
  expect(readLocalModel()).toBe("qwen3:4b");
  const abort = new AbortController();
  state.install.mockImplementationOnce(async () => abort.abort());
  await expect(
    setupLocal({ model: "qwen3:8b" }, abort.signal),
  ).rejects.toMatchObject({ code: "INTERRUPTED" });
  expect(readLocalModel()).toBe("qwen3:4b");
});
it("validates explicit models before downloading or saving", async () => {
  await expect(
    setupLocal({ model: "other-model" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "LOCAL_MODEL" });
  expect(state.install).not.toHaveBeenCalled();
  expect(readLocalModel()).toBeUndefined();
});
it("requires a deliberate noninteractive selection and supports --yes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  try {
    await expect(
      setupLocal({}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "LOCAL_SETUP", exitCode: 2 });
    expect(state.install).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
});
it("uses --yes with saved and built-in defaults", async () => {
  await setupLocal({ yes: true }, new AbortController().signal);
  expect(readLocalModel()).toBe("qwen3:14b");
  await saveLocalModel("qwen3:4b");
  await setupLocal({ yes: true }, new AbortController().signal);
  expect(state.install).toHaveBeenLastCalledWith(
    "qwen3:4b",
    expect.any(AbortSignal),
  );
});
it("explicit setup flag beats environment, while environment overrides saved generation choice", async () => {
  vi.stubEnv("PLANCAST_LOCAL_SCRIPT_MODEL", "qwen3:4b");
  await setupLocal({ model: "qwen3:8b" }, new AbortController().signal);
  expect(readLocalModel()).toBe("qwen3:8b");
  expect(config().scriptModel).toBe("qwen3:4b");
  await setupLocal({}, new AbortController().signal);
  expect(readLocalModel()).toBe("qwen3:4b");
});
it("reports malformed settings without affecting cloud or explicit model setup", async () => {
  await writeFile(settingsPath(), "{bad");
  expect(() => config({})).toThrow("Cannot read the saved writing model");
  expect(config({}, "gemini").provider).toBe("gemini");
  await setupLocal({ model: "qwen3:8b" }, new AbortController().signal);
  expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({
    localScriptModel: "qwen3:8b",
  });
});
