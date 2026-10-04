#!/usr/bin/env bash
# Ask every chat deployment in tiers.yaml for one word through LiteLLM and print the HTTP
# status, so a retired model or a bad key shows up before a customer's run does.
#   cd /opt/kritvia/infra && sudo infra/scripts/probe-models.sh
# Run from cron too if you like; it prints nothing secret.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/load-env.sh; load_env ../.env
models=$(grep -E '^\s+- model_name:' litellm/config.yaml | awk '{print $3}' | grep -vE 'whisper|bge')
rc=0
for m in $models; do
  code=$(docker compose exec -T api python - "$m" <<'PY'
import os, sys, httpx
m = sys.argv[1]
r = httpx.post(os.environ["LITELLM_BASE_URL"] + "/v1/chat/completions", timeout=60,
               headers={"Authorization": "Bearer " + os.environ.get("LITELLM_API_KEY", "")},
               json={"model": m, "messages": [{"role": "user", "content": "Say OK"}], "max_tokens": 5})
print(r.status_code)
PY
  )
  printf "%-18s %s\n" "$m" "${code:-ERR}"
  [ "$code" = "200" ] || rc=1
done
exit $rc
