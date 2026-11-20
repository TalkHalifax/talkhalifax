// TalkHalifax service worker: the app shell always opens, stories you've read stay readable offline, and push alerts
// for urgent notices arrive here. Everything is network-first, so a deploy shows up on the next load; the caches are
// only a fallback for when there's no connection.
const BUILD = "dev"; // stamped at deploy as v<PR number>; see docs/DESIGN-SYSTEM.md
const VERSION = `th-v8-${BUILD}`;
// DATA is fixed on purpose and must never follow VERSION: saved stories survive every deploy stamp and version bump
const SHELL = `${VERSION}-shell`, DATA = "th-v7-data", FONTS = "th-fonts";
const SHELL_FILES = ["/", "/app.js", "/events.js", "/alerts.js", "/transit.js", "/stats.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/favicon-32.png", "/styles.css", "/api.js", "/chat.js", "/views/home.js", "/views/articles.js", "/views/notices.js", "/views/article.js", "/views/moderation.js", "/views/user.js", "/views/reset.js", "/views/profile.js"];
// Data worth keeping for offline reading; everything else under /api, /auth, /rooms and /mcp always goes to the network
const KEEP = /^\/api\/(stories(\/[^/]+)?|weather|alerts|events|transit\/alerts)$/;
const MAX_STORIES = 60;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Try the network; keep a copy of what worked; fall back to the copy when offline. */
async function networkFirst(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

/** Keep the most recently read stories; drop the oldest beyond MAX_STORIES. */
async function trimStories() {
  const cache = await caches.open(DATA);
  const stories = (await cache.keys()).filter(r => /\/api\/stories\/[^/]+$/.test(new URL(r.url).pathname));
  for (const r of stories.slice(0, Math.max(0, stories.length - MAX_STORIES))) await cache.delete(r);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache first, they never change at a given URL
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => (await c.match(req)) || fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;

  // Pages: the one page, with the hash doing the routing, so any navigation falls back to the cached shell
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "/"));
    return;
  }
  if (KEEP.test(url.pathname)) {
    e.respondWith(networkFirst(req, DATA, url.pathname).then(res => { e.waitUntil(trimStories()); return res; }));
    return;
  }
  if (/^\/(api|auth|rooms|mcp|telegram)\//.test(url.pathname) || url.pathname === "/mcp") return;
  // Static files (scripts, icons, route lines)
  e.respondWith(networkFirst(req, SHELL));
});

// ---------- push alerts (urgent notices the editor chose to send) ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "TalkHalifax", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "TalkHalifax", {
    body: d.body || "",
    tag: d.tag || "talkhalifax",
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    data: { url: d.url || "/#notices" },
    timestamp: d.at || Date.now(),
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) { await win.focus(); return win.navigate(target).catch(() => win.postMessage({ t: "go", url: target })); }
    return self.clients.openWindow(target);
  })());
});

// The browser replaced or dropped this alert subscription. Only while alerts are on: carry the reader's own saved
// choices over to a new address and remove the old one. A new address is kept only if it's saved with those choices;
// otherwise it's dropped, so nobody is signed up for alerts they didn't choose. Each step stands alone, so one failure
// doesn't skip the steps after it.
const pushKeyBytes = k => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((k.length + 3) % 4)), c => c.charCodeAt(0));
const postJson = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    // 1. Alerts must be on; otherwise do nothing at all
    let publicKey = null;
    try {
      const r = await fetch("/api/push");
      const d = r.ok ? await r.json() : null;
      if (d && d.enabled === true && d.publicKey != null) publicKey = d.publicKey;
    } catch (err) { publicKey = null; }
    if (publicKey == null) return;
    const old = e.oldSubscription || null;
    // 2. A new subscription: the browser's, or one made with the site's current key
    let sub = e.newSubscription || null;
    if (!sub) {
      try {
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(publicKey) });
      } catch (err) { sub = null; }
    }
    // 3. The choices saved for the old address
    let status = null;
    if (old) {
      try {
        const r = await postJson("/api/push/status", { endpoint: old.endpoint });
        if (r.ok) status = await r.json();
      } catch (err) { status = null; }
    }
    // 4. Save the new address with those choices; with no choices to carry over, or if saving fails, drop it
    let saved = false;
    if (sub) {
      saved = false;
      if (status && status.subscribed === true) {
        try {
          const r = await postJson("/api/push/subscribe", { subscription: sub.toJSON(), kinds: status.kinds, quiet: status.quiet });
          saved = r.ok;
        } catch (err) { saved = false; }
      }
      if (!saved) {
        try { await sub.unsubscribe().catch(() => {}); } catch (err) { /* nothing more to do */ }
      }
    }
    // 5. Remove the old address, unless the same address was just saved
    if (old && !(saved && sub.endpoint === old.endpoint)) {
      try { await postJson("/api/push/unsubscribe", { endpoint: old.endpoint }); } catch (err) { /* nothing more to do */ }
    }
  })().catch(() => {}));
});
