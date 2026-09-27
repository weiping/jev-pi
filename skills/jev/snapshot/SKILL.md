---
name: jev-snapshot
description: Build one shared snapshot of the current change (ranked files + diff), then run read-only reviewer subagents in parallel on it. Use before merging or when the user asks for a review of the working tree.
disable-model-invocation: true
---
Run the `/jev:snapshot [base-ref]` command. It ranks changed files by review priority
(one Jev request), writes `.pi/jev/state/snapshot.md`, and then instructs you to launch
three read-only reviewer subagents in parallel — security, tests, documentation — each
reading the snapshot first. Merge their findings into one list ordered by severity.
