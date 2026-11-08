// The agent guard in Claude Code desktop's layout: CLAUDE_PROJECT_DIR is the main checkout, and the session runs in
// a linked worktree at <main>/.claude/worktrees/<name>/. Uses throwaway repos with real `git worktree add`.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "..", "..", ".claude", "hooks", "agent-guard.mjs");
let tmp, main, w1, w2, other;

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
function write(file, text = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
// A repo with a few files and one commit
function makeRepo(dir, policies = []) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const f of policies) write(path.join(dir, ".claude", "agents", "policy", f), fs.readFileSync(path.join(here, "fixtures", f), "utf8"));
  write(path.join(dir, "src", "events.ts"));
  write(path.join(dir, "test", "unit", "x.ts"));
  write(path.join(dir, "package.json"), "{}\n");
  write(path.join(dir, ".gitignore"), ".claude/worktrees/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}
const wt = (name) => path.join(main, ".claude", "worktrees", name);
// Git Bash's spelling of a Windows path: D:\x\y -> /d/x/y
const msys = (p) => p.replace(/^([A-Za-z]):/, (_, d) => "/" + d.toLowerCase()).replace(/\\/g, "/");

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-wt-")));
  main = path.join(tmp, "main");
  makeRepo(main, ["events-builder.json", "strict.json", "qa-tester.json"]);
  git(main, "worktree", "add", "-q", "-b", "w1", wt("w1"));
  git(main, "worktree", "add", "-q", "-b", "w2", wt("w2"));
  w1 = wt("w1");
  w2 = wt("w2");

  // Look-alikes under .claude/worktrees/ that aren't linked worktrees of this repo
  write(path.join(wt("plain"), "src", "events.ts"));
  write(path.join(wt("dotgit-dir"), ".git", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(wt("dotgit-dir"), "src", "events.ts"));
  other = path.join(tmp, "other");
  makeRepo(other);
  git(other, "worktree", "add", "-q", "-b", "o1", path.join(other, "o1"));
  write(path.join(wt("other-repo"), ".git"), fs.readFileSync(path.join(other, "o1", ".git"), "utf8"));
  write(path.join(wt("other-repo"), "src", "events.ts"));
  write(path.join(wt("copied"), ".git"), fs.readFileSync(path.join(w1, ".git"), "utf8")); // points at w1's gitdir, which doesn't point back
  write(path.join(wt("copied"), "src", "events.ts"));
  write(path.join(wt("elsewhere"), ".git"), `gitdir: ${path.join(tmp, "nowhere")}\n`);
  write(path.join(wt("elsewhere"), "src", "events.ts"));
  write(path.join(main, ".git", "worktrees", "fake", "commondir"), "../..\n"); // looks right but no gitdir back-link
  write(path.join(wt("half"), ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "fake")}\n`);
  write(path.join(wt("half"), "src", "events.ts"));

  // Links: one outside the repo into w1, one under .claude/worktrees/ out to the other repo's worktree
  fs.symlinkSync(w1, path.join(tmp, "link-to-w1"), "junction");
  fs.symlinkSync(path.join(other, "o1"), wt("link-out"), "junction");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(input) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_use_id: "t", ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: main },
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}
const as = (agent, cwd, tool_name, tool_input) => run({ agent_type: agent, agent_id: "a1", cwd, tool_name, tool_input });
const edit = (agent, cwd, file_path) => as(agent, cwd, "Edit", { file_path, old_string: "a", new_string: "b" });
const bash = (cwd, command) => as("events-builder", cwd, "Bash", { command, description: "d" });
function allowed(r) { assert.equal(r.code, 0, `expected allowed, got: ${r.err}`); assert.equal(r.err, ""); }
function refused(r, re) {
  assert.equal(r.code, 2, "expected refused");
  assert.equal(r.err.trim().split("\n").length, 1, "one line");
  assert.match(r.err, re);
}

describe("in a linked worktree", () => {
  test("edits inside the worktree's allowed paths pass, relative or absolute", () => {
    allowed(edit("strict", w1, "src/events.ts"));
    allowed(edit("strict", w1, path.join(w1, "src", "events.ts")));
    allowed(edit("strict", path.join(w1, "src"), "events.ts"));
    allowed(edit("events-builder", w1, "test/unit/x.ts"));
    allowed(edit("events-builder", w1, "agent-drafts/transit-builder.md"));
    allowed(as("events-builder", w1, "Write", { file_path: path.join(w1, "agent-drafts", "policy", "transit-builder.json"), content: "{}" }));
  });
  test("the usual rules apply relative to the worktree root", () => {
    refused(edit("strict", w1, "src/auth.ts"), /outside its file scope/);
    refused(edit("events-builder", w1, ".claude/agents/new.md"), /protected for every agent; agent changes are drafted in agent-drafts\//);
    refused(edit("events-builder", w1, path.join(w1, ".claude", "settings.json")), /protected for every agent/);
    refused(edit("events-builder", w1, "package.json"), /protected for every agent/);
    refused(edit("events-builder", w1, "agent-drafts/events-builder.md"), /never drafts its own/);
    refused(as("events-builder", w1, "Read", { file_path: ".dev.vars" }), /secrets/);
  });
  test("the main checkout and other worktrees count as outside the repository", () => {
    refused(edit("strict", w1, path.join(main, "src", "events.ts")), /outside the repository/);
    refused(edit("strict", w1, path.join(w2, "src", "events.ts")), /outside the repository/);
    refused(edit("strict", w1, "../w2/src/events.ts"), /outside the repository/);
    refused(edit("events-builder", w1, path.join(main, ".claude", "agents", "policy", "strict.json")), /outside the repository/);
    refused(as("events-builder", w1, "Read", { file_path: path.join(main, "package.json") }), /outside the repository/);
    refused(as("events-builder", w1, "Grep", { pattern: "x", path: main }), /outside the repository/);
    refused(as("events-builder", w1, "Glob", { pattern: "*", path: "../.." }), /outside the repository/);
    allowed(as("events-builder", w1, "Read", { file_path: path.join(w1, "package.json") }));
    allowed(as("events-builder", w1, "Grep", { pattern: "x" }));
    allowed(as("events-builder", path.join(w1, "src"), "Glob", { pattern: "*", path: ".." }));
  });
  test("policies still come from the main checkout", () => {
    // A policy file only in the worktree doesn't exist as far as the guard is concerned
    write(path.join(w1, ".claude", "agents", "policy", "wt-only.json"), JSON.stringify({ agent: "wt-only", tools: [] }));
    allowed(as("wt-only", w1, "Bash", { command: "anything" }));
    // A broken policy in the worktree doesn't change the main checkout's policy
    write(path.join(w1, ".claude", "agents", "policy", "strict.json"), "{ broken");
    allowed(edit("strict", w1, "src/events.ts"));
    fs.rmSync(path.join(w1, ".claude", "agents", "policy", "wt-only.json"));
    git(w1, "checkout", "--", ".claude/agents/policy/strict.json");
  });
  test("a cwd reached through a link resolves to the real worktree", () => {
    const link = path.join(tmp, "link-to-w1");
    allowed(edit("strict", link, "src/events.ts"));
    allowed(edit("strict", link, path.join(link, "src", "events.ts")));
    refused(edit("strict", link, path.join(main, "src", "events.ts")), /outside the repository/);
  });
});

describe("look-alikes stay judged against the main checkout", () => {
  for (const name of ["plain", "dotgit-dir", "other-repo", "copied", "elsewhere", "half"]) {
    test(`.claude/worktrees/${name}`, () => {
      refused(edit("strict", wt(name), "src/events.ts"), /protected for every agent; agent changes are drafted in agent-drafts\//);
      refused(bash(wt(name), "cat package.json"), /no pattern|under \.claude/);
      refused(bash(wt(name), `cat '${path.join(wt(name), "src", "events.ts")}'`), /under \.claude/);
    });
  }
  test("a link under .claude/worktrees/ that leads out of the repo", () => {
    refused(edit("strict", wt("link-out"), "src/events.ts"), /outside the repository/);
  });
  test("a cwd that doesn't exist, or the worktrees folder itself", () => {
    refused(edit("strict", path.join(wt("w1"), "..", "missing"), "src/events.ts"), /protected for every agent|outside/);
    refused(edit("strict", path.join(main, ".claude", "worktrees"), "w1/src/events.ts"), /protected for every agent/);
  });
});

describe("from the main checkout", () => {
  test(".claude/worktrees/ stays protected, and the main checkout's own files are judged as usual", () => {
    allowed(edit("strict", main, "src/events.ts"));
    refused(edit("strict", main, ".claude/worktrees/w1/src/events.ts"), /protected for every agent/);
    refused(edit("strict", main, path.join(w1, "src", "events.ts")), /protected for every agent/);
    refused(bash(main, `cat '${path.join(w1, "package.json")}'`), /under \.claude/);
  });
});

describe("Bash path words in a worktree", () => {
  test("resolve against the worktree", () => {
    allowed(bash(w1, "cat package.json"));
    allowed(bash(w1, `cat '${path.join(w1, "package.json")}'`));
    allowed(bash(path.join(w1, "src"), "cat ../package.json"));
    refused(bash(w1, `cat '${path.join(main, "package.json")}'`), /outside the repository/);
    refused(bash(w1, "cat ../../../package.json"), /outside the repository/);
    refused(bash(w1, `cat '${path.join(w2, "package.json")}'`), /outside the repository/);
    refused(bash(w1, "cat .claude/settings.json"), /under \.claude/);
    refused(bash(w1, `cat '${path.join(w1, ".claude", "agents", "policy", "strict.json")}'`), /under \.claude/);
    refused(bash(w1, "cat src/.claude/x"), /under \.claude/);
  });
  test("a session folder under .claude/ or outside the work root refuses every command", () => {
    refused(bash(path.join(w1, ".claude"), "cat package.json"), /the session's folder: a path under \.claude/);
    refused(bash(wt("plain"), "echo hi"), /the session's folder: a path under \.claude/);
    refused(bash(tmp, "echo hi"), /the session's folder: a path outside the repository/);
    allowed(bash(path.join(w1, "src"), "echo hi"));
  });
  test("Git Bash /d/... paths mean the same place on Windows", (t) => {
    if (process.platform !== "win32") return t.skip("Windows only");
    allowed(bash(w1, `cat ${msys(path.join(w1, "package.json"))}`));
    refused(bash(w1, `cat ${msys(path.join(main, "package.json"))}`), /outside the repository/);
    refused(bash(w1, `cat ${msys(path.join(w1, ".claude", "settings.json"))}`), /under \.claude/);
  });
});

describe("SubagentHandback", () => {
  test("is always allowed for a policy agent, whatever its input names", () => {
    allowed(as("strict", w1, "SubagentHandback", { message: "done" }));
    allowed(as("strict", main, "SubagentHandback", { message: "done", file_path: "/etc/passwd", path: "../..", notebook_path: ".dev.vars" }));
    allowed(as("qa-tester", tmp, "SubagentHandback", {}));
  });
  test("other unlisted tools are still refused", () => {
    refused(as("strict", w1, "TodoWrite", { todos: [] }), /not a tool in its policy/);
    refused(as("strict", w1, "SubagentHandbackX", {}), /not a tool in its policy/);
  });
});
