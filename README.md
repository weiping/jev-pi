# jev-pi

A [pi package](https://github.com/earendil-works/pi) that puts [TypeSafe Jev](https://docs.typesafe.ai) in the agent
loop to make coding agents faster and cheaper. Jev answers typed questions (choice / score / yes-no) with
probabilities; the extension keeps every threshold and branch in code.

A pi port of the original `jev-claude-code` plugin, rebuilt on pi mechanisms:
**extension + skills + prompt templates**.

| Component | pi mechanism | What it does |
| --- | --- | --- |
| Permission gate | extension, `tool_call(bash)` | Hard rules in code, fuzzy judgment from Jev: allow / ask / deny, reads scripts before running them |
| Output ladder | extension, `tool_result(bash)` | Long output is shown in full, excerpted, or hidden per the current request; originals always recoverable |
| Conditional context | extension, `input` + `before_agent_start` | Loads project guidance only when relevant, suggests project tools, re-injects after compaction |
| Agent router | extension, `tool_call(dispatch_agent)` | Dedupes subgoals, keeps sensitive work off cheap models, downgrades mechanical work |
| `/jev:init` `/jev:stats` `/jev:snapshot` `/jev:recall` | extension commands | Project setup, decision statistics, shared retrieval for parallel reviewers, hidden-output recall |
| `jev_ask` tool | extension tool | Lets the model ask Jev bounded choice / score / yes-no questions on demand |
| `skills/jev/*` | skills | Routing guidance for the commands above |
| `prompts/*.md` | prompt templates | `/cheap-worker` and `/readonly-reviewer` subagent roles |

Everything runs in **shadow mode** by default: Jev is called and every decision is logged, but pi's
behavior does not change until you switch to enforce mode.

## Install

Requirements: pi, git, and a TypeSafe API key (`jev-1.13.0`). TypeScript is compiled by pi's `jiti`
at load time — no build step.

```bash
# from npm
pi install npm:jev-pi

# from git (pin a tag once published)
pi install git:github.com/<you>/jev-pi@v0.1.0

# try it once without touching settings
pi -e npm:jev-pi        # or: pi -e ./jev-pi

# project-local instead of personal
pi install ./jev-pi -l
```

The package layout follows pi conventions (`extensions/`, `skills/`, `prompts/`), so no
manifest is needed. The first session in a project writes runtime state and logs to
`.pi/jev/` (self-ignored).

## Set up a project

Run `/jev:init` inside the project. It scans the repository and writes `.pi/jev/rules.json`,
`tools.json` and `config.json`. Runtime state and logs go to `.pi/jev/state/` and `.pi/jev/logs/`,
each with its own `.gitignore`.

After about a week in shadow mode, run `/jev:stats`, tune thresholds in `.pi/jev/config.json`,
then turn it on:

```json
{ "mode": "enforce" }
```

or for a single session: `JEV_MODE=enforce pi`.

## Meta-workspaces

A Bash command or dispatched subagent may run inside a sibling checkout that carries its
own `.pi/jev/` (its own independent git repository inside the session root). Since v0.2
every hook resolves the **nearest** `.pi/jev/` from its own working directory — the gate
uses that sibling's deny patterns and mode, the ladder saves output to that sibling's
state, and the router's dedupe registry stays whole. Conditional context and `/jev:stats`
additionally scan one level deep for such siblings and merge every project's rules, tools,
and decision logs (per-project id namespacing, one Jev request). A workspace without
siblings behaves exactly as before.

## Configuration

Defaults live in `extensions/jev/config/default.json`; `.pi/jev/config.json` in a project is
deep-merged on top (lists are replaced, so add project rules under `permission.extra_deny_patterns`
/ `permission.extra_allow_patterns`).

The permission gate checks, in order: `deny_patterns` → `allow_patterns` → simple read-only
commands (`readonly_commands`, exact prefix, no pipes/redirects) → one Jev request. Static hits
never reach Jev, so widening the rule sets also cuts per-command latency (~0.7 s median). Defaults
ship an audited set: read-only `gh`/`git`/`npm` inspection commands are read-only-listed, and
`^git (add|commit)\b` is allowed — local staging and commits pass without a Jev call, while
`git push` still gets judged.

`JEV_MOCK=1` replaces the network call with a local mock (noul 0.1 / first choice 0.9 / score 0);
`JEV_MOCK_ANSWERS=<file>` feeds canned answers per question id. Both exercise the full request path
without an API key.

## Develop and test

```bash
npm install        # devDependencies include the pi package for types
npm run lint       # eslint + typescript-eslint
npm run typecheck  # tsc --strict, zero errors required
npm test           # offline unit tests, mocked Jev, no API key (24 cases)
npm run check      # all three
```

CI runs lint + typecheck + offline tests + an assembly smoke test on every push.

## Release

Bump `version` in `package.json`, commit, then tag and push — CD publishes to npm
automatically after the full check suite passes:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

CD guards: the tag must equal `package.json` version, and that version must not already
exist on npm. Requires the repo secret `NPM_TOKEN` (npm Automation token):
`gh secret set NPM_TOKEN`. After publishing, users update with `pi update --extensions`.

## Differences from the original Claude Code plugin

- Hooks are in-process TypeScript events instead of stdin/stdout Python scripts; the Jev client is
  plain `fetch` against `https://api.typesafe.ai/v1/systemone`, so no venv or `setup.sh`.
- The permission gate's "ask" outcome opens a `ctx.ui.confirm` dialog (or blocks in non-interactive
  modes) instead of returning to Claude Code's permission flow.
- Conditional context is injected as a `jev-project-context` system-prompt section per request;
  re-injection after compaction is inherent because sections are re-sent every request.
- The agent router mutates `input.model` when the dispatch tool supports it; pi's built-in
  `dispatch_agent` takes task + role only, so downgrades surface as a blocked-with-guidance result
  in enforce mode.
- The output ladder prefers pi's own untruncated output (`details.fullOutputPath`) when present.

## Data and privacy

The permission gate sends commands and script contents, the output ladder sends command output,
and the router sends subagent task descriptions to TypeSafe. Keep sensitive paths in
`deny_patterns` so they are blocked before any Jev call.

## License

MIT
