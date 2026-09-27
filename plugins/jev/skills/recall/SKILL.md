---
name: recall
description: Recall command output that the Jev output ladder hid, or ask Jev a bounded choice / score / yes-no question. Use when a Bash result ends with a "[jev] ... hidden ranges" footer, or when a decision has a known set of answers.
allowed-tools: Bash(${CLAUDE_PLUGIN_DATA}/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---
# Jev helpers

## Recall hidden output

Long Bash output may be trimmed by the Jev plugin. The footer lists the hidden line ranges
and gives the exact command to read the original, for example:

```bash
${CLAUDE_PLUGIN_DATA}/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/recall.py /path/to/project/.claude/jev/state/outputs/<key>.txt 41 188
```

Recall whenever a hidden range could matter. Nothing is ever deleted.

## Ask Jev a bounded question

Use this for a decision with known answers, such as ranking candidate files or checking a
claim against evidence. Write the spec to a temp file and run:

```bash
${CLAUDE_PLUGIN_DATA}/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/scripts/jev_ask.py /tmp/q.json
```

Spec format:

```json
{"state": {"claim": "...", "evidence": "..."},
 "questions": {
   "supported": {"type": "noul", "instructions": "`evidence` supports `claim`."},
   "best_file": {"type": "choice", "instructions": "...", "criteria": {"a.py": "...", "b.py": "..."}},
   "risk": {"type": "score", "instructions": "...", "criteria": ["low", "medium", "high"]}}}
```

The output is JSON with each answer and its confidence. Treat low-confidence answers as
unknown, and never use Jev for arithmetic, counting, or exact string checks.
