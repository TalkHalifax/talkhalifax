# Protected drafts

The agent guard refuses some files to every agent, because they run code or deploy: `migrations/`, `package.json`,
`test/e2e/`, the wrangler configs, `.github/` and `scripts/`. Teams that own one of them write their change here
instead, at the same path. For example, `protected-drafts/test/e2e/routes.mjs` becomes `test/e2e/routes.mjs`.

Nothing loads this folder. TypeScript, the unit tests, the end-to-end runner and the deploy all ignore it, so a draft
does nothing until it's promoted.

## The flow

1. **A team drafts the file here**, as far as its policy's `edit.allow` lets it. Each team gets its draft paths
   through a change request, for example `protected-drafts/test/e2e/**` for Platform Core.
2. **The team's project manager opens a pull request** with the draft, as usual.
3. **The orchestrator or the editor reviews it.** Once the editor approves that pull request, they run
   `npm run drafts:promote` on its branch, with a clean working tree. That runs
   [`scripts/promote-protected-drafts.mjs`](../scripts/promote-protected-drafts.mjs), which:
   - moves each draft to its real path with `git mv`, staged but not committed;
   - refuses any target outside this list:
     - `test/e2e/**`
     - new migrations, `migrations/NNNN_name.sql`
     - `package.json`
     - `wrangler.jsonc`, `admin/wrangler.jsonc`, `test/wrangler.<name>.jsonc`
     - `.github/workflows/<name>.yml`
     - `scripts/<name>.mjs`
   - refuses the promote scripts and the scripts that set secrets;
   - refuses `.claude/`, `CLAUDE.md`, `.git`, `node_modules` and secrets, whatever the list says;
   - refuses to overwrite an existing migration, because applied migrations are never edited;
   - after a `package.json` draft, reminds you to run `npm install` and commit `package-lock.json` with it.
4. **Commit, push, wait for `check`, merge.**

Until the draft is promoted on its branch, the pull request's `check` fails at "No unpromoted drafts". That's
expected: promotion is what lets CI run the change for real.

CI fails if `main` has anything here except this README, so a draft that was never promoted can't sit unseen.

`tsconfig*.json` and `vitest.config.*` can't be drafted: the guard refuses those names anywhere. The orchestrator
changes them, on the editor's approval.
