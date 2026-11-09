import { $, esc, hm, S, reported, avatar } from "./app.js";
import { sendReport } from "./api.js";
import { refreshArticleInPlace, storyClosed } from "./views/article.js";

const room = { ws: null, id: null, messages: [], profiles: {}, here: [], readers: 0, you: null, error: "", typing: false, armed: null, armedTimer: null, tries: 0, closing: false };

const nameOf = uid => uid === (S.me && S.me.id) ? "You" : (room.profiles[uid] && room.profiles[uid].name) || "Someone";

function renderComposer() {
  const slot = $("#composerSlot");
  if (!slot) return;
  if (!S.me) {
    slot.innerHTML = `<div class="chat-note"><a href="#profile">Sign in or create an account</a> to join the chat.</div>`;
  } else if (S.me.banned) {
    slot.innerHTML = `<div class="chat-note">Your account can't post right now.</div>`;
  } else if (!$("#chatInput")) {
    slot.innerHTML = `<div class="composer">
        <label class="sr" for="chatInput">Message</label>
        <textarea id="chatInput" rows="1" maxlength="1000" placeholder="Say something about this…"></textarea>
        <button type="button" class="send" id="chatSend" aria-label="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>`;
    wireComposer();
  }
}

function wireComposer() {
  const ta = $("#chatInput"), send = $("#chatSend");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
  const setTyping = on => { if (room.typing === on) return; room.typing = on; sendRoom({ t: "typing", on }); };
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    if (!sendRoom({ t: "send", text })) { showChatError("Not connected yet. Your message is still here; try again in a moment."); return; }
    ta.value = ""; grow(); send.disabled = true; setTyping(false);
  };
  ta.addEventListener("input", () => { grow(); send.disabled = !ta.value.trim(); setTyping(!!ta.value.trim()); });
  ta.addEventListener("blur", () => setTyping(false));
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  send.addEventListener("click", submit);
}

// ---------- Room connection ----------
function sendRoom(obj) {
  if (!room.ws || room.ws.readyState !== WebSocket.OPEN) return false;
  room.ws.send(JSON.stringify(obj));
  return true;
}
function leaveRoom() {
  if (room.ws) { room.closing = true; try { room.ws.close(); } catch (e) {} }
  Object.assign(room, { ws: null, id: null, messages: [], profiles: {}, here: [], readers: 0, you: null, error: "", typing: false, tries: 0 });
}
function connectRoom(id) {
  if (room.id === id && room.ws && room.ws.readyState <= 1) { renderChat(true); return; }
  leaveRoom();
  room.id = id; room.closing = false;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rooms/${encodeURIComponent(id)}/ws`);
  room.ws = ws;
  ws.addEventListener("message", e => {
    if (room.ws !== ws) return;
    let d; try { d = JSON.parse(e.data); } catch (x) { return; }
    if (d.t === "hello") {
      room.tries = 0; room.you = d.you; room.messages = d.messages; Object.assign(room.profiles, d.profiles);
      room.error = ""; renderChat(true);
    } else if (d.t === "msg") {
      if (d.profile) room.profiles[d.m.uid] = d.profile;
      room.messages.push(d.m); renderChat(d.m.uid === (S.me && S.me.id));
    } else if (d.t === "del") {
      room.messages = room.messages.filter(m => m.id !== d.id); renderChat();
    } else if (d.t === "here") {
      room.here = d.here; room.readers = d.readers; Object.assign(room.profiles, d.profiles); renderHere();
    } else if (d.t === "error") {
      showChatError(d.text);
      // A message the screening turned away goes back in the box, so it can be reworded
      const i = $("#chatInput");
      if (d.rejected && i && !i.value.trim()) { i.value = d.rejected; $("#chatSend").disabled = false; }
    } else if (d.t === "article") {
      refreshArticleInPlace(id);
    } else if (d.t === "closed") {
      storyClosed(id);
    }
  });
  ws.addEventListener("close", () => {
    if (room.ws !== ws || room.closing) return;
    // Offline: wait for the connection to come back (the "online" listener reconnects)
    if (!navigator.onLine) { showChatError("You're offline. Chat reconnects when you're back online."); return; }
    // Reconnect with backoff while the person is still in this room
    const wait = Math.min(15000, 1000 * 2 ** room.tries++);
    showChatError("Reconnecting…");
    setTimeout(() => { if (S.current === "article" && S.article === id && room.ws === ws) { room.id = null; connectRoom(id); } }, wait);
  });
}
function showChatError(t) {
  room.error = t;
  const e = $("#chatErr");
  if (e) { e.hidden = !t; e.textContent = t; }
  if (t && t !== "Reconnecting…" && navigator.onLine) setTimeout(() => { if (room.error === t) showChatError(""); }, 6000);
}

function renderChat(toBottom) {
  const box = $("#msgs");
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const myId = S.me && S.me.id, mod = S.me && S.me.role === "moderator";
  const groups = [];
  room.messages.forEach(m => {
    const g = groups[groups.length - 1];
    if (g && g.uid === m.uid && m.at - g.items[g.items.length - 1].at < 5 * 60000) g.items.push(m);
    else groups.push({ uid: m.uid, items: [m] });
  });
  box.innerHTML = room.messages.length ? groups.map(g => {
    // The newsroom's own notes ("Article updated: …") sit apart from people's messages
    if (g.uid === "newsroom") return `<div class="grp sys"><div class="meta"><b>Newsroom</b> · ${esc(hm(g.items[0].at))}</div>
      ${g.items.map(m => `<div class="bubble-row"><div class="bubble">${esc(m.text)}</div>${mod ? `<button type="button" class="x${room.armed === m.id ? " armed" : ""}" data-del="${esc(m.id)}" aria-label="Remove note">${room.armed === m.id ? "Remove?" : "×"}</button>` : ""}</div>`).join("")}</div>`;
    const mine = g.uid === myId;
    return `<div class="grp${mine ? " mine" : ""}">
      ${avatar(room.profiles[g.uid] || { id: g.uid, name: "" })}
      <div class="meta"><b>${esc(nameOf(g.uid))}</b> ${mine ? "You · " : "· "}${esc(hm(g.items[0].at))}</div>
      ${g.items.map(m => `<div class="bubble-row"><div class="bubble">${esc(m.text)}</div>${mine || mod
        ? `<button type="button" class="x${room.armed === m.id ? " armed" : ""}" data-del="${esc(m.id)}" aria-label="${mine ? "Delete" : "Remove"} message">${room.armed === m.id ? (mine ? "Delete?" : "Remove?") : "×"}</button>` : reportBtn(m)}</div>`).join("")}
    </div>`;
  }).join("") : `<div class="chat-empty">No messages yet.<br>Start the conversation about this article.</div>`;
  box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.del;
    if (room.armed !== id) {
      room.armed = id; clearTimeout(room.armedTimer);
      room.armedTimer = setTimeout(() => { room.armed = null; renderChat(); }, 4000);
      return renderChat();
    }
    room.armed = null; sendRoom({ t: "del", id });
  }));
  box.querySelectorAll("[data-rep]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.rep;
    if (room.armed !== "r:" + id) {
      room.armed = "r:" + id; clearTimeout(room.armedTimer);
      room.armedTimer = setTimeout(() => { room.armed = null; renderChat(); }, 4000);
      return renderChat();
    }
    room.armed = null;
    const err = await sendReport("message", id);
    if (err) showChatError(err); else reported.add(id);
    renderChat();
  }));
  if (toBottom || near) box.scrollTop = box.scrollHeight;
  renderHere();
  const e = $("#chatErr"); if (e) { e.hidden = !room.error; e.textContent = room.error; }
}

// Signed-in readers can flag someone else's message for a moderator
function reportBtn(m) {
  if (!S.me || S.me.banned) return "";
  if (reported.has(m.id)) return `<span class="x armed rep-done">Reported</span>`;
  const armed = room.armed === "r:" + m.id;
  return `<button type="button" class="x${armed ? " armed" : ""}" data-rep="${esc(m.id)}" aria-label="Report this message to a moderator">${armed ? "Report?" : "⚑"}</button>`;
}

function renderHere() {
  const here = $("#here"), typing = $("#typing");
  if (!here) return;
  const people = room.here;
  here.innerHTML = people.length
    ? `<span class="stack">${people.slice(0, 4).map(p => avatar(room.profiles[p.id] || { id: p.id, name: "" })).join("")}</span><span>${people.length} here</span>`
    : `<span>${room.messages.length} ${room.messages.length === 1 ? "message" : "messages"}</span>`;
  const rn = $("#reopenN"); if (rn) rn.textContent = people.length ? `${people.length} here` : String(room.messages.length);
  const typers = people.filter(p => p.typing && p.id !== (S.me && S.me.id)).map(p => nameOf(p.id));
  typing.textContent = !typers.length ? "" : typers.length === 1 ? `${typers[0]} is typing…`
    : typers.length === 2 ? `${typers[0]} and ${typers[1]} are typing…` : "Several people are typing…";
}

export { room, renderComposer, leaveRoom, connectRoom, showChatError };
