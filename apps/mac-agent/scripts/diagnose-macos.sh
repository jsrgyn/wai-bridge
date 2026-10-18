#!/bin/bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then echo "macOS only." >&2; exit 1; fi
SUPPORT_DIR="${HOME}/Library/Application Support/WaiBridge"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG_DIR="${HOME}/Library/Logs/WaiBridge"
DB_PATH="$SUPPORT_DIR/data/wai-bridge.sqlite"
PLIST="${HOME}/Library/LaunchAgents/com.wai-bridge.local-api.plist"
MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wai_bridge.mac_agent.json"
echo "WAI Bridge local diagnostics"
echo "Node: $(command -v node || echo missing)"
echo "pnpm: $(command -v pnpm || echo missing)"
echo "LaunchAgent plist: $([[ -f "$PLIST" ]] && echo present || echo missing)"
if launchctl print "gui/$(id -u)/com.wai-bridge.local-api" >/dev/null 2>&1; then echo "LaunchAgent state: loaded"; else echo "LaunchAgent state: not loaded"; fi
echo "Native Messaging manifest: $([[ -f "$MANIFEST" ]] && echo present || echo missing)"
echo "Data directory: $([[ -d "$SUPPORT_DIR/data" ]] && echo present || echo missing)"
echo "Log directory: $([[ -d "$LOG_DIR" ]] && echo present || echo missing)"
if [[ -f "$SUPPORT_DIR/host-config.json" ]]; then
  MODE="$(stat -f '%Lp' "$SUPPORT_DIR/host-config.json")"
  echo "Host config permissions: $MODE (expected 600)"
else echo "Host config: missing"; fi
if [[ -f "$DB_PATH" ]]; then
  cd "$ROOT"
  node --input-type=module - "$DB_PATH" <<'NODE'
import Database from 'better-sqlite3';
const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});
try{console.log(`SQLite integrity: ${db.pragma('integrity_check',{simple:true})}`);console.log(`Schema version: ${db.prepare('SELECT MAX(version) AS version FROM wa_schema_migrations').get()?.version??'unknown'}`);}
finally{db.close();}
NODE
else echo "SQLite database: missing"; fi
if command -v curl >/dev/null && curl --silent --fail --max-time 2 http://127.0.0.1:47831/health >/dev/null; then echo "Local API health: available"; else echo "Local API health: unavailable"; fi
echo "Token contents are never printed. Logs are stored under $LOG_DIR."
