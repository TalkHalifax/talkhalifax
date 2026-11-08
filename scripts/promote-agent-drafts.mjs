// Promotes reviewed agent drafts into place. For the editor only, on a pull request's branch after review:
//   npm run agents:promote
// Moves agent-drafts/<name>.md and agent-drafts/policy/<name>.json into .claude/agents/ and .claude/agents/policy/
// with git mv (replacing what's there), after checking every policy with the agent guard's own validator and every
// definition's front matter against a short allowlist and its policy's tools.
// Refuses if the working tree has uncommitted changes. Doesn't commit or push. Policy agents can't run it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Load the guard's validator without running the hook
globalThis.AGENT_GUARD_NO_MAIN = true;
const { policyProblem } = await import(new URL("../.claude/hooks/agent-guard.mjs", import.meta.url).href);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (msg) => { console.error(`agents:promote: ${msg}`); process.exit(1); };
const NAME = /^[a-z0-9-]+$/;

// The only front matter keys a promoted agent may have. hooks, mcpServers, permissionMode, skills and the rest would
// change what the agent can do outside its policy, so they're refused rather than understood.
const FRONT_KEYS = new Set(["name", "description", "tools", "model", "color", "effort", "maxTurns"]);
const unquote = (v) => v.replace(/^(["'])(.*)\1$/, "$2");
const splitTools = (v) => v.replace(/^\[(.*)\]$/, "$1").split(",").map((t) => unquote(t.trim())).filter(Boolean);

// Strict front matter: flat "key: value" lines, plus a YAML list under tools only. Returns { keys } or { error }.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { error: "doesn't start with a --- front matter line" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { error: "has no closing --- for its front matter" };
  const keys = new Map();
  let inToolsList = false;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item) {
      if (!inToolsList) return { error: "has an indented list somewhere other than under tools:" };
      keys.get("tools").push(unquote(item[1]));
      continue;
    }
    if (/^\s/.test(line)) return { error: "has an indented line (only a list under tools: is allowed)" };
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!kv) return { error: `has a front matter line that can't be read: "${line.slice(0, 40)}"` };
    const [, key, value = ""] = kv;
    if (!FRONT_KEYS.has(key)) return { error: `has front matter key "${key}", which isn't allowed (only ${[...FRONT_KEYS].join(", ")})` };
    if (keys.has(key)) return { error: `has front matter key "${key}" twice` };
    inToolsList = key === "tools" && !value;
    if (key === "tools") keys.set(key, value ? splitTools(value) : []);
    else if (!value) return { error: `has front matter key "${key}" with no value` };
    else keys.set(key, unquote(value));
  }
  if (!keys.has("name")) return { error: "has no name: in its front matter" };
  if (!keys.has("tools") || !keys.get("tools").length) return { error: "has no tools: in its front matter (an agent without one gets every tool)" };
  return { keys };
}

// An agent file must name itself and list only tools its policy grants (PowerShell and mcp__ tools included)
function checkAgentFile(file, name, policy) {
  const fm = parseFrontmatter(fs.readFileSync(file.abs, "utf8"));
  if (fm.error) fail(`${file.rel} ${fm.error}`);
  const declared = fm.keys.get("name");
  if (declared !== name) fail(`${file.rel} declares name: ${declared}, not ${name}`);
  for (const tool of fm.keys.get("tools")) {
    if (!policy.tools.includes(tool)) fail(`${file.rel} lists tool ${tool}, which its policy's tools don't include`);
  }
}

// Every draft, checked; the first problem stops everything before anything moves
function collect(root) {
  const dir = path.join(root, "agent-drafts");
  if (!fs.existsSync(dir)) return { mds: [], policies: [] };
  const mds = [], policies = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    if (entry.isDirectory() && entry.name === "policy") continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) fail(`agent-drafts/${entry.name} isn't a draft (only <name>.md and policy/<name>.json)`);
    mds.push(entry.name.slice(0, -3));
  }
  const pdir = path.join(dir, "policy");
  if (fs.existsSync(pdir)) {
    for (const entry of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) fail(`agent-drafts/policy/${entry.name} isn't a draft policy (only <name>.json)`);
      policies.push(entry.name.slice(0, -5));
    }
  }
  return { mds, policies };
}

function validate(root, mds, policies) {
  for (const name of new Set([...mds, ...policies])) {
    if (!NAME.test(name)) fail(`"${name}" isn't a valid agent name (a-z, 0-9 and - only)`);
    if (name === "orchestrator" || name.startsWith("agent-ops-")) fail(`${name} can't be promoted from drafts; the editor changes it directly`);
  }
  for (const name of mds) {
    if (!policies.includes(name)) fail(`agent-drafts/${name}.md has no matching agent-drafts/policy/${name}.json`);
  }
  for (const name of policies) {
    let policy;
    try {
      policy = JSON.parse(fs.readFileSync(path.join(root, "agent-drafts", "policy", `${name}.json`), "utf8"));
    } catch {
      fail(`agent-drafts/policy/${name}.json isn't valid JSON`);
    }
    const problem = policyProblem(policy, name);
    if (problem) fail(`agent-drafts/policy/${name}.json is invalid: ${problem}`);
    // The definition that will sit beside this policy: the draft, or (for a policy on its own) the one already in place
    const rel = mds.includes(name) ? `agent-drafts/${name}.md` : `.claude/agents/${name}.md`;
    if (!fs.existsSync(path.join(root, rel))) fail(`agent-drafts/policy/${name}.json is for an agent that doesn't exist and has no draft`);
    checkAgentFile({ rel, abs: path.join(root, rel) }, name, policy);
  }
}

function move(root, from, to) {
  const existed = fs.existsSync(path.join(root, to));
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  git("mv", "-f", "--", from, to);
  return `${existed ? "updated" : "added  "} ${to}`;
}

const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
if (git("status", "--porcelain")) fail("the working tree has uncommitted changes; commit or stash them first");
const { mds, policies } = collect(root);
if (!mds.length && !policies.length) {
  console.log("agents:promote: no drafts in agent-drafts/, nothing to do");
  process.exit(0);
}
validate(root, mds, policies);
const done = [
  ...mds.map((n) => move(root, `agent-drafts/${n}.md`, `.claude/agents/${n}.md`)),
  ...policies.map((n) => move(root, `agent-drafts/policy/${n}.json`, `.claude/agents/policy/${n}.json`)),
];
// git doesn't track folders, so drop the emptied policy/ to leave only the README
const draftPolicies = path.join(root, "agent-drafts", "policy");
if (fs.existsSync(draftPolicies) && !fs.readdirSync(draftPolicies).length) fs.rmdirSync(draftPolicies);
console.log(`agents:promote: moved ${done.length} file(s) from agent-drafts/ (staged, not committed):`);
for (const line of done) console.log(`  ${line}`);
console.log("Review with `git diff --cached`, then commit and push the branch.");
