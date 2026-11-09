import { $, esc, linkify, fmt, hm, fullDate, ago, S, reported, avatar, applyChatState, wireChat, back, lazy, loadStories } from "../app.js";
import { getJSON, sendReport } from "../api.js";
import { renderComposer, leaveRoom, connectRoom } from "../chat.js";

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "the source"; } };

// Who a story's source is, by the site it's on: a notice's label, and how the byline names it
const SOURCES = [
  [/(^|\.)halifaxwater\.ca$/, "Halifax Water", "Halifax Water's"],
  [/(^|\.)halifax\.ca$/, "City notice", "the city's"],
  [/(^|\.)rcmp\.ca$/, "RCMP", "the RCMP's"],
  [/(^|\.)novascotia\.ca$/, "Province", "the Province's"],
  [/(^|\.)weather\.gc\.ca$/, "Environment Canada", "Environment Canada's"],
  [/(^|\.)nspower\.ca$/, "Nova Scotia Power", "Nova Scotia Power's"],
];
const sourceOf = u => { const h = hostOf(u), s = SOURCES.find(x => x[0].test(h)); return s ? { label: s[1], whose: s[2] } : { label: "Notice", whose: "the official" }; };

// Newsroom style: "Nov. 6", with the year only when it isn't this one
const MONTHS = { January: "Jan.", February: "Feb.", August: "Aug.", September: "Sept.", October: "Oct.", November: "Nov.", December: "Dec." };
function storyDate(t) {
  const d = new Date(t), month = fmt({ month: "long" }).format(d), year = fmt({ year: "numeric" }).format(d);
  return `${MONTHS[month] || month} ${fmt({ day: "numeric" }).format(d)}${year === fmt({ year: "numeric" }).format(new Date()) ? "" : ", " + year}`;
}
const readTime = a => Math.max(1, Math.round([...a.body, ...(a.actions || []), ...a.means].join(" ").split(/\s+/).length / 200));
/** A line of a story's text: a string starting "## " is a subheading. */
const bodyLine = p => p.startsWith("## ") ? `<h2>${esc(p.slice(3))}</h2>` : `<p>${linkify(p)}</p>`;

/** The article itself (shared by Developing and Articles views, and swapped in place on live updates). */
function articleHTML(a) {
  const isNotice = a.kind === "notice";
  const newer = isNotice && a.supersededBy && (S.stories || []).find(s => s.id === a.supersededBy);
  const developing = a.kind === "article" && a.stage === "developing";
  // A version 1 story has never changed, whatever its last-written time says
  const changed = a.version > 1 && a.lastUpdate;
  const showUpdate = (developing || isNotice) && changed && a.updateNote && !newer;
  const mod = S.me && S.me.role === "moderator" && a.kind === "article";
  const src = sourceOf(a.source), doc = isNotice ? "notice" : "release";
  // Notices' points were always actions. An older article's stay at the bottom as "what this means"
  const actions = a.actions && a.actions.length ? a.actions : isNotice ? a.means : [];
  const oldMeans = !isNotice && a.means.length ? `<h2 class="means-h">What this means for you</h2><ul>${a.means.map(p => `<li>${linkify(p)}</li>`).join("")}</ul>` : "";
  const facts = a.facts.length ? `<dl class="facts">${a.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${linkify(f.v)}</dd>`).join("")}</dl>` : "";
  const kicker = isNotice
    ? src.label + (a.statusLabel ? " · " + esc(a.statusLabel) : "")
    : (developing ? "Developing · " : "") + (a.section && a.section !== "City Hall" ? esc(a.section) + " · " : "") + esc(a.area || "Halifax");
  return `
    <article>
      <div class="kicker${isNotice ? " notice" : ""}">${kicker}</div>
      <h1>${esc(a.headline)}</h1>
      ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
      <p class="byline"><span>${a.author ? `<button type="button" class="by-link" data-user="${esc(a.author.id)}">${esc(a.author.name)}</button>, AI journalist · ` : ""}${storyDate(a.publishedAt)}${isNotice ? "" : ` · ${readTime(a)} min read`}${changed ? ` · Updated ${storyDate(a.lastUpdate)}, ${hm(a.lastUpdate)}` : ""}</span> <span>Written by AI from <a href="${esc(a.source)}" target="_blank" rel="noopener">${src.whose} ${doc}</a>${isNotice ? ", facts only" : ""}</span></p>
      ${showUpdate ? `<div class="updated-banner"><b>Latest update</b> · ${esc(ago(a.lastUpdate))}: ${esc(a.updateNote)}</div>` : ""}
      ${newer ? `<button type="button" class="banner" data-article="${esc(newer.id)}"><b>There's a newer update.</b> <span>${esc(newer.headline)} →</span></button>` : ""}
      ${actions.length ? `<section class="todo"><h2>What to do</h2><ul>${actions.map(p => `<li>${linkify(p)}</li>`).join("")}</ul></section>` : ""}
      ${isNotice ? facts : ""}
      <div class="body">
        ${a.body.map(bodyLine).join("")}
        ${oldMeans}
      </div>
      ${!isNotice && facts ? `<section class="key-details"><h2>Key details</h2>${facts}</section>` : ""}
      <div class="source">If anything here differs from <a href="${esc(a.source)}" target="_blank" rel="noopener">the original ${doc} on ${esc(hostOf(a.source))}</a>, the original is right.</div>
      ${a.author ? `<button type="button" class="author-card" data-user="${esc(a.author.id)}" aria-label="${esc(a.author.name)}'s profile">${avatar({ id: a.author.id, name: a.author.name })}<span><b>${esc(a.author.name)}</b><span class="ac-bio">${esc(a.author.bio)}</span><span class="ac-more">See all of ${esc(a.author.name.split(" ")[0])}'s stories →</span></span></button>` : ""}
      ${mod ? `<div class="stage-tools">Moderator: <button type="button" id="stageBtn" data-stage="${developing ? "archived" : "developing"}">${developing ? "Move to Articles (closes and clears the chat)" : "Move back to Developing"}</button></div>` : ""}
    </article>`;
}

async function fetchStory(id) {
  const a = (await getJSON("/api/stories/" + encodeURIComponent(id))).story;
  S.full[id] = a;
  // Keep the home list in step with what this page now knows
  if (S.stories) { const i = S.stories.findIndex(s => s.id === id); if (i >= 0) S.stories[i] = { ...S.stories[i], ...a }; }
  return a;
}

async function renderArticle() {
  const v = $("#article");
  const id = S.article;
  v.classList.remove("wide");
  let a = S.full[id];
  if (!a) {
    v.innerHTML = `${back()}<div class="msg" style="margin-top:20px">Loading…</div>`;
    try { a = await fetchStory(id); }
    catch (e) { if (S.article === id) v.innerHTML = `${back()}<div class="msg" style="margin-top:20px">This story isn't available.</div>`; return; }
    if (S.article !== id) return;
  }

  if (a.kind === "skip") {
    v.innerHTML = `${back()}
      <article>
        <div class="kicker">${esc(a.section)}</div>
        <h1>${esc(a.headline)}</h1>
        <div class="byline"><span>Announcement from the Halifax Regional Municipality</span><span>${fullDate(a.publishedAt)}</span></div>
        <div class="body"><p style="color:var(--muted)">We haven't written this one up${a.reason ? ": " + esc(a.reason.toLowerCase()) : ""}.</p></div>
        <div class="source">Source and full text: <a href="${esc(a.source)}" target="_blank" rel="noopener">original release on halifax.ca</a>.</div>
      </article>`;
    window.scrollTo({ top: 0 }); return;
  }

  if (a.kind === "notice") {
    v.innerHTML = `<div class="room"><div>${back(a)}${articleHTML(a)}<p class="closed">Chat and comments are off for notices. For emergencies, follow official channels and sign up for hfxALERT at <a href="https://halifax.ca/hfxalert" target="_blank" rel="noopener">halifax.ca/hfxalert</a>.</p><div id="alertOffer"></div></div></div>`;
    // Readers are offered alerts after opening a notice, never on a first visit to the site
    lazy("/alerts.js").then(() => { const o = $("#alertOffer"); if (o) window.THAlerts.offer(o); }).catch(() => {});
    wireStageTools(); window.scrollTo({ top: 0 }); return;
  }

  // ---- Articles: no live chat; threaded comments below ----
  if (a.stage !== "developing") {
    leaveRoom();
    v.innerHTML = `<div class="room"><div id="articleCol">${back(a)}${articleHTML(a)}</div></div>
      <section class="comments-sec" aria-labelledby="cmH">
        <div class="c-head2"><h2 id="cmH">Comments</h2><span id="cmCount"></span></div>
        <div id="cmCompose"></div>
        <ul class="cthread" id="cmList"><li class="msg" style="border:0">Loading comments…</li></ul>
      </section>`;
    wireStageTools();
    window.scrollTo({ top: 0 });
    loadComments(id);
    return;
  }

  // ---- Developing: article plus the docked live chat ----
  v.classList.add("wide");
  v.innerHTML = `<div class="room">
    <div id="articleCol">${back(a)}${articleHTML(a)}</div>
    <aside class="chat glass" id="chat" aria-label="Live chat about this story">
      <div class="chat-head" id="chatHead">
        <span class="grab" aria-hidden="true"></span>
        <h2>Live chat</h2>
        <span class="here" id="here"></span>
        <button type="button" class="chat-toggle" id="chatToggle" aria-controls="chat">
          <svg class="side" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6M19 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <svg class="down" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="msgs" id="msgs" aria-live="polite"><div class="chat-empty">Connecting…</div></div>
      <div class="typing" id="typing"></div>
      <div class="chat-err" id="chatErr" hidden></div>
      <div id="composerSlot"></div>
    </aside>
    <button type="button" class="chat-reopen glass" id="chatReopen" hidden><span class="dot-live" aria-hidden="true"></span>Live chat <span class="n" id="reopenN"></span></button>
  </div>`;
  renderComposer();
  wireChat(v);
  wireStageTools();
  applyChatState();
  window.scrollTo({ top: 0 });
  connectRoom(id);
}

/** The newsroom updated the article: swap it in place without touching the chat. */
async function refreshArticleInPlace(id) {
  let a;
  try { a = await fetchStory(id); } catch (e) { return; }
  const col = $("#articleCol");
  if (S.current !== "article" || S.article !== id || !col) return;
  col.innerHTML = back(a) + articleHTML(a);
  wireStageTools();
  const art = col.querySelector("article");
  if (art) { art.classList.remove("flash-update"); void art.offsetWidth; art.classList.add("flash-update"); }
}

/** The story moved to Articles while open: reload it as an article with comments. */
async function storyClosed(id) {
  leaveRoom();
  delete S.full[id];
  if (S.current === "article" && S.article === id) { await renderArticle(); }
}

function wireStageTools() {
  const b = $("#stageBtn");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await fetch(`/api/stories/${encodeURIComponent(S.article)}/stage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: b.dataset.stage }),
    });
    if (!r.ok) { b.disabled = false; return; }
    const id = S.article;
    delete S.full[id];
    leaveRoom();
    await loadStories();
    if (S.current === "article" && S.article === id) renderArticle();
  });
}

// ---------- Comments (Articles) ----------
const CM = { list: [], replyTo: null, armed: null, armedTimer: null };
async function loadComments(id) {
  try { CM.list = (await getJSON(`/api/stories/${encodeURIComponent(id)}/comments`)).comments; }
  catch (e) { if ($("#cmList")) $("#cmList").innerHTML = `<li class="msg" style="border:0">Couldn't load comments.</li>`; return; }
  if (S.article === id) renderComments();
}
function composeHTML(kind) {
  return `<div class="c-compose" data-kind="${kind}">
    ${avatar({ id: S.me.id, name: S.me.name, avatar: S.me.avatarUrl })}
    <div>
      <label class="sr" for="cm-${kind}">${kind === "reply" ? "Reply" : "Comment"}</label>
      <textarea id="cm-${kind}" maxlength="2000" placeholder="${kind === "reply" ? "Write a reply…" : "Add a comment…"}"></textarea>
      <div class="row2"><span id="cmErr-${kind}"></span><button type="button" class="btn primary" disabled>${kind === "reply" ? "Reply" : "Comment"}</button></div>
    </div></div>`;
}
function commentHTML(c, replies) {
  const mine = S.me && c.uid === S.me.id, mod = S.me && S.me.role === "moderator";
  const acts = [];
  if (replies && S.me && !S.me.banned) acts.push(`<button type="button" data-reply="${esc(c.id)}">Reply</button>`);
  if (mine || mod) acts.push(CM.armed === c.id
    ? `<button type="button" class="danger" data-cdel="${esc(c.id)}">${mine ? "Delete" : "Remove"} for good</button>`
    : `<button type="button" data-cdel="${esc(c.id)}">${mine ? "Delete" : "Remove"}</button>`);
  else if (S.me && !S.me.banned) acts.push(reported.has(c.id) ? `<span>Reported</span>`
    : `<button type="button" data-crep="${esc(c.id)}">${CM.armed === "r:" + c.id ? "Report to a moderator?" : "Report"}</button>`);
  return `<div class="cm">
      ${avatar({ id: c.uid, name: c.name, avatar: c.avatar })}
      <div>
        <div class="who"><b>${esc(mine ? "You" : c.name || "Someone")}</b> <span>· ${ago(c.at)}</span></div>
        <p>${esc(c.text)}</p>
        <div class="acts">${acts.join("")}</div>
      </div>
    </div>`;
}
function renderComments() {
  const tops = CM.list.filter(c => !c.parentId);
  const total = CM.list.length;
  $("#cmCount").textContent = `${total} ${total === 1 ? "comment" : "comments"}`;
  $("#cmCompose").innerHTML = !S.me ? `<div class="chat-note" style="padding:14px 0"><a href="#profile">Sign in or create an account</a> to comment.</div>`
    : S.me.banned ? `<div class="chat-note" style="padding:14px 0">Your account can't post right now.</div>` : composeHTML("top");
  $("#cmList").innerHTML = tops.map(c => {
    const replies = CM.list.filter(r => r.parentId === c.id);
    return `<li>${commentHTML(c, true)}
      ${replies.length || CM.replyTo === c.id ? `<ul class="creplies">${replies.map(r => `<li>${commentHTML(r, false)}</li>`).join("")}
        ${CM.replyTo === c.id ? `<li>${composeHTML("reply")}</li>` : ""}</ul>` : ""}</li>`;
  }).join("") || `<li class="msg" style="border:0">No comments yet. Start the conversation.</li>`;
  wireComments();
}
function wireComments() {
  document.querySelectorAll(".c-compose").forEach(box => {
    const ta = box.querySelector("textarea"), btn = box.querySelector(".btn"), kind = box.dataset.kind;
    ta.addEventListener("input", () => { btn.disabled = !ta.value.trim(); });
    btn.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      const r = await fetch(`/api/stories/${encodeURIComponent(S.article)}/comments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, parentId: kind === "reply" ? CM.replyTo : null }),
      }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { $("#cmErr-" + kind).textContent = d.error || "That didn't post. Try again."; btn.disabled = false; return; }
      CM.list.push(d.comment);
      CM.replyTo = null;
      renderComments();
    });
  });
  document.querySelectorAll("[data-reply]").forEach(b => b.addEventListener("click", () => {
    CM.replyTo = CM.replyTo === b.dataset.reply ? null : b.dataset.reply;
    renderComments();
    const ta = $("#cm-reply"); if (ta) ta.focus();
  }));
  document.querySelectorAll("[data-crep]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.crep;
    if (CM.armed !== "r:" + id) {
      CM.armed = "r:" + id; clearTimeout(CM.armedTimer);
      CM.armedTimer = setTimeout(() => { CM.armed = null; renderComments(); }, 4000);
      return renderComments();
    }
    CM.armed = null;
    const err = await sendReport("comment", id);
    if (err) { b.textContent = err; return; }
    reported.add(id);
    renderComments();
  }));
  document.querySelectorAll("[data-cdel]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.cdel;
    if (CM.armed !== id) {
      CM.armed = id; clearTimeout(CM.armedTimer);
      CM.armedTimer = setTimeout(() => { CM.armed = null; renderComments(); }, 4000);
      return renderComments();
    }
    CM.armed = null;
    const r = await fetch(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (r && r.ok) CM.list = CM.list.filter(c => c.id !== id && c.parentId !== id);
    renderComments();
  }));
}

export { articleHTML, fetchStory, renderArticle, refreshArticleInPlace, storyClosed, wireStageTools, loadComments };
