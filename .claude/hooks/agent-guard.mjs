#!/usr/bin/env node
// agent-guard: a PreToolUse hook that holds each subagent to its policy in .claude/agents/policy/<name>.json.
// No agent_type (the editor's own session) or no policy file: no decision. Anything malformed or unexpected: refuse.
// Exit 2 with one line on stderr refuses the tool call. No network, no dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const MAX_LEN = 4096; // longer commands, paths and addresses are refused, so no regex can stall on them
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const POLICY_KEYS = new Set(["agent", "level", "tools", "edit", "bash", "webfetch", "agents", "expires"]);

// No policy can loosen these (all of .claude/ is protected in code, apart from agent definitions and policies).
// Each either runs code later (git hooks, MCP servers, npm scripts, test and wrangler config) or steers every agent.
// node_modules, scripts, test/e2e and test/hooks run in plain Node under allowed commands.
const NEVER_EDIT = [".github/**", "CLAUDE.md", "migrations/**", ".git/**", ".mcp.json", "package.json", "package-lock.json",
  "**/.gitignore", "**/.gitattributes", "**/vitest.config.*", "**/tsconfig*.json", ".vscode/**", "wrangler.*",
  "admin/wrangler.*", "test/wrangler.*", "node_modules/**", "scripts/**", "test/e2e/**", "test/hooks/**"];
const SECRET_NAMES = ["dev.vars", ".env", "newsroom-token", "seed.sql", ".wrangler", ".ssh", "credentials", ".netrc", ".npmrc"];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "eval", "xargs", "sudo"]);
const UNQUOTED_BANNED = ";&|<>`$\n*?[]{}()~#";
// The only git subcommands an agent may run; everything else can write files, run programs or reach other repos.
// checkout and switch only as "checkout -b <name>" and "switch -c <name>"; branch and push have their own rules.
const GIT_OK = new Set(["status", "diff", "log", "show", "add", "commit", "branch", "rev-parse", "ls-files", "blame", "checkout", "switch", "push"]);
// git takes any unique prefix of a long option, so these are refused by prefix too. --output writes a file;
// the rest run a program or read outside the repo.
const GIT_DANGER = ["--upload-pack", "--receive-pack", "--exec", "--exec-path", "--template", "--git-dir", "--work-tree",
  "--output", "--open-files-in-pager", "--extcmd", "--ext-diff", "--textconv", "--no-index"];
// branch may list and create; these delete, rename, copy, force or change tracking config
const BRANCH_DANGER = ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description",
  "--track", "--no-track", "--create-reflog", "--recurse-submodules"];
const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "-p", "--paginate", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
// Flags that load code, config or another package, wherever they appear
const CODE_FLAGS = ["--script-shell", "--node-options", "--prefix", "--userconfig", "--call", "--package", "--require",
  "--import", "--loader", "--experimental-loader", "--config", "--root", "--global-setup"];

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

// Short and printable: what the agent sent may be long or carry control characters
const show = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

function fail(e) {
  try { fs.writeSync(2, (e instanceof Refusal ? e.message : "agent-guard: internal error, so the tool is refused") + "\n"); } catch {}
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// CLAUDE_PROJECT_DIR is set by Claude Code; otherwise the repo this file lives in (never the agent's cwd)
function repoRoot() {
  return process.env.CLAUDE_PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const policyFile = (root, name) => path.join(root, ".claude", "agents", "policy", `${name}.json`);

function loadPolicy(root, agent) {
  // Policy files are lowercase; a capitalised name that has one (case-insensitive disks) is refused, not skipped
  const file = policyFile(root, agent.toLowerCase());
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    refuse(`agent-guard: ${agent} has a policy file that can't be read, so every tool is refused`);
  }
  if (agent !== agent.toLowerCase()) refuse(`agent-guard: ${agent} has a policy but its name isn't lowercase, so every tool is refused`);
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    refuse(`agent-guard: ${agent} has a policy file that isn't valid JSON, so every tool is refused`);
  }
  const problem = policyProblem(policy, agent);
  if (problem) refuse(`agent-guard: ${agent} has an invalid policy (${problem}), so every tool is refused`);
  return policy;
}

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// A final ** hands the agent every flag, so it's refused for tools whose flags can run code or reach the live site
function openPatternProblem(pat) {
  if (pat[pat.length - 1] !== "**") return null;
  const first = pat[0];
  if (first === "*" || first === "**" || first.startsWith("re:")) return "a bash pattern ending in ** must start with a plain command";
  const prog = program(first);
  if (["npm", "npx", "node", "vitest", "wrangler"].includes(prog)) return `${prog} patterns may not end in **`;
  if (prog === "git") return "git patterns may not end in **";
  return null;
}

function policyProblem(p, agent) {
  if (!isObject(p)) return "not an object";
  for (const k of Object.keys(p)) if (!POLICY_KEYS.has(k)) return `unknown key "${show(k)}"`;
  if (p.agent !== agent) return "\"agent\" doesn't match the file name";
  if (p.level !== undefined && !/^L\d$/.test(p.level)) return "\"level\" must look like L2";
  if (!strings(p.tools)) return "\"tools\" must be a list of tool names";
  if (p.edit !== undefined) {
    if (!isObject(p.edit)) return "\"edit\" must be an object";
    for (const k of Object.keys(p.edit)) if (k !== "allow" && k !== "deny") return `unknown edit key "${show(k)}"`;
    for (const list of [p.edit.allow ?? [], p.edit.deny ?? []]) {
      if (!strings(list)) return "edit lists must be lists of paths";
      if (list.some((g) => !g || g.startsWith("/") || g.includes("\\") || g.split("/").includes(".."))) return "edit paths must be repo-relative with forward slashes";
    }
  }
  if (p.bash !== undefined) {
    if (!Array.isArray(p.bash) || !p.bash.every((pat) => strings(pat) && pat.length > 0)) return "\"bash\" must be a list of token lists";
    for (const pat of p.bash) {
      if (pat.slice(0, -1).includes("**")) return "\"**\" may only end a bash pattern";
      const open = openPatternProblem(pat);
      if (open) return open;
      for (const t of pat) if (t.startsWith("re:")) { try { new RegExp(t.slice(3)); } catch { return `bad regex ${show(t)}`; } }
    }
  }
  if (p.webfetch !== undefined && !(strings(p.webfetch) && p.webfetch.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)))) return "\"webfetch\" must be a list of lowercase domains";
  if (p.agents !== undefined && !(strings(p.agents) && p.agents.every((a) => /^[A-Za-z0-9-]+$/.test(a)))) return "\"agents\" must be a list of agent names";
  if (p.expires !== undefined) {
    if (!isObject(p.expires)) return "\"expires\" must be an object";
    for (const d of Object.values(p.expires)) {
      if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) return "\"expires\" dates must be YYYY-MM-DD";
    }
  }
  return null;
}

// --- paths ---

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

// "*" stays within one segment, "**" spans any depth (including none)
function globMatch(pattern, p) {
  const ps = pattern.split("/"), xs = p.split("/");
  const seg = (s) => new RegExp("^" + s.split("*").map(escapeRe).join("[^/]*") + "$");
  const go = (i, j) => {
    if (i === ps.length) return j === xs.length;
    if (ps[i] === "**") return go(i + 1, j) || (j < xs.length && go(i, j + 1));
    return j < xs.length && seg(ps[i]).test(xs[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

// Resolve symlinks and Windows short names on the part of the path that exists
function realish(abs) {
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return abs;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

// The path as repo-relative with forward slashes (after symlinks), or a reason it's refused.
// Relative paths resolve against base (the session's cwd, as the tools do). allowRoot: "." for the repo itself.
function repoRelative(raw, root, base, allowRoot = false) {
  if (typeof raw !== "string" || !raw) return { error: "no path given" };
  if (raw.length > MAX_LEN) return { error: "the path is too long" };
  if (/[\x00-\x1f<>"|?*]/.test(raw)) return { error: "unusual characters in the path" };
  const hasDrive = WIN && /^[A-Za-z]:[\\/]/.test(raw);
  if (raw.slice(hasDrive ? 2 : 0).includes(":")) return { error: "a colon in the path" };
  if (raw.split(/[\\/]/).some((s) => s !== "." && s !== ".." && /[. ]$/.test(s))) return { error: "a trailing dot or space in the path" };
  const rel = path.relative(realish(path.resolve(root)), realish(path.resolve(base, raw)));
  if (!rel && allowRoot) return { rel: "." };
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return { error: "outside the repository" };
  const segs = rel.split(path.sep);
  // Windows drops trailing dots and spaces and expands short names, which would dodge the lists below
  if (segs.some((s) => /[. ]$/.test(s) || /~\d/.test(s))) return { error: "a trailing dot, space or short name in the path" };
  return { rel: segs.join("/") };
}

// Agent changes are drafted in agent-drafts/ (mirroring .claude/agents/) and promoted by the editor; .claude/ is never edited.
// In the drafts: only <name>.md and policy/<name>.json, never the agent's own, the orchestrator's or Agent Operations' team.
function draftsProblem(rel, agent) {
  const lower = rel.toLowerCase();
  if (lower !== "agent-drafts" && !lower.startsWith("agent-drafts/")) return null;
  const m = /^agent-drafts\/(?:policy\/([^/]+)\.json|([^/]+)\.md)$/.exec(rel);
  const name = m ? (m[1] ?? m[2]) : null;
  if (!name || !/^[a-z0-9-]+$/.test(name) || lower === "agent-drafts/readme.md") return "only agent-drafts/<name>.md and agent-drafts/policy/<name>.json, names in a-z, 0-9 and -";
  if (name === agent) return "an agent never drafts its own definition or policy";
  if (name === "orchestrator" || name.startsWith("agent-ops-")) return "the orchestrator's and Agent Operations' files are the editor's";
  return null;
}

function checkEdit(agent, policy, raw, root, base) {
  const r = repoRelative(raw, root, base);
  if (r.error) refuse(`agent-guard: ${agent} may not edit ${show(raw)} (${r.error})`);
  const lower = r.rel.toLowerCase();
  if (lower === ".claude" || lower.startsWith(".claude/")) refuse(`agent-guard: ${agent} may not edit ${r.rel} (protected for every agent; agent changes are drafted in agent-drafts/)`);
  const draft = draftsProblem(r.rel, agent);
  if (draft) refuse(`agent-guard: ${agent} may not edit ${r.rel} (${draft})`);
  if (NEVER_EDIT.some((g) => globMatch(g.toLowerCase(), lower))) refuse(`agent-guard: ${agent} may not edit ${r.rel} (protected for every agent)`);
  const { allow = [], deny = [] } = policy.edit ?? {};
  if (deny.some((g) => globMatch(g.toLowerCase(), lower))) refuse(`agent-guard: ${agent} may not edit ${r.rel} (denied by its policy)`);
  if (!allow.some((g) => globMatch(g, r.rel))) refuse(`agent-guard: ${agent} may not edit ${r.rel} (outside its file scope)`);
}

// Secrets and credentials, wherever they sit. Segments are cut at ":" and stripped of trailing dots/spaces (Windows).
function isSecretPath(p) {
  const segs = p.replace(/\\/g, "/").toLowerCase().split("/").map((s) => s.split(":")[0].replace(/[. ]+$/, "") || s);
  const base = segs[segs.length - 1];
  const joined = segs.join("/");
  return segs.some((s) => s === ".wrangler" || s === ".ssh" || s === ".aws" || s === ".gnupg")
    || base === ".dev.vars" || base.startsWith(".dev.vars.") || base === ".env" || base.startsWith(".env.")
    || base === ".newsroom-token" || joined === "scripts/seed.sql" || joined.endsWith("/scripts/seed.sql")
    || [".git-credentials", ".netrc", ".npmrc", ".credentials.json", ".claude.json"].includes(base)
    || joined.endsWith("gh/hosts.yml") || joined.endsWith("github cli/hosts.yml");
}

// A file or folder a tool reads or searches: inside the repo (after symlinks) and never a secret
function checkReadPath(agent, tool, raw, root, base) {
  if (typeof raw === "string" && raw.length <= MAX_LEN && isSecretPath(raw)) refuse(`agent-guard: ${agent} may not use ${tool} on ${show(raw)} (secrets are never read by agents)`);
  const r = repoRelative(raw, root, base, true);
  if (r.error) refuse(`agent-guard: ${agent} may not use ${tool} on ${show(raw)} (${r.error})`);
  if (isSecretPath(r.rel)) refuse(`agent-guard: ${agent} may not use ${tool} on ${show(raw)} (secrets are never read by agents)`);
}

function checkRead(agent, tool, input, root, base) {
  if (tool === "Read") return checkReadPath(agent, tool, input.file_path, root, base);
  // With no path, Grep/Glob/LS search the session's folder, which must pass the same test
  checkReadPath(agent, tool, input.path ?? base, root, base);
  // A Glob pattern or Grep file filter that names a secret or climbs out. Grep's content pattern only matches text.
  for (const key of tool === "Glob" ? ["pattern"] : tool === "Grep" ? ["glob"] : []) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_LEN) refuse(`agent-guard: ${agent} may not use ${tool} with that ${key}`);
    const lower = v.toLowerCase();
    if (SECRET_NAMES.some((n) => lower.includes(n))) refuse(`agent-guard: ${agent} may not use ${tool} with ${key} ${show(v)} (it names a secret file)`);
    if (/^([\\/]|[A-Za-z]:)/.test(v) || v.split(/[\\/]/).includes("..")) refuse(`agent-guard: ${agent} may not use ${tool} with ${key} ${show(v)} (outside the repository)`);
  }
}

// --- bash ---

// Shell words with single quotes, double quotes and backslashes. Anything that could start a second command,
// a redirect, an expansion or a glob is refused rather than understood.
function tokenize(cmd) {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) return { error: "a control character" };
  const tokens = [];
  let cur = "", inTok = false, i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return { error: "an unclosed quote" };
      cur += cmd.slice(i + 1, j);
      inTok = true;
      i = j + 1;
    } else if (c === '"') {
      inTok = true;
      for (i++; ; ) {
        if (i >= cmd.length) return { error: "an unclosed quote" };
        const d = cmd[i];
        if (d === '"') { i++; break; }
        if (d === "$" || d === "`") return { error: `"${d}" inside double quotes` };
        if (d === "\\" && "$`\"\\\n".includes(cmd[i + 1] ?? "")) {
          if (cmd[i + 1] === "\n") return { error: "a line continuation" };
          cur += cmd[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 >= cmd.length) return { error: "a trailing backslash" };
      if (cmd[i + 1] === "\n") return { error: "a line continuation" };
      cur += cmd[i + 1];
      inTok = true;
      i += 2;
    } else if (c === " " || c === "\t") {
      if (inTok) tokens.push(cur);
      cur = "";
      inTok = false;
      i++;
    } else if (UNQUOTED_BANNED.includes(c)) {
      return { error: c === "\n" ? "a newline outside quotes" : c === "$" ? "\"$\" outside single quotes" : `"${c}" outside quotes` };
    } else {
      cur += c;
      inTok = true;
      i++;
    }
  }
  if (inTok) tokens.push(cur);
  return { tokens };
}

const program = (t) => t.replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(cmd|exe|bat|ps1|js|mjs|cjs)$/, "");

// "--persistTo=x" -> "--persist-to" (yargs-style tools take either spelling)
const flagName = (a) => a.split("=")[0].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// Positional words, skipping flags; `valued` flags consume the next word unless written as --flag=value
function positionals(args, valued = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith("-") && a.length > 1) { if (valued.includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

function gitProblem(args) {
  let i = 0;
  for (; i < args.length && args[i].startsWith("-"); i++) {
    if (!GIT_GLOBAL_OK.has(args[i])) return `git ${show(args[i])} before the subcommand is never allowed`;
  }
  const sub = args[i], rest = args.slice(i + 1);
  if (sub === undefined) return null;
  if (!GIT_OK.has(sub)) return `git ${show(sub)} is never allowed (only status, diff, log, show, add, commit, branch, rev-parse, ls-files, blame, push, checkout -b and switch -c)`;
  for (const a of rest) {
    if (a === "-C" || /^-[oOx]/.test(a)) return `git ${show(a.slice(0, 2))} is never allowed`;
    const name = a.split("=")[0];
    if (name.startsWith("--") && name.length >= 3 && GIT_DANGER.some((d) => d.startsWith(name) || name.startsWith(d))) return `git ${show(name)} is never allowed`;
  }
  const newBranch = (flag) => rest.length === 2 && rest[0] === flag && !rest[1].startsWith("-");
  if (sub === "checkout") return newBranch("-b") ? null : 'git checkout is never allowed (only "git checkout -b <name>")';
  if (sub === "switch") return newBranch("-c") ? null : 'git switch is never allowed (only "git switch -c <name>")';
  if (sub === "branch") return branchProblem(rest);
  if (sub === "push") return pushProblem(rest);
  return null;
}

function branchProblem(args) {
  for (const a of args) {
    const name = a.split("=")[0];
    if (name.startsWith("--") && name.length >= 3 && BRANCH_DANGER.some((d) => d.startsWith(name) || name.startsWith(d))) return `git branch ${show(name)} is never allowed (list and create only)`;
    if (/^-[^-]/.test(a) && /[dDmMcCfut]/.test(a.slice(1))) return `git branch ${show(a)} is never allowed (list and create only)`;
  }
  return null;
}

function pushProblem(args) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("-") && a.length > 1) {
      if (a === "--set-upstream" || a === "--dry-run" || /^-[un]+$/.test(a)) continue;
      return `git push ${show(a.split("=")[0])} is never allowed (only -u and --dry-run)`;
    }
    pos.push(a);
  }
  if (pos.length < 2) return "git push must name the remote and the branch";
  for (const ref of pos.slice(1)) {
    if (ref.includes(":") || ref.includes("+")) return "git push refspecs with \":\" or \"+\" are never allowed";
    const name = ref.toLowerCase().replace(/^refs\/heads\//, "");
    if (name === "main" || name.startsWith("head") || name.startsWith("@")) return "git push to main (or to HEAD) is never allowed";
  }
  return null;
}

function ghProblem(args) {
  const pos = positionals(args, ["-R", "--repo"]);
  // workflow and run can start or restart a deploy; the rest change the repo, its releases or its keys
  if (["api", "secret", "repo", "auth", "alias", "variable", "extension", "workflow", "run", "release", "cache", "ruleset",
    "codespace", "ssh-key", "gpg-key"].includes(pos[0])) return `gh ${pos[0]} is never allowed`;
  if (pos[0] === "pr" && pos[1] === "merge") return "gh pr merge is the editor's call";
  return null;
}

// Local wrangler state only: .wrangler/ and below, no climbing out
function persistOk(v) {
  const p = (v ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return (p === ".wrangler" || p.startsWith(".wrangler/")) && !p.split("/").includes("..");
}

// The flags wrangler dev may take; anything else could point it at other config, code or the live site
const DEV_FLAGS = new Set(["--port", "--inspector-port", "--persist-to", "--var", "--local", "--log-level", "--show-interactive-dev-session"]);

// Only wrangler dev, a bare wrangler types, and d1 execute / migrations apply against the local database
function wranglerProblem(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[A-Za-z]+$/.test(a) && /[rc]/.test(a)) return `wrangler ${show(a)} is never allowed (-r is --remote, -c is --config)`;
    if (!a.startsWith("--")) continue;
    const name = flagName(a);
    if (name.includes("remote")) return "wrangler --remote touches the live site";
    if (name.startsWith("--x-")) return "wrangler experimental --x- flags are never allowed";
    if (["--config", "--script", "--env-file"].some((f) => name.startsWith(f))) return `wrangler ${name} is never allowed`;
    if (name === "--persist-to" && !persistOk(a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1])) return "wrangler --persist-to must stay under .wrangler/";
  }
  const [sub, sub2, sub3] = args;
  if (sub === "dev") {
    const bad = args.slice(1).find((a) => a.startsWith("-") && !DEV_FLAGS.has(flagName(a)));
    return bad ? `wrangler dev ${show(flagName(bad))} is never allowed (only ${[...DEV_FLAGS].join(", ")})` : null;
  }
  if (sub === "types") return args.length === 1 ? null : "wrangler types takes no arguments here";
  if (sub === "d1" && (sub2 === "execute" || (sub2 === "migrations" && sub3 === "apply"))) return args.includes("--local") ? null : "wrangler d1 needs --local";
  return `wrangler ${show(sub ?? "")} is never allowed (only dev, types, and d1 execute or migrations apply with --local)`;
}

function npmProblem(prog, rest) {
  if (rest[0]?.startsWith("-")) return `${prog} options before the command are never allowed`;
  if (prog === "npm" && ["run", "run-script", "rum", "urn", "exec", "x"].includes(rest[0]) && rest[1]?.startsWith("-")) return `npm ${rest[0]} options before the script are never allowed`;
  if (rest.includes("-c")) return `${prog} -c would run a command the guard can't see`;
  if (prog === "npm" && rest.some((a) => /deploy|remote/i.test(a))) return "npm scripts that deploy or touch the live database are never allowed";
  return null;
}

// npm test, npm run test*, and vitest: no switch that points the runner at other config or files
function runsTests(tokens) {
  return tokens.some((t, i) => program(t) === "vitest" || (program(t) === "npm" && (["test", "t", "tst"].includes(tokens[i + 1])
    || (["run", "run-script"].includes(tokens[i + 1]) && /^test/.test(tokens[i + 2] ?? "")))));
}

// Absolute paths, ~ and .. are refused when they land outside the repo (Bash can read and write through them)
function outsidePath(part, root, base) {
  if (part.startsWith("~") || (!WIN && /^[A-Za-z]:[\\/]/.test(part))) return true;
  if (!/^([\\/]|[A-Za-z]:[\\/])/.test(part) && !part.split(/[\\/]/).includes("..")) return false;
  const rel = path.relative(realish(path.resolve(root)), realish(path.resolve(base, part)));
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

// .claude/ holds the guard, its settings and the agents; no command may name it
function claudePath(part) {
  const p = part.replace(/\\/g, "/").toLowerCase();
  return p === ".claude" || p.startsWith(".claude/") || p.includes("/.claude/") || p.endsWith("/.claude") || p.includes("settings.local.json");
}

// What a word can name: itself, each side of "=" (--opt=value), and a value glued to a short option
// (-o/etc/x, or after a short cluster like -abC:/x), so the checks below see paths however they're attached
function wordParts(t) {
  const parts = t.split("=");
  if (/^-[A-Za-z]/.test(t)) for (let k = 2; k <= 4 && k < t.length; k++) parts.push(...t.slice(k).split("="));
  return parts;
}

// The one place .wrangler/ may appear in a command: as the value of wrangler's --persist-to
function persistValueAt(tokens, i) {
  if (!tokens.slice(0, i).some((t) => program(t) === "wrangler")) return false;
  const t = tokens[i];
  if (t.startsWith("--") && flagName(t) === "--persist-to" && t.includes("=")) return persistOk(t.slice(t.indexOf("=") + 1));
  return i > 0 && flagName(tokens[i - 1]) === "--persist-to" && !tokens[i - 1].includes("=") && persistOk(t);
}

// Hard rules for every policy agent, checked at every word so `npx wrangler deploy` is caught like `wrangler deploy`
function hardBashProblem(tokens, root, base) {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) return "leading environment assignments are not allowed";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], prog = program(t), rest = tokens.slice(i + 1);
    if (t.startsWith("--") && CODE_FLAGS.some((f) => flagName(t).startsWith(f))) return `${show(flagName(t))} loads code or config the guard can't see`;
    if (SHELLS.has(prog)) return `${prog} would run a command the guard can't see`;
    if (/agents:promote|promote-agent-drafts/i.test(t)) return "promoting agent drafts is the editor's job";
    if (prog === "node" && rest.some((a) => ["-e", "--eval", "-p", "--print", "-r"].includes(a))) return "node -e, -p and -r run code the guard can't see";
    const problem = prog === "git" ? gitProblem(rest) : prog === "gh" ? ghProblem(rest) : prog === "wrangler" ? wranglerProblem(rest)
      : prog === "npm" || prog === "npx" ? npmProblem(prog, rest) : null;
    if (problem) return problem;
  }
  if (runsTests(tokens) && tokens.some((t) => t === "-r" || t === "-c" || (t.startsWith("--") && ["--root", "--dir", "--config"].some((f) => flagName(t).startsWith(f))))) {
    return "test runs take no -r, -c, --root, --dir or --config";
  }
  for (let i = 0; i < tokens.length; i++) {
    if (persistValueAt(tokens, i)) continue;
    for (const part of wordParts(tokens[i])) {
      if (isSecretPath(part)) return "it names a secret file or folder";
      if (claudePath(part)) return "it names a path under .claude/";
      if (outsidePath(part, root, base)) return "it names a path outside the repository";
    }
  }
  return null;
}

function tokenMatches(pat, tok) {
  if (pat === "*") return true;
  if (pat.startsWith("re:")) return new RegExp(`^(?:${pat.slice(3)})$`).test(tok);
  return pat === tok;
}

function patternMatches(pat, tokens) {
  const open = pat[pat.length - 1] === "**";
  const fixed = open ? pat.slice(0, -1) : pat;
  if (open ? tokens.length < fixed.length : tokens.length !== fixed.length) return false;
  return fixed.every((p, i) => tokenMatches(p, tokens[i]));
}

function checkBash(agent, policy, input, root, base) {
  const cmd = input.command;
  if (typeof cmd !== "string") refuse(`agent-guard: ${agent} may not run Bash without a command`);
  if (cmd.length > MAX_LEN) refuse(`agent-guard: ${agent} may not run that command (longer than ${MAX_LEN} characters)`);
  const { tokens, error } = tokenize(cmd);
  if (error) refuse(`agent-guard: ${agent} may not run that command (it contains ${error}; run one plain command and quote special characters)`);
  if (!tokens.length) refuse(`agent-guard: ${agent} may not run an empty command`);
  const what = show(tokens.slice(0, 3).join(" "));
  const hard = hardBashProblem(tokens, root, base);
  if (hard) refuse(`agent-guard: ${agent} may not run "${what}..." (${hard})`);
  if (!(policy.bash ?? []).some((pat) => patternMatches(pat, tokens))) refuse(`agent-guard: ${agent} may not run "${what}..." (no pattern in its policy allows it)`);
}

// --- web and subagents ---

function checkFetch(agent, policy, input) {
  let url;
  try {
    if (typeof input.url !== "string" || input.url.length > MAX_LEN) throw new Error();
    url = new URL(input.url);
  } catch {
    refuse(`agent-guard: ${agent} may not fetch that address (not a valid URL)`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:") refuse(`agent-guard: ${agent} may not fetch ${show(host)} (https only)`);
  if (url.username || url.password || url.port) refuse(`agent-guard: ${agent} may not fetch ${show(host)} (no credentials or ports in the address)`);
  if (!(policy.webfetch ?? []).some((d) => host === d || host.endsWith("." + d))) refuse(`agent-guard: ${agent} may not fetch ${show(host)} (not a domain in its policy)`);
}

// A policy agent may only start agents its policy names, and only ones that are themselves held to a policy
function checkSubagent(agent, tool, policy, input, root) {
  const sub = input.subagent_type;
  if (typeof sub !== "string" || sub.length > MAX_LEN || !(policy.agents ?? []).includes(sub)) refuse(`agent-guard: ${agent} may not use ${tool} to start ${show(sub)} (not an agent in its policy)`);
  if (!/^[a-z0-9-]+$/.test(sub) || !fs.existsSync(policyFile(root, sub))) refuse(`agent-guard: ${agent} may not use ${tool} to start ${show(sub)} (it has no policy file of its own)`);
}

// --- main ---

function decide(input) {
  if (!isObject(input)) refuse("agent-guard: the hook input isn't a JSON object, so the tool is refused");
  const agent = input.agent_type;
  if (agent === undefined || agent === null || agent === "") return;
  if (typeof agent !== "string" || agent.length > 64 || !/^[A-Za-z0-9-]+$/.test(agent)) refuse("agent-guard: an agent with an invalid name may not use any tool");
  const root = repoRoot();
  const policy = loadPolicy(root, agent);
  if (!policy) return;
  const tool = input.tool_name;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (typeof tool !== "string" || !policy.tools.includes(tool)) refuse(`agent-guard: ${agent} may not use ${show(tool)} (not a tool in its policy)`);
  if (tool === "PowerShell") refuse(`agent-guard: ${agent} may not use PowerShell (the guard can only check Bash commands)`);
  // Relative paths resolve against the session's folder, as the tools themselves do
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : root;
  if (EDIT_TOOLS.has(tool)) return checkEdit(agent, policy, tool === "NotebookEdit" ? toolInput.notebook_path : toolInput.file_path, root, base);
  if (READ_TOOLS.has(tool)) return checkRead(agent, tool, toolInput, root, base);
  if (tool === "Bash") return checkBash(agent, policy, toolInput, root, base);
  if (tool === "WebFetch") return checkFetch(agent, policy, toolInput);
  if (tool === "Task" || tool === "Agent") return checkSubagent(agent, tool, policy, toolInput, root);
  // Any other listed tool that names a file is treated as writing it, and one that names a folder as reading it
  if (toolInput.file_path !== undefined || toolInput.notebook_path !== undefined) checkEdit(agent, policy, toolInput.file_path ?? toolInput.notebook_path, root, base);
  if (toolInput.path !== undefined) checkReadPath(agent, tool, toolInput.path, root, base);
}

// For scripts/promote-agent-drafts.mjs, which validates drafts with the same rules
export { policyProblem };

async function main() {
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  try {
    let input;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      refuse("agent-guard: the hook input isn't valid JSON, so the tool is refused");
    }
    decide(input);
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

// The hook always runs unless an importer opts out first, so a mistake here can't turn the guard off
if (!globalThis.AGENT_GUARD_NO_MAIN) await main();
