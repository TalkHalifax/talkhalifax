import { $, esc, shortDate, S, hue, avatar, loadingMsg, back } from "../app.js";
import { getJSON } from "../api.js";

/** Someone's public profile; for the newsroom's journalist, every story they wrote. */
const UM = { armed: null, link: null };
async function renderUser() {
  const v = $("#user"), id = S.user;
  const backBtn = S.userFrom && S.userFrom.startsWith("article-")
    ? `<button type="button" class="back" data-article="${esc(S.userFrom.slice(8))}">← Back to the story</button>` : back();
  if (!S.users[id]) v.innerHTML = `<div class="profile">${backBtn}${loadingMsg()}</div>`;
  let d = S.users[id];
  try { d = S.users[id] = await getJSON("/api/users/" + encodeURIComponent(id)); }
  catch (e) { if (!d) { if (S.current === "user" && S.user === id) v.innerHTML = `<div class="profile">${backBtn}<div class="msg">This profile isn't available.</div></div>`; return; } }
  if (S.current !== "user" || S.user !== id) return;
  const u = d.user, st = d.stories || [];
  const live = st.filter(x => x.stage === "developing").length;
  const stats = u.ai
    ? [[st.length, st.length === 1 ? "story" : "stories"], [live, "developing now"], [st.filter(x => x.kind === "notice").length, "notices"]]
    : [[d.stats.messages, d.stats.messages === 1 ? "message sent" : "messages sent"], [d.stats.rooms, d.stats.rooms === 1 ? "chat joined" : "chats joined"]];
  v.innerHTML = `<div class="profile">${backBtn}
    <div class="profile-card glass">
      <div class="pic">${u.avatar ? `<img alt="" src="${esc(u.avatar)}" referrerpolicy="no-referrer">` : avatar({ id: u.id, name: u.name }, "av").replace('class="av"', 'class="av" style="width:100%;height:100%;font-size:32px;background:' + hue(u.id) + '"')}</div>
      <div><h1>${esc(u.name || "Someone")}</h1><p>${u.ai ? "TalkHalifax journalist" : "Halifax"}${u.ai ? '<span class="role">AI</span>' : u.role === "moderator" ? '<span class="role">Moderator</span>' : ""}</p></div>
    </div>
    ${u.bio ? `<p class="u-bio">${esc(u.bio)}</p>` : ""}
    <div class="stats">${stats.map(([n, l]) => `<div class="stat glass"><b>${n || 0}</b><span>${l}</span></div>`).join("")}</div>
    ${u.ai ? `<h2 class="p-h">Stories by ${esc((u.name || "").split(" ")[0])}</h2>
    <div class="cards">${st.map(x => `<button type="button" class="card glass${x.stage === "archived" ? " archived" : ""}" data-article="${esc(x.id)}">
        <span class="k">${x.stage === "developing" ? "Developing · " : ""}${esc(x.kind === "notice" ? "Notice" : x.area || x.section || "Halifax")}</span>
        <span class="tt">${esc(x.headline)}</span>
        ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
        <span class="ft"><span>${shortDate(x.publishedAt)}</span></span></button>`).join("") || '<div class="msg">No stories yet.</div>'}</div>` : ""}
    ${d.mod ? `<h2 class="p-h">Moderator tools</h2>
    ${d.mod.banned ? `<p class="u-bio">Banned: they can read, but can't chat, comment or report.</p>` : ""}
    <div class="mod-tools">
      ${d.mod.banned ? `<button type="button" class="btn ghost" data-mod="unban">Unban</button>`
        : `<button type="button" class="btn ghost" data-mod="ban">Ban from posting</button>
           <button type="button" class="btn ghost${UM.armed === "purge" ? " danger-btn" : ""}" data-mod="purge">${UM.armed === "purge" ? "Ban and erase everything they posted?" : "Ban and remove their posts"}</button>`}
      ${d.mod.password ? `<button type="button" class="btn ghost" data-mod="reset">Make a password reset link</button>` : ""}
    </div>
    ${UM.link && UM.link.id === u.id ? `<div class="reset-link glass"><label for="rsUrl">Reset link for ${esc(u.name)}</label>
      <div class="row2"><input id="rsUrl" readonly value="${esc(UM.link.url)}"><button type="button" class="btn primary" id="rsCopy">Copy</button></div>
      <small>Works once, for the next hour. Send it to them privately; anyone with it can set their password.</small></div>` : ""}
    <div class="auth-err" id="umErr" role="alert" hidden></div>` : ""}
    <p class="p-note">${u.ai ? "An AI journalist: every story is written from an official release, and an editor approves articles before they publish." : `Joined ${shortDate(u.joined)}.`}</p>
  </div>`;
  v.querySelectorAll("[data-mod]").forEach(b => b.addEventListener("click", async () => {
    const act = b.dataset.mod, err = $("#umErr");
    if (act === "purge" && UM.armed !== "purge") { UM.armed = "purge"; return renderUser(); }
    UM.armed = null; b.disabled = true;
    const post = (path, body) => fetch(`/api/users/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const r = act === "reset" ? await post("reset", {}) : await post("ban", { banned: act !== "unban", purge: act === "purge" });
    const out = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { err.textContent = out.error || "That didn't work. Try again."; err.hidden = false; b.disabled = false; return; }
    if (act === "reset") UM.link = { id, url: out.url };
    renderUser();
  }));
  const copy = $("#rsCopy");
  if (copy) copy.addEventListener("click", async () => {
    const i = $("#rsUrl"); i.select();
    try { await navigator.clipboard.writeText(i.value); copy.textContent = "Copied"; } catch (e) { document.execCommand("copy"); copy.textContent = "Copied"; }
  });
}

export { renderUser };
