#!/bin/bash
# Reinício seguro da Local API gerenciada pelo launchd após atualizar o código.
#
#   scripts/restart-local-services.sh           build, backup verificado, kickstart e confirmação
#   scripts/restart-local-services.sh --check   somente leitura: detecta processo/schema desatualizado
#
# Não lê tokens, configuração do launcher nem conteúdo de mensagens.
set -euo pipefail

LABEL="com.wai-bridge.local-api"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_MAIN="$ROOT/apps/local-api/dist/main.js"
MIGRATIONS_DIR="$ROOT/packages/database/src/migrations"
DB_PATH="${WAI_BRIDGE_DB_PATH:-$HOME/Library/Application Support/WaiBridge/data/wai-bridge.sqlite}"
WAIT_SECONDS=15

usage() {
  echo "Uso: $0 [--check]" >&2
  exit 2
}

MODE="restart"
if [[ $# -gt 1 ]]; then usage; fi
if [[ $# -eq 1 ]]; then
  if [[ "$1" == "--check" ]]; then MODE="check"; else usage; fi
fi

fail() {
  echo "ERRO: $*" >&2
  exit 1
}

latest_migration() {
  local latest="" file name
  shopt -s nullglob
  for file in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]-*.sql; do
    name="$(basename "$file")"
    latest="${name%%-*}"
  done
  shopt -u nullglob
  [[ -n "$latest" ]] || fail "nenhuma migration encontrada em packages/database/src/migrations"
  echo $((10#$latest))
}

# Percent-encode os caracteres que quebrariam uma URI file: do SQLite (% primeiro).
uri_path() {
  local path="$1"
  path="${path//%/%25}"
  path="${path//\?/%3F}"
  path="${path//\#/%23}"
  echo "$path"
}

schema_version() {
  [[ -f "$DB_PATH" ]] || fail "banco não encontrado"
  local version
  version="$(sqlite3 "file:$(uri_path "$DB_PATH")?mode=ro" 'SELECT COALESCE(MAX(version), 0) FROM wa_schema_migrations' 2>/dev/null)" ||
    fail "não foi possível ler a versão do schema"
  echo "${version:-0}"
}

api_pid() {
  local pid
  pid="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }')" || true
  echo "${pid:-}"
}

# Segundos desde o início do processo (campo etime do ps: [[dd-]hh:]mm:ss).
process_age_seconds() {
  local etime days=0 rest h m s
  local -a parts
  etime="$(LC_ALL=C ps -o etime= -p "$1" 2>/dev/null | tr -d '[:space:]')" || true
  [[ -n "$etime" ]] || return 1
  rest="$etime"
  if [[ "$rest" == *-* ]]; then
    days="${rest%%-*}"
    rest="${rest#*-}"
  fi
  IFS=: read -r -a parts <<<"$rest"
  case "${#parts[@]}" in
    3) h="${parts[0]}" m="${parts[1]}" s="${parts[2]}" ;;
    2) h=0 m="${parts[0]}" s="${parts[1]}" ;;
    *) return 1 ;;
  esac
  echo $((10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

run_check() {
  [[ -f "$DIST_MAIN" ]] || fail "build ausente: apps/local-api/dist/main.js (rode pnpm build)"
  local pid age started built latest current needs=0
  pid="$(api_pid)"
  [[ -n "$pid" ]] || fail "o processo da Local API ($LABEL) não está em execução"
  age="$(process_age_seconds "$pid")" || fail "não foi possível obter o início do processo da Local API"
  started=$(($(date +%s) - age))
  built="$(file_mtime "$DIST_MAIN")"
  latest="$(latest_migration)"
  current="$(schema_version)"
  if ((started < built)); then
    echo "processo da API iniciado antes do build atual de dist/main.js"
    needs=1
  fi
  if ((current < latest)); then
    echo "schema do banco na versão $current; última migration do repositório: $latest"
    needs=1
  fi
  if ((needs == 1)); then
    echo "reinício necessário: rode scripts/restart-local-services.sh"
    return 1
  fi
  echo "ok: processo da API posterior ao build e schema na versão $current"
}

run_restart() {
  local latest backup stamp ok q esc pid new_pid="" i age current
  latest="$(latest_migration)"
  [[ -f "$DB_PATH" ]] || fail "banco não encontrado"

  echo "1/5 build"
  (cd "$ROOT" && pnpm build) || fail "pnpm build falhou; nada foi reiniciado"

  echo "2/5 backup consistente do banco"
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$(dirname "$DB_PATH")/backup-$stamp.sqlite"
  [[ ! -e "$backup" ]] || fail "arquivo de backup já existe: $backup"
  q="'"
  esc="${backup//$q/$q$q}"
  (umask 077 && sqlite3 "file:$(uri_path "$DB_PATH")?mode=ro" "VACUUM INTO '$esc'") ||
    fail "backup falhou; reinício abortado"
  chmod 600 "$backup"
  ok="$(sqlite3 "file:$(uri_path "$backup")?mode=ro" 'PRAGMA integrity_check' 2>/dev/null || true)"
  [[ "$ok" == "ok" ]] || fail "backup não passou em integrity_check; reinício abortado (backup mantido para análise)"
  echo "backup verificado: $backup"

  echo "3/5 reinício pelo launchd"
  pid="$(api_pid)"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" || fail "launchctl kickstart falhou"

  echo "4/5 aguardando o novo processo (até ${WAIT_SECONDS}s)"
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    new_pid="$(api_pid)"
    if [[ -n "$new_pid" && "$new_pid" != "$pid" ]]; then
      age="$(process_age_seconds "$new_pid" || echo 9999)"
      if ((age <= WAIT_SECONDS + 5)); then break; fi
    fi
    new_pid=""
    sleep 1
  done
  [[ -n "$new_pid" ]] || fail "novo processo da API não apareceu em ${WAIT_SECONDS}s; veja os logs em ~/Library/Logs/WaiBridge/"

  echo "5/5 confirmando o schema"
  current=0
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    current="$(schema_version)"
    if ((current == latest)); then break; fi
    sleep 1
  done
  ((current == latest)) || fail "schema na versão $current; esperado $latest"
  echo "ok: API reiniciada e schema na versão $current"
  echo "Próximos passos: recarregue a extensão em chrome://extensions, recarregue a aba do WhatsApp Web e reinicie o cliente MCP."
}

if [[ "$MODE" == "check" ]]; then run_check; else run_restart; fi
