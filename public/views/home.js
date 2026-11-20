import { $, esc, fmt, hm, shortDate, fullDate, S, tms, loadingMsg, reducedMotion } from "../app.js";
import { noticeType, noticeSeverity } from "./notices.js";

const VIEWER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4.2" fill="currentColor"/><path d="M3.8 21c.9-4.2 4.2-6.6 8.2-6.6s7.3 2.4 8.2 6.6z" fill="currentColor"/></svg>';

// ---------- Home ----------
/** Banners pinned under the header on Home, for urgent things only: weather warnings, then urgent city notices.
 *  Everything else is on the Notices page. */
function renderBanners() {
  const el = $("#abars");
  const t = x => (x ? new Date(x).getTime() : 0);
  const items = [];
  for (const a of (S.alerts && S.alerts.items) || []) {
    if (a.cat !== "Weather" || a.kind !== "Warning") continue;
    const until = t(a.until) ? `Until ${shortDate(a.until)}, ${hm(a.until)}` : "";
    items.push({ rank: 0, label: "Weather · Warning",
      title: a.title, meta: until, at: t(a.publishedAt), link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
  }
  for (const n of S.stories || []) {
    if (n.kind !== "notice" || Date.now() - t(n.publishedAt) >= 7 * 864e5) continue;
    const type = noticeType(n);
    if (noticeSeverity(n, type) !== "urgent") continue;
    items.push({ rank: 1, label: type + (n.statusLabel ? " · " + n.statusLabel : ""),
      title: n.headline, meta: shortDate(n.publishedAt), at: t(n.publishedAt), link: `href="#article-${esc(n.id)}" data-article="${esc(n.id)}"` });
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

const FEED_MAX = 24;
const year = t => fmt({ year: "numeric" }).format(new Date(t));
/** A card timestamp in Halifax time: "Nov 20, 3:15 pm", with the year when it isn't this one. */
const when = t => (year(t) === year(Date.now()) ? shortDate(t) : fullDate(t)) + ", " + hm(t);

/** Home is the developing stories pinned first, then the settled articles as a feed, each the most recently updated first. */
function renderHome() {
  renderBanners(); // city notices live in the banners now
  if (!S.stories) { setCards($("#devCards"), loadingMsg()); return; }
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
  const stamp = x => (changed(x) ? "Updated " + when(x.lastUpdate) : "Published " + when(x.publishedAt));
  const pinCards = pins.map((x, i) => {
    const r = x.room || {};
    const recentUpdate = changed(x) && Date.now() - t(x.lastUpdate) < 864e5;
    const left = `<span${recentUpdate ? ' class="upd"' : ""}>${esc(stamp(x))}</span>`;
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
      <span class="ft"><span>${left} ${messages(r)}</span>${viewers}</span></button>`;
  }).join("");
  const feedCards = feed.map(x => `<button type="button" class="card glass archived" data-article="${esc(x.id)}">
      ${head(x)}
      <span class="ft"><span><span>${esc(stamp(x))}</span> ${messages(x.room)}</span></span></button>`).join("");
  const html = pinCards ? pinCards + feedCards
    : feedCards ? '<div class="msg">Nothing developing right now.</div>' + feedCards
    : '<div class="msg">Nothing developing right now. New stories appear here as the newsroom publishes them, and settled ones are in <a href="#articles" data-go="articles">Articles</a>.</div>';
  setCards($("#devCards"), html);
}

// Switch the viewer counts between "here now" and "last seen" as the connection comes and goes
for (const ev of ["offline", "online"]) window.addEventListener(ev, () => { if (S.current === "home") renderHome(); });

export { renderBanners, renderHome };
