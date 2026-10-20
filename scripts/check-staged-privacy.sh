#!/bin/bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

author_name="$(git config user.name || true)"
author_email="$(git config user.email || true)"
if [[ "$author_name" != "WAI Bridge Contributor" || "$author_email" != "wai-bridge-contributor@users.noreply.github.com" ]]; then
  echo 'Commit bloqueado: configure uma identidade pública não pessoal para este repositório:' >&2
  echo '  git config user.name "WAI Bridge Contributor"' >&2
  echo '  git config user.email "wai-bridge-contributor@users.noreply.github.com"' >&2
  exit 1
fi

python3 - <<'PY'
import re
import subprocess
import sys

raw = subprocess.check_output(['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
paths = [p.decode('utf-8', errors='replace') for p in raw.split(b'\0') if p]
blocked = []
for path in paths:
    normalized = path.replace('\\', '/')
    name = normalized.rsplit('/', 1)[-1]
    lower_name = name.lower()
    if lower_name == '.env' or lower_name.endswith('.env') or (lower_name.startswith('.env.') and not lower_name.endswith('.example')):
        blocked.append(path)
        continue
    if lower_name in {'.npmrc', '.envrc', 'host-config.json', '.credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'}:
        blocked.append(path)
        continue
    if re.search(r'(^|/)(\.local-data|\.macos|data|backups?|media|conversation-data|whatsapp-data|private-data|runtime-data|captures|artifacts-private|logs?)(/|$)', normalized, re.I):
        blocked.append(path)
        continue
    if re.search(r'\.(sqlite(?:3)?(?:[-.].*)?|db(?:3)?(?:[-.].*)?|log|pem|key|p12|pfx|keystore|token|har|pcap|trace|crash|ips|bak|backup|dump)$', name, re.I):
        blocked.append(path)
        continue
    if re.search(r'\.(png|jpe?g|gif|webp|heic|mov|mp4|m4v|mp3|m4a|wav|ogg|pdf|zip|tar|gz)$', name, re.I):
        blocked.append(path)
        continue
    if re.search(r'(?:^|[._-])(credentials?|secrets?)(?:[._-]|$)', name, re.I):
        blocked.append(path)

if blocked:
    print('Commit bloqueado: estes caminhos podem conter dados locais/privados:')
    for path in blocked:
        print(f'  {path}')
    print('Remova-os do stage e mantenha dados privados fora do repositório.')
    sys.exit(1)
PY

if ! command -v gitleaks >/dev/null 2>&1; then
  echo 'Commit bloqueado: Gitleaks não está instalado. No macOS, instale com: brew install gitleaks' >&2
  exit 1
fi

gitleaks git --pre-commit --staged --redact --verbose
