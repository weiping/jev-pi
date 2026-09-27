#!/usr/bin/env bash
# SessionStart: install Python dependencies into the persistent plugin data directory.
# Runs synchronously; after the first install it only compares two small files.
# The copied requirements.txt doubles as the "install finished" marker for run-hook.sh.
ROOT="${CLAUDE_PLUGIN_ROOT}"
DATA="${CLAUDE_PLUGIN_DATA}"
cat > /dev/null
mkdir -p "$DATA"
if diff -q "$ROOT/requirements.txt" "$DATA/requirements.txt" >/dev/null 2>&1; then
  exit 0
fi
# 同时开了几个会话时，只让一个去装
mkdir "$DATA/.installing" 2>/dev/null || exit 0
trap 'rmdir "$DATA/.installing"' EXIT
PY="${JEV_PYTHON:-$(command -v python3)}"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "jev: Python 3.10+ not found, hooks stay inactive" >> "$DATA/setup.log"
  exit 0
fi
rm -f "$DATA/requirements.txt"
{ "$PY" -m venv "$DATA/venv" \
  && "$DATA/venv/bin/pip" install -q -r "$ROOT/requirements.txt" \
  && cp "$ROOT/requirements.txt" "$DATA/requirements.txt"; } >> "$DATA/setup.log" 2>&1
exit 0
