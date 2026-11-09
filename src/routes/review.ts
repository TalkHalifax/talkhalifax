import { Env, json } from "../env";
import { currentUser, sameOrigin } from "../auth";
import { archiveStory, listDrafts, reopenStory, reviewDraft } from "../stories";

export async function reviewRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Moderators review drafts the newsroom held back (review: true)
  if (path === "/api/review") {
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    return json({ drafts: await listDrafts(env) });
  }
  const rv = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/review$/);
  if (rv && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { action } = await req.json<{ action?: string }>().catch(() => ({ action: "" }));
    if (action !== "approve" && action !== "discard") return json({ error: "action must be approve or discard" }, { status: 400 });
    return (await reviewDraft(env, rv[1], action)) ? json({ ok: true }) : json({ error: "That draft is no longer waiting." }, { status: 409 });
  }

  // Moderators can move a story between Developing and Articles by hand
  const st = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/stage$/);
  if (st && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { stage } = await req.json<{ stage?: string }>().catch(() => ({ stage: "" }));
    const ok = stage === "archived" ? await archiveStory(env, st[1], "moderator") : stage === "developing" ? await reopenStory(env, st[1]) : false;
    return ok ? json({ ok: true }) : json({ error: "Nothing to change." }, { status: 409 });
  }

  return null;
}
