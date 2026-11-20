import { $, esc, fmt, hm as fmtHm, shortDate as fmtShortDate, fullDate, S, tms, loadingMsg, reducedMotion } from "../app.js";
import { noticeType, noticeSeverity } from "./notices.js";

const VIEWER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4.2" fill="currentColor"/><path d="M3.8 21c.9-4.2 4.2-6.6 8.2-6.6s7.3 2.4 8.2 6.6z" fill="currentColor"/></svg>';

// ---------- Home ----------
const WEEK = 7 * 864e5;
const FEED_MAX = 24;
const RAIL_NOTICES = 3;
const RAIL_REPEATS_BAR = true; // false drops the alert bar's urgent notices from the column
const WX_MAX_AGE = 3 * 36e5; // matches WX_MAX_AGE in app.js, which doesn't export it: an old reading is worse than none

/** A time that parses and isn't missing (tms gives 0 for none and NaN for nonsense). Intl throws on an invalid date. */
const valid = x => { const t = tms(x); return Number.isFinite(t) && t !== 0; };
const iso = x => (valid(x) ? new Date(tms(x)).toISOString() : "");
/** The datetime attribute, left out when the time doesn't parse. */
const dt = x => { const s = iso(x); return s ? ` datetime="${esc(s)}"` : ""; };
const hm = t => (valid(t) ? fmtHm(t) : "");
const shortDate = t => (valid(t) ? fmtShortDate(t) : "");
const year = t => fmt({ year: "numeric" }).format(new Date(t));
/** A card timestamp in Halifax time: "Nov 20, 3:15 pm", with the year when it isn't this one. */
const when = t => (valid(t) ? (year(t) === year(Date.now()) ? shortDate(t) : fullDate(t)) + ", " + hm(t) : "");

/** Weather warnings go in the alert bar; watches and statements in the column. */
const inBar = a => a.cat === "Weather" && a.kind === "Warning";
const byPublished = (a, b) => tms(b.publishedAt) - tms(a.publishedAt);
/** City notices from the last week that are urgent, newest first: the alert bar's test. */
const urgentNotices = () => (S.stories || [])
  .filter(n => n.kind === "notice" && Date.now() - tms(n.publishedAt) < WEEK && noticeSeverity(n, noticeType(n)) === "urgent")
  .sort(byPublished);
const noticeLabel = n => noticeType(n) + (n.statusLabel ? " · " + n.statusLabel : "");
const isWeb = u => /^https?:\/\//i.test(String(u || ""));

/** Banners pinned under the header on Home, for urgent things only: weather warnings, then urgent city notices.
 *  Everything else is on the Notices page. */
function renderBanners() {
  renderRail(); // loadAlerts and show() call only this, so the column stays current with the bar
  const el = $("#abars");
  const items = [];
  for (const a of (S.alerts && S.alerts.items) || []) {
    if (!inBar(a)) continue;
    const until = valid(a.until) ? `Until ${shortDate(a.until)}, ${hm(a.until)}` : "";
    items.push({ rank: 0, label: "Weather · Warning",
      title: a.title, meta: until, at: tms(a.publishedAt), link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
  }
  for (const n of urgentNotices()) {
    items.push({ rank: 1, label: noticeLabel(n),
      title: n.headline, meta: shortDate(n.publishedAt), at: tms(n.publishedAt), link: `href="#article-${esc(n.id)}" data-article="${esc(n.id)}"` });
  }
  items.sort((a, b) => a.rank - b.rank || b.at - a.at);
  el.hidden = S.current !== "home" || !items.length;
  if (el.hidden) { el.innerHTML = ""; return; }
  const shown = S.allBanners ? items : items.slice(0, 1);
  // The first banner carries the toggle for the rest, so a stack costs no extra row when collapsed
  const toggle = items.length > 1 ? `<button type="button" class="abar-tog" id="abarMore" aria-expanded="${!!S.allBanners}">${S.allBanners ? "Less" : `+${items.length - 1} more`}</button>` : "";
  // Both banner kinds use the default warn band
  el.innerHTML = shown.map((b, i) => `<div class="abar"><div class="wrap abar-row"><a class="abar-in" ${b.link}>
      <span class="abar-k">${esc(b.label)}</span><span class="abar-t">${esc(b.title)}</span>${b.meta ? `<span class="abar-m">${esc(b.meta)}</span>` : ""}
    </a>${i === 0 ? toggle : ""}</div></div>`).join("");
  const more = $("#abarMore");
  if (more) more.onclick = () => { S.allBanners = !S.allBanners; renderBanners(); };
}

/** A feed row that leaves the site: a link only when the address is a web address, otherwise a plain row. */
const outRow = (url, inner, label = "") => isWeb(url)
  ? `<a class="feed-row" href="${esc(url)}" target="_blank" rel="noopener"${label ? ` aria-label="${esc(label)}"` : ""}>${inner}</a>`
  : `<div class="feed-row">${inner}</div>`;
/** A number from the API, or NaN when it's missing (Number(null) would be 0). */
const num = v => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** Environment Canada's current conditions, or "" when there's no reading or it's too old to trust (as in the header). */
function railWeather() {
  const w = S.weather;
  if (!w || !valid(w.observedAt) || Date.now() - tms(w.observedAt) > WX_MAX_AGE) return "";
  const temp = num(w.tempC), feels = num(w.feelsLikeC);
  if (!Number.isFinite(temp)) return "";
  const cond = w.condition || "";
  const hasFeels = Number.isFinite(feels);
  const about = `${cond ? cond + ", " : ""}${temp}°C${hasFeels ? `, feels like ${feels}°C` : ""}. Environment Canada, ${hm(w.observedAt)}`;
  const tt = hasFeels ? `${esc(cond ? cond + ", feels like " : "Feels like ")}${feels}°C` : esc(cond);
  const inner = `<span class="pill">${temp}°C</span><span class="tt">${tt}</span><time class="stamp"${dt(w.observedAt)}>${esc(hm(w.observedAt))}</time>`;
  return `<h3>Weather</h3><div class="feed">${outRow(w.url, inner, about)}</div>`;
}

/** Weather watches and statements (warnings are in the bar), newest first. */
function railWatches() {
  const list = ((S.alerts && S.alerts.items) || []).filter(a => a.cat === "Weather" && !inBar(a)).sort(byPublished);
  if (!list.length) return "";
  const stamp = a => valid(a.until)
    ? `<time class="stamp"${dt(a.until)}>Until ${esc(shortDate(a.until))}, ${esc(hm(a.until))}</time>`
    : valid(a.publishedAt) ? `<time class="stamp"${dt(a.publishedAt)}>${esc(when(a.publishedAt))}</time>` : "";
  const rows = list.map(a => outRow(a.url, `<span class="pill">${esc(a.kind)}</span><span class="tt">${esc(a.title)}</span>${stamp(a)}`)).join("");
  return `<h3>Weather watches and statements</h3><div class="feed">${rows}</div>`;
}

/** The latest city notices: the bar's urgent ones first (unless RAIL_REPEATS_BAR is off), then the rest, newest first. */
function railNotices() {
  if (!S.stories) return "";
  const urgent = urgentNotices();
  const ids = new Set(urgent.map(n => n.id));
  const rest = S.stories.filter(n => n.kind === "notice" && !ids.has(n.id)).sort(byPublished);
  const picked = [...(RAIL_REPEATS_BAR ? urgent : []), ...rest].slice(0, RAIL_NOTICES);
  if (!picked.length) return "";
  const rows = picked.map(n => `<a class="feed-row" href="#article-${esc(n.id)}" data-article="${esc(n.id)}"><span class="pill">${esc(noticeLabel(n))}</span><span class="tt">${esc(n.headline)}</span><time class="stamp"${dt(n.publishedAt)}>${esc(when(n.publishedAt))}</time></a>`).join("");
  return `<h3>Notices</h3><div class="feed">${rows}</div><a class="more" href="#notices" data-go="notices">All notices</a>`;
}

/** The "Right now" column: weather, then watches and statements, then notices, leaving out any that are empty. */
function renderRail() {
  const rail = $("#homeRail"), body = $("#railBody");
  if (!rail || !body) return;
  const html = railWeather() + railWatches() + railNotices();
  if (html) { rail.hidden = false; setCards(body, html); }
  else { rail.hidden = true; setCards(body, ""); }
}

/** Swap in new cards, sliding the ones that moved, fading in new stories and fading out ones that left (moved to Articles). */
function setCards(box, html) {
  if (box.dataset.html === html) return;
  const old = new Map();
  const animate = !reducedMotion() && box.offsetParent && typeof box.animate === "function";
  if (animate) box.querySelectorAll(".card[data-article]").forEach(el => old.set(el.dataset.article, { el, r: el.getBoundingClientRect() }));
  const boxR = box.getBoundingClientRect();
  box.innerHTML = html; box.dataset.html = html;
  if (!animate || !old.size) return;
  const seen = new Set();
  box.querySelectorAll(".card[data-article]").forEach(el => {
    const id = el.dataset.article, was = old.get(id), now = el.getBoundingClientRect();
    seen.add(id);
    if (!was) return el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "ease-out" });
    const dx = was.r.left - now.left, dy = was.r.top - now.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 520, easing: "cubic-bezier(.2, .7, .2, 1)" });
  });
  for (const [id, { el, r }] of old) {
    if (seen.has(id)) continue;
    el.classList.add("ghost"); el.removeAttribute("data-article"); el.setAttribute("aria-hidden", "true"); el.tabIndex = -1;
    Object.assign(el.style, { left: r.left - boxR.left + "px", top: r.top - boxR.top + "px", width: r.width + "px", height: r.height + "px" });
    box.appendChild(el);
    el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }], { duration: 360, easing: "ease-in", fill: "forwards" }).onfinish = () => el.remove();
  }
}

const EMPTY_ALL = '<div class="msg">Nothing developing right now. New stories appear here as the newsroom publishes them, and settled ones are in <a href="#articles" data-go="articles">Articles</a>.</div>';

/** Home is the developing stories pinned first, then the settled articles as a feed, each the most recently updated first. */
function renderHome() {
  renderBanners(); // the alert bar, and the "Right now" column with it
  // Build 1 drew everything in #devCards; the sections below replace it
  const dev = $("#devCards");
  if (dev && !dev.hidden) { dev.hidden = true; dev.innerHTML = ""; delete dev.dataset.html; }
  const pinsSec = $("#pinsSec"), pinsBox = $("#pins"), pinsCount = $("#pinsCount");
  const feedSec = $("#feedSec"), feedBox = $("#feed");
  if (!S.stories) {
    pinsSec.hidden = false; pinsCount.textContent = ""; setCards(pinsBox, loadingMsg());
    feedSec.hidden = true; setCards(feedBox, "");
    return;
  }
  const t = tms;
  const offline = !navigator.onLine;
  const updated = x => Math.max(t(x.lastUpdate), t(x.developingSince), t(x.publishedAt));
  const newest = (a, b) => updated(b) - updated(a);
  const arts = S.stories.filter(x => x.kind === "article");
  const pins = arts.filter(x => x.stage === "developing").sort(newest);
  const feed = arts.filter(x => x.stage === "archived").sort(newest).slice(0, FEED_MAX);
  const kicker = x => (x.area || x.section ? `<span class="k">${esc(x.area || x.section)}</span>` : "");
  const head = x => `${kicker(x)}
      <span class="tt">${esc(x.headline)}</span>
      ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}`;
  const messages = r => {
    const n = Number(r && r.messages) || 0;
    return `<span class="pill${n ? "" : " zero"}">${n} ${n === 1 ? "message" : "messages"}${offline ? ", last seen" : ""}</span>`;
  };
  // A version 1 story has never changed, whatever its last-written time says (as in article.js)
  const changed = x => x.version > 1 && x.lastUpdate;
  const stampAt = x => (changed(x) ? x.lastUpdate : x.publishedAt);
  const stamp = x => { const w = when(stampAt(x)); return w ? (changed(x) ? "Updated " : "Published ") + w : ""; };
  const pinCards = pins.map((x, i) => {
    const r = x.room || {};
    const recentUpdate = changed(x) && Date.now() - t(x.lastUpdate) < 864e5;
    const note = changed(x) && x.updateNote
      ? `<span class="dk"><span class="upd">Latest update</span> · ${esc(x.updateNote)}</span>` : "";
    // Viewer count: everyone with the story open, live when online, the last count we saw when offline
    const here = Number(r.here) || 0, who = here === 1 ? "person" : "people";
    const viewers = offline
      ? `<span class="viewers" aria-label="${here} ${who} here when last seen">${VIEWER_SVG}<b>${here}</b> last seen</span>`
      : `<span class="viewers${here ? " on" : ""}" aria-label="${here} ${who} here now">${VIEWER_SVG}<b>${here}</b></span>`;
    return `<button type="button" class="card glass${i === 0 ? " lead" : ""}" data-article="${esc(x.id)}">
      ${head(x)}
      ${note}
      <span class="ft"><span class="ft-start"><time class="stamp${recentUpdate ? " upd" : ""}"${dt(stampAt(x))}>${esc(stamp(x))}</time> ${messages(r)}</span>${viewers}</span></button>`;
  }).join("");
  const rows = feed.map(x => `<button type="button" class="feed-row" data-article="${esc(x.id)}"><span class="pill">Story</span><span class="tt">${esc(x.headline)}</span><time class="stamp"${dt(stampAt(x))}>${esc(stamp(x))}</time></button>`).join("");

  if (pins.length || !feed.length) {
    pinsSec.hidden = false; pinsCount.textContent = pins.length ? String(pins.length) : ""; setCards(pinsBox, pinCards || EMPTY_ALL);
  } else {
    pinsSec.hidden = true; pinsCount.textContent = ""; setCards(pinsBox, "");
  }
  if (!feed.length) feedSec.hidden = true;
  setCards(feedBox, rows);
  feedSec.hidden = !feed.length;
}

// Switch the viewer counts between "here now" and "last seen" as the connection comes and goes
for (const ev of ["offline", "online"]) window.addEventListener(ev, () => { if (S.current === "home") renderHome(); });

export { renderBanners, renderHome };
