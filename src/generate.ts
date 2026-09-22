import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { readSource, hash } from "./input/markdown.js";
import {
  validateDialogue,
  scriptText,
  wordCount,
} from "./dialogue/validate.js";
import { geminiProviders } from "./providers/gemini.js";
import { config } from "./config.js";
import { openaiProviders, PROMPT_VERSION } from "./providers/openai.js";
import { llamaScript, LOCAL_PROMPT_VERSION } from "./providers/llama.js";
import { pocketSpeech } from "./providers/pocket.js";
import type { ScriptProvider, SpeechProvider } from "./providers/contracts.js";
import { balanceSpeech, SPEECH_PROCESSING_VERSION } from "./audio/speech.js";
import { assemble, localAudio, type AudioTools } from "./audio/local.js";
import { checkOutputs, publish } from "./artifacts/publish.js";
import { PlancastError, interrupted } from "./domain/errors.js";
export interface Options {
  length: string;
  provider?: string;
  output?: string;
  play?: boolean;
  force?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  debug?: boolean;
}
export interface Dependencies {
  providers?: { script: ScriptProvider; speech: SpeechProvider };
  audio?: AudioTools;
  acknowledge?: () => Promise<boolean>;
  log?: (message: string) => void;
}
const manifestSchema = z.object({
  version: z.literal(1),
  sourceSha256: z.string().length(64),
  source: z
    .object({
      kind: z.string(),
      location: z.string(),
      title: z.string().optional(),
      extractedText: z.string().optional(),
      originalSha256: z.string().optional(),
      pages: z
        .array(
          z.object({
            page: z.number(),
            startLine: z.number(),
            endLine: z.number(),
          }),
        )
        .optional(),
    })
    .optional(),
  scriptSha256: z.string().length(64),
  audioSha256: z.string().length(64),
  promptVersion: z.string(),
  scriptProvider: z.string(),
  speechProcessing: z.string(),
  scriptRuntimeVersion: z.string().optional(),
  scriptModelSha256: z.string().optional(),
  scriptModel: z.string(),
  speechProvider: z.string(),
  speechModel: z.string(),
  voiceA: z.string(),
  voiceB: z.string(),
  speed: z.number().min(0.85).max(1.15),
  targetLength: z.literal("2m"),
  actualDurationSeconds: z.number().min(110).max(140),
  wordCount: z.number().int().positive(),
  createdAt: z.string(),
  cacheStatus: z.literal("disabled"),
});
export async function generate(
  sourcePath: string,
  options: Options,
  signal: AbortSignal,
  dependencies: Dependencies = {},
) {
  const log =
    dependencies.log ?? ((text: string) => process.stderr.write(`${text}\n`));
  if (options.length !== "2m")
    throw new PlancastError(
      "ARGUMENT",
      "This milestone supports --length 2m only.",
      2,
    );
  const isUrl = /^https?:\/\//i.test(sourcePath);
  if (isUrl && !options.dryRun)
    log(
      "Fetching public article: the website receives a request from this Mac. Extraction and local generation stay on this Mac.",
    );
  const source = await readSource(sourcePath, signal, !options.dryRun);
  const defaultStem = isUrl
    ? `article-${hash(sourcePath).slice(0, 12)}`
    : source.path.slice(0, -extname(source.path).length);
  const settings = config(process.env, options.provider);
  const local = settings.provider === "local";
  const gemini = settings.provider === "gemini";
  const cloudName = gemini ? "Google Gemini" : "OpenAI";
  const keyName = gemini ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const audioPath = resolve(options.output ?? defaultStem + ".plancast.m4a");
  if (extname(audioPath).toLowerCase() !== ".m4a")
    throw new PlancastError("ARGUMENT", "--output must end in .m4a.", 2);
  const stem = audioPath.slice(0, -4);
  const paths = [audioPath, `${stem}.txt`, `${stem}.json`];
  await checkOutputs(paths, !!options.force);
  const preflight = {
    sourcePath: source.path,
    sourceKind: source.kind ?? "markdown",
    targetLength: "2m",
    scriptProvider: local ? "llama.cpp" : settings.provider,
    speechProvider: local ? "pocket-tts" : settings.provider,
    ...settings,
    contentLeavesMac: !local,
    outputPath: audioPath,
    wouldUseCache: false,
  };
  if (options.dryRun) return { status: "dry_run", ...preflight };
  interrupted(signal);
  const audio = dependencies.audio ?? localAudio;
  await audio.preflight();
  if (!local && !dependencies.providers && !process.env[keyName]?.trim())
    throw new PlancastError(
      "CREDENTIALS",
      `Set ${keyName} in your environment before generating. --dry-run needs no key.`,
      3,
    );
  if (local)
    log(
      "Local generation: Qwen via managed llama.cpp and Pocket TTS run on this Mac. No cloud API calls or charges. Voices are AI-generated.",
    );
  else
    log(
      `Cloud disclosure: source content leaves this Mac for ${cloudName} script generation; dialogue text goes to ${cloudName} speech synthesis. Your API account pays for usage. Voices are AI-generated.`,
    );
  if (!local && !options.yes) {
    const acknowledge =
      dependencies.acknowledge ??
      (async () => {
        if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          return /^y(es)?$/i.test(
            (await rl.question("Continue? [y/N] ", { signal })).trim(),
          );
        } finally {
          rl.close();
        }
      });
    if (!(await acknowledge()))
      throw new PlancastError(
        "ACKNOWLEDGEMENT",
        "Cloud use was not acknowledged. Use --yes to acknowledge in automation.",
        3,
      );
  }
  const providers =
    dependencies.providers ??
    (local
      ? {
          script: llamaScript(settings.scriptModel, fetch, log),
          speech: pocketSpeech(),
        }
      : (gemini ? geminiProviders : openaiProviders)(
          process.env[keyName]!,
          settings.scriptModel,
          settings.speechModel,
        ));
  await mkdir(dirname(audioPath), { recursive: true });
  const temp = await mkdtemp(`${dirname(audioPath)}/.plancast-`);
  let committed = false;
  let retainForRecovery = false;
  try {
    let targetWords = local ? 350 : 280;
    let pacingRate = 1;
    let feedback: string | undefined;
    let result: Awaited<ReturnType<AudioTools["convert"]>> | undefined;
    let dialogue: ReturnType<typeof validateDialogue> | undefined;
    // One correction pass total, shared by script-budget and measured-duration correction.
    for (let pass = 0; pass < 2; pass++) {
      interrupted(signal);
      log(
        pass
          ? "Adjusting briefing length once…"
          : "Generating grounded dialogue…",
      );
      try {
        dialogue = validateDialogue(
          await providers.script.generateDialogue({
            source,
            targetWords,
            signal,
            ...(feedback ? { feedback } : {}),
          }),
          source,
          targetWords,
        );
      } catch (error) {
        if (
          pass === 0 &&
          error instanceof PlancastError &&
          error.code === "WORD_BUDGET"
        ) {
          feedback = `The previous attempt failed: ${error.message} Rewrite to exactly ${targetWords} spoken words. Count only turns, not summary or facts. Keep all decision-critical content, shorten questions and remove repetition.`;
          continue;
        }
        throw error;
      }
      const pcmTurns: Buffer[] = [];
      for (const [index, turn] of dialogue.turns.entries()) {
        interrupted(signal);
        log(`Rendering voice ${index + 1}/${dialogue.turns.length}…`);
        pcmTurns.push(
          await providers.speech.synthesize({
            text: turn.text,
            voice:
              turn.speaker === "HOST_A" ? settings.voiceA : settings.voiceB,
            signal,
          }),
        );
      }
      result = await audio.convert(
        assemble(pcmTurns.map(balanceSpeech)),
        temp,
        signal,
      );
      if (result.duration >= 110 && result.duration <= 140) break;
      if (
        local &&
        pass === 0 &&
        audio.pace &&
        result.duration >= 94 &&
        result.duration <= 160
      ) {
        pacingRate = Math.max(0.85, Math.min(1.15, result.duration / 125));
        log(
          `Adjusting local narration pace to ${pacingRate.toFixed(2)}× without changing pitch…`,
        );
        result = await audio.pace(temp, pacingRate, signal);
        if (result.duration >= 110 && result.duration <= 140) break;
        throw new PlancastError(
          "DURATION",
          "Audio remains outside 110–140 seconds after bounded pacing. No artifacts were published.",
          5,
        );
      }
      if (pass === 1)
        throw new PlancastError(
          "DURATION",
          "Audio remains outside 110–140 seconds after one correction. No final artifacts were published.",
          5,
        );
      targetWords = Math.round(
        (wordCount(dialogue.turns.map((t) => t.text).join(" ")) * 125) /
          result.duration,
      );
      if (targetWords < 180 || targetWords > (local ? 600 : 400))
        throw new PlancastError(
          "DURATION",
          "Speech duration was implausible. No final artifacts were published.",
          5,
        );
    }
    if (!dialogue || !result)
      throw new PlancastError("AUDIO", "No validated audio was produced.", 5);
    interrupted(signal);
    const text = scriptText(dialogue);
    const manifest = manifestSchema.parse({
      version: 1,
      sourceSha256: source.sha256,
      source: {
        kind: source.kind ?? "markdown",
        location: source.path,
        title: source.title,
        ...(source.kind && source.kind !== "markdown"
          ? {
              extractedText: source.text,
              pages: source.pages,
              originalSha256: source.originalSha256,
            }
          : {}),
      },
      scriptSha256: hash(text),
      audioSha256: hash(await readFile(result.path)),
      promptVersion: local ? LOCAL_PROMPT_VERSION : PROMPT_VERSION,
      scriptProvider: providers.script.id,
      scriptModel: providers.script.model,
      scriptRuntimeVersion: providers.script.runtimeVersion,
      scriptModelSha256: providers.script.modelSha256,
      speechProvider: providers.speech.id,
      speechModel: providers.speech.model,
      speechProcessing: SPEECH_PROCESSING_VERSION,
      voiceA: settings.voiceA,
      voiceB: settings.voiceB,
      speed: pacingRate,
      targetLength: "2m",
      actualDurationSeconds: result.duration,
      wordCount: wordCount(dialogue.turns.map((t) => t.text).join(" ")),
      createdAt: new Date().toISOString(),
      cacheStatus: "disabled",
    });
    await writeFile(`${temp}/script.txt`, text, { mode: 0o600 });
    await writeFile(
      `${temp}/manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    interrupted(signal);
    await publish(
      [result.path, `${temp}/script.txt`, `${temp}/manifest.json`],
      paths,
      !!options.force,
    );
    committed = true;
    let played = false;
    if (options.play) {
      log("Starting local playback…");
      try {
        await audio.play(audioPath, signal);
        played = true;
      } catch {
        interrupted(signal);
        log(
          `Audio created, but playback failed. Open ${audioPath} in QuickTime Player.`,
        );
      }
    }
    return {
      status: "success",
      sourcePath: source.path,
      audioPath,
      scriptPath: paths[1],
      manifestPath: paths[2],
      targetLength: "2m",
      actualDurationSeconds: result.duration,
      cacheStatus: "disabled",
      played,
    };
  } catch (error) {
    retainForRecovery =
      error instanceof PlancastError && error.code === "RECOVERY";
    if ((options.debug || retainForRecovery) && !committed)
      log(
        `Debug artifacts retained locally at ${temp} (may contain generated dialogue/audio).`,
      );
    throw error;
  } finally {
    await providers.script.dispose?.();
    await providers.speech.dispose?.();
    if (!retainForRecovery && (committed || !options.debug))
      await rm(temp, { recursive: true, force: true });
  }
}
