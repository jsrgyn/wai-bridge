#!/bin/bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then echo "macOS only." >&2; exit 1; fi
if [[ "${1:-}" != "--confirm" || -z "${2:-}" || $# -ne 2 ]]; then
  echo "Usage: $0 --confirm <backup.sqlite>" >&2
  echo "This replaces the active database after saving a pre-restore backup." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLIST="${HOME}/Library/LaunchAgents/com.wai-bridge.local-api.plist"
SUPPORT_DIR="${HOME}/Library/Application Support/WaiBridge"
DATA_DIR="$SUPPORT_DIR/data"
BACKUP="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
if [[ ! -f "$BACKUP" ]]; then echo "Backup file not found." >&2; exit 1; fi
if launchctl print "gui/$(id -u)/com.wai-bridge.local-api" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$PLIST"
fi
mkdir -p "$DATA_DIR" "$SUPPORT_DIR/backups"
chmod 700 "$DATA_DIR" "$SUPPORT_DIR/backups"
cd "$ROOT"
node apps/mac-agent/scripts/restore-database.mjs "$BACKUP" "$DATA_DIR/wai-bridge.sqlite" "$SUPPORT_DIR/backups"
echo "Database restored. Service remains stopped; run install-macos.sh --load after reviewing the restored state."
