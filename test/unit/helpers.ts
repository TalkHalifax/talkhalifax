import { env as workerEnv } from "cloudflare:workers";
import { vi } from "vitest";
import type { Env, User } from "../../src/env";
import { saveStory } from "../../src/stories";

/** The test Worker's bindings: no Telegram (nothing is held for approval) and no Workers AI. */
export const env = workerEnv as unknown as Env;

export const HOUR = 36e5, DAY = 24 * HOUR;
export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, "Z");

/** The same bindings with the editor's Telegram set up, which turns approvals on. Telegram itself is stubbed. */
export function withTelegram(): Env {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const to = String(url instanceof Request ? url.url : url);
    if (!to.includes("api.telegram.org")) throw new Error(`Unexpected request to ${to}`);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  });
  return { ...env, TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: "1" } as Env;
}

export const storyInput = (over: Record<string, unknown> = {}) => ({
  kind: "article", section: "City Hall", area: "Halifax", headline: "A headline", dek: "A dek", facts: [], body: ["A sentence."], means: [],
  source: "https://www.halifax.ca/home/news/example", publishedAt: iso(), ...over,
});

/** A published story (made while approvals are off), with any columns set directly, for example to age it. */
export async function makeStory(id: string, over: Record<string, unknown> = {}, cols: Record<string, unknown> = {}) {
  await saveStory(env, id, storyInput(over), { mode: "create", author: "test" });
  const names = Object.keys(cols);
  if (names.length) await env.DB.prepare(`UPDATE stories SET ${names.map(n => `${n} = ?`).join(", ")} WHERE id = ?`).bind(...Object.values(cols), id).run();
}

export const storyRow = (id: string) => env.DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first<Record<string, any>>();

export async function makeUser(id: string, over: Partial<User> & { provider_sub?: string } = {}): Promise<User> {
  const u = { id, name: id, avatar_url: "", email: "", role: "member", banned: 0, provider: "password", created_at: Date.now() - 30 * DAY, ...over } as User;
  await env.DB.prepare("INSERT INTO users (id, provider, provider_sub, name, role, banned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, u.provider, over.provider_sub ?? id, u.name, u.role, u.banned, u.created_at).run();
  return u;
}

/** Sets the columns the admin data must never return. */
export async function setPrivate(id: string, cols: { email: string; password_hash: string; persona: string }) {
  await env.DB.prepare("UPDATE users SET email = ?, password_hash = ?, persona = ? WHERE id = ?").bind(cols.email, cols.password_hash, cols.persona, id).run();
}

/** What seedAdminData puts in the columns no admin view may show. */
export const ADMIN_SECRETS = {
  pw: { email: "nora.private@example.test", password_hash: "pbkdf2$hash-value-nora", persona: "secret persona nora" },
  google: { email: "gia.private@example.test", password_hash: "pbkdf2$hash-value-gia", persona: "secret persona gia" },
  newsroom: { email: "desk.private@example.test", password_hash: "pbkdf2$hash-value-desk", persona: "secret persona desk" },
  googleSub: "google-sub-123",
};

/**
 * A newsroom for the admin views, timed against `now`: password, Google, newsroom, deleted, banned and moderator accounts;
 * messages and reports; online samples; story traffic; stories in every stage and kind; an events feed; the weather and
 * alerts feeds; cron-health and github-jobs.
 */
export async function seedAdminData(now: number) {
  const at = (msAgo: number) => new Date(now - msAgo).toISOString().replace(/\.\d+Z$/, "Z");
  // Accounts, each joining at a different time so the list's order is fixed
  await makeUser("u_pw", { provider_sub: "harbourview", name: "Nora Harbour", created_at: now - 2 * HOUR });
  await makeUser("u_goog", { provider: "google", provider_sub: ADMIN_SECRETS.googleSub, name: "Gia Google", created_at: now - 3 * DAY });
  await makeUser("u_desk", { provider: "newsroom", provider_sub: "journalist", name: "The Desk", role: "journalist" as never, created_at: now - 50 * DAY });
  await makeUser("u_gone", { provider: "deleted", provider_sub: "gone", name: "Deleted account", created_at: now - 5 * HOUR });
  await makeUser("u_ban", { provider_sub: "trouble", name: "Banned Bob", banned: 1, created_at: now - 10 * DAY });
  await makeUser("u_mod", { provider_sub: "modmary", name: "Mary Mod", role: "moderator", created_at: now - 40 * DAY });
  await makeUser("u_pct", { provider_sub: "percent", name: "Pat 100% local", created_at: now - 6 * DAY });
  await makeUser("u_us", { provider_sub: "under", name: "a_b", created_at: now - 7 * DAY });
  await makeUser("u_ux", { provider_sub: "notunder", name: "axb", created_at: now - 8 * DAY });
  await makeUser("u_old", { provider_sub: "oldtimer", name: "Old Timer", created_at: now - 35 * DAY });
  await setPrivate("u_pw", ADMIN_SECRETS.pw);
  await setPrivate("u_goog", ADMIN_SECRETS.google);
  await setPrivate("u_desk", ADMIN_SECRETS.newsroom);

  // Stories in every stage and kind
  await makeStory("a-dev", { headline: "Harbour bridge closes for paving", source: "https://www.halifax.ca/home/news/bridge", publishedAt: at(3 * HOUR) }, { updated_at: at(1 * HOUR), version: 2 });
  await makeStory("a-arch", { headline: "Council approves budget", source: "https://news.novascotia.ca/en/budget", publishedAt: at(9 * DAY) }, { stage: "archived", updated_at: at(8 * DAY) });
  await makeStory("a-draft", { headline: "Draft about a ferry", publishedAt: at(1 * HOUR) }, { stage: "draft", updated_at: at(30 * 60_000) });
  await makeStory("a-gone", { headline: "Discarded story" }, { stage: "discarded", updated_at: at(2 * HOUR) });
  await makeStory("n-dev", { kind: "notice", headline: "Boil water advisory", source: "https://www.halifaxwater.ca/notice", publishedAt: at(4 * HOUR) }, { status_label: "Final update", updated_at: at(3 * HOUR) });
  await makeStory("n-arch", { kind: "notice", headline: "Old road closure", source: "https://www.rcmp.ca/en/old", publishedAt: at(20 * DAY) }, { stage: "archived", updated_at: at(19 * DAY) });
  await makeStory("s-skip", { kind: "skip", headline: "Skipped release", source: "https://example.test/skip" }, { updated_at: at(10 * 60_000) });
  await makeStory("a-bad-src", { headline: "Story with an odd source", source: "not a url", publishedAt: at(2 * DAY) }, { stage: "archived", updated_at: at(2 * DAY) });

  const hour = Math.floor(now / HOUR);
  await env.DB.batch([
    // Messages: recent, older and deleted
    env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m1', 'a-dev', 'u_pw', 'hello', ?)").bind(now - HOUR),
    env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m2', 'a-dev', 'u_pw', 'again', ?)").bind(now - 3 * HOUR),
    env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m3', 'a-dev', 'u_goog', 'hi', ?)").bind(now - 2 * DAY),
    env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at, deleted) VALUES ('m4', 'a-dev', 'u_ban', 'gone', ?, 1)").bind(now - HOUR),
    env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m5', 'a-dev', 'u_ban', 'old', ?)").bind(now - 20 * DAY),
    // Reports: two open on one message, one handled
    env.DB.prepare("INSERT INTO reports (id, kind, target_id, story_id, author_id, text, reporter_id, created_at) VALUES ('r1', 'message', 'm5', 'a-dev', 'u_ban', 'old', 'u_pw', ?)").bind(now - DAY),
    env.DB.prepare("INSERT INTO reports (id, kind, target_id, story_id, author_id, text, reporter_id, created_at) VALUES ('r2', 'message', 'm5', 'a-dev', 'u_ban', 'old', 'u_goog', ?)").bind(now - DAY),
    env.DB.prepare("INSERT INTO reports (id, kind, target_id, story_id, author_id, text, reporter_id, created_at, resolved) VALUES ('r3', 'message', 'm1', 'a-dev', 'u_pw', 'hello', 'u_goog', ?, 'dismissed')").bind(now - DAY),
    env.DB.prepare("INSERT INTO pending_updates (story_id, input, status, created_at) VALUES ('a-dev', '{}', 'waiting', ?)").bind(now - HOUR),
    env.DB.prepare("INSERT INTO pending_updates (story_id, input, status, created_at) VALUES ('a-dev', '{}', 'approved', ?)").bind(now - 2 * HOUR),
    env.DB.prepare("INSERT INTO room_stats (story_id, message_count, here_now, updated_at) VALUES ('a-dev', 3, 4, ?)").bind(now),
    env.DB.prepare("INSERT INTO room_stats (story_id, message_count, here_now, updated_at) VALUES ('a-arch', 7, 2, ?)").bind(now),
    // People online: a peak, a fresh sample, and older days
    env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 4)").bind(now - HOUR),
    env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 9)").bind(now - HOUR + 5 * 60_000),
    env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 6)").bind(now - 2 * 60_000),
    env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 3)").bind(now - 3 * DAY),
    env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 2)").bind(now - 20 * DAY),
    // Traffic: this hour, last hour, days ago, and older than 30 days
    env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'a-dev', 5, 2)").bind(hour),
    env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'a-dev', 3, 1)").bind(hour - 1),
    env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'n-dev', 11, 4)").bind(hour - 50),
    env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'a-arch', 20, 6)").bind(hour - 10 * 24),
    env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'a-arch', 100, 100)").bind(hour - 31 * 24),
    // Feeds: events (upcoming, finished, cancelled, a non-https link), weather fresh, alerts stale, and the cron's records
    env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('events', ?, ?)").bind(JSON.stringify({ events: [
      { id: "e1", title: "Story time at the harbour", url: "https://example.test/e1", start: new Date(now + DAY).toISOString(), end: new Date(now + DAY + HOUR).toISOString() },
      { id: "e2", title: "Finished event", url: "https://example.test/e2", start: new Date(now - DAY).toISOString(), end: new Date(now - DAY + HOUR).toISOString() },
      { id: "e3", title: "Cancelled chess club", url: "https://example.test/e3", start: new Date(now + 2 * DAY).toISOString(), end: "", cancelled: true },
      { id: "e4", title: "Odd link event", url: "javascript:alert(1)", start: new Date(now + 3 * DAY).toISOString(), end: new Date(now + 3 * DAY + HOUR).toISOString() },
    ] }), at(3 * HOUR)),
    env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('weather', '{}', ?)").bind(at(20 * 60_000)),
    env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('alerts', '{}', ?)").bind(at(5 * HOUR)),
    env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('cron-health', ?, ?)").bind(JSON.stringify({ weather: 2, stages: 0, "clean-up": 1 }), at(10 * 60_000)),
    env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('github-jobs', ?, ?)").bind(JSON.stringify({ "events.yml": now - HOUR, "transit.yml": now - 9 * DAY }), at(HOUR)),
  ]);
}
