---
name: init
description: Set up Jev for this project - generate .claude/jev/rules.json, tools.json and config.json from what is actually in the repository.
disable-model-invocation: true
---
Set up the Jev plugin for this project. Work only inside `.claude/jev/` in the project root;
do not touch application code.

1. Scan the repository for:
   - documentation and per-directory gotcha files (for example `docs/*.md`, `*/GOTCHAS.md`,
     `CONTRIBUTING.md`, style guides);
   - project tools: `Makefile` targets, `package.json` scripts, `pyproject.toml` scripts,
     executables under `scripts/`, `tools/` or `bin/`;
   - sensitive paths: secrets, credentials, infrastructure and deployment configuration.
2. Write `.claude/jev/rules.json`, a JSON array. Each rule has an `id`, a `load` path relative
   to the project root, and exactly one condition:
   - `when_files`: glob patterns matched against changed files (use this whenever a path
     decides relevance), or
   - `when_jev`: one factual sentence describing requests the file matters for.
   Only reference files that exist. If useful guidance files are missing, list suggestions for
   me instead of writing their content.
3. Write `.claude/jev/tools.json`, an object mapping a short tool id to
   `{"what": "<one line>", "how": "<exact command or --help>"}`. Mark destructive tools in
   `how`. The last entry must be `"none": {"what": "None of the project tools is relevant to this request.", "how": ""}`.
4. Write `.claude/jev/config.json` with only the overrides this project needs. Keep
   `"mode": "shadow"`. Put project-specific sensitive path regexes in
   `"permission": {"extra_deny_patterns": [...]}` and make sure they do not match example
   files such as `.env.example`.
5. Show me the three files and a short summary. Remind me that decisions are only logged
   until I set `"mode": "enforce"`, and that `/jev:stats` shows what has been logged.
