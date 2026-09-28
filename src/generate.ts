import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { readSource, normalizedSource, hash } from "./input/markdown.js";
import { readSources } from "./input/sources.js";
import { lengthProfile } from "./dialogue/length.js";
import {
  validateDialogue,
  scriptText,
  wordCount,
} from "./dialogue/validate.js";
import { geminiProviders } from "./providers/gemini.js";
import { pipelineConfig } from "./config.js";
import { openaiProviders, PROMPT_VERSION } from "./providers/openai.js";
import { llamaScript, LOCAL_PROMPT_VERSION } from "./providers/llama.js";
import { pocketSpeech } from "./providers/pocket.js";
import type { ScriptProvider, SpeechProvider } from "./providers/contracts.js";
import {
  speechSegments,
  SPEECH_SEGMENTATION_VERSION,
} from "./audio/segments.js";
import { balanceSpeech, SPEECH_PROCESSING_VERSION } from "./audio/speech.js";
import { assemble, localAudio, type AudioTools } from "./audio/local.js";
import { checkOutputs, exists, publish } from "./artifacts/publish.js";
import {
  draftEnvelope,
  readDraft,
  validateDraft,
  type Draft,
} from "./artifacts/draft.js";
import { cacheKey, readCache, writeCache } from "./artifacts/cache.js";
import { modelAsset, LLAMA_VERSION } from "./runtime/assets.js";
import { PlancastError, interrupted } from "./domain/errors.js";
export interface Options {
  length: string;
  provider?: string;
  scriptProvider?: string;
  speechProvider?: string;
  framing?: string;
  audience?: string;
  focus?: string;
  output?: string;
  play?: boolean;
  force?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  debug?: boolean;
  transcriptOnly?: boolean;
  fromDraft?: boolean;
  cache?: boolean;
}
export interface Dependencies {
  providers?: { script: ScriptProvider; speech: SpeechProvider };
  audio?: AudioTools;
  acknowledge?: () => Promise<boolean>;
  log?: (message: string) => void;
  cacheDirectory?: string;
}
export interface GenerationResult {
  status: string;
  sourcePath: string;
  targetLength: string;
  audioPath?: string;
  scriptPath?: string;
  manifestPath?: string;
  actualDurationSeconds?: number;
  cacheStatus?: string;
  played?: boolean;
  [key: string]: unknown;
}
export async function acknowledgeCloud(signal: AbortSignal) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test(
      (await rl.question("Continue? [y/N] ", { signal })).trim(),
    );
  } finally {
    rl.close();
  }
}
export async function generate(
  sourceInput: string | string[],
  options: Options,
  signal: AbortSignal,
  dependencies: Dependencies = {},
): Promise<GenerationResult> {
  const sourcePaths = Array.isArray(sourceInput) ? sourceInput : [sourceInput];
  const sourcePath = sourcePaths[0]!;
  const log =
    dependencies.log ?? ((text: string) => process.stderr.write(`${text}\n`));
  const requestedProfile = lengthProfile(options.length);
  const framingResult = z
    .enum(["auto", "plan", "document"])
    .safeParse(options.framing ?? "auto");
  if (!framingResult.success)
    throw new PlancastError(
      "ARGUMENT",
      "Choose --framing auto, plan, or document.",
      2,
    );
  const audienceResult = z
    .enum(["general", "technical", "plain-English", "executive"])
    .safeParse(options.audience ?? "general");
  if (!audienceResult.success)
    throw new PlancastError(
      "ARGUMENT",
      "Choose --audience general, technical, plain-English, or executive.",
      2,
    );
  if (
    options.focus !== undefined &&
    (!options.focus.trim() ||
      options.focus.length > 500 ||
      /[\u0000-\u001f]/.test(options.focus))
  )
    throw new PlancastError(
      "ARGUMENT",
      "--focus must contain 1–500 characters without control characters.",
      2,
    );
  if (options.transcriptOnly && options.play)
    throw new PlancastError(
      "ARGUMENT",
      "--play requires audio; omit it with --transcript-only.",
      2,
    );
  let draft = options.fromDraft ? await readDraft(sourcePath) : undefined;
  const audience = draft?.audience ?? audienceResult.data;
  const focus = draft?.focus ?? options.focus;
  const profile = draft ? lengthProfile(draft.targetLength) : requestedProfile;
  const framing = draft?.framing ?? framingResult.data;
  const isUrl = sourcePaths.some((path) => /^https?:\/\//i.test(path));
  if (isUrl && !options.dryRun)
    log(
      "Fetching public article: the website receives a request from this Mac. Extraction happens locally.",
    );
  const source = draft
    ? normalizedSource(draft.source.text, draft.source.path, draft.source)
    : await readSources(sourcePaths, signal, !options.dryRun);
  const defaultStem =
    sourcePaths.length > 1
      ? resolve("briefing-" + source.sha256.slice(0, 12) + ".plancast")
      : options.fromDraft
        ? resolve(sourcePath).replace(/\.json$/i, "") + ".rendered"
        : isUrl
          ? `article-${hash(sourcePath).slice(0, 12)}.plancast`
          : source.path.slice(0, -extname(source.path).length) + ".plancast";
  const settings = pipelineConfig(process.env, options, !!options.fromDraft);
  const scriptLocal = settings.scriptProvider === "local";
  const local = settings.speechProvider === "local";
  const cloudName = (provider: string) =>
    provider === "gemini" ? "Google Gemini" : "OpenAI";
  const keyName = (provider: string) =>
    provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const transcriptOnly = !!options.transcriptOnly;
  const outputPath = resolve(
    options.output ?? defaultStem + (transcriptOnly ? ".txt" : ".m4a"),
  );
  if (extname(outputPath).toLowerCase() !== (transcriptOnly ? ".txt" : ".m4a"))
    throw new PlancastError(
      "ARGUMENT",
      transcriptOnly
        ? "--output must end in .txt for transcript-only generation."
        : "--output must end in .m4a.",
      2,
    );
  const stem = outputPath.slice(0, -4);
  const paths = transcriptOnly
    ? [`${stem}.txt`, `${stem}.json`]
    : [outputPath, `${stem}.txt`, `${stem}.json`];
  const inputLocations = options.fromDraft
    ? [resolve(sourcePath)]
    : (source.sources?.map((item) => item.path) ?? [source.path]);
  const realInputs = await Promise.all(
    inputLocations.map((path) => realpath(path).catch(() => path)),
  );
  const realOutputs = await Promise.all(
    paths.map((path) => realpath(path).catch(() => path)),
  );
  if (realOutputs.some((path) => realInputs.includes(path)))
    throw new PlancastError(
      "OVERWRITE",
      "Outputs must not replace an input document or draft. Choose another --output.",
      6,
    );
  // Injected adapters must opt into an isolated cache, never populate the user's cache.
  const useCache =
    options.cache !== false &&
    (!dependencies.providers || !!dependencies.cacheDirectory);
  const promptVersion = scriptLocal ? LOCAL_PROMPT_VERSION : PROMPT_VERSION;
  const scriptKey = cacheKey({
    version: 1,
    source: source.sha256,
    sourceMetadata: {
      kind: source.kind,
      title: source.title,
      pages: source.pages,
      originalSha256: source.originalSha256,
    },
    sources: source.sources,
    location: source.path,
    length: profile.length,
    framing,
    audience,
    focus,
    promptVersion,
    provider: settings.scriptProvider,
    model: settings.scriptModel,
    ...(scriptLocal && !options.fromDraft
      ? {
          runtime: LLAMA_VERSION,
          modelSha256: modelAsset(settings.scriptModel).sha256,
        }
      : {}),
  });
  let scriptHit = false;
  if (!draft && useCache) {
    try {
      draft = validateDraft(
        await readCache(scriptKey, dependencies.cacheDirectory),
      );
      scriptHit = true;
    } catch {
      /* Missing or corrupt entries are regenerated. */
    }
  }
  const audioKeyFor = (value: Draft) =>
    cacheKey({
      version: 1,
      draft: hash(JSON.stringify(value)),
      provider: settings.speechProvider,
      model: settings.speechModel,
      voiceA: settings.voiceA,
      voiceB: settings.voiceB,
      processing: SPEECH_PROCESSING_VERSION,
      segmentation: SPEECH_SEGMENTATION_VERSION,
      length: profile.length,
      format: "aac-48000-m4a",
      pacing: "bounded-v1",
    });
  const audio = dependencies.audio ?? localAudio;
  type AudioCache = { audio: string; manifest: Record<string, unknown> };
  let cached: AudioCache | undefined;
  if (draft && useCache && !transcriptOnly) {
    try {
      const raw = z
        .object({
          audio: z.string(),
          manifest: z.record(z.string(), z.unknown()),
        })
        .parse(
          await readCache(audioKeyFor(draft), dependencies.cacheDirectory),
        );
      const bytes = Buffer.from(raw.audio, "base64");
      const duration = Number(raw.manifest.actualDurationSeconds);
      if (
        bytes.length < 1024 ||
        hash(bytes) !== raw.manifest.audioSha256 ||
        raw.manifest.scriptSha256 !== draft.scriptSha256 ||
        raw.manifest.draftSha256 !== hash(JSON.stringify(draft)) ||
        duration < profile.min ||
        duration > profile.max ||
        !Number.isFinite(duration)
      )
        throw new Error("Invalid cached audio");
      cached = raw;
    } catch {
      /* A cache entry is optional and never bypasses validation. */
    }
  }
  const preflight = {
    sourcePath: source.path,
    sourceKind: source.kind ?? "markdown",
    sources: source.sources?.map(({ id, path, sha256 }) => ({
      id,
      path,
      sha256,
    })),
    framing,
    audience,
    focus,
    targetLength: profile.length,
    ...settings,
    scriptModel: draft?.scriptModel ?? settings.scriptModel,
    scriptProvider:
      draft?.scriptProvider ??
      (scriptLocal ? "llama.cpp" : settings.scriptProvider),
    speechProvider: transcriptOnly
      ? "none"
      : local
        ? "pocket-tts"
        : settings.speechProvider,
    contentLeavesMac:
      (!scriptLocal && !draft) || (!local && !transcriptOnly && !cached),
    outputPath,
    wouldUseCache: !!cached || scriptHit,
    transcriptOnly,
  };
  if (options.dryRun) return { status: "dry_run", ...preflight };
  const exactHit = !!cached || (transcriptOnly && scriptHit);
  if (!exactHit) await checkOutputs(paths, !!options.force);
  interrupted(signal);
  const needScript = !draft;
  const needSpeech = !transcriptOnly && !cached;
  if (needSpeech) await audio.preflight();
  const remoteScript = needScript && !scriptLocal;
  const remoteSpeech = needSpeech && !local;
  if (remoteScript || remoteSpeech) {
    for (const provider of new Set([
      ...(remoteScript ? [settings.scriptProvider] : []),
      ...(remoteSpeech ? [settings.speechProvider] : []),
    ])) {
      const key = keyName(provider);
      if (!dependencies.providers && !process.env[key]?.trim())
        throw new PlancastError(
          "CREDENTIALS",
          `Set ${key} in your environment before generating. --dry-run needs no key.`,
          3,
        );
    }
    log(
      `Cloud disclosure: ${remoteScript ? `source content leaves this Mac for ${cloudName(settings.scriptProvider)} script generation; ` : ""}${remoteSpeech ? `dialogue text goes to ${cloudName(settings.speechProvider)} speech synthesis. ` : ""}${needScript && scriptLocal ? "Source analysis stays on this Mac. " : ""}${needSpeech && local ? "Speech runs locally on this Mac. " : ""}Your API account pays for usage. Voices are AI-generated.`,
    );
    if (
      !options.yes &&
      !(await (dependencies.acknowledge ?? (() => acknowledgeCloud(signal)))())
    )
      throw new PlancastError(
        "ACKNOWLEDGEMENT",
        "Cloud use was not acknowledged. Use --yes to acknowledge in automation.",
        3,
      );
  } else if (needScript || needSpeech)
    log(
      "Local generation: Qwen via managed llama.cpp and Pocket TTS run on this Mac. No cloud API calls or charges. Voices are AI-generated.",
    );
  function cloud(provider: string) {
    return (provider === "gemini" ? geminiProviders : openaiProviders)(
      process.env[keyName(provider)]!,
      settings.scriptModel,
      settings.speechModel,
    );
  }
  const providers = dependencies.providers ?? {
    script: needScript
      ? scriptLocal
        ? llamaScript(settings.scriptModel, fetch, log)
        : cloud(settings.scriptProvider).script
      : ({
          id: draft?.scriptProvider ?? "unused",
          model: draft?.scriptModel ?? "unused",
          generateDialogue: async () => {
            throw new Error("Writing a reused draft is disabled");
          },
        } as ScriptProvider),
    speech: needSpeech
      ? local
        ? pocketSpeech()
        : cloud(settings.speechProvider).speech
      : ({
          id: "unused",
          model: "unused",
          synthesize: async () => {
            throw new Error("Speech is disabled");
          },
        } as SpeechProvider),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  const temp = await mkdtemp(`${dirname(outputPath)}/.plancast-`);
  let committed = false;
  let retainForRecovery = false;
  try {
    let targetWords: number = draft?.targetWords ?? profile.words;
    let pacingRate = 1;
    let feedback: string | undefined;
    let result: { path: string; duration: number } | undefined;
    if (cached) {
      await writeFile(
        `${temp}/audio.m4a`,
        Buffer.from(cached.audio, "base64"),
        { mode: 0o600 },
      );
      result = {
        path: `${temp}/audio.m4a`,
        duration: Number(cached.manifest.actualDurationSeconds),
      };
      log("Cache hit: reusing validated audio and dialogue.");
    } else {
      for (let pass = 0; pass < 2; pass++) {
        interrupted(signal);
        if (!draft) {
          log(
            pass
              ? "Adjusting briefing length once…"
              : "Generating grounded dialogue…",
          );
          try {
            const rawDialogue = await providers!.script.generateDialogue({
              source,
              framing,
              audience,
              ...(focus ? { focus } : {}),
              targetWords,
              signal,
              ...(feedback ? { feedback } : {}),
            });
            if (options.debug)
              await writeFile(
                `${temp}/dialogue-pass-${pass + 1}.json`,
                JSON.stringify(rawDialogue, null, 2),
                { mode: 0o600 },
              );
            const dialogue = validateDialogue(rawDialogue, source, targetWords);
            draft = validateDraft({
              version: 1,
              source,
              dialogue,
              targetWords,
              targetLength: profile.length,
              framing,
              audience,
              focus,
              promptVersion,
              scriptProvider: providers!.script.id,
              scriptModel: providers!.script.model,
              scriptRuntimeVersion: providers!.script.runtimeVersion,
              scriptModelSha256: providers!.script.modelSha256,
              scriptSha256: hash(scriptText(dialogue)),
            });
          } catch (error) {
            if (
              pass === 0 &&
              error instanceof PlancastError &&
              (error.code === "WORD_BUDGET" ||
                error.code === "DIALOGUE_REPETITION")
            ) {
              feedback = `The previous attempt failed: ${error.message} Rewrite to exactly ${targetWords} spoken words, preserving the main ideas and caveats. Use distinct source-supported details instead of repeating sentences. Do not invent facts or add filler.`;
              continue;
            }
            throw error;
          }
        } else log("Reusing validated dialogue; no writing-model request.");
        if (transcriptOnly) break;
        const turns: Buffer[] = [];
        for (const [index, turn] of draft.dialogue.turns.entries()) {
          interrupted(signal);
          log(`Rendering voice ${index + 1}/${draft.dialogue.turns.length}…`);
          const segments: Buffer[] = [];
          for (const text of speechSegments(turn.text)) {
            interrupted(signal);
            segments.push(
              await providers!.speech.synthesize({
                text,
                voice:
                  turn.speaker === "HOST_A" ? settings.voiceA : settings.voiceB,
                signal,
              }),
            );
          }
          turns.push(Buffer.concat(segments));
        }
        result = await audio.convert(
          assemble(turns.map(balanceSpeech)),
          temp,
          signal,
        );
        if (result.duration >= profile.min && result.duration <= profile.max)
          break;
        if (
          local &&
          pass === 0 &&
          audio.pace &&
          result.duration >= profile.min * 0.85 &&
          result.duration <= profile.max * 1.15
        ) {
          pacingRate = Math.max(
            0.85,
            Math.min(1.15, result.duration / profile.target),
          );
          log(
            `Adjusting local narration pace to ${pacingRate.toFixed(2)}× without changing pitch…`,
          );
          result = await audio.pace(temp, pacingRate, signal);
          if (result.duration >= profile.min && result.duration <= profile.max)
            break;
          throw new PlancastError(
            "DURATION",
            `Audio remains outside ${profile.min}–${profile.max} seconds after bounded pacing. No artifacts were published.`,
            5,
          );
        }
        if (pass === 1 || options.fromDraft || scriptHit)
          throw new PlancastError(
            "DURATION",
            `Audio is ${result.duration.toFixed(1)} seconds; expected ${profile.min}–${profile.max}. No artifacts were published. ${options.fromDraft ? "Choose another voice or regenerate the draft." : scriptHit ? "Use --no-cache to generate a new script for these voices." : "Try a different voice or source."}`,
            5,
          );
        targetWords = Math.round(
          (wordCount(draft.dialogue.turns.map((t) => t.text).join(" ")) *
            profile.target) /
            result.duration,
        );
        if (
          targetWords < profile.words * 0.64 ||
          targetWords > profile.words * (local ? 2.15 : 1.43)
        )
          throw new PlancastError(
            "DURATION",
            "Speech duration was implausible. No final artifacts were published.",
            5,
          );
        draft = undefined;
      }
    }
    if (!draft || (!transcriptOnly && !result))
      throw new PlancastError("AUDIO", "No validated result was produced.", 5);
    interrupted(signal);
    const text = scriptText(draft.dialogue);
    const cacheStatus = useCache ? (exactHit ? "hit" : "miss") : "disabled";
    const manifest = cached?.manifest ?? {
      version: 2,
      sourceSha256: source.sha256,
      source: {
        kind: source.kind ?? "markdown",
        sources: source.sources,
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
      ...draftEnvelope(draft),
      scriptSha256: draft.scriptSha256,
      framing,
      audience,
      focus,
      promptVersion: draft.promptVersion,
      scriptProvider: draft.scriptProvider,
      scriptModel: draft.scriptModel,
      scriptRuntimeVersion: draft.scriptRuntimeVersion,
      scriptModelSha256: draft.scriptModelSha256,
      ...(result
        ? {
            audioSha256: hash(await readFile(result.path)),
            speechProvider: providers!.speech.id,
            speechModel: providers!.speech.model,
            speechProcessing: SPEECH_PROCESSING_VERSION,
            speechSegmentation: SPEECH_SEGMENTATION_VERSION,
            voiceA: settings.voiceA,
            voiceB: settings.voiceB,
            speed: pacingRate,
            actualDurationSeconds: result.duration,
          }
        : {}),
      targetLength: profile.length,
      wordCount: wordCount(draft.dialogue.turns.map((t) => t.text).join(" ")),
      createdAt: new Date().toISOString(),
      cacheStatus,
      kind: transcriptOnly ? "draft" : "audio",
    };
    await writeFile(`${temp}/script.txt`, text, { mode: 0o600 });
    await writeFile(
      `${temp}/manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    if (!options.fromDraft) {
      const originals = source.sources ?? [
        { path: source.path, sha256: source.sha256, kind: source.kind },
      ];
      for (const original of originals) {
        if (original.kind === "article") continue;
        const current = await readSource(original.path, signal, false);
        if (current.sha256 !== original.sha256)
          throw new PlancastError(
            "INPUT",
            "A source document changed during generation. Save it and retry; no artifacts were published.",
            2,
          );
      }
    }
    const staged = [
      ...(result ? [result.path] : []),
      `${temp}/script.txt`,
      `${temp}/manifest.json`,
    ];
    let existingExact = false;
    if (exactHit && !options.force && (await exists(paths[0]!))) {
      try {
        const same = await Promise.all(
          paths.map(
            async (path, i) =>
              hash(await readFile(path)) === hash(await readFile(staged[i]!)),
          ),
        );
        // Transcript-only cache reuse may have a different creation timestamp.
        if (transcriptOnly && same[0]) {
          const previous = await readDraft(paths[1]!);
          existingExact =
            hash(JSON.stringify(previous)) === hash(JSON.stringify(draft));
        } else existingExact = same.every(Boolean);
      } catch {
        existingExact = false;
      }
    }
    interrupted(signal);
    if (!existingExact) await publish(staged, paths, !!options.force);
    committed = true;
    if (useCache && !exactHit) {
      try {
        if (!options.fromDraft)
          await writeCache(scriptKey, draft, dependencies.cacheDirectory);
        if (result)
          await writeCache(
            audioKeyFor(draft),
            {
              audio: (await readFile(result.path)).toString("base64"),
              manifest,
            },
            dependencies.cacheDirectory,
          );
      } catch {
        log("Artifacts created; optional cache storage failed.");
      }
    }
    let played = false;
    if (options.play && result) {
      try {
        await audio.play(outputPath, signal);
        played = true;
      } catch {
        interrupted(signal);
        log(
          `Audio created, but playback failed. Open ${outputPath} in QuickTime Player.`,
        );
      }
    }
    return {
      status: transcriptOnly ? "transcript" : "success",
      sourcePath: source.path,
      ...(result
        ? { audioPath: outputPath, actualDurationSeconds: result.duration }
        : {}),
      scriptPath: `${stem}.txt`,
      manifestPath: `${stem}.json`,
      targetLength: profile.length,
      cacheStatus,
      played,
    };
  } catch (error) {
    retainForRecovery =
      error instanceof PlancastError && error.code === "RECOVERY";
    if ((options.debug || retainForRecovery) && !committed)
      log(
        `Debug artifacts retained locally at ${temp} (may contain source text and generated dialogue/audio).`,
      );
    throw error;
  } finally {
    try {
      await providers?.script.dispose?.();
    } finally {
      try {
        await providers?.speech.dispose?.();
      } finally {
        if (!retainForRecovery && (committed || !options.debug))
          await rm(temp, { recursive: true, force: true });
      }
    }
  }
}
