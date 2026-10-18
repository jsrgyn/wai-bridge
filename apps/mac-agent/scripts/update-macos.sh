#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ "${1:-}" == "--load" ]]; then
  exec "$ROOT/apps/mac-agent/scripts/install-macos.sh" --load
elif [[ $# -eq 0 ]]; then
  exec "$ROOT/apps/mac-agent/scripts/install-macos.sh"
else
  echo "Usage: $0 [--load]" >&2
  exit 2
fi
