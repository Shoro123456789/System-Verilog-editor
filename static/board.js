/* SV Studio – virtual COMP12111 lab board */
"use strict";

const BD = {
  alive: false, buttons: 0, simple: 0, simpleLatch: 0, polling: false, since: 0, info: null,
  lastSeq: -1, memPrev: [], audio: null, osc: null, gain: null,
};
const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, "0");

/* ---------------------------------------------------------------- 14-segment display */
// bit -> segment, matching the lab's 15-bit Digit encoding (a b c d e f g1 g2 h j k l m n dp)
const SEGS = [
  [10, 6, 38, 6], [42, 10, 42, 44], [42, 54, 42, 88], [10, 92, 38, 92], [6, 54, 6, 88], [6, 10, 6, 44],
  [10, 49, 22, 49], [26, 49, 38, 49], [11, 13, 20, 41], [24, 11, 24, 43], [37, 13, 28, 41],
  [20, 57, 11, 85], [24, 55, 24, 87], [28, 57, 37, 85],
];
function digitSVG(i) {
  const lines = SEGS.map(([x1, y1, x2, y2], b) => `<line class="seg" data-b="${b}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join("");
  return `<div class="digit"><svg viewBox="-2 0 58 100"><g transform="skewX(-6) translate(8 0)">${lines}</g>` +
    `<circle class="dp" data-b="14" cx="50" cy="93" r="3.4"/></svg><span class="dl">Digit${i}</span></div>`;
}

/* ---------------------------------------------------------------- build the board */
function buildBoard() {
  $("#bdDisplays").innerHTML = [5, 4, 3, 2, 1, 0].map(digitSVG).join("");
  // traffic lights: Crossing_B[5:0] = two R/A/G heads, Crossing_A[4:0] = R/A/G head + pedestrian
  const head = (title, bits, cls = "") => `<div class="tl"><div class="tl-head ${cls}">` +
    bits.map(([c, id, lab]) => `<span class="lamp ${c}" id="${id}" data-bit="${lab}"></span>`).join("") +
    `</div><div class="tl-lab">${title}</div></div>`;
  $("#bdTraffic").innerHTML =
    head("Crossing_B[5:3]", [["r", "tlB5", "B5"], ["a", "tlB4", "B4"], ["g", "tlB3", "B3"]]) +
    head("Crossing_B[2:0]", [["r", "tlB2", "B2"], ["a", "tlB1", "B1"], ["g", "tlB0", "B0"]]) +
    head("Crossing_A[2:0]", [["r", "tlA2", "A2"], ["a", "tlA1", "A1"], ["g", "tlA0", "A0"]]) +
    head("Crossing_A[4:3]", [["r", "tlA4", "A4"], ["g", "tlA3", "A3"]], "ped");
  // keypad, laid out as on the board: 1 2 3 F / 4 5 6 E / 7 8 9 D / A 0 B C
  const keys = "123F456E789DA0BC";
  $("#bdKeypad").innerHTML = [...keys].map(k => {
    const v = parseInt(k, 16);
    return `<button class="key ${v > 9 ? "letter" : ""}" data-k="${v}">${k}<small>[${v}]</small></button>`;
  }).join("");
  // switches A..H -> button[23..16]
  $("#bdSwitches").innerHTML = [..."ABCDEFGH"].map((l, i) =>
    `<div class="sw" data-bit="${23 - i}"><div class="sw-body"><div class="sw-knob"></div></div><span>${l}</span><i>[${23 - i}]</i></div>`).join("");
  $("#bdSimple").innerHTML = [3, 2, 1, 0].map(i => `<button class="sbtn" data-s="${i}">[${i}]</button>`).join("");

  document.querySelectorAll("#bdKeypad .key").forEach(el => {
    const bit = +el.dataset.k;
    el.onpointerdown = (e) => {
      el.setPointerCapture(e.pointerId);
      if (e.shiftKey) { toggleButton(bit); return; }
      delete el.dataset.latched;
      setButton(bit, true);
    };
    el.onpointerup = (e) => { if (!e.shiftKey && !el.dataset.latched) setButton(bit, false); };
  });
  document.querySelectorAll("#bdSwitches .sw").forEach(el => {
    el.onclick = () => toggleButton(+el.dataset.bit);
  });
  document.querySelectorAll("#bdSimple .sbtn").forEach(el => {
    const bit = +el.dataset.s;
    el.onpointerdown = (e) => {
      el.setPointerCapture(e.pointerId);
      if (e.shiftKey) { BD.simpleLatch ^= 1 << bit; setSimple(); return; }
      BD.simple |= 1 << bit; setSimple();
    };
    el.onpointerup = () => { BD.simple &= ~(1 << bit); setSimple(); };
  });
}

function setButton(bit, on) {
  const nb = on ? (BD.buttons | (1 << bit)) : (BD.buttons & ~(1 << bit));
  if (nb === BD.buttons) return;
  BD.buttons = nb >>> 0;
  sendButtons();
}
function toggleButton(bit) {
  BD.buttons = (BD.buttons ^ (1 << bit)) >>> 0;
  const k = document.querySelector(`#bdKeypad .key[data-k="${bit}"]`);
  if (k) { if (BD.buttons & (1 << bit)) k.dataset.latched = "1"; else delete k.dataset.latched; }
  sendButtons();
}
function sendButtons() { renderInputs(); boardCmd("b " + hex(BD.buttons, 6)); }
function setSimple() { renderInputs(); boardCmd("s " + hex(BD.simple | BD.simpleLatch, 1)); }

function renderInputs() {
  document.querySelectorAll("#bdKeypad .key").forEach(el => el.classList.toggle("on", !!(BD.buttons & (1 << +el.dataset.k))));
  document.querySelectorAll("#bdSwitches .sw").forEach(el => el.classList.toggle("on", !!(BD.buttons & (1 << +el.dataset.bit))));
  document.querySelectorAll("#bdSimple .sbtn").forEach(el => el.classList.toggle("on", !!((BD.simple | BD.simpleLatch) & (1 << +el.dataset.s))));
  $("#bdSwHex").textContent = hex((BD.buttons >>> 16) & 0xFF, 2);
}

/* ---------------------------------------------------------------- talking to the backend */
let cmdQueue = [], cmdBusy = false;
async function boardCmd(c) {
  if (!BD.alive) return;
  cmdQueue.push(c);
  if (cmdBusy) return;
  cmdBusy = true;
  while (cmdQueue.length) {
    const batch = cmdQueue.splice(0);
    try { await api("/api/board/cmd", { cmds: batch }); } catch (e) { toast(e.message, "err"); cmdQueue = []; }
  }
  cmdBusy = false;
}

function renderBoardTops() {
  const sel = $("#selBoardTop"), p = S.project;
  const tops = (p && p.board_tops) || [];
  sel.innerHTML = tops.length ? "" : '<option value="">(no *_Board module found)</option>';
  tops.forEach(t => sel.add(new Option(t, t)));
  const saved = p && LS.get("boardtop." + p.root, null);
  const cur = $("#selTop").value;
  sel.value = tops.includes(saved) ? saved : tops.includes(cur) ? cur : (tops[0] || "");
  $("#bdStart").disabled = !tops.length;
}
$("#selBoardEngine").value = LS.get("boardEngine", "auto");
$("#selBoardEngine").onchange = (e) => LS.set("boardEngine", e.target.value);
$("#selBoardTop").onchange = (e) => S.project && LS.set("boardtop." + S.project.root, e.target.value);

async function startBoard() {
  if (!S.project) { showOpenDialog(); return; }
  const top = $("#selBoardTop").value;
  if (!top) { toast("This project has no module that uses the lab board (BoardV3).", "err"); return; }
  await saveAll();
  try {
    const r = await api("/api/board/start", { top, engine: $("#selBoardEngine").value });
    S.project = r.project; renderProject();
    $("#console").innerHTML = ""; S.errors = S.warnings = 0;
    S.diags = new Map(); applyDiagnostics(); renderProblems();
    S.job = r.id; S.since = 0;
    setRunning(true, "board");
    $("#jobChip").textContent = "Building board…";
    $("#bdStatus").className = "job-chip running"; $("#bdStatus").textContent = "Building…";
    showTab("console");
    status("Building the virtual lab board…");
    poll();
  } catch (e) { toast(e.message, "err"); }
}

window.onBoardBuilt = (ok) => {
  if (!ok) {
    $("#bdStatus").className = "job-chip fail"; $("#bdStatus").textContent = "Build failed";
    toast("Board build failed — see console", "err");
    return;
  }
  BD.buttons = 0; BD.simple = 0; BD.simpleLatch = 0; BD.since = 0; BD.memPrev = [];
  document.querySelectorAll("#bdKeypad .key").forEach(k => delete k.dataset.latched);
  renderInputs();
  BD.alive = true;
  showTab("board");
  boardLoop();
};

async function boardLoop() {
  if (BD.polling) return;
  BD.polling = true;
  try {
    while (BD.alive) {
      let r;
      try { r = await api(`/api/board/state?since=${BD.since}`); } catch (e) { await sleep(300); continue; }
      if (r.log && r.log.length) appendLines(r.log.map(t => ({ t, c: "" })));
      BD.since = r.next || 0;
      BD.info = r.info;
      if (!r.alive) { boardEnded(r.exit); break; }
      if (r.state && r.seq !== BD.lastSeq) { BD.lastSeq = r.seq; renderState(r.state); }
      await sleep(document.hidden ? 500 : 45);
    }
  } finally { BD.polling = false; }
}
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function boardEnded(code) {
  BD.alive = false;
  buzz(0);
  $("#boardBadge").hidden = true;
  $("#bdPause").disabled = $("#bdStop").disabled = true;
  $("#bdStatus").className = "job-chip" + (code ? " fail" : "");
  $("#bdStatus").textContent = code === null || code === undefined ? "Not running" : `Stopped (exit ${code})`;
}

/* ---------------------------------------------------------------- rendering */
function renderState(st) {
  $("#boardEmpty").hidden = true;
  $("#boardWrap").hidden = false;
  $("#boardBadge").hidden = false;
  $("#bdPause").disabled = $("#bdStop").disabled = false;
  $("#bdPause").textContent = st.paused ? "Resume" : "Pause";
  const pct = st.mhz / 100 * 100;
  $("#bdStatus").className = "job-chip " + (st.paused ? "" : "running");
  $("#bdStatus").textContent = st.paused ? "Paused" :
    `Live${BD.info && BD.info.engine ? " · " + (BD.info.engine === "icarus" ? "Icarus" : "Verilator") : ""} · Clk ${st.mhz >= 1 ? st.mhz.toFixed(1) + " MHz" : (st.mhz * 1000).toFixed(0) + " kHz"} (${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% of real speed)`;
  $("#bdStatus").title = "Clk is 100 MHz on the real board. Clk_1Hz and Clk_1kHz always run in real time.";

  // displays
  document.querySelectorAll("#bdDisplays .digit").forEach((el, i) => {
    const v = st.d[5 - i];
    el.querySelectorAll("[data-b]").forEach(s => s.classList.toggle("on", !!(v & (1 << +s.dataset.b))));
  });
  // traffic lights: l = {Crossing_A[4:0], Crossing_B[5:0]}
  for (let b = 0; b < 6; b++) $("#tlB" + b).classList.toggle("on", !!(st.l & (1 << b)));
  for (let b = 0; b < 5; b++) $("#tlA" + b).classList.toggle("on", !!((st.l >> 6) & (1 << b)));
  $("#bdS7_1").classList.toggle("on", !!(st.s7 & 2));
  $("#bdS7_0").classList.toggle("on", !!(st.s7 & 1));
  // buzzer: period in 100 MHz Clk cycles, age = cycles since last rising edge
  const active = st.bzp > 0 && st.bza < Math.max(2 * st.bzp, 200000);
  const hz = active ? 100e6 / st.bzp : 0;
  $("#bdBuzzer").classList.toggle("on", active);
  $("#bdBuzzHz").textContent = active ? `${hz >= 1000 ? (hz / 1000).toFixed(2) + " kHz" : hz.toFixed(0) + " Hz"}` : "off";
  buzz(active ? hz : 0);
  if (BD.info && BD.info.mu0 && st.mu0) renderMU0(st.mu0);
  $("#mu0Panel").hidden = !(BD.info && BD.info.mu0);
}

const OPS = ["LDA", "STA", "ADD", "SUB", "JMP", "JGE", "JNE", "STP"];
const IO_NAMES = { 0xFF0: "Simple buttons", 0xFF1: "Switches A–H", 0xFF2: "Keypad", 0xFF3: "Buzzer busy", 0xFF4: "S7 LEDs",
  0xFF5: "Digit0", 0xFF6: "Digit1", 0xFF7: "Digit2", 0xFF8: "Digit3", 0xFF9: "Digit4", 0xFFA: "Digit5", 0xFFD: "Buzzer", 0xFFF: "Traffic lights" };
function disasm(v) {
  const op = v >>> 12;
  return op < 8 ? `${OPS[op]}${op === 7 ? "" : " " + hex(v & 0xFFF, 3)}` : "";
}

function renderMU0(m) {
  const names = ["Stopped", "Running", "Stepping", "Resetting"];
  const st = $("#mu0State");
  st.textContent = m.halted && m.mode === 0 ? "Halted (STP)" : names[m.mode] || "?";
  st.className = "job-chip " + (m.mode === 1 ? "running" : m.halted ? "fail" : "");
  $("#mu0Count").textContent = `${m.instrs} instr · ${m.cycles} clk`;
  $("#mu0Acc").textContent = hex(m.acc, 4);
  $("#mu0AccDec").textContent = (m.acc & 0x8000 ? m.acc - 0x10000 : m.acc).toString();
  $("#mu0Pc").textContent = hex(m.pc, 3);
  $("#mu0N").textContent = (m.flags >> 1) & 1;
  $("#mu0Z").textContent = m.flags & 1;
  $("#mu0Run").disabled = m.mode === 1;
  $("#mu0Stop").disabled = m.mode !== 1;

  if ($("#mu0Follow").checked && (m.pc < m.base || m.pc >= m.base + 64)) {
    const nb = Math.max(0, Math.min(0xFC0, m.pc - 8));
    boardCmd("base " + hex(nb, 3));
    if (document.activeElement !== $("#mu0Base")) $("#mu0Base").value = hex(nb, 3);
  }
  const box = $("#mu0Mem");
  if (box.children.length !== m.mem.length) {
    box.innerHTML = m.mem.map((_, i) => `<div class="mrow" data-i="${i}"><span class="ma"></span><span class="mv"></span><span class="md"></span></div>`).join("");
    [...box.children].forEach(row => row.onclick = () => editMem(+row.dataset.addr, row.querySelector(".mv").textContent));
  }
  m.mem.forEach((v, i) => {
    const row = box.children[i], a = (m.base + i) & 0xFFF;
    row.dataset.addr = a;
    row.querySelector(".ma").textContent = hex(a, 3);
    row.querySelector(".mv").textContent = hex(v, 4);
    row.querySelector(".md").textContent = disasm(v);
    const isPc = a === m.pc;
    if (isPc && $("#mu0Follow").checked && BD.lastPc !== m.pc) {
      const top = row.offsetTop - box.offsetTop, h = box.clientHeight;
      if (top < box.scrollTop || top > box.scrollTop + h - 20) box.scrollTop = Math.max(0, top - h / 3);
    }
    row.classList.toggle("pc", isPc);
    row.classList.toggle("chg", BD.memPrev[a] !== undefined && BD.memPrev[a] !== v);
    BD.memPrev[a] = v;
  });
  BD.lastPc = m.pc;
  $("#mu0Io").innerHTML = m.io.map((v, i) => [0xFF0 + i, v]).filter(([a]) => IO_NAMES[a])
    .map(([a, v]) => `<div><span>${hex(a, 3)} ${IO_NAMES[a]}</span><b>${hex(v, 4)}</b></div>`).join("");
}

function editMem(addr, cur) {
  const v = prompt(`New value for address ${hex(addr, 3)} (hex):`, cur);
  if (v === null) return;
  const n = parseInt(v.trim(), 16);
  if (isNaN(n) || n < 0 || n > 0xFFFF) { toast("Enter a 16-bit hex value, e.g. 1023", "err"); return; }
  boardCmd(`w ${hex(addr, 3)} ${hex(n, 4)}`);
}

/* ---------------------------------------------------------------- buzzer sound */
function buzz(hz) {
  if (!$("#bdSound").checked || !hz || hz < 20 || hz > 20000) {
    if (BD.gain) BD.gain.gain.setTargetAtTime(0, BD.audio.currentTime, 0.01);
    return;
  }
  if (!BD.audio) {
    BD.audio = new (window.AudioContext || window.webkitAudioContext)();
    BD.osc = BD.audio.createOscillator(); BD.osc.type = "square";
    BD.gain = BD.audio.createGain(); BD.gain.gain.value = 0;
    BD.osc.connect(BD.gain).connect(BD.audio.destination); BD.osc.start();
  }
  BD.osc.frequency.setTargetAtTime(hz, BD.audio.currentTime, 0.005);
  BD.gain.gain.setTargetAtTime(0.04, BD.audio.currentTime, 0.01);
}
$("#bdSound").checked = LS.get("bdSound", false);
$("#bdSound").onchange = (e) => { LS.set("bdSound", e.target.checked); if (!e.target.checked) buzz(0); };

/* ---------------------------------------------------------------- controls */
$("#bdStart").onclick = startBoard;
$("#bdStop").onclick = async () => { try { await api("/api/board/stop", {}); } catch (e) { toast(e.message, "err"); } BD.alive = false; boardEnded(null); };
$("#bdPause").onclick = () => boardCmd($("#bdPause").textContent === "Pause" ? "pause" : "resume");
$("#mu0Reset").onclick = () => boardCmd("reset");
$("#mu0Step").onclick = () => boardCmd("step");
$("#mu0Run").onclick = () => boardCmd("run " + $("#mu0Hz").value);
$("#mu0Stop").onclick = () => boardCmd("stop");
$("#mu0Hz").onchange = (e) => { LS.set("mu0Hz", e.target.value); if ($("#mu0State").textContent === "Running") boardCmd("run " + e.target.value); };
$("#mu0Hz").value = LS.get("mu0Hz", "10");
$("#mu0Base").onchange = (e) => {
  const n = parseInt(e.target.value, 16);
  if (isNaN(n)) return;
  $("#mu0Follow").checked = false;
  boardCmd("base " + hex(n & 0xFFF, 3));
};
$("#mu0Load").onclick = async () => {
  const path = $("#mu0MemFile").value;
  if (!path) { toast("No .mem files found in the project", "err"); return; }
  try {
    const r = await api("/api/board/loadmem", { path });
    toast(`Loaded ${r.words} words from ${basename(path)} and reset MU0`, "ok");
  } catch (e) { toast(e.message, "err"); }
};
async function refreshMemFiles() {
  if (!S.project) return;
  try {
    const r = await api("/api/board/memfiles");
    const sel = $("#mu0MemFile");
    sel.innerHTML = r.files.length ? "" : '<option value="">(no .mem files)</option>';
    r.files.forEach(f => sel.add(new Option(f.rel, f.path)));
  } catch (e) { /* ignore */ }
}

// type on the keypad while the Board tab is open (hold a key = hold the button)
const KEYMAP = "0123456789abcdef";
document.addEventListener("keydown", (e) => {
  if (!BD.alive || !$("#tab-board").classList.contains("active") || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const k = KEYMAP.indexOf(e.key.toLowerCase());
  if (k >= 0) { setButton(k, true); e.preventDefault(); }
});
document.addEventListener("keyup", (e) => {
  if (!BD.alive) return;
  const k = KEYMAP.indexOf(e.key.toLowerCase());
  if (k >= 0) setButton(k, false);
});

/* ---------------------------------------------------------------- hooks */
buildBoard();
const _renderProject = renderProject;
renderProject = function () {
  _renderProject();
  if (S.project !== BD.proj) { BD.proj = S.project; renderBoardTops(); refreshMemFiles(); }
};   // eslint-disable-line no-global-assign
if (S.project) { renderBoardTops(); refreshMemFiles(); }
COMMANDS.push(["Start virtual lab board", "", () => { showTab("board"); startBoard(); }, "▦"]);
COMMANDS.push(["Show Board", "", () => showTab("board"), "▦"]);
// reconnect to a board that is already running (e.g. after reloading the window)
api("/api/board/state").then(r => { if (r.alive) { BD.info = r.info; BD.alive = true; BD.since = r.next || 0; boardLoop(); } }).catch(() => {});
