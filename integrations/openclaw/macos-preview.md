# Isolated macOS preview

The preview uses a distinct app, data directory, and native AIRI channel port.
It does not replace the stable application.
The OpenClaw bridge address remains a separate connection setting.

## Prepare the app

Build an ARM64 application with a distinct bundle identifier, for example `ai.moeru.airi.openclaw-preview`.
Use `AIRI OpenClaw Preview` as its display name.
Build the desktop renderer with `VITE_AIRI_WS_URL=ws://127.0.0.1:6125/ws`.
This is a public local native-bus address, not a credential.
It must match the launcher's `AIRI_PREVIEW_CHANNEL_PORT`.
The renderer otherwise defaults to the stable native bus on port `6121`.
Changing the launcher port does not rewrite an already-built renderer.
An existing preview profile may also have a saved native-bus address.
Check that address in the preview's connection settings.
For a local build without an Apple certificate, use ad-hoc signing and disable notarization and publishing.
An ad-hoc signature does not provide Apple notarization or distribution trust.

After signature verification, copy the preview to `~/Applications/AIRI OpenClaw Preview.app`.
Keep the existing `airi.app` unchanged.

## Launch

From the repository root, run:

```sh
integrations/openclaw/examples/launch-macos-preview.sh --gui \
  --remote-debugging-port=9225 --remote-debugging-address=127.0.0.1
```

The defaults are:

- App: `~/Applications/AIRI OpenClaw Preview.app`.
- Data: `~/Library/Application Support/AIRI OpenClaw Preview`.
- Bundle identifier: `ai.moeru.airi.openclaw-preview`.
- Native AIRI channel port: `6125`.

Set `AIRI_PREVIEW_APP`, `AIRI_PREVIEW_DATA`, `AIRI_PREVIEW_BUNDLE_ID`, or `AIRI_PREVIEW_CHANNEL_PORT` to change these values.
Set `AIRI_PREVIEW_LOG_DIR` to capture GUI stdout and stderr.
The launcher rejects the stable bundle identifier, known stable data directories, and native channel port `6121`.
Use an unused port when another preview already owns `6125`.

The launcher sets both `APP_USER_DATA_PATH` and Chromium's `--user-data-dir`.
The Electron launcher acquires its instance lock before AIRI main applies `APP_USER_DATA_PATH`.
The command-line directory therefore isolates the early launcher lock and storage too.
`SERVER_CHANNEL_PORT` prevents the preview from sharing the stable application's native event bus.

## SSH and Aqua

For a visible application, use the logged-in console user's Aqua session.
An SSH process alone does not establish that context.
Set absolute paths before this command:

```sh
console_user=$(stat -f '%Su' /dev/console)
console_uid=$(id -u "$console_user")
console_home=$(dscl . -read "/Users/$console_user" NFSHomeDirectory | cut -d ' ' -f 2-)
sudo launchctl asuser "$console_uid" sudo -u "$console_user" \
  env HOME="$console_home" \
  AIRI_PREVIEW_APP="$preview_app" AIRI_PREVIEW_DATA="$preview_data" \
  AIRI_PREVIEW_CHANNEL_PORT=6125 AIRI_PREVIEW_LOG_DIR="$preview_logs" \
  "$launcher_path" --gui --remote-debugging-port=9225 \
  --remote-debugging-address=127.0.0.1
```

These variables name the preview app, isolated data directory, log directory, and absolute launcher path.
The command requires local permission to enter the console user's session.
Do not stop the stable application to launch the preview.
`--direct` runs the binary instead of Launch Services. Use it from an existing GUI terminal when needed.

## Verify and close

Check the preview PID, bundle identifier, data directory, and listening ports separately from the stable app.
Use `http://127.0.0.1:9225/json/list` to identify the main stage and other Electron windows.
Do not navigate the main stage into the settings or chat window's route.

The AIRI desktop handles `SIGINT` through its graceful shutdown path.
Confirm the preview executable path before signaling its PID.
Do not send a process-name-wide signal because both apps use the executable name `airi`.

The initial local preview does not include a Godot engine export.
Live STT, TTS, avatar rendering, and OpenClaw approval checks require separate evidence.
Disable remote debugging when the preview no longer needs inspection.
Remove only the separate preview app and its chosen data directory to uninstall this setup.
