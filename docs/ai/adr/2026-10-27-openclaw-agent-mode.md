# OpenClaw Agent Mode

Status: accepted for implementation. Live acceptance remains incomplete.

## Context

AIRI owns the avatar, microphone, STT, TTS, and playback. An existing OpenClaw agent owns reasoning, tools, memory, identity, and permissions.

The starting AIRI revision is `13eef81f02261281a35d1ec21c834ede8c786fa3`. Its package version is 0.13.0. The installed desktop release remains 0.12.0.

The initial OpenClaw target is 2026.10.3. Its public plugin SDK is experimental. Each host upgrade needs compatibility tests.

Upstream PR #1040 is open and unmerged. Its bridge polls completed chat history and emits artificial chunks. It lacks the required presentation tools and isolation.

## Decision

Use a native OpenClaw channel plugin with an authenticated WebSocket route. Use the public ingress and reply-dispatch APIs.

Keep the client transport and validated Eventa contracts in `packages/openclaw-bridge`. Keep the channel plugin in `integrations/openclaw-plugin`.

Add Agent Mode at AIRI's shared chat dispatch boundary, before local model preparation. Retain the existing transcript, voice drafts, speech hooks, and renderers.

In Agent Mode, block local conversation generation, recipes, autonomous reactions, transcript rephrasing, and model-based end judging. Retain STT, VAD, playback, blinking, and idle motion.

Use a presentation overlay for avatar, voice, and settings. Restore Normal Mode state on exit. Profiles contain resource identifiers, not credentials.

The plugin authenticates a principal. It binds that principal, client, conversation, and allowed agent to a canonical OpenClaw session.

Avatar, voice, device, and provider changes do not change this binding. Tool arguments cannot select another principal or session.

## Network contract

Use central Eventa events `airi:openclaw:v1:client` and `airi:openclaw:v1:server`. Validate every frame with Valibot.

The endpoint is `/plugins/airi/v1`. Remote connections require TLS. Credentials travel in the initial authenticated hello, never in URLs or bundles.

The hello includes stable client, conversation, and agent identifiers. It includes the last received sequence for replay.

Typed input and STT transcripts use `user.message` with stable message IDs. Responses use accepted, delta, final, cancelled, and error events.

Accepted means channel admission. It does not prove transcript persistence. Only user-facing delta and final text enters speech output.

The server sequences conversation events. It retains bounded replay and deduplication records. Missing replay history returns an explicit recovery error.

Presentation requests use correlated action IDs. Results contain effective state and refreshed capabilities. Unsupported changes return errors without a false success.

Approval events expose authorized decisions only. The channel preserves OpenClaw's approval policy and authenticated actor checks.

## Lifecycle

Agent Mode stays selected on transport failure. It never falls back into independent AIRI generation.

Mode changes cancel owned turns and flush local speech and presentation work. Stale callbacks cannot affect a new mode epoch.

Reconnect reuses the session and sequence. It does not submit the same user message again. Replayed events cannot create duplicate speech or actions.

## Acceptance

The project requires Normal Mode regression tests, true runtime text and voice turns, presentation tools, scoped profiles, and failure recovery.

A live demonstration must discover avatars and voices, change both, change a setting, save a profile, and restore the previous state.

Mocked providers and contract tests do not prove live voice, rendering, or full agent-runtime compatibility.

## Baseline

The clean Mac checkout passed frozen dependency installation, desktop and web bundles, and 571 targeted tests.

The tests required `NODE_OPTIONS=--no-experimental-webstorage` for Node 26 with jsdom. No source change was necessary.

The native backdrop compiled and loaded with Apple's command-line tools. Full Xcode and signed release packaging remain unverified.

## Source references

- https://github.com/moeru-ai/airi/pull/1040
- https://github.com/moeru-ai/airi/issues/1127
- AIRI shared chat, voice, hearing, display-model, and stage stores at the starting revision.
- OpenClaw 2026.10.3 public plugin SDK declarations and channel documentation.
