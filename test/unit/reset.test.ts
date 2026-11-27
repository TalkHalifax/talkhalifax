import { describe, expect, it } from "vitest";
import { clearSessionCookie, makeResetToken, originMatches, sameOrigin } from "../../src/auth";
import worker from "../../src/index";
import { env, makeUser } from "./helpers";

const ORIGIN = "https://talkhalifax.ca";
const check = (token: unknown, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) =>
  worker.fetch!(new Request(`${ORIGIN}/auth/reset/check`, { method: "POST", headers, body: JSON.stringify({ token }) }) as never, env, {} as ExecutionContext);

describe("checking a password reset link", () => {
  it("names the account for a good token, without using it up", async () => {
    await makeUser("u_reset", { provider_sub: "nora" });
    const token = await makeResetToken(env, "u_reset", "u_mod");
    for (let i = 0; i < 2; i++) {
      const r = await check(token);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ username: "nora" });
    }
  });
  it("turns away a bad or missing token", async () => {
    expect((await check("nope")).status).toBe(410);
    expect((await check(undefined)).status).toBe(410);
  });
  it("refuses another site", async () => {
    expect((await check("nope", { origin: "https://example.test", "content-type": "application/json" })).status).toBe(403);
  });
  it("never takes the token in a URL, where the request logs would keep it", async () => {
    await makeUser("u_url", { provider_sub: "bo" });
    const token = await makeResetToken(env, "u_url", "u_mod");
    const r = await worker.fetch!(new Request(`${ORIGIN}/auth/reset?token=${token}`) as never, env, {} as ExecutionContext);
    expect(await r.text()).not.toContain("bo");
  });
});

describe("originMatches", () => {
  const url = new URL(`${ORIGIN}/api/thing`);
  const req = (headers: Record<string, string>, method = "POST") => new Request(url, { method, headers });
  it("is true when the origin header equals the site's origin", () => {
    expect(originMatches(req({ origin: ORIGIN }), url)).toBe(true);
  });
  it("is false with no origin header", () => {
    expect(originMatches(req({}), url)).toBe(false);
  });
  it("is false for another site", () => {
    expect(originMatches(req({ origin: "https://example.test" }), url)).toBe(false);
  });
  it("is false for the literal origin null", () => {
    expect(originMatches(req({ origin: "null" }), url)).toBe(false);
  });
  it("is true for a DELETE with no body and no content-type", () => {
    const r = req({ origin: ORIGIN }, "DELETE");
    expect(r.headers.get("content-type")).toBeNull();
    expect(originMatches(r, url)).toBe(true);
  });
});

describe("sameOrigin", () => {
  const url = new URL(`${ORIGIN}/auth/login`);
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });
  it("is true for a matching origin and application/json", () => {
    expect(sameOrigin(req({ origin: ORIGIN, "content-type": "application/json" }), url)).toBe(true);
  });
  it("is true for a matching origin and application/json with a charset", () => {
    expect(sameOrigin(req({ origin: ORIGIN, "content-type": "application/json; charset=utf-8" }), url)).toBe(true);
  });
  it("is false for a matching origin with no content-type", () => {
    const r = req({ origin: ORIGIN });
    expect(r.headers.get("content-type")).toBeNull();
    expect(sameOrigin(r, url)).toBe(false);
  });
  it("is false for a matching origin with text/plain", () => {
    expect(sameOrigin(req({ origin: ORIGIN, "content-type": "text/plain" }), url)).toBe(false);
  });
  it("is false for application/json with no origin", () => {
    expect(sameOrigin(req({ "content-type": "application/json" }), url)).toBe(false);
  });
  it("is false for application/json from another site", () => {
    expect(sameOrigin(req({ origin: "https://example.test", "content-type": "application/json" }), url)).toBe(false);
  });
});

describe("clearSessionCookie", () => {
  const CLEARED = "th_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  it("is Secure on the live site", () => {
    expect(clearSessionCookie(new URL(`${ORIGIN}/`))).toBe("th_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });
  it("drops Secure on plain-http localhost", () => {
    expect(clearSessionCookie(new URL("http://localhost:8787/"))).toBe(CLEARED);
    expect(clearSessionCookie(new URL("http://127.0.0.1:8787/"))).toBe(CLEARED);
  });
});

describe("signing out", () => {
  for (const origin of [ORIGIN, "http://localhost:8787"]) {
    it(`clears the session cookie with clearSessionCookie on ${origin}`, async () => {
      const url = new URL(`${origin}/auth/logout`);
      const r = await worker.fetch!(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" } }) as never, env, {} as ExecutionContext);
      expect(r.status).toBe(200);
      expect(r.headers.get("set-cookie")).toBe(clearSessionCookie(url));
    });
  }
});

// ---------- Sessions are stored only as the SHA-256 of the cookie (job #122) ----------
const sha = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const post = (path: string, body: unknown, cookie?: string) =>
  worker.fetch!(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie: `th_session=${cookie}` } : {}) },
    body: JSON.stringify(body),
  }) as never, env, {} as ExecutionContext);
/** The signed-in user's id for this cookie value, or null. */
const whoIs = async (sid: string) => {
  const r = await worker.fetch!(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `th_session=${sid}` } }) as never, env, {} as ExecutionContext);
  return (await r.json<{ user: { id: string } | null }>()).user?.id ?? null;
};
const cookieOf = (r: Response) => decodeURIComponent(/th_session=([^;]*)/.exec(r.headers.get("set-cookie") || "")![1]);
const sessionIds = async () => (await env.DB.prepare("SELECT id FROM sessions ORDER BY id").all<{ id: string }>()).results.map(r => r.id);
const seedSession = (id: string, userId: string, expiresAt = Date.now() + 36e5) =>
  env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(id, userId, Date.now(), expiresAt).run();
const RAW = "s_abcdefghijklmnopqrstuvwx";

describe("sessions are stored as hashes", () => {
  it("T1: sign-up and login store sha256(cookie), never the cookie", async () => {
    const up = await post("/auth/signup", { username: "hashme", password: "a good password" });
    expect(up.status).toBe(200);
    const c1 = cookieOf(up);
    expect(c1.startsWith("s_")).toBe(true);
    expect(await sessionIds()).toEqual([await sha(c1)]);
    const login = await post("/auth/login", { username: "hashme", password: "a good password" });
    expect(login.status).toBe(200);
    const c2 = cookieOf(login);
    const ids = await sessionIds();
    expect(ids).toContain(await sha(c2));
    expect(ids).not.toContain(c1);
    expect(ids).not.toContain(c2);
    expect(await whoIs(c1)).not.toBeNull();
    expect(await whoIs(c2)).not.toBeNull();
  });

  it("T2: a hashed row signs in; an expired hashed row doesn't", async () => {
    await makeUser("u_h");
    await seedSession(await sha(RAW), "u_h");
    expect(await whoIs(RAW)).toBe("u_h");
    const old = "s_expiredexpiredexpiredxx";
    await seedSession(await sha(old), "u_h", Date.now() - 1000);
    expect(await whoIs(old)).toBeNull();
  });
});

describe("sessions made before hashing are upgraded on first use", () => {
  it("T3: a raw s_ row signs in, is rewritten to its hash, and the cookie keeps working", async () => {
    await makeUser("u_raw");
    await seedSession(RAW, "u_raw");
    expect(await whoIs(RAW)).toBe("u_raw");
    expect(await sessionIds()).toEqual([await sha(RAW)]);
    expect(await whoIs(RAW)).toBe("u_raw");
  });

  it("T4: an expired raw s_ row doesn't sign in and isn't rewritten", async () => {
    await makeUser("u_old");
    await seedSession(RAW, "u_old", Date.now() - 1000);
    expect(await whoIs(RAW)).toBeNull();
    expect(await sessionIds()).toEqual([RAW]);
  });

  it("T8: a raw row without the s_ prefix is never matched", async () => {
    await makeUser("u_x");
    await seedSession("x_abc", "u_x");
    expect(await whoIs("x_abc")).toBeNull();
    expect(await sessionIds()).toEqual(["x_abc"]);
  });
});

describe("a value copied out of the sessions table is not a cookie", () => {
  it("T5: a cookie equal to a stored hash is refused, and signing out with it leaves the row", async () => {
    await makeUser("u_h");
    const hash = await sha(RAW);
    await seedSession(hash, "u_h");
    expect(await whoIs(hash)).toBeNull();
    expect((await post("/auth/logout", {}, hash)).status).toBe(200);
    expect(await sessionIds()).toEqual([hash]);
    expect(await whoIs(RAW)).toBe("u_h");
  });
});

describe("signing out with hashed sessions", () => {
  it("T6: removes a hashed row", async () => {
    await makeUser("u_h");
    await seedSession(await sha(RAW), "u_h");
    expect((await post("/auth/logout", {}, RAW)).status).toBe(200);
    expect(await sessionIds()).toEqual([]);
    expect(await whoIs(RAW)).toBeNull();
  });
  it("T6: removes an unupgraded raw row", async () => {
    await makeUser("u_raw");
    await seedSession(RAW, "u_raw");
    expect((await post("/auth/logout", {}, RAW)).status).toBe(200);
    expect(await sessionIds()).toEqual([]);
    expect(await whoIs(RAW)).toBeNull();
  });
});

describe("changing a password with hashed sessions", () => {
  const OTHER_RAW = "s_otherrawotherrawotherra", OTHER_HASHED = "s_otherhashedotherhashedo";
  for (const current of ["hashed", "raw"] as const) {
    it(`T7: keeps the current ${current} session and ends the person's other sessions of both kinds`, async () => {
      const up = await post("/auth/signup", { username: "changer", password: "first password" });
      expect(up.status).toBe(200);
      const fresh = cookieOf(up);
      const { id: uid } = (await env.DB.prepare("SELECT id FROM users WHERE provider_sub = 'changer'").first<{ id: string }>())!;
      // Make the current session the given kind (whatever sign-up stored), plus one other session of each kind
      await env.DB.prepare("DELETE FROM sessions").run();
      await seedSession(current === "raw" ? fresh : await sha(fresh), uid);
      await seedSession(OTHER_RAW, uid);
      await seedSession(await sha(OTHER_HASHED), uid);
      await makeUser("u_someone");
      await seedSession(await sha(RAW), "u_someone");
      const r = await post("/auth/password", { current: "first password", password: "second password" }, fresh);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      expect(await whoIs(fresh)).toBe(uid);
      expect(await whoIs(OTHER_RAW)).toBeNull();
      expect(await whoIs(OTHER_HASHED)).toBeNull();
      expect(await whoIs(RAW)).toBe("u_someone");
      const ids = await sessionIds();
      expect(ids).not.toContain(OTHER_RAW);
      expect(ids).not.toContain(await sha(OTHER_HASHED));
    });
  }
});
