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
