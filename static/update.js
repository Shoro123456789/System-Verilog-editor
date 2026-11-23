/* SV Studio – self-update from GitHub */
"use strict";

const UP = { info: null };

async function checkForUpdate(force) {
  try {
    const r = await api("/api/update/check" + (force ? "?force=1" : ""));
    UP.info = r;
    if (force && r.error) { toast(r.error, "err"); return; }
    if (r.available) {
      if (!force && LS.get("updateSnooze", "") === r.latest) return;
      const n = r.commits.length;
      $("#updateText").textContent = `An update for SV Studio is available${n ? ` (${n} change${n > 1 ? "s" : ""})` : ""}.`;
      $("#updateList").innerHTML = `<b>What's new</b><ul>${(r.commits.length ? r.commits : ["Latest changes from GitHub"]).slice().reverse().map(c => `<li>${esc(c)}</li>`).join("")}</ul>`;
      $("#updateBar").hidden = false;
    } else if (force) {
      toast("SV Studio is up to date" + (r.current ? ` (${r.current.slice(0, 7)})` : ""), "ok");
    }
  } catch (e) { if (force) toast("Couldn't check for updates: " + e.message, "err"); }
}

$("#updateWhat").onclick = () => { $("#updateList").hidden = !$("#updateList").hidden; };
$("#updateClose").onclick = () => { $("#updateBar").hidden = true; if (UP.info) LS.set("updateSnooze", UP.info.latest); };
$("#updateGo").onclick = () => installUpdate();

async function installUpdate() {
  if (S.tabs && S.tabs.some(t => t.dirty)) await saveAll();
  let id;
  try { id = (await api("/api/update/apply", {})).id; } catch (e) { toast(e.message, "err"); return; }
  $("#updateBar").hidden = true;
  $("#restartOverlay").hidden = false;
  const oldToken = window.SVS_TOKEN;
  let since = 0, done = null, upToDate = false;
  while (!done) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const r = await api(`/api/job?id=${id}&since=${since}`);
      since = r.next;
      if (r.lines.some(l => /Already up to date/.test(l.t))) upToDate = true;
      const msg = r.lines.filter(l => l.c !== "done-ok" && l.c !== "done-err").pop();
      if (msg) $("#restartSub").textContent = msg.t;
      if (r.done) done = r;
    } catch (e) { break; }   // server already restarting
  }
  if (done && !done.ok) {
    $("#restartOverlay").hidden = true;
    toast("Update failed — " + ($("#restartSub").textContent || "see console"), "err");
    return;
  }
  if (done && upToDate) { $("#restartOverlay").hidden = true; toast("Already up to date", "ok"); return; }
  $("#restartTitle").textContent = "Restarting SV Studio…";
  $("#restartSub").textContent = "Starting the new version.";
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const t = await (await fetch("/", { cache: "no-store" })).text();
      const m = t.match(/SVS_TOKEN = "([0-9a-f]+)"/);
      if (m && m[1] !== oldToken) { location.reload(); return; }
    } catch (e) { /* not up yet */ }
  }
  $("#restartTitle").textContent = "SV Studio was updated";
  $("#restartSub").textContent = "Close this window and start SV Studio again.";
}

COMMANDS.push(["Check for updates", "", () => checkForUpdate(true), "⟳"]);
COMMANDS.push(["Update SV Studio now", "", () => installUpdate(), "⟳"]);
setTimeout(() => checkForUpdate(false), 3000);
setInterval(() => checkForUpdate(false), 6 * 3600 * 1000);
