// TalkHalifax client: Home (glass cards), article rooms with a docked live chat, and a profile page.
// Data comes from the Worker's /api, chat from /rooms/<story>/ws (one ArticleRoom Durable Object per story).
import { getJSON } from "./api.js";
import { room, renderComposer, leaveRoom, connectRoom, showChatError } from "./chat.js";
import { renderBanners, renderHome } from "./views/home.js";
import { renderArticles } from "./views/articles.js";
import { allNotices, renderNotices } from "./views/notices.js";
import { articleHTML, fetchStory, renderArticle, wireStageTools, loadComments } from "./views/article.js";
import { renderUser } from "./views/user.js";
import { renderReset } from "./views/reset.js";
import { renderProfile } from "./views/profile.js";

const TZ = "America/Halifax";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const linkify = s => esc(s)
  .replace(/\b((?:engagehalifax|halifax|halifaxwater|novascotia)\.ca\/[A-Za-z0-9/_-]+)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>')
  .replace(/(^|[^\d/-])(\d{3})-(\d{3})-(\d{4})(?![\d-])/g, '$1<a href="tel:+1$2$3$4">$2-$3-$4</a>');

// ---------- Time helpers (always Halifax time) ----------
const fmt = o => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...o });
const hm = t => fmt({ hour: "numeric", minute: "2-digit" }).format(new Date(t)).replace(/\./g, "");
const shortDate = t => fmt({ month: "short", day: "numeric" }).format(new Date(t));
const fullDate = t => fmt({ month: "short", day: "numeric", year: "numeric" }).format(new Date(t));
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  if (m < 1440) return Math.round(m / 60) + " h ago";
  const d = Math.round(m / 1440);
  if (d === 1) return "yesterday";
  if (d < 14) return d + " days ago";
  return Math.round(d / 7) + " weeks ago";
}

// ---------- State ----------
const S = {
  me: null, providers: {}, stories: null, full: {}, weather: null, alerts: null, offline: false,
  sort: "active", current: "home", article: null, user: null, userFrom: null, users: {},
};
const reported = new Set(); // messages and comments this person has reported

// ---------- People ----------
const PERSON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const hue = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
/** A small round avatar: photo when there is one, otherwise an initial on a stable colour. */
function avatar(p, cls = "av") {
  if (p && p.avatar) return `<span class="${cls}"><img alt="" src="${esc(p.avatar)}" referrerpolicy="no-referrer"></span>`;
  const name = (p && p.name) || "?";
  return `<span class="${cls}" style="background:${p ? hue(p.id) : "var(--ink-faint)"}" aria-hidden="true">${esc(name.trim()[0] || "?").toUpperCase()}</span>`;
}

const tms = x => (x ? new Date(x).getTime() : 0);
const loadingMsg = () => `<div class="msg">${S.offline ? "TalkHalifax can't reach its server right now. Check your connection and reload." : "Loading…"}</div>`;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => { S.sort = b.dataset.sort; renderArticles(); }));
$("#nFilters").addEventListener("click", e => { const b = e.target.closest("[data-nf]"); if (b) { S.nFilter = b.dataset.nf; renderNotices(); } });

// ---------- Article room ----------
const narrow = () => window.matchMedia("(max-width: 960px)").matches;
let chatOpen = false;
let chatHidden = false;
try { chatHidden = localStorage.getItem("talkhalifax.chatHidden") === "1"; } catch (e) {}
function setChatHidden(h) {
  chatHidden = h;
  try { localStorage.setItem("talkhalifax.chatHidden", h ? "1" : "0"); } catch (e) {}
  applyChatState();
}
function applyChatState() {
  const chat = $("#chat"), reopen = $("#chatReopen"), toggle = $("#chatToggle");
  const small = narrow();
  document.body.classList.toggle("chat-open", S.current === "article" && !!chat && !small && !chatHidden);
  if (!chat) return;
  chat.classList.toggle("hidden", !small && chatHidden);
  chat.classList.toggle("open", small && chatOpen);
  if (reopen) reopen.hidden = small || !chatHidden;
  if (toggle) {
    toggle.setAttribute("aria-label", small ? (chatOpen ? "Collapse chat" : "Expand chat") : "Hide chat");
    toggle.setAttribute("aria-expanded", String(small ? chatOpen : !chatHidden));
  }
}
window.addEventListener("resize", applyChatState);

/** Back to the list the story lives in: Notices, Articles for settled ones, Developing Stories for the rest. */
const back = a => a && a.kind === "notice" ? `<button type="button" class="back" data-go="notices">← Notices</button>`
  : a && a.kind === "article" && a.stage === "archived"
  ? `<button type="button" class="back" data-go="articles">← Articles</button>`
  : `<button type="button" class="back" data-go="home">← Developing Stories</button>`;

function wireChat(v) {
  const head = $("#chatHead"), toggle = $("#chatToggle"), reopen = $("#chatReopen");
  const setSheet = open => { chatOpen = open; applyChatState(); if (open) { const m = $("#msgs"); m.scrollTop = m.scrollHeight; } };
  toggle.addEventListener("click", e => { e.stopPropagation(); if (narrow()) return setSheet(!chatOpen); setChatHidden(true); reopen.focus(); });
  head.addEventListener("click", () => { if (narrow()) setSheet(!chatOpen); });
  reopen.addEventListener("click", () => { setChatHidden(false); const i = $("#chatInput"); (i || toggle).focus(); });
}

function renderMeButton() {
  const b = $("#meBtn");
  if (S.me) {
    b.innerHTML = S.me.avatarUrl ? `<img alt="" src="${esc(S.me.avatarUrl)}" referrerpolicy="no-referrer">`
      : `<span class="ini" style="background:${hue(S.me.id)}">${esc((S.me.name || "?")[0].toUpperCase())}</span>`;
    b.setAttribute("aria-label", `Your profile (${S.me.name || "signed in"})`);
  } else {
    b.innerHTML = PERSON_SVG; b.setAttribute("aria-label", "Sign in");
  }
}

// ---------- Drawer (phones): the profile button opens the sections ----------
const phone = () => window.matchMedia("(max-width: 760px)").matches;
const drawer = $("#navDrawer");
// ---------- Weather: Environment Canada's current conditions, in the header and the phone menu ----------
const WX_MAX_AGE = 3 * 36e5; // an old reading is worse than none
const svg = (paths, fill) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SUN_RAYS = '<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>';
const CLOUD = '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 11.1 3.5 3.5 0 0 0 7 18z"/>';
const WX_ICONS = {
  clear: svg(`<circle cx="12" cy="12" r="4.2" fill="currentColor"/>${SUN_RAYS}`),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
  partly: svg('<circle cx="8.5" cy="8" r="3" fill="currentColor"/><path d="M8.5 2.5v1.2M3 8h1.2M4.6 4.1l.9.9M12.4 4.1l-.9.9"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.4 13.4 3.3 3.3 0 0 0 9 20z"/>'),
  cloud: svg(CLOUD),
  rain: svg('<path d="M7 14.5h10a3.8 3.8 0 0 0 .6-7.55A5.8 5.8 0 0 0 6.2 8 3.3 3.3 0 0 0 7 14.5z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/>'),
  snow: svg('<path d="M7 14.5h10a3.8 3.8 0 0 0 .6-7.55A5.8 5.8 0 0 0 6.2 8 3.3 3.3 0 0 0 7 14.5z"/><path d="M8 18.5h.01M12 20.5h.01M16 18.5h.01M10 21.5h.01M14 17.5h.01"/>'),
  storm: svg('<path d="M7 14h10a3.8 3.8 0 0 0 .6-7.55A5.8 5.8 0 0 0 6.2 7.5 3.3 3.3 0 0 0 7 14z"/><path d="M12.5 13.5L10 18h3.5L11.5 22"/>'),
  fog: svg('<path d="M4 9h16M6.5 13h13M4 17h13"/>'),
};
/** The weather as link contents, or "" when there's no reading or it's too old to trust. */
function weatherLink() {
  const w = S.weather;
  if (!w || Date.now() - Date.parse(w.observedAt) > WX_MAX_AGE) return "";
  const icon = w.night && w.icon === "clear" ? WX_ICONS.moon : WX_ICONS[w.icon] || WX_ICONS.cloud;
  const about = `${w.condition ? w.condition + ", " : ""}${w.tempC}°C, feels like ${w.feelsLikeC}°C. Environment Canada, ${hm(w.observedAt)}`;
  return `<a class="wx" href="${esc(w.url)}" target="_blank" rel="noopener" title="${esc(about)}" aria-label="${esc(about)}">${icon}<span><span class="wx-lbl">Feels like </span>${w.feelsLikeC}°C</span></a>`;
}
function renderHeaderWeather() {
  const a = $("#hdrWx"), html = weatherLink();
  if (!html) { a.hidden = true; return; }
  const t = document.createElement("template");
  t.innerHTML = html;
  const link = t.content.firstElementChild;
  for (const n of ["href", "title", "aria-label"]) a.setAttribute(n, link.getAttribute(n));
  a.innerHTML = link.innerHTML;
  a.hidden = false;
}
async function loadWeather() {
  try { S.weather = (await getJSON("/api/weather")).weather; } catch (e) {}
  renderHeaderWeather();
}

function renderDrawer() {
  const live = (S.stories || []).filter(x => x.kind === "article" && x.stage === "developing").length;
  const urgent = allNotices().filter(n => !n.old && n.sev === "urgent").length;
  const here = v => S.current === v ? ' aria-current="page"' : "";
  const who = S.me
    ? `${avatar({ id: S.me.id, name: S.me.name, avatar: S.me.avatarUrl })}<span><b>${esc(S.me.name || "You")}</b><small>${S.me.role === "moderator" ? "Moderator · " : ""}Your profile</small></span>`
    : `<span class="av anon">${PERSON_SVG}</span><span><b>Sign in</b><small>Or create an account to chat</small></span>`;
  drawer.innerHTML = `<div class="dr-in">
    <div class="dr-head">
      <button type="button" class="dr-who" data-go="profile"${here("profile")}>${who}</button>
      <button type="button" class="dr-x" id="drClose" aria-label="Close menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <nav class="dr-nav" aria-label="Sections">
      <button type="button" class="dr-link" data-go="home"${here("home")}>Developing Stories${live ? `<span class="n">${live} LIVE</span>` : ""}</button>
      <button type="button" class="dr-link" data-go="articles"${here("articles")}>Articles</button>
      <button type="button" class="dr-link" data-go="notices"${here("notices")}>Notices${urgent ? `<span class="n">${urgent} URGENT</span>` : ""}</button>
      <button type="button" class="dr-link" data-go="events"${here("events")}>Events</button>
      <button type="button" class="dr-link" data-go="transit"${here("transit")}>Transit</button>
    </nav>
    ${weatherLink() ? `<div class="dr-wx">${weatherLink()}</div>` : ""}
    <p class="dr-foot">Written by AI from official releases. <button type="button" class="by-link" data-go="privacy">Privacy</button></p>
  </div>`;
  $("#drClose").onclick = closeDrawer;
}
function openDrawer() {
  renderDrawer();
  drawer.classList.remove("closing");
  drawer.showModal();
  // showModal focuses the first button, which iOS outlines; start focus on the panel itself instead
  drawer.focus();
  $("#meBtn").setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  if (!drawer.open) return;
  $("#meBtn").setAttribute("aria-expanded", "false");
  if (reducedMotion()) return drawer.close();
  drawer.classList.add("closing");
  setTimeout(() => { drawer.classList.remove("closing"); drawer.close(); }, 200);
}
drawer.addEventListener("cancel", e => { e.preventDefault(); closeDrawer(); }); // Escape slides it out too
drawer.addEventListener("click", e => { if (e.target === drawer) closeDrawer(); }); // tap on the dimmed page
window.matchMedia("(max-width: 760px)").addEventListener("change", e => { if (!e.matches) closeDrawer(); });
$("#meBtn").addEventListener("click", () => phone() ? openDrawer() : goTo("profile"));

// ---------- Navigation: Developing Stories (home), Articles, a profile, or one article room ----------
const VIEWS = ["home", "articles", "notices", "events", "transit", "profile", "privacy"];
function show(v) {
  let toAlerts = false;
  if (v.startsWith("article-")) { S.article = v.slice(8); v = "article"; }
  else if (v.startsWith("user-")) {
    const id = v.slice(5);
    if (S.current !== "user" || S.user !== id) S.userFrom = S.current === "article" ? "article-" + S.article : S.current;
    S.user = id; v = "user";
  }
  else if (v.startsWith("reset-")) { S.resetToken = v.slice(6); v = "reset"; }
  else if (v.startsWith("transit")) { S.transitRoute = decodeURIComponent(v.slice(8)); v = "transit"; }
  // Alerts are a section of the profile, so old #alerts links land there
  else if (v === "alerts") { toAlerts = true; v = "profile"; }
  else if (!VIEWS.includes(v)) v = "home";
  if (v !== "article") { S.article = null; chatOpen = false; leaveRoom(); }
  if (v !== "transit") window.THTransit?.close();
  S.current = v;
  renderBanners(); // Home only
  for (const id of [...VIEWS, "article", "user", "reset"]) $("#" + id).hidden = v !== id;
  document.body.classList.toggle("wide-view", v === "article");
  document.body.classList.toggle("transit-view", v === "transit");
  if (v === "profile") $("#meBtn").setAttribute("aria-current", "page"); else $("#meBtn").removeAttribute("aria-current");
  document.querySelectorAll(".hnav [data-go]").forEach(b => { if (b.dataset.go === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  try { history.replaceState(null, "", "#" + hashOf(v)); } catch (e) {}
  if (v === "article") renderArticle(); else if (v === "user") renderUser(); else if (v === "reset") renderReset(); else if (v === "privacy") {} else if (v === "transit") openTransit(); else if (v === "events") openEvents(); else if (v === "profile") renderProfile(); else if (v === "articles") renderArticles(); else if (v === "notices") renderNotices(); else renderHome();
  applyChatState();
  // The profile can redraw once sign-in state loads, so keep landing on Alerts for a moment after the request
  if (toAlerts) { alertsScrollUntil = Date.now() + 2500; setTimeout(scrollToAlerts, 60); }
}
// The Transit map lives in its own script (and MapLibre), loaded the first time someone opens it
let transitScript;
function openTransit() {
  transitScript ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/transit.js"; s.onload = res; s.onerror = () => { transitScript = null; rej(); }; document.head.appendChild(s); });
  transitScript.then(() => { if (S.current === "transit") window.THTransit.open($("#transit"), S.transitRoute || ""); })
    .catch(() => { $("#transit").innerHTML = `<div class="msg">The transit map couldn't load. Check your connection and try again.</div>`; });
}
// Events and alerts live in their own scripts too, loaded the first time they're needed
const scripts = {};
const lazy = src => scripts[src] ||= new Promise((res, rej) => {
  const s = document.createElement("script"); s.src = src; s.onload = res;
  s.onerror = () => { delete scripts[src]; rej(); }; document.head.appendChild(s);
});
function openEvents() {
  lazy("/events.js").then(() => { if (S.current === "events") window.THEvents.open($("#events")); })
    .catch(() => { $("#events").innerHTML = `<div class="msg">The events list couldn't load. Check your connection and try again.</div>`; });
}
/** The Alerts section of the profile (signed in or not: alerts belong to the device, not an account). */
let alertsScrollUntil = 0;
function scrollToAlerts() { const a = $("#alertsH"); if (a && Date.now() < alertsScrollUntil) a.scrollIntoView({ block: "start" }); }
function openAlerts() {
  const el = $("#pAlerts");
  if (!el) return;
  scrollToAlerts();
  lazy("/alerts.js").then(async () => { if (S.current === "profile" && el.isConnected) { await window.THAlerts.open(el); scrollToAlerts(); } })
    .catch(() => { el.innerHTML = `<div class="msg">Alerts couldn't load. Check your connection and try again.</div>`; });
}
const goTo = v => { closeDrawer(); show(v); window.scrollTo({ top: 0 }); };
const hashOf = v => v === "article" ? "article-" + S.article : v === "user" ? "user-" + S.user : v === "reset" ? "reset-" + S.resetToken : v === "transit" && S.transitRoute ? "transit-" + encodeURIComponent(S.transitRoute) : v;
document.addEventListener("click", e => {
  const a = e.target.closest("[data-article]");
  if (a) { e.preventDefault(); return goTo("article-" + a.dataset.article); }
  const p = e.target.closest("[data-user]");
  if (p) { e.preventDefault(); return goTo("user-" + p.dataset.user); }
  const g = e.target.closest("[data-go]");
  if (g) { e.preventDefault(); goTo(g.dataset.go); }
});
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h !== hashOf(S.current)) goTo(h); });

// ---------- Pull to refresh ----------
// Home-screen web apps on iOS have no browser reload, so pulling down from the top refreshes the current view.
// In a normal browser tab the browser's own pull-to-refresh already does this, so it stays off there.
async function refreshView() {
  if (S.current === "home") return Promise.all([loadStories(), loadAlerts()]);
  if (S.current === "articles") return loadStories();
  if (S.current === "notices") return Promise.all([loadStories(), loadAlerts()]);
  if (S.current === "profile") return loadMe();
  if (S.current === "user") return renderUser();
  if (S.current === "events") return window.THEvents?.refresh();
  if (S.current === "reset" || S.current === "privacy" || S.current === "transit") return;
  const id = S.article, before = S.full[id];
  let a;
  try { a = await fetchStory(id); } catch (e) { return; }
  if (S.current !== "article" || S.article !== id) return;
  const col = $("#articleCol");
  // A story that changed kind or stage (e.g. moved to Articles) needs its whole page rebuilt
  if (!before || before.kind !== a.kind || before.stage !== a.stage || !col) return renderArticle();
  col.innerHTML = back(a) + articleHTML(a);
  wireStageTools();
  if ($("#cmList")) loadComments(id);
  if (a.kind === "article" && a.stage === "developing") connectRoom(id); // reconnects if iOS dropped the socket
}

const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
if (standalone && "ontouchstart" in window) {
  const THRESHOLD = 70, MAX = 110;
  const ptr = document.createElement("div");
  ptr.className = "ptr glass";
  ptr.setAttribute("aria-hidden", "true");
  ptr.innerHTML = '<svg class="arrow" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v13M6 12l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '<svg class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 4a8 8 0 1 0 8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  document.body.appendChild(ptr);
  const status = document.createElement("div");
  status.className = "sr"; status.setAttribute("role", "status");
  document.body.appendChild(status);
  let startY = null, startX = 0, pull = 0, busy = false;
  const paint = () => {
    const p = Math.min(1, pull / THRESHOLD);
    ptr.style.transform = `translate(-50%, ${pull ? Math.min(pull, MAX) - 52 : -52}px) rotate(${busy ? 0 : p * 180}deg)`;
    ptr.style.opacity = busy ? 1 : p;
    ptr.classList.toggle("ready", !busy && pull >= THRESHOLD);
  };
  document.addEventListener("touchstart", e => {
    const t = e.target;
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || t.closest(".chat, #transit, input, textarea, [contenteditable]")) { startY = null; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; pull = 0;
  }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
    if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { if (pull) { pull = 0; paint(); } return; }
    pull = dy * 0.5;
    ptr.classList.add("drag");
    paint();
  }, { passive: true });
  const end = async () => {
    if (startY == null) return;
    startY = null;
    ptr.classList.remove("drag");
    if (pull < THRESHOLD) { pull = 0; paint(); return; }
    busy = true; pull = THRESHOLD; ptr.classList.add("busy"); paint();
    status.textContent = "Refreshing";
    const minSpin = new Promise(r => setTimeout(r, 500)); // long enough to see that something happened
    try { await Promise.all([refreshView(), minSpin]); } catch (e) {}
    busy = false; pull = 0; ptr.classList.remove("busy"); paint();
    status.textContent = "Updated";
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", () => { startY = null; ptr.classList.remove("drag"); if (!busy) { pull = 0; paint(); } });
  paint();
}

// The docked chat sits just under the sticky header, whatever its height
const hdr = document.querySelector("header");
const setHdr = () => document.documentElement.style.setProperty("--hdr", hdr.offsetHeight + "px");
setHdr(); if (window.ResizeObserver) new ResizeObserver(setHdr).observe(hdr);

// ---------- Data ----------
async function loadStories() {
  try { S.stories = (await getJSON("/api/stories")).stories; S.offline = false; }
  catch (e) { S.offline = !S.stories; }
  if (S.current === "home") renderHome(); else if (S.current === "articles") renderArticles(); else if (S.current === "notices") renderNotices();
}
async function loadAlerts() {
  try { S.alerts = (await getJSON("/api/alerts")).alerts || { items: [] }; } catch (e) {}
  if (S.current === "home") renderBanners(); else if (S.current === "notices") renderNotices();
}
async function loadMe() {
  try { const d = await getJSON("/api/me"); S.me = d.user; S.providers = d.providers; } catch (e) {}
  renderMeButton();
  if (S.current === "profile") renderProfile();
  if (S.current === "article") renderComposer();
}

// ---------- Offline and installed ----------
const offlineBar = document.createElement("div");
offlineBar.className = "offline-bar"; offlineBar.setAttribute("role", "status");
offlineBar.textContent = "You're offline. Stories you've opened on this device are still here; chat comes back when you're online.";
document.querySelector("header").after(offlineBar);
const net = () => { offlineBar.hidden = navigator.onLine; document.body.classList.toggle("is-offline", !navigator.onLine); };
net();
window.addEventListener("offline", net);
window.addEventListener("online", () => {
  net(); showChatError("");
  loadStories(); loadAlerts();
  const a = S.current === "article" && S.full[S.article];
  if (a && a.kind === "article" && a.stage === "developing") { room.id = null; connectRoom(S.article); }
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  // A tapped push alert, when the page couldn't be navigated directly
  navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.t === "go") location.href = e.data.url; });
}

// ---------- Footer ----------
document.getElementById("sfYear").textContent = new Date().getFullYear();
// "Install the app": the browser's own install prompt where it offers one (Chrome, Edge, Android once it's ready);
// on iPhone, iPad and Android otherwise, a card with the steps. Hidden when it's already open as an installed app.
let installPrompt = null;
const sfInstall = document.getElementById("sfInstall"), installCard = document.getElementById("installCard");
const installed = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const showInstall = () => { sfInstall.hidden = installed() || !(installPrompt || isIOS || isAndroid); };
showInstall();
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; showInstall(); });
window.addEventListener("appinstalled", () => { installPrompt = null; sfInstall.hidden = true; if (installCard.open) installCard.close(); });
const SHARE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const MENU_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>`;
function openInstallCard() {
  const otherIOSBrowser = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent), iPad = isIOS && !/iPhone|iPod/.test(navigator.userAgent);
  const steps = isIOS ? [
    `Tap the Share button <span class="ico">${SHARE_ICON}</span> ${otherIOSBrowser ? "in the address bar" : iPad ? "at the top of Safari" : "at the bottom of Safari"}.`,
    "Scroll down and tap <b>Add to Home Screen</b>.",
    "Tap <b>Add</b>. TalkHalifax is now on your Home Screen; open it from there.",
  ] : [
    `Tap the menu <span class="ico">${MENU_ICON}</span> at the top right of your browser.`,
    "Tap <b>Add to Home screen</b> or <b>Install app</b>.",
    "Tap <b>Install</b> or <b>Add</b>. TalkHalifax is now with your apps.",
  ];
  installCard.innerHTML = `<div class="ins-in">
    <div class="ins-head"><img src="/icons/icon-192.png" alt=""><h2 id="insTitle">Install TalkHalifax</h2>
      <button type="button" class="ins-x" id="insClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
    <ol>${steps.map(t => `<li><span>${t}</span></li>`).join("")}</ol>
    <p class="ins-note">It opens full screen like an app, keeps the stories you've read for when you're offline, and can get alerts for urgent notices.</p>
  </div>`;
  installCard.querySelector("#insClose").onclick = () => installCard.close();
  installCard.showModal();
}
installCard.addEventListener("click", e => { if (e.target === installCard) installCard.close(); }); // tap outside closes
document.getElementById("sfInstallBtn").addEventListener("click", async () => {
  if (!installPrompt) return openInstallCard();
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null; showInstall();
});

show(location.hash.slice(1) || "home");
Promise.all([loadMe(), loadStories(), loadAlerts(), loadWeather()]);
// Home numbers ("2 here now", message counts) refresh while the page is visible
setInterval(() => { if (!document.hidden && (S.current === "home" || S.current === "articles" || S.current === "notices")) loadStories(); }, 20000);
setInterval(() => { if (!document.hidden) { loadAlerts(); loadWeather(); } }, 10 * 60000);

export { $, esc, linkify, fmt, hm, shortDate, fullDate, ago, S, reported, PERSON_SVG, hue, avatar, tms, loadingMsg, reducedMotion, chatHidden, setChatHidden, applyChatState, wireChat, back, lazy, openAlerts, goTo, loadStories, loadMe };
