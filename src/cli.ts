#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { PlancastError } from "./domain/errors.js";
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const program = new Command()
  .name("plancast")
  .version("0.5.0")
  .description(
    "Turn documents and public articles into grounded two-host audio briefings",
  )
  .argument(
    "<source>",
    "Markdown/text file (2 MB), text-based PDF (20 MB), or public article URL",
  )
  .option(
    "--provider <provider>",
    "Generation provider: local (default), openai, or gemini",
  )
  .option(
    "--framing <mode>",
    "Conversation framing: auto (content-based), plan, or document",
    "auto",
  )
  .option("--length <length>", "Briefing length (2m supported)", "2m")
  .option("--output <path>", "Destination M4A file")
  .option("--play", "Open the completed briefing in your default browser")
  .option("--force", "Replace existing output and sidecars")
  .option(
    "--yes",
    "Acknowledge sending source/dialogue to the selected cloud provider and API charges",
  )
  .option("--dry-run", "Validate locally without network requests or writes")
  .option("--json", "Machine-readable stdout; progress goes to stderr")
  .option("--debug", "Retain temporary artifacts on generation failure")
  .exitOverride()
  .action(async (source, options) => {
    const { generate } = await import("./generate.js");
    const result = await generate(source, options, abort.signal);
    process.stdout.write(
      options.json
        ? JSON.stringify(result) + "\n"
        : result.status === "dry_run"
          ? JSON.stringify(result, null, 2) + "\n"
          : `Created ${result.audioPath} (${result.actualDurationSeconds?.toFixed(1)} seconds)\nScript: ${result.scriptPath}\nManifest: ${result.manifestPath}\n`,
    );
  });
program
  .command("listen")
  .description("Open an existing audio file in the local browser player")
  .argument("<audio>", "Existing M4A, WAV, or MP3 file")
  .action(async (audio: string) => {
    const { playAudio } = await import("./audio/play.js");
    await playAudio(audio, abort.signal);
  });
program
  .command("setup-local")
  .description(
    "Install verified llama.cpp, the selected Qwen model, and Pocket TTS voices",
  )
  .option(
    "--model <id>",
    "Download and save a writing model: qwen3:4b, qwen3:8b, or qwen3:14b",
  )
  .option("--yes", "Skip model selection and use the selected/default model")
  .action(async (options: { model?: string; yes?: boolean }) => {
    const { setupLocal } = await import("./commands/setup-local.js");
    await setupLocal(options, abort.signal);
  });
program
  .command("models")
  .description("List curated local models, storage paths, and download status")
  .action(async () => {
    const { modelCatalog, modelAsset, verifyGguf, LLAMA_VERSION } =
      await import("./runtime/assets.js");
    const { config } = await import("./config.js");
    const selected = config(process.env, "local").scriptModel;
    process.stdout.write(
      `Managed llama.cpp ${LLAMA_VERSION}; selected model: ${selected}\n`,
    );
    for (const id of Object.keys(modelCatalog)) {
      const asset = modelAsset(id);
      const installed = await verifyGguf(asset.path, asset.bytes).then(
        () => true,
        () => false,
      );
      process.stdout.write(
        `${id === selected ? "*" : " "} ${id}  ${(asset.bytes / 1e9).toFixed(1)} GB  ${installed ? "installed" : "not installed"}\n  ${asset.path}\n`,
      );
    }
    process.stdout.write(
      "Choose and save: plancast setup-local\nWithout a prompt: plancast setup-local --model qwen3:8b\nPLANCAST_LOCAL_SCRIPT_MODEL overrides the saved choice.\n",
    );
  });
program
  .command("preview-voices")
  .description(
    "Generate a short local two-voice sample without a plan or writing model",
  )
  .option("--play", "Open the sample in the browser player")
  .action(async (options: { play?: boolean }) => {
    const { previewVoices } = await import("./audio/voice-preview.js");
    const result = await previewVoices(abort.signal, options.play);
    process.stdout.write(
      `Voice preview: ${result.path} (${result.duration.toFixed(1)} seconds)\n`,
    );
  });
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    const known = error instanceof PlancastError;
    const code = abort.signal.aborted
      ? "INTERRUPTED"
      : known
        ? error.code
        : "INTERNAL";
    const message = abort.signal.aborted
      ? "Interrupted."
      : known
        ? error.message
        : "Unexpected local failure. Check output permissions and available disk space.";
    if (program.opts().json)
      process.stdout.write(
        JSON.stringify({ status: "error", code, message }) + "\n",
      );
    else process.stderr.write(`plancast: ${message}\n`);
    process.exitCode = abort.signal.aborted ? 130 : known ? error.exitCode : 1;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
