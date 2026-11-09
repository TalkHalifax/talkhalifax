import { $, esc, S, PERSON_SVG, loadingMsg, back, goTo, loadMe } from "../app.js";

/** A reset link a moderator sent: choose a new password, then you're signed in. */
async function renderReset() {
  const v = $("#reset"), token = S.resetToken;
  v.innerHTML = `<div class="profile">${back()}${loadingMsg()}</div>`;
  let who;
  try {
    const r = await fetch("/auth/reset/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "This reset link isn't working. Ask a moderator for a new one.");
    who = d.username;
  } catch (e) {
    if (S.current === "reset") v.innerHTML = `<div class="profile">${back()}<div class="msg">${esc(e.message && !/fetch/i.test(e.message) ? e.message : "Can't reach TalkHalifax. Check your connection and try again.")}</div></div>`;
    return;
  }
  if (S.current !== "reset") return;
  v.innerHTML = `<div class="profile">${back()}
    <div class="profile-card glass"><div class="pic">${PERSON_SVG}</div>
      <div><h1>Choose a new password</h1><p>For <b>${esc(who)}</b>. This link works once.</p></div></div>
    <form class="auth-form glass" id="rsForm" novalidate>
      <input type="text" name="username" autocomplete="username" value="${esc(who)}" hidden>
      <label for="rsPass">New password</label>
      <input id="rsPass" type="password" autocomplete="new-password" minlength="8" maxlength="200" required aria-describedby="rsHint">
      <small id="rsHint">At least 8 characters. Anywhere else this account is signed in will be signed out.</small>
      <div class="auth-err" id="rsErr" role="alert" hidden></div>
      <button type="submit" class="btn primary" id="rsGo">Save and sign in</button>
    </form>
  </div>`;
  $("#rsForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#rsErr"), go = $("#rsGo");
    go.disabled = true; err.hidden = true;
    const r = await fetch("/auth/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: $("#rsPass").value }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { err.textContent = d.error || "Can't reach TalkHalifax. Check your connection and try again."; err.hidden = false; go.disabled = false; return; }
    await loadMe();
    goTo("profile");
  });
}

export { renderReset };
