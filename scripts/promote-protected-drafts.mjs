// Promotes reviewed drafts of protected files into place. For the orchestrator or the editor only, on an approved pull
// request's branch, with a clean working tree:
//   npm run drafts:promote
// The agent guard refuses some files to every agent (migrations/, package.json, test/e2e/, wrangler configs, .github/,
// scripts/). Teams write changes to them under protected-drafts/, at the same path (protected-drafts/test/e2e/x.mjs
// becomes test/e2e/x.mjs). Nothing loads that folder, so a draft does nothing until it's promoted.
// This moves each draft with git mv, after checking every target against a short allowlist. It refuses anything else,
// including .claude/, CLAUDE.md and secrets, and never overwrites an existing migration. Doesn't commit or push.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = "protected-drafts";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (msg) => { console.error(`drafts:promote: ${msg}`); process.exit(1); };

// The only places a draft may land. Everything else is refused, so a new kind of protected file needs this list changed
// in its own reviewed pull request.
const ALLOWED = [
  /^test\/e2e\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/,
  /^migrations\/\d{4}_[a-z0-9_]+\.sql$/,
  /^package\.json$/,
  /^wrangler\.jsonc$/,
  /^admin\/wrangler\.jsonc$/,
  /^test\/wrangler\.[a-z]+\.jsonc$/,
  /^\.github\/workflows\/[a-z0-9-]+\.yml$/,
  /^scripts\/[a-z0-9-]+\.mjs$/,
];
// Refused even where the allowlist would match: the promote scripts themselves (they enforce this), and the scripts
// that set secrets
const REFUSED = [/^scripts\/promote-[a-z0-9-]+\.mjs$/, /^scripts\/(events-token|vapid-keys)\.mjs$/];
// Never, whatever the lists say (a second line of defence if the allowlist is ever widened by mistake)
function forbidden(rel) {
  const lower = rel.toLowerCase();
  const segs = lower.split("/");
  const base = segs[segs.length - 1];
  return lower === ".claude" || lower.startsWith(".claude/") || lower === "claude.md" || segs.includes(".git")
    || segs.includes("node_modules") || segs.includes(".wrangler") || segs.includes("..") || segs.includes(".")
    || base === ".dev.vars" || base.startsWith(".dev.vars.") || base === ".env" || base.startsWith(".env.")
    || base === ".newsroom-token" || base === "seed.sql" || base === ".npmrc" || base === ".netrc";
}

// Every file under protected-drafts/ except the README, as repo-relative target paths
function collect(root) {
  const base = path.join(root, DIR);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) fail(`${DIR}/${rel} is a link; drafts must be plain files`);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) { if (rel !== "README.md") out.push(rel); }
      else fail(`${DIR}/${rel} isn't a plain file`);
    }
  };
  walk(base);
  return out.sort();
}

function validate(root, targets) {
  for (const rel of targets) {
    if (forbidden(rel)) fail(`${DIR}/${rel} would land on ${rel}, which can never be promoted from drafts`);
    if (REFUSED.some((re) => re.test(rel))) fail(`${DIR}/${rel} would replace ${rel}, which the editor changes directly`);
    if (!ALLOWED.some((re) => re.test(rel))) fail(`${DIR}/${rel} would land on ${rel}, which isn't a place drafts may go (see ${DIR}/README.md)`);
    if (rel.startsWith("migrations/") && fs.existsSync(path.join(root, rel))) fail(`${rel} already exists; applied migrations are never edited, so add a new numbered file`);
  }
}

function move(root, rel) {
  const existed = fs.existsSync(path.join(root, rel));
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  git("mv", "-f", "--", `${DIR}/${rel}`, rel);
  return `${existed ? "updated" : "added  "} ${rel}`;
}

// Remove folders the move emptied, leaving protected-drafts/ with only its README
function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    prune(sub);
    if (!fs.readdirSync(sub).length) fs.rmdirSync(sub);
  }
}

const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
if (git("status", "--porcelain")) fail("the working tree has uncommitted changes; commit or stash them first");
const targets = collect(root);
if (!targets.length) {
  console.log(`drafts:promote: no drafts in ${DIR}/, nothing to do`);
  process.exit(0);
}
validate(root, targets);
const done = targets.map((rel) => move(root, rel));
prune(path.join(root, DIR));
console.log(`drafts:promote: moved ${done.length} file(s) from ${DIR}/ (staged, not committed):`);
for (const line of done) console.log(`  ${line}`);
if (targets.includes("package.json")) console.log("package.json changed: run `npm install` and commit package-lock.json with it.");
console.log("Review with `git diff --cached`, then commit and push the branch.");
