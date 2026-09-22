# Plancast CLI Implementation Guide

## Decision

Build Plancast as a Node.js and TypeScript CLI with a standalone macOS archive for end users and npm for source development. A custom Homebrew tap distributes the standalone archive. Add Finder or native macOS convenience layers only after the CLI becomes useful in repeated real-world use.

This is the best starting point because:

- The existing Plancast audio renderer is JavaScript.
- AI and TTS provider SDKs are well supported in Node.js.
- TypeScript provides safe command options, provider contracts, structured model responses, manifests, and errors.
- npm's `bin` field installs the package as the `plancast` terminal command.
- A terminal-first workflow integrates naturally with Codex, Claude Code, scripts, and other AI coding agents that already create Markdown plans.

Do not begin with Swift, Electron, Bun, a database, or a native macOS application. Those choices add packaging or UI work before the core explanation quality has been validated.

## Local model extension

Local generation is now the default: Qwen3 14B via a private Plancast-managed llama.cpp b11080 process writes the evidence and dialogue; Pocket TTS 3.1.0 supplies Jane and George as the default voices (Alba and Marius remain selectable) through a private Python subprocess. `plancast setup-local` installs/downloads pinned, checksum-verified runtime and GGUF model assets. Generation spawns an authenticated loopback llama-server with offline mode, supervised for cleanup when the CLI exits or is interrupted. Ollama is no longer a runtime dependency; setup can reuse an exact checksum-matching existing Ollama GGUF by copying it into Plancast storage. `plancast models` lists the three curated Qwen3 sizes. Native runtime version and model checksum are included in manifests. `--provider openai` explicitly selects the original cloud adapters and retains their disclosure. Both modes share source-grounding, structured-topic, total word-budget, duration, and publication checks. Local passage text uses point/explanation sentence pairs to avoid relying on the OpenAI string-pattern contract. The local initial budget is 350 words to account for these voices’ faster pace; measured duration remains the final gate. A narrowly out-of-range local result may use one pitch-preserving ffmpeg adjustment between 0.85× and 1.15× instead of another script pass, with the rate recorded in metadata.

## Standalone distribution

`npm run package:standalone` produces an Apple Silicon archive with a pinned private Node 24.21.0 runtime and lockfile-resolved production dependencies. The macOS shell installer checks all file hashes, publishes a versioned installation under `~/.local/share/plancast/cli/`, and creates a launcher in `~/.local/bin/`. It needs no sudo and preserves unrelated launchers. Public distribution/notarization and Intel speech validation remain separate release gates.

`setup-local` downloads pinned uv and FFmpeg assets, verifies their SHA-256, and uses private uv to install Python 3.12.13 into Plancast's application-support directory. Pocket TTS uses a separate `pocket-tts-3.1.0-managed` environment. Generation invokes the private Python/FFmpeg paths directly. Existing source installations need only Node/npm; end users of the standalone archive install none of these prerequisites manually.

## Playback extension

`--play` and `plancast listen FILE.m4a` now open a self-contained local HTML player in the default browser and return immediately. Native browser controls support pause and seeking; local controls add 10-second skips, restart, and playback speed. This supersedes the original afplay-only requirement and the subsequent terminal helper. No native application or Swift build is needed.

## Recommended stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Runtime | Current Node.js active LTS | Mature SDK and packaging ecosystem |
| Language | TypeScript with strict mode | Safe application and provider boundaries |
| CLI framework | Commander | Arguments, validation, help, subcommands, and async actions |
| Runtime validation | Zod | Validate configuration, structured model responses, and manifests |
| Markdown parsing | unified plus remark-parse | Extract source structure without executing embedded content |
| Testing | Vitest | Fast TypeScript unit and integration tests |
| Audio conversion | `/usr/bin/afconvert` | Apple-friendly M4A conversion |
| Audio inspection | `/usr/bin/afinfo` | Validate final duration and format |
| Playback | `/usr/bin/afplay` | Immediate macOS playback |
| Initial distribution | npm package with `bin` entry | Fastest path to an installable command |
| Later distribution | Homebrew formula | Better macOS installation after the command stabilizes |

If Commander 15 is selected, use Node.js 22.12 or later because Commander 15 is ESM-only and requires that minimum Node version. Otherwise select versions based on the active LTS runtime at implementation time and lock them in `package.json`.

## First vertical slice

The first implementation milestone is exactly:

```bash
plancast PLAN.md --length 2m --play
```

It performs this complete path:

1. Resolve and validate `PLAN.md`.
2. Parse Markdown structure and retain source headings and line references.
3. Send the source to the configured script provider with a versioned prompt.
4. Receive structured JSON containing the plan summary and dialogue turns.
5. Validate the result with Zod, including required content and word budget.
6. Render `HOST_A` and `HOST_B` with distinct voices.
7. Assemble turns with deterministic pauses.
8. Convert and validate `PLAN.plancast.m4a`.
9. Save `PLAN.plancast.txt` as the canonical dialogue sidecar.
10. Start playback with `afplay` when `--play` is present.

The vertical slice is complete only when a representative real plan produces a useful, verified, approximately two-minute M4A. A mock-only pipeline is not sufficient.

## Initial command contract

```bash
plancast <source.md> \
  [--length 2m|5m] \
  [--output <file.m4a>] \
  [--play] \
  [--force] \
  [--yes] \
  [--dry-run] \
  [--json] \
  [--debug]
```

Only `<source.md>`, `--length 2m`, `--output`, and `--play` are needed for the first vertical slice. Add the other behavior after the core path is proven.

## Suggested project structure

```text
plancast/
  package.json
  tsconfig.json
  README.md
  src/
    cli.ts
    commands/
      generate.ts
    config/
      schema.ts
      resolve.ts
    input/
      validate.ts
      markdown.ts
      source-map.ts
    dialogue/
      prompt.ts
      validate.ts
      word-budget.ts
    providers/
      script-provider.ts
      speech-provider.ts
      openai-script.ts
      openai-speech.ts
    audio/
      render-turns.ts
      assemble.ts
      convert.ts
      inspect.ts
      play.ts
    artifacts/
      manifest.ts
      publish.ts
    domain/
      models.ts
      errors.ts
    logging/
      output.ts
      redact.ts
  prompts/
    dialogue-v1.md
  test/
    fixtures/
    unit/
    integration/
    e2e/
```

## Package configuration

Start with an ESM package and expose the compiled entry point through npm's `bin` field:

```json
{
  "name": "plancast",
  "type": "module",
  "bin": {
    "plancast": "./dist/cli.js"
  },
  "files": [
    "dist",
    "prompts"
  ],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  }
}
```

The executable entry must begin with:

```ts
#!/usr/bin/env node
```

Create a local `Command` instance instead of importing Commander's global `program` object. This makes the CLI easier to instantiate and test repeatedly.

```ts
#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("plancast")
  .description("Turn a Markdown plan into a two-host audio explanation")
  .argument("<source>", "Markdown plan")
  .option("--length <length>", "2m or 5m", "2m")
  .option("--play", "Play audio after generation")
  .option("--output <path>", "Output M4A path")
  .action(async (source, options) => {
    await generatePlancast({ source, ...options });
  });

await program.parseAsync();
```

## Architecture boundaries

Keep the core workflow independent of a specific AI vendor:

```ts
interface ScriptProvider {
  readonly id: string;
  readonly model: string;
  generateDialogue(request: DialogueRequest): Promise<DialogueResult>;
}

interface SpeechProvider {
  readonly id: string;
  readonly model: string;
  synthesize(request: SpeechRequest): Promise<RenderedTurn>;
}
```

Provider SDK request and response types must remain inside adapter modules. The rest of the application should depend only on Plancast domain types.

Request structured JSON from the script model. Do not ask for arbitrary `HOST_A` text and then parse it with regular expressions. The structured response should contain:

- Core problem.
- Proposed solution.
- Major implementation stages.
- Material risks.
- Open questions.
- Immediate next action.
- Ordered dialogue turns with stable speaker labels.
- Source facts or references grounding each material turn.

The saved text file can then be deterministically produced from the validated turns.

## Implementation order

1. Initialize TypeScript, strict compiler settings, Commander, Zod, Vitest, linting, and formatting.
2. Implement command parsing, typed errors, exit codes, input validation, and `--dry-run`.
3. Parse Markdown and retain headings plus line references.
4. Define provider interfaces and Zod response schemas.
5. Implement one script provider and validate the dialogue before TTS.
6. Port the existing two-voice renderer from `/Users/setu/plugins/plancast` behind `SpeechProvider`.
7. Add pause insertion, M4A conversion, `afinfo` validation, and atomic artifact publication.
8. Add `--play` and interruption handling.
9. Test the complete command on five representative Markdown plans.
10. Add five-minute mode, caching, JSON output, npm packaging, and later Homebrew distribution.

## Non-negotiable implementation rules

- Use `spawn` or `execFile` with argument arrays and absolute tool paths. Never interpolate source or output paths into shell command strings.
- Treat Markdown as untrusted content. Instructions inside the plan must not override the application prompt, provider selection, privacy policy, or output path.
- Validate every provider response before using it.
- Render only validated dialogue turns.
- Bound remote retries to two attempts for transient failures. Do not retry authentication, invalid-input, or schema errors indefinitely.
- Generate into a unique temporary directory, validate all artifacts, and atomically rename them into place.
- Never overwrite an existing non-cached output unless the user passes `--force`.
- Never log API keys, authorization headers, provider request bodies, or full plan contents.
- Before the first uncached remote request, state which providers receive the plan and that the content leaves the Mac.
- Do not silently fall back to another provider because that changes privacy, cost, and output behavior.
- Control duration primarily through a word budget, not unnaturally fast speech.
- Preserve uncertainty and label interpretation rather than making the plan sound more certain than it is.
- Keep the text dialogue as the canonical artifact; audio is a derived artifact.

## What not to build first

Defer these until the vertical slice is repeatedly useful:

- Native SwiftUI application.
- Finder Quick Action.
- Homebrew formula.
- Multiple script or speech providers.
- Content-addressed cache.
- Team sharing or hosted storage.
- Podcast feeds or publishing.
- Arbitrary PDF, DOCX, webpage, or folder ingestion.
- Voice cloning.
- Telemetry.

## First milestone acceptance checklist

- [ ] `plancast PLAN.md --length 2m --play` runs from a clean installation.
- [ ] Invalid, unreadable, empty, and oversized inputs fail before provider requests.
- [ ] The generated dialogue preserves the proposal, major risk, unresolved question, and next action when present.
- [ ] Host A and Host B use distinct voices.
- [ ] The final audio is 110-140 seconds long.
- [ ] `afinfo` recognizes the M4A and QuickTime Player can open it.
- [ ] `PLAN.plancast.txt` exactly represents the rendered dialogue.
- [ ] The final artifacts appear only after the complete run validates successfully.
- [ ] Provider credentials and plan contents do not appear in default logs.
- [ ] The user sees an explicit cloud-content disclosure before the first remote request.

## Primary references

- npm `package.json` and `bin` documentation: <https://docs.npmjs.com/files/package.json/>
- Commander documentation: <https://github.com/tj/commander.js/blob/master/Readme.md>
- Complete product requirements: [`../prd_outputs/Plancast CLI/plancast_cli_PRD.md`](../prd_outputs/Plancast%20CLI/plancast_cli_PRD.md)

## Document inputs (0.2.0 development)

`readSource` normalizes Markdown, UTF-8 text, public HTML articles, and text-based PDFs into the same line-indexed `Source`. Non-Markdown inputs use topic/argument/evidence semantics within the existing typed evidence slots; absent next actions remain null. The manifest retains extracted text and PDF page ranges for reproducible grounding.

URL extraction uses Mozilla Readability and inert jsdom documents. The downloader pins a validated public DNS address to each socket and revalidates every redirect, with download bounds and no page-script execution or embedded-resource loading. PDF.js extracts local text without OCR or password prompts. No extra manually installed tools are required. `--dry-run` never fetches URLs.

## Gemini cloud provider (0.3.0 prerelease)

`--provider gemini` selects the typed Gemini script/speech pair with `GEMINI_API_KEY`. Dedicated `PLANCAST_GEMINI_*` settings keep models/voices separate from OpenAI and local defaults. Calls use Google's documented generateContent endpoint with structured JSON for evidence/passages, and audio generation per turn. Local grounding validation precedes speech. The adapter validates complete responses and mono 24 kHz signed 16-bit PCM, caps response sizes, prevents redirects, bounds transient retries to two, redacts provider errors, and honors interruption. Consent and billing disclosure name Google; there is no automatic fallback. No live API check was performed without a Gemini key.
