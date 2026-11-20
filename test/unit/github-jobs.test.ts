import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGithubJobs } from "../../src/github-jobs";
import worker from "../../src/index";
import { SWEEP_AFTER_DAYS } from "../../src/push";
import { CRON_JOBS } from "../../src/routes/cron-jobs";
import { env, HOUR, DAY } from "./helpers";

const withToken = { ...env, GITHUB_ACTIONS_TOKEN: "test-token" };
const START = Date.UTC(2026, 10, 7, 12);
type Call = { url: string; init: RequestInit };

describe("starting the GitHub jobs", () => {
  let calls: Call[], status: (url: string) => number;
  const started = () => calls.map(c => c.url.match(/workflows\/(.+)\/dispatches/)?.[1]);
  beforeEach(async () => {
    calls = []; status = () => 204;
    await env.DB.prepare("DELETE FROM feeds WHERE name = 'github-jobs'").run();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: status(url) }); });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing until the token is set", async () => {
    await startGithubJobs(env, START);
    expect(calls).toHaveLength(0);
  });
  it("starts both jobs the first time, on main, as GitHub requires", async () => {
    await startGithubJobs(withToken, START);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
    expect(calls[0].url).toBe("https://api.github.com/repos/TalkHalifax/talkhalifax/actions/workflows/events.yml/dispatches");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ref: "main" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["user-agent"]).toBeTruthy();
  });
  it("doesn't start anything again before it's due", async () => {
    await startGithubJobs(withToken, START);
    calls = [];
    await startGithubJobs(withToken, START + 30 * 60_000);
    expect(calls).toHaveLength(0);
  });
  it("starts Events every 6 hours, without drifting, and Transit weekly", async () => {
    await startGithubJobs(withToken, START);
    calls = [];
    await startGithubJobs(withToken, START + 6 * HOUR - 60_000);
    expect(started()).toEqual(["events.yml"]);
    calls = [];
    await startGithubJobs(withToken, START + 7 * DAY);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
  });
  it("tries again next run after a refusal, tells the watch, and still starts the other job", async () => {
    status = url => url.includes("events.yml") ? 401 : 204;
    await expect(startGithubJobs(withToken, START)).rejects.toThrow(/events\.yml \(HTTP 401\).*GITHUB_ACTIONS_TOKEN/);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
    calls = []; status = () => 204;
    await startGithubJobs(withToken, START + 30 * 60_000);
    expect(started()).toEqual(["events.yml"]);
  });
  it("never puts the token in what it reports", async () => {
    status = () => 403;
    await expect(startGithubJobs(withToken, START)).rejects.not.toThrow(/test-token/);
  });
});

describe("the cron's job list", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const health = async () => JSON.parse((await env.DB.prepare("SELECT body FROM feeds WHERE name = 'cron-health'").first<{ body: string }>())!.body) as Record<string, number>;
  const sweptAt = async () => (await env.DB.prepare("SELECT updated_at FROM feeds WHERE name = 'push-sweep'").first<{ updated_at: string }>())?.updated_at;

  it("has the eight jobs, in the order the cron has always run them, with the alert address clean-up last", () => {
    expect(CRON_JOBS.map(j => j.key)).toEqual(["weather", "alerts", "events", "stages", "transit schedule", "GitHub jobs", "clean-up", "push sweep"]);
  });
  it("lists the alert address clean-up for the admin site", () => {
    const job = CRON_JOBS.find(j => j.key === "push sweep")!;
    expect(job.name).toBe("Alert address clean-up");
    expect(job.every).toBe("Daily (checked every 30 minutes)");
    expect(job.does).toBe("Deletes alert addresses with no alert reaching them or change in 180 days, or after five failed alerts");
    expect(job.does).toContain(`${SWEEP_AFTER_DAYS} days`);
  });
  it("runs the alert address clean-up: one cron run records the sweep and counts no failure", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("no network in this test"); });
    expect(await sweptAt()).toBeUndefined();
    await worker.scheduled({} as ScheduledController, env);
    expect(await sweptAt()).toBeTypeOf("string");
    expect((await health())["push sweep"]).toBe(0);
  });
  it("sweeps alert addresses at most once a day, and counts a skipped run as a success", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("no network in this test"); });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    await worker.scheduled({} as ScheduledController, env);
    expect(await sweptAt()).toBe("2026-11-07T12:00:00Z");
    vi.setSystemTime(START + 23 * HOUR);
    await worker.scheduled({} as ScheduledController, env);
    expect((await health())["push sweep"]).toBe(0);
    expect(await sweptAt()).toBe("2026-11-07T12:00:00Z");
  });
  it("counts each failed sweep under its key, without touching the other database jobs", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("no network in this test"); });
    // The database refuses only the sweep's batch (the one touching push_subs); every other statement goes through
    const db = env.DB, sqlOf = new WeakMap<object, string>(), real = new WeakMap<object, D1PreparedStatement>();
    const prepare = (sql: string) => {
      const s = db.prepare(sql);
      const p = new Proxy(s, {
        get(t, k) {
          if (k === "bind") return (...args: unknown[]) => { const b = t.bind(...args); sqlOf.set(b, sql); return b; };
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      sqlOf.set(p, sql); real.set(p, s);
      return p;
    };
    const batch = (stmts: D1PreparedStatement[]) => stmts.some(s => /push_subs/.test(sqlOf.get(s) ?? ""))
      ? Promise.reject(new Error("D1_ERROR: database is unavailable"))
      : db.batch(stmts.map(s => real.get(s) ?? s));
    const broken = new Proxy(db, {
      get(t, k) {
        if (k === "prepare") return prepare;
        if (k === "batch") return batch;
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const brokenEnv = { ...env, DB: broken } as typeof env;
    await worker.scheduled({} as ScheduledController, brokenEnv);
    await worker.scheduled({} as ScheduledController, brokenEnv);
    const fails = await health();
    expect(fails["push sweep"]).toBe(2);
    expect(fails).toMatchObject({ stages: 0, "GitHub jobs": 0, "clean-up": 0 });
    expect(await sweptAt()).toBeUndefined();
  });
  it("is what the cron runs, and each job's failures are counted under its key", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("no network in this test"); });
    await worker.scheduled({} as ScheduledController, env);
    const row = await env.DB.prepare("SELECT body FROM feeds WHERE name = 'cron-health'").first<{ body: string }>();
    const fails = JSON.parse(row!.body) as Record<string, number>;
    expect(Object.keys(fails)).toEqual(CRON_JOBS.map(j => j.key));
    // Weather and warnings need the network, and no library events have arrived; the rest can't fail here
    expect(fails).toMatchObject({ weather: 1, alerts: 1, events: 1, stages: 0, "GitHub jobs": 0, "clean-up": 0, "push sweep": 0 });
    expect([0, 1]).toContain(fails["transit schedule"]); // fails only in the last week of the map's schedule
  });
});
