async function getJSON(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}

/** Flag a chat message or comment. Returns an error to show, or "" when it went through. */
async function sendReport(kind, id) {
  const r = await fetch("/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id }) }).catch(() => null);
  if (r && r.ok) return "";
  const d = r ? await r.json().catch(() => ({})) : {};
  return d.error || "That report didn't go through. Try again.";
}

export { getJSON, sendReport };
