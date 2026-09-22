import { it, expect, vi } from "vitest";
import { openaiProviders } from "../src/providers/openai.js";
import type { Source } from "../src/input/markdown.js";
const source: Source = {
  path: "/synthetic.md",
  text: "Source data",
  lines: ["Source data"],
  sha256: "test",
  sections: [],
};
const request = () => ({
  source,
  targetWords: 280,
  signal: new AbortController().signal,
});
function referenceResponse(sourceLineId = "L1") {
  return {
    problem: {
      summary: "Source data",
      facts: [{ claim: "Source data", sourceLineId }],
    },
    proposal: {
      summary: "Source data",
      facts: [{ claim: "Source data", sourceLineId }],
    },
    rationale: null,
    stages: null,
    risks: null as {
      summary: string;
      facts: { claim: string; sourceLineId: string }[];
    } | null,
    uncertainty: null,
    openQuestions: null,
    nextAction: null,
  };
}
function passageResponse() {
  const passage = (factId: string) => ({
    text: Array(83).fill("word").join(" ") + ".",
    factId,
    interpretation: false,
  });
  return {
    questions: {
      opening: "What does this source tell us?",
      details: null,
      uncertainty: null,
      recap: "What should listeners take away?",
    },
    problem: passage("problem_1"),
    proposal: passage("proposal_1"),
    rationale: null,
    stages: null,
    risks: null,
    uncertainty: null,
    openQuestions: null,
    nextAction: null,
    recap: passage("proposal_1"),
  };
}
it("never retries authentication and never exposes a provider error body", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "sensitive-body-do-not-log",
            type: "invalid_request_error",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  const provider = openaiProviders(
    "synthetic-test-key",
    "test-script",
    "test-speech",
    transport,
  );
  await expect(
    provider.script.generateDialogue(request()),
  ).rejects.toMatchObject({
    message: "OpenAI rejected the API key. Check OPENAI_API_KEY.",
    exitCode: 4,
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("caps transient failures at the initial request plus two retries", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ error: { message: "private-body" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      }),
  );
  const provider = openaiProviders(
    "synthetic-test-key",
    "test-script",
    "test-speech",
    transport,
  );
  await expect(
    provider.script.generateDialogue(request()),
  ).rejects.toMatchObject({ code: "PROVIDER", exitCode: 4 });
  expect(transport).toHaveBeenCalledTimes(3);
});
it("uses structured outputs and treats source instructions as user data", async () => {
  let body: Record<string, unknown> = {};
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const currentBody = JSON.parse(String(init?.body));
    if (currentBody.response_format.json_schema.name === "plancast_evidence")
      body = currentBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                currentBody.response_format.json_schema.name ===
                  "plancast_evidence"
                  ? referenceResponse()
                  : passageResponse(),
              ),
              refusal: null,
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const provider = openaiProviders(
    "synthetic-test-key",
    "test-script",
    "test-speech",
    transport,
  );
  expect(await provider.script.generateDialogue(request())).toMatchObject({
    facts: expect.arrayContaining([
      {
        id: "problem_1",
        category: "problem",
        claim: "Source data",
        quote: "Source data",
        startLine: 1,
        endLine: 1,
      },
    ]),
  });
  expect(body.store).toBe(false);
  expect(body.response_format).toMatchObject({
    type: "json_schema",
    json_schema: { strict: true },
  });
  expect(body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Source data"),
      }),
    ]),
  );
});
it("rejects truncated JSON without retrying", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    openaiProviders(
      "synthetic-test-key",
      "script",
      "speech",
      transport,
    ).script.generateDialogue(request()),
  ).rejects.toMatchObject({ code: "PROVIDER" });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("rejects empty speech responses", async () => {
  const transport = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array(), { status: 200 }),
  );
  await expect(
    openaiProviders(
      "synthetic-test-key",
      "script",
      "speech",
      transport,
    ).speech.synthesize({
      text: "Hello",
      voice: "alloy",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "PROVIDER" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("copies source quotation text locally without asking the model to reproduce Markdown", async () => {
  let body: Record<string, unknown> = {};
  const text = "**Risk:** Keep  notes local.";
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const currentBody = JSON.parse(String(init?.body));
    if (currentBody.response_format.json_schema.name === "plancast_evidence")
      body = currentBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                currentBody.response_format.json_schema.name ===
                  "plancast_evidence"
                  ? referenceResponse()
                  : passageResponse(),
              ),
              refusal: null,
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const result = await openaiProviders(
    "synthetic-test-key",
    "script",
    "speech",
    transport,
  ).script.generateDialogue({
    ...request(),
    source: { ...source, text, lines: [text] },
  });
  expect(result).toMatchObject({
    facts: expect.arrayContaining([
      expect.objectContaining({ quote: text, startLine: 1, endLine: 1 }),
    ]),
  });
  const schema = JSON.stringify(body.response_format);
  expect(schema).toContain("sourceLineId");
  expect(schema).not.toContain("startLine");
  expect(schema).not.toContain('"quote"');
});
it("rejects a source-line ID that is not present, without retries", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(referenceResponse("L99999")),
                refusal: null,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    openaiProviders(
      "synthetic-test-key",
      "script",
      "speech",
      transport,
    ).script.generateDialogue(request()),
  ).rejects.toMatchObject({ code: "PROVIDER" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("writes dialogue from locally grounded evidence rather than resending the full plan", async () => {
  const requests: Record<string, unknown>[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content =
      requests.length === 1 ? referenceResponse() : passageResponse();
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(content), refusal: null },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  await openaiProviders(
    "synthetic-test-key",
    "script",
    "speech",
    transport,
  ).script.generateDialogue({
    ...request(),
    source: {
      ...source,
      text: "Source data\nUNSELECTED SOURCE LINE",
      lines: ["Source data", "UNSELECTED SOURCE LINE"],
    },
  });
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]!.messages)).toContain(
    "UNSELECTED SOURCE LINE",
  );
  expect(JSON.stringify(requests[1]!.messages)).not.toContain(
    "UNSELECTED SOURCE LINE",
  );
  expect(JSON.stringify(requests[1]!.messages)).toContain("Source data");
  expect(requests[1]!.response_format).toMatchObject({
    json_schema: { name: "plancast_passages" },
  });
});
it("rejects missing evidence coverage before writing dialogue", async () => {
  const evidence = referenceResponse();
  evidence.risks = { summary: "A risk", facts: [] };
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(evidence), refusal: null },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    openaiProviders(
      "synthetic-test-key",
      "script",
      "speech",
      transport,
    ).script.generateDialogue(request()),
  ).rejects.toMatchObject({ code: "PROVIDER" });
  expect(transport).toHaveBeenCalledTimes(1);
});
