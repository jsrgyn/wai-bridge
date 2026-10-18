#!/bin/bash
set -euo pipefail

SUPPORT_DIR="${HOME}/Library/Application Support/WaiBridge"
CHROME_MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wai_bridge.mac_agent.json"
PLIST="${HOME}/Library/LaunchAgents/com.wai-bridge.local-api.plist"
PURGE=0
if [[ "${1:-}" == "--purge" ]]; then PURGE=1; fi
if [[ "${OSTYPE:-}" != darwin* ]]; then echo "macOS only." >&2; exit 1; fi

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST" "$CHROME_MANIFEST" "$SUPPORT_DIR/native-host.sh" "$SUPPORT_DIR/start-local-api.sh"
if [[ "$PURGE" == 1 ]]; then
  rm -f "$SUPPORT_DIR/host-config.json"
fi
echo "Removed host registration and LaunchAgent. Local database/config are retained unless --purge was supplied."
