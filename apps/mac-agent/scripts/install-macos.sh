#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SUPPORT_DIR="${HOME}/Library/Application Support/WaiBridge"
DATA_DIR="$SUPPORT_DIR/data"
LOG_DIR="${HOME}/Library/Logs/WaiBridge"
CHROME_HOSTS="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
LOAD_AGENT=0
if [[ "${1:-}" == "--load" ]]; then LOAD_AGENT=1; elif [[ -n "${1:-}" ]]; then echo "Usage: $0 [--load]" >&2; exit 2; fi

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "This installer supports macOS only." >&2
  exit 1
fi
if [[ -z "${WAI_BRIDGE_EXTENSION_ID:-}" || -z "${WAI_BRIDGE_API_TOKEN:-}" ]]; then
  echo "Set WAI_BRIDGE_EXTENSION_ID and WAI_BRIDGE_API_TOKEN before running." >&2
  exit 1
fi

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$SUPPORT_DIR" "$DATA_DIR" "$LOG_DIR" "$LAUNCH_AGENTS" "$CHROME_HOSTS"
chmod 700 "$SUPPORT_DIR" "$DATA_DIR" "$LOG_DIR"

export WAI_BRIDGE_SUPPORT_DIR="$SUPPORT_DIR"
node apps/mac-agent/scripts/write-config.mjs

NODE_BIN="$(command -v node)"
HOST_LAUNCHER="$SUPPORT_DIR/native-host.sh"
API_LAUNCHER="$SUPPORT_DIR/start-local-api.sh"
cat > "$HOST_LAUNCHER" <<EOF
#!/bin/bash
export WAI_BRIDGE_HOST_CONFIG="$SUPPORT_DIR/host-config.json"
exec "$NODE_BIN" "$ROOT/apps/mac-agent/dist/main.js" "\$@"
EOF
cat > "$API_LAUNCHER" <<EOF
#!/bin/bash
set -euo pipefail
CONFIG="$SUPPORT_DIR/host-config.json"
export WAI_BRIDGE_API_TOKEN=\$("$NODE_BIN" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).apiToken)' "\$CONFIG")
export WAI_BRIDGE_DATA_DIR="$SUPPORT_DIR/data"
export WAI_BRIDGE_DB_PATH="$SUPPORT_DIR/data/wai-bridge.sqlite"
exec "$NODE_BIN" "$ROOT/apps/local-api/dist/main.js"
EOF
chmod 700 "$HOST_LAUNCHER" "$API_LAUNCHER"

export WAI_BRIDGE_NATIVE_MANIFEST_DIR="$CHROME_HOSTS"
export WAI_BRIDGE_NATIVE_HOST_PATH="$HOST_LAUNCHER"
node apps/mac-agent/scripts/write-native-manifest.mjs

PLIST="$LAUNCH_AGENTS/com.wai-bridge.local-api.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wai-bridge.local-api</string>
  <key>ProgramArguments</key><array><string>$API_LAUNCHER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$LOG_DIR/local-api.stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/local-api.stderr.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
if [[ "$LOAD_AGENT" == 1 ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "LaunchAgent loaded for the current user. Restart Chrome to discover the Native Messaging host."
else
  echo "Prepared files only. No persistent service was loaded. Review the plist, then run this script with --load to activate it."
fi
