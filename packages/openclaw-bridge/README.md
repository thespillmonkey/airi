# OpenClaw bridge contracts and client

This package connects an AIRI client to the OpenClaw AIRI channel plugin. It does not perform inference or execute tools.

Use this package for Agent Mode transport. Do not use it as a normal AIRI model provider.

## Client

Create `OpenClawBridgeClient` with event, connection-state, and presentation callbacks. Call `connect` with the endpoint and authenticated binding.

Call `send` for typed input or STT transcripts. Its `accepted` promise confirms channel admission. Its `done` promise returns the final response.

The event callback receives streamed text and separate status, approval, and presentation events. Only response text belongs in speech playback.

Use `cancel` for one turn. Use `disconnect` to close the owned connection and clear in-memory credentials.

Use `updateCapabilities` after the loaded avatar or effective settings change. Presentation callbacks return effective state, not requested state.

## Contract

`contracts.ts` owns Eventa event names, Valibot schemas, and wire codecs. Unknown fields and cross-direction frames are rejected.

Remote endpoints require `wss`. Loopback endpoints can use `ws`. Credentials are forbidden in endpoint URLs.

Reconnect retains the selected session, event sequence, and pending turns. Protocol or authentication failures require explicit reconnection.

## Checks

Run `pnpm -F @proj-airi/openclaw-bridge typecheck` and `pnpm -F @proj-airi/openclaw-bridge test:run`.

These checks do not establish live AIRI, speech-provider, or OpenClaw runtime compatibility.
