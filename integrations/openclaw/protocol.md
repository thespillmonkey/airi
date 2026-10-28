# AIRI / OpenClaw wire contract v1

The authoritative strict schemas are in
[`packages/openclaw-bridge/src/contracts.ts`](../../packages/openclaw-bridge/src/contracts.ts).
Both endpoints validate inbound and outbound frames. Unknown properties, invalid
versions, and frames sent in the wrong direction are rejected. Frames are bounded
at 1 MiB. IDs are nonempty strings of at most 256 characters; response text is
bounded at 131,072 characters.

## Transport and envelope

Connect a WebSocket to `/plugins/airi/v1`. Authenticate in the first frame within
five seconds. Never put credentials in the URL. Remote clients require TLS; only
loopback clients may use plain WebSocket. Browser origins must match the plugin's
explicit allowlist.

Every client frame has this Eventa envelope:

```json
{
  "id": "airi:openclaw:v1:client",
  "type": "event",
  "body": {
    "version": 1,
    "type": "hello",
    "token": "provided-at-runtime",
    "clientId": "stable-client-id",
    "conversationId": "stable-airi-conversation-id",
    "agentId": "allowed-existing-agent"
  }
}
```

Server frames use `id: "airi:openclaw:v1:server"` with the same outer `type`.
Every body contains `version: 1` and a discriminating `type`.

## Client messages

- `hello`: token, clientId, conversationId, agentId, optional lastSequence.
- `user.message`: stable messageId, text, and input (`text` or `voice`). Voice
  carries an STT transcript, not binary audio. STT credentials and recordings stay
  in AIRI's provider path.
- `turn.cancel`: exact messageId. It does not cancel another client's work.
- `capabilities.update`: current capabilities and effective presentation state.
- `presentation.result`: correlated actionId, ok, optional state, capabilities,
  profiles, and error. Successful mutation results must reflect applied state.
- `approval.resolve`: recorded approvalId and an allowed decision (`allow-once`,
  `allow-always`, or `deny`). The plugin checks the native actor and policy.

## Server messages

- `ready`: connectionId, canonical sessionKey, selected agentId, permitted agents,
  and optional capabilities. It confirms an authenticated binding, not an active run.
- `response.accepted`: messageId, sessionKey, sequence. This is admission; it does
  not assert transcript persistence.
- `response.delta`: messageId, incremental text suffix, sequence.
- `response.final`: messageId, complete terminal user-facing text, sequence.
- `response.cancelled`: messageId and sequence.
- `response.error`: optional messageId, code, bounded diagnostic message, sequence.
- `status`: state (`thinking`, `listening`, `speaking`, `idle`, or `disconnected`)
  and sequence. Status is presentation metadata, not spoken content.
- `presentation.request`: actionId and a validated presentation command.
- `approval.request`: approvalId, kind, description, optional expiresAt, and
  allowedDecisions. A request frame alone is not evidence that a tool was authorized.
- `approval.resolved`: approvalId, status (`resolved`, `expired`, or `cancelled`),
  optional decision and applicationStatus (`applied` or `not-applied`), and sequence.
  The client keeps a submitted decision pending until this native acknowledgement.
  Expiry and external resolution remove the stale prompt as well.

## Ordering and recovery

The authenticated principal, client, conversation, and agent determine the canonical
session. Model arguments cannot change that routing. A new socket for the same
binding supersedes its previous socket; it does not create a new conversation.

Conversation response/status events carry monotonically increasing sequence values.
Reconnect supplies the last received value. The client ignores duplicate sequence
numbers. The durable bounded journal retains 256 events and 256 admitted message
identities. Reusing an admitted messageId never invokes reasoning twice. A replay
gap or exhausted identity journal returns an explicit error rather than re-running
old input. Pending messages not yet admitted may be retried with the same identity.

After host restart, an interrupted admission becomes an explicit uncertain/error
outcome. It is not automatically re-executed. Client admission defaults to a
30-second deadline and terminal completion to a 30-minute deadline.

The native dispatcher finishes teardown before committing and publishing one terminal
event. Admission release and that terminal journal write are atomic with respect to
follow-up input. Core cumulative text previews are converted to incremental deltas;
a non-monotonic revision stops further deltas until the corrected final text.

Presentation requests have separate action IDs and are never spoken. The client
remembers processed actions to prevent replayed mutations. A mutation acknowledgement
is bounded at 15 seconds; timeout makes state uncertain until a fresh snapshot or
state read. A transport acceptance is never a successful mutation acknowledgement.

AIRI owns speech segmentation and ordered playback. Replayed text cannot create
second playback. Mode epochs guard delayed callbacks, and explicit disconnect clears
the token and owned pending work. Bridge failure does not select Normal Mode.

## Presentation objects

State contains revision, effective scope, optional avatarId, voice, profileId, and
supported settings. Voice selections reference providerId, modelId, and voiceId;
they never copy provider credentials. Capabilities describe available avatars and
formats, loaded controls, voices, models, discovery limitations, setting ranges,
and supported profile scopes.

Commands are `state.read`, `avatars.list`, `avatar.select`, `avatar.control`,
`voices.list`, `voice.select`, `settings.update`, `settings.restore`, `profiles.list`,
`profile.save`, `profile.apply`, `profile.delete`, and `presentation.restore`.
See the [operation guide](guide.md) for exact examples and current client limitations.
