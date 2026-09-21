# Plancast

**Turn a Markdown plan into a two-person audio briefing—then listen at your own pace.**

Plancast reads your plan, writes a grounded conversation, and creates an audio file with two distinct AI voices. Generation runs locally on your Mac by default. OpenAI is available as an explicit alternative.

```sh
plancast PLAN.md --play
```

**macOS 14+ · Standalone Apple Silicon installation · Local by default · Two-minute briefings**

## Contents

- [Quick start](#quick-start)
- [Everyday commands](#everyday-commands)
- [Choose and download a model](#choose-and-download-a-model)
- [Choose voices](#choose-voices)
- [Use OpenAI instead](#use-openai-instead)
- [Listen in your browser](#listen-in-your-browser)
- [Files and storage](#files-and-storage)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Limits and privacy](#limits-and-privacy)
- [Development](#development)

## Quick start

### 1. Install Plancast

With Homebrew on Apple Silicon:

```sh
brew install sarthakdabhi/tap/plancast
```

Homebrew installs the same bundled Node runtime and puts `plancast` on its PATH. Skip step 2 if `plancast --help` works. Update with `brew update && brew upgrade plancast`; uninstall with `brew uninstall plancast`. Downloaded models and generated audio remain.

Or install directly without Homebrew:

The standalone Apple Silicon archive includes its own **Node.js 24.21.0** runtime. You do not need Homebrew, npm, Node, uv, Python, FFmpeg, Ollama, or LM Studio installed separately.

Download the archive and checksum from [GitHub Releases](https://github.com/sarthakdabhi/plancast/releases/tag/v0.1.0), then run:

```sh
shasum -a 256 -c plancast-0.1.0-macos-arm64.tar.gz.sha256
tar -xzf plancast-0.1.0-macos-arm64.tar.gz
sh plancast-0.1.0-macos-arm64/install.command
```

The installer verifies file checksums, installs into `~/.local/share/plancast/cli/`, and creates `~/.local/bin/plancast`. It requires no administrator access and does not modify your shell configuration or replace unrelated commands.

Version 0.1.0 is an early prerelease. The archive is not a notarized installer. See [Development](#development) to build an archive or install from source. Apple Silicon is the validated target; Intel packaging and speech support remain unverified.

### 2. Make the command available

For the current terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
plancast --help
```

Add that export line to `~/.zshrc` to keep it for new terminals. If you previously used `npm link`, putting `~/.local/bin` first selects the standalone command. You can also run it directly as `"$HOME/.local/bin/plancast"` without changing PATH.

### 3. Download the local models once

```sh
plancast setup-local
```

This installs private, checksum-verified **uv 0.12.17**, **FFmpeg 7.1** (from imageio-ffmpeg 0.6.0), and **llama.cpp b11080** runtimes. It uses uv to install private **Python 3.12.13**, downloads **Qwen3 14B** (about 9.3 GB), installs **Pocket TTS 3.1.0** in its own Python environment, and downloads the speech model and the supported voices. Leave additional space for Python dependencies and speech assets.

If you already downloaded the exact supported Qwen3 weights with Ollama, setup verifies and copies them into Plancast storage instead of downloading again. Your Ollama files remain untouched.

Setup needs internet access. It does not send any plan content. You do not need an OpenAI account or API key for local generation. Repeat setup when downloading a different model or repairing missing assets, not before every briefing.

### 4. Generate your first briefing

Move to the directory containing your plan, or pass its full path:

```sh
plancast PLAN.md --length 2m --play
```

The CLI creates the audio, opens a local browser player, and returns to the terminal. Press **Play** if your browser blocks autoplay. Local generation can take several minutes, especially for long plans.

> **Already installed?** Start with `plancast PLAN.md --play`. To listen to a briefing you already generated, use `plancast listen PLAN.plancast.m4a`.

**Upgrading a source checkout?** After updating the source, run these commands inside the repository:

```sh
npm ci
npm run build
plancast setup-local
plancast preview-voices --play
```

For a standalone upgrade, extract the new archive and rerun its `install.command`, then run `plancast setup-local`. Existing models are reused. Setup installs missing managed tools and voice assets, then the preview command plays the current Jane/George defaults. Existing voice environment variables override those defaults. Previously generated audio keeps its original voices; regenerate with `--force` or a new `--output` to use the new pair.

## Everyday commands

| What you want | Command |
| --- | --- |
| Install or verify local runtime, models, and voices | `plancast setup-local` |
| List supported models and download status | `plancast models` |
| Preview the selected local voice pair | `plancast preview-voices --play` |
| Generate and open the player | `plancast PLAN.md --play` |
| Generate without opening the browser | `plancast PLAN.md` |
| Listen to existing audio | `plancast listen PLAN.plancast.m4a` |
| Regenerate and replace existing files | `plancast PLAN.md --play --force` |
| Save to another location | `plancast PLAN.md --output ./audio/briefing.m4a --play` |
| Inspect configuration without generation | `plancast PLAN.md --dry-run --json` |
| Return a machine-readable result | `plancast PLAN.md --json` |
| Keep temporary files after a failure | `plancast PLAN.md --debug` |
| Show all options | `plancast --help` |

Quote paths that contain spaces:

```sh
plancast "My Project/Implementation Plan.md" --play
```

**Generation and playback are separate.** Running `plancast PLAN.md` generates again; it does not replay or reuse existing audio. Use `listen` to replay without computation or API charges. Use `--force` only when you want to replace the existing audio and its sidecars.

Ctrl-C interrupts generation. Once the browser player is open, pause or close that tab to stop playback.

## Choose and download a model

Plancast uses two different kinds of models:

| Job | Local default | How to change it |
| --- | --- | --- |
| Understand the plan and write both speakers' lines | Qwen3 14B through managed llama.cpp | Set `PLANCAST_LOCAL_SCRIPT_MODEL` |
| Turn those lines into two voices | Pocket TTS 3.1.0 | The speech model is currently fixed; choose Jane, George, Alba, or Marius |

Changing the writing model changes the **writing**, not the voices. You only need one writing model for both speakers.

### Which Qwen3 size should I try?

| Plancast model ID | Approximate download | Plancast status |
| --- | ---: | --- |
| `qwen3:4b` | 2.5 GB | Smallest option listed here; experimental |
| `qwen3:8b` | 5.0 GB | A smaller alternative to try; not benchmarked here |
| **`qwen3:14b`** | **9.3 GB** | **Default; tested on an M2 Max with 64 GB RAM** |

These are pinned Q4_K_M GGUF files. The 14B weights come from the Ollama model registry; the 4B and 8B files come from [Qwen’s official GGUF repositories](https://huggingface.co/Qwen). Downloading from the registry does not require or run Ollama. Model IDs such as `qwen3:14b` are Plancast catalog aliases. Download size is **not** total RAM usage: context, runtime memory, macOS, and other apps also need space. Smaller models are worth testing on more constrained machines, but may have more difficulty with grounding or output constraints. A larger model is not a guaranteed quality improvement for this workflow.

### Download and use a smaller model

Set the model for your current terminal, then run setup and generation:

```sh
export PLANCAST_LOCAL_SCRIPT_MODEL="qwen3:8b"
plancast setup-local
plancast PLAN.md --play --output PLAN-qwen3-8b.m4a
```

**Keep the variable set for generation too.** Downloading a model does not automatically make it Plancast's default.

To select a model for just one generation after setup:

```sh
PLANCAST_LOCAL_SCRIPT_MODEL=qwen3:8b plancast PLAN.md --output PLAN-qwen3-8b.m4a --play
```

The inline variable applies to that one command. Use different output filenames to compare models. Setup verifies existing model files; it does not download matching weights again.

### Keep your choice across terminal sessions

Add this line to your `~/.zshrc`, then open a new terminal:

```sh
export PLANCAST_LOCAL_SCRIPT_MODEL="qwen3:8b"
```

To return to the built-in default, remove that line from `~/.zshrc` and clear it from the current terminal:

```sh
unset PLANCAST_LOCAL_SCRIPT_MODEL
```

Plancast currently reads environment variables; it does not automatically load a `.env` file or a project configuration file.

### Manage downloaded models

```sh
plancast models
```

This lists the supported models, selected model, download sizes, local paths, and whether each file is installed. Run `plancast setup-local` to verify its full checksum.

Models live in `~/Library/Application Support/Plancast/models/`. To reclaim disk space, delete an unused GGUF file from that folder in Finder. Generated audio is independent of model files. Select another installed model or rerun setup before generating again.

### How the managed runtime works

- Setup downloads a specific llama.cpp release and checks its pinned SHA-256 before extraction. Model downloads are also checksum-verified before publication.
- Generation loads only a local file from Plancast’s curated catalog. It does not download assets or fall back to the cloud.
- Plancast starts a private `llama-server` process on a temporary loopback port with a random authentication token, offline mode, and its web UI disabled.
- The process stops after success, failure, or interruption. A supervisor also stops it if the CLI disappears unexpectedly. No login service or always-on daemon is installed.
- The manifest records the llama.cpp version and model checksum. Setup and generation verify the model checksum; generation also checks file size and the GGUF header before loading.

Node is bundled in the standalone archive. llama.cpp, uv, FFmpeg, Python, the speech environment, and models are **managed by Plancast and downloaded during setup**. FFmpeg is invoked by its private absolute path; Python is installed inside Plancast’s data directory. These tools do not have to be available on your system PATH. Setup requires internet access; later local generation needs no cloud service.

Only the three catalog models above are supported in this version. Arbitrary GGUF files, other model families, remote servers, and cloud-backed models are not selectable. Kokoro and Qwen3-TTS are not integrated speech backends.

## Choose voices

Pocket TTS uses **Jane (female, conversational)** for Host A and **George (male, conversational)** for Host B. Alba and Marius remain available. The two selected voices must be different.

After upgrading from the Alba/Marius defaults, run `plancast setup-local` once to download Jane and George. Existing voice environment variables still take precedence over the defaults.

Preview the pair before generating a full podcast:

```sh
plancast preview-voices --play
```

This creates a short local conversation using your selected voices. It does not use your plan, the writing model, or a cloud API. Pocket TTS must already be installed with `setup-local`. Preview audio and its transcript are saved under `~/Library/Caches/Plancast/voice-previews/`.

Both podcasts and previews gently balance each turn's volume, reserve peak headroom, and apply short boundary fades to reduce clicks. They keep the existing 300 ms pause between speakers. The local speech worker avoids hard-clipping peaks before PCM conversion. These controls improve signal consistency; they do not guarantee natural pronunciation or human-like delivery. Listen to the preview to judge the voices, accent, and clarity on your headphones or speakers. Voices remain AI-generated.

To swap them for one briefing:

```sh
PLANCAST_LOCAL_VOICE_A=george PLANCAST_LOCAL_VOICE_B=jane \
  plancast PLAN.md --output PLAN-swapped-voices.m4a --play
```

Use the browser's speed selector to listen faster or slower. That does not change the saved audio. The supported local names are `jane`, `george`, `alba`, and `marius`. Voice cloning and other voices are not exposed by this CLI.

## Use OpenAI instead

Cloud mode uses `gpt-4.1-mini` to write the conversation and `gpt-4o-mini-tts` with Alloy and Nova for speech.

Set your API key in your shell, then explicitly select OpenAI:

```sh
export OPENAI_API_KEY="your-api-key"
plancast PLAN.md --provider openai --output PLAN-openai.m4a --play
```

**Your plan goes to OpenAI for dialogue generation, and dialogue text goes to OpenAI for speech synthesis. Your API account pays for usage.** A ChatGPT subscription does not include API credit. Keep keys out of source control.

The CLI displays a disclosure and asks for confirmation. For automation, acknowledge that disclosure with `--yes`:

```sh
plancast PLAN.md --provider openai --yes --output PLAN-openai.m4a --json
```

No key or `--yes` is required for local mode. Neither provider silently falls back to the other. Mixed local/cloud stages are not currently selectable.

## Listen in your browser

```sh
plancast listen PLAN.plancast.m4a
```

The local HTML player includes:

- Play/pause, a seekable timeline, and volume controls.
- Back/forward 10 seconds and restart.
- Playback speeds from 0.5× to 2×.

The terminal returns immediately. Close the browser tab to stop. If autoplay is blocked, click Play. Replay works without model servers or API credentials.

The page embeds a local copy of the audio. It uses no server, remote assets, or upload. `listen` accepts nonempty M4A, WAV, and MP3 files up to 50 MB. You can also open the original M4A in QuickTime Player.

## Files and storage

For `PLAN.md`, the default outputs are:

```text
PLAN.md                 Your original plan
PLAN.plancast.m4a       Generated audio
PLAN.plancast.txt       Host-labeled transcript of the generated dialogue
PLAN.plancast.json      Models, voices, duration, hashes, and pacing metadata
```

Using `--output ./audio/briefing.m4a` creates `briefing.m4a`, `briefing.txt`, and `briefing.json` in that directory. Existing audio **or either sidecar** blocks generation unless you pass `--force`.

| Data | Location |
| --- | --- |
| Standalone CLI and bundled Node | `~/.local/share/plancast/cli/` |
| Private uv and FFmpeg | `~/Library/Application Support/Plancast/tools/` |
| Private Python | `~/Library/Application Support/Plancast/python/` |
| Python download/package cache | `~/Library/Application Support/Plancast/cache/uv/` |
| Generated briefing and sidecars | Beside the source, or at `--output` |
| Pocket TTS Python environment | `~/Library/Application Support/Plancast/pocket-tts-3.1.0-managed/` |
| Writing-model downloads | `~/Library/Application Support/Plancast/models/` |
| Managed llama.cpp runtime | `~/Library/Application Support/Plancast/llama.cpp-b11080-<arch>/` |
| Speech-model assets | Library-managed Hugging Face / Pocket TTS caches |
| Self-contained browser-player copies | `~/Library/Caches/Plancast/players/` |
| Voice-preview audio and transcripts | `~/Library/Caches/Plancast/voice-previews/` |

Browser-player copies remain until you remove them; deleting them does not delete the original M4A. These copies contain the audio, so treat them like your generated files.

Temporary generation files are removed after success or failure. `--debug` retains failed-generation files and reports their location. Completed output is staged and validated before publication; ordinary publication failures roll back. The manifest is published last. Publication is not a single crash-atomic transaction across all three files—see [validation notes](docs/VALIDATION.md).

## Configuration reference

| Setting | Default | Applies to |
| --- | --- | --- |
| `PLANCAST_PROVIDER` | `local` | Provider selection; `--provider` takes precedence |
| `PLANCAST_LOCAL_SCRIPT_MODEL` | `qwen3:14b` | Local writing model |
| `PLANCAST_LOCAL_VOICE_A` | `jane` | Local Host A |
| `PLANCAST_LOCAL_VOICE_B` | `george` | Local Host B |
| `OPENAI_API_KEY` | None | Required for OpenAI generation |
| `PLANCAST_SCRIPT_MODEL` | `gpt-4.1-mini` | OpenAI writing model |
| `PLANCAST_SPEECH_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model |
| `PLANCAST_VOICE_A` | `alloy` | OpenAI Host A |
| `PLANCAST_VOICE_B` | `nova` | OpenAI Host B |

Local and OpenAI voice settings are separate. Changing an OpenAI model requires compatibility with the adapter's structured-output or speech API contract. Available OpenAI voices also depend on the selected speech model.

Inspect the selected configuration without generating audio:

```sh
plancast PLAN.md --dry-run --json
```

Dry-run validates source/output arguments and reports configuration; it does not start llama.cpp or prove that the selected model is installed. It can still report an existing-output conflict; use a fresh `--output` path to inspect another configuration.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `plancast: command not found` | Add `~/.local/bin` to PATH or use `"$HOME/.local/bin/plancast"`. For a source installation, run `npm run build` and `npm link`. |
| Output or sidecar already exists | Use `listen` to replay, `--output` for a new copy, or `--force` to replace all three files. |
| Local GGUF model is missing or incomplete | Check `plancast models`, then run `plancast setup-local` with your selected model. |
| Managed runtime is missing | Run `plancast setup-local`. |
| Managed llama.cpp fails to load | Check available memory and run setup to verify the model. Try the smaller 8B model if needed. |
| Asset checksum failed | Retry setup; partial assets are not installed. |
| Another setup may be running | Wait for it to finish. After a hard crash, remove only the `.setup-llama.lock` directory named in the error if no setup is running. |
| Pocket TTS failed or is not installed | Run `plancast setup-local` to install dependencies and download the supported voices. |
| Local pacing needs the managed FFmpeg runtime | Run `plancast setup-local`, then retry. |
| Plan exceeds the local input limit | Split the plan into smaller sections, or explicitly choose OpenAI if sending it remotely is acceptable. |
| Word-budget, schema, or grounding failure | Read the error; try a smaller source or another writing model. Validation failures stop instead of publishing unchecked audio. |
| Browser opens but does not play | Click Play. If the browser cannot decode it, open the original M4A in QuickTime. |
| Generation seems slow | Watch the extraction, dialogue, and voice progress messages. Try an 8B model as an experiment; inspect its transcript before judging the result. |

After changing the code, rebuild the linked command:

```sh
npm run build
```

For more diagnostics, retry with `--debug` and a new output path. Retained files may contain derived plan content.

Exit codes: `0` success, `1` unexpected local failure, `2` input/arguments, `3` configuration/setup/acknowledgement, `4` provider or script validation, `5` audio validation, `6` overwrite protection, `130` interruption.

## Limits and privacy

- **Two-minute mode only:** `2m` is the default and targets 110–140 seconds. Five-minute mode is not implemented.
- **Input:** UTF-8 Markdown up to 2 MB. Local generation additionally limits the structured source payload to 65,000 characters and requests a 32K model context.
- **Language and hardware:** English and an Apple M2 Max with 64 GB have been exercised. Smaller Macs, Intel Macs, and other languages have not been comprehensively validated.
- **Local content stays local:** setup downloads software and model assets; subsequent local generation processes the plan on this Mac. The speech worker disables networking; llama.cpp uses offline mode and a local model file. No automatic cloud fallback or Plancast telemetry is added.
- **Validation has limits:** source quotations, references, required topics, word budgets, and audio duration are checked. Those checks cannot prove every paraphrase is true or catch every omission. Review the transcript for important decisions.
- **Bounded corrections:** one correction is allowed. Local audio narrowly outside the duration window may receive a pitch-preserving 0.85×–1.15× pacing adjustment instead of another script pass; the applied rate is recorded in metadata.
- **Not yet implemented:** generation caching, persistent project/user config files, Keychain integration, additional speech backends, and a native Mac interface.

See [validation notes](docs/VALIDATION.md) for measured results and remaining quality gates.

## Development

Source development requires **Node.js 24+ and npm**. Standalone users do not need these installed globally.

Install from source:

```sh
npm ci
npm run build
npm link
plancast setup-local
```

Build a standalone archive for your Mac (production npm dependencies are taken from the lockfile; the Node download is checksum-verified):

```sh
npm run package:standalone
```

The archive and its `.sha256` file are written to `releases/`. No publishing occurs. The archive includes dependency licenses and a private Node runtime; models and the remaining tools download during setup. The installer verifies archive contents, preserves prior managed releases, and refuses to replace unrelated files at the launcher path. For an isolated installation, set `PLANCAST_INSTALL_PREFIX` to an absolute path when running `install.command`; the default is `~/.local`.

Run development checks from the repository:

```sh
npm run dev -- test/fixtures/migration.md --dry-run
npm run check
npm run format
npm pack --dry-run
```

`npm run check` builds TypeScript, runs ESLint, and runs tests. Tests do not call paid APIs. An opt-in local generation check is:

```sh
plancast test/fixtures/migration.md --output tmp/live/migration.plancast.m4a
```

For an npm-linked source installation, `npm uninstall -g plancast` removes the linked CLI. For a standalone installation, remove its `~/.local/bin/plancast` symlink and `~/.local/share/plancast/cli/` directory. Generated files and model downloads remain. Older Python environments are preserved during migration to the private managed environment.

- [Implementation guide](docs/CLI_IMPLEMENTATION_GUIDE.md)
- [Product requirements](prd_outputs/Plancast%20CLI/plancast_cli_PRD.md)
- [Validation notes](docs/VALIDATION.md)

## License

Plancast is [MIT licensed](LICENSE). Bundled dependencies, downloaded runtimes, models, and voice recordings retain their own licenses; see [third-party notices](runtime/THIRD_PARTY.md).
