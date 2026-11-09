import { Env, json } from "../env";
import { sameOrigin } from "../auth";
import { statsReport } from "../stats";

export async function pageStatsRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Anonymous counts for the admin site, from open pages
  if (path === "/api/stats" && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    return statsReport(req, env);
  }

  return null;
}
