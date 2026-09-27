---
name: snapshot
description: Build one shared snapshot of the current change, then run read-only reviewers in parallel on it.
argument-hint: "[base-ref]"
disable-model-invocation: true
---
!`CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" "${CLAUDE_PLUGIN_DATA}/venv/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.py" $ARGUMENTS`

The snapshot above is shared retrieval: the diff and the files worth reading have been found
once. Now launch three `jev:readonly-reviewer` subagents in parallel, one each for security,
tests, and documentation. Tell each one its angle and that the snapshot is at
`.claude/jev/state/snapshot.md` in the project root. When all three report back, merge their
findings into one list ordered by severity.
