#!/usr/bin/env python3
"""Print lines START..END (1-based, inclusive) of a Bash output saved by the output ladder."""
import sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
start = int(sys.argv[2]) if len(sys.argv) > 2 else 1
end = int(sys.argv[3]) if len(sys.argv) > 3 else len(lines)
for n in range(start, min(end, len(lines)) + 1):
    print(f"{n:>6}  {lines[n - 1]}")
