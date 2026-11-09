import { Env, json } from "../env";
import { allow, currentUser, sameOrigin } from "../auth";
import { addComment, deleteComment, listComments } from "../stories";

export async function commentRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Threaded comments, once a story has moved to Articles
  const cm = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/comments$/);
  if (cm) {
    if (req.method === "GET") return listComments(env, cm[1]);
    if (req.method !== "POST" || !sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in to comment." }, { status: 401 });
    return addComment(req, env, cm[1], u, (k, n, w) => allow(env, k, n, w));
  }
  const cd = path.match(/^\/api\/comments\/([A-Za-z0-9_]{1,40})$/);
  if (cd && req.method === "DELETE") {
    if (req.headers.get("origin") !== url.origin) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in first." }, { status: 401 });
    return deleteComment(env, cd[1], u);
  }

  return null;
}
