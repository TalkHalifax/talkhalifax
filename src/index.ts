import { Env, json, SITE } from "./env";
import { currentUser, handleAuth } from "./auth";
import { newsroom } from "./stories";
import { mcp } from "./mcp";
import { getAlerts } from "./alerts";
import { getWeather } from "./weather";
import { telegramWebhook, tellEditor } from "./telegram";
import { transit } from "./transit";
import { events, ingestEvents } from "./events";
import { pushApi } from "./push";
import { CRON_JOBS } from "./routes/cron-jobs";
import { meRoutes } from "./routes/me";
import { storyRoutes } from "./routes/stories";
import { userRoutes } from "./routes/users";
import { reportRoutes } from "./routes/reports";
import { modToolRoutes } from "./routes/mod-tools";
import { pageStatsRoutes } from "./routes/page-stats";
import { commentRoutes } from "./routes/comments";
import { reviewRoutes } from "./routes/review";
export { ArticleRoom } from "./room";
export { StatsHub } from "./stats";
export { AdminApi } from "./routes/admin-api";

async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const mine = (await meRoutes(req, env, url)) ?? (await storyRoutes(req, env, url)) ?? (await userRoutes(req, env, url))
    ?? (await reportRoutes(req, env, url)) ?? (await modToolRoutes(req, env, url)) ?? (await pageStatsRoutes(req, env, url));
  if (mine) return mine;

  if (path === "/api/weather") return json({ weather: await getWeather(env, ctx) });
  if (path === "/api/alerts") return json({ alerts: await getAlerts(env, ctx) });
  if (path.startsWith("/api/transit/")) return transit(path);
  if (path === "/api/events") return events(env);
  if (path === "/api/events/ingest") return ingestEvents(req, env);
  if (path === "/api/push" || path.startsWith("/api/push/")) return pushApi(req, env, url);

  // The newsroom (Claude) publishes and updates stories here, with its own token
  if (path.startsWith("/api/newsroom/")) return newsroom(req, env, url);

  return (await commentRoutes(req, env, url)) ?? (await reviewRoutes(req, env, url)) ?? json({ error: "Not found" }, { status: 404 });
}

/** Upgrade to the story's ArticleRoom, passing who this is. Client-sent x-th-* headers are never forwarded. */
async function room(req: Request, env: Env, id: string): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const story = await env.DB.prepare("SELECT kind, stage FROM stories WHERE id = ?").bind(id).first<{ kind: string; stage: string }>();
  if (!story || story.kind !== "article" || story.stage !== "developing") return new Response("This story has no live chat", { status: 404 });
  const u = await currentUser(req, env);
  const headers = new Headers({ upgrade: "websocket", "x-th-story": id });
  if (u) { headers.set("x-th-user", u.id); headers.set("x-th-role", u.role); headers.set("x-th-banned", u.banned ? "1" : "0"); }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
  return stub.fetch(new Request(`https://room/${encodeURIComponent(id)}`, { headers }));
}

/** Tell the editor when a cron job fails twice in a row, and once more when it recovers. Counts live in feeds ('cron-health'). */
const CRON_ALERT_AFTER = 2;
async function watchCron(env: Env, results: (readonly [string, PromiseSettledResult<unknown>])[]) {
  const row = await env.DB.prepare("SELECT body FROM feeds WHERE name = 'cron-health'").first<{ body: string }>();
  const fails: Record<string, number> = row ? JSON.parse(row.body) : {};
  const notes: string[] = [];
  for (const [name, r] of results) {
    const before = fails[name] || 0;
    if (r.status === "rejected") {
      console.error(`cron ${name}:`, r.reason);
      fails[name] = before + 1;
      if (fails[name] === CRON_ALERT_AFTER) notes.push(`⚠️ <b>${name}</b> has failed ${CRON_ALERT_AFTER} runs in a row: ${String((r.reason as Error)?.message ?? r.reason).replace(/[&<>]/g, "").slice(0, 300)}`);
    } else {
      if (before >= CRON_ALERT_AFTER) notes.push(`✅ <b>${name}</b> is working again after ${before} failed runs.`);
      fails[name] = 0;
    }
  }
  await env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('cron-health', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
    .bind(JSON.stringify(fails), new Date().toISOString()).run();
  if (notes.length) await tellEditor(env, `🛠 <b>Site cron</b> (every 30 minutes)\n\n${notes.join("\n")}`);
}

// Readers belong on SITE. The other domains redirect for good. The old workers.dev address redirects only browsers opening
// a page, because the newsroom agents, the Telegram webhook and the Events job still work through it.
const OTHER_DOMAINS = /^(www\.talkhalifax\.ca|(www\.)?talkhalifax\.(com|org))$/;
const OLD_HOST = "talkhalifax.alexwmmolloy.workers.dev";
const BACKEND = /^\/(api|auth|mcp|telegram|rooms)(\/|$)/;
function redirectToSite(req: Request, url: URL) {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const to = SITE + url.pathname + url.search;
  if (OTHER_DOMAINS.test(url.hostname)) return Response.redirect(to, 301);
  if (url.hostname === OLD_HOST && req.headers.get("sec-fetch-mode") === "navigate" && !BACKEND.test(url.pathname)) return Response.redirect(to, 302);
  return null;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const moved = redirectToSite(req, url);
  if (moved) return moved;
  try {
    if (url.pathname.startsWith("/auth/")) return (await handleAuth(req, env, url)) ?? new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) return await api(req, env, url, ctx);
    // The newsroom's MCP server, for Claude agents
    if (url.pathname === "/mcp") return await mcp(req, env);
    // The editor approves drafts from Telegram
    if (url.pathname.startsWith("/telegram/")) return await telegramWebhook(req, env, url);
    const r = url.pathname.match(/^\/rooms\/([A-Za-z0-9_.~-]{1,200})\/ws$/);
    if (r) return await room(req, env, r[1]);
    return env.ASSETS.fetch(req);
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

// Strict-Transport-Security isn't here because the zone already sends it. The Content-Security-Policy only reports for now:
// turn it on once the editor has seen a few days with no real violations.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(self), camera=(), microphone=()", // The Transit map's locate button needs geolocation
  "content-security-policy-report-only": [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://halifax.bibliocommons.com", // Google profile photos, library event photos
    "connect-src 'self' https://tiles.openfreemap.org https://fonts.googleapis.com https://fonts.gstatic.com",
    "worker-src 'self' blob:",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

/** The site's security headers on a response. A WebSocket upgrade passes untouched: live chat depends on it. */
function secured(res: Response): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res); // Asset and redirect responses can't be changed directly
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return secured(await route(req, env, ctx));
  },

  async scheduled(_event: ScheduledController, env: Env) {
    const results = await Promise.allSettled(CRON_JOBS.map(j => j.run(env)));
    await watchCron(env, CRON_JOBS.map((j, i) => [j.key, results[i]] as const));
  },
} satisfies ExportedHandler<Env>;
