import { $, esc, shortDate, ago, S, tms, loadingMsg } from "../app.js";

/** Articles: settled stories with threaded comments. */
function renderArticles() {
  document.querySelectorAll("[data-sort]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sort === S.sort));
  if (!S.stories) { $("#artCards").innerHTML = loadingMsg(); return; }
  const t = tms;
  const key = {
    active: x => -Math.max(x.comments.lastAt || 0, t(x.archivedAt)),
    new: x => -t(x.publishedAt),
    top: x => -x.comments.count,
  }[S.sort];
  const arts = S.stories.filter(x => x.kind === "article" && x.stage === "archived").sort((a, b) => key(a) - key(b));
  $("#artCards").innerHTML = arts.map(x => {
    const c = x.comments;
    return `<button type="button" class="card glass archived" data-article="${esc(x.id)}">
      <span class="k">${esc(x.area || x.section || "Halifax")}</span>
      <span class="tt">${esc(x.headline)}</span>
      ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
      <span class="ft"><span>${c.lastAt ? "Last comment " + ago(c.lastAt) : shortDate(x.publishedAt)}</span><span class="pill${c.count ? "" : " zero"}">${c.count} ${c.count === 1 ? "comment" : "comments"}</span></span></button>`;
  }).join("") || '<div class="msg">No articles yet. Developing stories move here once they settle.</div>';
}

export { renderArticles };
