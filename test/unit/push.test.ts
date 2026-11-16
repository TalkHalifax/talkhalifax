// Web Push alerts as they work today: subscribing, the kinds and quiet hours readers choose, the rate limit, which
// notice falls under which kind, and sending (encryption, VAPID, and what happens to a subscription a push service
// refuses). No test reaches the network: fetch is stubbed, and only push.example.test answers.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Env } from "../../src/env";
import { alertKind, countRecipients, MAX_SEND, pushApi, sendNotice, sweepSubscriptions } from "../../src/push";
import { DAY, HOUR, env, makeStory, storyRow } from "./helpers";

declare global {
  interface ImportMeta { glob(pattern: string, opts: { query: string; import: string; eager: true }): Record<string, unknown> }
}

const ORIGIN = "https://site.test";
const PUSH_HOST = "push.example.test";
const BAD_ADDRESS = { error: "That browser's alert address wasn't recognised." };
const DEFAULT_KINDS = ["weather", "outages", "safety", "other"];

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

// Every endpoint and key a test makes, so the log check can look for each one
const secrets = new Set<string>();
const keep = (s: string) => { secrets.add(s); return s; };

// ---------- keys ----------
interface Browser { p256dh: string; auth: string; privateKey: CryptoKey }
/** A browser's push keys, as PushSubscription.toJSON() gives them: an ECDH P-256 public key and a 16-byte secret. */
async function browser(): Promise<Browser> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const p256dh = keep(b64u(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
  const auth = keep(b64u(crypto.getRandomValues(new Uint8Array(16))));
  return { p256dh, auth, privateKey: pair.privateKey };
}

let envOn: Env;
let keys: Browser;
beforeAll(async () => {
  // VAPID keys made here, as scripts/vapid-keys.mjs makes them: the raw public key and the private JWK's d
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  envOn = { ...env, VAPID_PUBLIC_KEY: keep(pub), VAPID_PRIVATE_KEY: keep(jwk.d!) } as Env;
  keys = await browser();
});

// ---------- the network stub and the log check ----------
let sent: { url: string; init: RequestInit }[] = [];
let stray: string[] = [];
let replies = new Map<string, number | "throw">();
let spies: MockInstance[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subs").run();
  sent = []; stray = []; replies = new Map();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    let host = "";
    try { host = new URL(url).hostname; } catch { /* counted as stray below */ }
    if (host !== PUSH_HOST) { stray.push(url); throw new Error("No network in tests"); }
    sent.push({ url, init });
    const r = replies.get(url) ?? 201;
    if (r === "throw") throw new Error("connection reset");
    return new Response(null, { status: r });
  });
  spies = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m));
});

afterEach(() => {
  const logged = spies.flatMap(s => s.mock.calls.flat()).map(a => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join("\n");
  vi.useRealTimers();
  vi.restoreAllMocks();
  const leaked = [...secrets].filter(s => logged.includes(s)).length;
  expect(leaked, "a console line held a test endpoint or key").toBe(0);
  // deliver() swallows a thrown fetch, so a request to any other host would pass quietly without this
  expect(stray.length, "a request went to a host other than the stub's").toBe(0);
});

// ---------- requests ----------
let ipN = 0;
const nextIp = () => { ipN++; return `10.0.${(ipN >> 8) & 255}.${ipN & 255}`; };

interface CallOpts { method?: string; origin?: string | null; type?: string | null; ip?: string; base?: string; e?: Env }
/** One request to pushApi, as the router would hand it over. Each gets its own IP unless the test sets one. */
async function call(path: string, body?: unknown, o: CallOpts = {}) {
  const url = new URL(path, o.base ?? ORIGIN);
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? nextIp() };
  const origin = o.origin === undefined ? url.origin : o.origin;
  if (origin) headers.origin = origin;
  const type = o.type === undefined ? "application/json" : o.type;
  if (type) headers["content-type"] = type;
  const method = o.method ?? (body === undefined ? "GET" : "POST");
  const req = new Request(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const res = await pushApi(req, o.e ?? envOn, url);
  return { status: res.status, data: await res.json<any>() };
}

const subscription = (endpoint: string, k: { p256dh: string; auth: string } = keys) =>
  ({ endpoint: keep(endpoint), keys: { p256dh: keep(k.p256dh), auth: keep(k.auth) } });
const subscribe = (endpoint: string, extra: Record<string, unknown> = {}, o: CallOpts = {}, k?: { p256dh: string; auth: string }) =>
  call("/api/push/subscribe", { subscription: subscription(endpoint, k), ...extra }, o);
const row = (endpoint: string) => env.DB.prepare("SELECT * FROM push_subs WHERE endpoint = ?").bind(endpoint).first<Record<string, any>>();
const rowCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs").first<{ n: number }>())!.n;

/** A subscriber put straight in the table, on the stubbed push service, with real keys so its alerts can be decrypted. */
async function addSub(n: number, kinds: string[] | string = ["weather"], cols: { quiet_start?: number | null; quiet_end?: number | null; failures?: number } = {}) {
  const b = await browser();
  const endpoint = keep(`https://${PUSH_HOST}/sub/${n}`);
  await env.DB.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, kinds, quiet_start, quiet_end, created_at, updated_at, failures) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)")
    .bind(endpoint, b.p256dh, b.auth, typeof kinds === "string" ? kinds : JSON.stringify(kinds), cols.quiet_start ?? null, cols.quiet_end ?? null, cols.failures ?? 0).run();
  return { endpoint, ...b };
}

const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };

// ---------- RFC 8291, the browser's side ----------
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}
async function decrypt(body: Uint8Array, b: Browser) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, b.privateKey, 256));
  const ikm = await hkdf(unb64u(b.auth), shared, concat(enc.encode("WebPush: info\0"), unb64u(b.p256dh), asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2); // the last record's delimiter
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

// =====================================================================================================================

describe("subscribing: which alert addresses are accepted", () => {
  it.each(["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-ab1.notify.windows.com/w/?token=abc"])(
    "accepts the push service at %s", async endpoint => {
      const r = await subscribe(endpoint);
      expect(r.status).toBe(200);
      expect(r.data).toEqual({ ok: true, kinds: DEFAULT_KINDS, quiet: null });
      expect(await row(endpoint)).toMatchObject({ endpoint, p256dh: keys.p256dh, auth: keys.auth, kinds: JSON.stringify(DEFAULT_KINDS), failures: 0 });
    });

  it.each([
    ["plain http", "http://fcm.googleapis.com/x"],
    ["another host", "https://evil.test/x"],
    ["a push host as a prefix of another", "https://fcm.googleapis.com.evil.test/x"],
    ["a push host as a suffix of another name", "https://evilfcm.googleapis.com/x"],
    ["not a URL", "not a url"],
    ["1,001 characters", "https://fcm.googleapis.com/" + "a".repeat(974)],
  ])("refuses %s", async (_, endpoint) => {
    const r = await subscribe(endpoint);
    expect(r.status).toBe(400);
    expect(r.data).toEqual(BAD_ADDRESS);
    expect(await rowCount()).toBe(0);
  });

  it("accepts an endpoint of exactly 1,000 characters", async () => {
    const endpoint = "https://fcm.googleapis.com/" + "a".repeat(973);
    expect(endpoint).toHaveLength(1000);
    expect((await subscribe(endpoint)).status).toBe(200);
    expect(await row(endpoint)).not.toBeNull();
  });

  const ep = "https://fcm.googleapis.com/fcm/send/keys";
  it.each([
    ["p256dh of 79 characters", { p256dh: "A".repeat(79), auth: "a".repeat(22) }],
    ["p256dh of 101 characters", { p256dh: "A".repeat(101), auth: "a".repeat(22) }],
    ["p256dh with +", { p256dh: "A".repeat(86) + "+", auth: "a".repeat(22) }],
    ["p256dh with =", { p256dh: "A".repeat(86) + "=", auth: "a".repeat(22) }],
    ["auth of 15 characters", { p256dh: "A".repeat(87), auth: "a".repeat(15) }],
    ["auth of 33 characters", { p256dh: "A".repeat(87), auth: "a".repeat(33) }],
  ])("refuses %s", async (_, k) => {
    const r = await subscribe(ep, {}, {}, k);
    expect(r.status).toBe(400);
    expect(r.data).toEqual(BAD_ADDRESS);
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ["p256dh of 80 characters", { p256dh: "A".repeat(80), auth: "a".repeat(22) }],
    ["p256dh of 100 characters", { p256dh: "A-_".repeat(33) + "A", auth: "a".repeat(22) }],
    ["auth of 16 characters", { p256dh: "A".repeat(87), auth: "a".repeat(16) }],
    ["auth of 32 characters", { p256dh: "A".repeat(87), auth: "a_-".repeat(10) + "aa" }],
  ])("accepts %s", async (_, k) => {
    expect((await subscribe(ep, {}, {}, k)).status).toBe(200);
    expect(await row(ep)).toMatchObject({ p256dh: k.p256dh, auth: k.auth });
  });

  it("accepts a localhost endpoint only when the site itself is on localhost", async () => {
    const endpoint = "http://localhost:8787/x";
    expect((await subscribe(endpoint, {}, { base: "http://localhost:8787" })).status).toBe(200);
    expect(await row(endpoint)).not.toBeNull();
    await env.DB.prepare("DELETE FROM push_subs").run();
    const r = await subscribe(endpoint);
    expect(r.status).toBe(400);
    expect(r.data).toEqual(BAD_ADDRESS);
    expect(await rowCount()).toBe(0);
  });
});

describe("subscribing: kinds and quiet hours", () => {
  const ep = "https://fcm.googleapis.com/fcm/send/choices";

  it("defaults the kinds, keeps only real ones in the site's order, and refuses none", async () => {
    expect((await subscribe(ep)).data.kinds).toEqual(DEFAULT_KINDS);
    const r = await subscribe(ep, { kinds: ["roads", "bogus", "weather"] });
    expect(r.data.kinds).toEqual(["weather", "roads"]);
    expect((await row(ep))!.kinds).toBe(JSON.stringify(["weather", "roads"]));
    const none = await subscribe(ep, { kinds: [] });
    expect(none.status).toBe(400);
    expect(none.data).toEqual({ error: "Pick at least one kind of alert, or turn alerts off." });
    expect((await row(ep))!.kinds).toBe(JSON.stringify(["weather", "roads"]));
  });

  it("echoes and stores a quiet window that crosses midnight", async () => {
    const r = await subscribe(ep, { quiet: { start: 1320, end: 420 } });
    expect(r.data.quiet).toEqual({ start: 1320, end: 420 });
    expect(await row(ep)).toMatchObject({ quiet_start: 1320, quiet_end: 420 });
  });

  it.each([1440, -1, 1.5, "x"])("drops the quiet window when start or end is %s", async bad => {
    const s = await subscribe(ep, { quiet: { start: bad, end: 420 } });
    expect(s.status).toBe(200);
    expect(s.data.quiet).toBeNull();
    // Today the valid half is still stored, though the window is reported as none
    expect(await row(ep)).toMatchObject({ quiet_start: null, quiet_end: 420 });
    expect((await call("/api/push/status", { endpoint: ep })).data.quiet).toBeNull();
    const e = await subscribe(ep, { quiet: { start: 1320, end: bad } });
    expect(e.data.quiet).toBeNull();
    expect(await row(ep)).toMatchObject({ quiet_start: 1320, quiet_end: null });
  });

  it("re-subscribing updates the choices, clears the failures and keeps when it began", async () => {
    await subscribe(ep, { kinds: ["weather"] });
    await env.DB.prepare("UPDATE push_subs SET failures = 3, created_at = 1000, updated_at = 1000 WHERE endpoint = ?").bind(ep).run();
    const r = await subscribe(ep, { kinds: ["outages", "water"], quiet: { start: 0, end: 60 } });
    expect(r.data).toEqual({ ok: true, kinds: ["outages", "water"], quiet: { start: 0, end: 60 } });
    const got = await row(ep);
    expect(got).toMatchObject({ kinds: JSON.stringify(["outages", "water"]), failures: 0, created_at: 1000, quiet_start: 0, quiet_end: 60 });
    expect(got!.updated_at).toBeGreaterThan(1000);
    expect(await rowCount()).toBe(1);
  });
});

describe("status and unsubscribing", () => {
  it("says what a known browser chose, nothing for an unknown one, and forgets it on unsubscribe", async () => {
    const ep = "https://updates.push.services.mozilla.com/wpush/v2/status";
    await subscribe(ep, { kinds: ["safety"], quiet: { start: 1320, end: 420 } });
    expect((await call("/api/push/status", { endpoint: ep })).data).toEqual({ subscribed: true, kinds: ["safety"], quiet: { start: 1320, end: 420 } });
    expect((await call("/api/push/status", { endpoint: keep("https://updates.push.services.mozilla.com/wpush/v2/unknown") })).data).toEqual({ subscribed: false });
    const off = await call("/api/push/unsubscribe", { endpoint: ep });
    expect(off).toEqual({ status: 200, data: { ok: true } });
    expect(await row(ep)).toBeNull();
    expect((await call("/api/push/status", { endpoint: ep })).data).toEqual({ subscribed: false });
  });
});

describe("the routes' guards", () => {
  const ep = "https://fcm.googleapis.com/fcm/send/guards";

  it("refuses a POST without the site's origin or a JSON content type", async () => {
    expect(await call("/api/push/subscribe", { subscription: subscription(ep) }, { origin: null })).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await call("/api/push/subscribe", { subscription: subscription(ep) }, { origin: "https://evil.test" })).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await call("/api/push/subscribe", { subscription: subscription(ep) }, { type: "text/plain" })).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await rowCount()).toBe(0);
  });

  it("refuses GET on a POST route, and a path it doesn't know", async () => {
    expect(await call("/api/push/subscribe")).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await call("/api/push/nope", {})).toEqual({ status: 404, data: { error: "Not found" } });
  });

  it("GET /api/push says whether alerts are on, the public key, and the six kinds with their defaults", async () => {
    const on = await call("/api/push");
    expect(on.status).toBe(200);
    expect(on.data.enabled).toBe(true);
    expect(on.data.publicKey).toBe(envOn.VAPID_PUBLIC_KEY);
    expect(on.data.kinds).toEqual([
      { id: "weather", label: "Weather warnings", default: true },
      { id: "outages", label: "Power outages", default: true },
      { id: "roads", label: "Roads, traffic and transit", default: false },
      { id: "water", label: "Water repairs and shut-offs", default: false },
      { id: "safety", label: "Police, fire and emergencies", default: true },
      { id: "other", label: "Other urgent notices", default: true },
    ]);
    const off = await call("/api/push", undefined, { e: env });
    expect(off.data).toMatchObject({ enabled: false, publicKey: null });
    expect(off.data.kinds).toHaveLength(6);
  });

  it("without VAPID keys, subscribe and status return 503, but unsubscribe still works", async () => {
    for (const [path, body] of [["/api/push/subscribe", { subscription: subscription(ep) }], ["/api/push/status", { endpoint: ep }]] as const) {
      expect(await call(path, body, { e: env })).toEqual({ status: 503, data: { error: "Alerts aren't switched on yet." } });
    }
    expect(await rowCount()).toBe(0);
    // NOT-1 D1: a reader can always withdraw, even with alerts switched off
    const s = await addSub(1);
    expect(await call("/api/push/unsubscribe", { endpoint: s.endpoint }, { e: env })).toEqual({ status: 200, data: { ok: true } });
    expect(await row(s.endpoint)).toBeNull();
  });

  it("unsubscribing still needs the site's origin and a JSON body", async () => {
    const s = await addSub(1);
    expect(await call("/api/push/unsubscribe", { endpoint: s.endpoint }, { origin: null })).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await call("/api/push/unsubscribe", { endpoint: s.endpoint }, { type: "text/plain" })).toEqual({ status: 400, data: { error: "Bad request" } });
    expect(await row(s.endpoint)).not.toBeNull();
  });
});

describe("rate limits: one per route, so using one up never blocks the others", () => {
  const ep = "https://fcm.googleapis.com/fcm/send/limits";
  const tooMany = { status: 429, data: { error: "Too many changes from here. Try again in an hour." } };
  // Hundreds of real requests take minutes here, so after a few real ones the window's count is moved on to just
  // below the limit; allow() then counts the rest exactly as it would have
  const fastForward = (key: string, count: number) => env.DB.prepare("UPDATE auth_throttle SET count = ? WHERE key = ?").bind(count, key).run();

  it("allows 30 subscribes an hour from one address and not a 31st; unsubscribe and status still work there, and another address is unaffected", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < 3; i++) expect((await subscribe(ep, {}, { ip })).status).toBe(200);
    await fastForward(`push:${ip}`, 29);
    expect((await subscribe(ep, {}, { ip })).status).toBe(200); // the 30th
    expect(await subscribe(ep, {}, { ip })).toEqual(tooMany); // the 31st
    expect(await call("/api/push/status", { endpoint: ep }, { ip })).toEqual({ status: 200, data: { subscribed: true, kinds: DEFAULT_KINDS, quiet: null } });
    expect(await call("/api/push/unsubscribe", { endpoint: ep }, { ip })).toEqual({ status: 200, data: { ok: true } });
    expect(await row(ep)).toBeNull();
    expect(await call("/api/push/status", { endpoint: ep }, { ip })).toEqual({ status: 200, data: { subscribed: false } });
    expect((await subscribe(ep, {}, { ip: "198.51.100.8" })).status).toBe(200);
  });


  it("allows 600 status checks an hour and not a 601st, without touching subscribing", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 5; i++) expect((await call("/api/push/status", { endpoint: ep }, { ip })).status).toBe(200);
    expect((await env.DB.prepare("SELECT count FROM auth_throttle WHERE key = ?").bind(`push:status:${ip}`).first<{ count: number }>())!.count).toBe(5);
    await fastForward(`push:status:${ip}`, 599);
    expect((await call("/api/push/status", { endpoint: ep }, { ip })).status).toBe(200); // the 600th
    expect(await call("/api/push/status", { endpoint: ep }, { ip })).toEqual(tooMany); // the 601st
    expect((await subscribe(ep, {}, { ip })).status).toBe(200);
  });

  it("allows 300 unsubscribes an hour and not a 301st", async () => {
    const ip = "198.51.100.10";
    for (let i = 0; i < 5; i++) expect((await call("/api/push/unsubscribe", { endpoint: ep }, { ip })).status).toBe(200);
    expect((await env.DB.prepare("SELECT count FROM auth_throttle WHERE key = ?").bind(`push:off:${ip}`).first<{ count: number }>())!.count).toBe(5);
    await fastForward(`push:off:${ip}`, 299);
    expect((await call("/api/push/unsubscribe", { endpoint: ep }, { ip })).status).toBe(200); // the 300th
    expect(await call("/api/push/unsubscribe", { endpoint: ep }, { ip })).toEqual(tooMany); // the 301st
  });

  it("keeps each route's count under its own key", async () => {
    const ip = "198.51.100.11";
    await subscribe(ep, {}, { ip });
    await call("/api/push/status", { endpoint: ep }, { ip });
    await call("/api/push/unsubscribe", { endpoint: ep }, { ip });
    const keys = (await env.DB.prepare("SELECT key FROM auth_throttle WHERE key LIKE 'push:%' ORDER BY key").all<{ key: string }>()).results.map(r => r.key);
    expect(keys).toEqual([`push:${ip}`, `push:off:${ip}`, `push:status:${ip}`]);
  });
});

describe("which kind a notice falls under", () => {
  it.each([
    [{ id: "weather-x" }, "weather"],
    [{ id: "ns-power-outages-x" }, "outages"],
    [{ id: "n-1", section: "City Hall", headline: "Boil water advisory" }, "safety"],
    [{ id: "hw-1", section: "Halifax Water", headline: "Emergency water service shut down" }, "safety"],
    [{ id: "hw-2", section: "Halifax Water", headline: "Traffic Advisory – Quinpool Road" }, "roads"],
    [{ id: "hw-3", section: "Halifax Water", headline: "Hollis Street Manhole Repair" }, "water"],
    [{ id: "n-2", section: "City Hall", headline: "Road closure after fire" }, "roads"],
    [{ id: "n-3", section: "City Hall", headline: "RCMP seek missing man" }, "safety"],
    [{ id: "n-4", section: "City Hall", headline: "Library hours change" }, "other"],
  ])("%o is %s", (s, kind) => expect(alertKind(s)).toBe(kind));
});

describe("quiet hours, counted in Halifax time", () => {
  const count = async (iso: string, start: number | null, end: number | null, kinds: string[] | string = ["weather"]) => {
    await env.DB.prepare("DELETE FROM push_subs").run();
    await addSub(1, kinds, { quiet_start: start, quiet_end: end });
    at(iso);
    const n = await countRecipients(envOn, "weather");
    vi.useRealTimers();
    return n;
  };

  // January: Atlantic Standard Time, UTC-4
  it("a daytime window, 09:00 to 17:00", async () => {
    expect(await count("2026-01-15T13:00:00Z", 540, 1020)).toBe(0); // 09:00
    expect(await count("2026-01-15T20:59:00Z", 540, 1020)).toBe(0); // 16:59
    expect(await count("2026-01-15T21:00:00Z", 540, 1020)).toBe(1); // 17:00
  });
  it("a window across midnight, 22:00 to 07:00", async () => {
    expect(await count("2026-01-16T02:00:00Z", 1320, 420)).toBe(0); // 22:00
    expect(await count("2026-01-15T04:30:00Z", 1320, 420)).toBe(0); // 00:30
    expect(await count("2026-01-15T10:59:00Z", 1320, 420)).toBe(0); // 06:59
    expect(await count("2026-01-15T11:00:00Z", 1320, 420)).toBe(1); // 07:00
    expect(await count("2026-01-16T01:59:00Z", 1320, 420)).toBe(1); // 21:59
  });
  it("an empty or half-set window is never quiet", async () => {
    expect(await count("2026-01-15T14:00:00Z", 600, 600)).toBe(1); // 10:00, start == end
    expect(await count("2026-01-15T04:30:00Z", null, 420)).toBe(1);
    expect(await count("2026-01-15T04:30:00Z", 1320, null)).toBe(1);
    expect(await count("2026-01-15T04:30:00Z", null, null)).toBe(1);
  });
  it("kinds that aren't JSON, or don't include the kind, are never counted", async () => {
    expect(await count("2026-01-15T16:00:00Z", null, null, "not json")).toBe(0);
    expect(await count("2026-01-15T16:00:00Z", null, null, ["roads", "safety"])).toBe(0);
  });
  it("follows the clocks changing", async () => {
    expect(await count("2026-03-08T10:30:00Z", 1320, 420)).toBe(1); // 07:30 ADT, the morning clocks went forward
    expect(await count("2026-03-08T05:30:00Z", 1320, 420)).toBe(0); // 01:30 AST
    expect(await count("2026-11-01T10:30:00Z", 1320, 420)).toBe(0); // 06:30 AST, the morning clocks went back
    expect(await count("2026-11-01T04:30:00Z", 1320, 420)).toBe(0); // the first 01:30, ADT
    expect(await count("2026-11-01T05:30:00Z", 1320, 420)).toBe(0); // the second 01:30, AST
    expect(await count("2026-01-15T04:30:00Z", 0, 60)).toBe(0); // 00:30 AST
  });
});

describe("sending a notice", () => {
  const notice = { kind: "notice", section: "Weather", headline: "Gale warning for Halifax", dek: "Winds gusting to 90 km/h tonight." };

  it("sends only live notices, and nothing at all otherwise", async () => {
    await addSub(1, ["weather", "outages", "roads", "water", "safety", "other"]);
    const refused = { sent: 0, failed: 0, removed: 0, error: "Only live notices can be sent as alerts." };
    await makeStory("weather-article", { ...notice, kind: "article" });
    await makeStory("weather-archived", notice, { stage: "archived" });
    await makeStory("weather-draft", notice, { stage: "draft" });
    for (const id of ["weather-missing", "weather-article", "weather-archived", "weather-draft"])
      expect(await sendNotice(envOn, id)).toEqual(refused);
    expect(sent).toHaveLength(0);
  });

  it("acts on each push service's answer, and skips readers in quiet hours or who chose other kinds", async () => {
    at("2026-01-15T17:00:00Z"); // 13:00 in Halifax
    await makeStory("weather-gale", notice);
    expect((await storyRow("weather-gale"))!.stage).toBe("developing");
    const answers: (number | "throw")[] = [201, 404, 410, 500, 400, 403, 413, "throw"];
    const subs = [];
    for (let i = 0; i < answers.length; i++) {
      const s = await addSub(i + 1, ["weather"], { failures: i === 0 ? 2 : 0 });
      replies.set(s.endpoint, answers[i]);
      subs.push(s);
    }
    const worn = await addSub(9, ["weather"], { failures: 4 });
    replies.set(worn.endpoint, 500);
    const quiet = await addSub(10, ["weather"], { quiet_start: 720, quiet_end: 840 });
    const other = await addSub(11, ["roads", "safety"]);

    const r = await sendNotice(envOn, "weather-gale");
    // NOT-1 D2: with one delivery through, 400, 403 and 413 now remove the subscription too
    expect(r).toMatchObject({ sent: 1, failed: 3, removed: 5, kind: "weather" });
    expect(sent.map(s => s.url).sort()).toEqual([...subs.map(s => s.endpoint), worn.endpoint].sort());
    expect(sent.some(s => s.url === quiet.endpoint || s.url === other.endpoint)).toBe(false);

    expect(await row(subs[0].endpoint)).toMatchObject({ last_sent_at: Date.parse("2026-01-15T17:00:00Z"), failures: 0 });
    for (const i of [1, 2, 4, 5, 6]) expect(await row(subs[i].endpoint)).toBeNull(); // 404, 410, 400, 403, 413
    for (const i of [3, 7]) expect(await row(subs[i].endpoint)).toMatchObject({ failures: 1, last_sent_at: null }); // 500, thrown
    expect(await row(worn.endpoint)).toBeNull(); // its fifth failure in a row
    expect(await row(quiet.endpoint)).toMatchObject({ failures: 0, last_sent_at: null });
    expect(await row(other.endpoint)).toMatchObject({ failures: 0, last_sent_at: null });
    expect((await storyRow("weather-gale"))!.push_count).toBe(r.sent);
  });

  it("each push is encrypted for its browser, signed with VAPID, and carries only the alert", async () => {
    await makeStory("weather-gale", notice);
    const s = await addSub(1);
    expect(await sendNotice(envOn, "weather-gale")).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    const { init } = sent[0];
    const h = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(h.get("TTL")).toBe("21600");
    expect(h.get("Urgency")).toBe("high");
    expect(h.get("Content-Encoding")).toBe("aes128gcm");
    expect(h.get("Authorization")).toMatch(new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^,]+, k=${envOn.VAPID_PUBLIC_KEY}$`));
    const payload = await decrypt(init.body as Uint8Array, s);
    expect(Object.keys(payload).sort()).toEqual(["at", "body", "tag", "title", "url"]);
    expect(payload).toMatchObject({ title: notice.headline, body: notice.dek, url: "/#article-weather-gale", tag: "weather-gale" });
    expect(typeof payload.at).toBe("number");
  });
});

describe("dead subscriptions don't linger (NOT-1 D2)", () => {
  const notice = { kind: "notice", section: "Weather", headline: "Gale warning for Halifax", dek: "Winds gusting to 90 km/h tonight." };
  const withAnswers = async (answers: (number | "throw")[]) => {
    const subs = [];
    for (let i = 0; i < answers.length; i++) { const s = await addSub(i + 1); replies.set(s.endpoint, answers[i]); subs.push(s); }
    return subs;
  };

  it("when some delivery gets through, 400, 403, 404, 410 and 413 all remove the subscription", async () => {
    await makeStory("weather-gale", notice);
    const subs = await withAnswers([201, 400, 403, 404, 410, 413]);
    expect(await sendNotice(envOn, "weather-gale")).toMatchObject({ sent: 1, failed: 0, removed: 5 });
    expect(await row(subs[0].endpoint)).not.toBeNull();
    for (const s of subs.slice(1)) expect(await row(s.endpoint)).toBeNull();
  });

  it("when nothing gets through, only 404 and 410 remove; 400, 403 and 413 count as failures", async () => {
    await makeStory("weather-gale", notice);
    const subs = await withAnswers([404, 410, 400, 403, 413]);
    expect(await sendNotice(envOn, "weather-gale")).toMatchObject({ sent: 0, failed: 3, removed: 2 });
    expect(await row(subs[0].endpoint)).toBeNull();
    expect(await row(subs[1].endpoint)).toBeNull();
    for (const s of subs.slice(2)) expect(await row(s.endpoint)).toMatchObject({ failures: 1 });
  });

  it("every delivery refused with 403, as a bad VAPID key would be, deletes no one", async () => {
    await makeStory("weather-gale", notice);
    const subs = await withAnswers([403, 403, 403, 403]);
    expect(await sendNotice(envOn, "weather-gale")).toMatchObject({ sent: 0, failed: 4, removed: 0 });
    expect(await rowCount()).toBe(4);
    for (const s of subs) expect(await row(s.endpoint)).toMatchObject({ failures: 1 });
  });

  it("an alert too big to send is refused before anything is fetched", async () => {
    // The id goes into both tag and url, so a long one takes the payload past 3,000 bytes
    const id = "weather-" + "x".repeat(1600);
    await env.DB.prepare("INSERT INTO stories (id, kind, section, headline, dek, source_url, published_at, stage, updated_at) VALUES (?, 'notice', 'Weather', ?, ?, 'https://weather.gc.ca/', ?, 'developing', ?)")
      .bind(id, notice.headline, notice.dek, "2026-11-16T00:00:00Z", "2026-11-16T00:00:00Z").run();
    await addSub(1);
    expect(await sendNotice(envOn, id)).toEqual({ sent: 0, failed: 0, removed: 0, error: "This notice is too long to send as an alert." });
    expect(sent).toHaveLength(0);
  });
});

describe("sending doesn't break partway (NOT-1 D3)", () => {
  const notice = { kind: "notice", section: "Weather", headline: "Gale warning for Halifax", dek: "Winds gusting to 90 km/h tonight." };

  /** env.DB, with every statement's run() and every batch counted, still running against the real database. */
  function watchDb() {
    const db = env.DB;
    const ran: string[] = [];
    const batches: number[] = [];
    const watch = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const bind = stmt.bind.bind(stmt), run = stmt.run.bind(stmt);
      Object.defineProperty(stmt, "bind", { configurable: true, value: (...v: unknown[]) => watch(bind(...v), sql) });
      Object.defineProperty(stmt, "run", { configurable: true, value: () => { ran.push(sql); return run(); } });
      return stmt;
    };
    const DB = new Proxy(db, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => watch(t.prepare(sql), sql);
        if (p === "batch") return (list: D1PreparedStatement[]) => { batches.push(list.length); return t.batch(list); };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { DB, ran, batches };
  }

  it("MAX_SEND is 900", () => expect(MAX_SEND).toBe(900));

  it("reaches at most the cap, longest-waiting first, and counts the rest as skipped", async () => {
    await makeStory("weather-gale", notice);
    // last_sent_at: never, then 1,000 to 7,000; the three sent most recently wait for next time
    const subs = [await addSub(1)];
    for (let n = 2; n <= 8; n++) {
      subs.push(await addSub(n));
      await env.DB.prepare("UPDATE push_subs SET last_sent_at = ? WHERE endpoint = ?").bind((n - 1) * 1000, subs[n - 1].endpoint).run();
    }
    const r = await sendNotice(envOn, "weather-gale", { cap: 5 });
    expect(r).toEqual({ sent: 5, failed: 0, removed: 0, skipped: 3, kind: "weather" });
    expect(sent).toHaveLength(5);
    expect(sent.map(s => s.url).sort()).toEqual(subs.slice(0, 5).map(s => s.endpoint).sort());
    for (const s of subs.slice(5)) expect(sent.some(f => f.url === s.endpoint)).toBe(false);
    expect(await countRecipients(envOn, "weather")).toBe(8);
  });

  it("a cap can only lower the limit", async () => {
    await makeStory("weather-gale", notice);
    for (let n = 1; n <= 3; n++) await addSub(n);
    expect(await sendNotice(envOn, "weather-gale", { cap: 5000 })).toMatchObject({ sent: 3, skipped: 0 });
    expect(await sendNotice(envOn, "weather-gale", { cap: -1 })).toMatchObject({ sent: 0, skipped: 3 });
  });

  it("writes everything in one batch at the end, and nothing outside it", async () => {
    await makeStory("weather-gale", notice);
    const answers: (number | "throw")[] = [201, 201, 404, 500, "throw"];
    for (let i = 0; i < answers.length; i++) { const s = await addSub(i + 1, ["weather"], { failures: i === 3 ? 4 : 0 }); replies.set(s.endpoint, answers[i]); }
    const w = watchDb();
    await w.DB.prepare("UPDATE stories SET dek = dek WHERE id = ?").bind("weather-gale").run(); // the watch sees a run() outside a batch
    expect(w.ran).toHaveLength(1);
    w.ran.length = 0;
    const r = await sendNotice({ ...envOn, DB: w.DB } as Env, "weather-gale");
    expect(r).toEqual({ sent: 2, failed: 2, removed: 1, skipped: 0, kind: "weather" });
    expect(w.ran.filter(sql => /push_subs|stories/.test(sql))).toEqual([]);
    expect(w.batches).toEqual([answers.length + 2]); // one write per recipient, the failures purge, push_count
    expect(await rowCount()).toBe(3); // 404 removed; the one at four failures reached five and went
    expect((await storyRow("weather-gale"))!.push_count).toBe(2);
  });

  it("the result has sent, failed, removed, kind and skipped, and nothing else", async () => {
    await makeStory("weather-gale", notice);
    await addSub(1);
    expect(Object.keys(await sendNotice(envOn, "weather-gale")).sort()).toEqual(["failed", "kind", "removed", "sent", "skipped"]);
  });
});

describe("sweeping abandoned subscriptions (NOT-1 D2)", () => {
  const NOW = Date.parse("2026-11-16T12:00:00Z");
  const days = (n: number) => NOW - n * DAY;
  const put = (n: number, cols: { last_sent_at?: number | null; updated_at: number; failures?: number }) =>
    env.DB.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, kinds, created_at, updated_at, last_sent_at, failures) VALUES (?, ?, ?, '[\"weather\"]', ?, ?, ?, ?)")
      .bind(keep(`https://${PUSH_HOST}/sweep/${n}`), keys.p256dh, keys.auth, cols.updated_at, cols.updated_at, cols.last_sent_at ?? null, cols.failures ?? 0).run();
  const left = async () => (await env.DB.prepare("SELECT endpoint FROM push_subs ORDER BY endpoint").all<{ endpoint: string }>()).results.map(r => r.endpoint.split("/").pop());
  const seed = async () => {
    await put(1, { last_sent_at: days(181), updated_at: days(181) }); // gone: nothing sent in 181 days
    await put(2, { last_sent_at: null, updated_at: days(181) }); // gone: never sent, unchanged in 181 days
    await put(3, { updated_at: days(1), failures: 5 }); // gone: five failures
    await put(4, { last_sent_at: days(1), updated_at: days(400) }); // kept: sent yesterday
    await put(5, { updated_at: days(179) }); // kept: changed 179 days ago
  };
  beforeEach(() => at("2026-11-16T12:00:00Z"));

  it("deletes the abandoned and the failing, keeps the rest, and says how many", async () => {
    await seed();
    expect(await sweepSubscriptions(envOn)).toEqual({ removed: 3 });
    expect(await left()).toEqual(["4", "5"]);
    expect(await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'push-sweep'").first()).toEqual({ body: "{}", updated_at: "2026-11-16T12:00:00Z" });
  });

  it("runs at most once a day", async () => {
    await seed();
    await sweepSubscriptions(envOn);
    await put(6, { updated_at: days(300) });
    vi.setSystemTime(NOW + 23 * HOUR);
    expect(await sweepSubscriptions(envOn)).toEqual({ skipped: true });
    expect(await left()).toEqual(["4", "5", "6"]);
    await env.DB.prepare("UPDATE feeds SET updated_at = ? WHERE name = 'push-sweep'").bind(new Date(NOW + 23 * HOUR - 25 * HOUR).toISOString()).run();
    expect(await sweepSubscriptions(envOn)).toEqual({ removed: 1 });
    expect(await left()).toEqual(["4", "5"]);
  });

  it("two sweeps at once both finish, and leave what one would", async () => {
    await seed();
    const results = await Promise.all([sweepSubscriptions(envOn), sweepSubscriptions(envOn)]);
    expect(await left()).toEqual(["4", "5"]);
    expect(results.reduce((n, r) => n + ("removed" in r ? r.removed : 0), 0)).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE name = 'push-sweep'").first<{ n: number }>())!.n).toBe(1);
  });

  it("rejects when the database does, without an endpoint or key in the error", async () => {
    await seed();
    const db = env.DB;
    const broken = new Proxy(db, {
      get(t, p) {
        if (p === "batch") return () => Promise.reject(new Error("D1_ERROR: database is unavailable"));
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const err = await sweepSubscriptions({ ...envOn, DB: broken } as Env).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message}\n${(err as Error).stack}`;
    expect([...secrets].filter(s => text.includes(s))).toHaveLength(0);
    expect(await left()).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("the source itself (NOT-1 D2)", () => {
  const sources = {
    ...import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
    ...import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }),
  } as Record<string, string>;

  it("push.ts never writes to the console", () => {
    expect(sources["../../src/push.ts"]).toBeTypeOf("string");
    expect(sources["../../src/push.ts"]).not.toMatch(/console\./);
  });
  it("sweepSubscriptions is used nowhere else yet, in src or the unit tests", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const users = Object.entries(sources).filter(([f, text]) => f !== "../../src/push.ts" && f !== "./push.test.ts" && /sweepSubscriptions/.test(text)).map(([f]) => f);
    expect(users).toEqual([]);
  });
});
