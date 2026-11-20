// The service worker's pushsubscriptionchange handler, run in a sandbox with a fake browser and a fake server: what it
// asks the server, what it saves, what it removes, and that it never logs an alert address or key. The behaviour checked
// is the one Trust & Safety ruled for job #57 (docs/PLATFORM.md, "Alerts"). Called from routes.mjs before the Worker
// starts; the second parameter lets a check run against a changed handler held in memory.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORIGIN = "https://sw-push.test";
const OLD = "https://push.example.test/sw-push-OLD-marker-7f3a";
const NEW = "https://push.example.test/sw-push-NEW-marker-7f3a";
const SUBSCRIBED = "https://push.example.test/sw-push-SUBSCRIBED-marker-7f3a";
const PUBKEY = "SWPushMarkerPublicKey_case3-xyz0";
const PUBKEY_BYTES = Array.from(Buffer.from(PUBKEY, "base64url")).join(",");
const OLD_KEY_BYTES = Array.from(Buffer.from("sw-push-OLD-key-marker-7f3a-bytes")).join(",");
const P256DH = "sw-push-p256dh-marker", AUTH = "sw-push-auth-marker";
const KINDS = ["sw-push-kind-marker-a", "sw-push-kind-marker-b"];
const QUIET = { start: 1320, end: 420 };
const MARKERS = [OLD, NEW, SUBSCRIBED, "sw-push-OLD-marker-7f3a", "sw-push-NEW-marker-7f3a", "sw-push-SUBSCRIBED-marker-7f3a", PUBKEY, P256DH, AUTH];
const P_PUSH = "/api/push", P_STATUS = "/api/push/status", P_SUB = "/api/push/subscribe", P_UNSUB = "/api/push/unsubscribe";
const REJECT = "reject";
const TIMEOUT = 2000;

// The Stage 1 privacy wording, and what must sit beside it in public/index.html
const PRIVACY_HAS = [
  "Blocking notifications in your browser stops them too; the address is deleted once your browser's push service tells us it's no longer valid, which we find out the next time we try to send it an alert",
  "repeated changes to, or checks of, alert settings",
  "that you changed or checked your alerts",
  "alert changes and checks beside your IP address",
  "or that your browser renewed them",
];
const PRIVACY_NOT = ["the next time an alert can't be delivered"];

const defaults = () => ({
  [P_PUSH]: { status: 200, data: { enabled: true, publicKey: PUBKEY } },
  [P_STATUS]: { status: 200, data: { subscribed: true, kinds: [...KINDS], quiet: { ...QUIET } } },
  [P_SUB]: { status: 200, data: { ok: true } },
  [P_UNSUB]: { status: 200, data: { ok: true } },
});

const oldKey = () => new Uint8Array(Buffer.from("sw-push-OLD-key-marker-7f3a-bytes"));

/** A fake PushSubscription that counts its unsubscribe() calls. */
function fakeSub(endpoint, { key = null, rejectUnsubscribe = false } = {}) {
  let calls = 0;
  const sub = {
    endpoint,
    toJSON() { return { endpoint, keys: { p256dh: P256DH, auth: AUTH } }; },
    unsubscribe() { calls++; return rejectUnsubscribe ? Promise.reject(new Error("unsubscribe failed")) : Promise.resolve(true); },
  };
  if (key) sub.options = { userVisibleOnly: true, applicationServerKey: key };
  return { sub, calls: () => calls };
}

// Objects made inside the sandbox have its own prototypes, so nothing here uses instanceof or deepStrictEqual
const bytes = k => {
  if (k == null) return "";
  if (typeof k === "string") return `string:${k}`;
  if (ArrayBuffer.isView(k)) return Array.from(new Uint8Array(k.buffer, k.byteOffset, k.byteLength)).join(",");
  if (Object.prototype.toString.call(k) === "[object ArrayBuffer]") return Array.from(new Uint8Array(k)).join(",");
  return "";
};
const parse = b => { try { return JSON.parse(b); } catch { return undefined; } };
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const seq = r => r.fetches.map(f => `${f.method} ${f.url}`);
const bodiesTo = (r, path) => r.fetches.filter(f => f.method === "POST" && f.url === path).map(f => parse(f.body));
const show = a => {
  let s = "";
  try { s += String(a); } catch { /* not printable */ }
  try { s += ` ${JSON.stringify(a)}`; } catch { /* not serialisable */ }
  return s;
};
const savedSub = (b, endpoint) => !!b && b.subscription?.endpoint === endpoint && b.subscription?.keys?.p256dh === P256DH && b.subscription?.keys?.auth === AUTH;
const savedKinds = b => !!b && Array.isArray(b.kinds) && b.kinds.length === KINDS.length && b.kinds.every((k, i) => k === KINDS[i]);
const savedQuiet = b => !!b && !!b.quiet && b.quiet.start === QUIET.start && b.quiet.end === QUIET.end;

/**
 * Runs public/sw.js in a fresh sandbox, fires one pushsubscriptionchange event and waits for it. Returns what the
 * handler did, or null if it couldn't be fired (the failure is already reported under the case's label).
 */
async function fire(ok, script, L, { answers = defaults(), old = null, neu = null, pushSubscribe }) {
  const handlers = {}, fetches = [], log = [], subscribeCalls = [], consoleCalls = [];
  const fetchFake = (input, init) => {
    const raw = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : String(input));
    const u = new URL(raw, `${ORIGIN}/`);
    const url = u.origin === ORIGIN ? u.pathname + u.search : u.href;
    const method = String(init?.method ?? "GET").toUpperCase();
    fetches.push({ url, method, headers: init?.headers, body: init?.body });
    log.push(`${method} ${url}`);
    const a = answers[url];
    if (a === REJECT) return Promise.reject(new TypeError("Failed to fetch"));
    if (a === undefined) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "Not found" }), text: async () => '{"error":"Not found"}' });
    const text = JSON.stringify(a.data ?? null);
    return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => JSON.parse(text), text: async () => text });
  };
  const cache = { addAll: async () => {}, put: async () => {}, match: async () => undefined, keys: async () => [], delete: async () => true };
  const sandbox = {
    fetch: fetchFake,
    location: { origin: ORIGIN, href: `${ORIGIN}/` },
    URL, atob, btoa, Uint8Array,
    console: new Proxy({}, { get: (_, name) => (...args) => { consoleCalls.push({ name: String(name), args }); } }),
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    skipWaiting: async () => {},
    registration: {
      pushManager: {
        subscribe(opts) { subscribeCalls.push(opts); log.push("pushManager.subscribe"); return pushSubscribe(); },
        getSubscription: async () => null,
      },
      showNotification: async () => {},
    },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  try {
    script.runInContext(ctx);
  } catch (err) {
    ok(false, `${L}: public/sw.js runs`, err?.message ?? String(err));
    return null;
  }
  const hs = handlers.pushsubscriptionchange || [];
  ok(hs.length === 1, `${L}: exactly one pushsubscriptionchange handler is registered`, `found ${hs.length}`);
  if (hs.length !== 1) return null;

  const captured = [];
  const e = { oldSubscription: old, newSubscription: neu, waitUntil(p) { captured.push(p); } };
  let threw = null;
  try { hs[0].call(sandbox, e); } catch (err) { threw = err; }
  ok(!threw, `${L}: the handler doesn't throw`, threw ? (threw.message ?? String(threw)) : "");
  ok(captured.length === 1, `${L}: waitUntil is called once`, `called ${captured.length}`);
  let settled = "no promise";
  if (captured.length) {
    let timer;
    settled = await Promise.race([
      Promise.resolve(captured[0]).then(() => "resolved", () => "rejected"),
      new Promise(r => { timer = setTimeout(() => r("timed out"), TIMEOUT); }),
    ]);
    clearTimeout(timer);
  }
  ok(settled === "resolved", `${L}: the waitUntil promise resolves within ${TIMEOUT / 1000} s`, settled);

  const r = { fetches, log, subscribeCalls, consoleCalls };
  // Checked on every case and variant: JSON POSTs, and nothing logged
  const posts = fetches.filter(f => f.method === "POST");
  ok(posts.every(f => !!f.headers && typeof f.headers === "object" && f.headers["content-type"] === "application/json"), `${L}: every POST sends content-type: application/json`, `${posts.length} POSTs`);
  ok(posts.every(f => typeof f.body === "string" && parse(f.body) !== undefined), `${L}: every POST body is a JSON string`);
  ok(consoleCalls.length === 0, `${L}: nothing is logged`, consoleCalls.map(c => `console.${c.name}`).join(", "));
  const leaked = consoleCalls.flatMap(c => c.args).some(a => { const s = show(a); return MARKERS.some(m => s.includes(m)); });
  ok(!leaked, `${L}: no log carries an alert address, the public key or the subscription keys`);
  return r;
}

/** Each case on its own: an exception fails that case by name and never escapes checkSwPush. */
async function guard(ok, label, fn) {
  try { await fn(); } catch (err) { ok(false, `sw push: ${label}: threw`, err?.message ?? String(err)); }
}

const resolveWith = f => () => Promise.resolve(f.sub);
const rejectSubscribe = () => Promise.reject(new Error("subscribe failed"));
const neverSubscribe = () => Promise.reject(new Error("pushManager.subscribe should not be called"));

export async function checkSwPush(ok, source = readFileSync("public/sw.js", "utf8")) {
  // Checked once: no logging anywhere in the handler, and the privacy wording
  try {
    const at = source.indexOf("pushsubscriptionchange");
    ok(at !== -1, "sw push: public/sw.js handles pushsubscriptionchange");
    ok(at !== -1 && !source.slice(at).includes("console."), "sw push: nothing from the pushsubscriptionchange handler to the end of public/sw.js calls console.");
  } catch (err) {
    ok(false, "sw push: source check: threw", err?.message ?? String(err));
  }
  try {
    const html = readFileSync("public/index.html", "utf8");
    for (const s of PRIVACY_HAS) ok(html.includes(s), `sw push: privacy text: public/index.html says "${s}"`);
    for (const s of PRIVACY_NOT) ok(!html.includes(s), `sw push: privacy text: public/index.html no longer says "${s}"`);
  } catch (err) {
    ok(false, "sw push: privacy text: threw", err?.message ?? String(err));
  }

  let script;
  try {
    script = new vm.Script(source, { filename: "public/sw.js" });
  } catch (err) {
    ok(false, "sw push: public/sw.js compiles", err?.message ?? String(err));
    return;
  }

  // 1. New and old subscriptions, status subscribed:true: carry the choices over, remove the old address
  await guard(ok, "case 1", async () => {
    const L = "sw push: case 1";
    const old = fakeSub(OLD, { key: oldKey() }), neu = fakeSub(NEW);
    const r = await fire(ok, script, L, { old: old.sub, neu: neu.sub, pushSubscribe: neverSubscribe });
    if (!r) return;
    const want = [`GET ${P_PUSH}`, `POST ${P_STATUS}`, `POST ${P_SUB}`, `POST ${P_UNSUB}`];
    ok(sameList(seq(r), want), `${L}: fetches are exactly GET ${P_PUSH}, POST status, POST subscribe, POST unsubscribe`, seq(r).join(", "));
    const [status] = bodiesTo(r, P_STATUS), [saved] = bodiesTo(r, P_SUB), [removed] = bodiesTo(r, P_UNSUB);
    ok(status?.endpoint === OLD && Object.keys(status).length === 1, `${L}: the status body is {endpoint: OLD}`);
    ok(savedSub(saved, NEW), `${L}: the subscribe body's subscription is NEW toJSON()`);
    ok(savedKinds(saved), `${L}: the subscribe body carries the saved kinds`);
    ok(savedQuiet(saved), `${L}: the subscribe body carries the saved quiet hours`);
    ok(removed?.endpoint === OLD && Object.keys(removed).length === 1, `${L}: the unsubscribe body is {endpoint: OLD}`);
    ok(r.subscribeCalls.length === 0, `${L}: pushManager.subscribe is called 0 times`, `called ${r.subscribeCalls.length}`);
    ok(neu.calls() === 0, `${L}: NEW unsubscribe() is called 0 times`, `called ${neu.calls()}`);
  });

  // 2. Old subscription only, with a key: subscribe with the server's current key, never the old one
  await guard(ok, "case 2", async () => {
    const L = "sw push: case 2";
    const key = oldKey();
    const old = fakeSub(OLD, { key }), made = fakeSub(SUBSCRIBED);
    const r = await fire(ok, script, L, { old: old.sub, pushSubscribe: resolveWith(made) });
    if (!r) return;
    ok(r.log[0] === `GET ${P_PUSH}`, `${L}: GET ${P_PUSH} runs first`, r.log.join(", "));
    ok(r.log.indexOf("pushManager.subscribe") > r.log.indexOf(`GET ${P_PUSH}`), `${L}: pushManager.subscribe comes after the GET`, r.log.join(", "));
    ok(r.subscribeCalls.length === 1, `${L}: pushManager.subscribe is called once`, `called ${r.subscribeCalls.length}`);
    const opts = r.subscribeCalls[0];
    ok(opts?.userVisibleOnly === true, `${L}: it subscribes with userVisibleOnly true`);
    ok(bytes(opts?.applicationServerKey) === PUBKEY_BYTES, `${L}: it subscribes with the public key from GET ${P_PUSH}, converted to bytes`);
    ok(bytes(opts?.applicationServerKey) !== OLD_KEY_BYTES && opts?.applicationServerKey !== key, `${L}: it doesn't reuse the old subscription's key`);
    const want = [`GET ${P_PUSH}`, `POST ${P_STATUS}`, `POST ${P_SUB}`, `POST ${P_UNSUB}`];
    ok(sameList(seq(r), want), `${L}: then status, subscribe and unsubscribe`, seq(r).join(", "));
    const [status] = bodiesTo(r, P_STATUS), [saved] = bodiesTo(r, P_SUB), [removed] = bodiesTo(r, P_UNSUB);
    ok(status?.endpoint === OLD, `${L}: the status body is {endpoint: OLD}`);
    ok(savedSub(saved, SUBSCRIBED), `${L}: the subscribe body's subscription is SUBSCRIBED toJSON()`);
    ok(savedKinds(saved), `${L}: the subscribe body carries the saved kinds`);
    ok(savedQuiet(saved), `${L}: the subscribe body carries the saved quiet hours`);
    ok(removed?.endpoint === OLD, `${L}: the unsubscribe body is {endpoint: OLD}`);
    ok(made.calls() === 0, `${L}: SUBSCRIBED unsubscribe() is called 0 times`, `called ${made.calls()}`);
  });

  // 3. No old subscription and no new one: nothing to carry over, so the new browser subscription is dropped again
  await guard(ok, "case 3", async () => {
    const L = "sw push: case 3";
    const made = fakeSub(SUBSCRIBED);
    const r = await fire(ok, script, L, { pushSubscribe: resolveWith(made) });
    if (!r) return;
    ok(sameList(seq(r), [`GET ${P_PUSH}`]), `${L}: fetches are exactly GET ${P_PUSH}`, seq(r).join(", "));
    ok(r.subscribeCalls.length === 1, `${L}: pushManager.subscribe is called once`, `called ${r.subscribeCalls.length}`);
    ok(bytes(r.subscribeCalls[0]?.applicationServerKey) === PUBKEY_BYTES, `${L}: it subscribes with the public key from GET ${P_PUSH}, converted to bytes`);
    ok(bodiesTo(r, P_STATUS).length === 0, `${L}: no status POST`);
    ok(bodiesTo(r, P_SUB).length === 0, `${L}: no subscribe POST`);
    ok(bodiesTo(r, P_UNSUB).length === 0, `${L}: no unsubscribe POST`);
    ok(made.calls() === 1, `${L}: SUBSCRIBED unsubscribe() is called once`, `called ${made.calls()}`);
  });

  // 4. Old and new subscriptions, but no saved choices to carry over: save nothing, drop NEW, remove OLD
  for (const [variant, answer] of [["subscribed false", { status: 200, data: { subscribed: false } }], ["status 500", { status: 500, data: { error: "Server error" } }], ["status rejects", REJECT]]) {
    await guard(ok, `case 4[${variant}]`, async () => {
      const L = `sw push: case 4[${variant}]`;
      const old = fakeSub(OLD, { key: oldKey() }), neu = fakeSub(NEW);
      const r = await fire(ok, script, L, { answers: { ...defaults(), [P_STATUS]: answer }, old: old.sub, neu: neu.sub, pushSubscribe: neverSubscribe });
      if (!r) return;
      ok(sameList(seq(r), [`GET ${P_PUSH}`, `POST ${P_STATUS}`, `POST ${P_UNSUB}`]), `${L}: fetches are exactly GET ${P_PUSH}, POST status, POST unsubscribe`, seq(r).join(", "));
      const [removed] = bodiesTo(r, P_UNSUB);
      ok(removed?.endpoint === OLD, `${L}: the unsubscribe body is {endpoint: OLD}`);
      ok(bodiesTo(r, P_SUB).length === 0, `${L}: no subscribe POST`);
      ok(neu.calls() === 1, `${L}: NEW unsubscribe() is called once`, `called ${neu.calls()}`);
    });
  }

  // 5. The new endpoint is the old one: save it, and don't remove the address just saved
  await guard(ok, "case 5", async () => {
    const L = "sw push: case 5";
    const old = fakeSub(OLD, { key: oldKey() }), same = fakeSub(OLD);
    const r = await fire(ok, script, L, { old: old.sub, neu: same.sub, pushSubscribe: neverSubscribe });
    if (!r) return;
    ok(sameList(seq(r), [`GET ${P_PUSH}`, `POST ${P_STATUS}`, `POST ${P_SUB}`]), `${L}: fetches are exactly GET ${P_PUSH}, POST status, POST subscribe`, seq(r).join(", "));
    ok(bodiesTo(r, P_UNSUB).length === 0, `${L}: no unsubscribe POST`);
    ok(same.calls() === 0 && old.calls() === 0, `${L}: unsubscribe() is called 0 times`, `new ${same.calls()}, old ${old.calls()}`);
  });

  // 6. The server refuses to save NEW: drop it, and still remove OLD
  for (const [variant, answer] of [["subscribe 429", { status: 429, data: { error: "Too many requests" } }], ["subscribe 503", { status: 503, data: { error: "Unavailable" } }], ["subscribe rejects", REJECT]]) {
    await guard(ok, `case 6[${variant}]`, async () => {
      const L = `sw push: case 6[${variant}]`;
      const old = fakeSub(OLD, { key: oldKey() }), neu = fakeSub(NEW);
      const r = await fire(ok, script, L, { answers: { ...defaults(), [P_SUB]: answer }, old: old.sub, neu: neu.sub, pushSubscribe: neverSubscribe });
      if (!r) return;
      ok(neu.calls() === 1, `${L}: NEW unsubscribe() is called once`, `called ${neu.calls()}`);
      const removed = bodiesTo(r, P_UNSUB);
      ok(removed.length === 1 && removed[0]?.endpoint === OLD, `${L}: unsubscribe {endpoint: OLD} is still POSTed`, `${removed.length} unsubscribe POSTs`);
    });
  }

  // 7. Alerts are off, or the server can't say: do nothing beyond the GET
  const off = [
    ["case 7a", "enabled false", { status: 200, data: { enabled: false, publicKey: PUBKEY } }],
    ["case 7b", "publicKey null", { status: 200, data: { enabled: true, publicKey: null } }],
    ["case 7c[GET rejects]", "GET rejects", REJECT],
    ["case 7c[GET 500]", "GET 500", { status: 500, data: { error: "Server error" } }],
  ];
  for (const [name, , answer] of off) {
    await guard(ok, name, async () => {
      const L = `sw push: ${name}`;
      const old = fakeSub(OLD, { key: oldKey() });
      const r = await fire(ok, script, L, { answers: { ...defaults(), [P_PUSH]: answer }, old: old.sub, pushSubscribe: neverSubscribe });
      if (!r) return;
      ok(sameList(seq(r), [`GET ${P_PUSH}`]), `${L}: fetches are exactly GET ${P_PUSH}`, seq(r).join(", "));
      ok(r.subscribeCalls.length === 0, `${L}: pushManager.subscribe is called 0 times`, `called ${r.subscribeCalls.length}`);
      ok(bodiesTo(r, P_STATUS).length === 0, `${L}: no status POST`);
      ok(bodiesTo(r, P_SUB).length === 0, `${L}: no subscribe POST`);
      ok(bodiesTo(r, P_UNSUB).length === 0, `${L}: no unsubscribe POST`);
    });
  }
  // 7d. Alerts off, and the browser handed over a new subscription: leave it alone too
  await guard(ok, "case 7d", async () => {
    const L = "sw push: case 7d";
    const old = fakeSub(OLD, { key: oldKey() }), neu = fakeSub(NEW);
    const r = await fire(ok, script, L, { answers: { ...defaults(), [P_PUSH]: { status: 200, data: { enabled: false, publicKey: PUBKEY } } }, old: old.sub, neu: neu.sub, pushSubscribe: neverSubscribe });
    if (!r) return;
    ok(neu.calls() === 0, `${L}: newSubscription left alone (its unsubscribe() is called 0 times)`, `called ${neu.calls()}`);
    ok(sameList(seq(r), [`GET ${P_PUSH}`]), `${L}: fetches are exactly GET ${P_PUSH}`, seq(r).join(", "));
    ok(r.subscribeCalls.length === 0, `${L}: pushManager.subscribe is called 0 times`, `called ${r.subscribeCalls.length}`);
    ok(bodiesTo(r, P_STATUS).length === 0, `${L}: no status POST`);
    ok(bodiesTo(r, P_SUB).length === 0, `${L}: no subscribe POST`);
    ok(bodiesTo(r, P_UNSUB).length === 0, `${L}: no unsubscribe POST`);
  });

  // 8a. Everything rejects, starting with the GET: it still finishes
  await guard(ok, "case 8a", async () => {
    const L = "sw push: case 8a";
    const old = fakeSub(OLD, { key: oldKey(), rejectUnsubscribe: true }), neu = fakeSub(NEW, { rejectUnsubscribe: true });
    const answers = { [P_PUSH]: REJECT, [P_STATUS]: REJECT, [P_SUB]: REJECT, [P_UNSUB]: REJECT };
    await fire(ok, script, L, { answers, old: old.sub, neu: neu.sub, pushSubscribe: rejectSubscribe });
  });

  // 8b. Alerts on, then everything after the GET rejects: it still finishes, and still tries to remove OLD
  for (const [variant, withNew] of [["old only", false], ["old and new", true]]) {
    await guard(ok, `case 8b[${variant}]`, async () => {
      const L = `sw push: case 8b[${variant}]`;
      const old = fakeSub(OLD, { key: oldKey(), rejectUnsubscribe: true });
      const neu = withNew ? fakeSub(NEW, { rejectUnsubscribe: true }) : null;
      const answers = { ...defaults(), [P_STATUS]: REJECT, [P_SUB]: REJECT, [P_UNSUB]: REJECT };
      const r = await fire(ok, script, L, { answers, old: old.sub, neu: neu ? neu.sub : null, pushSubscribe: rejectSubscribe });
      if (!r) return;
      const removed = bodiesTo(r, P_UNSUB);
      ok(removed.some(b => b?.endpoint === OLD), `${L}: unsubscribe {endpoint: OLD} is still attempted`, `${removed.length} unsubscribe POSTs`);
    });
  }
}
