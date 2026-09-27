# jev-pi

A [pi](https://github.com/earendil-works/pi) extension that puts [TypeSafe Jev](https://docs.typesafe.ai) in the agent
loop to make coding agents faster and cheaper. Jev answers typed questions (choice / score / yes-no) with
probabilities; the extension keeps every threshold and branch in code.

Port of the original `jev-claude-code` plugin (kept under `plugins/` for reference) to pi mechanisms:
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
# during development
export TYPESAFE_API_KEY=ts_...
pi --extension ./extension/jev

# stable: copy or symlink into your extensions directory
ln -s "$PWD/extension/jev" ~/.pi/agent/extensions/jev
```

Optionally expose the skills and prompt templates to all sessions:

```bash
ln -s "$PWD/skills/jev" ~/.pi/agent/skills/jev          # or keep them project-level in .pi/skills/
ln -s "$PWD/prompts" ~/.pi/agent/prompts/jev-roles       # prompt dir holds direct .md children
```

The first session in a project writes runtime state and logs to `.pi/jev/` (self-ignored).

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

## Configuration

Defaults live in `extension/jev/config/default.json`; `.pi/jev/config.json` in a project is
deep-merged on top (lists are replaced, so add project deny rules under
`permission.extra_deny_patterns`).

`JEV_MOCK=1` replaces the network call with a local mock (noul 0.1 / first choice 0.9 / score 0);
`JEV_MOCK_ANSWERS=<file>` feeds canned answers per question id. Both exercise the full request path
without an API key.

## Develop and test

```bash
npx -y tsx tests/test-extension.ts   # offline unit tests, mocked Jev (21 cases)
```

Type checking (optional; links the pi package types locally):

```bash
mkdir -p node_modules/@earendil-works node_modules/@types
ln -sfn "$(pi-root)/node_modules/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent  # adjust pi-root
ln -sfn .../pi-coding-agent/node_modules/typebox node_modules/typebox
ln -sfn .../pi-coding-agent/node_modules/@types/node node_modules/@types/node
npx -y -p typescript@5.9 tsc -p tsconfig.json
```

## Differences from the Claude Code version

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
