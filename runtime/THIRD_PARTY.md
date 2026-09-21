# Managed runtime assets

Plancast setup downloads llama.cpp b11080 from the upstream ggml-org GitHub release. The macOS ARM64 and x64 archive SHA-256 values are pinned in `src/runtime/assets.ts`. See `licenses/llama.cpp-MIT.txt` for the upstream MIT license.

The Qwen3 Q4_K_M GGUF models are Apache-2.0 licensed; see `licenses/Qwen3-Apache-2.0.txt`. The default 14B file is pinned by SHA-256 in the Ollama registry, matching the previously supported local download. 4B and 8B files are pinned to revisions of Qwen's official Hugging Face repositories. Ollama software is not used for inference or required for setup. Existing checksum-matching local weights may be copied into Plancast's own storage.

- llama.cpp release: https://github.com/ggml-org/llama.cpp/releases/tag/b11080
- Qwen model publisher: https://huggingface.co/Qwen
- Model catalog, URLs, sizes and digests: `src/runtime/assets.ts`

Pocket TTS remains a separately installed Python dependency with its own upstream license and dependencies. The npm tarball includes no native tools or model weights. The standalone archive includes the official Node runtime and its LICENSE; setup downloads the remaining assets.

Jane and George are the Pocket TTS presets derived from VCTK recordings `p339_023_enhanced.wav` and `p315_023_enhanced.wav`, respectively, distributed through Kyutai's voice repository. Kyutai lists VCTK recordings under Creative Commons Attribution 4.0 International. Voice source and attribution information: https://huggingface.co/kyutai/tts-voices (VCTK dataset: https://datashare.ed.ac.uk/handle/10283/3443). These are synthetic renditions; no endorsement by the original speakers is implied.

## Private setup tools

- Node 24.21.0: official nodejs.org distribution; its LICENSE is included in standalone archives at `node/LICENSE`.
- uv 0.12.17: https://github.com/astral-sh/uv/releases/tag/0.12.17 (MIT/Apache-2.0); setup downloads a checksum-pinned upstream archive.
- Python 3.12.13: uv-managed Astral python-build-standalone distribution, installed in Plancast's private Python directory.
- FFmpeg 7.1: executable extracted from the SHA-256-pinned imageio-ffmpeg 0.6.0 platform wheel on PyPI. Its archive includes the wrapper's BSD license; the FFmpeg build is separately GPL-licensed. Upstream sources and build provenance: https://github.com/imageio/imageio-ffmpeg/tree/v0.6.0 and https://github.com/imageio/imageio-binaries/tree/master/ffmpeg. FFmpeg is downloaded at setup and invoked as a separate process, not linked into Plancast or bundled in the standalone archive.

Runtime download URLs, versions, sizes and digests are recorded in `src/runtime/tools.ts`. Private Python packages retain their upstream licenses in the installed environment.
