#!/usr/bin/env bash
# Create .env with every secret Kritvia generates for itself, on the machine that will run it,
# so the secrets never travel anywhere else. Safe to re-run: only empty values are filled.
#
#   bash scripts/make-env.sh app.yourdomain.com api.yourdomain.com
#
# Afterwards add the keys only you can get (GROQ_API_KEY, CLOUDFLARE_TUNNEL_TOKEN, ...) —
# see docs/runbook.md — and back up MASTER_KEK_B64 offline.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB_HOST="${1:-}"
API_HOST="${2:-}"

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
[ -f .env ] || cp .env.example .env
chmod 600 .env

get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }
set_var() {  # set_var NAME VALUE  (replaces the line, keeps the rest of the file)
  python3 - "$1" "$2" <<'PY'
import re, sys
name, value = sys.argv[1], sys.argv[2]
lines = open(".env").read().splitlines()
for i, l in enumerate(lines):
    if re.match(rf"^{re.escape(name)}=", l):
        lines[i] = f"{name}={value}"
        break
else:
    lines.append(f"{name}={value}")
open(".env", "w").write("\n".join(lines) + "\n")
PY
}
fill() { [ -n "$(get "$1")" ] || { set_var "$1" "$2"; echo "  generated $1"; }; }

echo "Filling .env:"
# hex for anything that ends up inside a connection URL (base64 has / + =)
fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill KRITVIA_OWNER_PASSWORD "$(openssl rand -hex 24)"
fill KRITVIA_APP_PASSWORD "$(openssl rand -hex 24)"
fill VALKEY_PASSWORD "$(openssl rand -hex 24)"
fill JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fill SANDBOX_TOKEN "$(openssl rand -hex 32)"
fill DIARIZATION_TOKEN "$(openssl rand -hex 32)"
fill LITELLM_MASTER_KEY "sk-$(openssl rand -hex 24)"
[ -n "$(get LITELLM_API_KEY)" ] || { set_var LITELLM_API_KEY "$(get LITELLM_MASTER_KEY)"; echo "  set LITELLM_API_KEY = LITELLM_MASTER_KEY"; }
NEW_KEK=""
if [ -z "$(get MASTER_KEK_B64)" ]; then
  NEW_KEK="$(openssl rand -base64 32 | tr -d '\n')"   # 256-bit AES key, same as `cli new-kek`
  set_var MASTER_KEK_B64 "$NEW_KEK"
  echo "  generated MASTER_KEK_B64"
fi

if [ -n "$WEB_HOST" ] && [ -n "$API_HOST" ]; then
  set_var PUBLIC_WEB_URL "https://$WEB_HOST"
  set_var PUBLIC_API_URL "https://$API_HOST"
  set_var ALLOWED_ORIGINS "[\"https://$WEB_HOST\"]"
  set_var GOOGLE_REDIRECT_URI "https://$WEB_HOST/api/oauth/google/callback"
  echo "  set public URLs for $WEB_HOST / $API_HOST"
fi

echo
echo "Still empty — get these yourself (docs/runbook.md says where):"
for v in GROQ_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY SARVAM_API_KEY CLOUDFLARE_TUNNEL_TOKEN \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET HF_TOKEN BACKUP_AGE_RECIPIENT BACKUP_RCLONE_REMOTE; do
  [ -n "$(get "$v")" ] || echo "  $v"
done
if [ -n "$NEW_KEK" ]; then
  echo
  echo "!! Back up MASTER_KEK_B64 now (password manager + paper). Without it, encrypted data and"
  echo "!! backups cannot be recovered. Show it with:  grep ^MASTER_KEK_B64= .env"
fi
