// scripts/promote-protected-drafts.mjs, run against a throwaway git repo
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "..", "..", "scripts", "promote-protected-drafts.mjs");
let repo;

const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(repo, rel));
const commit = () => { git("add", "-A"); git("commit", "-q", "-m", "drafts"); };
const promote = () => {
  const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
function refusedUntouched(draft, re) {
  write(draft, "draft\n");
  commit();
  const r = promote();
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, re);
  assert.equal(git("status", "--porcelain"), "", "nothing moved");
  assert.ok(exists(draft), "the draft is still there");
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drafts-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write("protected-drafts/README.md", "drafts\n");
  write("test/e2e/routes.mjs", "old\n");
  write("migrations/0013_site_stats.sql", "applied\n");
  write("package.json", "{}\n");
  commit();
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("promote-protected-drafts", () => {
  test("no drafts: nothing to do", () => {
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing to do/);
  });

  test("drafts move into place with git mv, staged and not committed, leaving only the README", () => {
    write("protected-drafts/test/e2e/routes.mjs", "new\n");
    write("protected-drafts/test/e2e/api/me.mjs", "added\n");
    write("protected-drafts/migrations/0014_new_table.sql", "create\n");
    commit();
    const head = git("rev-parse", "HEAD");
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /updated test\/e2e\/routes\.mjs/);
    assert.match(r.out, /added +test\/e2e\/api\/me\.mjs/);
    assert.match(r.out, /added +migrations\/0014_new_table\.sql/);
    assert.equal(read("test/e2e/routes.mjs"), "new\n");
    assert.equal(read("migrations/0014_new_table.sql"), "create\n");
    assert.deepEqual(fs.readdirSync(path.join(repo, "protected-drafts")), ["README.md"]);
    assert.equal(git("rev-parse", "HEAD"), head, "no commit");
    assert.match(git("diff", "--cached", "--name-status"), /test\/e2e\/api\/me\.mjs/);
  });

  test("every allowed kind of target is accepted", () => {
    for (const rel of ["package.json", "wrangler.jsonc", "admin/wrangler.jsonc", "test/wrangler.test.jsonc", ".github/workflows/deploy.yml", "scripts/fetch-events.mjs"]) {
      write(`protected-drafts/${rel}`, "x\n");
    }
    commit();
    const r = promote();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /moved 6 file/);
    assert.match(r.out, /npm install/);
  });

  test("an existing migration is never overwritten", () => refusedUntouched("protected-drafts/migrations/0013_site_stats.sql", /already exists; applied migrations are never edited/));
  test("a migration name that isn't NNNN_name.sql is refused", () => refusedUntouched("protected-drafts/migrations/new.sql", /isn't a place drafts may go/));
  test(".claude/ can never be promoted", () => refusedUntouched("protected-drafts/.claude/hooks/agent-guard.mjs", /can never be promoted/));
  test(".claude/ is refused in any case", () => refusedUntouched("protected-drafts/.Claude/settings.json", /can never be promoted/));
  test("CLAUDE.md can never be promoted", () => refusedUntouched("protected-drafts/CLAUDE.md", /can never be promoted/));
  test("secrets can never be promoted", () => refusedUntouched("protected-drafts/.dev.vars", /can never be promoted/));
  test("seed.sql can never be promoted", () => refusedUntouched("protected-drafts/scripts/seed.sql", /can never be promoted/));
  test("the promote scripts are the editor's", () => refusedUntouched("protected-drafts/scripts/promote-agent-drafts.mjs", /the editor changes directly/));
  test("the scripts that set secrets are the editor's", () => refusedUntouched("protected-drafts/scripts/events-token.mjs", /the editor changes directly/));
  test("source files aren't drafts", () => refusedUntouched("protected-drafts/src/index.ts", /isn't a place drafts may go/));
  test("tsconfig can't be promoted from drafts", () => refusedUntouched("protected-drafts/tsconfig.json", /isn't a place drafts may go/));
  test("a workflow outside .github/workflows is refused", () => refusedUntouched("protected-drafts/.github/CODEOWNERS", /isn't a place drafts may go/));

  test("one bad draft stops everything before anything moves", () => {
    write("protected-drafts/test/e2e/routes.mjs", "new\n");
    write("protected-drafts/.claude/agents/x.md", "bad\n");
    commit();
    const r = promote();
    assert.equal(r.code, 1);
    assert.equal(read("test/e2e/routes.mjs"), "old\n");
    assert.equal(git("status", "--porcelain"), "");
  });

  test("a dirty working tree is refused", () => {
    write("protected-drafts/test/e2e/routes.mjs", "new\n");
    const r = promote();
    assert.equal(r.code, 1);
    assert.match(r.err, /uncommitted changes/);
  });
});
