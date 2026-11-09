import { $, esc, hm, shortDate, S, tms, loadingMsg } from "../app.js";

// ---------- Notices: city notices and weather alerts, coloured by severity ----------
const N_TYPES = ["Emergency", "Police", "Roads", "Water", "Transit", "Winter", "Weather", "City"];
/** What a city notice is about, from its section and headline. */
function noticeType(n) {
  const s = (n.section || "").toLowerCase(), h = (n.headline || "").toLowerCase();
  if (s === "halifax water") return "Water"; // "emergency" here is usually one street's shut-off, not a city emergency
  if (/fire|emergenc/.test(s) || /\b(fire|evacuat|emergency|hazmat|shelter in place)/.test(h)) return "Emergency";
  if (/police/.test(s) || /\b(police|rcmp|homicide|arrest|charged|missing (person|man|woman|youth|boy|girl))/.test(h)) return "Police";
  if (/winter/.test(s) || /parking ban|snow|plow/.test(h)) return "Winter";
  if (/water/.test(s) || /boil[- ]water|water main|water service/.test(h)) return "Water";
  if (/transit/.test(s) || /\b(ferry|bus|transit)\b/.test(h)) return "Transit";
  if (/road|transportation/.test(s) || /traffic|road|lane|highway|detour|bridge|street|drive/.test(h)) return "Roads";
  return "City";
}
const RESOLVED = /\b(lifted|final update|resolved|reopened|located|cancell?ed|ended|over)\b/i;
/** urgent (safety), disruption (getting around, water), info, or resolved */
function noticeSeverity(n, type) {
  if (n.supersededBy || RESOLVED.test(n.statusLabel || "") || RESOLVED.test(n.headline || "")) return "resolved";
  if (type === "Emergency" || /boil[- ]water|missing|evacuat|shelter in place/i.test(n.headline || "")) return "urgent";
  if (["Roads", "Water", "Transit", "Winter"].includes(type)) return "disruption";
  return "info";
}
const SEV_RANK = { urgent: 0, disruption: 1, info: 2, resolved: 3 };
/** Every notice as one shape: city notices from the newsroom, weather alerts from ECCC. */
function allNotices() {
  const out = [];
  for (const n of S.stories || []) {
    if (n.kind !== "notice") continue;
    const type = noticeType(n), sev = noticeSeverity(n, type);
    out.push({ id: n.id, type, sev, status: n.statusLabel, title: n.headline, dek: n.dek, area: n.area, at: tms(n.publishedAt),
      old: sev === "resolved" || Date.now() - tms(n.publishedAt) > 7 * 864e5, link: `data-article="${esc(n.id)}"` });
  }
  for (const a of (S.alerts && S.alerts.items) || []) {
    if (a.cat !== "Weather") continue;
    out.push({ id: "w:" + a.title, type: "Weather", sev: a.kind === "Warning" ? "urgent" : a.kind === "Watch" ? "disruption" : "info",
      status: a.kind, title: a.title, dek: a.detail, area: "", at: tms(a.publishedAt), old: false,
      until: a.until, link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
  }
  return out;
}
function noticeCard(n) {
  const tag = n.link.startsWith("href") ? "a" : "button";
  return `<${tag} ${tag === "button" ? 'type="button" ' : ""}class="ncard ${n.sev}" ${n.link}>
    <span class="nk">${esc(n.type)}${n.status ? `<span class="st">${esc(n.status)}</span>` : ""}</span>
    <span class="tt">${esc(n.title)}</span>
    ${n.dek ? `<span class="dk">${esc(n.dek)}</span>` : ""}
    <span class="ft"><span>${n.until ? `Until ${shortDate(n.until)}, ${hm(n.until)}` : n.at ? shortDate(n.at) + ", " + hm(n.at) : ""}</span><span>${esc(n.area || "")}</span></span>
  </${tag}>`;
}
function renderNotices() {
  if (!S.stories) { $("#nActive").innerHTML = loadingMsg(); return; }
  const all = allNotices(), f = S.nFilter || "All";
  const active = all.filter(n => !n.old);
  const types = N_TYPES.filter(t => all.some(n => n.type === t));
  $("#nFilters").innerHTML = ["All", ...types].map(t => {
    const c = t === "All" ? active.length : active.filter(n => n.type === t).length;
    return `<button type="button" data-nf="${t}" aria-pressed="${t === f}">${t}${c ? `<span class="c">${c}</span>` : ""}</button>`;
  }).join("");
  const shown = all.filter(n => f === "All" || n.type === f);
  const now = shown.filter(n => !n.old).sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.at - a.at);
  const earlier = shown.filter(n => n.old).sort((a, b) => b.at - a.at).slice(0, 24);
  $("#nActive").innerHTML = now.map(noticeCard).join("") || `<div class="msg">No current ${f === "All" ? "" : f.toLowerCase() + " "}notices.</div>`;
  $("#nEarlierH").hidden = !earlier.length;
  $("#nEarlier").innerHTML = earlier.map(noticeCard).join("");
}

export { noticeType, noticeSeverity, allNotices, renderNotices };
