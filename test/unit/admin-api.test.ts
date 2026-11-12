import { createExecutionContext } from "cloudflare:test";
import { WorkerEntrypoint } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker, { AdminApi as ExportedAdminApi } from "../../src/index";
import {
  AdminApi, contentArgs, contentData, dataSourcesData, jobsData, overviewData, summaryData, usersArgs, usersData,
} from "../../src/routes/admin-api";
import { CRON_JOBS } from "../../src/routes/cron-jobs";
import { ADMIN_SECRETS, env, HOUR, seedAdminData } from "./helpers";

// 8 a.m. in Halifax, mid-hour, so nothing here sits on an hour's edge
const NOW = Date.UTC(2026, 10, 7, 12, 30);

// ---------- what the data functions give for seedAdminData(NOW) ----------
// Recorded from the code when it still matched the admin site's endpoints row for row (PC-6), so a change here is a change
// to what the admin site shows. Times are milliseconds or ISO strings, all counted back from NOW.

/** The job list, as both summary and jobs show it. */
const JOBS = [
  { name: "Weather", does: "Current conditions for the header", every: "30 minutes", lastAt: 1794054000000, state: "failing", failures: 2 },
  { name: "Weather warnings", does: "Environment Canada banners and notices", every: "30 minutes", lastAt: 1794054000000, state: "ok", failures: 0 },
  { name: "Events check", does: "Warns when library events stop arriving", every: "30 minutes", lastAt: 1794054000000, state: "ok", failures: 0 },
  { name: "Stages", does: "Moves Developing stories to Articles", every: "30 minutes", lastAt: 1794054000000, state: "ok", failures: 0 },
  { name: "Transit schedule check", does: "Warns before the map's schedule data runs out", every: "30 minutes", lastAt: 1794054000000, state: "ok", failures: 0 },
  { name: "GitHub jobs", does: "Starts the library events and Transit jobs", every: "30 minutes", lastAt: 1794054000000, state: "ok", failures: 0 },
  { name: "Clean-up", does: "Expired sessions, links, rate limits and old counts", every: "30 minutes", lastAt: 1794054000000, state: "failing", failures: 1 },
  { name: "Library events", does: "Fetches events and posts them to the site", every: "6 hours", lastAt: 1794051000000, state: "ok", failures: 0 },
  { name: "Transit schedule", does: "Rebuilds the map's data for a new schedule", every: "7 days", lastAt: 1793277000000, state: "late", failures: 0 },
];

const SUMMARY = {
  members: 8, newThisWeek: 4, postedThisWeek: 2, banned: 1, openReports: 2, drafts: 1, pendingUpdates: 1,
  developing: 1, notices: 1, articles: 2, inRooms: 4, events: 3, jobs: JOBS,
};

const zeros = (n: number) => Array<number>(n).fill(0);
/** n zeros with some places set, for the long, mostly empty overview series. */
const series = (n: number, set: Record<number, number>) => zeros(n).map((v, i) => set[i] ?? v);

const OVERVIEW = {
  "24h": {
    range: "24h",
    labels: ["9 am", "10 am", "11 am", "12 pm", "1 pm", "2 pm", "3 pm", "4 pm", "5 pm", "6 pm", "7 pm", "8 pm",
      "9 pm", "10 pm", "11 pm", "12 am", "1 am", "2 am", "3 am", "4 am", "5 am", "6 am", "7 am", "8 am"],
    series: {
      online: series(24, { 22: 9, 23: 6 }),
      signups: series(24, { 21: 1 }),
      messages: series(24, { 20: 1, 22: 1 }),
      impressions: series(24, { 22: 3, 23: 5 }),
      clicks: series(24, { 22: 1, 23: 2 }),
    },
    onlineNow: 6, countingSince: 1792326600000,
  },
  "7d": {
    range: "7d",
    labels: ["Nov. 1", "Nov. 2", "Nov. 3", "Nov. 4", "Nov. 5", "Nov. 6", "Nov. 7"],
    series: {
      online: [0, 0, 0, 3, 0, 0, 9],
      signups: [1, 0, 0, 1, 0, 0, 1],
      messages: [0, 0, 0, 0, 1, 0, 2],
      impressions: [0, 0, 0, 0, 11, 0, 8],
      clicks: [0, 0, 0, 0, 4, 0, 3],
    },
    onlineNow: 6, countingSince: 1792326600000,
  },
  "30d": {
    range: "30d",
    labels: [...Array.from({ length: 23 }, (_, i) => `Oct. ${i + 9}`), ...Array.from({ length: 7 }, (_, i) => `Nov. ${i + 1}`)],
    series: {
      online: series(30, { 9: 2, 26: 3, 29: 9 }),
      signups: series(30, { 19: 1, 21: 1, 22: 1, 23: 1, 26: 1, 29: 1 }),
      messages: series(30, { 9: 1, 27: 1, 29: 2 }),
      impressions: series(30, { 19: 20, 27: 11, 29: 8 }),
      clicks: series(30, { 19: 6, 27: 4, 29: 3 }),
    },
    onlineNow: 6, countingSince: 1792326600000,
  },
};

/** Each seeded account as the users list shows it. u_gone (deleted) never appears. */
const USER = {
  u_pw: { id: "u_pw", name: "Nora Harbour", username: "harbourview", role: "member", banned: 0, joined: 1794047400000, messages: 2, lastPost: 1794051000000, openReports: 0 },
  u_goog: { id: "u_goog", name: "Gia Google", username: null, role: "member", banned: 0, joined: 1793795400000, messages: 1, lastPost: 1793881800000, openReports: 0 },
  u_pct: { id: "u_pct", name: "Pat 100% local", username: "percent", role: "member", banned: 0, joined: 1793536200000, messages: 0, lastPost: null, openReports: 0 },
  u_us: { id: "u_us", name: "a_b", username: "under", role: "member", banned: 0, joined: 1793449800000, messages: 0, lastPost: null, openReports: 0 },
  u_ux: { id: "u_ux", name: "axb", username: "notunder", role: "member", banned: 0, joined: 1793363400000, messages: 0, lastPost: null, openReports: 0 },
  u_ban: { id: "u_ban", name: "Banned Bob", username: "trouble", role: "member", banned: 1, joined: 1793190600000, messages: 1, lastPost: 1792326600000, openReports: 1 },
  u_old: { id: "u_old", name: "Old Timer", username: "oldtimer", role: "member", banned: 0, joined: 1791030600000, messages: 0, lastPost: null, openReports: 0 },
  u_mod: { id: "u_mod", name: "Mary Mod", username: "modmary", role: "moderator", banned: 0, joined: 1790598600000, messages: 0, lastPost: null, openReports: 0 },
  u_desk: { id: "u_desk", name: "The Desk", username: null, role: "journalist", banned: 0, joined: 1789734600000, messages: 0, lastPost: null, openReports: 0 },
};
type UserId = keyof typeof USER;
const users = (ids: UserId[], total: number) => ({ users: ids.map(id => USER[id]), total, pageSize: 100 });

/** The users arguments, and the page each gives. */
const USER_CASES: [Record<string, unknown>, ReturnType<typeof users>][] = [
  [{}, users(["u_pw", "u_goog", "u_pct", "u_us", "u_ux", "u_ban", "u_old", "u_mod", "u_desk"], 9)],
  [{ q: "harb" }, users(["u_pw"], 1)],
  [{ q: "%" }, users(["u_pct"], 1)],
  [{ q: "_" }, users(["u_us"], 1)],
  [{ q: "a_b" }, users(["u_us"], 1)],
  [{ role: "banned" }, users(["u_ban"], 1)],
  [{ role: "moderator" }, users(["u_mod"], 1)],
  [{ role: "journalist" }, users(["u_desk"], 1)],
  [{ offset: 2 }, users(["u_pct", "u_us", "u_ux", "u_ban", "u_old", "u_mod", "u_desk"], 9)],
  [{ q: "a", role: "member", offset: 1 }, users(["u_goog", "u_pct", "u_us", "u_ux", "u_ban"], 6)],
];

const story = (id: string, title: string, screen: string, status: string, label: string, source: string, updatedAt: string,
  version: number, messages: number, impressions: number, clicks: number, url: string | null = `https://talkhalifax.ca/#article-${id}`) =>
  ({ id, title, screen, status, label, source, updatedAt, version, messages, impressions, clicks, url });
const event = (id: string, title: string, label: string, url: string | null) =>
  ({ id, title, screen: "Events", status: "active", label, source: "Halifax Public Libraries", updatedAt: "2026-11-07T09:30:00Z", version: null, messages: null, impressions: null, clicks: null, url });

/** Each seeded story and event as the content list shows it. Discarded and skipped stories never appear, nor does the finished event. */
const ITEM = {
  "a-draft": story("a-draft", "Draft about a ferry", "Developing", "waiting", "", "halifax.ca", "2026-11-07T12:00:00Z", 1, 0, 0, 0, null),
  "a-dev": story("a-dev", "Harbour bridge closes for paving", "Developing", "active", "", "halifax.ca", "2026-11-07T11:30:00Z", 2, 3, 8, 3),
  "n-dev": story("n-dev", "Boil water advisory", "Notices", "active", "Final update", "halifaxwater.ca", "2026-11-07T09:30:00Z", 1, 0, 11, 4),
  "a-bad-src": story("a-bad-src", "Story with an odd source", "Articles", "archived", "", "", "2026-11-05T12:30:00Z", 1, 0, 0, 0),
  "a-arch": story("a-arch", "Council approves budget", "Articles", "archived", "", "news.novascotia.ca", "2026-10-30T12:30:00Z", 1, 7, 20, 6),
  "n-arch": story("n-arch", "Old road closure", "Notices", "archived", "", "rcmp.ca", "2026-10-19T12:30:00Z", 1, 0, 0, 0),
  e1: event("e1", "Story time at the harbour", "", "https://example.test/e1"),
  e3: event("e3", "Cancelled chess club", "Cancelled", "https://example.test/e3"),
  e4: event("e4", "Odd link event", "", null),
};
type ItemId = keyof typeof ITEM;
const items = (ids: ItemId[]) => ({ items: ids.map(id => ITEM[id]), total: ids.length, limit: 500 });

/** The content arguments, and the list each gives. */
const CONTENT_CASES: [Record<string, unknown>, ReturnType<typeof items>][] = [
  [{}, items(["a-draft", "a-dev", "n-dev", "a-bad-src", "a-arch", "n-arch", "e1", "e3", "e4"])],
  [{ screen: "Events" }, items(["e1", "e3", "e4"])],
  [{ status: "archived" }, items(["a-bad-src", "a-arch", "n-arch"])],
  [{ q: "harbour" }, items(["a-dev", "e1"])],
  [{ screen: "Notices", status: "active" }, items(["n-dev"])],
  [{ status: "waiting" }, items(["a-draft"])],
];

const DATA_SOURCES = {
  feeds: [
    { name: "Environment Canada, conditions", shows: "Weather line", lastAt: 1794053400000, state: "ok" },
    { name: "Environment Canada, warnings", shows: "Banners and Notices", lastAt: 1794036600000, state: "late" },
    { name: "Halifax Public Libraries", shows: "Events", lastAt: 1794043800000, state: "ok" },
  ],
  sources: [
    { name: "halifax.ca", stories: 1, last: "2026-11-07T09:30:00Z" },
    { name: "Halifax Water", stories: 1, last: "2026-11-07T08:30:00Z" },
    { name: "Province of Nova Scotia", stories: 1, last: "2026-10-29T12:30:00Z" },
    { name: "RCMP", stories: 1, last: "2026-10-18T12:30:00Z" },
  ],
};

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const api = (e: Env = env) => new AdminApi(createExecutionContext(), e);
/** Calls a method with any arguments at all, as an RPC caller could. */
const call = (a: AdminApi, method: keyof AdminApi, ...args: unknown[]) => (a[method] as unknown as (...x: unknown[]) => Promise<unknown>).apply(a, args);
const METHODS = ["content", "dataSources", "jobs", "overview", "summary", "users"] as const;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("AdminApi's surface", () => {
  it("has exactly six methods, and no fetch, getters or anything else", () => {
    const names = Object.getOwnPropertyNames(AdminApi.prototype).filter(n => n !== "constructor").sort();
    expect(names).toEqual([...METHODS]);
    expect(Object.getPrototypeOf(AdminApi.prototype)).toBe(WorkerEntrypoint.prototype);
    expect(Object.getOwnPropertySymbols(AdminApi.prototype)).toEqual([]);
    expect((AdminApi.prototype as unknown as { fetch?: unknown }).fetch).toBeUndefined();
    for (const n of names) {
      const d = Object.getOwnPropertyDescriptor(AdminApi.prototype, n)!;
      expect(d.get, n).toBeUndefined();
      expect(d.set, n).toBeUndefined();
      expect(typeof d.value, n).toBe("function");
    }
  });
  it("has no fields on an instance beyond what WorkerEntrypoint itself sets", () => {
    class Bare extends WorkerEntrypoint<Env> {}
    const base = Object.getOwnPropertyNames(new Bare(createExecutionContext(), env));
    expect(Object.getOwnPropertyNames(api()).sort()).toEqual(base.sort());
  });
  it("is the class the main Worker exports", () => {
    expect(ExportedAdminApi).toBe(AdminApi);
  });
});

describe("AdminApi's data for the seeded rows", () => {
  beforeEach(() => seedAdminData(NOW));

  it("summary", async () => {
    expect(plain(await summaryData(env, undefined, NOW))).toEqual(SUMMARY);
  });
  for (const range of ["24h", "7d", "30d"] as const) {
    it(`overview, ${range}`, async () => {
      const mine = plain(await overviewData(env, range, NOW));
      expect(mine).toEqual(OVERVIEW[range]);
      expect(mine.series.signups.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0); // the seed shows up
    });
  }
  for (const [args, want] of USER_CASES) {
    it(`users, ${JSON.stringify(args)}`, async () => {
      expect(plain(await usersData(env, usersArgs(args)!, NOW))).toEqual(want);
    });
  }
  it("users finds what the seed says it should", async () => {
    const ids = async (args: Record<string, unknown>) => (await usersData(env, usersArgs(args)!, NOW)).users.map(u => u.id);
    expect(await ids({ q: "harb" })).toEqual(["u_pw"]);
    expect(await ids({ q: "%" })).toEqual(["u_pct"]);
    expect(await ids({ role: "banned" })).toEqual(["u_ban"]);
    expect(await ids({ role: "moderator" })).toEqual(["u_mod"]);
    expect(await ids({})).not.toContain("u_gone");
  });
  for (const [args, want] of CONTENT_CASES) {
    it(`content, ${JSON.stringify(args)}`, async () => {
      const mine = plain(await contentData(env, contentArgs(args)!, NOW));
      expect(mine).toEqual(want);
      expect(mine.items.length).toBeGreaterThan(0);
    });
  }
  it("data", async () => {
    expect(plain(await dataSourcesData(env, undefined, NOW))).toEqual(DATA_SOURCES);
  });
  it("jobs", async () => {
    expect(plain(await jobsData(env, undefined, NOW))).toEqual({ jobs: JOBS });
  });
});

describe("AdminApi's methods are its query functions", () => {
  beforeEach(async () => {
    await seedAdminData(NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW); // the methods use Date.now(), so pin it rather than race the hour
  });

  it("summary, dataSources and jobs", async () => {
    const a = api();
    expect(plain(await a.summary())).toEqual(plain(await summaryData(env, undefined, NOW)));
    expect(plain(await a.dataSources())).toEqual(plain(await dataSourcesData(env, undefined, NOW)));
    expect(plain(await a.jobs())).toEqual(plain(await jobsData(env, undefined, NOW)));
  });
  it("overview", async () => {
    for (const r of ["24h", "7d", "30d"] as const) expect(plain(await api().overview(r))).toEqual(plain(await overviewData(env, r, NOW)));
  });
  it("users, with its arguments trimmed and lowercased", async () => {
    expect(plain(await api().users())).toEqual(plain(await usersData(env, { q: "", role: "all", offset: 0 }, NOW)));
    expect(plain(await api().users({ q: "  HARB  ", role: "member", offset: 0 }))).toEqual(plain(await usersData(env, { q: "harb", role: "member", offset: 0 }, NOW)));
    expect(plain(await api().users({ role: "banned" }))).toEqual(plain(await usersData(env, { q: "", role: "banned", offset: 0 }, NOW)));
  });
  it("content, with its arguments trimmed and lowercased", async () => {
    expect(plain(await api().content())).toEqual(plain(await contentData(env, { screen: "all", status: "all", q: "" }, NOW)));
    expect(plain(await api().content({ screen: "Events", q: " STORY " }))).toEqual(plain(await contentData(env, { screen: "Events", status: "all", q: "story" }, NOW)));
  });
});

describe("AdminApi keeps private things private", () => {
  beforeEach(() => seedAdminData(NOW));
  const hidden = [
    ...Object.values(ADMIN_SECRETS.pw), ...Object.values(ADMIN_SECRETS.google), ...Object.values(ADMIN_SECRETS.newsroom), ADMIN_SECRETS.googleSub,
    '"email"', '"password_hash"', '"persona"', '"provider_sub"',
  ];

  it("no method returns an email, password hash, persona or Google id, or those keys", async () => {
    const a = api();
    const outputs = [
      await a.summary(), await a.dataSources(), await a.jobs(), await a.overview("30d"), await a.users(), await a.users({ role: "journalist" }),
      await a.users({ q: "gia" }), await a.content(),
    ];
    for (const out of outputs) {
      const body = JSON.stringify(out);
      for (const h of hidden) expect(body).not.toContain(h);
    }
    expect(JSON.stringify(await a.users())).toContain("harbourview"); // a password account's username is shown, as on the admin site
  });
  it("won't find a Google account by its Google id", async () => {
    expect(plain(await api().users({ q: "google-sub" }))).toMatchObject({ users: [], total: 0 });
  });
  it("won't find an account by any part of its email", async () => {
    const email = ADMIN_SECRETS.pw.email; // nora.private@example.test
    const [local, domain] = email.split("@");
    for (const q of [local, `${local.split(".")[1]}@${domain.split(".")[0]}`, domain, email]) {
      expect(plain(await api().users({ q })), q).toMatchObject({ users: [], total: 0 });
    }
  });
});

describe("AdminApi's arguments", () => {
  beforeEach(() => seedAdminData(NOW));

  it("overview falls back to 7 days for anything but a known range", async () => {
    for (const r of [undefined, "forever", 42, {}, null, ["24h"], "7d".repeat(1000), "24H"]) expect((await call(api(), "overview", r) as { range: string }).range).toBe("7d");
    expect((await api().overview("24h")).range).toBe("24h");
  });
  it("users refuses anything but its own arguments, with exactly Bad request", async () => {
    const bad = [null, "x", [], 5, new Date(), { q: 5 }, { q: null }, { role: "admin" }, { role: ["member"] }, { role: "Member" },
      { offset: -1 }, { offset: 1.5 }, { offset: "10" }, { offset: NaN }, { offset: Infinity }, { offset: 2 ** 53 }, { offset: 100_001 }];
    for (const args of bad) await expect(call(api(), "users", args), JSON.stringify(args) ?? String(args)).rejects.toThrow(/^Bad request$/);
  });
  it("users takes a long search, cut to 60 characters", async () => {
    expect(usersArgs({ q: "A".repeat(10_000) })!.q).toBe("a".repeat(60));
    expect((await api().users({ q: "  harb" + " ".repeat(10_000) })).users.map(u => u.id)).toEqual(["u_pw"]);
    await expect(api().users({ q: "x".repeat(48) })).resolves.toMatchObject({ users: [], total: 0 });
  });
  it("users fails a search past D1's 50-byte LIKE limit, and says nothing more", async () => {
    // Known gap: 60 characters plus the two % signs is over D1's limit. Fixing it is its own change.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(usersArgs({ q: "x".repeat(10_000) })!.q).toBe("x".repeat(60));
    await expect(api().users({ q: "x".repeat(10_000) })).rejects.toThrow(/^Something went wrong$/);
    expect(logged).toHaveBeenCalled();
  });
  it("users takes an offset up to 100,000", () => {
    expect(usersArgs({ offset: 100_000 })!.offset).toBe(100000);
  });
  it("users treats % and _ as plain text", async () => {
    expect((await api().users({ q: "%" })).users.map(u => u.id)).toEqual(["u_pct"]);
    expect((await api().users({ q: "_" })).users.map(u => u.id)).toEqual(["u_us"]);
    expect((await api().users({ q: "a_b" })).users.map(u => u.id)).toEqual(["u_us"]);
    expect((await api().users({ q: "\\" })).users).toEqual([]);
  });
  it("users fills in its defaults", () => {
    expect(usersArgs(undefined)).toEqual({ q: "", role: "all", offset: 0 });
    expect(usersArgs({})).toEqual({ q: "", role: "all", offset: 0 });
    for (const role of ["all", "member", "moderator", "journalist", "banned"]) expect(usersArgs({ role })!.role).toBe(role);
  });
  it("content refuses anything but its own arguments, with exactly Bad request", async () => {
    const bad = [null, "x", [], { screen: "Foo" }, { screen: "events" }, { status: "deleted" }, { status: ["all"] }, { q: {} }, { q: 1 }];
    for (const args of bad) await expect(call(api(), "content", args), JSON.stringify(args)).rejects.toThrow(/^Bad request$/);
  });
  it("content fills in its defaults and cuts its search to 100 characters", async () => {
    expect(contentArgs(undefined)).toEqual({ screen: "all", status: "all", q: "" });
    expect(contentArgs({ q: "B".repeat(500) })!.q).toBe("b".repeat(100));
    for (const screen of ["all", "Developing", "Articles", "Notices", "Events"]) expect(contentArgs({ screen })!.screen).toBe(screen);
    for (const status of ["all", "waiting", "active", "archived"]) expect(contentArgs({ status })!.status).toBe(status);
    await expect(api().content({ q: "x".repeat(10_000) })).resolves.toMatchObject({ items: [], total: 0 });
  });
  it("the methods with no arguments ignore whatever they're sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (const m of ["summary", "dataSources", "jobs"] as const) {
      const clean = plain(await call(api(), m));
      for (const junk of [null, "x", { q: 1 }, [1], "x".repeat(10_000)]) expect(plain(await call(api(), m, junk, junk))).toEqual(clean);
    }
  });
});

describe("AdminApi's errors", () => {
  /** A database that refuses every query. */
  const refusing = () => {
    const no = (what: string) => { throw new Error(`Unexpected database call: ${what} FROM users`); };
    return { ...env, DB: { prepare: (sql: string) => no(sql), batch: () => no("batch"), exec: (sql: string) => no(sql), dump: () => no("dump") } } as unknown as Env;
  };

  it("say only Something went wrong when the database fails, with no SQL", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = api(refusing());
    for (const m of METHODS) {
      const err = await call(a, m).then(() => null, (e: Error) => e);
      expect(err, m).toBeInstanceOf(Error);
      expect(err!.message, m).toBe("Something went wrong");
      expect(err!.cause, m).toBeUndefined();
    }
    expect(logged).toHaveBeenCalledTimes(METHODS.length);
  });
  it("say Bad request, not Something went wrong, for bad arguments, before touching the database", async () => {
    const a = api(refusing());
    await expect(call(a, "users", { role: "admin" })).rejects.toThrow(/^Bad request$/);
    await expect(call(a, "content", { screen: "Foo" })).rejects.toThrow(/^Bad request$/);
  });
});

describe("AdminApi has no public address", () => {
  it("every guess at a path is 404 through the main Worker, read or write", async () => {
    const paths = ["/internal/x", "/internal/summary", "/admin-api", "/admin-api/summary", "/api/admin", "/api/admin/summary", "/api/adminx", "/api/admin-api/jobs"];
    for (const path of paths) for (const method of ["GET", "POST"]) {
      const init: RequestInit = method === "POST" ? { method, headers: { origin: "https://talkhalifax.ca", "content-type": "application/json" }, body: "{}" } : { method };
      const r = await worker.fetch(new Request(`https://talkhalifax.ca${path}`, init) as never, env, {} as ExecutionContext);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("AdminApi and the cron share one job list", () => {
  it("lists the cron's jobs from CRON_JOBS, then the two it dispatches", async () => {
    const names = (await api().jobs()).jobs.map(j => j.name);
    expect(names.slice(0, -2)).toEqual(CRON_JOBS.map(j => j.name));
    expect(names.slice(-2)).toEqual(["Library events", "Transit schedule"]);
  });
  it("shows a failure counted under a CRON_JOBS key as failing on that job", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (const j of CRON_JOBS) {
      await env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('cron-health', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
        .bind(JSON.stringify({ [j.key]: 3 }), new Date(NOW - 10 * 60_000).toISOString()).run();
      const jobs = (await api().jobs()).jobs;
      expect(jobs.find(x => x.name === j.name), j.key).toMatchObject({ state: "failing", failures: 3 });
      expect(jobs.filter(x => x.state === "failing").map(x => x.name), j.key).toEqual([j.name]);
    }
    await env.DB.prepare("UPDATE feeds SET updated_at = ? WHERE name = 'cron-health'").bind(new Date(NOW - 2 * HOUR).toISOString()).run();
    expect((await api().jobs()).jobs.find(x => x.name === CRON_JOBS[0].name)!.state).toBe("late");
  });
});
