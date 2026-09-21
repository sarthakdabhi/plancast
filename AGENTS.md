# Plancast agent instructions

Before implementing or planning work in this repository, read:

1. `README.md`
2. `docs/CLI_IMPLEMENTATION_GUIDE.md`
3. `prd_outputs/Plancast CLI/plancast_cli_PRD.md`

## Product direction

- Plancast is terminal-first and macOS-first.
- Build the Node.js and TypeScript CLI before any native macOS interface.
- The first milestone is the complete `plancast PLAN.md --length 2m --play` vertical slice.
- Optimize for fact-faithful comprehension, not entertaining or verbatim audio.
- Preserve the proposal, rationale, risks, uncertainty, open questions, and next action.
- Plan parsing, audio assembly, validation, and playback stay local.
- Explicitly disclose when plan content is sent to remote script or speech providers.

## Engineering boundaries

- Keep script and speech providers behind typed interfaces.
- Validate structured model output before TTS.
- Use `spawn` or `execFile` with argument arrays for system tools.
- Limit transient retries to two.
- Publish artifacts atomically only after validation.
- Never log secrets or full provider request bodies.
- Preserve unrelated user changes and do not edit `/Users/setu/plugins/plancast` in place; use it only as behavioral reference unless the user explicitly asks otherwise.
