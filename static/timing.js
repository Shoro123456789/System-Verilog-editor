/* SV Studio – FPGA timing (Vivado static timing analysis) */
"use strict";

const TM = { info: null, src: "run" };
const fmt = (v, d = 3) => (v === null || v === undefined || isNaN(v)) ? "—" : (+v).toFixed(d);

function renderTimingTops() {
  const sel = $("#selTimTop"), p = S.project;
  if (!p) { sel.innerHTML = '<option value="">—</option>'; return; }
  const boards = p.board_tops || [];
  const others = p.modules.map(m => m.name).filter(n => !boards.includes(n) && m_hasPorts(n));
  sel.innerHTML = "";
  boards.forEach(n => sel.add(new Option(n, n)));
  if (others.length) {
    const g = document.createElement("optgroup"); g.label = "Other modules (no board pinout)";
    others.forEach(n => g.appendChild(new Option(n, n)));
    sel.appendChild(g);
  }
  const saved = LS.get("timtop." + p.root, null);
  const all = [...boards, ...others];
  sel.value = all.includes(saved) ? saved : (boards.includes($("#selBoardTop").value) ? $("#selBoardTop").value : (boards[0] || all[0] || ""));
}
function m_hasPorts(n) { const m = S.project.modules.find(x => x.name === n); return m && m.has_ports; }
$("#selTimTop").onchange = (e) => { if (S.project) LS.set("timtop." + S.project.root, e.target.value); loadTiming(); };

async function loadTiming() {
  const top = $("#selTimTop").value;
  if (!S.project || !top) return;
  try {
    TM.info = await api("/api/timing/info?top=" + encodeURIComponent(top));
  } catch (e) { return; }
  const v = TM.info.vivado;
  $("#tmVivado").className = "job-chip " + (v ? "ok" : "");
  $("#tmVivado").textContent = v ? "Vivado found" : "Vivado not found";
  $("#tmVivado").title = v || "Install Vivado (ML Standard is free and supports Spartan-7) or set its path in Settings";
  $("#tmRun").disabled = !v;
  const has = { run: !!TM.info.run, lab: !!TM.info.lab };
  if (!has[TM.src]) TM.src = has.run ? "run" : "lab";
  $("#tmSource").hidden = !(has.run && has.lab);
  document.querySelectorAll("#tmSource button").forEach(b => b.classList.toggle("active", b.dataset.src === TM.src));
  renderTiming(TM.info[TM.src]);
}
document.querySelectorAll("#tmSource button").forEach(b => b.onclick = () => { TM.src = b.dataset.src; loadTiming(); });

function verdict(r) {
  if (!r.completed) return { cls: "bad", icon: "✖", title: "The build didn't finish", sub: "Vivado stopped before timing analysis. See the errors below and the console." };
  const wns = r.wns, whs = r.whs;
  if (wns === null || wns === undefined) return { cls: "", icon: "?", title: "No timing numbers found", sub: "" };
  const clk = (r.clocks || []).find(c => c.name === "Clk") || { period: 10, freq: 100 };
  const setupOk = wns >= 0, holdOk = whs === null || whs === undefined || whs >= 0;
  const fmax = 1000 / (clk.period - wns);
  if (setupOk && holdOk) return { cls: "good", icon: "✔", title: "Timing met",
    sub: `${fmt(wns)} ns of spare time on the slowest path at ${fmt(clk.freq, 0)} MHz. The design would still work up to roughly ${fmt(fmax, 0)} MHz.` };
  if (!setupOk) return { cls: "bad", icon: "✖", title: `Setup timing failed by ${fmt(-wns)} ns`,
    sub: `The slowest path needs ${fmt(clk.period - wns, 2)} ns but the clock period is ${fmt(clk.period, 2)} ns, so it would only work reliably up to about ${fmt(fmax, 0)} MHz. Shorten the logic between registers (see the worst paths below).` };
  return { cls: "bad", icon: "✖", title: `Hold timing failed by ${fmt(-whs)} ns`,
    sub: "Data changes too soon after the clock edge. This usually comes from clocks made from logic, or from gated clocks." };
}

function renderTiming(r) {
  const box = $("#tmResult");
  $("#tmEmpty").hidden = !!r;
  box.hidden = !r;
  const badge = $("#timingBadge");
  if (!r) { badge.hidden = true; return; }
  const v = verdict(r);
  badge.hidden = false;
  badge.className = "badge " + (v.cls === "good" ? "ok" : v.cls === "bad" ? "" : "dim");
  badge.textContent = v.cls === "good" ? "met" : v.cls === "bad" ? "fail" : "?";

  const when = new Date(r.when * 1000).toLocaleString();
  const srcLine = r.source === "run"
    ? `Vivado run on this PC · ${when} · ${esc(r.constraints || "")}`
    : `Lab build log <code>${esc(r.log.replace(/\\/g, "/").split("/").slice(-3).join("/"))}</code> · ${esc(r.date || when)}`;
  let html = `<div class="tm-verdict ${v.cls}"><div class="tm-icon">${v.icon}</div><div><h3>${esc(v.title)}</h3><p>${esc(v.sub)}</p></div></div>
    <div class="tm-src muted small">${srcLine} · part ${esc(r.part)}</div>`;

  if (r.completed) {
    const card = (label, val, sub, bad, tip) => `<div class="tm-card ${bad ? "bad" : ""}" title="${esc(tip)}"><span>${label}</span><b>${val}</b><i>${sub || ""}</i></div>`;
    html += `<div class="tm-cards">
      ${card("Setup slack (WNS)", fmt(r.wns) + " ns", "worst path", r.wns < 0, "Worst negative slack: spare time on the slowest register-to-register path. Must be ≥ 0.")}
      ${card("Total setup violation (TNS)", fmt(r.tns) + " ns", r.tns_fail !== undefined ? `${r.tns_fail} of ${r.tns_total} endpoints failing` : "", r.tns < 0, "Sum of all negative setup slacks")}
      ${card("Hold slack (WHS)", fmt(r.whs) + " ns", "fastest path", r.whs < 0, "Worst hold slack: data must not change too soon after the clock edge. Must be ≥ 0.")}
      ${card("Total hold violation (THS)", fmt(r.ths) + " ns", r.ths_fail !== undefined ? `${r.ths_fail} of ${r.ths_total} endpoints failing` : "", r.ths < 0, "Sum of all negative hold slacks")}
      ${r.wpws !== undefined ? card("Pulse width slack", fmt(r.wpws) + " ns", "", r.wpws < 0, "Minimum clock pulse width check") : ""}
    </div>`;
  }
  if (r.checks && r.checks.length) {
    html += `<div class="tm-sec"><h4>Constraint checks</h4><ul class="tm-checks">${r.checks.map(c => `<li>⚠ There are ${esc(c)}.</li>`).join("")}</ul>
      <p class="muted small">Registers with no clock or unconstrained paths aren't checked by timing analysis.</p></div>`;
  }
  if (r.clocks && r.clocks.length) {
    html += `<div class="tm-sec"><h4>Clocks</h4><table class="tm-table"><tr><th>Clock</th><th>Period</th><th>Frequency</th></tr>` +
      r.clocks.map(c => `<tr><td>${esc(c.name)}</td><td>${fmt(c.period)} ns</td><td>${freqText(1000 / c.period)}</td></tr>`).join("") + `</table></div>`;
  }
  if (r.util && Object.keys(r.util).length) {
    const names = { lut: "LUTs", ff: "Flip-flops", bram: "Block RAM", dsp: "DSPs", io: "I/O pins" };
    html += `<div class="tm-sec"><h4>Resources used</h4><div class="tm-util">` + Object.entries(names).filter(([k]) => r.util[k]).map(([k, n]) => {
      const u = r.util[k];
      return `<div><span>${n}</span><div class="bar"><i style="width:${Math.min(100, u.pct || 0)}%"></i></div><b>${u.used}${u.avail ? " / " + u.avail : ""}</b></div>`;
    }).join("") + `</div></div>`;
  }
  if (r.paths && r.paths.length) {
    html += `<div class="tm-sec"><h4>Worst paths</h4><table class="tm-table tm-paths"><tr><th>Check</th><th>Slack</th><th>From</th><th>To</th><th>Logic levels</th><th>Delay</th><th>Clock</th></tr>` +
      r.paths.map((p, i) => `<tr class="${p.slack < 0 ? "bad" : ""}" data-i="${i}">
        <td>${p.kind}</td><td><b>${fmt(p.slack)}</b></td>
        <td><a class="tm-pin" data-end="from">${esc(shortPin(p.from))}</a><i>${esc(p.smod || "")}</i></td>
        <td><a class="tm-pin" data-end="to">${esc(shortPin(p.to))}</a><i>${esc(p.emod || "")}</i></td>
        <td>${p.levels ?? "—"}</td><td>${fmt(p.delay)} ns</td><td>${esc(p.sclk === p.eclk ? p.sclk : p.sclk + " → " + p.eclk)}</td></tr>`).join("") + `</table></div>`;
  }
  // messages: grouped by id, your code first
  const msgs = r.messages || [];
  if (msgs.length) {
    const groups = new Map();
    msgs.forEach(m => { const k = m.sev + "|" + m.id + "|" + (m.user ? 1 : 0); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    const counts = { error: 0, critical: 0, warning: 0 };
    msgs.forEach(m => counts[m.sev]++);
    html += `<div class="tm-sec"><h4>Synthesis &amp; implementation messages <span class="muted">· ${counts.error} errors · ${counts.critical} critical warnings · ${counts.warning} warnings</span></h4><div class="tm-msgs">`;
    let gi = 0;
    for (const [, list] of groups) {
      const m0 = list[0];
      html += `<details class="tm-msg ${m0.sev} ${m0.user ? "user" : ""}" ${m0.user || m0.sev !== "warning" ? "open" : ""}>
        <summary><span class="sev">${m0.sev === "critical" ? "critical" : m0.sev}</span><code>${esc(m0.id)}</code>${m0.user ? '<span class="tag">your code</span>' : ""}
        <span class="txt">${esc(list.length > 1 ? m0.msg.replace(/\S*\[\d+\]/, "…") : m0.msg)}</span>${list.length > 1 ? `<span class="cnt">×${list.length}</span>` : ""}</summary>
        ${m0.hint ? `<div class="hint">💡 ${esc(m0.hint)}</div>` : ""}
        <ul>${list.map((m, j) => `<li>${m.rel ? `<a class="tm-loc" data-g="${gi}" data-j="${j}">${esc(m.rel)}:${m.line}</a> ` : ""}${esc(m.msg)}</li>`).join("")}</ul></details>`;
      gi++;
    }
    html += `</div></div>`;
    TM.groups = [...groups.values()];
    // your-code warnings also go to the Problems panel
    let added = false;
    msgs.filter(m => m.user && m.rel && m.line).forEach(m => { addDiagnostic(m.file, m.line, null, m.sev === "error" ? "error" : "warning", `[Vivado ${m.id}] ${m.msg}`); added = true; });
    if (added) { applyDiagnostics(); renderProblems(); }
  }
  if (r.source === "run") html += `<div class="tm-src muted small">Reports: <code>${esc(r.dir.replace(/\\/g, "/"))}</code></div>`;
  box.innerHTML = html;
  TM.cur = r;
  box.querySelectorAll("a.tm-loc").forEach(a => a.onclick = () => {
    const m = TM.groups[+a.dataset.g][+a.dataset.j];
    openFile(m.file, m.line); showTab("editor");
  });
  box.querySelectorAll("a.tm-pin").forEach(a => a.onclick = () => {
    const p = r.paths[+a.closest("tr").dataset.i];
    openPin(a.dataset.end === "from" ? p.from : p.to, a.dataset.end === "from" ? p.smod : p.emod);
  });
}

function freqText(mhz) {
  if (mhz >= 1) return fmt(mhz, 3) + " MHz";
  if (mhz >= 0.001) return fmt(mhz * 1000, 3) + " kHz";
  return fmt(mhz * 1e6, 3) + " Hz";
}
function shortPin(pin) { return (pin || "").replace(/\/(C|D|Q|CE|R|S|CLR|PRE|I\d?|O|ADDR\w*\[\d+\]|DI\w*\[\d+\])$/, ""); }
function pinSignal(pin) {
  const cell = shortPin(pin).split("/").pop() || "";
  return cell.replace(/_reg(\[\d+\])*(_\d+)?$/, "").replace(/\[\d+\]$/, "").replace(/_i(_\d+)?$/, "");
}
function openPin(pin, mod) {
  const m = S.project.modules.find(x => x.name === mod) || S.project.modules.find(x => x.name === $("#selTimTop").value);
  if (!m) { toast("Can't find the module for " + pin); return; }
  const sig = pinSignal(pin);
  const re = sig ? new RegExp("\\b" + sig.replace(/[^\w]/g, "") + "\\b") : null;
  showTab("editor");
  openFile(m.file, null, re || undefined);
}

async function runTiming() {
  if (!S.project) { showOpenDialog(); return; }
  const top = $("#selTimTop").value;
  if (!top) { toast("Pick the design to analyse", "err"); return; }
  await saveAll();
  try {
    const r = await api("/api/timing/run", { top });
    S.project = r.project; renderProject();
    $("#console").innerHTML = ""; S.errors = S.warnings = 0;
    S.diags = new Map(); applyDiagnostics(); renderProblems();
    S.job = r.id; S.since = 0;
    setRunning(true, "timing");
    $("#jobChip").textContent = "Running Vivado…";
    showTab("console");
    status("Running Vivado (synthesis, place & route, timing)…");
    poll();
  } catch (e) { toast(e.message, "err"); }
}
window.onTimingDone = async (ok) => {
  TM.src = "run";
  await loadTiming();
  if (TM.info && TM.info.run) showTab("timing");
  if (!ok) toast("Vivado run failed — see console", "err");
};

$("#tmRun").onclick = runTiming;
$("#tmReload").onclick = loadTiming;
const _renderProject2 = renderProject;
renderProject = function () { _renderProject2(); renderTimingTops(); loadTiming(); };   // eslint-disable-line no-global-assign
if (S.project) { renderTimingTops(); loadTiming(); }
COMMANDS.push(["Run FPGA timing analysis (Vivado)", "", () => runTiming(), "⏱"]);
COMMANDS.push(["Show Timing", "", () => showTab("timing"), "⏱"]);
