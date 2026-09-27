---
name: jev-recall
description: Recall command output that the Jev output ladder hid, or ask Jev a bounded choice / score / yes-no question via the jev_ask tool. Use when a Bash result ends with a "[jev] ... hidden ranges" footer, or when a decision has a known set of answers.
---
# Jev helpers

## Recall hidden output

Long Bash output may be trimmed by the Jev extension. The footer lists the hidden line
ranges and the saved file path. Recover it with the **read** tool using offset/limit
(1-based line numbers), or show it to the human with `/jev:recall <path> START END`.
Nothing is ever deleted.

## Ask Jev a bounded question

Use the `jev_ask` tool for a decision with known answers, such as ranking candidate
files or checking a claim against evidence:

```json
{
  "state": {"claim": "...", "evidence": "..."},
  "questions": {
    "supported": {"type": "noul", "instructions": "`evidence` supports `claim`."},
    "best_file": {"type": "choice", "instructions": "Which file should change first?",
                   "criteria": {"a.py": "defines the API", "b.py": "calls it"}},
    "risk": {"type": "score", "instructions": "Blast radius if this change is wrong.",
              "criteria": ["low", "medium", "high"]}
  }
}
```

The answer is JSON with each answer, its probabilities, and confidence. Treat
low-confidence answers as unknown, and never use Jev for arithmetic, counting, or
exact string checks.
