import { Env, json } from "../env";
import { currentUser } from "../auth";
import { StoryRow, storyOut, STORY_SELECT } from "./story-rows";

export async function userRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // A person's public profile: name, picture, bio and, for the newsroom's journalist, the stories they wrote
  const pu = path.match(/^\/api\/users\/([A-Za-z0-9_]{1,40})$/);
  if (pu) {
    const u = await env.DB.prepare("SELECT id, name, avatar_url, bio, role, provider, created_at FROM users WHERE id = ?").bind(pu[1])
      .first<{ id: string; name: string; avatar_url: string; bio: string; role: string; provider: string; created_at: number }>();
    if (!u) return json({ error: "Not found" }, { status: 404 });
    const ai = u.provider === "newsroom";
    const stories = ai ? (await env.DB.prepare(
      `${STORY_SELECT} WHERE s.author_id = ? AND s.stage IN ('developing', 'archived') AND s.kind != 'skip' ORDER BY s.published_at DESC LIMIT 60`,
    ).bind(u.id).all<StoryRow>()).results.map(r => storyOut(r)) : [];
    const stats = await env.DB.prepare("SELECT COUNT(*) AS messages, COUNT(DISTINCT story_id) AS rooms FROM message_index WHERE user_id = ? AND deleted = 0")
      .bind(u.id).first<{ messages: number; rooms: number }>();
    // Moderators also see whether they're banned and whether a reset link can be made
    const viewer = await currentUser(req, env);
    const mod = viewer?.role === "moderator" && u.id !== viewer.id && !ai && u.role !== "moderator"
      ? { banned: !!(await env.DB.prepare("SELECT banned FROM users WHERE id = ?").bind(u.id).first<{ banned: number }>())?.banned, password: u.provider === "password" }
      : null;
    return json({
      user: { id: u.id, name: u.name, avatar: u.avatar_url, bio: u.bio, role: u.role, ai, joined: u.created_at },
      stats: { messages: stats?.messages ?? 0, rooms: stats?.rooms ?? 0 },
      stories,
      mod,
    });
  }

  return null;
}
