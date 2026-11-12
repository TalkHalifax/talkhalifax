// Sign-in with one username and password, both admin Worker secrets the editor sets. The simpler front door, used while
// Cloudflare Access isn't set up. A signed cookie keeps the editor in for 12 hours; changing the password signs everyone out.
export interface PasswordEnv {
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  /** Caps sign-in attempts per IP address. Without it, password sign-in is refused (503). */
  LOGIN_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export const SESSION_COOKIE = "__Host-th-admin";
export const MIN_PASSWORD = 16;
const SESSION_MS = 12 * 36e5, MAX_FORM = 4096;
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));

/** Both secrets set, and the password long enough to stand up to guessing. Otherwise nobody gets in this way. */
export const passwordReady = (env: PasswordEnv) => !!env.ADMIN_USER && (env.ADMIN_PASSWORD?.length ?? 0) >= MIN_PASSWORD;

/** The session key comes from the credentials, so changing either one ends every session. */
const sessionKey = (env: PasswordEnv) => crypto.subtle.importKey("raw", enc.encode(`talkhalifax-admin\n${env.ADMIN_USER}\n${env.ADMIN_PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** Compared in constant time, both always, so the answer's timing doesn't say which one was wrong. */
export async function rightCredentials(env: PasswordEnv, user: string, password: string): Promise<boolean> {
  const digest = async (s: string) => crypto.subtle.digest("SHA-256", enc.encode(s));
  const [a, b, c, d] = await Promise.all([digest(user), digest(env.ADMIN_USER || ""), digest(password), digest(env.ADMIN_PASSWORD || "")]);
  const userOk = crypto.subtle.timingSafeEqual(a, b), passOk = crypto.subtle.timingSafeEqual(c, d);
  return userOk && passOk && passwordReady(env);
}

export async function newSession(env: PasswordEnv, now: number): Promise<string> {
  const exp = now + SESSION_MS;
  return `${exp}.${b64u(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(`session:${exp}`)))}`;
}

/** True only for a cookie this Worker signed with today's credentials, that hasn't run out. Never throws. */
export async function validSession(env: PasswordEnv, token: string | undefined, now: number): Promise<boolean> {
  try {
    const m = token?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
    if (!m || !passwordReady(env)) return false;
    const exp = Number(m[1]);
    if (exp <= now || exp > now + SESSION_MS + 60_000) return false;
    return await crypto.subtle.verify("HMAC", await sessionKey(env), unb64u(m[2]), enc.encode(`session:${exp}`));
  } catch {
    return false;
  }
}

export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
export const clearedCookie = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The sign-in form's fields, or null if it's too big. A chunked request has no length, so the bytes are what's counted. */
export async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (Number(req.headers.get("content-length") || 0) > MAX_FORM) return null;
  if (!req.body) return new URLSearchParams();
  const reader = req.body.getReader(), decoder = new TextDecoder();
  let text = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new URLSearchParams(text + decoder.decode());
    size += value.length;
    if (size > MAX_FORM) { await reader.cancel(); return null; }
    text += decoder.decode(value, { stream: true });
  }
}

/** The sign-in page. Messages are fixed text, never anything from the request. */
export function loginPage(message = "", status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · TalkHalifax Admin</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=Inter+Tight:wght@600;700&display=swap">
<link rel="stylesheet" href="/admin.css">
</head>
<body>
<main class="signin-page">
  <form class="card signin" method="post" action="/login">
    <div class="brand">TalkHalifax<small>Admin</small></div>
    <h1 class="h1">Sign in</h1>
    ${message ? `<p class="error" role="alert">${message}</p>` : ""}
    <label for="user">Username</label>
    <input id="user" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" maxlength="500" required>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
