// The admin site's Worker. Stage 1 is read-only: every data route is a GET, and it has no database of its own. It reads
// platform data only through PLATFORM, a service binding to the main Worker's read-only AdminApi entrypoint.
// It never returns email addresses, password hashes, the journalist's private persona, or Google account ids.
// The front door is Cloudflare Access when that's set up, otherwise the editor's username and password.
import { validAccessToken, validTeam } from "./access";
import {
  clearedCookie, cookieValue, loginPage, newSession, PasswordEnv, passwordReady, readForm, rightCredentials,
  SESSION_COOKIE, sessionCookie, validSession,
} from "./password";
import type { AdminApi, ContentArgs, ContentScreen, ContentStatus, Range, UserRole, UsersArgs } from "../../src/routes/admin-api";

export interface AdminEnv extends PasswordEnv {
  /** The platform's read-only admin data: a service binding to the main Worker's AdminApi entrypoint. The only way in to it. */
  PLATFORM: Service<AdminApi>;
  ASSETS: Fetcher;
  /** The Access team's address, like yourteam.cloudflareaccess.com. Without it and ACCESS_AUD, everything is refused. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag. */
  ACCESS_AUD?: string;
  /** "1" skips the Access check on localhost only. Passed by hand for a local run, never set in production. */
  ADMIN_DEV?: string;
}

const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // Nothing to other sites. Not "no-referrer": that makes browsers send "Origin: null" on the sign-in form, which it refuses
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};
const secured = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const NOT_SET_UP = "The admin site isn't set up yet: set its username and password, or its Access settings.";
const sameOrigin = (req: Request, url: URL) => req.headers.get("origin") === url.origin;
const redirect = (to: string, cookie?: string) => new Response(null, { status: 303, headers: { location: to, ...(cookie ? { "set-cookie": cookie } : {}) } });

/** Cloudflare Access's signed token. Either setting present means Access is the front door, so a half-done setup refuses. */
async function accessGate(req: Request, env: AdminEnv, now: number): Promise<Response | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !validTeam(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) return new Response(NOT_SET_UP, { status: 503 });
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !await validAccessToken(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, now)) return new Response("Sign in through Cloudflare Access.", { status: 403 });
  return null;
}

/** The username and password. Answers the sign-in page itself; otherwise null for a signed-in request, or a refusal. */
async function passwordGate(req: Request, env: AdminEnv, url: URL, now: number): Promise<Response | null> {
  const signedIn = await validSession(env, cookieValue(req, SESSION_COOKIE), now);
  if (url.pathname === "/login") {
    if (req.method === "GET" || req.method === "HEAD") return signedIn ? redirect("/") : loginPage();
    if (req.method !== "POST") return new Response("Not allowed", { status: 405, headers: { allow: "GET, POST" } });
    if (!sameOrigin(req, url)) return new Response("Bad request", { status: 403 });
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    if (!env.LOGIN_LIMIT) return loginPage("Sign-in is switched off until it's set up properly.", 503);
    if (!(await env.LOGIN_LIMIT.limit({ key: ip })).success) return loginPage("Too many tries. Wait a minute, then try again.", 429);
    const form = await readForm(req);
    if (!form) return loginPage("That didn't work. Try again.", 413);
    if (!await rightCredentials(env, form.get("user") || "", form.get("password") || "")) return loginPage("That username and password don't match.", 401);
    return redirect("/", sessionCookie(await newSession(env, now)));
  }
  // The stylesheet only, so the sign-in page has its look. Pages, scripts and data all need a session.
  if (signedIn || (url.pathname === "/admin.css" && req.method === "GET")) return null;
  if (url.pathname.startsWith("/api/")) return json({ error: "Sign in first" }, 401);
  return req.method === "GET" || req.method === "HEAD" ? redirect("/login") : new Response("Sign in first", { status: 401 });
}

/** A refusal, or null to let the request through. With neither front door set up, nobody gets in. */
async function refuse(req: Request, env: AdminEnv, url: URL, now: number): Promise<Response | null> {
  if (env.ADMIN_DEV === "1" && isLocal(url.hostname)) return null;
  if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) return accessGate(req, env, now);
  if (passwordReady(env)) return passwordGate(req, env, url, now);
  return new Response(NOT_SET_UP, { status: 503 });
}

// ---------- the query string, read the way the panel has always sent it ----------

const RANGES: Record<Range, true> = { "24h": true, "7d": true, "30d": true };
const ROLES: Record<UserRole, true> = { all: true, member: true, moderator: true, journalist: true, banned: true };
const SCREENS: Record<ContentScreen, true> = { all: true, Developing: true, Articles: true, Notices: true, Events: true };
const STATUSES: Record<ContentStatus, true> = { all: true, waiting: true, active: true, archived: true };

/** Only the record's own keys count, so "constructor", "__proto__" and the like are unknown. */
const known = <T extends string>(allowed: Record<T, true>, x: string): x is T => Object.hasOwn(allowed, x);

/** The furthest a users page may start, the same cap AdminApi checks. */
const MAX_OFFSET = 100_000;

const rangeOf = (p: URLSearchParams): Range => {
  const r = p.get("range") ?? "";
  return known(RANGES, r) ? r : "7d";
};

function usersOf(p: URLSearchParams): UsersArgs {
  const role = p.get("role") || "all";
  const args: UsersArgs = {
    q: p.get("q") ?? "",
    role: known(ROLES, role) ? role : "all",
    offset: Math.min(MAX_OFFSET, Math.floor(Math.max(0, Number(p.get("offset")) || 0))),
  };
  return args;
}

/** /api/content. A screen or status the panel doesn't know has always matched nothing, so it still answers an empty list. */
async function contentFor(env: AdminEnv, p: URLSearchParams) {
  const screen = p.get("screen") || "all", status = p.get("status") || "all";
  const args: ContentArgs = {
    screen: known(SCREENS, screen) ? screen : "all",
    status: known(STATUSES, status) ? status : "all",
    q: p.get("q") ?? "",
  };
  const page = await env.PLATFORM.content(args);
  if (known(SCREENS, screen) && known(STATUSES, status)) return page;
  return { items: [], total: 0, limit: page.limit };
}

/** The data routes, each one call to PLATFORM. Its refusal of bad arguments is a 400; anything else goes to handle()'s 500. */
async function api(url: URL, env: AdminEnv): Promise<Response> {
  const p = url.searchParams;
  try {
    switch (url.pathname) {
      case "/api/summary": return json(await env.PLATFORM.summary());
      case "/api/overview": return json(await env.PLATFORM.overview(rangeOf(p)));
      case "/api/users": return json(await env.PLATFORM.users(usersOf(p)));
      case "/api/content": return json(await contentFor(env, p));
      case "/api/data": return json(await env.PLATFORM.dataSources());
      case "/api/jobs": return json(await env.PLATFORM.jobs());
      default: return json({ error: "Not found" }, 404);
    }
  } catch (e) {
    if (e instanceof Error && e.message === "Bad request") return json({ error: "Bad request" }, 400);
    throw e;
  }
}

export async function handle(req: Request, env: AdminEnv, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  try {
    const no = await refuse(req, env, url, now);
    if (no) return secured(no);
    if (url.pathname === "/logout" && req.method === "POST") return secured(sameOrigin(req, url) ? redirect("/", clearedCookie) : new Response("Bad request", { status: 403 }));
    if (req.method !== "GET" && req.method !== "HEAD") return secured(new Response("This site is read-only.", { status: 405, headers: { allow: "GET, HEAD" } }));
    return secured(url.pathname.startsWith("/api/") ? await api(url, env) : await env.ASSETS.fetch(req));
  } catch (e) {
    console.error(e);
    return secured(json({ error: "Something went wrong" }, 500));
  }
}

export default { fetch: (req: Request, env: AdminEnv) => handle(req, env) } satisfies ExportedHandler<AdminEnv>;
