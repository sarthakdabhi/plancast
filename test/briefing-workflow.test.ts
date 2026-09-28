import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizedSource } from "../src/input/markdown.js";
import { evidenceChunks } from "../src/input/chunks.js";
import { generate, type Dependencies } from "../src/generate.js";
import type { Dialogue } from "../src/dialogue/validate.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "briefing-workflow-"));
  dirs.push(dir);
  const path = join(dir, "plan.md");
  await writeFile(path, "Search is slow.\nUse SQLite.\n");
  const script = {
    id: "test",
    model: "script",
    generateDialogue: vi.fn(
      async ({ targetWords }: { targetWords: number }): Promise<Dialogue> => ({
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
        facts: ["problem", "proposal"].map((category, i) => ({
          id: category,
          category: category as "problem" | "proposal",
          claim: i ? "Use SQLite." : "Search is slow.",
          quote: i ? "Use SQLite." : "Search is slow.",
          startLine: i + 1,
          endLine: i + 1,
        })),
        turns: Array.from({ length: 4 }, (_, i) => ({
          speaker: i % 2 ? "HOST_B" : "HOST_A",
          text: Array(Math.round(targetWords / 4))
            .fill("search")
            .join(" "),
          factIds: [i % 2 ? "proposal" : "problem"],
          interpretation: false,
        })),
      }),
    ),
  };
  const speech = {
    id: "test",
    model: "speech",
    synthesize: vi.fn(async () => Buffer.alloc(48000)),
  };
  let duration = 300;
  const deps: Dependencies = {
    providers: { script, speech },
    log: vi.fn(),
    audio: {
      preflight: vi.fn(async () => {}),
      play: vi.fn(async () => {}),
      convert: vi.fn(async (_, temp) => {
        const file = join(temp, "audio.m4a");
        await writeFile(file, Buffer.alloc(2048, 1));
        return { path: file, duration };
      }),
    },
  };
  return {
    dir,
    path,
    deps,
    script,
    speech,
    setDuration: (value: number) => {
      duration = value;
    },
  };
}
it("renders five minutes with a larger script and measured duration gate", async () => {
  const { path, deps, script } = await setup();
  const result = await generate(
    path,
    { length: "5m", provider: "local" },
    new AbortController().signal,
    deps,
  );
  expect(result).toMatchObject({
    targetLength: "5m",
    actualDurationSeconds: 300,
  });
  expect(script.generateDialogue).toHaveBeenCalledWith(
    expect.objectContaining({ targetWords: 700 }),
  );
  expect(
    JSON.parse(await readFile(result.manifestPath!, "utf8")),
  ).toMatchObject({ targetLength: "5m", actualDurationSeconds: 300 });
});
it("chunks long input without losing characters or original line references", () => {
  const text = Array.from(
    { length: 100 },
    (_, i) => `Section ${i} ${"Detail. ".repeat(300)}`,
  ).join("\n");
  const source = normalizedSource(text, "long.md");
  const chunks = evidenceChunks(source);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks)
    expect(
      JSON.stringify({
        sourceLines: chunk.map(({ id, text }) => ({ id, text })),
      }).length,
    ).toBeLessThanOrEqual(24000);
  for (const [i, line] of source.lines.entries())
    expect(
      chunks
        .flat()
        .filter((item) => item.line === i + 1)
        .map((item) => item.text)
        .join(""),
    ).toBe(line);
});

it("publishes a reusable transcript without starting speech or audio tools", async () => {
  const { path, dir, deps, speech, script } = await setup();
  const result = await generate(
    path,
    {
      length: "5m",
      provider: "local",
      transcriptOnly: true,
      audience: "executive",
      focus: "risks",
    },
    new AbortController().signal,
    deps,
  );
  expect(result.status).toBe("transcript");
  expect(speech.synthesize).not.toHaveBeenCalled();
  expect(deps.audio!.preflight).not.toHaveBeenCalled();
  expect(script.generateDialogue).toHaveBeenCalledWith(
    expect.objectContaining({ audience: "executive", focus: "risks" }),
  );
  script.generateDialogue.mockClear();
  const rendered = await generate(
    result.manifestPath!,
    {
      length: "2m",
      provider: "local",
      fromDraft: true,
      output: join(dir, "rendered.m4a"),
    },
    new AbortController().signal,
    deps,
  );
  expect(rendered).toMatchObject({
    targetLength: "5m",
    actualDurationSeconds: 300,
  });
  expect(script.generateDialogue).not.toHaveBeenCalled();
  expect(await readFile(rendered.scriptPath!, "utf8")).toBe(
    await readFile(result.scriptPath!, "utf8"),
  );
});
it("rejects an edited draft before speech", async () => {
  const { path, deps, speech } = await setup();
  const result = await generate(
    path,
    { length: "5m", provider: "local", transcriptOnly: true },
    new AbortController().signal,
    deps,
  );
  const artifact = JSON.parse(await readFile(result.manifestPath!, "utf8"));
  artifact.draft.dialogue.turns[0].text += " unsupported change";
  await writeFile(result.manifestPath!, JSON.stringify(artifact));
  await expect(
    generate(
      result.manifestPath!,
      { length: "5m", provider: "local", fromDraft: true },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "DRAFT" });
  expect(speech.synthesize).not.toHaveBeenCalled();
});
it("reuses exact audio without provider calls and rerenders changed voices without rewriting", async () => {
  const { path, dir, deps, script, speech } = await setup();
  deps.cacheDirectory = join(dir, "cache");
  const options = { length: "5m", provider: "local" };
  await generate(path, options, new AbortController().signal, deps);
  script.generateDialogue.mockClear();
  speech.synthesize.mockClear();
  const hit = await generate(path, options, new AbortController().signal, deps);
  expect(hit.cacheStatus).toBe("hit");
  expect(script.generateDialogue).not.toHaveBeenCalled();
  expect(speech.synthesize).not.toHaveBeenCalled();
  vi.stubEnv("PLANCAST_LOCAL_VOICE_A", "alba");
  await generate(
    path,
    { ...options, output: join(dir, "other.m4a") },
    new AbortController().signal,
    deps,
  );
  expect(script.generateDialogue).not.toHaveBeenCalled();
  expect(speech.synthesize).toHaveBeenCalled();
  expect(speech.synthesize).toHaveBeenCalledWith(
    expect.objectContaining({ voice: "alba" }),
  );
});
it("invalidates cache when presentation changes and bypasses cache explicitly", async () => {
  const { path, dir, deps, script } = await setup();
  deps.cacheDirectory = join(dir, "cache");
  const opts = { length: "5m", provider: "local", transcriptOnly: true };
  await generate(path, opts, new AbortController().signal, deps);
  await generate(
    path,
    { ...opts, audience: "technical", output: join(dir, "technical.txt") },
    new AbortController().signal,
    deps,
  );
  await generate(
    path,
    { ...opts, cache: false, output: join(dir, "uncached.txt") },
    new AbortController().signal,
    deps,
  );
  expect(script.generateDialogue).toHaveBeenCalledTimes(3);
});
it.each([
  {
    scriptProvider: "local",
    speechProvider: "openai",
    expected: "dialogue text goes to OpenAI",
    absent: "source content leaves",
  },
  {
    scriptProvider: "gemini",
    speechProvider: "local",
    expected: "source content leaves this Mac for Google Gemini",
    absent: "dialogue text goes to",
  },
])(
  "discloses only active remote stages: $scriptProvider / $speechProvider",
  async (pair) => {
    const { path, deps, script, speech } = await setup();
    deps.acknowledge = vi.fn(async () => false);
    await expect(
      generate(
        path,
        { length: "5m", ...pair },
        new AbortController().signal,
        deps,
      ),
    ).rejects.toMatchObject({ code: "ACKNOWLEDGEMENT" });
    expect(script.generateDialogue).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    const messages = vi.mocked(deps.log!).mock.calls.flat().join(" ");
    expect(messages).toContain(pair.expected);
    expect(messages).not.toContain(pair.absent);
  },
);
it("refuses transcript output that would overwrite the input", async () => {
  const { dir, deps } = await setup();
  const path = join(dir, "input.txt");
  await writeFile(path, "Source content.");
  await expect(
    generate(
      path,
      {
        length: "5m",
        provider: "local",
        transcriptOnly: true,
        force: true,
        output: path,
      },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "OVERWRITE" });
  expect(await readFile(path, "utf8")).toBe("Source content.");
});
it("recovers corrupt cached audio without rewriting its validated script", async () => {
  const { path, dir, deps, script, speech } = await setup();
  deps.cacheDirectory = join(dir, "cache");
  await generate(
    path,
    { length: "5m", provider: "local" },
    new AbortController().signal,
    deps,
  );
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(deps.cacheDirectory)) {
    const file = join(deps.cacheDirectory, name);
    const entry = JSON.parse(await readFile(file, "utf8"));
    if (entry.payload.audio) await writeFile(file, "corrupt");
  }
  script.generateDialogue.mockClear();
  speech.synthesize.mockClear();
  await generate(
    path,
    { length: "5m", provider: "local", output: join(dir, "recovered.m4a") },
    new AbortController().signal,
    deps,
  );
  expect(script.generateDialogue).not.toHaveBeenCalled();
  expect(speech.synthesize).toHaveBeenCalled();
});
it("cached cloud audio needs no fresh consent or provider access", async () => {
  const { path, dir, deps, script, speech } = await setup();
  deps.cacheDirectory = join(dir, "cache");
  await generate(
    path,
    { length: "5m", provider: "openai", yes: true },
    new AbortController().signal,
    deps,
  );
  script.generateDialogue.mockClear();
  speech.synthesize.mockClear();
  deps.acknowledge = vi.fn(async () => false);
  const result = await generate(
    path,
    { length: "5m", provider: "openai" },
    new AbortController().signal,
    deps,
  );
  expect(result.cacheStatus).toBe("hit");
  expect(deps.acknowledge).not.toHaveBeenCalled();
  expect(script.generateDialogue).not.toHaveBeenCalled();
  expect(speech.synthesize).not.toHaveBeenCalled();
});
it("rejects changed exported text before re-rendering", async () => {
  const { path, deps, speech } = await setup();
  const result = await generate(
    path,
    { length: "5m", provider: "local", transcriptOnly: true },
    new AbortController().signal,
    deps,
  );
  await writeFile(result.scriptPath!, "HOST_A: Changed explanation.");
  await expect(
    generate(
      result.manifestPath!,
      { length: "5m", provider: "local", fromDraft: true },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "DRAFT" });
  expect(speech.synthesize).not.toHaveBeenCalled();
});
it("a reused draft fails duration validation without being rewritten", async () => {
  const { path, dir, deps, script, setDuration } = await setup();
  const result = await generate(
    path,
    { length: "5m", provider: "local", transcriptOnly: true },
    new AbortController().signal,
    deps,
  );
  script.generateDialogue.mockClear();
  setDuration(400);
  await expect(
    generate(
      result.manifestPath!,
      {
        length: "5m",
        provider: "local",
        fromDraft: true,
        output: join(dir, "bad.m4a"),
      },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "DURATION" });
  expect(script.generateDialogue).not.toHaveBeenCalled();
  const { exists } = await import("../src/artifacts/publish.js");
  expect(await exists(join(dir, "bad.m4a"))).toBe(false);
});
it("does not publish when the source changes during generation", async () => {
  const { path, deps, script } = await setup();
  const original = script.generateDialogue.getMockImplementation()!;
  script.generateDialogue.mockImplementation(async (request) => {
    const draft = await original(request);
    await writeFile(path, "Changed source.");
    return draft;
  });
  await expect(
    generate(
      path,
      { length: "5m", provider: "local", transcriptOnly: true },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "INPUT" });
  const { exists } = await import("../src/artifacts/publish.js");
  expect(await exists(path.replace(".md", ".plancast.json"))).toBe(false);
});
it("protects source documents reached through a directory alias", async () => {
  const { dir, deps } = await setup();
  const { symlink } = await import("node:fs/promises");
  const input = join(dir, "source.txt");
  await writeFile(input, "Original content.");
  const alias = join(dir, "alias");
  await symlink(dir, alias, "dir");
  await expect(
    generate(
      input,
      {
        length: "5m",
        provider: "local",
        transcriptOnly: true,
        output: join(alias, "source.txt"),
        force: true,
      },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "OVERWRITE" });
  expect(await readFile(input, "utf8")).toBe("Original content.");
});
it("rejects repeated explanatory sentences instead of padding a long briefing", async () => {
  const { path, deps, script, speech } = await setup();
  const original = script.generateDialogue.getMockImplementation()!;
  script.generateDialogue.mockImplementation(async (request) => {
    const draft = await original(request);
    draft.turns[1]!.text =
      "This proposal keeps source files as the authoritative local store. This proposal keeps source files as the authoritative local store.";
    return draft;
  });
  await expect(
    generate(
      path,
      { length: "5m", provider: "local" },
      new AbortController().signal,
      deps,
    ),
  ).rejects.toMatchObject({ code: "DIALOGUE_REPETITION" });
  expect(script.generateDialogue).toHaveBeenCalledTimes(2);
  expect(speech.synthesize).not.toHaveBeenCalled();
});
it("the real render CLI honors child options and inherited JSON mode", async () => {
  const { path, dir, deps } = await setup();
  const draft = await generate(
    path,
    { length: "5m", provider: "local", transcriptOnly: true },
    new AbortController().signal,
    deps,
  );
  const { execFileSync } = await import("node:child_process");
  for (const before of [false, true]) {
    const output = join(dir, "selected.m4a");
    const stdout = execFileSync(
      process.execPath,
      [
        "dist/cli.js",
        ...(before ? ["--json"] : []),
        "render",
        draft.manifestPath!,
        "--output",
        output,
        "--speech-provider",
        "gemini",
        "--no-cache",
        "--dry-run",
        ...(!before ? ["--json"] : []),
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      status: "dry_run",
      outputPath: output,
      speechProvider: "gemini",
      targetLength: "5m",
      wouldUseCache: false,
    });
  }
});
