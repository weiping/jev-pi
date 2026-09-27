#!/usr/bin/env bash
# Launch a hook with the plugin's own Python environment.
# Until setup.sh has finished installing it, every hook stays silent: no decision, exit 0.
DATA="${CLAUDE_PLUGIN_DATA:-/nonexistent}"
PY="$DATA/venv/bin/python"
if [ ! -f "$DATA/requirements.txt" ] || [ ! -x "$PY" ]; then
  cat > /dev/null
  exit 0
fi
exec "$PY" "${CLAUDE_PLUGIN_ROOT}/scripts/$1.py"
