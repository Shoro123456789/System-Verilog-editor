/* SV Studio – RISC-V simulator tab (a Bennett-style assembler/debugger, built in). */
(function () {
"use strict";

const EXAMPLE = `# RISC-V example: sum an array, then print it.
# F7 assemble · F5 run · F11 step · F10 step over · Shift+F11 step back
# Click left of a line number (or press F9) for a breakpoint.

        .data
nums:   .word   3, 14, 15, 92, 65
count:  .word   5
msg:    .asciz  "sum = "

        .text
main:
        la      a0, nums          # a0 = address of the array
        lw      a1, count         # a1 = number of elements
        call    sum               # a0 = sum(a0, a1)
        mv      s0, a0

        la      a0, msg           # print "sum = "
        li      a7, 4
        ecall
        mv      a0, s0            # print the number
        li      a7, 1
        ecall
        li      a0, '\\n'
        li      a7, 11
        ecall

        li      a7, 10            # exit
        ecall

# int sum(int *a0, int a1)
sum:
        li      t0, 0             # running total
1:      beqz    a1, 2f
        lw      t1, 0(a0)
        add     t0, t0, t1
        addi    a0, a0, 4
        addi    a1, a1, -1
        j       1b
2:      mv      a0, t0
        ret
`;

const RV = window.RV;
const el = (s) => document.querySelector(s);
const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const h8 = (v) => "0x" + (v >>> 0).toString(16).padStart(8, "0");
const hx = (v, n = 8) => (v >>> 0).toString(16).padStart(n, "0");

const R = {
  path: LS.get("rv.path", null),
  dirty: false,
  asm: null,             // last assembly result
  asmText: null,         // source it was built from
  m: new RV.Machine({ memSize: +LS.get("rv.mem", 1048576), output: (s) => conOut(s) }),
  running: false,
  timer: null,
  names: LS.get("rv.names", "abi"),
  fmt: LS.get("rv.fmt", "hex"),
  memFmt: "w",
  sel: null,             // selected register for history
  pane: "hist",
  prevRegs: new Int32Array(32),
  memBase: 0,
  bpAddrs: new Set(),
  stopAt: null,          // step over / out target
  loaded: false,
};
el("#rvMem").value = String(R.m.memSize);

/* ---------------------------------------------------------------- editor */
const ed = SVEditor.createAsm(el("#rvEditor"), {
  doc: LS.get("rv.draft", null) ?? EXAMPLE,
  onChange: () => {
    if (!R.dirty) { R.dirty = true; renderFile(); }
    clearTimeout(R.draftT); R.draftT = setTimeout(() => LS.set("rv.draft", ed.getDoc()), 400);
    if (R.asm && ed.getDoc() !== R.asmText) setStatus("Source changed — press F7 to reassemble", "");
    clearTimeout(R.lintT); R.lintT = setTimeout(liveCheck, 500);
  },
  onSave: () => save(),
  onBreakpoints: () => { syncBreakpoints(); LS.set("rv.bps", ed.breakpoints()); },
  hooks: {
    regValue: (r) => R.loaded ? `${h8(R.m.x[r])}  =  ${R.m.x[r]}` : null,
    symbol: (name) => {
      const a = (R.asm && R.asm.symbols.get(name));
      return a === undefined ? null : `${h8(a)}  (${a})` + (R.loaded && R.asm.symLine.has(name) && a < R.m.memSize - 4 ? `   mem = ${h8(R.m.peek32(a))}` : "");
    },
  },
});
ed.setBreakpoints(LS.get("rv.bps", []));

function liveCheck() {
  const r = RV.assemble(ed.getDoc());
  ed.setDiagnostics([...r.errors, ...r.warnings]);
}
setTimeout(liveCheck, 300);

/* ---------------------------------------------------------------- console */
function conOut(text, cls) {
  const box = el("#rvCon");
  if (cls) {
    const d = document.createElement("div"); d.className = cls; d.textContent = text; box.appendChild(d);
  } else {
    const last = box.lastChild;
    if (last && last.nodeType === 3) last.appendData(text); else box.appendChild(document.createTextNode(text));
  }
  if (box.childNodes.length > 4000) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
const sys = (t, cls = "sys") => { const box = el("#rvCon"); const last = box.lastChild; if (last && last.nodeType === 3 && !/\n$/.test(last.data)) box.appendChild(document.createTextNode("\n")); conOut(t, cls); };
el("#rvConClear").onclick = () => { el("#rvCon").innerHTML = ""; };

/* ---------------------------------------------------------------- file handling */
const fname = () => R.path ? R.path.replace(/\\/g, "/").split("/").pop() : "untitled.s";
function renderFile() { const f = el("#rvFile"); f.textContent = fname(); f.title = R.path || "Not saved yet"; f.classList.toggle("dirty", R.dirty); }
renderFile();

async function save(as = false) {
  let path = R.path;
  if (!path || as || !/\.(s|asm)$/i.test(path)) {
    try { path = (await api("/api/browse", { kind: "asmsave", start: R.path ? R.path.replace(/[\\/][^\\/]*$/, "") : "" })).path; }
    catch (e) { toast(e.message, "err"); return; }
    if (!path) return;
  }
  try {
    const r = await api("/api/asm/save", { path, text: ed.getDoc() });
    R.path = r.path; LS.set("rv.path", R.path); R.dirty = false; renderFile(); toast("Saved " + fname(), "ok");
  } catch (e) { toast(e.message, "err"); }
}

async function openFile(path) {
  if (!path) {
    if (R.dirty && !confirm("Discard unsaved changes to " + fname() + "?")) return;
    try { path = (await api("/api/browse", { kind: "asm", start: R.path ? R.path.replace(/[\\/][^\\/]*$/, "") : "" })).path; }
    catch (e) { toast(e.message, "err"); return; }
    if (!path) return;
  }
  let r;
  try { r = await api("/api/asm/read", { path }); } catch (e) { toast(e.message, "err"); return; }
  if (/\.(s|asm)$/i.test(path)) {
    stop();
    ed.setDoc(r.text); ed.setBreakpoints([]);
    R.path = r.path; LS.set("rv.path", R.path); LS.set("rv.draft", r.text); R.dirty = false; renderFile();
    R.asm = null; R.loaded = false; setStatus("Not assembled", "");
    liveCheck(); assemble();
    return;
  }
  // memory image (.hex / .txt / .bin / .kmd)
  let bytes, at = null;
  try {
    if (r.binary) bytes = Uint8Array.from(atob(r.binary), (c) => c.charCodeAt(0));
    else if (/\.kmd$/i.test(path)) ({ bytes, addr: at } = parseKMD(r.text));
    else ({ bytes, addr: at } = RV.parseHexText(r.text));
  } catch (e) { toast(e.message, "err"); return; }
  if (at === null || at === undefined) {
    const s = prompt(`Load ${bytes.length} bytes at address (hex):`, "0");
    if (s === null) return;
    at = parseInt(s, 16) || 0;
    if (at % 4) toast("Address should be a multiple of 4 for RISC-V", "err");
  }
  stop();
  try { R.m.loadBinary(bytes, at); } catch (e) { toast(e.message, "err"); return; }
  R.asm = null; R.loaded = true; R.bpAddrs.clear();
  sys(`Loaded ${path.replace(/\\/g, "/").split("/").pop()} — ${bytes.length} bytes at ${h8(at)}. No source: use the Code tab to follow execution.`, "ok");
  setStatus("Loaded image", "ok");
  R.pane = "code"; showPane("code");
  refresh(true);
}

// Bennett/Komodo .kmd listing: lines like "00000000: 00500093  ; addi x1, x0, 5"
function parseKMD(text) {
  const words = new Map(); let first = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{1,8})\s*:\s*((?:[0-9a-f]{2,8}\s+)*[0-9a-f]{2,8})/i.exec(line);
    if (!m) continue;
    let a = parseInt(m[1], 16);
    if (first === null || a < first) first = first === null ? a : Math.min(first, a);
    for (const tok of m[2].trim().split(/\s+/)) {
      const n = tok.length / 2;
      const v = parseInt(tok, 16);
      for (let k = 0; k < n; k++) words.set(a + k, (v >>> (8 * k)) & 0xff);
      a += n;
    }
  }
  if (!words.size) throw new Error("No code found in the .kmd file");
  const last = Math.max(...words.keys());
  const bytes = new Uint8Array(last - first + 1);
  for (const [a, b] of words) bytes[a - first] = b;
  return { bytes, addr: first };
}

el("#rvNew").onclick = () => {
  if (R.dirty && !confirm("Discard unsaved changes to " + fname() + "?")) return;
  stop(); ed.setDoc("        .text\nmain:\n        \n        li      a7, 10\n        ecall\n"); ed.setBreakpoints([]);
  R.path = null; LS.set("rv.path", null); R.dirty = false; renderFile(); R.asm = null; R.loaded = false; setStatus("Not assembled", ""); refresh(true);
};
el("#rvOpen").onclick = () => openFile();
el("#rvSave").onclick = () => save();

/* ---------------------------------------------------------------- assemble / control */
function setStatus(t, cls) { const c = el("#rvStatus"); c.textContent = t; c.className = "job-chip " + (cls || ""); }

function assemble(quiet) {
  stop();
  const text = ed.getDoc();
  const r = RV.assemble(text);
  ed.setDiagnostics([...r.errors, ...r.warnings]);
  if (!r.ok) {
    setStatus(`${r.errors.length} error${r.errors.length > 1 ? "s" : ""}`, "fail");
    sys(`Assembly failed:`, "err");
    for (const e of r.errors.slice(0, 20)) sys(`  line ${e.line}: ${e.message}`, "err");
    ed.gotoLine(r.errors[0].line);
    R.loaded = false; refresh(true);
    return false;
  }
  if (R.m.memSize !== +el("#rvMem").value) R.m = new RV.Machine({ memSize: +el("#rvMem").value, output: (s) => conOut(s) });
  try { R.m.load(r); } catch (e) { setStatus("Too big", "fail"); sys(e.message, "err"); return false; }
  R.asm = r; R.asmText = text; R.loaded = true;
  R.prevRegs = new Int32Array(R.m.x);
  syncBreakpoints();
  const words = (r.textRange[1] - r.textRange[0]) / 4, data = r.dataRange[1] - r.dataRange[0];
  if (!quiet) sys(`Assembled ${fname()}: ${words} instruction word${words === 1 ? "" : "s"} at ${h8(r.textRange[0])}` +
    (data ? `, ${data} bytes of data at ${h8(r.dataRange[0])}` : "") + `, entry ${R.m.symbolAt(r.entry) || h8(r.entry)}` +
    (r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}` : ""), "ok");
  setStatus("Ready", "ok");
  R.memBase = r.dataRange[1] > r.dataRange[0] ? r.dataRange[0] : 0;
  el("#rvMemAddr").value = h8(R.memBase);
  refresh(true);
  return true;
}

// Reassemble automatically if the source changed since the last build (only from a fresh start).
function ensureBuilt() {
  if (!R.loaded) return assemble();
  if (R.asm && ed.getDoc() !== R.asmText) {
    if (R.m.cycles === 0 || confirm("The source has changed. Reassemble and restart?")) return assemble();
  }
  return true;
}

function syncBreakpoints() {
  R.bpAddrs.clear();
  if (!R.asm) return;
  const lines = ed.breakpoints();
  const sorted = [...R.asm.lineToAddr.keys()].sort((a, b) => a - b);
  for (const ln of lines) {
    let a = R.asm.lineToAddr.get(ln);
    if (a === undefined) { const next = sorted.find(l => l > ln); if (next !== undefined) a = R.asm.lineToAddr.get(next); }
    if (a !== undefined && a >= R.asm.textRange[0] && a < R.asm.textRange[1]) R.bpAddrs.add(a);
  }
}

function canRun() { const s = R.m.status; return R.loaded && s !== "halted" && s !== "fault" && s !== "input"; }

function run(mode = "run") {
  if (!ensureBuilt()) return;
  if (R.m.status === "input") { el("#rvInput").focus(); return; }
  if (!canRun()) { sys(R.m.message || "Program has finished — press Reset to run again.", "sys"); return; }
  if (mode === "over" || mode === "out") {
    const depth = R.m.frames.length;
    const d = RV.decode(R.m.peek32(R.m.pc));
    const isCall = (d.op === 0x6f || d.op === 0x67) && d.rd === 1;
    if (mode === "over" && !isCall) { stepOnce(); return; }
    R.stopAt = mode === "over" ? { depth } : { depth: depth - 1 };
    if (mode === "out" && depth === 0) { R.stopAt = null; sys("Not inside a call — step out needs a function that was entered with call/jal.", "sys"); return; }
  } else R.stopAt = null;
  R.running = true;
  R.m.status = "running";
  setStatus("Running", "running");
  el("#rvRun").querySelector("span").textContent = "Pause";
  tick(true);
}

function tick(first) {
  if (!R.running) return;
  const speed = +el("#rvSpeed").value;
  const m = R.m;
  const t0 = performance.now();
  let n = 0;
  const budget = speed ? 1 : 1e9;
  let stopMsg = null;
  const nAbi = m.abiWarnings.length;
  while (n < budget) {
    if (!(first && n === 0) && R.bpAddrs.has(m.pc)) { stopMsg = `Breakpoint at ${R.m.symbolAt(m.pc) || h8(m.pc)} (line ${lineOf(m.pc) || "?"})`; break; }
    if (!m.step()) break;
    n++;
    if (R.stopAt && m.frames.length <= R.stopAt.depth) { stopMsg = ""; break; }
    if ((n & 1023) === 0 && performance.now() - t0 > 14) break;
  }
  first = false;
  for (const w of m.abiWarnings.slice(nAbi)) sys(`⚠ ABI: ${w.msg} (at ${h8(w.pc)}, line ${lineOf(w.pc) || "?"})`, "warn");
  const done = m.status !== "running";
  if (stopMsg !== null || done) {
    R.running = false; R.stopAt = null;
    el("#rvRun").querySelector("span").textContent = "Run";
    if (m.status === "running") m.status = "paused";
    if (stopMsg) sys(stopMsg, "sys");
    reportStatus();
    refresh(true);
    return;
  }
  refresh(speed > 0 && speed <= 200);
  R.timer = speed ? setTimeout(() => tick(false), 1000 / speed) : setTimeout(() => tick(false), 0);
}

function reportStatus() {
  const m = R.m;
  if (m.status === "halted") { sys(m.message + `  ·  ${m.cycles.toLocaleString()} instructions`, "ok"); setStatus("Finished", "ok"); }
  else if (m.status === "fault") { sys("✖ " + m.message, "err"); setStatus("Fault", "fail"); const ln = lineOf(m.pc); if (ln) ed.gotoLine(ln); }
  else if (m.status === "input") askInput();
  else { if (m.message) { sys(m.message, "warn"); m.message = ""; } setStatus("Paused", ""); }
}

function stop() {
  if (R.timer) clearTimeout(R.timer);
  R.timer = null;
  if (R.running) { R.running = false; if (R.m.status === "running") R.m.status = "paused"; el("#rvRun").querySelector("span").textContent = "Run"; setStatus("Paused", ""); }
}

function stepOnce() {
  if (!ensureBuilt()) return;
  if (R.m.status === "input") { el("#rvInput").focus(); return; }
  if (!canRun()) { sys(R.m.message || "Program has finished — press Reset to run again.", "sys"); return; }
  stop();
  const nAbi = R.m.abiWarnings.length;
  R.m.step();
  for (const w of R.m.abiWarnings.slice(nAbi)) sys(`⚠ ABI: ${w.msg} (line ${lineOf(w.pc) || "?"})`, "warn");
  if (R.m.status === "running" || R.m.status === "ready") R.m.status = "paused";
  if (R.m.status !== "paused") reportStatus(); else setStatus("Paused", "");
  refresh(true);
}

function stepBack() {
  stop();
  if (!R.loaded) return;
  if (!R.m.stepBack()) { toast(R.m.histDropped ? "History limit reached — can't go further back" : "Already at the start", ""); return; }
  el("#rvInputForm").hidden = true;
  setStatus("Paused", "");
  refresh(true);
}

function reset() {
  stop();
  el("#rvInputForm").hidden = true;
  if (R.asm && ed.getDoc() !== R.asmText) { assemble(); return; }
  if (R.asm) { R.m.load(R.asm); R.prevRegs = new Int32Array(R.m.x); sys("Reset.", "sys"); setStatus("Ready", "ok"); refresh(true); }
  else assemble();
}

el("#rvAsm").onclick = () => assemble();
el("#rvRun").onclick = () => R.running ? (stop(), refresh(true)) : run();
el("#rvStep").onclick = () => stepOnce();
el("#rvOver").onclick = () => run("over");
el("#rvOut").onclick = () => run("out");
el("#rvBack").onclick = () => stepBack();
el("#rvReset").onclick = () => reset();
el("#rvMem").onchange = () => { LS.set("rv.mem", +el("#rvMem").value); if (R.asm) assemble(true); };

/* ---------------------------------------------------------------- input (read syscalls) */
function askInput() {
  const kind = { 5: "Enter an integer", 8: "Enter a string", 12: "Enter a character", 63: "Enter text" }[R.m.pendingInput] || "Input";
  el("#rvInputLabel").textContent = kind + " ›";
  el("#rvInputForm").hidden = false;
  setStatus("Waiting for input", "running");
  el("#rvInput").value = ""; el("#rvInput").focus();
}
el("#rvInputForm").onsubmit = (e) => {
  e.preventDefault();
  const v = el("#rvInput").value;
  conOut(v + "\n", "sys");
  el("#rvInputForm").hidden = true;
  R.m.provideInput(v);
  run();
};

/* ---------------------------------------------------------------- rendering */
const lineOf = (a) => R.asm ? R.asm.addrToLine.get(a >>> 0) : undefined;
const regName = (i) => R.names === "x" ? "x" + i : RV.ABI[i];
function fmtVal(v, f = R.fmt) {
  switch (f) {
    case "dec": return String(v | 0);
    case "udec": return String(v >>> 0);
    case "bin": return (v >>> 0).toString(2).padStart(32, "0").replace(/(.{8})(?!$)/g, "$1_");
    case "chr": { const c = v & 0xff; return (c >= 32 && c < 127 ? `'${String.fromCharCode(c)}'` : c === 10 ? "'\\n'" : c === 0 ? "'\\0'" : "·") + `  (${v | 0})`; }
    default: return h8(v);
  }
}
const symOr = (a) => (R.m.symbolAt(a) || h8(a));
const disasmAt = (a) => RV.disasm(R.m.peek32(a), a, { xnames: R.names === "x", symbolAt: (t) => R.m.symbolAt(t) });

function refresh(full) {
  const m = R.m;
  // pc
  const pcEl = el("#rvPc");
  if (R.loaded) {
    const sym = m.symbolAt(m.pc);
    const fin = m.status === "halted" ? "program finished" : m.status === "fault" ? "stopped on a fault" : null;
    pcEl.innerHTML = `<span class="lbl">pc</span><b>${h8(m.pc)}</b><span class="dis">${fin ? `<span class="muted">${fin}</span>` : escH(m.pc + 4 <= m.memSize ? disasmAt(m.pc) : "—")}</span>${sym && !fin ? `<span class="lbl">${escH(sym)}</span>` : ""}`;
  } else pcEl.innerHTML = `<span class="lbl">pc</span><b>—</b><span class="dis muted">Press Assemble (F7)</span>`;
  // registers
  const grid = el("#rvRegs");
  if (!grid.children.length) {
    grid.innerHTML = RV.ABI.map((n, i) => `<div class="rreg ${i === 0 ? "zero" : RV.REG_SAVER[i] === "callee" ? "callee" : /^a/.test(n) ? "arg" : /^t/.test(n) ? "tmp" : ""}" data-r="${i}"><span class="rn"></span><span class="rv"></span></div>`).join("");
    grid.querySelectorAll(".rreg").forEach(d => d.onclick = () => { R.sel = +d.dataset.r; showPane("hist"); refresh(true); });
  }
  const last = m.hist[m.hist.length - 1];
  const lastRd = last ? last.rd : 0;
  const badRegs = new Set(m.abiWarnings.length ? m.abiWarnings[m.abiWarnings.length - 1].regs : []);
  [...grid.children].forEach((d, i) => {
    const v = m.x[i];
    d.querySelector(".rn").innerHTML = escH(regName(i)) + (R.names === "x" ? "" : `<small>x${i}</small>`);
    const rv = d.querySelector(".rv");
    rv.textContent = fmtVal(v);
    d.title = `${RV.ABI[i]} (x${i}) — ${RV.REG_ROLE[i]}${RV.REG_SAVER[i] ? `, ${RV.REG_SAVER[i]}-saved` : ""}\n${h8(v)}  ·  ${v | 0}  ·  unsigned ${v >>> 0}`;
    d.classList.toggle("chg", R.loaded && i === lastRd && i !== 0 && m.cycles > 0);
    d.classList.toggle("sel", R.sel === i);
    d.classList.toggle("bad", badRegs.has(i));
  });
  // editor exec line
  ed.setExecLine(R.loaded && m.status !== "halted" ? (lineOf(m.pc) || 0) : 0, !R.running || +el("#rvSpeed").value > 0);
  el("#rvCycles").textContent = R.loaded ? `${m.cycles.toLocaleString()} instructions` + (m.frames.length ? ` · depth ${m.frames.length}` : "") : "";
  const ab = el("#rvAbiBadge"); ab.hidden = !m.abiWarnings.length; ab.textContent = m.abiWarnings.length;
  const b = el("#rvBadge"); b.hidden = !R.running; b.textContent = "run";
  if (full || R.pane === "mem") renderPane();
}

/* ---------- side panes */
function showPane(p) {
  R.pane = p;
  document.querySelectorAll("#rvTabs button").forEach(b => b.classList.toggle("active", b.dataset.p === p));
  document.querySelectorAll(".rv-pane").forEach(x => x.classList.toggle("active", x.id === "rvP-" + p));
  renderPane();
}
document.querySelectorAll("#rvTabs button").forEach(b => b.onclick = () => showPane(b.dataset.p));

function renderPane() {
  ({ hist: renderHist, trace: renderTrace, mem: renderMem, stack: renderStack, code: renderCode, sym: renderSyms })[R.pane]();
}

function rowLine(ln) { return ln ? `<span title="line ${ln}">L${ln}</span>` : ""; }
function bindRows(box) {
  box.querySelectorAll("[data-ln]").forEach(r => r.onclick = () => { const ln = +r.dataset.ln; if (ln) ed.gotoLine(ln); });
}

function renderHist() {
  const box = el("#rvP-hist");
  if (R.sel === null) { box.innerHTML = `<div class="rv-empty">Click a register to see every value it has held, with the instruction that wrote it.<br><br>Shift+F11 steps backwards, undoing one instruction at a time.</div>`; return; }
  const r = R.sel, m = R.m;
  const hist = m.regHistory(r, 2000);
  const vals = [...hist.map(h => h.value)];
  let spark = "";
  if (vals.length > 1) {
    const nums = vals.map(v => v | 0), lo = Math.min(...nums), hi = Math.max(...nums), W = 440, H = 34;
    const xs = (i) => (i / (nums.length - 1)) * W, ys = (v) => hi === lo ? H / 2 : H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
    const d = nums.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join("");
    spark = `<svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="area" d="${d}L${W},${H}L0,${H}Z"/><path d="${d}"/></svg>`;
  }
  const rows = hist.slice().reverse().map(h => {
    const ln = lineOf(h.pc);
    return `<div class="rv-row" data-ln="${ln || 0}" title="${escH(disasmAt(h.pc))}"><span class="c">#${h.cyc}</span><span class="a">${hx(h.pc)}</span>` +
      `<span class="v"><i>${escH(fmtVal(h.old))}</i> → <b>${escH(fmtVal(h.value))}</b> <em>${escH(disasmAt(h.pc))}</em></span></div>`;
  }).join("");
  box.innerHTML = `<div class="rv-h-title"><b>${escH(regName(r))}</b><span class="muted small">x${r} · ${escH(RV.REG_ROLE[r])}${RV.REG_SAVER[r] ? " · " + RV.REG_SAVER[r] + "-saved" : ""}</span><div class="spacer"></div><span class="muted small">${hist.length} write${hist.length === 1 ? "" : "s"} · now ${escH(fmtVal(m.x[r]))}</span></div>` +
    spark + (rows || `<div class="rv-empty">${r === 0 ? "zero is hard-wired to 0 — writes to it are ignored." : "Not written yet in this run."}</div>`);
  bindRows(box);
}

function effectText(h, m) {
  const parts = [];
  if (h.rd) {
    // value after = next write's old, or current value
    parts.push(`${regName(h.rd)} = ${fmtVal(valueAfter(h, m))}`);
  }
  if (h.mem) parts.push(`mem[${hx(h.mem[0])}] ← ${h.mem[1] === 4 ? h8(m.read(h.mem[0], 4)) : "0x" + hx(m.read(h.mem[0], h.mem[1], false), h.mem[1] * 2)}`);
  if (h.frame && h.frame.push) parts.push("call");
  if (h.frame && h.frame.popped) parts.push("return");
  return parts.join(" · ");
}
function valueAfter(h, m) {
  const i = m.hist.lastIndexOf(h);
  for (let j = i + 1; j < m.hist.length; j++) if (m.hist[j].rd === h.rd) return m.hist[j].old;
  return m.x[h.rd];
}

function renderTrace() {
  const box = el("#rvP-trace"); box.classList.add("rv-trace");
  const m = R.m;
  if (!m.hist.length) { box.innerHTML = `<div class="rv-empty">The last 300 executed instructions appear here, newest first, with what each one changed.</div>`; return; }
  const recent = m.hist.slice(-300).reverse();
  box.innerHTML = recent.map((h, k) => {
    const ln = lineOf(h.pc);
    return `<div class="rv-row ${k === 0 ? "cur" : ""} ${h.abiWarn ? "warn" : ""}" data-ln="${ln || 0}"><span class="c">#${h.cyc}</span><span class="a">${hx(h.pc)}</span>` +
      `<span class="v">${escH(disasmAt(h.pc))}</span><span class="v"><b>${escH(effectText(h, m))}</b></span></div>`;
  }).join("");
  bindRows(box);
}

function resolveAddr(s) {
  s = s.trim();
  if (!s) return null;
  const r = RV.regNum(s);
  if (r >= 0) return R.m.x[r] >>> 0;
  try { return RV.evalExpr(s, (n) => R.asm ? R.asm.symbols.get(n) : undefined, R.m.pc) >>> 0; } catch (e) { return null; }
}
el("#rvMemGo").onclick = () => {
  const a = resolveAddr(el("#rvMemAddr").value);
  if (a === null) { toast("Unknown address / label", "err"); return; }
  el("#rvMemFollow").checked = false;
  R.memBase = a & ~15; renderMem();
};
el("#rvMemAddr").onkeydown = (e) => { if (e.key === "Enter") el("#rvMemGo").click(); };
el("#rvMemFollow").onchange = () => renderMem();
document.querySelectorAll("#rvMemFmt button").forEach(b => b.onclick = () => {
  R.memFmt = b.dataset.v; document.querySelectorAll("#rvMemFmt button").forEach(x => x.classList.toggle("active", x === b)); renderMem();
});

function renderMem() {
  const m = R.m, box = el("#rvMemView");
  if (el("#rvMemFollow").checked) R.memBase = Math.max(0, ((m.x[2] >>> 0) & ~15) - 64);
  const base = Math.min(R.memBase >>> 0, Math.max(0, m.memSize - 16 * 48));
  const sp = m.x[2] >>> 0, pc = m.pc >>> 0, now = m.cycles;
  const symAt = (a) => m.symbolAt(a);
  let html = "";
  for (let row = 0; row < 48; row++) {
    const a = base + row * 16;
    if (a >= m.memSize) break;
    let cells = "", chars = "";
    const labs = [0, 4, 8, 12].map(k => symAt(a + k) ? `${symAt(a + k)} = ${h8(a + k)}` : null).filter(Boolean);
    for (let k = 0; k < 16; k += 4) {
      const wa = a + k, w = m.peek32(wa);
      const wrote = m.memWrites.has(wa) && now - m.memWrites.get(wa) < 2;
      const cls = [w === 0 ? "z" : "", wrote ? "w" : "", symAt(wa) ? "lab" : "", wa === pc && R.loaded ? "pc" : "", wa === (sp & ~3) ? "sp" : ""].join(" ");
      const tip = `${h8(wa)}${symAt(wa) ? " <" + symAt(wa) + ">" : ""}\nword ${h8(w)} = ${w | 0}\n${disasmSafe(w, wa)}${wa === sp ? "\n← sp" : ""}`;
      if (R.memFmt === "w") cells += `<span class="${cls}" data-a="${wa}" title="${escH(tip)}">${hx(w)}</span>`;
      else for (let j = 0; j < 4; j++) cells += `<span class="${cls}" data-a="${wa}" title="${escH(tip)}">${hx(m.mem[wa + j], 2)}</span>`;
      for (let j = 0; j < 4; j++) { const c = m.mem[wa + j]; chars += c >= 32 && c < 127 ? String.fromCharCode(c) : "·"; }
    }
    html += `<div class="mline ${R.memFmt === "b" ? "bytes" : ""}"><span class="ma ${labs.length ? "sym" : ""}" title="${escH(labs.join("\n"))}">${hx(a)}</span><span class="mw">${cells}</span><span class="mc">${escH(chars)}</span></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll(".mw span").forEach(s => s.ondblclick = () => editWord(+s.dataset.a));
}
const disasmSafe = (w, a) => { try { return RV.disasm(w, a); } catch (e) { return ""; } };
function editWord(a) {
  if (R.running) return;
  const cur = R.m.peek32(a);
  const s = prompt(`New value for word at ${h8(a)} (hex 0x…, decimal, or 'c'):`, h8(cur));
  if (s === null) return;
  let v; try { v = RV.evalExpr(s, (n) => R.asm ? R.asm.symbols.get(n) : undefined, a); } catch (e) { toast(e.message, "err"); return; }
  for (let k = 0; k < 4; k++) R.m.mem[a + k] = (v >>> (8 * k)) & 0xff;
  R.m.memWrites.set(a, R.m.cycles); renderMem();
}

function renderStack() {
  const box = el("#rvP-stack"), m = R.m;
  let html = "";
  if (m.abiWarnings.length) {
    html += m.abiWarnings.slice(-20).reverse().map(w => `<div class="rv-abiw" data-ln="${lineOf(w.pc) || 0}">⚠ ${escH(w.msg)}<br><span class="muted">instruction #${w.cyc} at ${hx(w.pc)}${lineOf(w.pc) ? ", line " + lineOf(w.pc) : ""}</span></div>`).join("");
  }
  if (!m.frames.length) html += `<div class="rv-empty">Call stack is empty. Each <code>call</code>/<code>jal ra</code> adds a frame; <code>ret</code> removes it.<br><br>SV Studio checks the calling convention on every return: if a function changes a callee-saved register (s0–s11, sp) without restoring it, you get a warning here and in the console.</div>`;
  else {
    html += m.frames.slice().reverse().map((f, i) => {
      const fn = symOr(f.target);
      return `<div class="rv-frame" data-ln="${lineOf(f.callPc) || 0}"><div><b>${escH(fn)}</b> ${i === 0 ? '<span class="job-chip running" style="padding:1px 8px">current</span>' : ""}</div>` +
        `<div class="muted">called from ${hx(f.callPc)}${lineOf(f.callPc) ? " (line " + lineOf(f.callPc) + ")" : ""} · returns to ${hx(f.ret)} · entered at #${f.cyc}</div></div>`;
    }).join("");
  }
  box.innerHTML = html;
  bindRows(box);
}

function renderCode() {
  const box = el("#rvP-code"); box.classList.add("rv-code");
  const m = R.m;
  if (!R.loaded) { box.innerHTML = `<div class="rv-empty">Assemble or load a memory image to see the machine code.</div>`; return; }
  let lo, hi;
  if (R.asm) { lo = R.asm.textRange[0]; hi = R.asm.textRange[1]; }
  else { lo = Math.max(0, (m.pc & ~3) - 64); hi = Math.min(m.memSize, lo + 4 * 200); }
  if (hi - lo > 4 * 2000) { lo = Math.max(lo, (m.pc & ~3) - 4 * 500); hi = Math.min(hi, lo + 4 * 1000); }
  let html = "";
  for (let a = lo; a < hi; a += 4) {
    const ln = lineOf(a), sym = m.symbolAt(a);
    if (sym) html += `<div class="rv-row" style="color:#89ddff" data-ln="${ln || 0}"><span></span><span></span><span></span><span class="v" style="color:#89ddff">${escH(sym)}:</span><span></span></div>`;
    html += `<div class="rv-row ${a === m.pc ? "cur" : ""}" data-ln="${ln || 0}" data-a="${a}"><span class="bp">${R.bpAddrs.has(a) ? "●" : ""}</span><span class="a">${hx(a)}</span><span class="c">${hx(m.peek32(a))}</span>` +
      `<span class="v">${escH(disasmAt(a))}</span><span class="ln">${ln ? "L" + ln : ""}</span></div>`;
  }
  box.innerHTML = html;
  bindRows(box);
  const cur = box.querySelector(".cur"); if (cur) cur.scrollIntoView({ block: "nearest" });
}

function renderSyms() {
  const box = el("#rvP-sym"); box.classList.add("rv-sym");
  if (!R.asm) { box.innerHTML = `<div class="rv-empty">Assemble to see labels and constants.</div>`; return; }
  const rows = [...R.asm.symbols].sort((a, b) => a[1] - b[1]).map(([k, v]) => {
    const ln = R.asm.symLine.get(k);
    return `<div class="rv-row" data-ln="${ln || 0}" data-sym="${escH(k)}"><span class="v">${escH(k)}</span><span class="a">${h8(v)}</span><span class="c">${ln ? "L" + ln : ".equ"}</span></div>`;
  }).join("");
  box.innerHTML = rows || `<div class="rv-empty">No labels.</div>`;
  box.querySelectorAll("[data-sym]").forEach(r => r.ondblclick = () => { el("#rvMemAddr").value = r.dataset.sym; showPane("mem"); el("#rvMemGo").click(); });
  bindRows(box);
}

/* ---------- register display toggles */
function bindSeg(sel, key, cb) {
  document.querySelectorAll(sel + " button").forEach(b => {
    b.classList.toggle("active", b.dataset.v === R[key]);
    b.onclick = () => { R[key] = b.dataset.v; LS.set("rv." + key, R[key]); document.querySelectorAll(sel + " button").forEach(x => x.classList.toggle("active", x === b)); cb && cb(); refresh(true); };
  });
}
bindSeg("#rvNames", "names");
bindSeg("#rvFmt", "fmt");

/* ---------- resizer */
(() => {
  const rz = el("#rvResize"), right = el("#rvRight");
  const w = LS.get("size.rvRight", null); if (w) right.style.width = w + "px";
  rz.onmousedown = (e) => {
    e.preventDefault(); const sx = e.clientX, sw = right.offsetWidth; rz.classList.add("active"); document.body.classList.add("resizing");
    const mv = (ev) => { right.style.width = Math.max(340, Math.min(window.innerWidth * 0.75, sw - (ev.clientX - sx))) + "px"; };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); rz.classList.remove("active"); document.body.classList.remove("resizing"); LS.set("size.rvRight", right.offsetWidth); ed.view.requestMeasure(); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };
  rz.ondblclick = () => { right.style.width = ""; LS.set("size.rvRight", null); };
})();

/* ---------- keyboard (only while the RISC-V tab is showing) */
window.addEventListener("keydown", (e) => {
  if (!el("#tab-riscv").classList.contains("active")) return;
  if (!el("#palette").hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  let f = null;
  if (e.key === "F5" && mod && e.shiftKey) f = reset;
  else if (e.key === "F5") f = () => R.running ? (stop(), refresh(true)) : run();
  else if (e.key === "F7") f = () => assemble();
  else if (e.key === "F11" && e.shiftKey) f = stepBack;
  else if (e.key === "F11") f = stepOnce;
  else if (e.key === "F10" && e.shiftKey) f = () => run("out");
  else if (e.key === "F10") f = () => run("over");
  else if (mod && !e.shiftKey && e.key.toLowerCase() === "s") f = () => save();
  else if (mod && e.shiftKey && e.key.toLowerCase() === "s") f = () => save(true);
  else if (mod && e.key.toLowerCase() === "o") f = () => openFile();
  else if (e.key === "Escape" && R.running) f = () => { stop(); refresh(true); };
  if (!f) return;
  e.preventDefault(); e.stopImmediatePropagation();
  f();
}, true);

// redraw the editor when the tab becomes visible
document.querySelector('#tabs button[data-tab="riscv"]').addEventListener("click", () => requestAnimationFrame(() => ed.view.requestMeasure()));

if (typeof COMMANDS !== "undefined") {
  COMMANDS.push(["RISC-V: Assemble", "F7", () => { showTab("riscv"); assemble(); }, "⟨⟩"]);
  COMMANDS.push(["RISC-V: Run", "F5", () => { showTab("riscv"); run(); }, "▶"]);
  COMMANDS.push(["RISC-V: Open program…", "", () => { showTab("riscv"); openFile(); }, "📂"]);
  COMMANDS.push(["RISC-V: Load example program", "", () => { showTab("riscv"); ed.setDoc(EXAMPLE); R.dirty = true; renderFile(); assemble(); }, "✎"]);
}
window.addEventListener("beforeunload", (e) => { if (R.dirty && R.path) { e.preventDefault(); e.returnValue = ""; } });

if (R.path && !R.dirty) renderFile();
refresh(true);
})();
