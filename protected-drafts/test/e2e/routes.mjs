// Opens the real site in a real browser against a local Worker with its own throwaway data: every page by direct link,
// and every kind of story by clicking its card, at phone and desktop widths. Run before every deploy.
//   npm run test:e2e
// Uses Chrome or Edge from the system, or the one at CHROME_PATH.
// Each run has its own id, data folder (.wrangler/e2e-<run id>, removed at the end) and port: one the OS hands out, or
// E2E_PORT if set (never another). Before any check it makes sure the Worker answering is this run's own.
import { randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { checkSwPush } from "./sw-push.mjs";

// This run's id (8 hex characters, short for Windows path length), its data folder and its own marker user
const RUN = randomBytes(4).toString("hex");
const DATA = `.wrangler/e2e-${RUN}`;
const RUN_USER = `u_e2e_run_${RUN}`;
let PORT, B, INSPECTOR; // chosen below, before any wrangler call; B always follows PORT
const usePort = p => { PORT = p; B = `http://localhost:${PORT}`; };
const WRANGLER = ["wrangler", "--config", "test/wrangler.test.jsonc"];
const win = process.platform === "win32";
const wait = ms => new Promise(r => setTimeout(r, ms));

// A connection means something is listening on that port and host; an error (refused, or no ::1 at all) means free
const inUse = (port, host) => new Promise(r => { const s = connect(port, host); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const busyOn = async port => (await inUse(port, "127.0.0.1")) ? "127.0.0.1" : (await inUse(port, "::1")) ? "::1" : "";
// A port the OS hands out on 127.0.0.1 that is also free on ::1 and isn't `avoid`: up to 5 tries
const freePort = async (avoid = 0) => {
  for (let i = 0; i < 5; i++) {
    const srv = createServer();
    await new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(0, "127.0.0.1", resolve); });
    const port = srv.address().port;
    await new Promise(resolve => srv.close(resolve));
    if (port !== avoid && !await inUse(port, "::1")) return port;
  }
  throw new Error("couldn't find a free port");
};
// This run's data folder goes when the run ends. Node's retry delay grows linearly, so a locked file is retried for about
// 16.5 s at most; a folder left behind is named but never fails the run.
let dataDone = false;
const removeData = () => {
  if (dataDone) return;
  dataDone = true;
  try { rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* reported below */ }
  if (existsSync(DATA)) console.error(`data folder left behind: ${DATA}`);
};
class StartupError extends Error {}

// The port: E2E_PORT if set (in use means stop, never another port), otherwise one from the OS
const FORCED = process.env.E2E_PORT;
const PORT_FROM = FORCED === undefined ? "port from the OS" : "E2E_PORT";
if (FORCED !== undefined) {
  if (!/^\d+$/.test(FORCED) || Number(FORCED) < 1024 || Number(FORCED) > 65535) {
    console.error(`E2E_PORT must be a whole number from 1024 to 65535, not "${FORCED}"`);
    process.exit(1);
  }
  usePort(Number(FORCED));
  const host = await busyOn(PORT);
  if (host) {
    console.error(`port ${PORT} (E2E_PORT) is in use on ${host}; not starting`);
    process.exit(1);
  }
} else {
  try { usePort(await freePort()); } catch (e) { console.error(e.message); process.exit(1); }
}
// The inspector port, always from the OS. Left to itself wrangler 4.158.0 starts at 9229 and takes the first free port
// (node_modules/wrangler/wrangler-dist/cli.js:214156, DEFAULT_INSPECTOR_PORT = 9229; :214913, getInspectorPort =
// memoizeGetPort(DEFAULT_INSPECTOR_PORT, "127.0.0.1")), so two runs started together can race for the same port.
try { INSPECTOR = await freePort(PORT); } catch (e) { console.error(e.message); process.exit(1); }

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
// The article page's layout: a new article, an older one, and a notice that changed
const story = (id, kind, section, source, version, note, facts, body, means, actions) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, actions, source_url, published_at, updated_at, last_newsroom_update, update_note, version, stage, developing_since) VALUES (${[id, kind, section, "Halifax", id, "A dek", facts, body, means, actions, source, now, now, now, note, version, "developing", now].map(v => typeof v === "number" ? v : q(v)).join(", ")});`;
const FACTS = '[{"k":"Call","v":"902-555-0100"}]';
const SEED_LAYOUT = story("e2e-new", "article", "Province", "https://news.novascotia.ca/x", 1, "", FACTS, '["First.","## A subheading","Second."]', "[]", '["Do this by Friday."]')
  + story("e2e-old", "article", "City Hall", "https://www.halifax.ca/x", 1, "", FACTS, '["First."]', '["An older point."]', "[]")
  + story("hw-e2e-changed", "notice", "Halifax Water", "https://www.halifaxwater.ca/x", 2, "The advisory was lifted", FACTS, '["First."]', '["Boil water."]', "[]");
const SEED_WEATHER = `INSERT INTO feeds (name, body, updated_at) VALUES ('weather', '${WEATHER}', '${now}');`;
const ALERTS = JSON.stringify({ updatedAt: now, items: [
  { cat: "Weather", kind: "Warning", title: "Wind warning in effect", detail: "", until: new Date(Date.parse(now) + 12 * 36e5).toISOString().replace(/\.\d+Z$/, "Z"), url: "https://weather.gc.ca/", publishedAt: now },
  { cat: "Weather", kind: "Watch", title: "Rainfall watch in effect", detail: "", until: "", url: "https://weather.gc.ca/", publishedAt: now } ] });
const SEED_ALERTS = `INSERT INTO feeds (name, body, updated_at) VALUES ('alerts', '${ALERTS}', '${now}');`; // fresh, so the Worker never fetches Environment Canada
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
// This run's marker: a user only this run's data has, so the Worker on the port can be checked as ours. A user, not a
// story, since some checks count stories exactly.
const SEED_RUN = apiUser(RUN_USER, "password", `e2e_run_${RUN}`, "E2E Run", "member");

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

// The site version: the deploy stamps v<PR number> over exactly one "dev" in each file, so each must be there once (docs/DESIGN-SYSTEM.md, "Site version")
{
  const occurs = (file, str) => readFileSync(file, "utf8").split(str).length - 1;
  const html = occurs("public/index.html", '<span class="sf-ver" id="sfVer">dev</span>');
  ok(html === 1, "public/index.html has the footer's version placeholder exactly once", `found ${html}`);
  const sw = occurs("public/sw.js", 'const BUILD = "dev";');
  ok(sw === 1, "public/sw.js has the service worker's version placeholder exactly once", `found ${sw}`);
}
await checkSwPush(ok);

rmSync(DATA, { recursive: true, force: true });
npx([...WRANGLER, "d1", "migrations", "apply", "talkhalifax-test", "--local", "--persist-to", DATA]);
writeFileSync(`${DATA}/seed.sql`, `${SEED} ${SEED_WATER} ${SEED_LAYOUT} ${SEED_WEATHER} ${SEED_ALERTS} ${SEED_API} ${SEED_RUN}`);
npx([...WRANGLER, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);

// Both ports again, just before the Worker starts, since something may have taken them meanwhile. E2E_PORT taken: stop.
{
  const host = await busyOn(PORT);
  if (host && FORCED !== undefined) {
    console.error(`port ${PORT} (E2E_PORT) is in use on ${host}; not starting`);
    removeData();
    process.exit(1);
  }
  try {
    if (host) usePort(await freePort(INSPECTOR));
    if (await busyOn(INSPECTOR)) INSPECTOR = await freePort(PORT);
  } catch (e) { console.error(e.message); removeData(); process.exit(1); }
}
const server = spawn("npx", [...WRANGLER, "dev", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--inspector-ip", "127.0.0.1", "--persist-to", DATA], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
console.log(`Local Worker: ${B} (${PORT_FROM}), inspector ${INSPECTOR}, data ${DATA}, run ${RUN}, pid ${server.pid}`);
let exited = null;
server.once("exit", (code, signal) => { exited = { code, signal }; });
const stopServer = (s = server) => {
  if (!s) return;
  try { if (win) execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: "ignore" }); else process.kill(-s.pid); } catch { /* already gone */ }
};
// Resolves once the Worker process has exited, or after ms; at once if it already has
const waitExit = (s = server, ms = 10000) => !s || s.exitCode !== null || s.signalCode !== null ? Promise.resolve()
  : new Promise(r => { const t = setTimeout(r, ms); s.once("exit", () => { clearTimeout(t); r(); }); });

let browser, startFailed = false;
try {
  for (let i = 0; ; i++) {
    if (exited) throw new StartupError(`The local Worker exited before it was ready (code ${exited.code}, signal ${exited.signal}), port ${PORT}`);
    if (await fetch(B + "/api/stories").then(r => r.ok, () => false)) break;
    if (i > 60) throw new StartupError(`The local Worker didn't start on port ${PORT}.`);
    await wait(1000);
  }
  // Something answered: make sure it's this run's Worker, on this run's data, before any check runs
  const ours = await fetch(`${B}/api/users/${RUN_USER}`).then(async r => r.status === 200 && (await r.json().catch(() => null))?.user?.id === RUN_USER, () => false);
  if (!ours) throw new StartupError(`port ${PORT} answered, but not as this run's Worker (${RUN_USER} missing); not testing someone else's Worker`);
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, userDataDir: mkdtempSync(join(tmpdir(), "th-e2e-")), args: process.env.CI ? ["--no-sandbox"] : [] });
  const errors = [];
  // #62 T5 and T6: the boxes of Home's grid, main column and "Right now" rail, with the rail shown (a stand-in line in it) or
  // hidden, and whether the page scrolls sideways. One evaluate, so the change and the reads go together.
  const homeColumns = (p, showRail) => p.evaluate(show => {
    const rail = document.getElementById("homeRail");
    if (show) {
      rail.hidden = false;
      document.getElementById("railBody").insertAdjacentHTML("beforeend", "<p>A stand-in for the rail</p>");
    } else {
      rail.hidden = true;
    }
    const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
    return { grid: box("#home .home-grid"), main: box("#home .home-main"), rail: box("#homeRail"), wide: document.documentElement.scrollWidth > innerWidth };
  }, showRail);
  // #64: a click that can't stop the run. Returns "" once the element is shown and clicked, or why not; the check that
  // follows folds the reason into its FAIL, so a missing or hidden element is a failed check, never a thrown error.
  const tryClick = async (p, sel) => {
    try {
      const el = await p.waitForSelector(sel, { visible: true, timeout: 5000 });
      await el.evaluate(e => e.scrollIntoView({ block: "center" }));
      await el.click();
      return "";
    } catch (e) { return `couldn't click ${sel}: ${String(e?.message ?? e).split("\n")[0]}`; }
  };
  // #64: choose one of Home's phone tabs by clicking it, then wait until #home and the tab say so (never a bare read)
  const chooseTab = async (p, tab) => {
    const why = await tryClick(p, `#homeTabs [role="tab"][data-tab="${tab}"]`);
    if (why) return why;
    return p.waitForFunction(t => document.getElementById("home")?.dataset.tab === t && document.querySelector(`#homeTabs [data-tab="${t}"]`)?.getAttribute("aria-selected") === "true", { timeout: 5000 }, tab)
      .then(() => "", () => `the ${tab} tab didn't take`);
  };
  // #64: a key press that can't stop the run, like tryClick
  const tryPress = (p, key) => p.keyboard.press(key).then(() => "", e => `couldn't press ${key}: ${String(e?.message ?? e).split("\n")[0]}`);
  // #64: Developing's swipe row below 760px. One evaluate reads the row, scrolls it to its end and reads the page again
  // a moment later, so the change and the reads go together. Three checks.
  const checkSwipe = async (p, tag) => {
    const s = await p.evaluate(async () => {
      const pins = document.getElementById("pins"), cs = getComputedStyle(pins);
      const cards = [...pins.querySelectorAll(":scope > .card[data-article]")];
      const inner = pins.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const page = () => ({ fits: document.documentElement.scrollWidth <= innerWidth, x: scrollX });
      const out = { display: cs.display, overflowX: cs.overflowX, snap: cs.scrollSnapType, cards: cards.length,
        aligns: cards.map(c => getComputedStyle(c).scrollSnapAlign), leadFirst: !!pins.firstElementChild?.matches(".card.lead"),
        widths: cards.map(c => c.getBoundingClientRect().width / inner),
        peeks: (cards[1]?.getBoundingClientRect().left ?? Infinity) < pins.getBoundingClientRect().right,
        overflows: pins.scrollWidth > pins.clientWidth, before: page() };
      pins.scrollLeft = pins.scrollWidth;
      await new Promise(r => setTimeout(r, 250));
      return { ...out, scrolled: pins.scrollLeft, after: page() };
    });
    ok(s.display === "flex" && s.overflowX === "auto" && s.snap === "x mandatory" && s.cards === 3 && s.aligns.every(a => a === "start") && s.leadFirst, `${tag}: Developing is a sideways swipe row that snaps, lead first`, `${s.display}, ${s.overflowX}, ${s.snap}, ${s.cards} cards, ${s.aligns.join("/")}`);
    ok(s.widths.length === 3 && s.widths.every(w => w >= 0.8 && w <= 0.9) && s.peeks && s.overflows, `${tag}: each swipe card is about 85% wide and the next one peeks in`, s.widths.map(w => w.toFixed(2)).join(", "));
    ok(s.before.fits && s.before.x === 0 && s.scrolled > 0 && s.after.fits && s.after.x === 0, `${tag}: scrolling the swipe row to its end scrolls only the row, never the page`, JSON.stringify({ before: s.before, after: s.after, scrolled: s.scrolled }));
  };

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

    // The footer: the site version (dev until the deploy stamps v<PR number>), and what the site says about itself
    {
      const p = await open("home");
      const { ver, foot } = await p.evaluate(() => ({
        ver: document.getElementById("sfVer")?.textContent ?? "",
        foot: (document.querySelector(".site-foot")?.textContent ?? "").replace(/\s+/g, " "),
      }));
      ok(/^(dev|v\d+)$/.test(ver), `${label}: the footer shows a site version, dev or v<PR number>`, ver);
      ok(ver === "dev", `${label}: an unstamped local site shows dev`, ver);
      ok(!foot.includes("TalkHalifax is a prototype"), `${label}: the footer no longer calls the site a prototype`);
      ok(foot.includes("Stories are written by AI from official releases and may contain mistakes; each one links to its original."), `${label}: the footer says stories are written by AI and link to their originals`);
      ok(foot.includes("Outage figures from Nova Scotia Power."), `${label}: the footer credits Nova Scotia Power for outage figures`);
      await p.close();
    }

    // Only a boil-water advisory pins to Home; one street's emergency shut-off stays on Notices
    {
      const p = await open("home");
      // The seeded wind warning comes first and folds the rest behind "+1 more"
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

    // #62 T1, T2 and T3: one read-only Home page for its regions, its section heads and its one heading
    {
      const p = await open("home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});

      // #62 T1: Home has its grid, its Developing and Latest sections, a labelled "Right now" side column, and their heads
      {
        ok(await view(p) === "home", `${label}: Home shows the home view`);
        const has = await p.evaluate(w => ({
          grid: !!document.querySelector("#home .home-grid"),
          pins: !!document.querySelector("#home #pinsSec #pins"),
          feed: !!document.querySelector("#home #feedSec #feed"),
          rail: w < 1024 ? !!document.querySelector('aside#homeRail[role="tabpanel"][aria-labelledby="homeTab-notices"]') && !!document.querySelector('#homeTabs > [role="tab"][data-tab="notices"]#homeTab-notices') : !!document.querySelector('aside#homeRail[aria-labelledby="railH"]'),
          heads: ["railH", "pinsH", "feedH"].map(id => document.getElementById(id)?.textContent.trim() ?? ""),
        }), width);
        ok(has.grid, `${label}: Home has its grid`);
        ok(has.pins, `${label}: Home has a Developing section with a place for its cards`);
        ok(has.feed, `${label}: Home has a Latest section with a place for its feed`);
        ok(has.rail, `${label}: Home has a side column labelled by ${width < 1024 ? "its Notices tab" : "its head"}`);
        ok(has.heads[0] === "Right now", `${label}: the side column's head reads Right now`, has.heads[0]);
        ok(has.heads[1] === "Developing", `${label}: the Developing section's head reads Developing`, has.heads[1]);
        ok(has.heads[2] === "Latest", `${label}: the Latest section's head reads Latest`, has.heads[2]);
      }

      // #62 T3: Home has exactly one h1, there for screen readers and kept off-screen
      {
        const h1 = await p.evaluate(() => {
          const all = document.querySelectorAll("#home h1");
          const r = all[0]?.getBoundingClientRect();
          return { count: all.length, off: !!r && (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.width * r.height <= 1) };
        });
        ok(h1.count === 1, `${label}: Home has exactly one h1`, `found ${h1.count}`);
        ok(h1.off, `${label}: Home's h1 is kept off-screen, for screen readers`);
      }

      // #62 T2, filled by build 3: Home fills and shows its Developing pins, its Latest feed and its "Right now" rail
      await p.waitForSelector('#pins [data-article="e2e-developing"]', { timeout: 5000 }).catch(() => {});
      await p.waitForFunction(() => document.querySelectorAll("#railBody h3").length === 3, { timeout: 10000 }).catch(() => {});
      const home = await p.evaluate(() => {
        const shown = id => { const el = document.getElementById(id); return !!el && el.hidden === false && el.getBoundingClientRect().height > 0; };
        const stamped = el => { const t = el.querySelector("time.stamp[datetime]"); return !!t && Number.isFinite(Date.parse(t.getAttribute("datetime"))); };
        const pins = document.getElementById("pins"), leads = [...document.querySelectorAll("#pins .card.lead")];
        const cards = [...document.querySelectorAll("#pins .card[data-article]")];
        const feed = [...document.getElementById("feed").children];
        const rows = [...document.querySelectorAll("#feed .feed-row")];
        const rail = document.getElementById("railBody");
        const wx = rail.querySelector('a.feed-row[href="https://weather.gc.ca/"][target="_blank"][rel="noopener"]');
        const notices = [...rail.querySelectorAll("a.feed-row[data-article]")];
        const more = rail.querySelector('a.more[href="#notices"][data-go="notices"]');
        return {
          pins: shown("pinsSec"), feed: shown("feedSec"), rail: shown("homeRail"),
          devGone: document.getElementById("devCards") === null,
          pinIds: cards.map(c => c.dataset.article).sort(),
          leads: leads.length, leadFirst: leads.length === 1 && leads[0] === pins.firstElementChild,
          count: document.getElementById("pinsCount").textContent,
          live: getComputedStyle(document.getElementById("pinsH"), "::after").content,
          pinCards: cards.length,
          pinFt: cards.every(c => { const s = c.querySelector(".ft > .ft-start"); return !!s && stamped(s) && !!s.querySelector(".pill"); }),
          pinViewers: cards.every(c => !!c.querySelector(".ft-start + .viewers")),
          feedKids: feed.length, feedRowsOnly: feed.every(el => el.matches("button.feed-row")), feedCards: document.querySelectorAll("#feed .card").length,
          rowIds: rows.map(r => r.dataset.article),
          rowPills: rows.map(r => r.querySelector(".pill")?.textContent.trim() ?? ""),
          rowStamps: rows.length > 0 && rows.every(stamped),
          firstTitle: document.querySelector("#feed .tt")?.textContent.trim() ?? "",
          railHeads: JSON.stringify([...rail.querySelectorAll("h3")].map(h => h.textContent.trim())),
          wx: !!wx, wxText: wx?.textContent ?? "", wxAbout: wx?.getAttribute("aria-label") ?? "",
          railText: rail.textContent,
          bars: document.getElementById("abars").innerText,
          noticeIds: notices.map(a => a.dataset.article), noticeHref: notices[0]?.getAttribute("href") ?? "",
          more: !!more, moreText: more?.textContent.trim() ?? "",
        };
      });
      ok(home.pins, `${label}: the Developing section shows once Home fills it`);
      ok(home.feed, `${label}: the Latest section shows once Home fills it`);
      ok(home.devGone, `${label}: #devCards is gone from Home`);
      ok(JSON.stringify(home.pinIds) === JSON.stringify(["e2e-developing", "e2e-new", "e2e-old"]), `${label}: Developing pins the three developing stories`, home.pinIds.join(", "));
      ok(home.leads === 1 && home.leadFirst, `${label}: exactly one pin is the lead, and it comes first`, `${home.leads} lead`);
      ok(home.count === "3", `${label}: the Developing head counts 3`, home.count);
      ok(home.live === '"LIVE"', `${label}: the Developing head says LIVE`, home.live);
      ok(home.pinCards >= 1 && home.pinFt, `${label}: every pin has a timestamp and a message count`, `${home.pinCards} pins`);
      ok(home.pinCards >= 1 && home.pinViewers, `${label}: every pin has a viewer count`, `${home.pinCards} pins`);
      ok(home.feedKids >= 1 && home.feedRowsOnly && home.feedCards === 0, `${label}: Latest is feed rows only, no cards`, `${home.feedKids} children, ${home.feedCards} cards`);
      ok(JSON.stringify(home.rowIds) === JSON.stringify(["e2e-article", "e2e-api-archived"]), `${label}: Latest lists the settled stories newest first`, home.rowIds.join(", "));
      ok(home.rowPills.length > 0 && home.rowPills.every(t => t === "Story") && home.rowStamps, `${label}: each Latest row reads Story, with a timestamp`, home.rowPills.join(" | "));
      ok(home.firstTitle === "A story that has settled", `${label}: the first Latest row is the settled story`, home.firstTitle);
      ok(home.railHeads === JSON.stringify(["Weather", "Weather watches and statements", "Notices"]), `${label}: the Right now heads are Weather, watches and statements, then Notices`, home.railHeads);
      ok(home.wx && home.wxText.includes("15°C") && home.wxText.includes("Sunny") && home.wxAbout.includes("feels like 15°C"), `${label}: the rail's weather row links to Environment Canada`, `${home.wxText.trim()} | ${home.wxAbout}`);
      ok(home.railText.includes("Rainfall watch in effect") && !home.railText.includes("Wind warning in effect"), `${label}: the rail lists the weather watch, not the warning`);
      ok(home.bars.includes("Wind warning in effect"), `${label}: the weather warning is in the alert bar`, home.bars);
      ok(home.more && home.moreText === "All notices", `${label}: the rail links to All notices`, home.moreText);

      // #62 T3: no heading shows above Home's Developing section
      {
        const above = await p.evaluate(() => {
          const top = document.getElementById("pinsSec").getBoundingClientRect().top;
          return [...document.querySelectorAll("#home :is(h1,h2,h3,h4,h5,h6)")].filter(h => {
            const r = h.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.bottom <= top;
          }).map(h => h.textContent.trim());
        });
        ok(!above.length, `${label}: no heading shows above Home's Developing section`, above.join(" | "));
      }

      // #64: below 1024px "Right now" is the Notices tab's panel, so the rail's own checks choose Notices first
      const railTab = width < 1024 ? await chooseTab(p, "notices") : "";
      const railBox = await p.evaluate(() => {
        const el = document.getElementById("homeRail");
        return { shown: !!el && el.hidden === false && el.getBoundingClientRect().height > 0,
          moreH: Math.round(document.querySelector("#railBody a.more")?.getBoundingClientRect().height ?? 0) };
      });
      ok(!railTab && railBox.shown, `${label}: the Right now column shows once Home fills it`, railTab);
      // All notices is a finger-sized target: 44px tall at least
      ok(!railTab && railBox.moreH >= 44, `${label}: All notices is a 44px tap target`, railTab || `${railBox.moreH}px`);

      // The alert bar folds the boil-water advisory behind the wind warning; opening it shows the advisory
      await p.evaluate(() => document.getElementById("abarMore")?.click());
      ok((await p.evaluate(() => document.getElementById("abars").innerText)).includes("Boil Water Advisory"), `${label}: the alert bar still shows the boil-water advisory`);
      // #64: the rail never repeats the alert bar. With the bar opened every notice it holds is in #abars; the rail shows the
      // seeded notices the bar doesn't hold (their order isn't fixed: the seed gives them one time), each linking to its story
      await p.waitForFunction(() => !!document.querySelector('#abars [data-article="hw-e2e-boil"]'), { timeout: 5000 }).catch(() => {});
      const noRepeat = await p.evaluate(() => {
        const rows = [...document.querySelectorAll("#railBody a.feed-row[data-article]")];
        return { ids: rows.map(a => a.dataset.article), hrefs: rows.every(a => a.getAttribute("href") === `#article-${a.dataset.article}`),
          bar: [...document.querySelectorAll("#abars [data-article]")].map(a => a.dataset.article) };
      });
      ok(JSON.stringify([...noRepeat.ids].sort()) === JSON.stringify(["e2e-notice", "hw-e2e-changed", "hw-e2e-shutoff"]) && noRepeat.hrefs, `${label}: the rail shows the notices the alert bar doesn't hold`, noRepeat.ids.join(", "));
      ok(noRepeat.bar.includes("hw-e2e-boil") && noRepeat.ids.length > 0 && noRepeat.ids.every(id => !noRepeat.bar.includes(id)), `${label}: no notice in the rail is also in the alert bar`, `rail ${noRepeat.ids.join(", ")}; bar ${noRepeat.bar.join(", ")}`);

      // A Latest row opens its story, the way readers get there
      {
        const f = await open("home");
        await f.waitForSelector('#feed [data-article="e2e-article"]', { timeout: 5000 }).catch(() => {});
        const row = await f.$('#feed [data-article="e2e-article"]');
        if (row) {
          await row.evaluate(r => r.scrollIntoView({ block: "center" }));
          await row.click();
          await wait(600);
        }
        const hash = await f.evaluate(() => location.hash);
        ok(hash === "#article-e2e-article" && await heading(f, "A story that has settled") === "A story that has settled" && await view(f) === "article", `${label}: clicking a Latest row opens its story`, `${hash} ${await view(f)}`);
        await f.close();
      }

      // All notices, at the foot of the rail, opens Notices. Below 1024px the rail is the Notices tab's panel, so choose it
      // first; a click that can't happen is this check's FAIL, never an error that stops the run
      {
        const n = await open("home");
        await n.waitForSelector("#railBody a.more", { timeout: 5000 }).catch(() => {});
        const why = (width < 1024 ? await chooseTab(n, "notices") : "") || await tryClick(n, "#railBody a.more");
        if (!why) await n.waitForFunction(() => [...document.querySelectorAll("main > section.view")].filter(s => !s.hidden).map(s => s.id).join(",") === "notices", { timeout: 5000 }).catch(() => {});
        const got = await view(n);
        ok(!why && got === "notices", `${label}: All notices opens Notices`, why || got);
        await n.close();
      }

      await p.close();
    }

    // #64: Home's tabs. Below 1024px: All, News and Notices, chosen by click or arrow keys, each showing its own panel, with no
    // change to the address. From 1024px up: hidden, and both columns show whatever data-tab says. Each read after a click or
    // key waits for the state it expects first.
    {
      const p = await open("home");
      await p.waitForFunction(() => document.getElementById("homeTabs")?.hidden === false && !!document.querySelector("#home .card[data-article]"), { timeout: 10000 }).catch(() => {});
      const state = force => p.evaluate(f => {
        const home = document.getElementById("home"), box = document.getElementById("homeTabs");
        if (f) home.dataset.tab = f;
        const tall = el => !!el && el.getBoundingClientRect().height > 0;
        const tabs = [...box.querySelectorAll('[role="tab"]')];
        const main = document.getElementById("homeMain"), rail = document.getElementById("homeRail");
        return {
          tab: home.dataset.tab ?? "",
          selected: tabs.filter(b => b.getAttribute("aria-selected") === "true").map(b => b.dataset.tab).join(","),
          zero: tabs.filter(b => b.tabIndex === 0).map(b => b.dataset.tab).join(","),
          focus: document.activeElement?.closest?.('#homeTabs [role="tab"]')?.dataset.tab ?? "",
          unhidden: box.hidden === false, shown: tall(box),
          sizes: tabs.map(b => { const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }),
          main: tall(main), rail: tall(rail),
          mainPanel: `${main.getAttribute("role")} ${main.getAttribute("aria-labelledby")}`,
          railPanel: `${rail.getAttribute("role")} ${rail.getAttribute("aria-labelledby")}`,
          hash: location.hash,
        };
      }, force);
      const press = async (key, want) => (await tryPress(p, key)) || p.waitForFunction(t => document.getElementById("home").dataset.tab === t && document.activeElement?.dataset?.tab === t, { timeout: 5000 }, want).then(() => "", () => `${key} didn't move to ${want}`);
      if (width < 1024) {
        let s = await state();
        ok(s.unhidden && s.shown && s.sizes.length === 3 && s.sizes.every(n => n >= 44), `${label}: Home's three tabs show once the stories load, each a 44px tap target`, `${s.sizes.join(", ")}px`);
        ok(s.tab === "all" && s.selected === "all" && s.zero === "all", `${label}: Home opens on All, the one selected tab`, `${s.tab} | ${s.selected} | ${s.zero}`);
        const newsWhy = await chooseTab(p, "news"); s = await state();
        const newsPanel = s.mainPanel;
        ok(!newsWhy && s.tab === "news" && s.selected === "news" && s.zero === "news" && s.main && !s.rail && s.hash === "#home", `${label}: News is selected on click and shows the main column, not the rail`, newsWhy || JSON.stringify(s));
        let why = await chooseTab(p, "notices"); s = await state();
        ok(!why && s.tab === "notices" && s.selected === "notices" && s.zero === "notices" && !s.main && s.rail && s.hash === "#home", `${label}: Notices is selected on click and shows only the rail`, why || JSON.stringify(s));
        why = await chooseTab(p, "all"); s = await state();
        ok(!why && s.tab === "all" && s.selected === "all" && s.zero === "all" && s.main && !s.rail && s.hash === "#home", `${label}: All is selected on click and brings the main column back`, why || JSON.stringify(s));
        await p.evaluate(() => document.querySelector('#homeTabs [data-tab="all"]')?.focus());
        why = await press("ArrowRight", "news"); s = await state();
        ok(!why && s.selected === "news" && s.zero === "news" && s.focus === "news", `${label}: ArrowRight moves to the next tab, focused and selected`, why || JSON.stringify(s));
        why = (await press("ArrowRight", "notices")) || (await press("ArrowRight", "all")) || (await press("ArrowLeft", "notices")); s = await state();
        ok(!why && s.tab === "notices" && s.selected === "notices" && s.zero === "notices" && s.focus === "notices", `${label}: the arrow keys wrap around the tabs, both ways`, why || JSON.stringify(s));
        ok(!newsWhy && !why && s.tab === "notices" && newsPanel === "tabpanel homeTab-news" && s.mainPanel === "tabpanel homeTab-all", `${label}: the main column is a tab panel labelled by the selected All or News tab`, newsWhy || why || `${newsPanel} | ${s.mainPanel}`);
      } else {
        const s = await state("notices");
        ok(s.unhidden && !s.shown, `${label}: Home's tabs are hidden at 1024px and up`, s.sizes.join(", "));
        ok(s.tab === "notices" && s.main && s.rail && s.mainPanel === "null null" && s.railPanel === "null railH", `${label}: both columns show whatever the tab, and neither is a tab panel`, `${s.mainPanel} | ${s.railPanel}`);
      }
      await p.close();
    }

    // Home rule 2: offline, the viewer counts read "last seen" and Home keeps its rail and its feed; back online they're live again
    {
      const p = await open("home");
      await p.waitForSelector('#pins [data-article="e2e-developing"]', { timeout: 5000 }).catch(() => {});
      await p.setOfflineMode(true);
      await p.evaluate(() => window.dispatchEvent(new Event("offline")));
      await p.waitForFunction(() => { const v = [...document.querySelectorAll("#pins .viewers")]; return v.length > 0 && v.every(e => e.textContent.includes("last seen")); }, { timeout: 5000 }).catch(() => {});
      const off = await p.evaluate(() => ({
        viewers: [...document.querySelectorAll("#pins .viewers")].map(v => v.textContent.trim()),
        rail: document.getElementById("homeRail").hidden === false,
        rows: document.querySelectorAll("#feed .feed-row").length,
      }));
      ok(off.viewers.length >= 1 && off.viewers.every(t => t.includes("last seen")), `${label}: offline, every viewer count reads last seen`, off.viewers.join(" | "));
      ok(off.rail && off.rows === 2, `${label}: offline, Home keeps its rail and its feed`, `rail ${off.rail ? "shown" : "hidden"}, ${off.rows} rows`);
      await p.setOfflineMode(false);
      await p.evaluate(() => window.dispatchEvent(new Event("online")));
      await p.waitForFunction(() => ![...document.querySelectorAll("#pins .viewers")].some(e => e.textContent.includes("last seen")), { timeout: 5000 }).catch(() => {});
      const on = await p.evaluate(() => [...document.querySelectorAll("#pins .viewers")].map(v => v.textContent.trim()));
      ok(on.length >= 1 && !on.some(t => t.includes("last seen")), `${label}: back online, the viewer counts are live again`, on.join(" | "));
      await p.close();
    }

    // Home's rail when the weather comes last: watches and notices show first, and the weather joins them when it lands,
    // without waiting for the next stories or alerts refresh. The weather request is held back until the rest is in.
    // Interception has to be on before the page loads, so this page is set up by hand rather than with open().
    {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(`${label} #home (held weather): ${e.message}`));
      await p.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
      await p.setBypassServiceWorker(true); // sw.js caches /api/weather, which would answer without a request
      await p.setRequestInterception(true);
      let held = null, stories = 0, alerts = 0;
      p.on("request", r => {
        let path = "";
        try { path = new URL(r.url()).pathname; } catch { /* not a URL: let it through */ }
        if (path === "/api/weather" && !held) { held = r; return; }
        if (path === "/api/stories") stories++;
        if (path === "/api/alerts") alerts++;
        r.continue().catch(() => {});
      });
      await p.goto(`${B}/#home`, { waitUntil: "load" });
      await p.waitForFunction(() => JSON.stringify([...document.querySelectorAll("#railBody h3")].map(h => h.textContent.trim())) === JSON.stringify(["Weather watches and statements", "Notices"])
        && !!document.querySelector('#pins [data-article="e2e-developing"]'), { timeout: 10000 }).catch(() => {});
      const before = await p.evaluate(() => JSON.stringify([...document.querySelectorAll("#railBody h3")].map(h => h.textContent.trim())));
      ok(!!held && before === JSON.stringify(["Weather watches and statements", "Notices"]), `${label}: with the weather held back, the rail shows watches and notices first`, `${held ? "held" : "not held"}; ${before}`);
      const counts = { stories, alerts };
      await held?.continue().catch(() => {});
      await p.waitForFunction(() => document.querySelector("#railBody h3")?.textContent.trim() === "Weather" && [...document.querySelectorAll("#railBody .feed-row")].some(r => r.textContent.includes("15°C")), { timeout: 5000 }).catch(() => {});
      const after = await p.evaluate(() => ({
        first: document.querySelector("#railBody h3")?.textContent.trim() ?? "",
        wx: [...document.querySelectorAll("#railBody .feed-row")].some(r => r.textContent.includes("15°C")),
      }));
      ok(after.first === "Weather" && after.wx && stories === counts.stories && alerts === counts.alerts, `${label}: when the weather arrives last, the rail adds it without waiting for a refresh`,
        `first head ${after.first}; ${after.wx ? "" : "no "}15°C row; stories ${counts.stories}->${stories}, alerts ${counts.alerts}->${alerts}`);
      await p.close();
    }

    // #64: with no weather, watches or notices, the rail says so and still links to All notices (below 1024px, under Notices).
    // Interception has to be on before the page loads, as above.
    {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(`${label} #home (empty rail): ${e.message}`));
      await p.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
      await p.setBypassServiceWorker(true);
      await p.setRequestInterception(true);
      const json = body => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      p.on("request", r => {
        let path = "";
        try { path = new URL(r.url()).pathname; } catch { /* not a URL: let it through */ }
        if (path === "/api/stories") return r.respond(json({ stories: [] })).catch(() => {});
        if (path === "/api/alerts") return r.respond(json({ alerts: { updatedAt: now, items: [] } })).catch(() => {});
        if (path === "/api/weather") return r.respond(json({ weather: null })).catch(() => {});
        r.continue().catch(() => {});
      });
      await p.goto(`${B}/#home`, { waitUntil: "load" });
      await p.waitForFunction(() => document.querySelector("#railBody .msg")?.textContent.trim() === "Nothing right now.", { timeout: 10000 }).catch(() => {});
      const why = width < 1024 ? await chooseTab(p, "notices") : "";
      const empty = await p.evaluate(() => {
        const rail = document.getElementById("homeRail"), body = document.getElementById("railBody");
        const more = body.querySelector('a.more[href="#notices"][data-go="notices"]');
        return { shown: rail.hidden === false && rail.getBoundingClientRect().height > 0, msg: body.querySelector(".msg")?.textContent.trim() ?? "",
          more: more?.textContent.trim() ?? "", heads: body.querySelectorAll("h3").length, rows: body.querySelectorAll(".feed-row").length };
      });
      ok(!why && empty.shown && empty.msg === "Nothing right now." && empty.more === "All notices" && empty.heads === 0 && empty.rows === 0, `${label}: with nothing to show, the rail says Nothing right now. and links to All notices`, why || JSON.stringify(empty));
      await p.close();
    }

    // #62 T4: LIVE follows content: the Developing head says LIVE only once a story still developing is in its section
    {
      const p = await open("home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const live = await p.evaluate(() => {
        const pins = document.getElementById("pins");
        const after = () => getComputedStyle(document.getElementById("pinsH"), "::after").content;
        pins.replaceChildren();
        const empty = after();
        document.getElementById("pinsSec").hidden = false;
        const shown = after();
        pins.insertAdjacentHTML("beforeend", '<button type="button" class="card glass archived" data-article="e2e-probe-settled"><span class="tt">x</span></button>');
        const settled = after();
        pins.insertAdjacentHTML("beforeend", '<button type="button" class="card glass" data-article="e2e-probe-live"><span class="tt">x</span></button>');
        const developing = after();
        return { empty, shown, settled, developing };
      });
      const quiet = v => v === "none" || v === "normal";
      ok(quiet(live.empty), `${label}: the Developing head doesn't say LIVE while its section is empty`, live.empty);
      ok(quiet(live.shown), `${label}: nor once the section shows with no stories in it`, live.shown);
      ok(quiet(live.settled), `${label}: nor with only a settled story in it`, live.settled);
      ok(live.developing === '"LIVE"', `${label}: it says LIVE once a developing story is in it`, live.developing);
      await p.close();
    }

    // Home's spacing: with no Developing section Latest starts at the top of the main column; below Developing it keeps its gap.
    // One evaluate hides Developing, reads, and shows it again.
    {
      const p = await open("home");
      await p.waitForSelector('#feed [data-article="e2e-article"]', { timeout: 5000 }).catch(() => {});
      const gap = await p.evaluate(() => {
        const feedSec = document.getElementById("feedSec"), pinsSec = document.getElementById("pinsSec");
        const both = parseFloat(getComputedStyle(feedSec).marginTop);
        pinsSec.hidden = true;
        const margin = getComputedStyle(feedSec).marginTop;
        const top = feedSec.getBoundingClientRect().top;
        const mainTop = document.querySelector(".home-main").getBoundingClientRect().top;
        pinsSec.hidden = false;
        return { both, margin, top, mainTop };
      });
      ok(gap.margin === "0px" && Math.abs(gap.top - gap.mainTop) <= 1, `${label}: with no Developing section, Latest starts at the top of the column`, `margin ${gap.margin}, top ${gap.top} vs ${gap.mainTop}`);
      ok(gap.both > 0, `${label}: below Developing, Latest keeps its gap`, `${gap.both}px`);
      await p.close();
    }

    // #62 T5, #64: on a phone, under Notices, the "Right now" rail takes the main column's place; on desktop with no rail the main column takes the whole grid, 1200px at most
    {
      const p = await open("home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      if (width === 375) {
        const why = await chooseTab(p, "notices");
        const { grid, main, rail } = await homeColumns(p, true);
        ok(!why && main.width === 0 && rail.width > 0 && Math.abs(rail.top - grid.top) <= 1 && Math.abs(rail.left - grid.left) <= 1 && Math.abs(rail.width - grid.width) <= 1, `${label}: under Notices the Right now rail takes the main column's place`, why || JSON.stringify({ grid, main, rail }));
      }
      if (width === 1280) {
        const { grid, main, rail } = await homeColumns(p, false);
        ok(rail.width === 0, `${label}: a hidden Right now rail takes no width`, `${rail.width}px`);
        ok(Math.abs(main.width - grid.width) <= 1, `${label}: with no rail the main column takes the whole grid`, `${main.width}px of ${grid.width}px`);
        ok(grid.width <= 1200, `${label}: the Home grid is 1200px wide at most`, `${grid.width}px`);
      }
      await p.close();
    }

    // #62 T6: on a phone Home never scrolls sideways
    if (width === 375) {
      const p = await open("home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const fits = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth }));
      ok(fits.scroll <= fits.inner, `${label}: Home fits the phone's width, with no sideways scroll`, `${fits.scroll}px in ${fits.inner}px`);
      await p.close();
    }

    // #64: below 760px Developing is a sideways swipe row that snaps, and only the row scrolls sideways; under reduced motion it doesn't snap
    if (width === 375) {
      const p = await open("home");
      await p.waitForFunction(() => document.querySelectorAll("#pins > .card[data-article]").length === 3, { timeout: 10000 }).catch(() => {});
      await checkSwipe(p, label);
      await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]).catch(() => {});
      await p.waitForFunction(() => getComputedStyle(document.getElementById("pins")).scrollSnapType === "none", { timeout: 5000 }).catch(() => {});
      const calm = await p.evaluate(() => { const s = getComputedStyle(document.getElementById("pins")); return { snap: s.scrollSnapType, behavior: s.scrollBehavior }; });
      ok(calm.snap === "none" && calm.behavior === "auto", `${label}: under reduced motion the swipe row doesn't snap`, `${calm.snap}, ${calm.behavior}`);
      await p.close();
    }

    // Home with its "Right now" rail really filled (nothing forced): no sideways scroll, and every rail row on two lines,
    // its label and time first and its headline below. Read-only.
    if (width === 1280) {
      const p = await open("home");
      await p.waitForFunction(() => document.querySelectorAll("#railBody h3").length === 3, { timeout: 10000 }).catch(() => {});
      const filled = await p.evaluate(() => ({
        heads: document.querySelectorAll("#railBody h3").length,
        scroll: document.documentElement.scrollWidth, inner: innerWidth,
        rows: [...document.querySelectorAll("#railBody .feed-row")].map(row => {
          const tt = row.querySelector(".tt"), pill = row.querySelector(".pill");
          return !!tt && !!pill && tt.getBoundingClientRect().top >= pill.getBoundingClientRect().bottom - 1;
        }),
      }));
      ok(filled.heads === 3 && filled.scroll <= filled.inner, `${label}: Home with its rail filled doesn't scroll sideways`, `${filled.heads} heads, ${filled.scroll}px in ${filled.inner}px`);
      ok(filled.rows.length >= 3 && filled.rows.every(Boolean), `${label}: each rail row puts its headline below its label`, `${filled.rows.filter(Boolean).length} of ${filled.rows.length} rows`);
      await p.close();
    }

    // #62 T7: Home card headlines are in Inter Tight and balanced, the updated mark is in ink, and on desktop the lead card spans its grid
    {
      const p = await open("home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const look = await p.evaluate(() => {
        const cards = [...document.querySelectorAll("#home .card[data-article]")].filter(el => el.getBoundingClientRect().height > 0);
        const tts = cards.flatMap(el => [...el.querySelectorAll(".tt")]).map(el => { const s = getComputedStyle(el); return { font: s.fontFamily, style: s.textWrapStyle, wrap: s.textWrap }; });
        const out = {
          checked: tts.length,
          fonts: [...new Set(tts.map(t => t.font))],
          wraps: [...new Set(tts.map(t => `${t.style}/${t.wrap}`))],
          face: tts.every(t => /^"?Inter Tight"?(,|$)/.test(t.font)),
          balanced: tts.every(t => t.style === "balance" || /\bbalance\b/.test(t.wrap)),
          upd: "", ink: "", warn: "",
        };
        const first = cards[0];
        if (first) {
          first.insertAdjacentHTML("beforeend", '<span class="upd"></span><span style="color: var(--ink)"></span><span style="color: var(--signal-warn)"></span>');
          const spans = [...first.children].slice(-3);
          [out.upd, out.ink, out.warn] = spans.map(el => getComputedStyle(el).color);
          spans.forEach(el => el.remove());
        }
        const lead = document.querySelector("#home .card.lead");
        out.lead = !!lead;
        if (lead) {
          const grid = lead.parentElement, r = lead.getBoundingClientRect(), g = grid.getBoundingClientRect();
          out.tracks = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
          out.edges = Math.abs(r.left - g.left) <= 1 && Math.abs(r.right - g.right) <= 1;
          out.box = { left: r.left, right: r.right, gridLeft: g.left, gridRight: g.right };
        }
        return out;
      });
      ok(look.checked > 0, `${label}: Home has card headlines to check`, `${look.checked} checked; ${look.fonts.join(" | ")}`);
      ok(look.face, `${label}: every Home card headline is in Inter Tight`, look.fonts.join(" | "));
      ok(look.balanced, `${label}: every Home card headline is balanced`, look.wraps.join(" | "));
      ok(!!look.upd && look.upd === look.ink, `${label}: the updated mark on a card is in ink`, `${look.upd} vs ${look.ink}`);
      ok(look.upd !== look.warn, `${label}: and not in the warning red`, `${look.upd} vs ${look.warn}`);
      if (width === 1280) {
        ok(look.lead, `${label}: Home has a lead card`);
        ok(look.tracks >= 2, `${label}: the lead card's grid has two or more columns`, `${look.tracks} columns`);
        ok(look.edges === true, `${label}: the lead card spans its grid from edge to edge`, JSON.stringify(look.box));
      }
      await p.close();
    }
  }

  // #62 T5 and T6 at the 1024px breakpoint, and #64: beside the main column at 1024px; at 1023px the Notices tab's panel, in its place
  {
    const openAt = async (width, hash) => {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(`${width} #${hash}: ${e.message}`));
      await p.setViewport({ width, height: 900 });
      await p.goto(`${B}/#${hash}`, { waitUntil: "load" });
      await wait(500);
      return p;
    };

    // #64 at 1023: one pixel under the breakpoint "Right now" is the Notices tab's panel; chosen, it takes the main column's place
    {
      const p = await openAt(1023, "home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const why = await chooseTab(p, "notices");
      const { grid, main, rail } = await homeColumns(p, true);
      ok(!why && main.width === 0 && rail.width > 0 && Math.abs(rail.top - grid.top) <= 1 && Math.abs(rail.left - grid.left) <= 1 && Math.abs(rail.width - grid.width) <= 1, "1023: under Notices the Right now rail takes the main column's place", why || JSON.stringify({ grid, main, rail }));
      const panel = await p.evaluate(() => { const r = document.getElementById("homeRail"); return `${r.getAttribute("role")} ${r.getAttribute("aria-labelledby")}`; });
      ok(panel === "tabpanel homeTab-notices", "1023: the rail is a tab panel labelled by its Notices tab", panel);
      await p.close();
    }

    // #62 T5 and T6 at 1024: the rail sits beside the main column, 320px wide, and the page doesn't scroll sideways
    {
      const p = await openAt(1024, "home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const { main, rail, wide } = await homeColumns(p, true);
      ok(Math.abs(rail.top - main.top) <= 1, "1024: the Right now rail's top lines up with the main column's", `${rail.top} vs ${main.top}`);
      ok(rail.left >= main.right - 1, "1024: the rail sits to the right of the main column", `${rail.left} vs ${main.right}`);
      ok(Math.abs(rail.width - 320) <= 0.5, "1024: the rail is 320px wide", `${rail.width}px`);
      ok(!wide, "1024: Home with the rail doesn't scroll sideways");
      await p.close();
    }

    // #64 at 1024: the tabs are gone, so whatever #home's data-tab says both columns show, and neither is a tab panel
    {
      const p = await openAt(1024, "home");
      await p.waitForSelector("#home .card[data-article]", { timeout: 5000 }).catch(() => {});
      const at = await p.evaluate(() => {
        const home = document.getElementById("home"), m = document.getElementById("homeMain"), r = document.getElementById("homeRail");
        home.dataset.tab = "notices"; r.hidden = false;
        const box = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
        return { tab: home.dataset.tab, main: box(m), rail: box(r), mainRole: m.getAttribute("role"), railRole: r.getAttribute("role"), railBy: r.getAttribute("aria-labelledby") };
      });
      ok(at.tab === "notices" && at.main.width > 0 && at.rail.width > 0 && at.rail.left >= at.main.right - 1, "1024: with Notices in data-tab, both columns still show side by side", JSON.stringify(at));
      ok(at.mainRole === null && at.railRole === null && at.railBy === "railH", "1024: neither column is a tab panel, and the rail is labelled by its head", `${at.mainRole} ${at.railRole} ${at.railBy}`);
      await p.close();
    }

    // At 1024 with the rail really filled (nothing forced), the page doesn't scroll sideways. Read-only.
    {
      const p = await openAt(1024, "home");
      await p.waitForFunction(() => document.querySelectorAll("#railBody h3").length === 3, { timeout: 10000 }).catch(() => {});
      const filled = await p.evaluate(() => ({
        heads: document.querySelectorAll("#railBody h3").length,
        scroll: document.documentElement.scrollWidth, inner: innerWidth,
      }));
      ok(filled.heads === 3 && filled.scroll <= filled.inner, "1024: Home with its rail filled doesn't scroll sideways", `${filled.heads} heads, ${filled.scroll}px in ${filled.inner}px`);
      await p.close();
    }

    // #64: Home's tabs show below 1024px and not from 1024px up; Developing is a swipe row below 760px and a grid from 760px
    // (tested at 759 and 761, never at exactly 760)
    for (const w of [759, 761, 1023, 1024]) {
      const p = await openAt(w, "home");
      await p.waitForFunction(() => document.getElementById("homeTabs")?.hidden === false && document.querySelectorAll("#pins > .card[data-article]").length === 3, { timeout: 10000 }).catch(() => {});
      const t = await p.evaluate(() => { const el = document.getElementById("homeTabs"); return { unhidden: el.hidden === false, height: el.getBoundingClientRect().height, display: getComputedStyle(el).display, pins: getComputedStyle(document.getElementById("pins")).display }; });
      ok(t.unhidden && (w < 1024 ? t.height > 0 : t.height === 0 && t.display === "none"), `${w}: Home's tabs ${w < 1024 ? "show" : "are hidden"}`, `display ${t.display}, ${t.height}px`);
      if (w === 761) ok(t.pins === "grid", "761: Developing is a grid, not a swipe row", t.pins);
      if (w === 759) await checkSwipe(p, "759");
      await p.close();
    }
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
    // AdminApi has no public address: every guess at one is 404 on the main Worker, read or write
    for (const path of ["/internal/x", "/internal/summary", "/admin-api", "/admin-api/summary", "/api/admin", "/api/admin/summary", "/api/adminx", "/api/admin-api/jobs"]) for (const method of ["GET", "POST"]) {
      r = await api(method, path, method === "POST" ? { json: {} } : {});
      ok(r.status === 404, `api: ${method} ${path} is 404 (no public path reaches AdminApi)`, http(r));
    }

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
    r = await api("GET", "/api/push");
    ok(r.status === 200 && r.body?.enabled === false, "api: the e2e Worker runs with alerts switched off (no VAPID keys)", http(r));
    r = await api("POST", "/api/push/unsubscribe", { json: { endpoint: "https://fcm.googleapis.com/fcm/send/e2e-not-subscribed" } });
    ok(r.status === 200 && JSON.stringify(r.body) === '{"ok":true}', "api: /api/push/unsubscribe with alerts switched off answers 200 {ok:true}, for an endpoint that isn't subscribed", http(r));
    r = await api("POST", "/api/push/unsubscribe", { json: null });
    ok(r.status === 200 && JSON.stringify(r.body) === '{"ok":true}', "api: /api/push/unsubscribe treats a JSON null body as {} (200 {ok:true})", http(r));
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
    ok(r.status === 401, "api: DELETE /api/comments/:id without content-type passes the origin check (originMatches)", http(r));
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
    ok(r.status === 401, "api: DELETE /api/me without content-type passes the origin check (originMatches)", http(r));
    r = await api("DELETE", "/api/me", { as: GONE });
    ok(r.status === 200 && r.body?.ok === true && r.cookie.includes("th_session=;") && r.cookie.includes("Max-Age=0") && !r.cookie.includes("Secure"), "api: a member deletes their account, and the session cookie is cleared with Max-Age=0 and no Secure on local http", http(r));
    r = await api("GET", "/api/me", { as: GONE });
    ok(r.status === 200 && r.body?.user === null, "api: the deleted account's session no longer works", http(r));
    r = await api("GET", "/api/users/u_e2e_delete");
    ok(r.status === 200 && r.body?.user?.name === "Deleted account", "api: the profile says Deleted account", http(r));
  }
} catch (e) {
  if (!(e instanceof StartupError)) throw e;
  console.error(e.message); // no Worker of this run's to check: the browser and API checks never ran, so never "All passed"
  startFailed = true;
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  await waitExit();
  removeData();
}
if (startFailed) process.exit(1);
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
