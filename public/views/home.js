import { $, esc, hm, shortDate, ago, S, tms, loadingMsg, reducedMotion } from "../app.js";
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

/** Home is the developing stories, the most recently updated first. */
function renderHome() {
  renderBanners(); // city notices live in the banners now
  if (!S.stories) { setCards($("#devCards"), loadingMsg()); return; }
  const t = tms;
  const updated = x => Math.max(t(x.lastUpdate), t(x.developingSince), t(x.publishedAt));
  const dev = S.stories.filter(x => x.kind === "article" && x.stage === "developing").sort((a, b) => updated(b) - updated(a));
  const devCards = dev.map((x, i) => {
    const r = x.room;
    const recentUpdate = x.lastUpdate && Date.now() - t(x.lastUpdate) < 864e5;
    const left = recentUpdate ? `<span class="upd">Updated ${hm(x.lastUpdate)}</span>`
      : r.lastAt ? `<span>Last message ${ago(r.lastAt)}${r.lastAuthor ? " from " + esc(r.lastAuthor) : ""}</span>`
      : `<span>${shortDate(x.publishedAt)}</span>`;
    // Live viewer count: everyone with the story open right now, chatting or not
    const viewers = `<span class="viewers${r.here ? " on" : ""}" aria-label="${r.here} ${r.here === 1 ? "person" : "people"} here now">${VIEWER_SVG}<b>${r.here}</b></span>`;
    return `<button type="button" class="card glass${i === 0 ? " lead" : ""}" data-article="${esc(x.id)}">
      <span class="k">${esc(x.area || x.section || "Halifax")}</span>
      <span class="tt">${esc(x.headline)}</span>
      ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
      <span class="ft">${left}${viewers}</span></button>`;
  }).join("");
  setCards($("#devCards"), devCards || '<div class="msg">Nothing developing right now. New stories appear here as the newsroom publishes them, and settled ones are in <a href="#articles" data-go="articles">Articles</a>.</div>');
}

export { renderBanners, renderHome };
