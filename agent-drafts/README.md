# Agent drafts

Where changes to agents are drafted. Nothing here is loaded by Claude Code: an agent only exists once its files are
in `.claude/agents/`, and no agent can edit anything under `.claude/`.

The layout mirrors `.claude/agents/`:

- `agent-drafts/<name>.md`: a new or changed agent definition. Its front matter `name:` must equal `<name>`.
- `agent-drafts/policy/<name>.json`: its policy (format in [`.claude/agents/policy/README.md`](../.claude/agents/policy/README.md)).
  Every `.md` needs one. A policy on its own updates an agent that already exists.

Names use `a-z`, `0-9` and `-` only.

## The flow

1. **Agent Operations drafts** the files here, as far as its policy's `edit.allow` lets it. The agent guard refuses
   every agent its own drafts, the orchestrator's (`orchestrator`) and Agent Operations' own team (`agent-ops-*`).
   The editor changes those directly.
2. **The reviewer commits the drafts and opens a pull request.**
3. **The editor reviews it**, then on the pull request's branch, with a clean working tree, runs
   `npm run agents:promote`. This runs [`scripts/promote-agent-drafts.mjs`](../scripts/promote-agent-drafts.mjs), which:
   - refuses to run if the working tree has any uncommitted change;
   - refuses any file in `agent-drafts/` that isn't `<name>.md`, `policy/<name>.json` or this README;
   - checks every name, refusing `orchestrator` and `agent-ops-*`;
   - checks every policy with the agent guard's own validator;
   - checks each `.md` has a matching policy;
   - reads each definition's front matter strictly:
     - only the keys `name`, `description`, `tools`, `model`, `color`, `effort` and `maxTurns`;
     - exactly one `name:`, equal to the file name, and a `tools:` line (an agent without one gets every tool);
     - no duplicate keys and no indented or nested lines, except a YAML list under `tools:`;
     - anything else is refused, `hooks`, `mcpServers`, `permissionMode` and `skills` included;
   - checks every tool in `tools:` is in the policy's `tools`, so `PowerShell` and `mcp__` tools only if the policy
     lists them (for a policy on its own, the definition already in `.claude/agents/` is checked);
   - moves the files into `.claude/agents/` and `.claude/agents/policy/` with `git mv`, replacing what's there;
   - prints what it changed.

   Nothing is moved unless every draft passes. The script stages the moves but doesn't commit or push. No policy
   agent can run or edit it.
4. **The editor commits, pushes the branch and merges.** `agent-drafts/` is left with only this README.
