# Recovery: the D1 database

Written by Infrastructure & Continuity in #116 (Nov. 27, 2026), from Cloudflare's documentation. **No command here has
been run against TalkHalifax yet**: the first test restore (section 3, issue #74) confirms them, and this page is fixed
wherever the real output differs. Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/. Commands:
https://developers.cloudflare.com/workers/wrangler/commands/d1/.

Who runs this: **the editor only.** Agents never touch the live database. Every `--remote` command below acts on the
live Cloudflare account. Read a command's "changes" line before you run it.

The live database is `talkhalifax`. The scratch database for tests is `th-restore-test`. The two names are
deliberately unalike, so check the name in every command twice. A typo between them is the worst mistake this page
allows.

## What can and can't be restored

- **D1 (stories, users, sessions, comments, leads, reports, push subscriptions, stats, the `message_index` copy of
  chat text):** Time Travel can restore the whole database to any minute in the last 30 days (Workers Paid) or 7 days
  (Workers Free). Always on, free. https://developers.cloudflare.com/d1/reference/time-travel/
- **Live chat rooms (Durable Objects):** not covered. No restore exists today. Chat text is still in D1's
  `message_index`.
- **StatsHub:** nothing to restore. It loses at most about 10 minutes of counts.
- **Secrets, Cloudflare settings, GitHub settings, routines:** not part of this. Set them again by hand.
- **Push alerts and Telegram messages already sent:** can't be undone.
- A restore is **whole-database**: there's no single table or row. Everything written after the restore point is lost,
  including bans, purges and account deletions, which must be redone by hand.

## 1. Look at the live database's Time Travel state (read-only)

```
npx wrangler d1 time-travel info talkhalifax
```

- **Does:** prints the current bookmark and the restore command that would use it.
- **Changes:** nothing. Cloudflare's docs describe it as retrieving a bookmark; it doesn't restore.
- **Check:** a bookmark like `00000085-0000024c-...` prints. Also check the plan (dashboard, Workers & Pages, Plans):
  Free gives 7 days of history, Paid gives 30. Write down which.

For a past moment, add `--timestamp=2026-11-27T15:00:00Z` (RFC3339, UTC) or Unix seconds.

## 2. Take a bookmark before any risky change

Before merging a pull request with a migration, a bulk edit, or a purge across many accounts:

```
npx wrangler d1 time-travel info talkhalifax
```

- **Changes:** nothing.
- **Write down** the UTC time and the bookmark in a comment on the pull request (or, for a change with no pull
  request, on a new issue titled "Restore bookmark <date>"). A bookmark is not a secret, but never paste anything else from
  the terminal with it.
- If you forgot, the time is enough: any minute in the window can be restored with `--timestamp`. Use the start time
  of the deploy run in GitHub Actions, minus a minute.

## 3. Test restore (scratch database only, never the live one)

Time Travel can only restore a database **in place**. It can't copy the live database into another one. So the test
has two parts: copy the live data into a scratch database with an export and import, then practise a real Time Travel
restore **on the scratch database**.

Do it at a quiet hour, away from :00, :05 and :30 (cron and journalist runs). **The export in step 3.2 blocks the live
database while it runs**, so the site pauses for that long.

**3.1 Create the scratch database**
```
npx wrangler d1 create th-restore-test
```
- **Changes:** creates a new, empty database on the account. Live is untouched. Don't use `--update-config`, so
  `wrangler.jsonc` stays as it is. If wrangler offers to add it to the config, say no.
- **Check:** `npx wrangler d1 list` shows `th-restore-test`.

**3.2 Export the live database to a file outside the repo**
```
npx wrangler d1 export talkhalifax --remote --output=C:\restore-test\talkhalifax.sql
```
- **Changes:** nothing in the data, but it **blocks live requests while it runs**.
- **The file is sensitive:** emails and password hashes. Since #122 (Nov. 27, 2026) sessions are stored only as
  hashes, but sessions from before that stay as **live session tokens** until they're next used or expire, by Dec. 27,
  2026 (#123). Keep the file outside the repo folder, never commit, upload or paste it, and delete it at the end.
- **Check:** the file exists and opens with `CREATE TABLE` lines. Note the time it took: that's how long a weekly
  export would pause the site. If wrangler refuses because of virtual tables, stop and report it.

**3.3 Import into the scratch database**
- If the file has `BEGIN TRANSACTION;` and `COMMIT;` lines, delete them. If the import fails on a foreign key, add
  `PRAGMA defer_foreign_keys = true;` as the first line.
```
npx wrangler d1 execute th-restore-test --remote --file=C:\restore-test\talkhalifax.sql
```
- **Changes:** writes into `th-restore-test` only. Before pressing Enter, check that the name is **`th-restore-test`**.
- **Check (compare each with the same query on live, which is read-only):**
```
npx wrangler d1 execute th-restore-test --remote --command "SELECT COUNT(*) FROM stories"
npx wrangler d1 execute th-restore-test --remote --command "SELECT COUNT(*) FROM users"
npx wrangler d1 execute th-restore-test --remote --command "SELECT id, headline FROM stories ORDER BY rowid DESC LIMIT 3"
npx wrangler d1 execute th-restore-test --remote --command "SELECT name FROM d1_migrations ORDER BY id"
```
  The counts should match live, or be a few rows lower if something was written since the export. The last query
  shows whether the export carried the migrations table. Write down which.

**3.4 Practise a Time Travel restore on the scratch database**
```
npx wrangler d1 time-travel info th-restore-test
```
  Write down the bookmark (call it B1), then wait 2 minutes. Then make a harmless change in the scratch database
  only:
```
npx wrangler d1 execute th-restore-test --remote --command "DELETE FROM stories"
npx wrangler d1 execute th-restore-test --remote --command "SELECT COUNT(*) FROM stories"
```
  This should show 0. Now restore:
```
npx wrangler d1 time-travel restore th-restore-test --bookmark=<B1>
```
- **Changes:** overwrites **all** of `th-restore-test` with its state at B1. It asks for confirmation: **read the
  database name in the prompt before saying yes.** It prints a new bookmark that undoes this restore. Write it down
  (B2).
- **Check:** `SELECT COUNT(*) FROM stories` on `th-restore-test` is back to the 3.3 number. Note how long the restore
  took.
- Optional: test the undo with `--bookmark=<B2>`. The count should go back to 0.

**3.5 Clean up**
```
npx wrangler d1 delete th-restore-test
```
- **Changes:** deletes the scratch database for good. Check the name: **`th-restore-test`**.
- Delete `C:\restore-test\talkhalifax.sql` and empty the recycle bin.
- **Check:** `npx wrangler d1 list` shows only `talkhalifax`, and `git status` in the repo is clean.

## 4. The real restore (live)

### Decide first

- **A. Fix forward, don't restore,** when the damage is small and known: a few rows wrong or missing that a query or
  a new migration can put right, or anything whose loss costs less than losing every write since the restore point.
  This is the default.
- **B. Restore** when data is lost or corrupted widely (a bulk delete, a bad bulk edit) and there's no other copy.
  Before choosing B, count what B loses: everything written since the bookmark (sign-ups, comments, stories,
  moderation).
- **C. Restore, copy out, restore forward** (the safest way to get rows back): restore to the bookmark, export just the
  tables you need (`wrangler d1 export talkhalifax --remote --table=<table> --output=...`), then restore forward with
  the bookmark the first restore printed. The site ends up where it was, with lost rows that you re-insert through a
  reviewed change. It still loses any write made **between** the two restores, and the site errors briefly twice.
- **D. A migration that already ran.** Restoring to before it **un-applies** it, and the next push to `main` runs it
  again. If the migration destroyed data, don't do a plain B: use C to get the data back with the migration still
  applied. If the migration must really be undone, that needs a change request (the migration file can't be edited
  once applied), so stop and raise it.
- **E. Code that expects a newer schema.** Restoring to before a migration leaves the live code querying tables or
  columns that are gone, and those pages and features fail until the migration runs again (next deploy, or re-run the
  Deploy workflow on `main`). Rolling the Worker back to match is a last resort, and **never past `f05802c`**: the
  admin site depends on it.

### Do it

1. Tell readers, if you can. There's no maintenance mode. Pick a quiet minute away from :00, :05 and :30.
2. Record where you are now (the undo point):
   `npx wrangler d1 time-travel info talkhalifax`. Changes nothing. Write the bookmark down.
3. Find the target: the bookmark from step 2 of the risky change, or
   `npx wrangler d1 time-travel info talkhalifax --timestamp=<UTC time just before the damage>`. Changes nothing.
4. Restore:
   `npx wrangler d1 time-travel restore talkhalifax --bookmark=<target>`
   - **Changes everything:** the whole live database goes back to the target. Queries in flight are cancelled and
     return errors, so readers see failed loads, failed sign-ins and failed chat sends for the duration. Write down
     the bookmark it prints: that's the undo.
5. Check:
   - the site loads, `/api/stories` lists stories, and you can sign in (your session may be gone, so sign in again);
   - the damaged rows are back (count the table that was hit);
   - `SELECT name FROM d1_migrations ORDER BY id` matches the migrations folder. If not, see E.
6. Redo what the restore undid since the target: bans, purges and **account deletions** (a deleted account is back,
   with its name and email, until it's deleted again), and stories the newsroom published (it will re-file leads).
7. If it went wrong: `npx wrangler d1 time-travel restore talkhalifax --bookmark=<undo bookmark from step 4>`.
8. Write down what happened in an issue: times, bookmarks, what was lost and what was redone.

Limits: 10 restores per 10 minutes per database. Durable Object chat isn't touched by any of this.
