import { Env, json } from "../env";
import { allow, currentUser, sameOrigin } from "../auth";
import { listReports, report, resolveReport } from "../moderation";

export async function reportRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Reports: anyone signed in flags a message or comment; moderators review them
  if (path === "/api/reports") {
    const u = await currentUser(req, env);
    if (req.method === "POST") {
      if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
      if (!u) return json({ error: "Sign in to report." }, { status: 401 });
      return report(req, env, u, (k, n, w) => allow(env, k, n, w));
    }
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    return listReports(env);
  }
  const rp = path.match(/^\/api\/reports\/([A-Za-z0-9_]{1,40})$/);
  if (rp && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { action } = await req.json<{ action?: string }>().catch(() => ({ action: "" }));
    if (action !== "remove" && action !== "dismiss") return json({ error: "action must be remove or dismiss" }, { status: 400 });
    return (await resolveReport(env, rp[1], action)) ? json({ ok: true }) : json({ error: "That report was already handled." }, { status: 409 });
  }

  return null;
}
