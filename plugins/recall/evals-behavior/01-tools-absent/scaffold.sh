#!/bin/sh
# Run by `claude plugin eval --scaffold` before the agent starts. It runs as the operator, inside the
# run's sandbox workspace: HOME is the sandbox home and the child Claude reads
# its config from the sibling "config" directory, but CLAUDE_CONFIG_DIR is not
# exported here, so the journal config is planted in both candidate locations.
# The workspace becomes its own git repository with no remote and is saved as
# a filesystem-project destination, so the plugin's hook routes to the eval
# Project on its first rung without a resolve_project round trip.
set -eu
git init -q . 2>/dev/null || true
ROOT="$(pwd -P)"
for d in "$(dirname "$HOME")/config" "$HOME/.claude"; do
  mkdir -p "$d"
  cat > "$d/recall-journal.json" <<JSON
{"version":7,"projectMemory":{"enabled":true,
  "global":{"workspace":{"id":"ws-eval-personal","name":"Personal"},"recallProject":{"id":"proj-eval-ai","name":"AI"}},
  "paths":{"$ROOT":{"workspace":{"id":"ws-eval-personal","name":"Personal"},"recallProject":{"id":"proj-eval-ai","name":"AI"}}}}}
JSON
done
