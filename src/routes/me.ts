import { Env, json } from "../env";
import { currentUser, providers } from "../auth";
import { deleteAccount } from "../moderation";

export async function meRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/api/me" && req.method === "GET") {
    const u = await currentUser(req, env);
    return json({
      user: u ? { id: u.id, name: u.name, avatarUrl: u.avatar_url, role: u.role, banned: !!u.banned, password: u.provider === "password" } : null,
      providers: providers(env, url),
    });
  }

  if (path === "/api/me/messages") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Not signed in" }, { status: 401 });
    const rows = await env.DB.prepare(
      `SELECT m.id, m.story_id AS storyId, m.text, m.created_at AS at, s.headline
         FROM message_index m LEFT JOIN stories s ON s.id = m.story_id
        WHERE m.user_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 50`,
    ).bind(u.id).all();
    const stats = await env.DB.prepare(
      `SELECT COUNT(*) AS messages, COUNT(DISTINCT story_id) AS rooms,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today
         FROM message_index WHERE user_id = ? AND deleted = 0`,
    ).bind(Date.now() - 864e5, u.id).first();
    return json({ messages: rows.results, stats });
  }

  // Someone deletes their own account
  if (path === "/api/me" && req.method === "DELETE") {
    if (req.headers.get("origin") !== url.origin) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in first." }, { status: 401 });
    const res = await deleteAccount(env, u);
    res.headers.append("set-cookie", `th_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`);
    return res;
  }

  return null;
}
