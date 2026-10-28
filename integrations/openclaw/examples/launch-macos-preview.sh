#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail 'This launcher requires macOS.'
preview_app=${AIRI_PREVIEW_APP:-"$HOME/Applications/AIRI OpenClaw Preview.app"}
preview_data=${AIRI_PREVIEW_DATA:-"$HOME/Library/Application Support/AIRI OpenClaw Preview"}
preview_port=${AIRI_PREVIEW_CHANNEL_PORT:-6125}
expected_id=${AIRI_PREVIEW_BUNDLE_ID:-ai.moeru.airi.openclaw-preview}

[ -d "$preview_app" ] || fail 'Set AIRI_PREVIEW_APP to the preview .app directory.'
actual_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$preview_app/Contents/Info.plist")
[ "$actual_id" = "$expected_id" ] || fail 'The application bundle identifier does not match the preview identifier.'
[ "$actual_id" != ai.moeru.airi ] || fail 'The stable AIRI application cannot use this launcher.'
case "$preview_port" in
  ''|*[!0-9]*) fail 'AIRI_PREVIEW_CHANNEL_PORT must be an integer.' ;;
esac
[ "$preview_port" -ge 1024 ] && [ "$preview_port" -le 65535 ] || fail 'Choose an unprivileged TCP port from 1024 to 65535.'
[ "$preview_port" -ne 6121 ] || fail 'The preview cannot use the normal AIRI channel port 6121.'

mkdir -p "$preview_data"
preview_data=$(cd "$preview_data" && pwd -P)
normalized_data=$(printf '%s' "$preview_data" | tr '[:upper:]' '[:lower:]')
normalized_support=$(printf '%s' "$HOME/Library/Application Support" | tr '[:upper:]' '[:lower:]')
case "$normalized_data" in
  "$normalized_support/airi"|"$normalized_support/ai.moeru.airi")
    fail 'The preview cannot use a normal AIRI data directory.' ;;
esac

export APP_USER_DATA_PATH="$preview_data"
export SERVER_CHANNEL_PORT="$preview_port"
mode=gui
case "${1:-}" in
  --gui) shift ;;
  --direct) mode=direct; shift ;;
esac

for argument in "$@"; do
  case "$argument" in
    --user-data-dir|--user-data-dir=*)
      fail 'Set AIRI_PREVIEW_DATA instead of passing --user-data-dir.' ;;
  esac
done

if [ "$mode" = gui ]; then
  if [ -n "${AIRI_PREVIEW_LOG_DIR:-}" ]; then
    mkdir -p "$AIRI_PREVIEW_LOG_DIR"
    exec /usr/bin/open -n -a "$preview_app" \
      --env "APP_USER_DATA_PATH=$APP_USER_DATA_PATH" \
      --env "SERVER_CHANNEL_PORT=$SERVER_CHANNEL_PORT" \
      -o "$AIRI_PREVIEW_LOG_DIR/stdout.log" \
      --stderr "$AIRI_PREVIEW_LOG_DIR/stderr.log" \
      --args "--user-data-dir=$APP_USER_DATA_PATH" "$@"
  fi
  exec /usr/bin/open -n -a "$preview_app" \
    --env "APP_USER_DATA_PATH=$APP_USER_DATA_PATH" \
    --env "SERVER_CHANNEL_PORT=$SERVER_CHANNEL_PORT" \
    --args "--user-data-dir=$APP_USER_DATA_PATH" "$@"
fi

exec "$preview_app/Contents/MacOS/airi" "--user-data-dir=$APP_USER_DATA_PATH" "$@"
