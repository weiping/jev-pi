#!/usr/bin/env python3
"""Ask Jev an ad-hoc question from a JSON spec file (see the recall skill)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402
from typesafe_sdk import Choice, Noul, Score  # noqa: E402

TYPES = {"choice": Choice, "noul": Noul, "score": Score}
spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
questions = {k: TYPES[q.pop("type")](**q) for k, q in spec["questions"].items()}
answers = jevlib.ask("jev_ask", spec["state"], questions)
print(json.dumps({k: v.model_dump() for k, v in answers.items()}, ensure_ascii=False, indent=2))
