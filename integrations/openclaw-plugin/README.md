# AIRI channel plugin

This package connects AIRI Agent Mode to an existing OpenClaw agent.
The agent keeps its identity, tools, memory, and permission policy.
The plugin does not replace an inference provider.

## Status

The initial compatibility target is OpenClaw **2026.10.3**.
The plugin rejects other host versions until compatibility tests cover them.
The Plugin SDK is experimental.
Automated tests do not prove live microphone, speech, avatar, or approval behavior.

## Build and install

From the repository root:

```sh
pnpm -F @proj-airi/openclaw-bridge build
pnpm -F @proj-airi/openclaw-plugin build
pnpm -F @proj-airi/openclaw-plugin typecheck
pnpm -F @proj-airi/openclaw-plugin test:run
cd integrations/openclaw-plugin
pnpm run pack:standalone
openclaw plugins install ./proj-airi-openclaw-plugin-0.1.0.tgz
```

Installation needs a supported Gateway reload before the endpoint becomes available.
Do not restart a production Gateway while unrelated work is active.

## Configuration

The plugin uses environment references or managed SecretRefs for credentials.
It never stores credentials in presentation profiles or the source tree.
Use a different random credential for each person.
Each credential must contain at least 32 characters.

Example configuration fragment:

```json
{
  "plugins": {
    "entries": {
      "airi": {
        "enabled": true,
        "config": {
          "clients": [
            {
              "principalId": "gary",
              "tokenEnv": "AIRI_GARY_TOKEN",
              "agentIds": ["mitsuki"]
            }
          ],
          "allowedOrigins": ["http://localhost:5173"]
        }
      }
    }
  },
  "channels": { "airi": { "enabled": true } },
  "tools": { "alsoAllow": ["airi_presentation"] }
}
```

Give the Gateway process the credential through its normal protected environment.
Give the same credential to AIRI through its connection settings.
The first WebSocket message carries authentication.
Credentials never enter the WebSocket URL.
Use `wss://gateway.example/plugins/airi/v1` between machines.
Use `ws://127.0.0.1:18789/plugins/airi/v1` only on the same machine.

`allowedOrigins` contains exact browser origins.
A browser origin absent from this list receives HTTP 403.
Desktop clients without an Origin header still require first-message authentication.
Each person can select only an agent from their `agentIds` list.
The selected agent must exist in OpenClaw.

## Routing and recovery

The session key binds the authenticated person, client, conversation, and agent.
Switching input method, avatar, or voice preserves that key.
A replacement socket disconnects the previous socket for the same binding.
An unrelated person or client cannot address that session through presentation tools.

The plugin stores a journal under the OpenClaw state directory, in `plugins/airi`.
Journal files contain response text and opaque route identities, not credentials.
They use mode `0600` in a mode `0700` directory.
Each journal retains 256 events and 256 message identities.
Duplicate message identities never start another run.
A full identity journal requires a new AIRI conversation.

After a host restart, interrupted admissions return an explicit error.
The plugin never reruns those messages automatically.
After a replay gap, the client must recover the saved OpenClaw history before another connection.
The plugin does not silently discard a gap.

`response.accepted` means authenticated channel admission.
It does not prove that OpenClaw saved a transcript row.
`response.delta` carries incremental sanitized text, not a complete preview.
A non-monotonic core revision stops further deltas until the corrected terminal response.
Only terminal user-facing response content belongs in the speech queue.
A single terminal response follows native runtime teardown.
The journal releases admission and saves that response before publication.
An immediate follow-up can start when the terminal response arrives.
A targeted cancel aborts only the corresponding agent run.

## Agent presentation tool

`airi_presentation` is an optional tool.
Add it to the selected agent’s tool allowlist, for example with `tools.alsoAllow: ["airi_presentation"]`.
It appears only in AIRI channel turns.
The tool binds to the trusted current sender and session.
Model arguments cannot choose another person, client, or session.

Example calls:

```json
[
  { "command": { "operation": "avatars.list" } },
  { "command": { "operation": "voices.list" } },
  { "command": { "operation": "avatar.select", "avatarId": "configured-avatar-id", "scope": "client" } },
  { "command": { "operation": "voice.select", "voice": { "providerId": "configured-provider", "modelId": "configured-model", "voiceId": "configured-voice" } } },
  { "command": { "operation": "settings.update", "settings": { "speechVolume": 0.6 } } },
  { "command": { "operation": "profile.save", "name": "Work", "scope": "client" } },
  { "command": { "operation": "presentation.restore" } }
]
```

The shared contract lists every command.
The shipped AIRI adapter supports client scope.
Other scopes require explicit client capability support.
Agent and application defaults affect other conversations and return an explicit error.
The client must advertise capabilities before a change.
The tool waits for a correlated client acknowledgement and returns the effective state.
Unsupported avatars, controls, voices, parameters, and settings fail before transport.

A timeout or cancellation leaves the effective state uncertain.
Read `state.read` before another change.
Disconnect rejects pending commands and clears the capability snapshot.
A new client snapshot restores discovery.
The tool does not report success from a queued request alone.

## Approvals

The channel uses OpenClaw's approval policy and shared `/approve` command.
The public SDK native runtime subscribes to exec, plugin, and system-agent approval events.
The adapter delivers only events for the exact authenticated AIRI conversation.
It also accepts public SDK approval metadata attached to channel replies.
A client decision must match the recorded approval and allowed decision set.
The plugin sends the SDK's canonical approval command as the same authenticated sender.
The pending card remains until core acknowledges resolution, expiry, or cancellation.
Those terminal events are sequenced and replay after reconnect.
Core enforces the reviewer policy and pending-request lifetime.
The plugin never auto-approves tools or grants its own Gateway scopes.

Live verification on the isolated Linux Gateway 2026.10.3 covered actual agent exec approval: deny, allow-once, core acknowledgement, and rejection of another client/conversation.
The allowed exec returned an exact printf marker; the denied exec returned an error.
The test model then looped in its own yield tool after the allowed result, so a bounded test cancelled that turn; a clean natural-language final after allow was not verified in that run.
Plugin and system-agent approval kinds have SDK adapter tests but remain unverified live.
Do not treat a mocked approval result as live verification.

## Limits and diagnostics

The endpoint allows 32 sockets, 32 queued inbound frames, and 1 MiB frames.
First-message authentication must finish in five seconds.
The account owns a passive listener until its abort signal ends.
Status reports `listening` with zero authenticated clients.
The `connected` flag is present only with authenticated sockets.
The client count remains explicit in the status snapshot.
Presentation acknowledgements must arrive in 15 seconds.
A full outbound queue closes the slow connection.
The client receives bounded error categories instead of raw provider exceptions.
Use Gateway diagnostics to inspect dispatch failures.

A disconnected Agent Mode never activates normal AIRI inference.
The AIRI client owns mode state, speech cancellation, settings restoration, and application permissions.

## Disable and remove

Disable the AIRI plugin entry and the AIRI channel through normal OpenClaw configuration.
Then reload the Gateway during an approved maintenance window.
Switch AIRI back to Normal Mode.
Keep the AIRI settings backup and journal until recovery is complete.
Remove the plugin through `openclaw plugins uninstall airi` after it is disabled.
Revoke the credential from both endpoints.

## Hot installation with a managed secret

An existing Gateway process cannot receive a new environment variable from its parent shell.
For hot installation, use OpenClaw's supported SecretRef materialization instead of `tokenEnv`.
Each client accepts exactly one credential source: `token`, `tokenEnv`, or `tokenFile`.
The manifest declares `clients.*.token` as a secret input.
The Gateway resolves and redacts this input before the plugin loads.
The runtime rejects an unresolved reference.

Example source configuration:

```json
{
  "secrets": {
    "providers": {
      "airi-client-file": {
        "source": "file",
        "path": "~/.openclaw/secrets/airi-client-token",
        "mode": "singleValue"
      }
    }
  },
  "plugins": {
    "entries": {
      "airi": {
        "enabled": true,
        "config": {
          "clients": [
            {
              "principalId": "gary",
              "agentIds": ["mitsuki"],
              "token": { "source": "file", "provider": "airi-client-file", "id": "value" }
            }
          ]
        }
      }
    }
  }
}
```

The configured file contains only the credential, not this JSON example.
Use a private regular file owned by the Gateway user, with mode `0600` and one hard link.
OpenClaw enforces the file provider's ownership, permissions, size, and symlink rules.
The credential must contain 32 to 4096 characters.
Presentation profiles never contain this credential.

After you configure the provider and reference, refresh secrets and reload the plugin:

```sh
openclaw secrets reload
openclaw plugins reload airi --wait --accept-capabilities
```

The public operations support plugin-only reload. Fresh private Gateway startup with this SecretRef was live verified.
Hot first activation on an already-running Gateway remained blocked by host materialization of a previously disabled plugin.
Do not treat a successful secrets reload alone as authenticated bridge readiness.
Use the protected `tokenFile` option below when this host limitation applies.
Rotate a managed credential through the same refresh and reload sequence.
Do not configure multiple credential sources for one client.


## Protected file credential for hot activation

`tokenFile` is a plugin-owned protected credential reference.
It does not depend on host SecretRef activation or a new process environment variable.
For example, replace the credential field in one client with:

```json
{ "principalId": "gary", "agentIds": ["mitsuki"], "tokenFile": "/absolute/private/path/airi-client-token" }
```

The file contains only the credential. One terminal LF or CRLF is removed, matching single-value secret files; other bytes are unchanged.
It must be a regular file owned by the Gateway process user, mode `0600`, exactly one hard link, and 32 to 4096 UTF-8 bytes.
The plugin opens it with `O_NOFOLLOW` and rejects a final symlink, a relative path, unsafe permissions, an unsupported platform, and non-regular files.
Reads are bounded; errors never include the path or contents.
This option targets the tested Linux and macOS hosts, not Windows.
The plugin snapshots the credential at load and detects duplicate credentials across principals.
Rotate the file through a private write and reload only the AIRI plugin.
It never copies credentials into presentation profiles or client bundles.
Keep the previous file and source configuration available until an authenticated connection passes.
