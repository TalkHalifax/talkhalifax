import { Env, json } from "../env";
import { currentUser, makeResetToken, sameOrigin } from "../auth";
import { setBanned } from "../moderation";

export async function modToolRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Moderators ban people and make password reset links
  const um = path.match(/^\/api\/users\/([A-Za-z0-9_]{1,40})\/(ban|reset)$/);
  if (um && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    if (um[2] === "ban") {
      const b = await req.json<{ banned?: boolean; purge?: boolean }>().catch(() => ({} as { banned?: boolean; purge?: boolean }));
      return setBanned(env, um[1], !!b.banned, !!b.purge);
    }
    const token = await makeResetToken(env, um[1], u.id);
    return token ? json({ url: `${url.origin}/#reset-${token}`, expiresIn: "1 hour" }) : json({ error: "Only accounts with a password can be reset." }, { status: 400 });
  }

  return null;
}
