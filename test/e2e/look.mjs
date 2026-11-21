// Takes full-page screenshots of the site, so a person (or an agent) can look at a page before shipping a change.
// It starts its own local Worker on throwaway seeded data (.wrangler/look, wiped each run) and opens each route in
// Chrome at 375x812 (phone) and 1280x800, each with and without reduced motion: four PNGs per route.
// --dark adds each shot again in dark mode; --mid adds an 800x1000 width with the same variants.
//   node test/e2e/look.mjs [--dark] [--mid] <route> [<route>...]   e.g. node test/e2e/look.mjs --dark root notices article-look-developing
// A route is a bare word (root is /, any other word w is /#w), '#...' (quote it in bash) or /... (not from Git Bash,
// which rewrites it into a Windows path). No hosts, URLs, dots or colons. Each page is shot once.
// It never reaches production. The browser may reach only localhost; every other request is blocked and listed, as is
// /api/transit/. The local Worker's own outbound calls are not blocked.
// Files go to .agent-tmp/look/<slug>-<375|800|1280>[-dark][-reduced].png under the current folder, overwritten each run.
// Takes about 15 s per route with no flags, more with --dark or --mid. Ctrl+C or a kill stops the Worker and Chrome.
// Uses Chrome or Edge from the system, or the one at CHROME_PATH. Not a test: it checks nothing and counts nothing.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

// Every route is normalised to its /... form; the page URL is always B + that
const toRoute = a => /^\/[#a-z0-9\/_?=&-]*$/.test(a) ? a
  : /^#[a-z0-9\/_?=&-]*$/.test(a) ? "/" + a
  : /^[a-z0-9-]+$/.test(a) ? (a === "root" ? "/" : "/#" + a)
  : null;
const args = process.argv.slice(2);
const dark = args.includes("--dark"), mid = args.includes("--mid");
const given = args.filter(a => a !== "--dark" && a !== "--mid").map(toRoute);
if (!given.length || given.includes(null)) {
  console.error("usage: node test/e2e/look.mjs [--dark] [--mid] <route> [<route>...]   routes: root, home, notices, article-<id> (= /#<word>), or /#... and '#...'");
  process.exit(2);
}
const routes = [...new Set(given.map(r => r === "/#" ? "/" : r))]; // "/#" is the same page as "/"
const WIDTHS = [[375, 812], ...(mid ? [[800, 1000]] : []), [1280, 800]];
const SCHEMES = dark ? [false, true] : [false];

const PORT = 8792, B = `http://localhost:${PORT}`;
const DATA = ".wrangler/look";
const OUT = join(process.cwd(), ".agent-tmp", "look");
const WRANGLER = ["wrangler", "--config", "test/wrangler.test.jsonc"];
const win = process.platform === "win32";
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- Seed: routes.mjs's rows, copied verbatim ----------
const STORIES = [
  { id: "e2e-developing", kind: "article", stage: "developing", headline: "A story still developing", list: "home", cards: "#pins", chat: true },
  { id: "e2e-article", kind: "article", stage: "archived", headline: "A story that has settled", list: "articles", cards: "#articles", chat: false },
  { id: "e2e-notice", kind: "notice", stage: "developing", headline: "A notice about a road", list: "notices", cards: "#notices", chat: false },
];
const q = s => `'${s}'`;
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const SEED = STORIES.map(s => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since)
  VALUES (${[s.id, s.kind, "City Hall", "Halifax", s.headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifax.ca/", now, now, s.stage, now].map(q).join(", ")});`).join(" ");

const WEATHER = JSON.stringify({ updatedAt: now, observedAt: now, station: "Test", condition: "Sunny", tempC: 15, feelsLikeC: 15, icon: "clear", night: false, url: "https://weather.gc.ca/" });
const waterNotice = (id, headline) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since) VALUES (${[id, "notice", "Halifax Water", "Halifax", headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifaxwater.ca/", now, now, "developing", now].map(q).join(", ")});`;
const SEED_WATER = waterNotice("hw-e2e-shutoff", "One Street - Emergency Water Service Shut Down") + waterNotice("hw-e2e-boil", "Boil Water Advisory for one area");
const story = (id, kind, section, source, version, note, facts, body, means, actions) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, actions, source_url, published_at, updated_at, last_newsroom_update, update_note, version, stage, developing_since) VALUES (${[id, kind, section, "Halifax", id, "A dek", facts, body, means, actions, source, now, now, now, note, version, "developing", now].map(v => typeof v === "number" ? v : q(v)).join(", ")});`;
const FACTS = '[{"k":"Call","v":"902-555-0100"}]';
const SEED_LAYOUT = story("e2e-new", "article", "Province", "https://news.novascotia.ca/x", 1, "", FACTS, '["First.","## A subheading","Second."]', "[]", '["Do this by Friday."]')
  + story("e2e-old", "article", "City Hall", "https://www.halifax.ca/x", 1, "", FACTS, '["First."]', '["An older point."]', "[]")
  + story("hw-e2e-changed", "notice", "Halifax Water", "https://www.halifaxwater.ca/x", 2, "The advisory was lifted", FACTS, '["First."]', '["Boil water."]', "[]");
const SEED_WEATHER = `INSERT INTO feeds (name, body, updated_at) VALUES ('weather', '${WEATHER}', '${now}');`;
const T = Date.now();
const dayBefore = new Date(Date.parse(now) - 864e5).toISOString().replace(/\.\d+Z$/, "Z");
const apiUser = (id, provider, sub, name, role) => `INSERT INTO users (id, provider, provider_sub, name, email, role, created_at, password_hash) VALUES (${[id, provider, sub, name, "", role].map(q).join(", ")}, ${T - 2 * 864e5}, NULL);`;
const apiSession = (id, user, expires) => `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (${q(id)}, ${q(user)}, ${T}, ${expires});`;
const apiStory = (id, stage, headline, at) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since)
  VALUES (${[id, "article", "City Hall", "Halifax", headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifax.ca/", at, at, stage, at].map(q).join(", ")});`;
const apiMessage = (id, user, text) => `INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES (${[id, "e2e-developing", user, text].map(q).join(", ")}, ${T});`;
const apiComment = (id, user, text) => `INSERT INTO comments (id, story_id, parent_id, user_id, text, created_at) VALUES (${q(id)}, 'e2e-api-archived', NULL, ${q(user)}, ${q(text)}, ${T});`;
const SEED_API = [
  apiUser("u_e2e_mod", "password", "e2e_mod", "E2E Moderator", "moderator"),
  apiUser("u_e2e_member", "password", "e2e_member", "E2E Member", "member"),
  apiUser("u_e2e_other", "password", "e2e_other", "E2E Other", "member"),
  apiUser("u_e2e_ban", "password", "e2e_ban", "E2E Ban", "member"),
  apiUser("u_e2e_reset", "password", "e2e_reset", "E2E Reset", "member"),
  apiUser("u_e2e_google", "google", "e2e-google-sub", "E2E Google", "member"),
  apiUser("u_e2e_delete", "password", "e2e_delete", "E2E Delete", "member"),
  apiSession("s_e2e_mod", "u_e2e_mod", T + 864e5),
  apiSession("s_e2e_member", "u_e2e_member", T + 864e5),
  apiSession("s_e2e_other", "u_e2e_other", T + 864e5),
  apiSession("s_e2e_delete", "u_e2e_delete", T + 864e5),
  apiSession("s_e2e_expired", "u_e2e_member", T - 1000),
  apiStory("e2e-api-archived", "archived", "An API story that has settled", dayBefore),
  apiStory("e2e-api-draft", "draft", "An API draft", now),
  apiStory("e2e-api-draft2", "draft", "A second API draft", now),
  apiMessage("m_e2e_mine", "u_e2e_member", "A seeded message"),
  apiMessage("m_e2e_other", "u_e2e_other", "Another seeded message"),
  apiComment("c_e2e_mine", "u_e2e_member", "A seeded comment of mine"),
  apiComment("c_e2e_other", "u_e2e_other", "Another seeded comment"),
  apiComment("c_e2e_seeded", "u_e2e_other", "A seeded comment"),
  `INSERT INTO reports (id, kind, target_id, story_id, author_id, text, reporter_id, created_at, resolved) VALUES ('r_e2e_1', 'comment', 'c_e2e_seeded', 'e2e-api-archived', 'u_e2e_other', 'A seeded comment', 'u_e2e_member', ${T}, NULL);`,
].join(" ");

// ---------- Seed additions: one of each kind of thing a page can show ----------
const sq = s => `'${String(s).replace(/'/g, "''")}'`; // every single quote doubled
const iso = t => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const halifax = t => { // YYYY-MM-DDTHH:MM in America/Halifax
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(t).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const lookStory = (id, kind, stage, section, headline, update = null, note = "") => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since, last_newsroom_update, update_note)
  VALUES (${[id, kind, section, "Halifax", headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifax.ca/", now, now, stage, now].map(sq).join(", ")}, ${update ? sq(update) : "NULL"}, ${sq(note)});`;
const ALERTS = { updatedAt: now, items: [{ cat: "Weather", kind: "Warning", title: "Wind warning in effect", detail: "", until: iso(T + 12 * 36e5), url: "https://weather.gc.ca/", publishedAt: now }] };
const EVENTS = { updatedAt: now, source: "Halifax Public Libraries", sourceUrl: "https://halifax.bibliocommons.com/v2/events",
  from: halifax(T).slice(0, 10), to: halifax(T + 14 * 864e5).slice(0, 10),
  events: [{ id: "look-event", title: "Story time at Central Library", url: "https://halifax.bibliocommons.com/v2/events",
    start: iso(T + 2 * 36e5), end: iso(T + 3 * 36e5), startLocal: halifax(T + 2 * 36e5), endLocal: halifax(T + 3 * 36e5),
    place: "Halifax Central Library", room: "", city: "Halifax", lat: null, lon: null, audiences: ["Kids"], types: ["Storytimes"], image: null,
    featured: false, highlight: false, cancelled: false, virtual: false, registration: null, summary: "Stories and songs for kids." }] };
const feed = (name, body) => `INSERT INTO feeds (name, body, updated_at) VALUES (${sq(name)}, ${sq(JSON.stringify(body))}, ${sq(now)});`;
const SEED_LOOK = [
  lookStory("look-notice-urgent", "notice", "developing", "Fire and Emergency", "Evacuation order for one block"),
  lookStory("look-notice-info", "notice", "developing", "City Hall", "Library hours change for the holiday"),
  lookStory("look-developing", "article", "developing", "City Hall", "A story with a new detail", now, "A detail was added"),
  lookStory("look-article", "article", "archived", "City Hall", "A story that has settled down"),
  feed("alerts", ALERTS), // fresh, so the Worker never fetches Environment Canada
  feed("events", EVENTS),
].join(" "); // weather comes from SEED_WEATHER above: one row, updated now

function browserPath() {
  const found = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
  return found;
}

const npx = args => execSync(`npx ${args.join(" ")}`, { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const slug = r => r.replace(/^\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

// Another run (or anything else) on the port: stop before touching its data or starting a second Worker
const inUse = host => new Promise(r => { const s = connect(PORT, host); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
if (await inUse("127.0.0.1") || await inUse("::1")) {
  console.error(`port ${PORT} is in use; is another look run still going?`);
  process.exit(1);
}

rmSync(DATA, { recursive: true, force: true });
npx([...WRANGLER, "d1", "migrations", "apply", "talkhalifax-test", "--local", "--persist-to", DATA]);
writeFileSync(`${DATA}/seed.sql`, `${SEED} ${SEED_WATER} ${SEED_LAYOUT} ${SEED_WEATHER} ${SEED_API} ${SEED_LOOK}`);
npx([...WRANGLER, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);

const server = spawn("npx", [...WRANGLER, "dev", "--port", String(PORT), "--persist-to", DATA], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const stopServer = (s = server) => {
  if (!s) return;
  try { if (win) execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: "ignore" }); else process.kill(-s.pid); } catch { /* already gone */ }
};

let browser, profile, bad = false, stopping = false, quitCode = null;
const dropProfile = () => { if (profile) try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ } };
// Signals, or the Worker dying: stop the Worker first and synchronously, then Chrome if it lets us, then exit
const quit = code => {
  if (stopping) return;
  stopping = true;
  quitCode = code;
  stopServer();
  Promise.race([browser?.close(), wait(5000)]).catch(() => {}).finally(() => { dropProfile(); process.exit(code); });
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => quit(code));
server.on("exit", () => { if (!stopping) { console.error("The local Worker stopped unexpectedly."); quit(1); } });

// Back to the top, then two frames and a short pause so layout and the sticky header settle
const toTop = p => p.evaluate(() => { window.scrollTo(0, 0); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }).then(() => wait(200));

try {
  for (let i = 0; ; i++) {
    if (await fetch(B + "/api/stories").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local Worker didn't start.");
    await wait(1000);
  }
  const executablePath = browserPath();
  profile = mkdtempSync(join(tmpdir(), "th-look-"));
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: process.env.CI ? ["--no-sandbox"] : [],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); // our handler stops the Worker too
  mkdirSync(OUT, { recursive: true });

  for (const route of routes) {
    const shots = [], errors = [], failed = [], blocked = [], notes = [];
    for (const [width, height] of WIDTHS) for (const isDark of SCHEMES) for (const reduced of [false, true]) {
      const tag = `${width}${isDark ? "-dark" : ""}${reduced ? "-reduced" : ""}`;
      const file = join(OUT, `${slug(route)}-${tag}.png`);
      const phone = width < 500;
      const p = await browser.newPage();
      const aborted = new WeakSet();
      p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
      p.on("pageerror", e => errors.push(e.message));
      p.on("requestfailed", r => { if (!aborted.has(r)) failed.push(`${r.failure()?.errorText || "failed"} ${r.url()}`); });
      p.on("response", r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`); });
      await p.setRequestInterception(true);
      await p.setBypassServiceWorker(true);
      p.on("request", r => {
        const url = r.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return r.continue().catch(() => {});
        let origin = "";
        try { origin = new URL(url).origin; } catch { /* not a URL: blocked */ }
        if (origin === B && !url.startsWith(B + "/api/transit/")) return r.continue().catch(() => {});
        aborted.add(r);
        blocked.push(url);
        r.abort().catch(() => {});
      });
      await p.setViewport(phone ? { width, height, isMobile: true, hasTouch: true } : { width, height });
      const media = [...(isDark ? [{ name: "prefers-color-scheme", value: "dark" }] : []), ...(reduced ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [])];
      if (media.length) await p.emulateMediaFeatures(media);
      try {
        const res = await p.goto(B + route, { waitUntil: "load" });
        if (!res || res.status() >= 400) { bad = true; notes.push(`${tag}: main response ${res ? `HTTP ${res.status()}` : "missing"}`); }
        await p.waitForSelector("main > section.view:not([hidden])", { timeout: 10000 }).catch(() => notes.push(`${tag}: no view showed`));
        await p.evaluate(() => document.fonts.ready.then(() => {}));
        await wait(1500);
        await toTop(p);
        if (phone) {
          // A full-page capture beyond a mobile viewport draws the sticky header (and Home's banners inside it) one
          // header-height too low. Make the viewport as tall as the page instead, so there's nothing beyond it.
          const tall = await p.evaluate(() => document.documentElement.scrollHeight);
          await p.setViewport({ width, height: Math.max(height, tall), isMobile: true, hasTouch: true });
          await toTop(p);
          await p.screenshot({ path: file, captureBeyondViewport: false });
        } else {
          await p.screenshot({ path: file, fullPage: true });
        }
        shots.push(file);
      } catch (e) {
        bad = true;
        notes.push(`${tag}: ${e.message}`);
      }
      await p.close();
    }
    const uniq = a => [...new Set(a)];
    console.log(`\n${route}`);
    for (const f of shots) console.log(`  ${f}`);
    for (const n of notes) console.log(`  problem: ${n}`);
    console.log(`  console errors: ${uniq(errors).join(" | ") || "none"}`);
    console.log(`  failed requests: ${uniq(failed).join(" | ") || "none"}`);
    console.log(`  blocked requests: ${uniq(blocked).join(" | ") || "none"}`);
  }
} catch (e) {
  bad = true;
  console.error(e.message);
} finally {
  stopping = true; // our own stop, not a crash
  await browser?.close().catch(() => {});
  stopServer();
  dropProfile();
}
if (quitCode === null) process.exit(bad ? 1 : 0); // otherwise quit() exits with its own code
