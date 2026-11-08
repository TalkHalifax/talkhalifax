// scripts/promote-agent-drafts.mjs, run against a throwaway git repo
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "..", "..", "scripts", "promote-agent-drafts.mjs");
let repo;

const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
const commit = () => { git("add", "-A"); git("commit", "-q", "-m", "drafts"); };
const agentMd = (name) => `---\nname: ${name}\ndescription: test\ntools: Read\n---\n\nYou are ${name}.\n`;
const policy = (name, extra = {}) => JSON.stringify({ agent: name, tools: ["Read"], ...extra }) + "\n";
const promote = () => {
  const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const exists = (rel) => fs.existsSync(path.join(repo, rel));
function refusedUntouched(r, re) {
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, re);
  assert.equal(git("status", "--porcelain"), "", "nothing moved");
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "promote-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write("agent-drafts/README.md", "drafts\n");
  write(".claude/agents/engineer.md", agentMd("engineer"));
  commit();
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("promote-agent-drafts", () => {
  test("no drafts: nothing to do", () => {
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing to do/);
  });
  test("a new agent moves into place with git mv, staged and not committed", () => {
    write("agent-drafts/transit-builder.md", agentMd("transit-builder"));
    write("agent-drafts/policy/transit-builder.json", policy("transit-builder"));
    commit();
    const head = git("rev-parse", "HEAD");
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /added +\.claude\/agents\/transit-builder\.md/);
    assert.match(r.out, /added +\.claude\/agents\/policy\/transit-builder\.json/);
    assert.ok(exists(".claude/agents/transit-builder.md") && exists(".claude/agents/policy/transit-builder.json"));
    assert.deepEqual(fs.readdirSync(path.join(repo, "agent-drafts")), ["README.md"]);
    assert.equal(git("rev-parse", "HEAD"), head, "no commit");
    assert.match(git("status", "--porcelain"), /^R  agent-drafts\/transit-builder\.md -> \.claude\/agents\/transit-builder\.md$/m);
  });
  test("a draft replaces an existing agent, and a policy alone updates one", () => {
    write(".claude/agents/policy/engineer.json", policy("engineer"));
    write(".claude/agents/designer.md", agentMd("designer"));
    commit();
    write("agent-drafts/engineer.md", agentMd("engineer") + "Changed.\n");
    write("agent-drafts/policy/engineer.json", policy("engineer", { level: "L2" }));
    write("agent-drafts/policy/designer.json", policy("designer"));
    commit();
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /updated \.claude\/agents\/engineer\.md/);
    assert.match(r.out, /updated \.claude\/agents\/policy\/engineer\.json/);
    assert.match(r.out, /added +\.claude\/agents\/policy\/designer\.json/);
    assert.match(fs.readFileSync(path.join(repo, ".claude/agents/engineer.md"), "utf8"), /Changed\./);
    assert.match(fs.readFileSync(path.join(repo, ".claude/agents/policy/engineer.json"), "utf8"), /"L2"/);
  });
  test("refuses a dirty working tree", () => {
    write("agent-drafts/transit-builder.md", agentMd("transit-builder"));
    write("agent-drafts/policy/transit-builder.json", policy("transit-builder"));
    commit();
    write("src/x.ts", "x");
    const r = promote();
    assert.equal(r.code, 1);
    assert.match(r.err, /uncommitted changes/);
    assert.ok(exists("agent-drafts/transit-builder.md"));
  });
  test("refuses a definition without a policy", () => {
    write("agent-drafts/transit-builder.md", agentMd("transit-builder"));
    commit();
    refusedUntouched(promote(), /has no matching agent-drafts\/policy\/transit-builder\.json/);
  });
  test("refuses a policy for an agent that doesn't exist", () => {
    write("agent-drafts/policy/ghost.json", policy("ghost"));
    commit();
    refusedUntouched(promote(), /doesn't exist and has no draft/);
  });
  describe("front matter", () => {
    // Draft one agent with this front matter body and a policy granting these tools, then promote
    function tryFront(body, tools = ["Read", "Grep"]) {
      write("agent-drafts/fm.md", `---\n${body}\n---\n\nYou are fm.\n`);
      write("agent-drafts/policy/fm.json", policy("fm", { tools }));
      commit();
      return promote();
    }
    test("the allowed keys, inline or listed tools, and quotes pass", () => {
      const r = tryFront("name: fm\ndescription: \"Does: things\"\ntools:\n  - Read\n  - 'Grep'\nmodel: sonnet\ncolor: blue\neffort: high\nmaxTurns: 20");
      assert.equal(r.code, 0, r.err);
    });
    test("inline tool lists, with or without brackets, pass", () => {
      assert.equal(tryFront("name: fm\ntools: [Read, Grep]").code, 0);
    });
    for (const key of ["hooks", "mcpServers", "permissionMode", "skills", "memory", "isolation", "background", "initialPrompt",
      "disallowedTools", "omitClaudeMd", "Name", "allowed-tools"]) {
      test(`refuses the ${key} key`, () => refusedUntouched(tryFront(`name: fm\ntools: Read\n${key}: x`), new RegExp(`front matter key "${key}", which isn't allowed`)));
    }
    test("refuses nested or indented lines anywhere but a list under tools", () => {
      refusedUntouched(tryFront("name: fm\ntools: Read\nmodel:\n  - x"), /"model" with no value/);
      refusedUntouched(tryFront("name: fm\ntools: Read\n  - Grep"), /indented list somewhere other than under tools/);
      refusedUntouched(tryFront("name: fm\ntools:\n  - Read\ncolor: blue\n  - Grep"), /indented list somewhere other than under tools/);
      refusedUntouched(tryFront("name: fm\ntools: Read\ndescription: >\n  folded text"), /indented line/);
      refusedUntouched(tryFront("name: fm\ntools:\n  - Read\n    nested: x"), /indented line/);
      refusedUntouched(tryFront("name: fm\ntools: Read\nhooks:\n  PreToolUse: []"), /front matter key "hooks"/);
    });
    test("refuses duplicate keys, a missing or second name, and a wrong name", () => {
      refusedUntouched(tryFront("name: fm\nname: fm\ntools: Read"), /key "name" twice/);
      refusedUntouched(tryFront("name: fm\ntools: Read\ntools: Grep"), /key "tools" twice/);
      refusedUntouched(tryFront("description: x\ntools: Read"), /no name:/);
      refusedUntouched(tryFront("name: other\ntools: Read"), /declares name: other, not fm/);
    });
    test("refuses front matter that can't be parsed", () => {
      refusedUntouched(tryFront("name: fm\ntools: Read\n# a comment"), /can't be read/);
      refusedUntouched(tryFront("name: fm\ntools: Read\njust words"), /can't be read/);
      refusedUntouched(tryFront("name: fm\ntools: Read\ncolor:"), /"color" with no value/);
      write("agent-drafts/fm.md", "no front matter here\n");
      write("agent-drafts/policy/fm.json", policy("fm"));
      commit();
      refusedUntouched(promote(), /doesn't start with a --- front matter line/);
      write("agent-drafts/fm.md", "---\nname: fm\ntools: Read\n");
      commit();
      refusedUntouched(promote(), /no closing ---/);
    });
    test("refuses an agent with no tools: line (it would get every tool)", () => {
      refusedUntouched(tryFront("name: fm\ndescription: x"), /has no tools:/);
    });
    test("every listed tool must be in the policy's tools, PowerShell and MCP tools included", () => {
      refusedUntouched(tryFront("name: fm\ntools: Read, Bash"), /lists tool Bash, which its policy's tools don't include/);
      refusedUntouched(tryFront("name: fm\ntools: Read, PowerShell"), /lists tool PowerShell/);
      refusedUntouched(tryFront("name: fm\ntools: Read, mcp__talkhalifax__publish_story"), /lists tool mcp__talkhalifax__publish_story/);
      assert.equal(tryFront("name: fm\ntools: Read, mcp__talkhalifax__list_leads", ["Read", "mcp__talkhalifax__list_leads"]).code, 0);
    });
    test("a policy on its own is checked against the definition already in place", () => {
      write("agent-drafts/policy/engineer.json", policy("engineer", { tools: ["Grep"] }));
      commit();
      refusedUntouched(promote(), /\.claude\/agents\/engineer\.md lists tool Read, which its policy's tools don't include/);
    });
  });
  test("refuses a front matter name that doesn't match the file", () => {
    write("agent-drafts/transit-builder.md", agentMd("someone-else"));
    write("agent-drafts/policy/transit-builder.json", policy("transit-builder"));
    commit();
    refusedUntouched(promote(), /declares name: someone-else, not transit-builder/);
  });
  test("refuses a policy the guard would refuse, and moves nothing else", () => {
    write("agent-drafts/good.md", agentMd("good"));
    write("agent-drafts/policy/good.json", policy("good"));
    write("agent-drafts/bad.md", agentMd("bad"));
    write("agent-drafts/policy/bad.json", policy("bad", { tools: ["Bash"], bash: [["npm", "**"]] }));
    commit();
    refusedUntouched(promote(), /bad\.json is invalid: npm patterns may not end in \*\*/);
    assert.ok(!exists(".claude/agents/good.md"));
  });
  test("refuses broken JSON and unknown keys", () => {
    write("agent-drafts/policy/engineer.json", "{ nope");
    commit();
    refusedUntouched(promote(), /isn't valid JSON/);
    write("agent-drafts/policy/engineer.json", policy("engineer", { edits: {} }));
    commit();
    refusedUntouched(promote(), /unknown key "edits"/);
  });
  test("refuses the orchestrator, Agent Operations and bad names", () => {
    for (const name of ["orchestrator", "agent-ops-lead"]) {
      write(`agent-drafts/${name}.md`, agentMd(name));
      write(`agent-drafts/policy/${name}.json`, policy(name));
      commit();
      refusedUntouched(promote(), /can't be promoted from drafts/);
      git("rm", "-q", "-r", `agent-drafts/${name}.md`, `agent-drafts/policy/${name}.json`);
      git("commit", "-q", "-m", "clean");
    }
    write("agent-drafts/Bad_Name.md", agentMd("Bad_Name"));
    write("agent-drafts/policy/Bad_Name.json", policy("Bad_Name"));
    commit();
    refusedUntouched(promote(), /isn't a valid agent name/);
  });
  test("refuses files that aren't drafts", () => {
    write("agent-drafts/notes.txt", "x");
    commit();
    refusedUntouched(promote(), /agent-drafts\/notes\.txt isn't a draft/);
  });
});
