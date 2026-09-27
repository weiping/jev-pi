---
name: stats
description: Show how the Jev hooks have behaved in this project (calls, latency, decisions, output savings).
disable-model-invocation: true
---
Current Jev decision log summary:

!`CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" "${CLAUDE_PLUGIN_DATA}/venv/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/stats.py"`

Summarize this for me in a few sentences. Point out anything that suggests a threshold in
`.claude/jev/config.json` should change, for example many `ask` decisions from the permission
gate, or errors. Do not change the config yourself.
