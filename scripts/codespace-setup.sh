#!/usr/bin/env bash
# One-time setup inside a Codespace / dev container.
set -euo pipefail
cd "$(dirname "$0")/.."
sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client >/dev/null
python -m pip install -q --upgrade pip
python -m pip install -q -e "apps/api[dev]"
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
echo "setup done"
