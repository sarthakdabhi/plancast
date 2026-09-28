import { expect, it } from "vitest";
import { pipelineConfig } from "../src/config.js";
it("resolves independent providers and keeps each provider's models and voices", () => {
  const settings = pipelineConfig(
    {
      PLANCAST_SCRIPT_PROVIDER: "openai",
      PLANCAST_SPEECH_PROVIDER: "gemini",
      PLANCAST_SCRIPT_MODEL: "writer",
      PLANCAST_GEMINI_SPEECH_MODEL: "speaker",
      PLANCAST_GEMINI_VOICE_A: "Kore",
      PLANCAST_GEMINI_VOICE_B: "Puck",
    },
    {},
  );
  expect(settings).toMatchObject({
    scriptProvider: "openai",
    speechProvider: "gemini",
    scriptModel: "writer",
    speechModel: "speaker",
    voiceA: "Kore",
    voiceB: "Puck",
  });
});
it("explicit provider pair beats environment while a role flag beats the pair", () => {
  expect(
    pipelineConfig(
      {
        PLANCAST_SCRIPT_PROVIDER: "gemini",
        PLANCAST_SPEECH_PROVIDER: "gemini",
      },
      { provider: "openai", speechProvider: "local" },
    ),
  ).toMatchObject({
    scriptProvider: "openai",
    speechProvider: "local",
    voiceA: "jane",
  });
});
it("rendering does not resolve or validate an unused local writing model", () => {
  expect(
    pipelineConfig(
      { PLANCAST_LOCAL_SCRIPT_MODEL: "not-installed" },
      { speechProvider: "local" },
      true,
    ),
  ).toMatchObject({ scriptModel: "unused", speechProvider: "local" });
});
it("transcript-only generation ignores unused speech settings", () => {
  expect(
    pipelineConfig(
      { PLANCAST_VOICE_A: "invalid", PLANCAST_SPEECH_PROVIDER: "invalid" },
      { scriptProvider: "openai", transcriptOnly: true },
    ),
  ).toMatchObject({ scriptProvider: "openai", speechModel: "unused" });
});
