#!/bin/bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then echo "macOS only." >&2; exit 1; fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SUPPORT_DIR="${HOME}/Library/Application Support/WaiBridge"
DB_PATH="$SUPPORT_DIR/data/wai-bridge.sqlite"
BACKUP_DIR="$SUPPORT_DIR/backups"
if [[ ! -f "$DB_PATH" ]]; then echo "Database not found: $DB_PATH" >&2; exit 1; fi
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/wai-bridge-$STAMP.sqlite"
cd "$ROOT"
node apps/mac-agent/scripts/backup-database.mjs "$DB_PATH" "$DEST"
echo "Backup created: $DEST"
