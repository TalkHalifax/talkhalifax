// Opens the real site in a real browser against a local Worker with its own throwaway data: every page by direct link,
// and every kind of story by clicking its card, at phone and desktop widths. Run before every deploy.
//   npm run test:e2e
// Uses Chrome or Edge from the system, or the one at CHROME_PATH.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 8791, B = `http://localhost:${PORT}`;
const ADMIN_PORT = 8792, ADMIN = `http://localhost:${ADMIN_PORT}`;
const DATA = ".wrangler/e2e";
const WRANGLER = ["wrangler", "--config", "test/wrangler.test.jsonc"];
const win = process.platform === "win32";
const wait = ms => new Promise(r => setTimeout(r, ms));

const STORIES = [
  { id: "e2e-developing", kind: "article", stage: "developing", headline: "A story still developing", list: "home", cards: "#devCards", chat: true },
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
// The article page's layout: a new article, an older one, and a notice that changed
const story = (id, kind, section, source, version, note, facts, body, means, actions) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, actions, source_url, published_at, updated_at, last_newsroom_update, update_note, version, stage, developing_since) VALUES (${[id, kind, section, "Halifax", id, "A dek", facts, body, means, actions, source, now, now, now, note, version, "developing", now].map(v => typeof v === "number" ? v : q(v)).join(", ")});`;
const FACTS = '[{"k":"Call","v":"902-555-0100"}]';
const SEED_LAYOUT = story("e2e-new", "article", "Province", "https://news.novascotia.ca/x", 1, "", FACTS, '["First.","## A subheading","Second."]', "[]", '["Do this by Friday."]')
  + story("e2e-old", "article", "City Hall", "https://www.halifax.ca/x", 1, "", FACTS, '["First."]', '["An older point."]', "[]")
  + story("hw-e2e-changed", "notice", "Halifax Water", "https://www.halifaxwater.ca/x", 2, "The advisory was lifted", FACTS, '["First."]', '["Boil water."]', "[]");
const SEED_WEATHER = `INSERT INTO feeds (name, body, updated_at) VALUES ('weather', '${WEATHER}', '${now}');`;
// The API checks' own fake accounts, sessions, stories, chat messages, comments and report. Times are in ms, as the app keeps them.
const T = Date.now();
const dayBefore = new Date(Date.parse(now) - 864e5).toISOString().replace(/\.\d+Z$/, "Z"); // sorts below the cards above
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

function browserPath() {
  const found = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
  return found;
}

const npx = args => execSync(`npx ${args.join(" ")}`, { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });

let fails = 0;
const ok = (c, label, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`); if (!c) fails++; };

rmSync(DATA, { recursive: true, force: true });
npx([...WRANGLER, "d1", "migrations", "apply", "talkhalifax-test", "--local", "--persist-to", DATA]);
writeFileSync(`${DATA}/seed.sql`, `${SEED} ${SEED_WATER} ${SEED_LAYOUT} ${SEED_WEATHER} ${SEED_API}`);
npx([...WRANGLER, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);

const server = spawn("npx", [...WRANGLER, "dev", "--port", String(PORT), "--persist-to", DATA], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let adminServer;
const stopServer = (s = server) => {
  if (!s) return;
  try { if (win) execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: "ignore" }); else process.kill(-s.pid); } catch { /* already gone */ }
};

let browser;
try {
  for (let i = 0; ; i++) {
    if (await fetch(B + "/api/stories").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local Worker didn't start.");
    await wait(1000);
  }
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, userDataDir: mkdtempSync(join(tmpdir(), "th-e2e-")), args: process.env.CI ? ["--no-sandbox"] : [] });
  const errors = [];

  for (const [width, height, label] of [[1280, 900, "desktop"], [375, 812, "phone"]]) {
    const open = async hash => {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(`${label} #${hash}: ${e.message}`));
      await p.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
      await p.goto(`${B}/#${hash}`, { waitUntil: "load" });
      await wait(500);
      return p;
    };
    const view = p => p.evaluate(() => [...document.querySelectorAll("main > section.view")].filter(s => !s.hidden).map(s => s.id).join(","));
    // A story loads from the API after the page does, so wait for it rather than guessing how long that takes
    const heading = async (p, want) => {
      if (want) await p.waitForFunction(t => document.querySelector("#article h1")?.innerText === t, { timeout: 10000 }, want).catch(() => {});
      return p.evaluate(() => document.querySelector("#article h1")?.innerText || "");
    };

    // Every page, by direct link
    for (const [hash, want] of [["home", "home"], ["articles", "articles"], ["notices", "notices"], ["events", "events"], ["transit", "transit"], ["profile", "profile"],
      ["privacy", "privacy"], ["alerts", "profile"], ["not-a-page", "home"], ["user-nobody", "user"], ["reset-nothing", "reset"]]) {
      const p = await open(hash);
      const got = await view(p);
      ok(got === want, `${label}: #${hash} shows ${want}`, got === want ? "" : `showed ${got}`);
      await p.close();
    }

    for (const s of STORIES) {
      // By direct link
      let p = await open(`article-${s.id}`);
      const direct = await heading(p, s.headline);
      ok(await view(p) === "article" && direct === s.headline, `${label}: a direct link opens the ${s.id} story`, direct);
      await p.close();

      // By clicking its card, the way readers get there
      p = await open(s.list);
      await p.waitForSelector(`${s.cards} [data-article="${s.id}"]`, { timeout: 5000 }).catch(() => {});
      const card = await p.$(`${s.cards} [data-article="${s.id}"]`);
      ok(!!card, `${label}: ${s.id} has a card on #${s.list}`);
      if (card) {
        await card.evaluate(c => c.scrollIntoView({ block: "center" }));
        await card.click();
        await wait(600);
        ok(await heading(p, s.headline) === s.headline && await view(p) === "article", `${label}: clicking the ${s.id} card opens it`, await view(p));
        ok(await p.evaluate(id => location.hash === `#article-${id}`, s.id), `${label}: the address follows`);
        if (s.chat) ok(await p.$(".chat") !== null, `${label}: ${s.id} shows its live chat`);
      }
      await p.close();
    }

    // The weather: in the header on desktop, at the bottom of the menu on phones, and it never pushes the page sideways
    {
      const p = await open("home");
      await p.waitForSelector("#hdrWx:not([hidden])", { timeout: 5000 }).catch(() => {});
      const shown = await p.evaluate(() => { const r = document.getElementById("hdrWx").getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      ok(shown === (width >= 761), `${label}: the header ${width >= 761 ? "shows" : "leaves out"} the weather`);
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: the header fits`);
      if (width < 761) {
        await p.click("#meBtn");
        await wait(500);
        const line = await p.evaluate(() => document.querySelector("#navDrawer .wx")?.innerText || "");
        ok(line.includes("15°C"), `${label}: the menu shows the weather`, line);
      } else {
        ok((await p.evaluate(() => document.getElementById("hdrWx").innerText)).includes("Feels like 15°C"), `${label}: it reads as feels like`);
      }
      await p.close();
    }

    // Only a boil-water advisory pins to Home; one street's emergency shut-off stays on Notices
    {
      const p = await open("home");
      // A real weather warning, fetched live, can come first and fold the rest behind "+1 more"
      await p.evaluate(() => document.getElementById("abarMore")?.click());
      const bars = await p.evaluate(() => document.getElementById("abars").innerText);
      ok(bars.includes("Boil Water Advisory"), `${label}: a boil-water advisory pins to Home`);
      ok(!bars.includes("One Street"), `${label}: a one-street shut-off doesn't`);
      await p.close();
      const n = await open("notices");
      ok((await n.evaluate(() => document.getElementById("notices").innerText)).includes("One Street"), `${label}: the shut-off is on Notices`);
      await n.close();
    }

    // The article page: what comes first, and what it says about itself
    {
      const read = async id => {
        const a = await open("article-" + id);
        await heading(a, id);
        const out = await a.evaluate(() => {
          const r = document.querySelector("#article article");
          const at = s => { const e = r.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : -1; };
          return { text: r.innerText, back: document.querySelector("#article .back").innerText, kicker: r.querySelector(".kicker").innerText, byline: r.querySelector(".byline").innerText, sub: r.querySelector(".body h2:not(.means-h)")?.innerText,
            todo: at(".todo"), body: at(".body"), facts: at(".facts"), means: at(".means-h"), wide: document.documentElement.scrollWidth > innerWidth, tel: r.querySelector('.facts a[href^="tel:"]')?.innerText };
        });
        await a.close();
        return out;
      };
      const n = await read("e2e-new");
      ok(n.todo > 0 && n.todo < n.body && n.body < n.facts, `${label}: a new article runs what to do, story, key details`, JSON.stringify(n));
      ok(n.sub === "A subheading" && !n.text.includes("## "), `${label}: a body line starting ## is a subheading`);
      ok(!n.byline.includes("Updated"), `${label}: a story that never changed doesn't say Updated`, n.byline);
      ok(/1 min read/.test(n.byline) && /the Province's release/.test(n.byline), `${label}: the byline gives read time and names the source`, n.byline);
      ok(n.kicker.toUpperCase().includes("PROVINCE"), `${label}: an article outside City Hall names its section`, n.kicker);
      ok(n.tel === "902-555-0100", `${label}: a phone number can be tapped`, n.tel);
      ok(!n.wide, `${label}: the story fits the width`);
      const o = await read("e2e-old");
      ok(o.todo === -1 && o.means > o.body && o.facts > o.means, `${label}: an older article keeps its points at the bottom`, JSON.stringify(o));
      const w = await read("hw-e2e-changed");
      ok(w.kicker.toUpperCase().startsWith("HALIFAX WATER"), `${label}: a notice names its real source`, w.kicker);
      ok(w.back.includes("Notices"), `${label}: a notice goes back to Notices`, w.back);
      ok(w.todo > 0 && w.todo < w.facts && w.facts < w.body, `${label}: a notice runs what to do, facts, story`, JSON.stringify(w));
      ok(w.byline.includes("Updated") && w.text.includes("The advisory was lifted"), `${label}: a changed notice says so, and why`, w.byline);
    }

    // Moving between pages without reloading
    const p = await open("home");
    await p.evaluate(() => { location.hash = "#article-e2e-notice"; });
    await wait(500);
    ok(await heading(p, "A notice about a road") === "A notice about a road", `${label}: changing the address opens a story in place`);
    await p.evaluate(() => { location.hash = "#articles"; });
    await wait(500);
    ok(await view(p) === "articles", `${label}: and goes back to a list`);
    await p.close();
  }

  ok(!errors.length, "no script errors", errors.slice(0, 5).join("; "));

  // An open page reports its anonymous counts
  {
    const p = await browser.newPage();
    const report = p.waitForResponse(r => r.url().endsWith("/api/stats"), { timeout: 8000 }).catch(() => null);
    await p.goto(`${B}/#home`, { waitUntil: "load" });
    const r = await report;
    ok(r?.status() === 204, "an open page reports its anonymous counts", r ? `HTTP ${r.status()}` : "no report");
    const stored = await p.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
    ok(!/[a-f0-9]{24}/.test(stored), "the counting id isn't saved in the browser");
    await p.close();
  }

  // A reset link checks its token without putting it in a URL
  {
    const p = await browser.newPage();
    const urls = [];
    p.on("request", r => urls.push(r.url().split("#")[0])); // The part after # is never sent to the server
    await p.goto(`${B}/#reset-e2e-bad-token`, { waitUntil: "load" });
    await p.waitForFunction(() => /expired or was already used/.test(document.querySelector("#reset")?.innerText || ""), { timeout: 8000 }).catch(() => {});
    ok(/expired or was already used/.test(await p.evaluate(() => document.querySelector("#reset")?.innerText || "")), "a bad reset link says so");
    ok(!urls.some(u => u.includes("e2e-bad-token")), "a reset token never appears in a request's URL");
    await p.close();
  }

  // The admin site's real config keeps it off every other address, and can't skip the sign-in check
  const adminConfig = readFileSync("admin/wrangler.jsonc", "utf8");
  ok(/"workers_dev":\s*false/.test(adminConfig), "admin config: no workers.dev address");
  ok(/"preview_urls":\s*false/.test(adminConfig), "admin config: no preview addresses");
  ok(/"run_worker_first":\s*true/.test(adminConfig), "admin config: pages go through the sign-in check");
  ok(!adminConfig.includes("ADMIN_DEV"), "admin config: doesn't set the local bypass");
  ok(/"name":\s*"LOGIN_LIMIT"/.test(adminConfig), "admin config: limits sign-in attempts");
  ok(!/ADMIN_(USER|PASSWORD)"?\s*:/.test(adminConfig), "admin config: the username and password are secrets, not in the file");

  // The admin site, on the same throwaway data
  adminServer = spawn("npx", ["wrangler", "--config", "test/wrangler.admin.jsonc", "dev", "--port", String(ADMIN_PORT), "--persist-to", DATA, "--inspector-port", "9331"], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  for (let i = 0; ; i++) {
    if (await fetch(ADMIN + "/api/summary").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local admin Worker didn't start.");
    await wait(1000);
  }
  const adminErrors = [];
  for (const [width, height, label] of [[1280, 900, "desktop"], [375, 812, "phone"]]) {
    const open = async hash => {
      const p = await browser.newPage();
      p.on("pageerror", e => adminErrors.push(`${label} #${hash}: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_NAME|ERR_INTERNET/.test(m.text() + (m.location().url || ""))) adminErrors.push(`${label} #${hash}: ${m.text()}`); });
      await p.setViewport({ width, height });
      await p.goto(`${ADMIN}/#${hash}`, { waitUntil: "load" });
      return p;
    };
    const fits = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const h1 = p => p.evaluate(() => document.querySelector("h1")?.innerText || "");

    let p = await open("home");
    await p.waitForSelector("#charts .plot", { timeout: 8000 }).catch(() => {});
    ok(await h1(p) === "Home", `admin ${label}: Home opens`);
    ok(await p.$$eval("#charts > .card", c => c.length) === 4, `admin ${label}: Home has the four chart cards`);
    ok(await p.$$eval("#charts .plot", c => c.length) === 5, `admin ${label}: with a plot for each measure`);
    ok(await fits(p), `admin ${label}: Home fits the screen`);
    await p.click('[data-range="30d"]');
    await p.waitForFunction(() => document.querySelector('[data-range="30d"]').classList.contains("on"), { timeout: 5000 }).catch(() => {});
    ok(await p.$$eval("#charts .plot:first-child .col, #charts .plot .col", c => c.length) >= 30, `admin ${label}: the range switch redraws the charts`);
    await p.click("[data-table=signups]");
    ok(await p.$$eval("#charts .chart-table", c => c.length) === 1, `admin ${label}: a chart can show as a table`);
    await p.close();

    // Switching pages quickly shows the last one asked for, whichever answer arrives first
    p = await open("home");
    await p.evaluate(() => { location.hash = "#jobs"; location.hash = "#users"; location.hash = "#content-data"; location.hash = "#jobs"; });
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    await wait(1000);
    ok(await h1(p) === "Administration", `admin ${label}: switching quickly lands on the last page`, await h1(p));
    await p.close();

    p = await open("users");
    await p.waitForSelector("#urows", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Users", `admin ${label}: Users opens`);
    ok(await fits(p), `admin ${label}: Users fits the screen`);
    await p.close();

    p = await open("content");
    await p.waitForFunction(() => document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A story still developing"), `admin ${label}: Content lists the stories`);
    ok(await fits(p), `admin ${label}: Content fits the screen`);
    await p.click('[data-screen="Notices"]');
    await p.waitForFunction(() => !document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A notice about a road"), `admin ${label}: Content filters by screen`);
    await p.close();

    p = await open("content-data");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Content", { timeout: 5000 }).catch(() => {});
    ok(await fits(p), `admin ${label}: Data fits the screen`);
    await p.close();

    p = await open("jobs");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Administration", `admin ${label}: Administration opens`);
    ok(await fits(p), `admin ${label}: Administration fits the screen`);
    await p.close();
  }
  ok(!adminErrors.length, "admin: no script errors", adminErrors.slice(0, 5).join("; "));

  // The API by plain requests, on its own throwaway rows: what each route answers today, signed out, as a member and as a
  // moderator. Read-only checks first, then the ones that change things, account deletion last. Labels never carry a session or a reset link.
  {
    const call = (method, path, { as, origin = B, json: body, ct = body !== undefined ? "application/json" : undefined } = {}) => fetch(B + path, { method, headers: { ...(origin ? { origin } : {}), ...(ct ? { "content-type": ct } : {}), ...(as ? { cookie: `th_session=${as}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const api = async (method, path, opts) => { const r = await call(method, path, opts); return { status: r.status, cookie: r.headers.get("set-cookie") || "", body: await r.json().catch(() => null) }; };
    const http = r => `HTTP ${r.status}`;
    const MOD = "s_e2e_mod", MEMBER = "s_e2e_member", GONE = "s_e2e_delete";
    let r;

    r = await api("GET", "/api/nope");
    ok(r.status === 404 && r.body?.error === "Not found", "api: an unknown /api/ path is 404", http(r));

    // Who's signed in
    r = await api("GET", "/api/me");
    ok(r.status === 200 && r.body?.user === null && r.body?.providers?.password === true, "api: /api/me signed out has no user, and offers password sign-in", http(r));
    r = await api("GET", "/api/me", { as: MEMBER });
    const me = r.body?.user;
    ok(r.status === 200 && me?.id === "u_e2e_member" && me.role === "member" && me.banned === false && me.password === true && me.name === "E2E Member" && typeof me.avatarUrl === "string", "api: /api/me as a member", http(r));
    r = await api("GET", "/api/me", { as: MOD });
    ok(r.status === 200 && r.body?.user?.role === "moderator", "api: /api/me as a moderator", http(r));
    r = await api("GET", "/api/me", { as: "s_e2e_expired" });
    ok(r.status === 200 && r.body?.user === null, "api: an expired session is signed out", http(r));
    r = await api("PUT", "/api/me", { as: MEMBER, json: {} });
    ok(r.status === 404, "api: PUT /api/me (today: 404, not 405, JOB-10 may change)", http(r));

    r = await api("GET", "/api/me/messages");
    ok(r.status === 401, "api: /api/me/messages signed out is 401", http(r));
    r = await api("GET", "/api/me/messages", { as: MEMBER });
    const msg = r.body?.messages?.find(m => m.id === "m_e2e_mine");
    ok(r.status === 200 && msg?.storyId === "e2e-developing" && msg.headline === "A story still developing" && !r.body.messages.some(m => m.id === "m_e2e_other"), "api: /api/me/messages lists a member's own messages, with the story", http(r));
    ok(r.body?.stats?.messages === 1 && r.body?.stats?.rooms === 1, "api: and counts them", JSON.stringify(r.body?.stats));
    r = await api("POST", "/api/me/messages", { as: MEMBER });
    ok(r.status === 200, "api: POST /api/me/messages (today: 200, no method check, JOB-10 may change)", http(r));

    // Stories
    r = await api("GET", "/api/stories");
    const ids = (r.body?.stories || []).map(s => s.id);
    ok(r.status === 200 && ["e2e-developing", "e2e-article", "e2e-api-archived"].every(id => ids.includes(id)), "api: /api/stories lists developing and archived stories", http(r));
    ok(!ids.includes("e2e-api-draft"), "api: /api/stories leaves out drafts");
    r = await api("POST", "/api/stories");
    ok(r.status === 200, "api: POST /api/stories (today: 200, no method check, JOB-10 may change)", http(r));
    r = await api("GET", "/api/stories/e2e-article");
    const one = r.body?.story;
    ok(r.status === 200 && one?.id === "e2e-article" && one.stage === "archived" && ["body", "facts", "means", "actions"].every(k => Array.isArray(one[k])), "api: one story comes with its body, facts, points and actions", http(r));
    r = await api("GET", "/api/stories/e2e-nope");
    ok(r.status === 404, "api: an unknown story is 404", http(r));
    r = await api("GET", "/api/stories/e2e-api-draft");
    ok(r.status === 404, "api: a draft is 404 to readers", http(r));
    r = await api("POST", "/api/stories/e2e-article");
    ok(r.status === 200, "api: POST /api/stories/:id (today: 200, no method check, JOB-10 may change)", http(r));

    // Public profiles
    r = await api("GET", "/api/users/u_e2e_member");
    const pu = r.body;
    ok(r.status === 200 && pu?.user?.id === "u_e2e_member" && pu.user.role === "member" && pu.user.ai === false && typeof pu.stats?.messages === "number" && typeof pu.stats?.rooms === "number"
      && Array.isArray(pu.stories) && pu.stories.length === 0 && pu.mod === null, "api: a public profile, signed out, has no moderator tools", http(r));
    r = await api("GET", "/api/users/u_e2e_member", { as: MOD });
    ok(r.status === 200 && r.body?.mod?.banned === false && r.body.mod.password === true, "api: a moderator also sees ban and password status", http(r));
    r = await api("GET", "/api/users/u_e2e_member", { as: MEMBER });
    ok(r.status === 200 && r.body?.mod === null, "api: a member viewing their own profile gets no moderator tools", http(r));
    r = await api("GET", "/api/users/u_e2e_nope");
    ok(r.status === 404, "api: an unknown user is 404", http(r));
    r = await api("POST", "/api/users/u_e2e_member");
    ok(r.status === 200, "api: POST /api/users/:id (today: 200, no method check, JOB-10 may change)", http(r));

    // Anonymous counts (few calls: the limit is 60 a minute, and over it looks like success)
    const STATS = { sid: "0123456789abcdef", shown: ["e2e-developing"], opened: [] };
    r = await api("POST", "/api/stats", { json: STATS });
    ok(r.status === 204, "api: /api/stats takes a same-origin JSON report", http(r));
    r = await api("POST", "/api/stats", { json: STATS, origin: null });
    ok(r.status === 400, "api: /api/stats refuses a report without an origin", http(r));
    r = await api("POST", "/api/stats", { json: STATS, ct: "text/plain" });
    ok(r.status === 400, "api: /api/stats refuses a report that isn't JSON", http(r));
    r = await api("POST", "/api/stats", { json: { sid: "x" } });
    ok(r.status === 400, "api: /api/stats refuses a bad counting id", http(r));
    r = await api("GET", "/api/stats");
    ok(r.status === 404, "api: GET /api/stats (today: 404, not 405, JOB-10 may change)", http(r));

    // Routes handed off to other modules, one smoke check each
    r = await api("GET", "/api/weather");
    ok(r.status === 200 && !!r.body?.weather && typeof r.body.weather === "object", "api: /api/weather answers with the weather", http(r));
    r = await api("GET", "/api/alerts");
    ok(r.status === 200 && !!r.body && "alerts" in r.body, "api: /api/alerts answers", http(r));
    r = await api("GET", "/api/transit/nope");
    ok(r.status === 404, "api: an unknown transit feed is 404", http(r));
    r = await api("GET", "/api/transit");
    ok(r.status === 404, "api: /api/transit without a slash (today: 404, JOB-10 may change)", http(r));
    r = await api("GET", "/api/events");
    ok(r.status === 503, "api: GET /api/events with no events (today: 503)", http(r));
    r = await api("GET", "/api/events/ingest");
    ok(r.status === 405, "api: GET /api/events/ingest (today: 405, the only 405)", http(r));
    r = await api("POST", "/api/events/ingest", { json: {} });
    ok(r.status === 401, "api: /api/events/ingest without its token is 401", http(r));
    r = await api("GET", "/api/push");
    ok(r.status === 200 && typeof r.body?.enabled === "boolean" && r.body?.kinds?.length === 6, "api: /api/push gives its switch and six kinds", http(r));
    r = await api("POST", "/api/push/subscribe", { json: {}, origin: null });
    ok(r.status === 400, "api: /api/push/subscribe refuses a request without an origin", http(r));
    r = await api("PUT", "/api/newsroom/stories/e2e-nope", { json: {} });
    ok(r.status === 401 && r.body?.error === "Unauthorized", "api: the newsroom API without its token is 401", http(r));

    // Comments: reading
    const COMMENTS = "/api/stories/e2e-api-archived/comments";
    r = await api("GET", COMMENTS);
    const seeded = r.body?.comments?.find(c => c.id === "c_e2e_mine");
    ok(r.status === 200 && !!seeded && ["id", "parentId", "uid", "text", "at", "name"].every(k => k in seeded), "api: an archived story lists its comments", http(r));
    r = await api("GET", "/api/stories/e2e-nope/comments");
    ok(r.status === 200 && Array.isArray(r.body?.comments) && r.body.comments.length === 0, "api: GET comments for unknown story (today: 200 empty, not 404, JOB-10 may change)", http(r));

    // Comments: posting
    r = await api("PUT", COMMENTS, { as: MEMBER, json: { text: "A put." } });
    ok(r.status === 400, "api: PUT on /api/stories/:id/comments (today: 400, not 405, JOB-10 may change)", http(r));
    r = await api("POST", COMMENTS, { as: MEMBER, json: { text: "No origin." }, origin: null });
    ok(r.status === 400, "api: a comment without an origin is refused", http(r));
    r = await api("POST", COMMENTS, { json: { text: "Signed out." } });
    ok(r.status === 401, "api: a comment signed out is 401", http(r));
    r = await api("POST", "/api/stories/e2e-developing/comments", { as: MEMBER, json: { text: "Too early." } });
    ok(r.status === 409, "api: a developing story takes no comments", http(r));
    r = await api("POST", "/api/stories/e2e-notice/comments", { as: MEMBER, json: { text: "On a notice." } });
    ok(r.status === 404, "api: a notice takes no comments", http(r));
    r = await api("POST", "/api/stories/e2e-nope/comments", { as: MEMBER, json: { text: "Nowhere." } });
    ok(r.status === 404, "api: a comment on an unknown story is 404", http(r));
    r = await api("POST", COMMENTS, { as: MEMBER, json: { text: "" } });
    ok(r.status === 400, "api: an empty comment is refused", http(r));
    r = await api("POST", COMMENTS, { as: MEMBER, json: { text: "A plain e2e comment." } });
    const posted = r.body?.comment;
    ok(r.status === 200 && /^c_/.test(posted?.id || "") && posted.uid === "u_e2e_member" && posted.text === "A plain e2e comment.", "api: a member comments on an archived story", http(r));

    // Comments: deleting
    r = await api("DELETE", "/api/comments/c_e2e_mine", { as: MEMBER, origin: null });
    ok(r.status === 400, "api: deleting a comment without an origin is refused", http(r));
    r = await api("DELETE", "/api/comments/c_e2e_mine");
    ok(r.status === 401, "api: DELETE /api/comments/:id without content-type passes the origin check (today: direct origin compare, JOB-10 may change)", http(r));
    r = await api("DELETE", "/api/comments/c_nope", { as: MEMBER });
    ok(r.status === 404, "api: deleting an unknown comment is 404", http(r));
    r = await api("DELETE", "/api/comments/c_e2e_other", { as: MEMBER });
    ok(r.status === 403, "api: a member can't delete someone else's comment", http(r));
    r = await api("DELETE", "/api/comments/c_e2e_mine", { as: MEMBER });
    ok(r.status === 200 && r.body?.ok === true, "api: a member deletes their own comment", http(r));
    r = await api("GET", COMMENTS);
    ok(r.status === 200 && Array.isArray(r.body?.comments) && !r.body.comments.some(c => c.id === "c_e2e_mine"), "api: and it's no longer listed", http(r));
    r = await api("DELETE", "/api/comments/c_e2e_other", { as: MOD });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator deletes anyone's comment", http(r));
    r = await api("GET", "/api/comments/c_e2e_other");
    ok(r.status === 404, "api: GET /api/comments/:id (today: 404, not 405, JOB-10 may change)", http(r));

    // Reports: filing
    r = await api("POST", "/api/reports", { as: MEMBER, json: { kind: "message", id: "m_e2e_other" }, origin: null });
    ok(r.status === 400, "api: a report without an origin is refused", http(r));
    r = await api("POST", "/api/reports", { json: { kind: "message", id: "m_e2e_other" } });
    ok(r.status === 401, "api: a report signed out is 401", http(r));
    r = await api("POST", "/api/reports", { as: MEMBER, json: { kind: "bogus", id: "x" } });
    ok(r.status === 400, "api: a report of an unknown kind is refused", http(r));
    r = await api("POST", "/api/reports", { as: MEMBER, json: { kind: "comment", id: "c_nope" } });
    ok(r.status === 404, "api: a report of an unknown comment is 404", http(r));
    r = await api("POST", "/api/reports", { as: MEMBER, json: { kind: "message", id: "m_e2e_mine" } });
    ok(r.status === 400, "api: a member can't report their own message", http(r));
    r = await api("POST", "/api/reports", { as: MEMBER, json: { kind: "message", id: "m_e2e_other" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a member reports someone else's message", http(r));

    // Reports: the moderators' list
    r = await api("GET", "/api/reports");
    ok(r.status === 403, "api: signed out on GET /api/reports (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("GET", "/api/reports", { as: MEMBER });
    ok(r.status === 403, "api: a member can't list reports", http(r));
    r = await api("GET", "/api/reports", { as: MOD });
    const reported = (r.body?.reports || []).map(x => x.id);
    ok(r.status === 200 && reported.includes("c_e2e_seeded") && reported.includes("m_e2e_other"), "api: a moderator lists open reports by reported item", http(r));
    r = await api("DELETE", "/api/reports", { as: MOD });
    ok(r.status === 200 && Array.isArray(r.body?.reports), "api: DELETE /api/reports as moderator (today: 200 list, no method check, JOB-10 may change)", http(r));

    // Reports: acting on one
    r = await api("POST", "/api/reports/c_e2e_seeded", { as: MOD, json: { action: "dismiss" }, origin: null });
    ok(r.status === 400, "api: acting on a report without an origin is refused", http(r));
    r = await api("POST", "/api/reports/c_e2e_seeded", { as: MEMBER, json: { action: "dismiss" } });
    ok(r.status === 403, "api: a member can't act on a report", http(r));
    r = await api("POST", "/api/reports/c_e2e_seeded", { json: { action: "dismiss" } });
    ok(r.status === 403, "api: signed out on POST /api/reports/:id (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("POST", "/api/reports/c_e2e_seeded", { as: MOD, json: { action: "nope" } });
    ok(r.status === 400, "api: an unknown report action is refused", http(r));
    r = await api("POST", "/api/reports/r_e2e_1", { as: MOD, json: { action: "dismiss" } });
    ok(r.status === 409, "api: /api/reports/:id takes the reported item's id, not the report's (today: report id gives 409)", http(r));
    r = await api("POST", "/api/reports/c_e2e_seeded", { as: MOD, json: { action: "dismiss" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator dismisses a report", http(r));
    r = await api("POST", "/api/reports/c_e2e_seeded", { as: MOD, json: { action: "dismiss" } });
    ok(r.status === 409, "api: a report already handled is 409", http(r));
    r = await api("POST", "/api/reports/m_e2e_other", { as: MOD, json: { action: "remove" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator removes a reported message", http(r));
    r = await api("POST", "/api/reports/x_nope", { as: MOD, json: { action: "dismiss" } });
    ok(r.status === 409, "api: unknown report target (today: 409, not 404, JOB-10 may change)", http(r));
    r = await api("GET", "/api/reports/c_e2e_seeded", { as: MOD });
    ok(r.status === 404, "api: GET /api/reports/:id (today: 404, not 405, JOB-10 may change)", http(r));

    // Review: drafts the newsroom held back
    r = await api("GET", "/api/review");
    ok(r.status === 403, "api: signed out on GET /api/review (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("GET", "/api/review", { as: MEMBER });
    ok(r.status === 403, "api: a member can't see drafts", http(r));
    r = await api("GET", "/api/review", { as: MOD });
    const draft = r.body?.drafts?.find(d => d.id === "e2e-api-draft");
    ok(r.status === 200 && Array.isArray(draft?.facts) && Array.isArray(draft?.body), "api: a moderator sees drafts, with facts and body", http(r));
    r = await api("POST", "/api/review", { as: MOD });
    ok(r.status === 200, "api: POST /api/review as moderator (today: 200, no method check, JOB-10 may change)", http(r));
    const REVIEW = id => `/api/stories/${id}/review`;
    r = await api("POST", REVIEW("e2e-api-draft"), { as: MOD, json: { action: "approve" }, origin: null });
    ok(r.status === 400, "api: reviewing without an origin is refused", http(r));
    r = await api("POST", REVIEW("e2e-api-draft"), { as: MEMBER, json: { action: "approve" } });
    ok(r.status === 403, "api: a member can't review", http(r));
    r = await api("POST", REVIEW("e2e-api-draft"), { json: { action: "approve" } });
    ok(r.status === 403, "api: signed out on POST /api/stories/:id/review (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("POST", REVIEW("e2e-api-draft"), { as: MOD, json: { action: "nope" } });
    ok(r.status === 400, "api: an unknown review action is refused", http(r));
    r = await api("POST", REVIEW("e2e-nope"), { as: MOD, json: { action: "approve" } });
    ok(r.status === 409, "api: unknown draft on review (today: 409, not 404, JOB-10 may change)", http(r));
    r = await api("POST", REVIEW("e2e-api-draft"), { as: MOD, json: { action: "approve" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator approves a draft", http(r));
    r = await api("GET", "/api/stories/e2e-api-draft");
    ok(r.status === 200 && r.body?.story?.stage === "developing", "api: and it's published as developing", http(r));
    r = await api("POST", REVIEW("e2e-api-draft"), { as: MOD, json: { action: "approve" } });
    ok(r.status === 409, "api: a draft already approved is 409", http(r));
    r = await api("POST", REVIEW("e2e-api-draft2"), { as: MOD, json: { action: "discard" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator discards a draft", http(r));
    r = await api("GET", "/api/stories/e2e-api-draft2");
    ok(r.status === 404, "api: and readers never see it", http(r));
    r = await api("GET", REVIEW("e2e-api-draft"), { as: MOD });
    ok(r.status === 404, "api: GET /api/stories/:id/review (today: 404, not 405, JOB-10 may change)", http(r));

    // Stage: moving a story between Developing and Articles by hand
    const STAGE = id => `/api/stories/${id}/stage`;
    r = await api("POST", STAGE("e2e-api-archived"), { as: MOD, json: { stage: "developing" }, origin: null });
    ok(r.status === 400, "api: changing a stage without an origin is refused", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { as: MEMBER, json: { stage: "developing" } });
    ok(r.status === 403, "api: a member can't change a stage", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { json: { stage: "developing" } });
    ok(r.status === 403, "api: signed out on POST /api/stories/:id/stage (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { as: MOD, json: { stage: "nope" } });
    ok(r.status === 409, "api: bad stage on stage (today: 409, not 400, JOB-10 may change)", http(r));
    r = await api("POST", STAGE("e2e-nope"), { as: MOD, json: { stage: "developing" } });
    ok(r.status === 409, "api: unknown story on stage (today: 409, not 404, JOB-10 may change)", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { as: MOD, json: { stage: "developing" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator moves an article back to developing", http(r));
    r = await api("GET", "/api/stories/e2e-api-archived");
    ok(r.status === 200 && r.body?.story?.stage === "developing", "api: and it shows as developing", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { as: MOD, json: { stage: "developing" } });
    ok(r.status === 409, "api: moving a story to the stage it's in is 409", http(r));
    r = await api("POST", STAGE("e2e-api-archived"), { as: MOD, json: { stage: "archived" } });
    ok(r.status === 200 && r.body?.ok === true, "api: a moderator moves it down to Articles", http(r));
    r = await api("GET", "/api/stories/e2e-api-archived");
    ok(r.status === 200 && r.body?.story?.stage === "archived", "api: and it shows as archived", http(r));
    r = await api("GET", STAGE("e2e-api-archived"), { as: MOD });
    ok(r.status === 404, "api: GET /api/stories/:id/stage (today: 404, not 405, JOB-10 may change)", http(r));

    // Bans
    const BAN = id => `/api/users/${id}/ban`;
    r = await api("POST", BAN("u_e2e_ban"), { as: MOD, json: { banned: true }, origin: null });
    ok(r.status === 400, "api: banning without an origin is refused", http(r));
    r = await api("POST", BAN("u_e2e_ban"), { as: MEMBER, json: { banned: true } });
    ok(r.status === 403, "api: a member can't ban", http(r));
    r = await api("POST", BAN("u_e2e_ban"), { json: { banned: true } });
    ok(r.status === 403, "api: signed out on POST /api/users/:id/ban (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("POST", BAN("u_e2e_nope"), { as: MOD, json: { banned: true } });
    ok(r.status === 404, "api: banning an unknown user is 404", http(r));
    r = await api("POST", BAN("u_e2e_mod"), { as: MOD, json: { banned: true } });
    ok(r.status === 400, "api: a moderator can't be banned", http(r));
    r = await api("POST", BAN("u_e2e_ban"), { as: MOD, json: { banned: true } });
    ok(r.status === 200 && r.body?.ok === true && r.body.banned === true, "api: a moderator bans a member", http(r));
    r = await api("GET", "/api/users/u_e2e_ban", { as: MOD });
    ok(r.status === 200 && r.body?.mod?.banned === true, "api: and the profile shows it to moderators", http(r));
    r = await api("POST", BAN("u_e2e_ban"), { as: MOD, json: { banned: false } });
    ok(r.status === 200 && r.body?.ok === true && r.body.banned === false, "api: a moderator lifts the ban", http(r));
    r = await api("GET", BAN("u_e2e_ban"), { as: MOD });
    ok(r.status === 404, "api: GET /api/users/:id/ban (today: 404, not 405, JOB-10 may change)", http(r));

    // Password reset links
    const RESET = id => `/api/users/${id}/reset`;
    r = await api("POST", RESET("u_e2e_reset"), { as: MOD, json: {}, origin: null });
    ok(r.status === 400, "api: a reset link without an origin is refused", http(r));
    r = await api("POST", RESET("u_e2e_reset"), { as: MEMBER, json: {} });
    ok(r.status === 403, "api: a member can't make a reset link", http(r));
    r = await api("POST", RESET("u_e2e_reset"), { json: {} });
    ok(r.status === 403, "api: signed out on POST /api/users/:id/reset (today: 403, not 401, JOB-9 or JOB-10 may change)", http(r));
    r = await api("POST", RESET("u_e2e_reset"), { as: MOD, json: {} });
    ok(r.status === 200 && typeof r.body?.url === "string" && r.body.url.startsWith(`${B}/#reset-`) && r.body.expiresIn === "1 hour", "api: a moderator makes a one-hour reset link for a password account", http(r));
    r = await api("POST", RESET("u_e2e_google"), { as: MOD, json: {} });
    ok(r.status === 400, "api: a Google account gets no reset link", http(r));
    r = await api("POST", RESET("u_e2e_nope"), { as: MOD, json: {} });
    ok(r.status === 400, "api: reset for unknown user (today: 400, not 404, JOB-10 may change)", http(r));
    r = await api("GET", RESET("u_e2e_reset"), { as: MOD });
    ok(r.status === 404, "api: GET /api/users/:id/reset (today: 404, not 405, JOB-10 may change)", http(r));

    // Deleting your own account, last
    r = await api("DELETE", "/api/me", { as: GONE, origin: null });
    ok(r.status === 400, "api: deleting an account without an origin is refused", http(r));
    r = await api("DELETE", "/api/me", { as: GONE, origin: "http://evil.example" });
    ok(r.status === 400, "api: deleting an account from another site is refused", http(r));
    r = await api("DELETE", "/api/me");
    ok(r.status === 401, "api: DELETE /api/me without content-type passes the origin check (today: direct origin compare, JOB-10 may change)", http(r));
    r = await api("DELETE", "/api/me", { as: GONE });
    ok(r.status === 200 && r.body?.ok === true && r.cookie.includes("th_session=;") && r.cookie.includes("Max-Age=0"), "api: a member deletes their account, and the session cookie is cleared", http(r));
    r = await api("GET", "/api/me", { as: GONE });
    ok(r.status === 200 && r.body?.user === null, "api: the deleted account's session no longer works", http(r));
    r = await api("GET", "/api/users/u_e2e_delete");
    ok(r.status === 200 && r.body?.user?.name === "Deleted account", "api: the profile says Deleted account", http(r));
  }
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  stopServer(adminServer);
}
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
