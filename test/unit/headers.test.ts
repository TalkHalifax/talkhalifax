import { describe, expect, it } from "vitest";
import { clearSessionCookie } from "../../src/auth";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { env, makeStory, makeUser } from "./helpers";

const ORIGIN = "https://talkhalifax.ca";
const get = (url: string, init?: RequestInit) => worker.fetch!(new Request(url, init) as never, env, {} as ExecutionContext);

function expectSecured(r: Response) {
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(r.headers.get("permissions-policy")).toBe("geolocation=(self), camera=(), microphone=()");
  expect(r.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'none'");
}

describe("security headers", () => {
  it("are on the page, the data, errors and refusals", async () => {
    for (const path of ["/", "/app.js", "/api/stories", "/auth/nothing-here", "/no-such-file"]) expectSecured(await get(ORIGIN + path));
    expectSecured(await get(`${ORIGIN}/api/stats`, { method: "POST", body: "{}" }));
  });
  it("are on redirects, which still redirect", async () => {
    const r = await get("https://talkhalifax.com/some/page");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`${ORIGIN}/some/page`);
    expectSecured(r);
  });
  it("keep what the response already had", async () => {
    const r = await get(`${ORIGIN}/api/stories`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await r.json() as { stories: unknown[] }).stories).toBeInstanceOf(Array);
  });
  it("only report on the content policy for now, and leave HSTS to the zone", async () => {
    const r = await get(`${ORIGIN}/`);
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });
  it("leave a chat's WebSocket upgrade untouched", async () => {
    await makeStory("hdr-room");
    const r = await get(`${ORIGIN}/rooms/hdr-room/ws`, { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(101);
    expect(r.webSocket).toBeTruthy();
    expect(r.headers.get("x-frame-options")).toBeNull();
    r.webSocket!.accept();
    r.webSocket!.close();
  });
});

// The origin checks on the API routes that change things (PC-3, JOB-9)
const OTHER = "https://example.test";
const COOKIE = "th_session=s_origin_test";

/** The test bindings with a database that refuses every query and records that it was asked. */
function refusingDb() {
  const queries: string[] = [];
  const refuse = (what: string) => { queries.push(what); throw new Error(`Unexpected database call: ${what}`); };
  const DB = { prepare: (sql: string) => refuse(sql), batch: () => refuse("batch"), exec: (sql: string) => refuse(sql), dump: () => refuse("dump") };
  return { env: { ...env, DB } as unknown as Env, queries };
}
const call = (e: Env, url: string, init: RequestInit) => worker.fetch!(new Request(url, init) as never, e, {} as ExecutionContext);

/** Missing, another site, the literal "null", and a lookalike host that starts with the site's address. */
const BAD_ORIGINS: (string | null)[] = [null, OTHER, "null", `${ORIGIN}.example.test`];

/** A signed-in DELETE with each bad origin is 400, and the database is never asked anything. */
async function expectNoLookupForBadOrigins(url: string) {
  for (const origin of BAD_ORIGINS) {
    const db = refusingDb();
    const headers: Record<string, string> = origin === null ? { cookie: COOKIE } : { cookie: COOKIE, origin };
    const r = await call(db.env, url, { method: "DELETE", headers });
    expect(r.status, `origin ${origin}`).toBe(400);
    expect(db.queries, `origin ${origin}`).toEqual([]);
  }
}

/** The control: with the right origin, the session lookup reaches the refusing database (500, one sessions query). */
async function expectLookupForGoodOrigin(url: string) {
  const db = refusingDb();
  const r = await call(db.env, url, { method: "DELETE", headers: { cookie: COOKIE, origin: ORIGIN } });
  expect(r.status).toBe(500);
  expect(db.queries).toHaveLength(1);
  expect(db.queries[0]).toContain("FROM sessions");
}

async function signIn(id: string) {
  await makeUser(id);
  const sid = `s_${id}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(sid, id, Date.now(), Date.now() + 36e5).run();
  return `th_session=${sid}`;
}

describe("DELETE /api/me", () => {
  it("refuses a request with no origin, or from another site", async () => {
    expect((await call(env, `${ORIGIN}/api/me`, { method: "DELETE" })).status).toBe(400);
    expect((await call(env, `${ORIGIN}/api/me`, { method: "DELETE", headers: { origin: OTHER } })).status).toBe(400);
  });
  it("never looks up the session for a bad origin", async () => {
    await expectNoLookupForBadOrigins(`${ORIGIN}/api/me`);
  });
  it("does look up the session once the origin is right, so the check above would catch a swapped order", async () => {
    await expectLookupForGoodOrigin(`${ORIGIN}/api/me`);
  });
  for (const origin of [ORIGIN, "http://localhost:8787"]) {
    it(`deletes the account and clears the cookie with clearSessionCookie on ${origin}, with no content-type`, async () => {
      const cookie = await signIn(`u_del_${origin.startsWith("https") ? "live" : "local"}`);
      const url = new URL(`${origin}/api/me`);
      const r = await call(env, url.href, { method: "DELETE", headers: { origin, cookie } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      expect(r.headers.get("set-cookie")).toBe(clearSessionCookie(url));
    });
  }
});

describe("DELETE /api/comments/:id", () => {
  it("refuses a request with no origin, or from another site", async () => {
    expect((await call(env, `${ORIGIN}/api/comments/c_1`, { method: "DELETE" })).status).toBe(400);
    expect((await call(env, `${ORIGIN}/api/comments/c_1`, { method: "DELETE", headers: { origin: OTHER } })).status).toBe(400);
  });
  it("never looks up the session for a bad origin", async () => {
    await expectNoLookupForBadOrigins(`${ORIGIN}/api/comments/c_1`);
  });
  it("does look up the session once the origin is right, so the check above would catch a swapped order", async () => {
    await expectLookupForGoodOrigin(`${ORIGIN}/api/comments/c_1`);
  });
  it("passes the origin check with the right origin and no content-type", async () => {
    const r = await call(env, `${ORIGIN}/api/comments/c_1`, { method: "DELETE", headers: { origin: ORIGIN } });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Sign in first." });
  });
});

describe("/api/reports", () => {
  it("refuses a POST from another site before looking up the session", async () => {
    const db = refusingDb();
    const r = await call(db.env, `${ORIGIN}/api/reports`, { method: "POST", headers: { origin: OTHER, "content-type": "application/json", cookie: COOKIE }, body: "{}" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Bad request" });
    expect(db.queries).toEqual([]);
  });
  it("still asks a signed-out POST from this site to sign in", async () => {
    const r = await call(env, `${ORIGIN}/api/reports`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Sign in to report." });
  });
  it("still keeps the list to moderators", async () => {
    const r = await call(env, `${ORIGIN}/api/reports`, { method: "GET" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Moderators only." });
  });
});
