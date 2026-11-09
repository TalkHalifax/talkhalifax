import { $, esc, ago, S, loadStories } from "../app.js";
import { getJSON } from "../api.js";

// ---------- Review queue (moderators) ----------
// Drafts the newsroom held back with review: true. Approving publishes under Developing; discarding hides it for good.
const RV = { armed: null };
async function loadReview() {
  const box = $("#pReview");
  if (!box) return;
  let drafts;
  try { drafts = (await getJSON("/api/review")).drafts; } catch (e) { box.innerHTML = `<p class="msg" style="border:0">Couldn't load drafts.</p>`; return; }
  if (S.current !== "profile") return;
  box.innerHTML = drafts.length ? drafts.map(d => `<details class="draft glass">
      <summary><span class="k">${esc(d.kind)} · ${esc(d.area || "Halifax")}${d.author ? " · by " + esc(d.author) : ""} · ${ago(d.updatedAt)}</span><b>${esc(d.headline)}</b></summary>
      ${d.dek ? `<p class="dek-s">${esc(d.dek)}</p>` : ""}
      ${(d.actions || []).length ? `<p><b>What to do</b></p><ul>${d.actions.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${d.facts.length ? `<dl class="facts">${d.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join("")}</dl>` : ""}
      ${d.body.map(p => p.startsWith("## ") ? `<p><b>${esc(p.slice(3))}</b></p>` : `<p>${esc(p)}</p>`).join("")}
      ${d.means.length ? `<ul>${d.means.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      <p class="src-s">Source: <a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.source)}</a></p>
      <div class="review-acts">
        <button type="button" class="btn primary" data-review="approve" data-id="${esc(d.id)}">Approve and publish</button>
        <button type="button" class="btn ghost" data-review="discard" data-id="${esc(d.id)}">${RV.armed === d.id ? "Discard for good" : "Discard"}</button>
      </div>
    </details>`).join("") : `<p class="msg" style="border:0">Nothing waiting. Sensitive stories the newsroom holds back show up here.</p>`;
  box.querySelectorAll("[data-review]").forEach(b => b.addEventListener("click", async () => {
    const { review: action, id } = b.dataset;
    if (action === "discard" && RV.armed !== id) { RV.armed = id; return loadReview(); }
    RV.armed = null;
    b.disabled = true;
    await fetch(`/api/stories/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    loadReview(); loadStories();
  }));
}

// ---------- Reports (moderators) ----------
// Messages and comments readers flagged. Removing takes it down everywhere; banning is on the writer's profile.
async function loadReports() {
  const box = $("#pReports");
  if (!box) return;
  let list;
  try { list = (await getJSON("/api/reports")).reports; } catch (e) { box.innerHTML = `<p class="msg" style="border:0">Couldn't load reports.</p>`; return; }
  if (S.current !== "profile") return;
  box.innerHTML = list.length ? list.map(r => `<div class="report glass">
      <span class="k">${r.kind === "message" ? "Chat message" : "Comment"} · ${r.reports} ${r.reports === 1 ? "report" : "reports"} · ${ago(r.at)}</span>
      <p class="rq">${esc(r.text)}</p>
      <p class="rw">By <button type="button" class="by-link" data-user="${esc(r.authorId)}">${esc(r.author || "someone")}</button>${r.banned ? " (banned)" : ""}
        in <button type="button" class="by-link" data-article="${esc(r.storyId)}">${esc(r.headline || "a story")}</button></p>
      <div class="review-acts">
        <button type="button" class="btn primary" data-rp="remove" data-id="${esc(r.id)}">Remove it</button>
        <button type="button" class="btn ghost" data-rp="dismiss" data-id="${esc(r.id)}">It's fine</button>
      </div>
    </div>`).join("") : `<p class="msg" style="border:0">No open reports. When readers flag a message or comment, it shows up here.</p>`;
  box.querySelectorAll("[data-rp]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    await fetch(`/api/reports/${encodeURIComponent(b.dataset.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: b.dataset.rp }) }).catch(() => null);
    loadReports();
  }));
}

export { loadReview, loadReports };
