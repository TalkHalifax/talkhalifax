import { Env, json } from "../env";
import { StoryRow, storyOut, STORY_SELECT } from "./story-rows";

export async function storyRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/api/stories") {
    const rows = await env.DB.prepare(`${STORY_SELECT} WHERE s.stage IN ('developing', 'archived') ORDER BY s.published_at DESC LIMIT 200`).all<StoryRow>();
    return json({ stories: rows.results.map(r => storyOut(r)) });
  }

  const one = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})$/);
  if (one) {
    const r = await env.DB.prepare(`${STORY_SELECT} WHERE s.id = ? AND s.stage IN ('developing', 'archived')`).bind(one[1]).first<StoryRow>();
    return r ? json({ story: storyOut(r, true) }) : json({ error: "Not found" }, { status: 404 });
  }

  return null;
}
