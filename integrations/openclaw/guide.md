# AIRI Agent Mode setup and operation

## Components and compatibility

Agent Mode uses three components:

- AIRI's shared Stage UI, microphone, speech providers, and avatar renderers.
- `@proj-airi/openclaw-bridge`, the validated client and wire contract.
- `@proj-airi/openclaw-plugin`, a native OpenClaw channel and presentation tool.

The plugin targets OpenClaw **2026.10.3** exactly. The AIRI starting revision is
`13eef81f02261281a35d1ec21c834ede8c786fa3` (source version 0.13.0).
This is not a provider proxy. Messages enter the selected agent's native runtime.
Its configured workspace, memory plugins, skills, tool policy, and identity remain authoritative.
AIRI character prompts do not replace that identity in Agent Mode.

See the [plugin installation guide](../openclaw-plugin/README.md),
[protocol source](../../packages/openclaw-bridge/src/contracts.ts), and
[architecture decision](../../docs/ai/adr/2026-10-27-openclaw-agent-mode.md).

## Prepare AIRI

Build the desktop or web application using the upstream instructions and the
repository's Node and pnpm versions. Configure and test these AIRI resources first:

1. Import or select at least one working avatar.
2. Configure a speech-to-text provider in AIRI's hearing settings.
3. Configure a text-to-speech provider, model, and voice in its speech settings.
4. Allow microphone access if spoken input is required.

STT and TTS are independent. Their addresses and credentials belong in the existing
AIRI provider settings, not in presentation profiles or the OpenClaw channel token.
Use providers reachable from the machine running AIRI. Browser CORS and secure-context
rules still apply. A working server-side endpoint alone does not prove browser access.

Providers without voice discovery can use the Agent Mode panel's configured voice
catalog. It contains resource identifiers only:

```json
[
  { "providerId": "configured-provider-id", "modelId": "configured-model-id", "voiceId": "configured-voice-id" }
]
```

Copy actual IDs from the configured provider. This catalog does not create or clone
a voice and does not validate a provider's licensing or access rights. A custom or
cloned voice is selectable only when discovered or explicitly cataloged and usable
by that configured provider. Speech rate and pitch are not advertised by the current
adapter; attempts to set them fail explicitly.

## Connect

Open the mode panel at the upper left of the Stage, select **Agent Mode**, then enter:

- Endpoint: the Gateway's `/plugins/airi/v1` WebSocket route.
- Agent ID: an existing agent allowed by that credential's channel configuration.
- Connection token: the credential provisioned for this person.

Select Connect and check that the selected agent and `ready` state appear.
The token is kept in memory, cleared from the form after connection, and not saved
in application settings. A fresh application session needs the token again.
Endpoint, agent ID, and stable client identity are saved locally.

Use TLS (`wss`) between machines. Plain `ws` is accepted only for loopback endpoints.
A private SSH tunnel can expose a remote Gateway on AIRI's local loopback without
publishing a new network listener. Configure the Gateway's exact browser Origin
allowlist; the token is still required through a tunnel.

Typed input and recognized speech share the current AIRI conversation and its
OpenClaw session mapping. Changing avatar, voice, provider, or input method does
not create a new agent identity or conversation. Selecting another AIRI conversation
creates a distinct mapping. Changing the authenticated person or client also isolates
its mapping. Do not delete browser storage to recover a transient connection fault.

## Presentation tools

Enable the optional `airi_presentation` tool through the host's normal allowlist.
It is scoped to the authenticated AIRI sender and current conversation. It cannot
address another client through model-supplied routing arguments.

Discover before changing:

```json
{ "command": { "operation": "state.read" } }
{ "command": { "operation": "avatars.list" } }
{ "command": { "operation": "voices.list" } }
{ "command": { "operation": "profiles.list" } }
```

Use the returned stable IDs and advertised capabilities:

```json
{ "command": { "operation": "avatar.select", "avatarId": "returned-avatar-id", "scope": "client" } }
{ "command": { "operation": "voice.select", "voice": { "providerId": "returned-provider", "modelId": "returned-model", "voiceId": "returned-voice" }, "scope": "client" } }
{ "command": { "operation": "settings.update", "settings": { "speechVolume": 0.6 }, "scope": "client" } }
{ "command": { "operation": "profile.save", "name": "Work", "scope": "client" } }
{ "command": { "operation": "presentation.restore" } }
```

`profile.save` with an existing `profileId` updates that profile. `profile.apply`
uses its returned ID. `profile.delete` removes it. `settings.restore` restores only
settings; `presentation.restore` restores the captured Normal Mode presentation.

The current AIRI adapter supports **client scope only**. Profiles persist in that
client's local storage and reference configured resources, never provider credentials.
They are not cross-device agent defaults. The protocol reserves conversation, agent,
and application scopes, but this client rejects them. Readback reports the effective
scope. Returning to Normal Mode restores its prior avatar, voice, and supported settings.

### Supported settings and controls

The client advertises actual capabilities on connection and after avatar changes.
Read this snapshot rather than assuming every renderer supports every control.

- Speech volume (0–1), speech mute, microphone mute.
- Available microphone input device IDs; browser permissions still apply.
- Existing AIRI listening modes: always-on, push-to-talk, wake-word.
- Live2D scale (0.01–3), position (-500–500), and idle-animation toggle.
- Loaded Live2D expressions and motions, using returned control IDs.

Output-device routing, STT-language changes, and transcript visibility are not exposed
by this adapter. Configure provider language through AIRI's existing provider UI.
Live2D directory placeholders are unavailable until imported as usable models.
Godot avatar switching is not supported by the adapter. Other renderers may offer
avatar selection without Live2D-specific controls. A control omitted from the loaded
avatar's catalog is unsupported, not an instruction for the model to improvise.

Changes stop owned speech before replacing presentation. Failed changes attempt to
restore the previous working state and return an error. A successful tool result
includes the effective state and refreshed capabilities after client acknowledgement.
A timeout means the state is uncertain; read `state.read` before another change.

## Stop, disconnect, and return to Normal Mode

Use the existing stop control to cancel the owned turn and speech. Disconnect keeps
Agent Mode selected, so it never starts AIRI's independent reasoning as a fallback.
Reconnect uses the same binding and event sequence, with bounded replay and duplicate
protection. Stale actions from a previous mode epoch cannot change the new mode.

Select Return to Normal Mode to cancel owned work, drain speech, restore the captured
presentation, and resume AIRI's normal behavior. Saved presentation profiles remain
available, but selecting Normal Mode does not apply one implicitly.

## Diagnostics

- HTTP 403 before connection: check exact `allowedOrigins` and the client URL.
- Authentication error: check the person's credential and allowed agent IDs.
- Ready but no speech: test TTS in AIRI, then check mute, volume, and browser audio activation.
- No microphone transcript: test STT independently, permissions, selected input, and listening mode.
- Unsupported selection: refresh capabilities; do not substitute a similar ID silently.
- Presentation timeout: inspect the AIRI renderer/provider error, reconnect if necessary,
  and refresh state before retrying.
- Replay gap: the bounded journal cannot reconstruct the missing interval. Preserve the
  existing transcript and inspect OpenClaw history; do not auto-resend old user input.
- Native approval: respond only to the decisions actually offered by OpenClaw. The channel
  cannot grant itself approval authority. A missing approval is not permission to bypass policy.

Gateway diagnostics identify dispatch and transport failures. Do not publish raw
conversation journals or provider configuration as troubleshooting output.

## Verification and removal

Automated protocol or mocked presentation tests do not establish actual avatar rendering,
physical microphone capture, audible output, or native approval compatibility. Record
provider versions, platform, avatar format, and whether each result is live or mocked.

Disable the plugin and channel through supported OpenClaw configuration, then perform
a supported reload. Return AIRI to Normal Mode and revoke the connection credential.
The upstream AIRI install remains usable without Agent Mode. Back up local profile and
Normal Mode restoration data before clearing application storage. See the plugin guide
for uninstall commands and journal retention.

## Tested speech-service fixture

The development evidence uses a **local test fixture**, not a bundled production speech
service. AIRI connects to its existing OpenAI-compatible audio adapters at a configurable
loopback base URL. The fixture maps `tts-1` to installed macOS `say` voices and
`whisper-1` to Whisper.cpp 1.9.5 with the English `base.en` model. The two exercised
voice aliases are `alloy` (Samantha) and `echo` (Albert). These are fixture aliases,
not claims about OpenAI voice compatibility or cloned-voice support.

The checksum-verified model is 147,964,211 bytes with SHA256
`a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`.
FFmpeg 9.0.2 converts input audio to 16 kHz mono PCM. STT output is not exact: the test
utterance's word “AIRI” was recognized as “Ira.” Record transcription quality separately
from channel routing. Production providers must be tested with their own endpoints,
model IDs, permissions, CORS behavior, and available voices.

Actual browser audio playback was captured after the AIRI volume stage. Synthetic
microphone fixtures exercise capture and STT plumbing; they do not prove physical
microphone acoustics, speaker-to-microphone echo cancellation, or every supported
platform. Hardware checks remain distinct acceptance evidence.
