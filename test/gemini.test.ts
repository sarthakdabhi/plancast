import { afterEach, expect, it, vi } from "vitest";
import { geminiProviders } from "../src/providers/gemini.js";
import { config } from "../src/config.js";
import { normalizedSource } from "../src/input/markdown.js";
const signal = () => new AbortController().signal;
const audio = (
  data = Buffer.from([0, 1, 2, 3]).toString("base64"),
  mimeType = "audio/L16;codec=pcm;rate=24000",
) => ({ inlineData: { data, mimeType } });
const response = (parts: unknown[], finishReason = "STOP") =>
  Response.json({ candidates: [{ finishReason, content: { parts } }] });
const speech = (transport: typeof fetch) =>
  geminiProviders("secret-test-key", "script-model", "tts-model", transport)
    .speech;
afterEach(() => vi.useRealTimers());
it("isolates Gemini settings from OpenAI and local defaults", () => {
  expect(
    config(
      { PLANCAST_VOICE_A: "alloy", PLANCAST_SCRIPT_MODEL: "openai-model" },
      "gemini",
    ),
  ).toMatchObject({
    provider: "gemini",
    voiceA: "Kore",
    voiceB: "Puck",
    scriptModel: "gemini-3.8-flash",
    speechModel: "gemini-3.1-flash-tts-preview",
  });
  expect(config({}).provider).toBe("local");
  expect(() => config({ PLANCAST_GEMINI_VOICE_A: "jane" }, "gemini")).toThrow();
  expect(() => config({ PLANCAST_GEMINI_VOICE_A: "Puck" }, "gemini")).toThrow();
  expect(
    config(
      {
        PLANCAST_GEMINI_SCRIPT_MODEL: "custom-model",
        PLANCAST_GEMINI_VOICE_A: "Aoede",
      },
      "gemini",
    ),
  ).toMatchObject({ scriptModel: "custom-model", voiceA: "Aoede" });
});
it("uses a header key and Gemini audio config and returns exact PCM", async () => {
  const transport = vi.fn<typeof fetch>(async () => response([audio()]));
  expect(
    await speech(transport).synthesize({
      text: "Hello world.",
      voice: "Kore",
      signal: signal(),
    }),
  ).toEqual(Buffer.from([0, 1, 2, 3]));
  const [url, init] = transport.mock.calls[0]!;
  expect(url).not.toContain("secret-test-key");
  expect(init?.headers).toMatchObject({ "x-goog-api-key": "secret-test-key" });
  expect(init?.redirect).toBe("error");
  expect(JSON.parse(init!.body as string).generationConfig).toMatchObject({
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    },
  });
});
it.each([400, 401, 403, 404])(
  "redacts HTTP %s failures without retries",
  async (status) => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response("secret-test-key private text", { status }),
    );
    await expect(
      speech(transport).synthesize({
        text: "private text",
        voice: "Kore",
        signal: signal(),
      }),
    ).rejects.toThrow("Gemini");
    expect(transport).toHaveBeenCalledTimes(1);
    try {
      await speech(transport).synthesize({
        text: "private text",
        voice: "Kore",
        signal: signal(),
      });
    } catch (e) {
      expect(String(e)).not.toMatch(/secret-test-key|private text/);
    }
  },
);
it("caps transient retries at two", async () => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>(
    async () => new Response("private", { status: 503 }),
  );
  const pending = expect(
    speech(transport).synthesize({
      text: "test",
      voice: "Puck",
      signal: signal(),
    }),
  ).rejects.toThrow("HTTP 503");
  await vi.runAllTimersAsync();
  await pending;
  expect(transport).toHaveBeenCalledTimes(3);
});
it("retries transient failures and then succeeds", async () => {
  vi.useFakeTimers();
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("", { status: 429 }))
    .mockResolvedValueOnce(response([audio()]));
  const pending = speech(transport).synthesize({
    text: "test",
    voice: "Puck",
    signal: signal(),
  });
  await vi.runAllTimersAsync();
  expect(await pending).toHaveLength(4);
  expect(transport).toHaveBeenCalledTimes(2);
});
it.each([
  audio("not-base64"),
  audio("AA=="),
  audio("", "audio/wav"),
  audio("AAE=", "audio/L16;codec=pcm;rate=48000"),
])("rejects invalid PCM and unsupported formats", async (part) => {
  await expect(
    speech(async () => response([part])).synthesize({
      text: "test",
      voice: "Kore",
      signal: signal(),
    }),
  ).rejects.toThrow("Gemini returned");
});
it("rejects incomplete, blocked, and empty responses", async () => {
  for (const body of [
    { candidates: [] },
    { promptFeedback: { blockReason: "SAFETY" } },
    {
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [audio()] } },
      ],
    },
  ]) {
    await expect(
      speech(async () => Response.json(body)).synthesize({
        text: "test",
        voice: "Kore",
        signal: signal(),
      }),
    ).rejects.toThrow("blocked, incomplete");
  }
});
it("respects cancellation before transmission", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = vi.fn<typeof fetch>();
  await expect(
    speech(transport).synthesize({
      text: "private",
      voice: "Kore",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ exitCode: 130 });
  expect(transport).not.toHaveBeenCalled();
});
it("requests structured evidence and validates source references before composition", async () => {
  const evidence = {
    problem: {
      summary: "Slow search",
      facts: [{ claim: "Slow search", sourceLineId: "L1" }],
    },
    proposal: {
      summary: "Use an index",
      facts: [{ claim: "Use an index", sourceLineId: "L2" }],
    },
    rationale: null,
    stages: null,
    risks: null,
    uncertainty: null,
    openQuestions: null,
    nextAction: null,
  };
  const passage = (factId: string) => ({
    text: Array(89).fill("word").join(" ") + ".",
    factId,
    interpretation: false,
  });
  const draft = {
    problem: passage("problem_1"),
    proposal: passage("proposal_1"),
    recap: passage("proposal_1"),
    rationale: null,
    stages: null,
    risks: null,
    uncertainty: null,
    openQuestions: null,
    nextAction: null,
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response([{ text: JSON.stringify(evidence) }]))
    .mockResolvedValueOnce(response([{ text: JSON.stringify(draft) }]));
  const provider = geminiProviders("key", "script", "tts", transport);
  const d = await provider.script.generateDialogue({
    source: normalizedSource("Slow search\nUse an index", "plan.md"),
    targetWords: 280,
    signal: signal(),
  });
  expect(d).toMatchObject({
    facts: [{ quote: "Slow search" }, { quote: "Use an index" }],
  });
  const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(body.generationConfig.responseFormat.text.mimeType).toBe(
    "application/json",
  );
  expect(body.systemInstruction.parts[0].text).toContain("untrusted");
  expect(
    body.generationConfig.responseFormat.text.schema.properties.problem,
  ).toBeDefined();
  const malformed = geminiProviders("key", "script", "tts", async () =>
    response([{ text: '{"invalid":true}' }]),
  );
  await expect(
    malformed.script.generateDialogue({
      source: normalizedSource("text", "test.txt"),
      targetWords: 280,
      signal: signal(),
    }),
  ).rejects.toThrow("invalid structured");
});
