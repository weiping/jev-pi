---
name: jev-init
description: Set up Jev for this project — generate .pi/jev/rules.json, tools.json and config.json from what is actually in the repository. Use when the user wants to initialize, configure, or re-scan Jev for the project.
disable-model-invocation: true
---
Run the `/jev:init` command. It sends the exact setup instructions: scan the repository
for guidance files, project tools, and sensitive paths, then write `.pi/jev/rules.json`,
`.pi/jev/tools.json` and `.pi/jev/config.json` in the project root. Work only inside
`.pi/jev/`; do not touch application code. Keep `"mode": "shadow"` until the decision
log (`/jev:stats`) looks sane.
