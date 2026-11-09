import { $, esc, ago, S, PERSON_SVG, hue, avatar, chatHidden, setChatHidden, back, openAlerts, loadMe } from "../app.js";
import { getJSON } from "../api.js";
import { loadReview, loadReports } from "./moderation.js";

// ---------- Profile ----------
let authMode = "login";
// Turnstile (Cloudflare's bot check) on sign-up, loaded only when someone opens the sign-up form
let tsReady = null, tsToken = "", tsWidget = null;
function loadTurnstile() {
  if (!tsReady) tsReady = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    sc.async = true; sc.onload = res; sc.onerror = () => { tsReady = null; rej(); };
    document.head.appendChild(sc);
  });
  return tsReady;
}
function resetTurnstile() { tsToken = ""; if (tsWidget != null && window.turnstile) window.turnstile.reset(tsWidget); }

async function renderProfile() {
  const v = $("#profile");
  const backBtn = back();
  if (!S.me) {
    const p = S.providers;
    const creating = authMode === "signup";
    v.innerHTML = `<div class="profile">${backBtn}
      <div class="profile-card glass"><div class="pic">${PERSON_SVG}</div>
        <div><h1>${creating ? "Join TalkHalifax" : "Welcome back"}</h1><p>${creating ? "Pick a username to chat about the city's news. No email needed." : "Sign in to join the live chats."}</p></div></div>
      <div class="auth-tabs" role="tablist" aria-label="Sign in or create an account">
        <button type="button" role="tab" class="sort" data-mode="login" aria-pressed="${!creating}" aria-selected="${!creating}">Sign in</button>
        <button type="button" role="tab" class="sort" data-mode="signup" aria-pressed="${creating}" aria-selected="${creating}">Create account</button>
      </div>
      <form class="auth-form glass" id="authForm" novalidate>
        <label for="authUser">Username</label>
        <input id="authUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required
          ${creating ? 'pattern="[A-Za-z0-9_.\\-]{3,20}" aria-describedby="userHint"' : ""}>
        ${creating ? '<small id="userHint">3 to 20 characters: letters, numbers, dots, dashes or underscores. Shown next to your messages.</small>' : ""}
        <label for="authPass">Password</label>
        <input id="authPass" name="password" type="password" autocomplete="${creating ? "new-password" : "current-password"}" minlength="${creating ? 8 : 1}" maxlength="200" required ${creating ? 'aria-describedby="passHint"' : ""}>
        ${creating ? '<small id="passHint">At least 8 characters. There\'s no email reset: if you\'re locked out, a moderator can send you a reset link.</small>' : ""}
        ${creating && p.turnstile ? '<div class="ts-box" id="tsBox"></div>' : ""}
        <div class="auth-err" id="authErr" role="alert" hidden></div>
        <button type="submit" class="btn primary" id="authGo">${creating ? "Create account" : "Sign in"}</button>
      </form>
      ${p.google || p.dev ? `<div class="signin">
        ${p.google ? `<a class="btn ghost" href="/auth/google?return=${encodeURIComponent("/#profile")}">Continue with Google</a>` : ""}
        ${p.dev ? `<form class="dev" id="devForm"><label class="sr" for="devName">Name</label><input id="devName" placeholder="Your name (local dev)" maxlength="40" required><button class="btn ghost" type="submit">Dev sign-in</button></form>` : ""}
      </div>` : ""}
      <h2 class="p-h" id="alertsH">Alerts on this device</h2>
      <div id="pAlerts"><p class="msg" style="border:0">Loading…</p></div>
      <p class="p-note">How TalkHalifax handles your account and messages: <a href="#privacy">Privacy</a>.</p>
    </div>`;
    openAlerts();
    if (creating && p.turnstile) loadTurnstile().then(() => {
      if (!$("#tsBox")) return;
      tsToken = "";
      tsWidget = window.turnstile.render("#tsBox", { sitekey: p.turnstile, theme: "auto", size: "flexible",
        callback: t => { tsToken = t; }, "expired-callback": () => { tsToken = ""; }, "error-callback": () => { tsToken = ""; } });
    }).catch(() => { const e = $("#authErr"); if (e) { e.textContent = "The bot check didn't load. Check your connection and reload."; e.hidden = false; } });
    v.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { authMode = b.dataset.mode; renderProfile(); $("#authUser").focus(); }));
    $("#authForm").addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("#authErr"), go = $("#authGo");
      const username = $("#authUser").value.trim(), password = $("#authPass").value;
      const fail = t => { err.textContent = t; err.hidden = false; go.disabled = false; };
      if (!username || !password) return fail("Enter a username and password.");
      if (creating && p.turnstile && !tsToken) return fail("Finish the check above the button first.");
      go.disabled = true; err.hidden = true;
      try {
        const r = await fetch(creating ? "/auth/signup" : "/auth/login", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, turnstile: creating ? tsToken : undefined }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (creating) resetTurnstile(); return fail(d.error || "That didn't work. Try again."); }
        await loadMe();
        if (S.current === "profile") renderProfile();
      } catch (x) { fail("Can't reach TalkHalifax. Check your connection and try again."); }
    });
    const f = $("#devForm");
    if (f) f.addEventListener("submit", e => { e.preventDefault(); location.href = `/auth/dev?name=${encodeURIComponent($("#devName").value)}&return=${encodeURIComponent("/#profile")}`; });
    return;
  }
  v.innerHTML = `<div class="profile">${backBtn}
    <div class="profile-card glass">
      <div class="pic">${S.me.avatarUrl ? `<img alt="" src="${esc(S.me.avatarUrl)}" referrerpolicy="no-referrer">` : avatar({ id: S.me.id, name: S.me.name }, "av").replace('class="av"', 'class="av" style="width:100%;height:100%;font-size:32px;background:' + hue(S.me.id) + '"')}</div>
      <div><h1 id="pName"></h1><p>Halifax${S.me.role === "moderator" ? '<span class="role">Moderator</span>' : ""}</p></div>
    </div>
    <div class="stats" id="pStats">
      <div class="stat glass"><b>–</b><span>messages sent</span></div>
      <div class="stat glass"><b>–</b><span>chats joined</span></div>
      <div class="stat glass"><b>–</b><span>in the last 24 hours</span></div>
    </div>
    ${S.me.role === "moderator" ? `<h2 class="p-h">Reports</h2><div id="pReports"><p class="msg" style="border:0">Loading…</p></div>` : ""}
    ${S.me.role === "moderator" ? `<h2 class="p-h">Drafts waiting for review</h2><div id="pReview"><p class="msg" style="border:0">Loading…</p></div>` : ""}
    <h2 class="p-h">Your recent messages</h2>
    <ul class="activity" id="pActivity"><li class="msg" style="border:0">Loading…</li></ul>
    <h2 class="p-h">Settings</h2>
    <div class="setting"><span>Show the live chat when I open an article<small>On a phone it always starts tucked away at the bottom.</small></span>
      <button type="button" class="switch" id="chatPref" role="switch" aria-checked="${!chatHidden}" aria-label="Show the live chat when I open an article"></button></div>
    <h2 class="p-h" id="alertsH">Alerts on this device</h2>
    <div id="pAlerts"><p class="msg" style="border:0">Loading…</p></div>
    ${S.me.password ? `<details class="setting-more"><summary>Change password</summary>
      <form class="auth-form glass" id="pwForm" novalidate>
        <input type="text" name="username" autocomplete="username" value="${esc(S.me.name || "")}" hidden>
        <label for="pwCur">Current password</label>
        <input id="pwCur" type="password" autocomplete="current-password" maxlength="200" required>
        <label for="pwNew">New password</label>
        <input id="pwNew" type="password" autocomplete="new-password" minlength="8" maxlength="200" required aria-describedby="pwHint">
        <small id="pwHint">At least 8 characters. You stay signed in here; anywhere else is signed out.</small>
        <div class="auth-err" id="pwErr" role="alert" hidden></div>
        <button type="submit" class="btn primary" id="pwGo">Change password</button>
      </form></details>` : ""}
    <button type="button" class="btn ghost signout" id="signOut">Sign out</button>
    <button type="button" class="btn ghost del-acct" id="delAcct">Delete my account</button>
    <p class="p-note">TalkHalifax keeps your ${S.me.password ? "username, a scrambled (hashed) copy of your password" : "name, email and photo from Google"}, and what you post. <a href="#privacy">Privacy</a></p>
  </div>`;
  $("#pName").textContent = S.me.name || "You";
  openAlerts();
  $("#chatPref").addEventListener("click", e => { setChatHidden(!chatHidden); e.currentTarget.setAttribute("aria-checked", String(!chatHidden)); });
  $("#signOut").addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/"; });
  let delArmed = false;
  $("#delAcct").addEventListener("click", async e => {
    const b = e.currentTarget;
    if (!delArmed) { delArmed = true; b.classList.add("danger-btn"); b.textContent = "Delete for good? Your messages and comments are erased too."; return; }
    b.disabled = true;
    const r = await fetch("/api/me", { method: "DELETE" }).catch(() => null);
    if (r && r.ok) { location.href = "/"; return; }
    b.disabled = false; b.textContent = "That didn't work. Tap to try again.";
  });
  const pw = $("#pwForm");
  if (pw) pw.addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#pwErr"), go = $("#pwGo");
    go.disabled = true; err.hidden = true;
    const r = await fetch("/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: $("#pwCur").value, password: $("#pwNew").value }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    go.disabled = false;
    if (!r || !r.ok) { err.textContent = d.error || "Can't reach TalkHalifax. Check your connection and try again."; err.hidden = false; return; }
    pw.reset(); err.textContent = "Password changed."; err.classList.add("ok"); err.hidden = false;
  });
  if (S.me.role === "moderator") { loadReports(); loadReview(); }
  try {
    const d = await getJSON("/api/me/messages");
    if (S.current !== "profile") return;
    const st = d.stats || {};
    $("#pStats").innerHTML = [[st.messages, (st.messages === 1 ? "message" : "messages") + " sent"], [st.rooms, (st.rooms === 1 ? "chat" : "chats") + " joined"], [st.today || 0, "in the last 24 hours"]]
      .map(([n, l]) => `<div class="stat glass"><b>${n || 0}</b><span>${l}</span></div>`).join("");
    $("#pActivity").innerHTML = d.messages.slice(0, 15).map(m => `<li><button type="button" data-article="${esc(m.storyId)}">
        <span class="q">${esc(m.text)}</span><span class="r">${ago(m.at)}</span>
        <span class="w">in ${esc(m.headline || "an article that's no longer listed")}</span></button></li>`).join("")
      || `<li class="msg" style="border:0">You haven't said anything yet. Open a discussion on the home page to join its live chat.</li>`;
  } catch (e) { $("#pActivity").innerHTML = `<li class="msg" style="border:0">Couldn't load your messages.</li>`; }
}

export { renderProfile };
