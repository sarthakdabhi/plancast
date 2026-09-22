import { it, expect, vi } from "vitest";
import { config } from "../src/config.js";
import { llamaScript } from "../src/providers/llama.js";
const engine = () => ({
  start: vi.fn(async () => ({
    url: "http://127.0.0.1:43210",
    token: "private-token",
  })),
  dispose: vi.fn(async () => {}),
});
const source = {
  path: "plan.md",
  text: "Keep data local.",
  lines: ["Keep data local."],
  sha256: "",
  sections: [],
};
const request = () => ({
  source,
  targetWords: 280,
  signal: new AbortController().signal,
});
it("defaults to local providers and keeps cloud voice settings separate", () => {
  expect(
    config({ PLANCAST_SCRIPT_MODEL: "cloud", PLANCAST_VOICE_A: "nova" }),
  ).toMatchObject({
    provider: "local",
    scriptModel: "qwen3:14b",
    voiceA: "jane",
    voiceB: "george",
  });
  expect(config({}, "openai")).toMatchObject({
    scriptModel: "gpt-4.1-mini",
    voiceA: "alloy",
  });
  expect(() => config({}, "unknown")).toThrow();
});
it("validates local sentence pairs and keeps citations through composition", async () => {
  let stage = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:43210/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer private-token",
    });
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    stage++;
    if (stage === 1) {
      const evidence = Object.fromEntries(
        [
          "problem",
          "proposal",
          "rationale",
          "stages",
          "risks",
          "uncertainty",
          "openQuestions",
          "nextAction",
        ].map((c) => [
          c,
          c === "proposal" || c === "problem"
            ? {
                summary: "Keep data local",
                facts: [{ claim: "Keep data local", sourceLineId: "L1" }],
              }
            : null,
        ]),
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(evidence) },
          },
        ],
      });
    }
    expect(
      body.response_format.json_schema.schema.properties.problem.properties.text
        .required,
    ).toEqual(["point", "explanation"]);
    expect(
      body.response_format.json_schema.schema.properties.problem.properties.text
        .properties.point.pattern,
    ).toBeUndefined();
    const content = Object.fromEntries(
      Object.keys(body.response_format.json_schema.schema.properties).map(
        (c) => [
          c,
          c === "questions"
            ? {
                opening: "What does this source tell us?",
                details: null,
                uncertainty: null,
                recap: "What should listeners take away?",
              }
            : ["problem", "proposal", "recap"].includes(c)
              ? {
                  text: {
                    point: "Keep data local.",
                    explanation: "Process the plan on this Mac.",
                  },
                  factId: c === "problem" ? "problem_1" : "proposal_1",
                  interpretation: false,
                }
              : null,
        ],
      ),
    );
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    });
  });
  const result = (await llamaScript(
    "qwen3:14b",
    fetcher,
    undefined,
    engine(),
  ).generateDialogue(request())) as {
    turns: { text: string; factIds: string[] }[];
  };
  expect(result.turns[1]?.text).toContain(
    "Keep data local. Process the plan on this Mac.",
  );
  expect(result.turns[1]?.factIds).toContain("problem_1");
});
it("local PCM pacing rejects excessive rate changes", async () => {
  if (process.platform !== "darwin") return;
  const { localAudio } = await import("../src/audio/local.js");
  await expect(
    localAudio.pace!("/unused", 0.5, new AbortController().signal),
  ).rejects.toMatchObject({ code: "AUDIO" });
});
it("ffmpeg pacing preserves a tone's pitch while extending duration", async () => {
  if (process.platform !== "darwin") return;
  const { execFileSync } = await import("node:child_process");
  try {
    const { managedFfmpeg } = await import("../src/runtime/tools.js");
    execFileSync(managedFfmpeg(), ["-version"], { stdio: "ignore" });
  } catch {
    return;
  }
  const { localAudio } = await import("../src/audio/local.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "plancast-tempo-"));
  try {
    const pcm = Buffer.alloc(48000 * 2);
    for (let i = 0; i < 48000; i++)
      pcm.writeInt16LE(
        Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 24000)),
        i * 2,
      );
    const signal = new AbortController().signal;
    await localAudio.convert(pcm, dir, signal);
    const paced = await localAudio.pace!(dir, 0.85, signal);
    expect(paced.duration).toBeGreaterThan(2.25);
    expect(paced.duration).toBeLessThan(2.45);
    const samples = await readFile(join(dir, "paced.pcm"));
    let crossings = 0;
    for (let i = 12000; i < 36000; i++)
      if (
        samples.readInt16LE(i * 2) <= 0 &&
        samples.readInt16LE((i + 1) * 2) > 0
      )
        crossings++;
    expect(crossings).toBeGreaterThan(435);
    expect(crossings).toBeLessThan(445);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects truncated output before speech", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      choices: [{ finish_reason: "length", message: { content: "{}" } }],
    }),
  );
  await expect(
    llamaScript("qwen3:14b", fetcher, undefined, engine()).generateDialogue(
      request(),
    ),
  ).rejects.toMatchObject({ code: "DIALOGUE_SCHEMA" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("limits transient llama.cpp retries to two", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response("", { status: 503 }),
  );
  await expect(
    llamaScript("qwen3:14b", fetcher, undefined, engine()).generateDialogue(
      request(),
    ),
  ).rejects.toMatchObject({ code: "LOCAL_PROVIDER" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("rejects oversized source before starting native inference", async () => {
  const runtime = engine();
  await expect(
    llamaScript("qwen3:14b", fetch, undefined, runtime).generateDialogue({
      ...request(),
      source: { ...source, lines: ["x".repeat(66000)] },
    }),
  ).rejects.toMatchObject({ code: "LOCAL_CONTEXT" });
  expect(runtime.start).not.toHaveBeenCalled();
});
