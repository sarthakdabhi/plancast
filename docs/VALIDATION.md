# Initial CLI validation

Validated locally on macOS with Node.js 26 on September 20, 2026 (Pacific).

## Automated checks

`npm run check` builds strict TypeScript, runs ESLint, and runs 92 tests. Coverage includes invalid inputs, source references, privacy acknowledgement, word budgets, publication rollback, voice ordering, failed generation cleanup, interruption, playback recovery, SDK retry limits and error redaction, structured-output requests, and real macOS WAV-to-M4A conversion. No paid APIs are called by the tests.

The command is installed locally using `npm link`. Help, a clean-prefix installation, and installation from an actual npm tarball were checked. The packed binary completed a dry-run, and help completed in 81 ms. Help loads the generation pipeline lazily. All five saved script/audio hashes match their manifests.

## Live provider checks

Five synthetic plans were sent to OpenAI during development. These results are developmental samples across prompt revisions, not a statistical reliability benchmark or a complete rerun of the final prompt across every fixture.

| Plan | Observed duration | Source-to-script inspection |
| --- | ---: | --- |
| SQLite search migration | 122.95 seconds (final prompt) | Preserves proposal, stale-index risk, performance target versus measured result, encrypted-notebook question, and benchmark next action. Final script includes the recap but still omits explicit sync/cloud exclusions; this remains a quality-evaluation finding. |
| Signed desktop release | 124.35 seconds | Preserves release ordering, CDN risk, uncertain notarization time, Friday/Monday decision, and next action. |
| Duplicate reminders | 112.70 seconds | Preserves investigation-first approach, dropped-reminder risk, hardware uncertainty, and reproduction next action. |
| Selected-note export | 120.50 seconds | Preserves local ZIP proposal, path-escape risk, memory uncertainty, unresolved links, and prototype next action; includes final recap. |
| Background thumbnails | 116.10 seconds | Preserves queue proposal, outage/duplicate risks, two retries and third-attempt failure, retention question, and local prototype next action. |

Failed attempts correctly stopped before speech when source quotations or grounding coverage were invalid. Word-budget misses are limited to one correction pass; correction now includes explicit feedback. Interpretation labels are added deterministically when the model sets its structured interpretation flag without a spoken qualifier. These checks reduce errors but cannot establish semantic truth or complete source coverage.

The initial samples used 24 kHz AAC. Inspection exposed an afconvert flag error; the final converter explicitly requests and validates 48 kHz AAC. The selected-note and final migration samples verified the corrected conversion. The final migration run also invoked `--play` using the installed command. QuickTime Player opened it and displayed a 02:00 duration with playback controls.

## Remaining release gates

- Independent listening review for two-voice clarity and comprehension.
- Full final-prompt evaluation on 15–20 representative plans, including long plans and adversarial Markdown; measure unsupported claims, exclusions, and omissions.
- Reliability and latency benchmarking; the development runs are not evidence of the PRD's 95% success target.
- Oldest supported macOS / Node 24 validation and Intel coverage. Current host results do not establish those compatibility claims.
- Five-minute mode, caching, persistent/user/project configuration, and later distribution are intentionally outside this first milestone.

Publication uses per-file atomic hard links and a manifest-last completion marker, with rollback and a publication lock. It is not a single atomic transaction across three sibling files under power loss or SIGKILL. Consumers must verify the manifest hashes.

## Full-PRD quotation regression

Reproducing the failure on the 910-line Plancast PRD exposed whitespace differences, incorrect model-supplied line numbers, and omitted bold delimiters in otherwise faithful quotations. The captured cases are retained in a small regression fixture.

Prompt version `dialogue-v6` uses two structured stages: extract compact evidence with source-line IDs, then write the dialogue from the validated evidence. The adapter copies quotation text and line locations directly from the local source instead of asking the model to reproduce Markdown. For documents within structured-output enum limits, IDs are constrained to actual nonempty source lines; larger documents still validate IDs against the local source map. Unknown IDs and incomplete evidence coverage stop before dialogue or speech generation. The second stage receives only selected evidence and summary, rather than the full plan.

The core validator also resolves unique quotations locally when references have inaccurate line numbers. It tolerates whitespace and parser-recognized emphasis, while preserving wording, negation, quantities, punctuation, code literals, links, and strikethrough. Ambiguous or absent quotations still fail. Known inline fact citations are removed from speech text, and structured dialogue is capped at eight turns. These checks validate evidence structure and provenance, not semantic truth.

The 61-test suite covers captured regressions, Markdown/code distinctions, source-line selection, rejection of invented IDs, evidence coverage, and separation of extraction from dialogue writing, alongside existing pipeline checks.

The rebuilt installed command generated the full PRD successfully with `dialogue-v6`: 122.10 seconds, eight turns, and matching audio/script hashes. Artifacts are under `tmp/live/prd-regression.plancast.*`. No schema or grounding checks were bypassed.

## Required spoken coverage regression

The previous free-form dialogue response could omit a category's citations even after evidence extraction succeeded. Prompt version `dialogue-v7` requests named passages for each detected category instead. Every present category requires nonempty spoken text and a fact ID selected from that category's evidence. Absent categories must be null. The CLI composes host questions and explanatory turns locally, with nextAction in the final spoken turn. This is a structural constraint, not a prompt-only request or an added citation on unrelated dialogue.

Evidence extraction now binds each category’s summary and supporting source references together, so a nonempty summary cannot omit its evidence. Fact IDs and categories are assigned locally.

Each passage also has a schema-enforced word-count range derived from the total target and fixed host questions. This was added after repeated live tests caught overly long passages despite the requested total budget. Core grounding and final audio-duration checks remain enabled. Tests cover missing, blank, incorrectly cited, absent-source, and overlong passages.

After the final evidence and passage schema changes, five independent live generations of the full PRD passed script validation without correction (245–267 words). All five contained nextAction evidence in the final HOST_B turn. A separate installed-CLI end-to-end run produced a 113.2-second M4A. Its transcript was inspected for complete sentences and the grounded final next action. Results: `tmp/live/prd-coverage-report.json`; audio and sidecars: `tmp/live/prd-coverage-final.plancast.*`. Script/audio hashes were verified against the manifest. These are repeated regression checks, not a general reliability-rate guarantee. Playback was not repeated in this regression run; the playback implementation is unchanged from the previously verified run.

## Interactive local playback

The universal AVAudioPlayer helper and TypeScript controller add pause, 10-second seek, 0.5–2× playback speed, restart, normal-speed reset, and quit. An integration test drives the real helper using local silence and verifies state changes and clean exit. `plancast listen` replays existing files without invoking providers. The complete suite passes 69 tests. Native playback is tested on Apple silicon; Intel is compiled but execution is not verified.

Installed-command PTY checks verified q exits 0, Ctrl-C exits 130, and natural completion exits 0, with terminal settings restored in all three cases. A real saved briefing exercised pause, both seek directions, and speed changes. The npm package includes the universal helper. These checks used local files and made no provider requests.

## Browser playback (current)

The HTML browser player supersedes the terminal helper above; the Swift helper and its integration test were removed. The installed listen command opened the local page in the default Brave browser and returned immediately. UI checks verified playback, pause, seeking, and speed selection. Browser autoplay was correctly blocked until Play was clicked. Two tests verify safe filename escaping and exact audio embedding with remote resources blocked; the current suite has 70 tests. Safari and other browsers were not exercised. No provider requests were made.

## Local Qwen3 and Pocket TTS

Validated on an Apple M2 Max with 64 GB of memory. Ollama already existed on this Mac; setup downloaded Qwen3 14B and installed Pocket TTS 3.1.0 with alba and marius in a dedicated Python 3.12 environment. The installed `plancast setup-local` command completed successfully, including a repeat run against cached assets. The npm package includes the Python worker.

Both voices generated local smoke-test WAV files with Python networking disabled. The initial adapter exposed a PyTorch threading issue caused by an unnecessary inference-mode wrapper; removing that wrapper fixed synthesis. The original cloud per-passage regex was not reliably enforced by Ollama. Local mode now requests point/explanation sentence pairs, requires topic citations, and validates the assembled total word budget. An earlier short-plan attempt failed closed on a word-budget miss; this remains evidence that local generation can fail, not a reason to bypass validation.

A full 910-line PRD generated a 132.02-second, 362-word M4A with eight turns, Qwen3 14B, and Pocket TTS alba/marius. Audio and script hashes match the manifest, and afinfo verifies 48 kHz AAC. Files: `tmp/live/local-prd.plancast.*`. That run used the first sentence-pair prompt and recorded the inherited dialogue-v7 tag; subsequent local runs use dialogue-v7-local-v1 and derive sentence allocations from the current word budget. Transcript inspection found a coherent next action and complete sentences, but more literal technical labels than ideal. Listening quality and a broader faithfulness benchmark remain release gates.

The 83-test suite includes local-default configuration, cloud-backed Ollama rejection before source transmission, loopback-only requests with redirects forbidden, malformed structured output, bounded transient retries, sentence-pair composition, local generation without cloud acknowledgement, worker reuse, interruption, cleanup, and redacted worker failures. No test invokes paid APIs. Local generation has no automatic cloud fallback.

The final short-plan regression generated `tmp/live/local-migration-paced.plancast.*` successfully in local mode: 114.375 seconds, with the final local prompt version and matching script/audio hashes. The initial 400-word local budget proved unnecessarily strict for short sources; 350 is the current starting budget. Pocket TTS narration narrowly below the duration window can use one ffmpeg tempo adjustment bounded to 0.85–1.15 while retaining pitch; this sample used 0.85. The manifest records the applied rate. A real tone integration test verifies extended duration with pitch preserved, and a pipeline test verifies one correction with no text regeneration. Both full-PRD and short-plan results are development samples, not a broad reliability or naturalness benchmark.

## Ollama metadata compatibility regression

The model check incorrectly required the optional tensors array. The installed Ollama returned Qwen3 14B GGUF metadata and a positive parameter count without tensors, reproducing the reported failure after successful setup. The check now accepts that local weight metadata while rejecting remote_model or remote_host markers. Connection errors, HTTP failures, missing models, and unrecognized metadata have distinct messages. The rebuilt check passed against the live installed model; all 88 tests passed. This verification exercised the model gate without regenerating or overwriting user audio.


## Plancast-managed llama.cpp runtime (September 21, 2026)

Local generation now uses pinned llama.cpp b11080 directly, through a private supervised server. Ollama is no longer a process or API dependency. The old Ollama transport and metadata tests were replaced with managed-runtime/provider tests.

- `npm run check`: 87 tests pass, including curated model selection, GGUF checks, pinned download hashes/sizes, structured completion validation, bounded retries, provider disposal on success/failure, and supervisor shutdown with forced termination of an unresponsive child.
- ARM64 release archive was downloaded from upstream, SHA-256 checked, extracted into Plancast's application-support directory, and executed successfully. The x64 archive has a pinned upstream checksum but has not been exercised on Intel hardware.
- Existing Qwen3 14B weights were checksum-verified and copied from the local Ollama blob store into Plancast-managed storage. A full `plancast setup-local` rerun verified the model and existing Pocket TTS environment successfully.
- Live migration fixture produced 122.374 seconds of two-voice audio, with one permitted 0.85x pacing adjustment. This is an integration check, not a broad quality benchmark. Source inspection still finds repetition and an overstatement that encrypted indexing is currently disabled, where the source states a prohibition pending a decision.
- A live Ctrl-C check after the native server started returned exit 130, stopped the server, and left no output or temporary generation files.
- The live server listened on loopback only and returned HTTP 401 for an unauthenticated `/v1/models` request.
- Package dry-run includes the supervisor, provider/runtime modules, Pocket worker, and third-party notices/licenses. It excludes obsolete Ollama modules, native binaries, and model weights. Assets are downloaded during setup rather than embedded inside the npm package.

Runtime startup has a two-minute deadline; each generation request has a five-minute deadline. The supervisor terminates its server when its stdin pipe closes, including when the CLI is killed, and escalates from SIGTERM to SIGKILL after two seconds. No source content or server diagnostics are logged. Model checksums are verified before loading, and the pinned runtime version/model digest are recorded in completed manifests.

The 4B and 8B catalog models, oldest supported macOS/Node versions, offline setup from a fresh machine, and independent listening/faithfulness review remain unverified. Generation is local; first setup still needs the network, uv, ffmpeg, and a separately installed Python speech environment.

Final build replayed the migration fixture through the complete `--play` flow: 119.641 seconds, browser player opened, M4A/transcript hashes matched, runtime b11080 and the pinned model digest were present in the manifest, and no llama-server process remained.


## Two-voice clarity pass

The local Alba/Marius pair remains the default. `plancast preview-voices --play` renders a four-turn sample using the selected local voices, with no writing model or cloud API. Both previews and the podcast pipeline use `balanced-speech-v1`: per-turn RMS gain with a 6 dB ordinary adjustment cap, approximately 1 dB peak headroom, and 5 ms boundary fades. Sample counts and the existing 300 ms speaker gaps are preserved. The Pocket worker scales over-range float peaks before integer conversion instead of hard clipping, and rejects silent output. Completed manifests record the processing version.

Automated signal tests cover level balancing, headroom, bounded gain, unchanged durations/source buffers, silent input behavior, and malformed PCM. These tests cannot assess perceived voice gender, accent, articulation, or human naturalness. Listening acceptance remains separate.

The live four-turn Alba/Marius preview rendered successfully (20.2 seconds) and opened in the browser. Build, lint, and all 90 tests passed. No listening-quality claim is inferred from these checks.

## Jane and George default pair

Jane (Host A) and George (Host B) replace Alba/Marius as the local defaults; the previous pair remains selectable. Setup downloaded the additional built-in voice embeddings. The speech worker lazily loads selected voices from the cache with networking disabled during generation. Build, lint, and all 90 tests passed. A live four-turn Jane/George preview rendered to 22.7 seconds and opened in the browser; CLI dry-run also reports Jane/George. This validates selection and synthesis, not an independent listening-quality rating or a full two-minute quality benchmark.


## Standalone installation and private prerequisites

The Apple Silicon standalone archive includes Node 24.21.0 (official archive checksum pinned) and lockfile-resolved production npm dependencies. `setup-local` installs checksum-pinned uv 0.12.17 and FFmpeg 7.1 from the imageio-ffmpeg 0.6.0 platform wheel. uv installed Python 3.12.13 under Plancast's own application-support directory and created a separate Pocket TTS managed environment; the older environment remains untouched.

- Build/lint and all 92 tests passed. Installer tests cover paths containing spaces, repeat installation, tampered files, and refusal to overwrite unrelated launchers. The existing pitch-preservation test passed with the private FFmpeg binary.
- Created and installed the approximately 43 MB ARM64 archive using only macOS shell utilities. The launcher points to an immutable release under `~/.local/share/plancast/cli/` and invokes its own Node binary. Package contents are checked against SHA256SUMS before installation and again after copying.
- With PATH restricted to `/usr/bin:/bin`, the installed command completed help, setup, and a live full two-host render with `--play`: 113.540 seconds, Jane/George, browser player opened, audio/transcript hashes verified. Existing Qwen and speech assets were reused for this standalone setup check; private Python and tools had been downloaded earlier in this session. This is not a completely fresh-machine test.
- A separate restricted-PATH check exercised FFmpeg pacing through the packaged audio module; a 2-second tone slowed to approximately 2.35 seconds. Native Node and FFmpeg dynamic-library dependencies resolve only to macOS system libraries/frameworks, not Homebrew libraries.

The installer does not edit shell profiles, replace unrelated commands, publish releases, or uninstall existing system tools. Add `~/.local/bin` first on PATH to prefer this installation over an older npm link. Release archives are local artifacts, not public downloads or a notarized installer. Intel speech compatibility, a truly fresh Mac without cached models, and oldest-macOS validation remain release gates.

## Document inputs (0.2.0 development)

- Build, lint, and all 105 tests pass, including real PDF extraction with page ranges, malformed/scanned/mixed-page failures, plain text, inert article extraction, source snapshots, article-specific dialogue, public-address checks, DNS pinning, redirect bounds, response limits, and offline URL dry-run rejection.
- A public article URL was extracted successfully. Its HTML/scripts were not executed; extracted content was not sent to a cloud model.
- A synthetic plain-text article produced a 125.0-second local Jane/George briefing. Script, audio, and normalized-source hashes matched the sidecar. The script retained the fictional-study qualifier, sampling caveats, and uncertainty and did not invent a next action. This is a smoke check, not a broad quality benchmark.
- The 0.2.0 standalone archive was installed locally and exercised with its private Node runtime and system-only PATH. Plain text and the existing 17-page PRD PDF passed dry-run extraction; PDF extraction required no external utilities.
- The public GitHub release and Homebrew formula remain at 0.1.0. Scanned PDFs/OCR, password-protected PDFs, authenticated webpages, and JavaScript-rendered articles are outside this implementation.

## Gemini provider (0.3.0 prerelease)

124 tests pass with build and lint. Gemini tests cover separate configuration, header-based credentials, structured evidence/composition, exact PCM bytes, voice routing and manifest identity, missing-key rejection, cloud acknowledgement denial, dry-run without credentials, transient retry limits, cancellation, error redaction, and malformed/blocked/incomplete/audio-format failures. Tests use mocked responses and make no paid requests. No GEMINI_API_KEY was available for a live generation or listening check; model availability, end-to-end duration, and voice quality remain unverified. The 0.3.0 prerelease includes this provider with the live-validation limitation disclosed.
