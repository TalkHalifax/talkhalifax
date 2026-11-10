# Agent policies

One file per agent, `<name>.json`, where `<name>` is the `name:` in `.claude/agents/<name>.md`. The agent guard
(`.claude/hooks/agent-guard.mjs`, registered in `.claude/settings.json`) reads it before every tool call the agent
makes and refuses anything the policy doesn't allow. The agent can't talk past it: the check runs outside the model.

- No policy file: the guard stays out of the way (the editor's own session, the older build agents, and built-ins
  like `Explore` and `Plan`).
- A policy file that can't be read, isn't valid JSON or doesn't match the shape below: every tool is refused.
- An agent name with anything outside `A-Z`, `a-z`, `0-9` and `-`: every tool is refused. Policy file names are
  lowercase; a capitalised agent whose lowercase name has a policy is refused too.
- If the guard crashes or can't start, the hook command (`... || exit 2`) refuses the call.

## How agents and policies change

No agent edits anything under `.claude/`. Changes are drafted in [`agent-drafts/`](../../../agent-drafts/README.md),
which mirrors `.claude/agents/` and from which nothing loads:

1. Agent Operations drafts `agent-drafts/<name>.md` and `agent-drafts/policy/<name>.json`.
2. The reviewer commits the drafts and opens a pull request.
3. The editor reviews it, then runs `npm run agents:promote` on the branch. That checks every policy with this
   guard's own validator, and every definition's front matter against a short allowlist of keys and its policy's
   `tools`, then moves the drafts into `.claude/agents/` with `git mv`. The full list of checks is in the
   [drafts README](../../../agent-drafts/README.md).
4. The editor commits, pushes and merges.

The guard refuses every agent its own drafts, the orchestrator's, and Agent Operations' own team (`agent-ops-*`).
No policy agent can run or edit the promote script.

## What the guard depends on

- A Claude Code version that sends `agent_type` to hooks for calls made inside a subagent. Without it every call
  looks like the editor's own session and nothing is enforced.
- Hooks staying on. `"disableAllHooks": true` in `.claude/settings.local.json` (or the user's own settings) turns the
  guard off. Agents can't set it in this repo: nothing under `.claude/` is editable by a policy agent. No Bash word
  may name `.claude/` or `settings.local.json`, whether it stands alone, follows `=` (`--opt=value`) or is glued to
  a short option (`-f.claude/...`).
- Policies that don't list general file-writing commands. The hard rules refuse the git and wrangler commands and
  options that write files. But a policy that lists something like `cp`, `tee` or `sed -i` lets the agent write
  wherever that command reaches inside the repo.
- The 10-second hook timeout in `.claude/settings.json`. Claude Code lets a call through if a hook times out; the
  guard normally answers in about a tenth of a second.

## Shape

```json
{
  "agent": "events-builder",
  "level": "L2",
  "tools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch"],
  "edit": { "allow": ["src/events.ts", "public/events.js", "test/unit/**"], "deny": [] },
  "bash": [
    ["npm", "test"],
    ["git", "checkout", "-b", "re:^events/[a-z0-9._-]+$"],
    ["git", "commit", "-m", "*"],
    ["npx", "wrangler", "dev", "--persist-to", ".wrangler/state"]
  ],
  "webfetch": ["developers.cloudflare.com"],
  "agents": ["qa-tester"],
  "expires": { "push-grant": "2026-12-31" }
}
```

Unknown keys are refused, so a typo can't silently drop a rule.

- `agent` must equal the file name. `level` is optional, like `L2`.
- `tools`: every tool the agent may call. Anything else is refused, MCP tools (`mcp__server__tool`) included unless
  listed exactly. PowerShell is always refused (the guard only understands Bash).
- `agents`: the subagents it may start. `Task` and `Agent` need to be in `tools`, the `subagent_type` in this list,
  and that agent needs a policy file of its own.
- `edit`: for Edit, Write and NotebookEdit. Repo-relative paths with forward slashes; `*` stays within one folder,
  `**` spans any depth. `deny` wins over `allow`; no `allow` means no edits. Paths outside the repo are refused.
  A file the guard refuses to every agent (`migrations/`, `package.json`, `test/e2e/`, wrangler configs, `.github/`,
  `scripts/`) can't be granted, but its draft path can, for example `protected-drafts/test/e2e/**`. The orchestrator
  promotes drafts once the editor approves the pull request (see
  [`protected-drafts/README.md`](../../../protected-drafts/README.md)). `tsconfig*.json` and `vitest.config.*` are
  refused anywhere, `protected-drafts/` included.
- Reads (Read, Grep, Glob, LS, and any tool given a `path`) must stay inside the repo, after following links.
  Relative paths resolve against the session's folder, as the tools do. "The repo" is the main checkout, unless the
  session runs in a genuine linked worktree at `.claude/worktrees/<name>/` (Claude Code desktop does this). Then it
  is that worktree, judged with its own `.claude/`, `scripts/` and so on, and the main checkout and other worktrees
  count as outside. Policies are always read from the main checkout.
- `bash`: the command must match one pattern, token for token. A literal must be equal, `*` is exactly one token,
  `re:<regex>` must match the whole token, and a final `**` takes any remaining tokens (none included). Without a
  final `**` the token count must be equal. A final `**` is refused for any `git` pattern, for `npm`, `npx`, `node`,
  `vitest` and `wrangler`, and for patterns that start with `*` or `re:`: list those commands in full.
- `webfetch`: https only, no port or credentials; the host must be a listed domain or a subdomain of one.
- `expires`: grant id to `YYYY-MM-DD`, for the record. Dates are checked for shape, not enforced.
- Commands, paths and addresses longer than 4096 characters are refused.

**Never pair edits with a command that runs those files in plain Node.** Paths like `scripts/`, `test/e2e/`,
`test/hooks/` and `node_modules/` are hard-denied for that reason. If a new folder holds code that an allowed command
runs in Node, don't put it in the same policy's `edit.allow`. Unit tests in `test/unit/` run inside the Workers
runtime, which is why `npm test` plus `test/unit/**` is a reasonable pair.

**Never pair `node <file>` (or any command that runs a file) with an `edit.allow` that covers that file.** An agent
that can edit a script and also run it can run anything.

## Always refused, whatever the policy says

**Edits:**
- anything under `.claude/`;
- in `agent-drafts/`, anything but `<name>.md` and `policy/<name>.json` with names in `a-z`, `0-9` and `-`, as well
  as the agent's own drafts, `orchestrator` and `agent-ops-*`;
- `.github/**`, `CLAUDE.md`, `migrations/**`, `.git/**`, `.mcp.json`;
- the root `package.json` and `package-lock.json`;
- `.gitignore`, `.gitattributes`, `vitest.config.*`, `tsconfig*.json`, `.vscode/**`;
- `wrangler.*`, `admin/wrangler.*`, `test/wrangler.*`;
- `node_modules/**`, `scripts/**`, `test/e2e/**`, `test/hooks/**`.

**Reads, greps and globs:**
- `.dev.vars*`, `.env`, `.env.*`, `.newsroom-token`, `scripts/seed.sql` and anything under `.wrangler/`;
- credential files: `.ssh`, `.aws`, `.gnupg`, `.git-credentials`, `.npmrc`, `.netrc`, `.claude.json`,
  `.credentials.json`, and gh's `hosts.yml` (`gh/` or `GitHub CLI/`).

**Bash, any command:**
- a word naming a secret, `.claude/` or `settings.local.json`;
- a word that is an absolute path, starts with `~`, or uses `..` to land outside the repo;
- both checks also look at the value after `=` (`--opt=value`) and a value glued to a short option (`-o<value>`,
  including after a short cluster like `-ab<value>`);
- `agents:promote` and `promote-agent-drafts`.

**git:**
- Subcommands: only `status`, `diff`, `log`, `show`, `add`, `commit`, `branch`, `rev-parse`, `ls-files`, `blame`,
  `push`, exactly `git checkout -b <name>`, and exactly `git switch -c <name>`. Everything else is refused.
- `git branch` lists and creates only: no `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `-f`, `-u`, `-t`, `--delete`,
  `--move`, `--copy`, `--force`, `--set-upstream-to`, `--track` and similar.
- Before the subcommand, only `--no-pager`, `-p`, `-P`, `--paginate`, `--no-optional-locks`, `--literal-pathspecs`
  and `--no-replace-objects`.
- In any subcommand:
  - `-C`;
  - anything starting `-o`, `-O` or `-x`;
  - `--output`, `--open-files-in-pager`, `--extcmd`, `--ext-diff`, `--textconv`, `--no-index`, `--upload-pack`,
    `--receive-pack`, `--exec`, `--exec-path`, `--template`, `--git-dir` and `--work-tree`, including any
    abbreviation of three or more characters.
- `git push` takes only `-u`, `--set-upstream`, `--dry-run` and `-n`. It must name the remote and the branch, and
  never `main`, `HEAD`, or a refspec with `:` or `+`.

**gh:** `pr merge`, `api`, `secret`, `repo`, `auth`, `alias`, `variable`, `extension`, `workflow`, `run`, `release`,
`cache`, `ruleset`, `codespace`, `ssh-key` and `gpg-key`.

**wrangler:**
- Only `dev`, a bare `types`, `d1 execute` with `--local`, and `d1 migrations apply` with `--local`.
- `dev` takes only `--port`, `--inspector-port`, `--persist-to`, `--var`, `--local`, `--log-level` and
  `--show-interactive-dev-session`; every other flag is refused.
- In every case: no flag mentioning `remote`, no `-r` or `-c` (alone or in a cluster), no `--config`, `--script`,
  `--env-file` or `--x-*`, and no `--persist-to` outside `.wrangler/`.

**npm, npx, node, vitest:**
- npm and npx: options before the command or script name, `-c`, and npm scripts that deploy or touch the live database.
- `npm test`, `npm run test*` and `vitest`: no `-r`, `-c`, `--root`, `--dir` or `--config`, even after `--`.
- Anywhere in a command:
  - `--script-shell`, `--node-options`, `--prefix`, `--userconfig`, `--call`, `--package`, `--require`, `--import`,
    `--loader`, `--experimental-loader`, `--config`, `--root` and `--global-setup` (either spelling, `--globalSetup`
    too);
  - `node -e`, `-p` or `-r`;
  - shells and wrappers such as `bash`, `sh`, `pwsh`, `cmd`, `eval`, `xargs` and `sudo`.

Tests: `npm run test:hooks` (fixtures in `test/hooks/fixtures/`).
