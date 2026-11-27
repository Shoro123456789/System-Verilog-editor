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
$("#updateGo").onclick = () => installUpdate(UP.info);

// ---------------------------------------------------------------- update window
const STEPS = ["check", "download", "install", "restart"];
function updSteps(phase, failed) {
  const idx = STEPS.indexOf(phase);
  document.querySelectorAll("#updSteps li").forEach((li, i) => {
    li.className = i < idx ? "ok" : i === idx ? (failed ? "err" : "active") : "";
  });
}
function updProgress(frac) {
  const f = $("#updFill");
  if (frac === null || frac === undefined) { f.classList.add("indet"); return; }
  f.classList.remove("indet");
  f.style.width = Math.max(2, Math.min(100, frac * 100)).toFixed(1) + "%";
}
// overall bar: check 0–5 %, download 5–75 %, install 75–95 %, restart 95–100 %
const PHASE_SPAN = { check: [0, 5], download: [5, 75], install: [75, 95], restart: [95, 100] };
function showUpdateWindow(info) {
  const card = document.querySelector(".upd-card");
  card.classList.remove("done", "failed");
  $("#restartTitle").textContent = "Updating SV Studio";
  const cur = info && info.current ? info.current.slice(0, 7) : null, lat = info && info.latest ? info.latest.slice(0, 7) : null;
  $("#updVersions").textContent = cur && lat ? `Version ${cur} → ${lat}` : "Getting the latest version from GitHub";
  const commits = (info && info.commits) || [];
  $("#updNews").hidden = !commits.length;
  $("#updNews").innerHTML = commits.length ? `<b>What's new</b><ul>${commits.slice().reverse().map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : "";
  $("#updActions").hidden = true; $("#updNote").hidden = false;
  $("#restartSub").textContent = "Starting…";
  updSteps("check"); updProgress(0.01);
  $("#restartOverlay").hidden = false;
}
function updateFailed(msg) {
  const card = document.querySelector(".upd-card");
  card.classList.add("failed");
  $("#restartTitle").textContent = "The update didn't finish";
  $("#restartSub").textContent = msg;
  $("#restartSub").title = msg;
  $("#updNote").hidden = true;
  $("#updActions").hidden = false;
  const cur = document.querySelector("#updSteps li.active"); if (cur) cur.className = "err";
}
$("#updSkip").onclick = () => { $("#restartOverlay").hidden = true; toast("Still on the current version — you can update later from the command palette (Update SV Studio now)", ""); };
$("#updRetry").onclick = () => installUpdate(UP.info);

async function saveBeforeUpdate() {
  for (const f of (window.SVS_BEFORE_UPDATE || [])) { try { f(); } catch (e) {} }
  if (S.tabs && S.tabs.some(t => t.dirty) && typeof saveAll === "function") { try { await saveAll(); } catch (e) {} }
  LS.flush(false);
  await new Promise(r => setTimeout(r, 250));
}

async function installUpdate(info) {
  info = info || UP.info;
  showUpdateWindow(info);
  $("#updateBar").hidden = true;
  await saveBeforeUpdate();
  let id;
  try { id = (await api("/api/update/apply", {})).id; }
  catch (e) { updateFailed(e.message); return; }
  const oldToken = window.SVS_TOKEN;
  let since = 0, done = null, upToDate = false, lastMsg = "";
  while (!done) {
    await new Promise(r => setTimeout(r, 250));
    let r;
    try { r = await api(`/api/job?id=${id}&since=${since}`); }
    catch (e) { break; }   // server already restarting
    since = r.next;
    if (r.lines.some(l => /Already up to date/.test(l.t))) upToDate = true;
    const msg = r.lines.filter(l => l.c !== "done-ok" && l.c !== "done-err" && !/^SV Studio · updating/.test(l.t)).pop();
    if (msg) lastMsg = msg.t;
    const p = r.progress;
    if (p) {
      updSteps(p.phase);
      const [a, b] = PHASE_SPAN[p.phase] || [0, 100];
      updProgress(p.frac === null || p.frac === undefined ? (p.phase === "check" ? null : (a + (b - a) * 0.5) / 100) : (a + (b - a) * p.frac) / 100);
      $("#restartSub").textContent = p.detail || lastMsg;
    }
    if (r.done) done = r;
  }
  if (done && !done.ok) { updateFailed(lastMsg.replace(/^Update failed:\s*/, "") || "See the Console tab for details."); return; }
  if (done && upToDate) {
    updSteps("restart"); document.querySelectorAll("#updSteps li").forEach(li => li.className = "ok");
    $("#restartOverlay").hidden = true; toast("SV Studio is already up to date", "ok"); return;
  }
  updSteps("restart"); updProgress(0.97);
  $("#restartTitle").textContent = "Restarting SV Studio";
  $("#restartSub").textContent = "Starting the new version — this window will refresh by itself.";
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const t = await (await fetch("/", { cache: "no-store" })).text();
      const m = t.match(/SVS_TOKEN = "([0-9a-f]+)"/);
      if (m && m[1] !== oldToken) {
        document.querySelectorAll("#updSteps li").forEach(li => li.className = "ok");
        updProgress(1); document.querySelector(".upd-card").classList.add("done");
        $("#restartTitle").textContent = "Updated"; $("#restartSub").textContent = "Reopening…";
        LS.set("ui.justUpdated", (UP.info && UP.info.latest) || "yes"); LS.flush(false);
        setTimeout(() => location.reload(), 350);
        return;
      }
    } catch (e) { /* new version not up yet */ }
  }
  document.querySelector(".upd-card").classList.add("done");
  $("#restartTitle").textContent = "SV Studio was updated";
  $("#restartSub").textContent = "Close this window and start SV Studio again.";
}

// after a restart, say what happened
(() => {
  const just = LS.get("ui.justUpdated", null);
  if (just) { LS.set("ui.justUpdated", null); setTimeout(() => toast(`SV Studio updated${just.length > 6 ? " to " + just.slice(0, 7) : ""} — you're on the latest version`, "ok"), 600); }
})();

// on start-up: "Install automatically" shows the update window and installs; "Ask me first" shows the bar
async function startupUpdateCheck() {
  try {
    const r = await api("/api/update/startup");
    if (r.skip) return;
    UP.info = r;
    if (!r.available || r.error) return;
    if (r.mode === "auto") installUpdate(r);
    else checkForUpdate(false);
  } catch (e) { /* offline: try again later */ }
}

COMMANDS.push(["Check for updates", "", () => checkForUpdate(true), "⟳"]);
COMMANDS.push(["Update SV Studio now", "", async () => { try { UP.info = await api("/api/update/check?force=1"); } catch (e) {} installUpdate(UP.info); }, "⟳"]);
setTimeout(startupUpdateCheck, 800);
setInterval(() => checkForUpdate(false), 6 * 3600 * 1000);
