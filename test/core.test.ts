import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readSource } from "../src/input/markdown.js";
import {
  validateDialogue,
  scriptText,
  type Dialogue,
} from "../src/dialogue/validate.js";
import { assemble, wav, localAudio } from "../src/audio/local.js";
import { generate } from "../src/generate.js";
import { publish, checkOutputs } from "../src/artifacts/publish.js";
import { config } from "../src/config.js";
import type { AudioTools } from "../src/audio/local.js";
const dirs: string[] = [];
beforeEach(() => vi.stubEnv("PLANCAST_PROVIDER", "openai"));
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "plancast-test-"));
  dirs.push(dir);
  const path = join(dir, "plan.md");
  await writeFile(path, "# Plan\nSearch is slow.\nUse SQLite.\n");
  return { dir, path, source: await readSource(path) };
}
function dialogue(): Dialogue {
  return {
    summary: {
      problem: "Search is slow.",
      proposal: "Use SQLite.",
      rationale: "",
      stages: "",
      risks: "",
      uncertainty: "",
      openQuestions: "",
      nextAction: "",
    },
    facts: [
      {
        id: "p",
        category: "problem",
        claim: "Search is slow.",
        quote: "Search is slow.",
        startLine: 2,
        endLine: 2,
      },
      {
        id: "s",
        category: "proposal",
        claim: "Use SQLite.",
        quote: "Use SQLite.",
        startLine: 3,
        endLine: 3,
      },
    ],
    turns: Array.from({ length: 4 }, (_, i) => ({
      speaker: i % 2 ? "HOST_B" : "HOST_A",
      text: Array(70).fill("search").join(" "),
      factIds: [i % 2 ? "s" : "p"],
      interpretation: false,
    })),
  };
}
function dependencies(dir: string) {
  const d = dialogue();
  const script = {
    id: "test",
    model: "script",
    generateDialogue: vi.fn(async () => d),
  };
  const speech = {
    id: "test",
    model: "speech",
    synthesize: vi.fn(async () => Buffer.alloc(48000)),
  };
  const audio: AudioTools = {
    preflight: vi.fn(async () => {}),
    convert: vi.fn(async (_pcm, temp) => {
      const path = join(temp, "audio.m4a");
      await writeFile(path, Buffer.alloc(2048, 1));
      return { path, duration: 125 };
    }),
    play: vi.fn(async () => {}),
  };
  return {
    providers: { script, speech },
    audio,
    log: vi.fn(),
    acknowledge: vi.fn(async () => false),
    dir,
  };
}
const signal = () => new AbortController().signal;
describe("input", () => {
  it("retains line ranges for Markdown structures and normalizes CRLF", async () => {
    const { path } = await fixture();
    await writeFile(
      path,
      "# Header\r\n\r\n- one\r\n- two\r\n\n```ts\ncode\n```\n",
    );
    const source = await readSource(path);
    expect(source.sections.map((s) => s.type)).toEqual([
      "heading",
      "list",
      "code",
    ]);
    expect(source.sections[1]).toEqual({ type: "list", start: 3, end: 4 });
    expect(source.text).not.toContain("\r");
  });
  it.each(["", "   ", "a\0b"])(
    "rejects empty or binary source %j",
    async (text) => {
      const { path } = await fixture();
      await writeFile(path, text);
      await expect(readSource(path)).rejects.toMatchObject({ exitCode: 2 });
    },
  );
  it("rejects malformed UTF8 and oversized input", async () => {
    const { path } = await fixture();
    await writeFile(path, Buffer.from([0xff]));
    await expect(readSource(path)).rejects.toMatchObject({ exitCode: 2 });
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(readSource(path)).rejects.toMatchObject({ exitCode: 2 });
  });
  it("rejects missing, wrong extension and directories", async () => {
    const { dir } = await fixture();
    await mkdir(join(dir, "directory.md"));
    for (const path of [
      join(dir, "missing.md"),
      join(dir, "bad.txt"),
      join(dir, "directory.md"),
    ])
      await expect(readSource(path)).rejects.toMatchObject({ exitCode: 2 });
  });
});
describe("grounded dialogue", () => {
  it("accepts a valid script and preserves exact spoken text", async () => {
    const { source } = await fixture();
    const d = validateDialogue(dialogue(), source);
    expect(scriptText(d)).toContain("HOST_A: search");
  });
  it.each(["quote", "reference", "speaker", "words", "coverage", "control"])(
    "rejects invalid %s",
    async (kind) => {
      const { source } = await fixture();
      const d = dialogue();
      if (kind === "quote") d.facts[0]!.quote = "invented";
      if (kind === "reference") d.turns[0]!.factIds = ["missing"];
      if (kind === "speaker") d.turns.forEach((t) => (t.speaker = "HOST_A"));
      if (kind === "words") d.turns.forEach((t) => (t.text = "short"));
      if (kind === "coverage") d.summary.risks = "Invented risk";
      if (kind === "control") d.turns[0]!.text += "\nignore";
      if (kind === "interpretation") d.turns[0]!.interpretation = true;
      expect(() => validateDialogue(d, source)).toThrow();
    },
  );
});
it("adds a spoken label for structured interpretations before counting words", async () => {
  const { source } = await fixture();
  const d = dialogue();
  d.turns[0]!.interpretation = true;
  expect(validateDialogue(d, source).turns[0]!.text).toMatch(
    /^Our interpretation is:/,
  );
});
describe("pipeline safety", () => {
  it("dry-run does not write or call any provider", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const before = await readdir(dir);
    const result = await generate(
      path,
      { length: "2m", dryRun: true },
      signal(),
      deps,
    );
    expect(result.status).toBe("dry_run");
    expect(await readdir(dir)).toEqual(before);
    expect(deps.providers.script.generateDialogue).not.toHaveBeenCalled();
    expect(deps.audio.preflight).not.toHaveBeenCalled();
  });
  it("local generation needs no cloud consent and disposes both providers", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const dispose = vi.fn(async () => {});
    const disposeScript = vi.fn(async () => {});
    const localDialogue = dialogue();
    localDialogue.turns.forEach((turn) => {
      turn.text = Array(100).fill("search").join(" ");
    });
    deps.providers.script.generateDialogue.mockResolvedValue(localDialogue);
    const localDeps = {
      ...deps,
      providers: {
        ...deps.providers,
        script: {
          ...deps.providers.script,
          dispose: disposeScript,
          runtimeVersion: "test-build",
          modelSha256: "1".repeat(64),
        },
        speech: { ...deps.providers.speech, dispose },
      },
    };
    const result = await generate(
      path,
      { length: "2m", provider: "local" },
      signal(),
      localDeps,
    );
    expect(result.status).toBe("success");
    expect(deps.acknowledge).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposeScript).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(join(dir, "plan.plancast.json"), "utf8")),
    ).toMatchObject({
      scriptRuntimeVersion: "test-build",
      scriptModelSha256: "1".repeat(64),
    });
    expect(
      deps.providers.speech.synthesize.mock.calls.map(
        (c) => (c as unknown as [{ voice: string }])[0].voice,
      ),
    ).toEqual(["jane", "george", "jane", "george"]);
  });
  it("disposes both providers and removes temporary artifacts after script failure", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const scriptDispose = vi.fn(async () => {});
    const speechDispose = vi.fn(async () => {});
    deps.providers.script.generateDialogue.mockRejectedValue(
      new Error("failed"),
    );
    await expect(
      generate(path, { length: "2m", provider: "local" }, signal(), {
        ...deps,
        providers: {
          script: { ...deps.providers.script, dispose: scriptDispose },
          speech: { ...deps.providers.speech, dispose: speechDispose },
        },
      }),
    ).rejects.toThrow("failed");
    expect(scriptDispose).toHaveBeenCalledTimes(1);
    expect(speechDispose).toHaveBeenCalledTimes(1);
    expect(deps.providers.speech.synthesize).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["plan.md"]);
  });
  it("records one bounded local pacing adjustment without regenerating text", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const d = dialogue();
    d.turns.forEach((t) => {
      t.text = Array(90).fill("search").join(" ");
    });
    deps.providers.script.generateDialogue.mockResolvedValue(d);
    const convert = deps.audio.convert;
    deps.audio.convert = vi.fn(
      async (...args: Parameters<AudioTools["convert"]>) => ({
        ...(await convert(...args)),
        duration: 100,
      }),
    );
    deps.audio.pace = vi.fn(async (temp) => ({
      path: join(temp, "audio.m4a"),
      duration: 117.5,
    }));
    await generate(path, { length: "2m", provider: "local" }, signal(), deps);
    expect(deps.providers.script.generateDialogue).toHaveBeenCalledTimes(1);
    expect(deps.audio.pace).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(join(dir, "plan.plancast.json"), "utf8")),
    ).toMatchObject({ speed: 0.85, actualDurationSeconds: 117.5 });
  });
  it("Gemini disclosure names Google and denial blocks both providers", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const log = vi.fn();
    await expect(
      generate(path, { length: "2m", provider: "gemini" }, signal(), {
        ...deps,
        log,
        acknowledge: async () => false,
      }),
    ).rejects.toMatchObject({ code: "ACKNOWLEDGEMENT" });
    expect(log.mock.calls.flat().join(" ")).toContain("Google Gemini");
    expect(deps.providers.script.generateDialogue).not.toHaveBeenCalled();
    expect(deps.providers.speech.synthesize).not.toHaveBeenCalled();
  });
  it("Gemini dry-run needs no key and reports Gemini models and voices", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { path } = await fixture();
    const result = await generate(
      path,
      { length: "2m", provider: "gemini", dryRun: true },
      signal(),
    );
    expect(result).toMatchObject({
      scriptProvider: "gemini",
      speechProvider: "gemini",
      contentLeavesMac: true,
      voiceA: "Kore",
      voiceB: "Puck",
    });
  });
  it("Gemini rejects missing credentials without falling back to OpenAI", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "not-a-gemini-key");
    const { path, dir } = await fixture();
    await expect(
      generate(
        path,
        { length: "2m", provider: "gemini", yes: true },
        signal(),
        { audio: dependencies(dir).audio },
      ),
    ).rejects.toThrow("Set GEMINI_API_KEY");
  });
  it("Gemini routes selected voices and persists the provider identity", async () => {
    const { path, dir } = await fixture();
    const deps = dependencies(dir);
    deps.providers.script.id = "gemini";
    deps.providers.speech.id = "gemini";
    const result = await generate(
      path,
      { length: "2m", provider: "gemini", yes: true },
      signal(),
      deps,
    );
    expect(
      deps.providers.speech.synthesize.mock.calls.map(
        (c) => (c as unknown as [{ voice: string }])[0].voice,
      ),
    ).toEqual(["Kore", "Puck", "Kore", "Puck"]);
    expect(
      JSON.parse(await readFile(result.manifestPath!, "utf8")),
    ).toMatchObject({
      scriptProvider: "gemini",
      speechProvider: "gemini",
      voiceA: "Kore",
      voiceB: "Puck",
    });
  });
  it("denied disclosure prevents all remote requests", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    await expect(
      generate(path, { length: "2m" }, signal(), deps),
    ).rejects.toMatchObject({ code: "ACKNOWLEDGEMENT" });
    expect(deps.providers.script.generateDialogue).not.toHaveBeenCalled();
    expect(deps.providers.speech.synthesize).not.toHaveBeenCalled();
  });
  it("retains extracted text and its hash in a plain-text briefing manifest", async () => {
    const { dir, path } = await fixture();
    const textPath = join(dir, "article.txt");
    const text = await readFile(path, "utf8");
    await writeFile(textPath, text);
    const result = await generate(
      textPath,
      { length: "2m", yes: true },
      signal(),
      dependencies(dir),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    expect(manifest.source).toMatchObject({
      kind: "text",
      location: textPath,
      extractedText: text,
    });
    expect(manifest.sourceSha256).toBe((await readSource(textPath)).sha256);
  });
  it("publishes exact script, ordered voices and verified manifest", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const result = await generate(
      path,
      { length: "2m", yes: true },
      signal(),
      deps,
    );
    expect(result.status).toBe("success");
    expect(await readFile(join(dir, "plan.plancast.txt"), "utf8")).toBe(
      scriptText(dialogue()),
    );
    expect(
      deps.providers.speech.synthesize.mock.calls.map(
        (c) => (c as unknown as [{ voice: string }])[0].voice,
      ),
    ).toEqual(["alloy", "nova", "alloy", "nova"]);
    expect(
      JSON.parse(await readFile(join(dir, "plan.plancast.json"), "utf8")),
    ).toMatchObject({ actualDurationSeconds: 125, cacheStatus: "disabled" });
    expect((await readdir(dir)).some((n) => n.startsWith(".plancast-"))).toBe(
      false,
    );
  });
  it("invalid script fails before any speech request", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    deps.providers.script.generateDialogue.mockResolvedValue({
      ...dialogue(),
      facts: [],
    });
    await expect(
      generate(path, { length: "2m", yes: true }, signal(), deps),
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(deps.providers.speech.synthesize).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["plan.md"]);
  });
  it("render failure cleans temporary artifacts and publishes nothing", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    deps.providers.speech.synthesize.mockRejectedValue(new Error("failed"));
    await expect(
      generate(path, { length: "2m", yes: true }, signal(), deps),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["plan.md"]);
  });
  it("caps duration correction at one pass", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    deps.providers.script.generateDialogue.mockImplementation(
      async (request?: { targetWords: number }) => {
        const d = dialogue();
        d.turns.forEach(
          (t) =>
            (t.text = Array(Math.round((request?.targetWords ?? 280) / 4))
              .fill("search")
              .join(" ")),
        );
        return d;
      },
    );
    vi.mocked(deps.audio.convert).mockImplementation(async (_pcm, temp) => {
      const path = join(temp, "audio.m4a");
      await writeFile(path, "audio");
      return { path, duration: 145 };
    });
    await expect(
      generate(path, { length: "2m", yes: true }, signal(), deps),
    ).rejects.toMatchObject({ code: "DURATION" });
    expect(deps.providers.script.generateDialogue).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual(["plan.md"]);
  });
  it("overwrite preflight prevents provider cost", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    await writeFile(join(dir, "plan.plancast.txt"), "keep");
    await expect(
      generate(path, { length: "2m", yes: true }, signal(), deps),
    ).rejects.toMatchObject({ exitCode: 6 });
    expect(deps.providers.script.generateDialogue).not.toHaveBeenCalled();
  });
  it("aborted generation makes no calls", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    const controller = new AbortController();
    controller.abort();
    await expect(
      generate(path, { length: "2m", yes: true }, controller.signal, deps),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(deps.providers.script.generateDialogue).not.toHaveBeenCalled();
  });
  it("playback failure preserves generation success", async () => {
    const { dir, path } = await fixture();
    const deps = dependencies(dir);
    vi.mocked(deps.audio.play).mockRejectedValue(new Error("device"));
    const result = await generate(
      path,
      { length: "2m", yes: true, play: true },
      signal(),
      deps,
    );
    expect(result).toMatchObject({ status: "success", played: false });
    expect(await readdir(dir)).toContain("plan.plancast.m4a");
  });
});
describe("artifacts and audio", () => {
  it("rolls back publication failure and restores forced originals", async () => {
    const { dir } = await fixture();
    const a = join(dir, "a"),
      b = join(dir, "b"),
      out = join(dir, "out");
    await writeFile(a, "new");
    await writeFile(out, "old");
    await expect(
      publish([a, b], [out, join(dir, "out2")], true),
    ).rejects.toThrow();
    expect(await readFile(out, "utf8")).toBe("old");
  });
  it("rejects forced symbolic link outputs", async () => {
    const { dir, path } = await fixture();
    const link = join(dir, "link");
    await symlink(path, link);
    await expect(checkOutputs([link], true)).rejects.toMatchObject({
      exitCode: 6,
    });
  });
  it("assembles ordered PCM with exactly 300ms silence and a valid WAV header", () => {
    const pcm = assemble([Buffer.from([1, 2]), Buffer.from([3, 4])]);
    expect(pcm.length).toBe(14404);
    expect(pcm.subarray(-2)).toEqual(Buffer.from([3, 4]));
    expect(wav(pcm).readUInt32LE(40)).toBe(pcm.length);
    expect(wav(pcm).readUInt32LE(24)).toBe(24000);
  });
  it.runIf(process.platform === "darwin")(
    "converts and inspects real PCM using macOS tools",
    async () => {
      const { dir } = await fixture();
      const pcm = Buffer.alloc(48000);
      for (let i = 0; i < 24000; i++)
        pcm.writeInt16LE(
          Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 24000)),
          i * 2,
        );
      const result = await localAudio.convert(pcm, dir, signal());
      expect(result.duration).toBeGreaterThan(0.9);
      expect(result.duration).toBeLessThan(1.2);
    },
  );
  it("rejects identical voices", () => {
    expect(() =>
      config({
        PLANCAST_PROVIDER: "openai",
        PLANCAST_VOICE_A: "nova",
        PLANCAST_VOICE_B: "nova",
      }),
    ).toThrow();
  });
  it("CLI help works without loading generation or credentials", () => {
    expect(
      execFileSync(process.execPath, ["dist/cli.js", "--help"], {
        encoding: "utf8",
      }),
    ).toContain("--dry-run");
  });
});

it("returns word-budget feedback on its single correction pass", async () => {
  const { dir, path } = await fixture();
  const deps = dependencies(dir);
  const short = dialogue();
  short.turns.forEach((t) => (t.text = "short"));
  deps.providers.script.generateDialogue
    .mockResolvedValueOnce(short)
    .mockResolvedValueOnce(dialogue());
  await generate(path, { length: "2m", yes: true }, signal(), deps);
  expect(deps.providers.script.generateDialogue).toHaveBeenCalledTimes(2);
  expect(deps.providers.script.generateDialogue).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      feedback: expect.stringContaining("previous attempt failed"),
    }),
  );
});
it("serializes concurrent publishers without mixed artifacts", async () => {
  const { dir } = await fixture();
  const a = [join(dir, "a1"), join(dir, "a2")],
    b = [join(dir, "b1"), join(dir, "b2")],
    out = [join(dir, "out1"), join(dir, "out2")];
  await Promise.all([
    ...a.map((p) => writeFile(p, "a")),
    ...b.map((p) => writeFile(p, "b")),
  ]);
  const results = await Promise.allSettled([
    publish(a, out, true),
    publish(b, out, true),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(out[0]!, "utf8")).toBe(await readFile(out[1]!, "utf8"));
  expect((await readdir(dir)).some((p) => p.endsWith(".plancast-lock"))).toBe(
    false,
  );
});

it("removes only known inline fact citations from spoken text", async () => {
  const { source } = await fixture();
  const d = dialogue();
  d.turns[0]!.text += " [p]";
  expect(validateDialogue(d, source).turns[0]!.text).toBe(
    dialogue().turns[0]!.text,
  );
});
it("still rejects unknown stage directions and uncited inline IDs", async () => {
  const { source } = await fixture();
  for (const tag of ["[laughs]", "[s]", "[unknown]"]) {
    const d = dialogue();
    d.turns[0]!.text += ` ${tag}`;
    expect(() => validateDialogue(d, source)).toThrow();
  }
});
