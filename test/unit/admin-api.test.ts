import { createExecutionContext } from "cloudflare:test";
import { WorkerEntrypoint } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../admin/src/index";
import type { Env } from "../../src/env";
import worker, { AdminApi as ExportedAdminApi } from "../../src/index";
import {
  AdminApi, contentArgs, contentData, dataSourcesData, jobsData, overviewData, summaryData, usersArgs, usersData,
} from "../../src/routes/admin-api";
import { CRON_JOBS } from "../../src/routes/cron-jobs";
import { ADMIN_SECRETS, env, HOUR, seedAdminData } from "./helpers";

// 8 a.m. in Halifax, mid-hour, so nothing here sits on an hour's edge
const NOW = Date.UTC(2026, 10, 7, 12, 30);
const assets = { fetch: async () => new Response("the page") } as unknown as Fetcher;
/** What the admin Worker's endpoint answers, at NOW, for a local run. */
const admin = async (path: string) => (await handle(new Request(`http://localhost:8790${path}`), { DB: env.DB, ASSETS: assets, ADMIN_DEV: "1" }, NOW)).json();
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

describe("AdminApi gives the same data as the admin site", () => {
  beforeEach(() => seedAdminData(NOW));

  it("summary", async () => {
    expect(plain(await summaryData(env, undefined, NOW))).toEqual(await admin("/api/summary"));
  });
  for (const range of ["24h", "7d", "30d"] as const) {
    it(`overview, ${range}`, async () => {
      const mine = plain(await overviewData(env, range, NOW));
      expect(mine).toEqual(await admin(`/api/overview?range=${range}`));
      expect(mine.series.signups.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0); // the seed shows up
    });
  }
  const userCases: [Record<string, unknown>, string][] = [
    [{}, ""], [{ q: "harb" }, "q=harb"], [{ q: "%" }, "q=%25"], [{ q: "_" }, "q=_"], [{ q: "a_b" }, "q=a_b"],
    [{ role: "banned" }, "role=banned"], [{ role: "moderator" }, "role=moderator"], [{ role: "journalist" }, "role=journalist"],
    [{ offset: 2 }, "offset=2"], [{ q: "a", role: "member", offset: 1 }, "q=a&role=member&offset=1"],
  ];
  for (const [args, query] of userCases) {
    it(`users, ${query || "no filter"}`, async () => {
      const mine = plain(await usersData(env, usersArgs(args)!, NOW));
      expect(mine).toEqual(await admin(`/api/users?${query}`));
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
  const contentCases: [Record<string, unknown>, string][] = [
    [{}, ""], [{ screen: "Events" }, "screen=Events"], [{ status: "archived" }, "status=archived"], [{ q: "harbour" }, "q=harbour"],
    [{ screen: "Notices", status: "active" }, "screen=Notices&status=active"], [{ status: "waiting" }, "status=waiting"],
  ];
  for (const [args, query] of contentCases) {
    it(`content, ${query || "no filter"}`, async () => {
      const mine = plain(await contentData(env, contentArgs(args)!, NOW));
      expect(mine).toEqual(await admin(`/api/content?${query}`));
      expect(mine.items.length).toBeGreaterThan(0);
    });
  }
  it("data", async () => {
    expect(plain(await dataSourcesData(env, undefined, NOW))).toEqual(await admin("/api/data"));
  });
  it("jobs", async () => {
    expect(plain(await jobsData(env, undefined, NOW))).toEqual(await admin("/api/jobs"));
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
});

describe("AdminApi's arguments", () => {
  beforeEach(() => seedAdminData(NOW));

  it("overview falls back to 7 days for anything but a known range", async () => {
    for (const r of [undefined, "forever", 42, {}, null, ["24h"], "7d".repeat(1000), "24H"]) expect((await call(api(), "overview", r) as { range: string }).range).toBe("7d");
    expect((await api().overview("24h")).range).toBe("24h");
  });
  it("users refuses anything but its own arguments, with exactly Bad request", async () => {
    const bad = [null, "x", [], 5, new Date(), { q: 5 }, { q: null }, { role: "admin" }, { role: ["member"] }, { role: "Member" },
      { offset: -1 }, { offset: 1.5 }, { offset: "10" }, { offset: NaN }, { offset: Infinity }, { offset: 2 ** 53 }];
    for (const args of bad) await expect(call(api(), "users", args), JSON.stringify(args) ?? String(args)).rejects.toThrow(/^Bad request$/);
  });
  it("users takes a long search, cut to 60 characters", async () => {
    expect(usersArgs({ q: "A".repeat(10_000) })!.q).toBe("a".repeat(60));
    expect((await api().users({ q: "  harb" + " ".repeat(10_000) })).users.map(u => u.id)).toEqual(["u_pw"]);
    await expect(api().users({ q: "x".repeat(48) })).resolves.toMatchObject({ users: [], total: 0 });
  });
  it("users fails a search past D1's 50-byte LIKE limit just as the admin site does, and says nothing more", async () => {
    // Known gap, copied from admin/src/index.ts: 60 characters plus the two % signs is over D1's limit. Fixing it is its own change.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(api().users({ q: "x".repeat(10_000) })).rejects.toThrow(/^Something went wrong$/);
    expect((await handle(new Request(`http://localhost:8790/api/users?q=${"x".repeat(60)}`), { DB: env.DB, ASSETS: assets, ADMIN_DEV: "1" }, NOW)).status).toBe(500);
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
