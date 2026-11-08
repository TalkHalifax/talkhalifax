// The agent guard, run as Claude Code runs it: JSON on stdin, exit 2 and one stderr line to refuse.
// Each run points CLAUDE_PROJECT_DIR at a temp repo holding the fixture policies.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const script = path.join(repo, ".claude", "hooks", "agent-guard.mjs");
let root;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-guard-")));
  const policyDir = path.join(root, ".claude", "agents", "policy");
  fs.mkdirSync(policyDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(here, "fixtures"))) fs.copyFileSync(path.join(here, "fixtures", f), path.join(policyDir, f));
  fs.mkdirSync(path.join(policyDir, "dir-policy.json")); // a policy "file" that can't be read
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "events.ts"), "");
  fs.writeFileSync(path.join(root, ".dev.vars"), "X=1\n");
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(input, raw) {
  const r = spawnSync(process.execPath, [script], {
    input: raw ?? JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "PreToolUse", tool_use_id: "t", ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}
const as = (agent, tool_name, tool_input, extra = {}) => run({ agent_type: agent, agent_id: "a1", tool_name, tool_input, ...extra });
function allowed(r) { assert.equal(r.code, 0, `expected allowed, got: ${r.err}`); assert.equal(r.err, ""); }
function refused(r, re) {
  assert.equal(r.code, 2, "expected refused");
  assert.match(r.err, /^agent-guard: /);
  assert.equal(r.err.trim().split("\n").length, 1, "one line");
  if (re) assert.match(r.err, re);
}
// Refused by a hard-coded rule, not merely for lacking a policy pattern
function hard(r, re) { refused(r, re); assert.doesNotMatch(r.err, /no pattern in its policy/); }
const edit = (agent, file_path) => as(agent, "Edit", { file_path, old_string: "a", new_string: "b" });
const bash = (command, agent = "events-builder") => as(agent, "Bash", { command, description: "d" });
const fetch = (url, agent = "events-builder") => as(agent, "WebFetch", { url, prompt: "p" });
const long = "a".repeat(5000);
const settings = () => JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));

describe("fail closed", () => {
  test("settings.json registers the guard for every tool, turns a crash into a refusal and sets a timeout", () => {
    const entry = settings().hooks.PreToolUse.find((e) => e.matcher === "*");
    const h = entry.hooks[0];
    assert.equal(h.type, "command");
    assert.match(h.command, /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/agent-guard\.mjs" \|\| exit 2$/);
    assert.equal(h.timeout, 10);
  });
  test("if node can't run the guard, the registered command still exits 2", (t) => {
    const command = settings().hooks.PreToolUse[0].hooks[0].command;
    const r = spawnSync("bash", ["-c", command], { input: "{}", env: { ...process.env, CLAUDE_PROJECT_DIR: path.join(root, "nowhere") }, encoding: "utf8" });
    if (r.error) return t.skip("no bash on this machine");
    assert.equal(r.status, 2);
  });
  test("a policy that can't be read fails closed", () => refused(as("dir-policy", "Read", { file_path: "src/events.ts" }), /can't be read/));
  test("hook input that isn't JSON or isn't an object fails closed", () => {
    refused(run(null, "not json"), /isn't valid JSON/);
    refused(run(null, "[1]"), /isn't a JSON object/);
  });
  test("over-long commands, paths, patterns and addresses are refused", () => {
    refused(bash(`echo ${long}`), /longer than 4096/);
    refused(edit("events-builder", `test/${long}`), /too long/);
    refused(as("events-builder", "Read", { file_path: `src/${long}` }), /too long/);
    refused(as("events-builder", "Glob", { pattern: `src/${long}` }), /that pattern/);
    refused(fetch(`https://developers.cloudflare.com/${long}`), /not a valid URL/);
    refused(as("events-builder", "Task", { subagent_type: long, prompt: "p" }), /not an agent in its policy/);
  });
});

describe("who is checked", () => {
  test("the main session (no agent_type) passes, whatever it does", () => {
    allowed(run({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }));
    allowed(run({ tool_name: "Edit", tool_input: { file_path: path.join(root, ".claude", "hooks", "agent-guard.mjs") } }));
  });
  test("an agent without a policy file passes unchanged, built-in capitalised names included", () => {
    allowed(as("engineer", "Bash", { command: "npm run deploy" }));
    allowed(as("Explore", "Read", { file_path: path.join(os.homedir(), "anything") }));
    allowed(as("Plan", "Bash", { command: "ls" }));
  });
  test("a capitalised name whose lowercase form has a policy fails closed", () => refused(as("Strict", "Read", { file_path: "src/events.ts" }), /isn't lowercase/));
  test("an agent name outside [A-Za-z0-9-] fails closed", () => {
    for (const name of ["../strict", "events builder", "a/b", "x\u0000", "a_b", 5, "a".repeat(65)]) refused(as(name, "Read", { file_path: "src/events.ts" }), /invalid name/);
  });
  test("a policy that isn't valid JSON fails closed", () => refused(as("broken", "Read", { file_path: "src/events.ts" }), /broken has a policy file that isn't valid JSON/));
  test("invalid policies fail closed", () => {
    refused(as("wrong-name", "Read", { file_path: "src/events.ts" }), /doesn't match/);
    refused(as("bad-regex", "Bash", { command: "git status" }), /bad regex/);
    refused(as("bad-date", "Read", { file_path: "src/events.ts" }), /YYYY-MM-DD/);
    refused(as("typo-key", "Read", { file_path: "src/events.ts" }), /unknown key "edits"/);
    refused(as("mid-glob", "Bash", { command: "npm x test" }), /may only end/);
    refused(as("bad-agents", "Task", { subagent_type: "ok" }), /"agents" must be a list/);
  });
  test("a final ** is refused for npm, npx, node, vitest, wrangler, any git pattern and wildcard commands", () => {
    refused(as("open-npm", "Bash", { command: "npm test" }), /npm patterns may not end in \*\*/);
    refused(as("open-git", "Bash", { command: "git status" }), /git patterns may not end in \*\*/);
    refused(as("open-push", "Bash", { command: "git push origin x" }), /git patterns may not end in \*\*/);
    refused(as("open-gitlog", "Bash", { command: "git log" }), /git patterns may not end in \*\*/);
    refused(as("open-star", "Bash", { command: "ls" }), /must start with a plain command/);
    refused(as("open-wrangler", "Bash", { command: "npx wrangler dev" }), /npx patterns may not end/);
  });
});

describe("tools", () => {
  test("a listed tool passes and an unlisted one is refused", () => {
    allowed(as("reader", "Read", { file_path: "src/events.ts" }));
    refused(as("reader", "Bash", { command: "npm test" }), /reader may not use Bash \(not a tool in its policy\)/);
    refused(as("reader", "WebSearch", { query: "x" }), /not a tool in its policy/);
  });
  test("MCP tools pass only when listed exactly", () => {
    allowed(as("events-builder", "mcp__talkhalifax__list_leads", {}));
    refused(as("events-builder", "mcp__talkhalifax__publish_story", {}), /not a tool/);
    refused(as("events-builder", "mcp__talkhalifax__list_leads_x", {}), /not a tool/);
  });
  test("PowerShell is refused even when listed", () => refused(as("events-builder", "PowerShell", { command: "ls" }), /PowerShell/));
  test("a missing tool name is refused", () => refused(run({ agent_type: "reader", tool_input: {} }), /not a tool/));
  test("Task and Agent start only the agents the policy names", () => {
    allowed(as("events-builder", "Task", { subagent_type: "qa-tester", prompt: "p", description: "d" }));
    allowed(as("events-builder", "Agent", { subagent_type: "qa-tester", prompt: "p" }));
    refused(as("events-builder", "Task", { subagent_type: "engineer", prompt: "p" }), /may not use Task to start engineer \(not an agent in its policy\)/);
    refused(as("events-builder", "Agent", { prompt: "p" }), /not an agent in its policy/);
    refused(as("spawner", "Task", { subagent_type: "qa-tester" }), /not an agent in its policy/);
    refused(as("strict", "Task", { subagent_type: "qa-tester" }), /not a tool in its policy/);
  });
  test("Task and Agent refuse a named agent that has no policy file of its own", () => {
    refused(as("events-builder", "Task", { subagent_type: "no-policy-agent", prompt: "p" }), /no policy file of its own/);
    refused(as("events-builder", "Agent", { subagent_type: "no-policy-agent", prompt: "p" }), /no policy file of its own/);
  });
});

describe("edits", () => {
  test("allowed files and globs pass", () => {
    allowed(edit("strict", "src/events.ts"));
    allowed(edit("strict", path.join(root, "src", "events.ts")));
    allowed(edit("events-builder", "test/unit/events.test.ts"));
    allowed(edit("events-builder", "test/unit/deep/er/x.ts"));
    allowed(edit("events-builder", "docs/ROADMAP.md"));
    allowed(as("events-builder", "Write", { file_path: "public/events.js", content: "" }));
    allowed(as("events-builder", "NotebookEdit", { notebook_path: "notebooks/a.ipynb", new_source: "" }));
  });
  test("outside the file scope is refused, with the agent, tool and path named", () => {
    refused(edit("strict", "src/auth.ts"), /^agent-guard: strict may not edit src\/auth\.ts \(outside its file scope\)$/m);
    refused(edit("events-builder", "docs/sub/x.md"), /outside its file scope/);
    refused(as("events-builder", "Write", { file_path: "src/other.ts", content: "" }), /outside its file scope/);
  });
  test("an empty or missing allow list means no edits", () => refused(edit("reader", "src/events.ts"), /outside its file scope/));
  test("deny wins over allow", () => refused(edit("events-builder", "test/unit/secret-x.ts"), /denied by its policy/));
  test("paths outside the repo are refused", () => {
    refused(edit("strict", "../outside.ts"), /outside the repository/);
    refused(edit("strict", "src/../../outside.ts"), /outside the repository/);
    refused(edit("strict", path.join(path.dirname(root), "elsewhere", "src", "events.ts")), /outside the repository/);
    refused(edit("strict", "Z:\\elsewhere\\src\\events.ts"), /outside the repository|colon/);
    refused(edit("strict", "Z:/src/events.ts"), /outside the repository|colon/);
    refused(edit("strict", "\\\\server\\share\\src\\events.ts"), /outside the repository|colon|outside its file scope/);
  });
  test("normalized traversal back inside the repo is judged by where it lands", () => {
    allowed(edit("strict", "src/../src/./events.ts"));
    refused(edit("strict", "src/../src/auth.ts"), /outside its file scope/);
  });
  test("missing or odd paths are refused", () => {
    refused(as("strict", "Edit", {}), /no path/);
    refused(as("strict", "Edit", { file_path: 7 }), /no path/);
    refused(edit("strict", "src/events.ts:stream"), /colon/);
    refused(edit("strict", "src/events.ts."), /trailing dot/);
    refused(edit("events-builder", "docs/CLAUDE~1.MD"), /short name/);
    refused(edit("strict", "src/ev?nts.ts"), /unusual characters/);
  });
  test("protected paths are refused even when the policy allows them", () => {
    for (const p of [".claude/hooks/agent-guard.mjs", ".claude/settings.json", ".claude/settings.local.json", ".github/CODEOWNERS",
      ".github/workflows/deploy.yml", "CLAUDE.md", "claude.md", "migrations/0099_x.sql", ".git/config", ".git/hooks/pre-commit", ".git",
      ".mcp.json", ".CLAUDE/hooks/agent-guard.mjs", ".claude/skills/deploy/SKILL.md", ".claude/skills/x.md", ".claude/commands/ship.md",
      ".claude/agents/policy/README.md", ".claude/launch.json", ".claude/anything.md", ".claude/agents/sub/x.md", ".claude",
      "package.json", "package-lock.json", "PACKAGE.JSON", "wrangler.jsonc", "admin/wrangler.jsonc", "test/wrangler.test.jsonc",
      "test/wrangler.admin.jsonc", ".gitignore", ".gitattributes", "test/.gitignore", "vitest.config.ts", "tsconfig.json",
      "test/tsconfig.json", ".vscode/settings.json", "node_modules/vitest/index.js", "scripts/build-seed.mjs",
      "scripts/promote-agent-drafts.mjs", "test/e2e/routes.mjs", "test/hooks/agent-guard.test.mjs", "test/hooks/fixtures/strict.json"]) {
      refused(edit("events-builder", p), /protected for every agent/);
    }
  });
  test("nothing under .claude/ is editable, agent definitions and policies included", () => {
    for (const p of [".claude/agents/strict.md", ".claude/agents/policy/strict.json", ".claude/agents/policy/new-agent.json",
      ".claude/agents/events-builder.md", ".claude/agents/policy/events-builder.json", ".claude/agents/engineer.md"]) {
      refused(edit("events-builder", p), /protected for every agent; agent changes are drafted in agent-drafts\//);
    }
    refused(as("events-builder", "Write", { file_path: ".claude/agents/new-agent.md", content: "x" }), /drafted in agent-drafts/);
  });
  test("agent-drafts/ takes <name>.md and policy/<name>.json when the policy allows it", () => {
    allowed(edit("events-builder", "agent-drafts/transit-builder.md"));
    allowed(as("events-builder", "Write", { file_path: "agent-drafts/policy/transit-builder.json", content: "{}" }));
    refused(edit("strict", "agent-drafts/transit-builder.md"), /outside its file scope/);
  });
  test("agent-drafts/ refuses an agent's own drafts, the orchestrator's, Agent Operations' and anything else", () => {
    refused(edit("events-builder", "agent-drafts/events-builder.md"), /never drafts its own/);
    refused(edit("events-builder", "agent-drafts/policy/events-builder.json"), /never drafts its own/);
    for (const p of ["agent-drafts/orchestrator.md", "agent-drafts/policy/orchestrator.json", "agent-drafts/agent-ops-lead.md",
      "agent-drafts/policy/agent-ops-lead.json", "agent-drafts/agent-ops-.md"]) {
      refused(edit("events-builder", p), /orchestrator's and Agent Operations'/);
    }
    for (const p of ["agent-drafts/orchestrator.txt", "agent-drafts/README.md", "agent-drafts/Bad.md", "agent-drafts/x_y.md",
      "agent-drafts/sub/x.md", "agent-drafts/policy/x.md", "agent-drafts/policy/README.md", "agent-drafts", "Agent-Drafts/x.md"]) {
      refused(edit("events-builder", p), /only agent-drafts\/<name>\.md/);
    }
  });
  test("only the root package.json is protected, not a file of that name deeper down", () => {
    allowed(edit("events-builder", "test/fixtures/package.json"));
  });
  test("a link inside the scope that points at a protected directory is judged by its target", () => {
    // A junction on Windows (no admin needed), a directory symlink elsewhere
    const hooks = path.join(root, ".claude", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "agent-guard.mjs"), "");
    fs.mkdirSync(path.join(root, "test", "unit"), { recursive: true });
    fs.symlinkSync(hooks, path.join(root, "test", "unit", "hooklink"), "junction");
    refused(edit("events-builder", "test/unit/hooklink/agent-guard.mjs"), /protected for every agent/);
    refused(edit("events-builder", "test/unit/hooklink/new-file.mjs"), /protected for every agent/);
  });
  test("an unknown listed tool that names a file is treated as an edit, and a folder as a read", () => {
    refused(as("events-builder", "mcp__talkhalifax__list_leads", { file_path: "src/auth.ts" }), /outside its file scope/);
    refused(as("events-builder", "mcp__talkhalifax__list_leads", { path: "../elsewhere" }), /outside the repository/);
    refused(as("events-builder", "mcp__talkhalifax__list_leads", { path: ".wrangler" }), /secrets/);
  });
});

describe("reads", () => {
  test("secret files are never read", () => {
    for (const p of [".dev.vars", ".dev.vars.production", ".env", ".env.local", ".newsroom-token", "scripts/seed.sql",
      ".wrangler/state/v3/d1/x.sqlite", path.join(root, ".dev.vars"), "sub/.env", ".DEV.VARS", ".newsroom-token.", ".env::$DATA",
      path.join(os.homedir(), ".ssh", "id_ed25519"), path.join(os.homedir(), ".git-credentials"), ".claude.json",
      path.join(os.homedir(), ".claude.json"), "conf/GitHub CLI/hosts.yml", path.join(os.homedir(), "AppData", "Roaming", "GitHub CLI", "hosts.yml")]) {
      refused(as("events-builder", "Read", { file_path: p }), /secrets are never read/);
    }
  });
  test("ordinary files in the repo read fine", () => {
    allowed(as("events-builder", "Read", { file_path: "src/events.ts" }));
    allowed(as("events-builder", "Read", { file_path: "src/env.ts" }));
    allowed(as("events-builder", "Read", { file_path: ".envrc.example.md" }));
  });
  test("reads outside the repo are refused, links included", () => {
    refused(as("events-builder", "Read", { file_path: "../outside.txt" }), /outside the repository/);
    refused(as("events-builder", "Read", { file_path: path.join(os.homedir(), "notes.txt") }), /outside the repository/);
    refused(as("events-builder", "Read", { file_path: "Z:/x.txt" }), /outside the repository|colon/);
    refused(as("events-builder", "Read", {}), /no path/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guard-out-"));
    try {
      fs.symlinkSync(outside, path.join(root, "src", "outlink"), "junction");
      refused(as("events-builder", "Read", { file_path: "src/outlink/x.txt" }), /outside the repository/);
      refused(as("events-builder", "Grep", { pattern: "x", path: "src/outlink" }), /outside the repository/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test("Grep, Glob and LS can't search secrets or leave the repo", () => {
    refused(as("events-builder", "Grep", { pattern: "TOKEN", path: ".dev.vars" }), /secrets/);
    refused(as("events-builder", "Grep", { pattern: "x", path: ".wrangler" }), /secrets/);
    refused(as("events-builder", "Grep", { pattern: "x", glob: "**/.dev.vars*" }), /names a secret/);
    refused(as("events-builder", "Glob", { pattern: "**/.env*" }), /names a secret/);
    refused(as("events-builder", "Glob", { pattern: "*", path: ".wrangler/state" }), /secrets/);
    refused(as("events-builder", "Glob", { pattern: "scripts/seed.sql" }), /names a secret/);
    refused(as("events-builder", "Glob", { pattern: "../**/*.ts" }), /outside the repository/);
    refused(as("events-builder", "Glob", { pattern: "/etc/*" }), /outside the repository/);
    refused(as("events-builder", "Grep", { pattern: "x", glob: "C:/Users/**" }), /outside the repository/);
    refused(as("events-builder", "Grep", { pattern: "x", path: path.dirname(root) }), /outside the repository/);
    refused(as("events-builder", "LS", { path: os.homedir() }), /outside the repository/);
    allowed(as("events-builder", "Grep", { pattern: "process.env", path: "src" }));
    allowed(as("events-builder", "Glob", { pattern: "src/**/*.ts" }));
    allowed(as("events-builder", "LS", { path: root }));
  });
  test("with no path, the session folder is what gets searched and is checked", () => {
    allowed(as("events-builder", "Grep", { pattern: "x" }));
    refused(as("events-builder", "Grep", { pattern: "x" }, { cwd: path.dirname(root) }), /outside the repository/);
    refused(as("events-builder", "Glob", { pattern: "*" }, { cwd: path.join(root, ".wrangler") }), /secrets/);
  });
  test("relative paths resolve against the session folder, then must be inside the repo", () => {
    const src = { cwd: path.join(root, "src") };
    allowed(as("events-builder", "Grep", { pattern: "x", path: "." }, src));
    allowed(as("events-builder", "Glob", { pattern: "*.ts", path: ".." }, src));
    refused(as("events-builder", "Grep", { pattern: "x", path: "../.." }, src), /outside the repository/);
    refused(as("events-builder", "Glob", { pattern: "*", path: "../.wrangler" }, src), /secrets/);
    refused(as("events-builder", "Read", { file_path: "../../outside.txt" }, src), /outside the repository/);
    allowed(as("strict", "Edit", { file_path: "events.ts", old_string: "a", new_string: "b" }, src));
    refused(as("strict", "Edit", { file_path: "src/events.ts", old_string: "a", new_string: "b" }, src), /outside its file scope/);
    refused(as("events-builder", "Grep", { pattern: "x", path: "src" }, { cwd: path.dirname(root) }), /outside the repository/);
  });
});

describe("bash metacharacters", () => {
  const bad = { ";": "npm test; ls", "&": "npm test & ls", "&&": "npm test && ls", "|": "npm test | cat", "||": "npm test || ls",
    "<": "cat < x", ">": "echo x > src/auth.ts", ">>": "echo x >> f", "`": "echo `id`", "$(": "echo $(id)", "${": "echo ${HOME}",
    "$VAR": "echo $HOME", "newline": "npm test\nls", "CR": "npm test\r", "glob *": "cat src/*", "glob ?": "cat .dev.var?",
    "glob [": "cat .dev.var[s]", "brace": "echo {a,b}", "subshell": "(npm test)", "tilde": "cat ~/x", "comment": "npm test #x",
    "dq $": "echo \"$HOME\"", "dq $(": "echo \"$(id)\"", "dq backtick": "echo \"`id`\"", "continuation": "npm \\\ntest",
    "unclosed '": "echo 'x", "unclosed \"": "echo \"x", "trailing \\": "echo x\\" };
  for (const [name, cmd] of Object.entries(bad)) test(`refuses ${name}`, () => hard(bash(cmd), /may not run that command/));

  test("quoted metacharacters are just text", () => {
    allowed(bash("git commit -m 'fix: a; b | c > d $HOME `x` *'", "strict"));
    allowed(bash("git commit -m \"fix: a; b | c > d * ~ #\"", "strict"));
    allowed(bash("git commit -m fix\\;\\ all", "strict"));
    allowed(bash("git commit -m \"say \\\"hi\\\"\"", "strict"));
    allowed(bash("git commit -m 'line one\nline two'", "strict"));
  });
  test("leading env assignments are refused even when a pattern matches", () => hard(bash("FOO=bar npm test"), /environment assignments/));
  test("shells and eval wrappers are refused", () => {
    for (const c of ["npx bash -c 'git push --force'", "echo sh x.sh", "echo xargs ls", "echo bash"]) hard(bash(c), /can't see/);
    for (const c of ["node -e 'x'", "node --eval x", "node -p x"]) hard(bash(c), /node -e, -p and -r/);
  });
  test("an empty command is refused", () => { refused(bash("   "), /empty/); refused(as("events-builder", "Bash", {}), /without a command/); });
});

describe("bash patterns", () => {
  test("literals must match exactly and count must be equal without **", () => {
    allowed(bash("npm test", "strict"));
    allowed(bash("  npm   test  ", "strict"));
    refused(bash("npm test --watch", "strict"), /no pattern in its policy allows it/);
    refused(bash("npm", "strict"), /no pattern/);
    refused(bash("npm run test", "strict"), /no pattern/);
  });
  test("* matches exactly one token", () => {
    allowed(bash("git commit -m 'one token with spaces'", "strict"));
    refused(bash("git commit -m two tokens", "strict"), /no pattern/);
    refused(bash("git commit -m", "strict"), /no pattern/);
  });
  test("re: must fully match the token", () => {
    allowed(bash("git checkout -b events/new-feed.v2", "strict"));
    allowed(bash("npx wrangler dev --port 8787", "strict"));
    refused(bash("npx wrangler dev --port 87a", "strict"), /no pattern/);
    refused(bash("git checkout -b events/Bad", "strict"), /no pattern/);
    refused(bash("git checkout -b xevents/a", "strict"), /no pattern/);
    refused(bash("git checkout -b 'events/a b'", "strict"), /no pattern/);
  });
  test("a final ** matches zero or more tokens", () => {
    allowed(bash("echo"));
    allowed(bash("echo one"));
    allowed(bash("echo one two three"));
    allowed(bash("gh pr view 12"));
    refused(bash("git"), /no pattern/);
  });
  test("the refusal names the command's start, not the whole command", () => {
    const r = bash("git commit -m 'contains-a-secret-like-string-xyz' extra", "strict");
    refused(r, /may not run "git commit -m\.\.\."/);
    assert.doesNotMatch(r.err, /xyz/);
  });
});

describe("git", () => {
  test("only checkout -b <name> and switch -c <name> change branches", () => {
    allowed(bash("git checkout -b events/new-feed"));
    allowed(bash("git switch -c events/new-feed"));
    for (const c of ["git checkout main", "git checkout -b events/a main", "git checkout -- src/auth.ts", "git checkout -b -f",
      "git checkout -B events/a", "git switch main", "git switch -c events/a origin/main", "git switch -C events/a"]) hard(bash(c), /git (checkout|switch|-C) is never allowed/);
  });
  test("only allowlisted subcommands run", () => {
    allowed(bash("git status"));
    allowed(bash("git add src/events.ts"));
    allowed(bash("git diff src"));
    for (const sub of ["restore", "reset", "stash", "apply", "am", "merge", "pull", "rebase", "cherry-pick", "revert", "clean",
      "worktree", "submodule", "clone", "fetch", "ls-remote", "filter-branch", "update-index", "update-ref", "symbolic-ref",
      "read-tree", "checkout-index", "mv", "rm", "config", "send-pack", "grep", "difftool", "format-patch", "archive", "bundle",
      "tag", "notes", "init", "gc", "replace", "hash-object", "fast-import", "remote", "bisect", "sparse-checkout", "maintenance",
      "credential", "daemon", "instaweb", "help", "var", "my-alias"]) {
      hard(bash(`git ${sub} x`), new RegExp(`git ${sub} is never allowed`));
    }
  });
  test("dangerous options are refused in any subcommand, abbreviated or not", () => {
    for (const c of ["git log --exec-path", "git log --exe=x", "git add --upl x", "git commit --templ=x -m y",
      "git status --git-dir=x", "git status --work-t=x", "git add --receive-pack x", "git status -C .", "git push --rec=x origin events/a",
      "git diff --output=x", "git diff --outp=x", "git log --o=x", "git log --ou x", "git diff -o x", "git diff -Ox", "git diff -O x",
      "git show --open-files-in-pager", "git diff --ext-diff", "git diff --extcmd=x", "git diff -x x", "git diff --textconv",
      "git show --textc", "git diff --no-index a b", "git diff --no-i a b"]) {
      hard(bash(c), /is never allowed/);
    }
  });
  test("git branch lists and creates, nothing more", () => {
    allowed(bash("git branch"));
    allowed(bash("git branch events/new-feed"));
    for (const c of ["git branch -d x", "git branch -D x", "git branch -m x", "git branch -M x", "git branch -c x", "git branch -f x",
      "git branch -vd x", "git branch --delete x", "git branch --del x", "git branch --move x", "git branch --force x", "git branch --copy x",
      "git branch -u origin/x", "git branch --set-upstream-to=origin/x", "git branch --track x", "git branch --edit-description"]) {
      hard(bash(c), /git branch .* is never allowed \(list and create only\)/);
    }
  });
  test("options before the subcommand are refused, -C and -c included", () => {
    for (const c of ["git -C . status", "git --git-dir=.git status", "git --work-tree=. status", "git --exec-path=x status",
      "git -c core.hooksPath=x commit -m y", "git -ccore.x=y status", "git --config-env=a=b status", "git --namespace x status"]) {
      hard(bash(c), /before the subcommand is never allowed/);
    }
    // --no-pager passes the hard rules (and then needs a policy pattern of its own)
    refused(bash("git --no-pager status"), /no pattern in its policy/);
  });
  test("pushes to main, refspecs with : or +, and pushes without remote and branch are refused", () => {
    for (const c of ["git push origin main", "git push origin refs/heads/main", "git push origin MAIN", "git push origin HEAD",
      "git push origin @", "git push origin events/a:main", "git push origin :events/a", "git push origin +events/a",
      "git push", "git push origin", "git push origin events/a main", "git push origin -- main"]) {
      hard(bash(c), /git push/);
    }
  });
  test("push refuses every option except -u, --set-upstream, --dry-run and -n, by prefix too", () => {
    for (const c of ["git push --force origin events/a", "git push --forc origin events/a", "git push --fo origin events/a",
      "git push -f origin events/a", "git push -uf origin events/a", "git push --force-with-lease origin events/a",
      "git push --delete origin events/a", "git push --dele origin events/a", "git push -d origin events/a", "git push --mirror origin",
      "git push --all origin", "git push --tags origin events/a", "git push -o ci.skip origin events/a", "git push --no-verify origin events/a",
      "git push --repo=x origin events/a", "git push --set-up origin events/a"]) {
      hard(bash(c), /git (push .*|-o) is never allowed/);
    }
    allowed(bash("git push origin events/new-feed"));
    allowed(bash("git push -u origin events/new-feed"));
    allowed(bash("git push --set-upstream origin events/new-feed"));
    allowed(bash("git push --dry-run origin events/new-feed"));
    allowed(bash("git push -un origin events/new-feed"));
  });
});

describe("gh", () => {
  test("gh merge, api, secret, repo and auth are refused", () => {
    for (const c of ["gh pr merge 12", "gh pr merge --squash 12", "gh -R a/b pr merge 1", "gh api repos/x", "gh secret set X",
      "gh secret list", "gh repo delete x", "gh repo edit --visibility private", "gh auth token", "gh alias set x api"]) hard(bash(c));
    allowed(bash("gh pr create --title x --body y"));
    allowed(bash("gh pr view 12"));
  });
  test("gh workflow, run, release, cache, ruleset, codespace and key commands are refused", () => {
    for (const c of ["gh workflow run deploy.yml", "gh workflow enable deploy.yml", "gh workflow disable deploy.yml", "gh workflow list",
      "gh run rerun 123", "gh run rerun --failed 123", "gh run cancel 123", "gh run list", "gh -R a/b run rerun 1",
      "gh release create v1", "gh release delete v1", "gh cache delete --all", "gh ruleset list", "gh codespace create",
      "gh ssh-key add k.pub", "gh gpg-key add k.asc", "gh --repo a/b workflow run x"]) {
      hard(bash(c), /gh (workflow|run|release|cache|ruleset|codespace|ssh-key|gpg-key) is never allowed/);
    }
  });
});

describe("wrangler", () => {
  test("deploys, secrets and the live database are refused", () => {
    for (const c of ["npx wrangler deploy", "wrangler deploy", "npx wrangler versions deploy", "npx wrangler secret put X",
      "npx wrangler d1 execute talkhalifax --remote --command x", "npx wrangler d1 migrations apply talkhalifax --remote",
      "npx wrangler dev --remote", "npx wrangler dev --remote=true", "npx wrangler dev --experimental-remote-bindings",
      "node node_modules/wrangler/bin/wrangler.js deploy", "npx wrangler rollback", "npm exec wrangler deploy"]) {
      hard(bash(c));
    }
  });
  test("-r, -c, --config, --script, --env-file and --x- flags are refused", () => {
    for (const c of ["npx wrangler dev -r", "npx wrangler d1 execute talkhalifax -r --command x", "npx wrangler dev -lr",
      "npx wrangler dev -c admin/wrangler.jsonc", "npx wrangler dev --config admin/wrangler.jsonc", "npx wrangler dev --config=x",
      "npx wrangler dev --script x.js", "npx wrangler dev --env-file x", "npx wrangler dev --envFile=x", "npx wrangler dev --x-dev-env"]) {
      hard(bash(c), /never allowed|loads code or config|-c would run/);
    }
  });
  test("--persist-to must stay under .wrangler/", () => {
    for (const c of ["npx wrangler dev --persist-to /tmp/x", "npx wrangler dev --persist-to ../x", "npx wrangler dev --persist-to .wrangler/../x",
      "npx wrangler dev --persistTo=/tmp/x", "npx wrangler dev --persist-to=src", "npx wrangler dev --persist-to"]) {
      hard(bash(c), /--persist-to must stay under \.wrangler/);
    }
    allowed(bash("npx wrangler dev --persist-to .wrangler/state"));
    allowed(bash("npx wrangler dev --persist-to=.wrangler/state"));
    allowed(bash("npx wrangler dev --persist-to .wrangler/state", "strict"));
  });
  test("local database commands pass", () => {
    allowed(bash("npx wrangler d1 migrations apply talkhalifax --local"));
    allowed(bash("npx wrangler d1 execute talkhalifax --local --command 'DELETE FROM auth_throttle'"));
  });
  test("wrangler dev takes only its allowlisted flags", () => {
    allowed(bash("npx wrangler dev --port 8787", "strict"));
    for (const f of ["--port 8787", "--inspector-port 9333", "--var KEY:value", "--local", "--log-level debug",
      "--show-interactive-dev-session false", "--inspectorPort=9333"]) {
      refused(bash(`npx wrangler dev ${f}`), /no pattern in its policy/); // passes the hard rules
    }
    for (const f of ["--ip 0.0.0.0", "--env production", "-e production", "--site public", "--assets x", "--define A:B",
      "--tsconfig x", "--live-reload", "--test-scheduled", "--upstream-protocol http", "--host example.com", "--routes x",
      "--node-compat", "--no-bundle", "--minify", "--alias a:b", "--compatibility-date 2020-01-01", "-p 8787"]) {
      hard(bash(`npx wrangler dev ${f}`), /wrangler dev .* is never allowed \(only --port/);
    }
  });
  test("only dev, a bare types, and local d1 execute and migrations apply run", () => {
    allowed(bash("npx wrangler types"));
    for (const c of ["npx wrangler tail", "npx wrangler login", "npx wrangler logout", "npx wrangler whoami", "npx wrangler kv namespace list",
      "npx wrangler d1 time-travel restore talkhalifax", "npx wrangler d1 migrations list talkhalifax --local", "npx wrangler d1 export talkhalifax --local",
      "npx wrangler versions upload", "npx wrangler", "npx wrangler r2 object get x"]) {
      hard(bash(c), /wrangler .*is never allowed \(only dev, types/);
    }
    hard(bash("npx wrangler types out.d.ts"), /takes no arguments/);
    hard(bash("npx wrangler d1 execute talkhalifax --command x"), /needs --local/);
    hard(bash("npx wrangler d1 migrations apply talkhalifax"), /needs --local/);
    hard(bash("npx wrangler d1 execute talkhalifax --local=false --command x"), /needs --local/);
  });
});

describe("npm, npx, node and vitest", () => {
  test("npm scripts that deploy or touch the live database are refused", () => {
    for (const c of ["npm run deploy", "npm run-script deploy", "npm run db:migrate:remote", "npm run db:seed:remote"]) hard(bash(c), /deploy or touch the live database/);
    allowed(bash("npm run test:hooks"));
  });
  test("options before the command or script are refused", () => {
    for (const c of ["npm --prefix x test", "npx --yes cowsay", "npx -p x y", "npm run -s test", "npm exec --yes x", "npm -c x"]) hard(bash(c), /options before|loads code/);
  });
  test("flags that load code or config are refused anywhere", () => {
    for (const c of ["npm run test --script-shell=x", "npm test --node-options=x", "npm test --userconfig x", "npm exec x --call y",
      "npm exec x --package y", "npx vitest run --config x", "npx vitest run --root x", "npx vitest run --globalSetup x",
      "node --require x y.mjs", "node --import x y.mjs", "node --loader x y.mjs", "node --experimental-loader x y.mjs", "npm test --prefix=x"]) {
      hard(bash(c), /loads code or config/);
    }
    hard(bash("node -r x y.mjs"), /node -e, -p and -r/);
  });
  test("test runs take no -r, -c, --root, --dir or --config, even after --", () => {
    allowed(bash("npx vitest run"));
    for (const c of ["npm test -- -r x", "npm test -- -c x", "npm test -- --dir x", "npm test -- --dir=x", "npx vitest run -- --dir x",
      "npx vitest run -r x", "npm run test:hooks -- -r x", "npm t -- --dir x", "npm run test -- --dir x"]) {
      hard(bash(c), /test runs take no|loads code or config|-c would run/);
    }
  });
  test("only the editor promotes agent drafts", () => {
    for (const c of ["npm run agents:promote", "node scripts/promote-agent-drafts.mjs", "npm run-script agents:promote"]) hard(bash(c), /promoting agent drafts is the editor's job/);
  });
});

describe("paths in bash", () => {
  test("absolute paths, ~ and .. outside the repo are refused", () => {
    for (const c of ["cat /etc/passwd", "cat ../x", "cat src/../../x", "cat '~/notes'", "cat C:/Windows/win.ini", "cat 'C:\\Windows\\win.ini'",
      `cat '${path.dirname(root)}'`, "cat //server/share", "echo --file=/etc/passwd", "cat /c/Users"]) {
      hard(bash(c), /outside the repository/);
    }
    allowed(bash(`cat '${path.join(root, "src", "events.ts")}'`));
    allowed(bash("cat src/../src/events.ts"));
  });
  test("relative paths in commands resolve against the session folder", () => {
    allowed(as("events-builder", "Bash", { command: "cat ../src/events.ts" }, { cwd: path.join(root, "src") }));
    hard(as("events-builder", "Bash", { command: "cat ../../x" }, { cwd: path.join(root, "src") }), /outside the repository/);
  });
  test("values glued to short options and after = get the same checks", () => {
    for (const [c, re] of [["git diff -O/etc/passwd", /never allowed|outside/], ["cat -f/etc/passwd", /outside the repository/],
      ["cat -abC:/Windows/x", /outside the repository/], ["cat -f../../x", /outside the repository/], ["cat '-f~/x'", /outside the repository/],
      ["cat -I.claude/settings.json", /under \.claude/], ["cat -fsettings.local.json", /under \.claude/], ["cat -e.env", /secret file/],
      ["cat -k.dev.vars", /secret file/], ["cat -ab.wrangler/state", /secret file/], ["cat --file=/etc/passwd", /outside the repository/],
      ["cat --in=.claude/agents/x.md", /under \.claude/], ["cat --in=.dev.vars", /secret file/], ["cat --a=b=/etc/x", /outside the repository/]]) {
      hard(bash(c), re);
    }
    allowed(bash("cat -fsrc/events.ts"));
    allowed(bash("cat --in=src/events.ts"));
  });
  test("no command may name .claude/ or settings.local.json", () => {
    for (const c of [".claude/settings.json", ".claude", "x/.claude/agents/a.md", ".CLAUDE/hooks/agent-guard.mjs", "settings.local.json"]) {
      hard(bash(`cat ${c}`), /under \.claude/);
    }
    hard(bash(`cat '${path.join(root, ".claude", "settings.json")}'`), /under \.claude/);
  });
});

describe("secrets in bash", () => {
  test("any word naming a secret file or folder is refused", () => {
    for (const c of ["cat .dev.vars", "cat .env.local", "cat sub/.ssh/id", "cat .wrangler/state/x.sqlite", "cat scripts/seed.sql",
      "echo --persist-to .wrangler/state", "npx wrangler dev --persist-to .wrangler/state .wrangler/x", "echo --env-file=.env"]) {
      hard(bash(c), /secret file or folder/);
    }
  });
});

describe("webfetch", () => {
  test("the listed domain and its subdomains pass over https", () => {
    allowed(fetch("https://developers.cloudflare.com/workers/"));
    allowed(fetch("https://blog.developers.cloudflare.com/x"));
    allowed(fetch("https://DEVELOPERS.cloudflare.com./x"));
  });
  test("spoofed hosts, http and odd addresses are refused", () => {
    refused(fetch("https://developers.cloudflare.com.evil.com/"), /not a domain in its policy/);
    refused(fetch("https://evildevelopers.cloudflare.com/"), /not a domain in its policy/);
    refused(fetch("https://cloudflare.com/"), /not a domain in its policy/);
    refused(fetch("https://evil.com/developers.cloudflare.com"), /not a domain in its policy/);
    refused(fetch("https://developers.cloudflare.com@evil.com/"), /credentials|not a domain/);
    refused(fetch("http://developers.cloudflare.com/"), /https only/);
    refused(fetch("https://developers.cloudflare.com:8443/"), /ports/);
    refused(fetch("ftp://developers.cloudflare.com/"), /https only/);
    refused(fetch("developers.cloudflare.com"), /not a valid URL/);
    refused(as("events-builder", "WebFetch", {}), /not a valid URL/);
  });
  test("an agent with no webfetch list fetches nothing", () => {
    refused(as("strict", "WebFetch", { url: "https://example.com/" }), /not a domain/);
  });
});
