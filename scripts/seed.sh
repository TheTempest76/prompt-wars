#!/usr/bin/env bash
# Seeds the world with the ~30 creatures in scripts/seed_prompts.txt (one
# line per prompt), by calling spawn_from_prompt once per line. Each call
# round-trips through Groq, so this takes a couple of minutes for the full
# file -- expected, not a hang.
#
# Usage:
#   bash scripts/seed.sh                  # seeds --server local
#   bash scripts/seed.sh --server maincloud
#
# Requires: the `spacetime` CLI on PATH, logged in if targeting maincloud,
# and an LLM key already set via `set_llm_key` on the target server (see
# CLAUDE.md's "LLM secret" decision) -- without one, spawns still succeed
# but fall back to DEFAULT_CREATURE_PARAMS instead of an LLM-matched
# emoji/habitat.
set -euo pipefail

SERVER="local"
if [[ "${1:-}" == "--server" && -n "${2:-}" ]]; then
  SERVER="$2"
fi

PROMPTS_FILE="$(dirname "$0")/seed_prompts.txt"
DB_NAME="prompt-wars"

i=0
while IFS= read -r line; do
  line="${line%$'\r'}"   # tolerate CRLF line endings (this repo is Windows)
  [[ -z "$line" ]] && continue
  i=$((i + 1))
  echo "[$i] $line"
  spacetime call "$DB_NAME" spawn_from_prompt "\"$line\"" --server "$SERVER"
done < "$PROMPTS_FILE"

echo "Seeded $i creatures on --server $SERVER"
