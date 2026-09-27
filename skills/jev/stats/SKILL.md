---
name: jev-stats
description: Show how the Jev extension has behaved in this project (calls, latency, decisions, output savings) and interpret the numbers. Use when the user asks about Jev's cost, latency, decisions, or whether thresholds should change.
disable-model-invocation: true
---
Run the `/jev:stats` command. It computes the summary from `.pi/jev/logs/decisions.jsonl`
and hands it to you. Summarize it in a few sentences and point out anything that suggests
a threshold in `.pi/jev/config.json` should change — for example many `ask` decisions from
the permission gate, high p90 latency, or errors. Do not change the config yourself.
