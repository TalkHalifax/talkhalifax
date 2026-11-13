// The admin site's data, read-only, for the admin Worker to call over a service binding (admin split, phase 1).
// It has no address of its own: AdminApi is reachable only as a named entrypoint, never through fetch.
// The queries are the admin Worker's (admin/src/index.ts), unchanged. They never return email addresses, password hashes,
// the journalist's private persona, or Google account ids.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Env, SITE } from "../env";
import { CRON_JOBS } from "./cron-jobs";

const TZ = "America/Halifax", HOUR_MS = 36e5, DAY_MS = 864e5;
const ONLINE_FRESH_MS = 10 * 60_000, PAGE_SIZE = 100, MAX_ITEMS = 500;

// ---------- the types callers see ----------

export type Range = "24h" | "7d" | "30d";
export type UserRole = "all" | "member" | "moderator" | "journalist" | "banned";
export type ContentScreen = "all" | "Developing" | "Articles" | "Notices" | "Events";
export type ContentStatus = "all" | "waiting" | "active" | "archived";

/** Users, after checking: q is trimmed, lowercased and at most 60 characters. */
export interface UsersArgs { q: string; role: UserRole; offset: number }
/** Content, after checking: q is trimmed, lowercased and at most 100 characters. */
export interface ContentArgs { screen: ContentScreen; status: ContentStatus; q: string }

export interface Job { name: string; does: string; every: string; lastAt: number | null; state: "ok" | "late" | "failing"; failures: number }
export interface JobsList { jobs: Job[] }

export interface Summary {
  members: number; newThisWeek: number; postedThisWeek: number; banned: number; openReports: number; drafts: number;
  pendingUpdates: number; developing: number; notices: number; articles: number; inRooms: number;
  events: number; jobs: Job[];
}

export interface Overview {
  range: Range;
  labels: string[];
  series: { online: number[]; signups: number[]; messages: number[]; impressions: number[]; clicks: number[] };
  onlineNow: number;
  countingSince: number | null;
}

export interface UserRow {
  id: string; name: string; username: string | null; role: string; banned: number; joined: number;
  messages: number; lastPost: number | null; openReports: number;
}
export interface UsersPage { users: UserRow[]; total: number; pageSize: number }

export interface ContentItem {
  id: string; title: string; screen: string; status: string; label: string; source: string; updatedAt: string | null;
  version: number | null; messages: number | null; impressions: number | null; clicks: number | null; url: string | null;
}
export interface ContentPage { items: ContentItem[]; total: number; limit: number }

export interface DataSources {
  feeds: { name: string; shows: string; lastAt: number | null; state: "missing" | "late" | "ok" }[];
  sources: { name: string; stories: number; last: string }[];
}

// ---------- time buckets ----------

const RANGES: Range[] = ["24h", "7d", "30d"];
const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });

function halifax(ms: number) {
  const p: Record<string, string> = {};
  for (const x of parts.formatToParts(ms)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, month: +p.month, date: +p.day, hour: +p.hour % 24 };
}

/** The labels for a chart, and which label each hour belongs to. Days are Halifax days, so the clocks changing is handled. */
export function buckets(range: Range, now: number) {
  const nowHour = Math.floor(now / HOUR_MS), labels: string[] = [], index = new Map<number, number>();
  if (range === "24h") {
    for (let i = 0; i < 24; i++) {
      const h = nowHour - 23 + i, t = halifax(h * HOUR_MS);
      labels.push(`${t.hour % 12 || 12} ${t.hour < 12 ? "am" : "pm"}`);
      index.set(h, i);
    }
    return { labels, index, fromHour: nowHour - 23 };
  }
  const days = range === "7d" ? 7 : 30, keys: string[] = [], hoursByDay = new Map<string, number[]>();
  for (let h = nowHour - (days + 1) * 24; h <= nowHour; h++) {
    const t = halifax(h * HOUR_MS);
    if (!hoursByDay.has(t.day)) { hoursByDay.set(t.day, []); keys.push(t.day); }
    hoursByDay.get(t.day)!.push(h);
  }
  const kept = keys.slice(-days);
  kept.forEach((k, i) => {
    const hours = hoursByDay.get(k)!;
    const t = halifax(hours[0] * HOUR_MS);
    labels.push(`${MONTHS[t.month - 1]} ${t.date}`);
    for (const h of hours) index.set(h, i);
  });
  return { labels, index, fromHour: hoursByDay.get(kept[0])![0] };
}

function fill(n: number, index: Map<number, number>, rows: { h: number; n: number }[], how: "sum" | "max") {
  const out = new Array<number>(n).fill(0);
  for (const r of rows) {
    const i = index.get(r.h);
    if (i !== undefined) out[i] = how === "sum" ? out[i] + r.n : Math.max(out[i], r.n);
  }
  return out;
}

// ---------- the queries, as the admin site's endpoints run them ----------

/** /api/overview */
export async function overviewData(env: Env, range: Range, now: number): Promise<Overview> {
  const { labels, index, fromHour } = buckets(range, now);
  const fromMs = fromHour * HOUR_MS;
  type Hourly = { h: number; n: number };
  const [signups, messages, online, traffic, latest, since] = await env.DB.batch([
    env.DB.prepare("SELECT created_at / 3600000 AS h, COUNT(*) AS n FROM users WHERE created_at >= ? AND provider NOT IN ('newsroom', 'deleted') GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT created_at / 3600000 AS h, COUNT(*) AS n FROM message_index WHERE created_at >= ? AND deleted = 0 GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT at / 3600000 AS h, MAX(online) AS n FROM online_samples WHERE at >= ? GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT hour AS h, SUM(impressions) AS i, SUM(clicks) AS c FROM story_traffic WHERE hour >= ? GROUP BY hour").bind(fromHour),
    env.DB.prepare("SELECT at, online FROM online_samples ORDER BY at DESC LIMIT 1"),
    env.DB.prepare("SELECT MIN(at) AS at FROM online_samples"),
  ]);
  const t = traffic.results as { h: number; i: number; c: number }[];
  const newest = latest.results[0] as { at: number; online: number } | undefined;
  return {
    range, labels,
    series: {
      online: fill(labels.length, index, online.results as Hourly[], "max"),
      signups: fill(labels.length, index, signups.results as Hourly[], "sum"),
      messages: fill(labels.length, index, messages.results as Hourly[], "sum"),
      impressions: fill(labels.length, index, t.map(r => ({ h: r.h, n: r.i })), "sum"),
      clicks: fill(labels.length, index, t.map(r => ({ h: r.h, n: r.c })), "sum"),
    },
    onlineNow: newest && now - newest.at < ONLINE_FRESH_MS ? newest.online : 0,
    countingSince: (since.results[0] as { at: number | null } | undefined)?.at ?? null,
  };
}

/** /api/summary */
export async function summaryData(env: Env, _args: undefined, now: number): Promise<Summary> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE provider NOT IN ('newsroom', 'deleted')) AS members,
            (SELECT COUNT(*) FROM users WHERE provider NOT IN ('newsroom', 'deleted') AND created_at >= ?1) AS newThisWeek,
            (SELECT COUNT(DISTINCT user_id) FROM message_index WHERE created_at >= ?1 AND deleted = 0) AS postedThisWeek,
            (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
            (SELECT COUNT(*) FROM reports WHERE resolved IS NULL) AS openReports,
            (SELECT COUNT(*) FROM stories WHERE stage = 'draft') AS drafts,
            (SELECT COUNT(*) FROM pending_updates WHERE status = 'waiting') AS pendingUpdates,
            (SELECT COUNT(*) FROM stories WHERE stage = 'developing' AND kind = 'article') AS developing,
            (SELECT COUNT(*) FROM stories WHERE stage = 'developing' AND kind = 'notice') AS notices,
            (SELECT COUNT(*) FROM stories WHERE stage = 'archived' AND kind = 'article') AS articles,
            (SELECT COALESCE(SUM(rs.here_now), 0) FROM room_stats rs JOIN stories s ON s.id = rs.story_id WHERE s.stage = 'developing' AND s.kind = 'article') AS inRooms`,
  ).bind(now - 7 * DAY_MS).first<Record<string, number>>();
  return { ...row, events: (await upcomingEvents(env, now)).length, jobs: await jobList(env, now) } as Summary;
}

interface EventRow { id: string; title: string; url: string; start: string; end: string; cancelled?: boolean }
async function eventFeed(env: Env) {
  const row = await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'events'").first<{ body: string; updated_at: string }>();
  return row ? { events: (JSON.parse(row.body) as { events: EventRow[] }).events, updatedAt: row.updated_at } : { events: [] as EventRow[], updatedAt: null };
}
const upcomingEvents = async (env: Env, now: number) => (await eventFeed(env)).events.filter(e => Date.parse(e.end || e.start) > now);

/** /api/users. Wildcards in q are escaped, so they match only themselves. */
export async function usersData(env: Env, args: UsersArgs, _now: number): Promise<UsersPage> {
  const { q, role, offset } = args;
  const where = ["u.provider != 'deleted'"], binds: unknown[] = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(LOWER(u.name) LIKE ? ESCAPE '\\' OR (u.provider = 'password' AND LOWER(u.provider_sub) LIKE ? ESCAPE '\\'))");
    binds.push(like, like);
  }
  if (role === "banned") where.push("u.banned = 1");
  else if (["member", "moderator", "journalist"].includes(role)) { where.push("u.role = ?"); binds.push(role); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.name, CASE WHEN u.provider = 'password' THEN u.provider_sub END AS username, u.role, u.banned, u.created_at AS joined,
              (SELECT COUNT(*) FROM message_index m WHERE m.user_id = u.id AND m.deleted = 0) AS messages,
              (SELECT MAX(m.created_at) FROM message_index m WHERE m.user_id = u.id AND m.deleted = 0) AS lastPost,
              (SELECT COUNT(DISTINCT r.target_id) FROM reports r WHERE r.author_id = u.id AND r.resolved IS NULL) AS openReports
         FROM users u ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, PAGE_SIZE, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).bind(...binds),
  ]);
  return { users: rows.results as unknown as UserRow[], total: (total.results[0] as { n: number }).n, pageSize: PAGE_SIZE };
}

/** Which screen a story is on, as readers see it. */
export function screenOf(kind: string, stage: string) {
  if (kind === "notice") return "Notices";
  return stage === "archived" ? "Articles" : "Developing";
}
const statusOf = (stage: string) => stage === "draft" ? "waiting" : stage === "archived" ? "archived" : "active";
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** /api/content */
export async function contentData(env: Env, args: ContentArgs, now: number): Promise<ContentPage> {
  const { screen, status, q } = args;
  const fromHour = Math.floor((now - 30 * DAY_MS) / HOUR_MS);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.kind, s.stage, s.headline, s.source_url, s.updated_at, s.version, s.status_label,
            COALESCE(rs.message_count, 0) AS messages,
            COALESCE(t.impressions, 0) AS impressions, COALESCE(t.clicks, 0) AS clicks
       FROM stories s
       LEFT JOIN room_stats rs ON rs.story_id = s.id
       LEFT JOIN (SELECT story_id, SUM(impressions) AS impressions, SUM(clicks) AS clicks FROM story_traffic WHERE hour >= ? GROUP BY story_id) t ON t.story_id = s.id
      WHERE s.stage IN ('draft', 'developing', 'archived') AND s.kind != 'skip'
      ORDER BY s.updated_at DESC LIMIT ?`,
  ).bind(fromHour, MAX_ITEMS).all<{ id: string; kind: string; stage: string; headline: string; source_url: string; updated_at: string; version: number; status_label: string; messages: number; impressions: number; clicks: number }>();
  const stories: ContentItem[] = rows.results.map(r => ({
    id: r.id, title: r.headline, screen: screenOf(r.kind, r.stage), status: statusOf(r.stage), label: r.status_label, source: hostOf(r.source_url),
    updatedAt: r.updated_at, version: r.version, messages: r.messages, impressions: r.impressions, clicks: r.clicks,
    url: r.stage === "draft" ? null : `${SITE}/#article-${encodeURIComponent(r.id)}`,
  }));
  const feed = await eventFeed(env);
  const events: ContentItem[] = feed.events.filter(e => Date.parse(e.end || e.start) > now).map(e => ({
    id: e.id, title: e.title, screen: "Events", status: "active", label: e.cancelled ? "Cancelled" : "", source: "Halifax Public Libraries",
    updatedAt: feed.updatedAt, version: null, messages: null, impressions: null, clicks: null, url: /^https:\/\//.test(e.url) ? e.url : null,
  }));
  const all = [...stories, ...events];
  const items = all.filter(i => (screen === "all" || i.screen === screen) && (status === "all" || i.status === status) && (!q || i.title.toLowerCase().includes(q)));
  return { items: items.slice(0, MAX_ITEMS), total: items.length, limit: MAX_ITEMS };
}

/** The jobs as /api/jobs lists them, unwrapped: the cron's own (CRON_JOBS, the list scheduled() runs), then the two it dispatches. */
async function jobList(env: Env, now: number): Promise<Job[]> {
  const rows = await env.DB.prepare("SELECT name, body, updated_at FROM feeds WHERE name IN ('cron-health', 'github-jobs')").all<{ name: string; body: string; updated_at: string }>();
  const by = new Map(rows.results.map(r => [r.name, r]));
  const health = by.get("cron-health"), fails: Record<string, number> = health ? JSON.parse(health.body) : {};
  const started: Record<string, number> = by.has("github-jobs") ? JSON.parse(by.get("github-jobs")!.body) : {};
  const lastRun = health ? Date.parse(health.updated_at) : null;
  // The cron runs every 30 minutes, so an hour of silence means it has stopped
  const cronLate = lastRun === null || now - lastRun > HOUR_MS;
  const list: Job[] = CRON_JOBS.map(j => {
    const f = fails[j.key] || 0;
    return { name: j.name, does: j.does, every: j.every, lastAt: lastRun, state: f ? "failing" : cronLate ? "late" : "ok", failures: f };
  });
  const dispatched = (file: string, name: string, does: string, every: string, limitMs: number): Job => {
    const at = started[file] ?? null;
    return { name, does, every, lastAt: at, state: at === null || now - at > limitMs ? "late" : "ok", failures: 0 };
  };
  list.push(dispatched("events.yml", "Library events", "Fetches events and posts them to the site", "6 hours", 7 * HOUR_MS));
  list.push(dispatched("transit.yml", "Transit schedule", "Rebuilds the map's data for a new schedule", "7 days", 8 * DAY_MS));
  return list;
}

/** /api/jobs */
export async function jobsData(env: Env, _args: undefined, now: number): Promise<JobsList> {
  return { jobs: await jobList(env, now) };
}

const SOURCE_NAMES: Record<string, string> = {
  "halifax.ca": "halifax.ca", "halifaxwater.ca": "Halifax Water", "news.novascotia.ca": "Province of Nova Scotia", "novascotia.ca": "Province of Nova Scotia",
  "rcmp.ca": "RCMP", "rcmp-grc.gc.ca": "RCMP", "weather.gc.ca": "Environment Canada",
};

/** /api/data */
export async function dataSourcesData(env: Env, _args: undefined, now: number): Promise<DataSources> {
  const [stories, feeds] = await env.DB.batch([
    env.DB.prepare("SELECT source_url, published_at FROM stories WHERE stage IN ('developing', 'archived') AND kind != 'skip'"),
    env.DB.prepare("SELECT name, updated_at FROM feeds WHERE name IN ('weather', 'alerts', 'events')"),
  ]);
  const hosts = new Map<string, { name: string; stories: number; last: string }>();
  for (const r of stories.results as { source_url: string; published_at: string }[]) {
    const host = hostOf(r.source_url);
    if (!host) continue;
    const name = SOURCE_NAMES[host] || host;
    const h = hosts.get(name) || { name, stories: 0, last: "" };
    h.stories++;
    if (r.published_at > h.last) h.last = r.published_at;
    hosts.set(name, h);
  }
  const feed = (key: string, name: string, shows: string, staleAfter: number): DataSources["feeds"][number] => {
    const row = (feeds.results as { name: string; updated_at: string }[]).find(f => f.name === key);
    const at = row ? Date.parse(row.updated_at) : null;
    return { name, shows, lastAt: at, state: at === null ? "missing" : now - at > staleAfter ? "late" : "ok" };
  };
  return {
    feeds: [
      feed("weather", "Environment Canada, conditions", "Weather line", 2 * HOUR_MS),
      feed("alerts", "Environment Canada, warnings", "Banners and Notices", 2 * HOUR_MS),
      feed("events", "Halifax Public Libraries", "Events", 26 * HOUR_MS),
    ],
    sources: [...hosts.values()].sort((a, b) => b.last.localeCompare(a.last)),
  };
}

// ---------- checking what callers send ----------

const ROLES: UserRole[] = ["all", "member", "moderator", "journalist", "banned"];
const SCREENS: ContentScreen[] = ["all", "Developing", "Articles", "Notices", "Events"];
const STATUSES: ContentStatus[] = ["all", "waiting", "active", "archived"];

/** The range, or the admin site's fallback of 7 days for anything else. */
export const overviewRange = (range: unknown): Range => RANGES.includes(range as Range) ? range as Range : "7d";

/** undefined, or an object literal (not null, an array, or anything with its own prototype). */
function argsObject(args: unknown): Record<string, unknown> | null {
  if (args === undefined) return {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const proto = Object.getPrototypeOf(args);
  return proto === Object.prototype || proto === null ? args as Record<string, unknown> : null;
}

/** A search: "" when missing, otherwise a string, trimmed, lowercased and cut to max. null for anything else. */
const searchText = (q: unknown, max: number) => q === undefined ? "" : typeof q === "string" ? q.trim().toLowerCase().slice(0, max) : null;
/** One of the allowed values, the first ("all") when missing, null for anything else. */
const oneOf = <T extends string>(x: unknown, allowed: T[]): T | null => x === undefined ? allowed[0] : typeof x === "string" && (allowed as string[]).includes(x) ? x as T : null;

/** The furthest a users page may start: far past any real member count, but it stops a caller asking D1 to skip billions of rows. */
const MAX_OFFSET = 100_000;

/** The users arguments checked, or null to refuse. */
export function usersArgs(args: unknown): UsersArgs | null {
  const a = argsObject(args);
  if (!a) return null;
  const q = searchText(a.q, 60), role = oneOf(a.role, ROLES);
  const offset = a.offset === undefined ? 0 : typeof a.offset === "number" && Number.isSafeInteger(a.offset) && a.offset >= 0 && a.offset <= MAX_OFFSET ? a.offset : null;
  return q === null || role === null || offset === null ? null : { q, role, offset };
}

/** The content arguments checked, or null to refuse. */
export function contentArgs(args: unknown): ContentArgs | null {
  const a = argsObject(args);
  if (!a) return null;
  const screen = oneOf(a.screen, SCREENS), status = oneOf(a.status, STATUSES), q = searchText(a.q, 100);
  return screen === null || status === null || q === null ? null : { screen, status, q };
}

/** Runs a query. Any failure is logged here and reaches the caller only as "Something went wrong": no SQL, tables or input. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    console.error(e);
    throw new Error("Something went wrong");
  }
}

const refused = () => new Error("Bad request");

/**
 * The admin site's read-only data, as a named entrypoint for a service binding. Every method on the prototype can be called
 * over RPC, so it has exactly these six and nothing else: no fetch, getters, fields or helpers.
 */
export class AdminApi extends WorkerEntrypoint<Env> {
  async summary(): Promise<Summary> {
    return guarded(() => summaryData(this.env, undefined, Date.now()));
  }

  async overview(range?: unknown): Promise<Overview> {
    const r = overviewRange(range);
    return guarded(() => overviewData(this.env, r, Date.now()));
  }

  async users(args?: unknown): Promise<UsersPage> {
    const a = usersArgs(args);
    if (!a) throw refused();
    return guarded(() => usersData(this.env, a, Date.now()));
  }

  async content(args?: unknown): Promise<ContentPage> {
    const a = contentArgs(args);
    if (!a) throw refused();
    return guarded(() => contentData(this.env, a, Date.now()));
  }

  async dataSources(): Promise<DataSources> {
    return guarded(() => dataSourcesData(this.env, undefined, Date.now()));
  }

  async jobs(): Promise<JobsList> {
    return guarded(() => jobsData(this.env, undefined, Date.now()));
  }
}
