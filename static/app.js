/* SV Studio – application logic */
"use strict";

const $ = (s) => document.querySelector(s);
// Settings and UI state are kept by the backend in ~/.svstudio/ui-state.json (the window's own
// storage can be wiped between runs), with localStorage as a fallback/migration source.
const LS = (() => {
  const mem = (window.SVS_STATE && typeof window.SVS_STATE === "object") ? window.SVS_STATE : {};
  let pending = {}, timer = null;
  const fromLocal = (k) => { try { const v = localStorage.getItem("svs." + k); return v === null ? undefined : JSON.parse(v); } catch (e) { return undefined; } };
  function flush(beacon) {
    clearTimeout(timer); timer = null;
    if (!Object.keys(pending).length) return;
    const body = JSON.stringify({ set: pending });
    pending = {};
    const url = "/api/state?token=" + encodeURIComponent(window.SVS_TOKEN);
    if (beacon && navigator.sendBeacon) { try { navigator.sendBeacon(url, new Blob([body], { type: "text/plain" })); return; } catch (e) {} }
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-SVS-Token": window.SVS_TOKEN }, body, keepalive: body.length < 60000 }).catch(() => {});
  }
  // first run with the state folder: copy over anything the old localStorage-only version saved
  if (!Object.keys(mem).length) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("svs.")) { const v = fromLocal(k.slice(4)); if (v !== undefined && v !== null) { mem[k.slice(4)] = v; pending[k.slice(4)] = v; } }
      }
      if (Object.keys(pending).length) timer = setTimeout(() => flush(false), 1000);
    } catch (e) {}
  }
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("beforeunload", () => flush(true));
  return {
    get(k, d) {
      if (Object.prototype.hasOwnProperty.call(mem, k)) return mem[k] === null ? d : mem[k];
      const v = fromLocal(k); return v === undefined || v === null ? d : v;
    },
    set(k, v) {
      if (v === undefined) v = null;
      mem[k] = v;
      try { localStorage.setItem("svs." + k, JSON.stringify(v)); } catch (e) {}
      pending[k] = v;
      if (!timer) timer = setTimeout(() => flush(false), 500);
    },
    flush,
  };
})();

const S = { project: null, tools: {}, config: {}, job: null, since: 0, file: null, dirty: false, errors: 0, warnings: 0, diags: new Map() };

/* ---------------------------------------------------------------- api */
async function api(path, body) {
  const opt = { headers: { "X-SVS-Token": window.SVS_TOKEN } };
  if (body !== undefined) { opt.method = "POST"; opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, opt);
  const ct = r.headers.get("Content-Type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || r.statusText);
  return data;
}

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, kind === "err" ? 6000 : 3000);
  setTimeout(() => t.remove(), kind === "err" ? 6400 : 3400);
}
const status = (t) => { $("#statusText").textContent = t; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const basename = (p) => (p || "").replace(/\\/g, "/").split("/").pop();

/* ---------------------------------------------------------------- tabs */
function showTab(name) {
  document.body.dataset.tab = name;
  LS.set("ui.tab", name);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "wave") wave.draw();
  if (name === "editor") syncEditor();
}
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ---------------------------------------------------------------- tools / status */
function renderTools() {
  const t = S.tools, chips = $("#toolChips");
  const items = [["Questa", t.questa], ["Verilator", t.verilator], ["Icarus", t.icarus], ["Vivado", t.vivado], ["VS Code", t.vscode]];
  chips.innerHTML = items.map(([n, p]) => `<span class="chip ${p ? "on" : ""}" title="${esc(p || "not found")}">${n}</span>`).join("");
  const sel = $("#selBackend");
  [["questa", t.questa], ["verilator", t.verilator], ["icarus", t.icarus]].forEach(([v, p]) => {
    const o = sel.querySelector(`option[value=${v}]`);
    o.textContent = { questa: "Questa", verilator: "Verilator", icarus: "Icarus" }[v] + (p ? "" : " (not found)");
  });
  let be = LS.get("backend", null);
  if (!be) be = t.questa ? "questa" : t.verilator ? "verilator" : t.icarus ? "icarus" : "questa";
  sel.value = be;
}
$("#selBackend").onchange = (e) => LS.set("backend", e.target.value);

/* ---------------------------------------------------------------- project */
function renderProject() {
  const p = S.project;
  $("#projDot").classList.toggle("on", !!p);
  $("#projName").textContent = p ? p.name : "No project open";
  const full = p ? (p.mpf || p.root).replace(/\\/g, "/") : "";
  const parts = full.split("/");
  $("#projPath").textContent = p ? (parts.length > 4 ? "…/" + parts.slice(-3).join("/") : full) : "Click to open a Questa .mpf or folder";
  $("#projPill").title = p ? full + "\nClick to open another project" : "Open a project";
  document.title = p ? `${p.name} · SV Studio` : "SV Studio";
  const fl = $("#fileList"), ml = $("#modList"), sel = $("#selTop");
  editor.setProject(p);
  if (!p) { fl.innerHTML = '<li class="empty">No project open</li>'; ml.innerHTML = ""; return; }
  fl.innerHTML = "";
  if (!p.files.length) fl.innerHTML = '<li class="empty">No HDL files found</li>';
  const groups = new Map();
  p.files.forEach(f => { const g = f.group || ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); });
  const gnames = [...groups.keys()].sort((a, b) => (a === "") ? -1 : (b === "") ? 1 : a.localeCompare(b));
  const showHeaders = gnames.length > 1 || (gnames.length === 1 && gnames[0] !== "");
  gnames.forEach((g) => {
    const key = "fold." + p.root + "|" + g;
    const collapsed = LS.get(key, false);
    if (showHeaders && g !== "") {
      const h = document.createElement("li");
      h.className = "folder" + (collapsed ? " collapsed" : "");
      h.innerHTML = `<span class="caret">${collapsed ? "▸" : "▾"}</span>
        <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span class="fname"></span><span class="count">${groups.get(g).length}</span>`;
      h.querySelector(".fname").textContent = g;
      h.title = g;
      h.onclick = () => { LS.set(key, !collapsed); renderProject(); };
      fl.appendChild(h);
    }
    if (collapsed && g !== "") return;
    groups.get(g).forEach((f) => {
      const li = document.createElement("li");
      li.className = (showHeaders && g !== "" ? "in-folder " : "") + (f.exists ? "" : "missing ") + (S.file && norm(S.file) === norm(f.path) ? "active" : "");
      li.title = f.path + (f.exists ? "" : "\n(file not found)");
      li.innerHTML = `<span class="ord">${f.kind === "header" ? "·" : f.order + 1}</span><span class="kind ${f.kind}">${f.kind === "header" ? "inc" : f.kind}</span>
        <span class="fname"></span>
        <button class="row-act" title="Open in VS Code"><svg viewBox="0 0 24 24"><path d="M14 3h7v7M10 14L21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg></button>`;
      li.querySelector(".fname").textContent = (g !== "" && f.rel.startsWith(g + "/")) ? f.rel.slice(g.length + 1) : f.rel;
      li.onclick = (e) => {
        if (e.target.closest(".row-act") || e.ctrlKey || e.metaKey) { openInCode(f.path); return; }
        if (f.exists) openFile(f.path);
      };
      fl.appendChild(li);
    });
  });
  // modules
  ml.innerHTML = "";
  if (!p.modules.length) ml.innerHTML = '<li class="empty">No modules found</li>';
  p.modules.forEach((m) => {
    const li = document.createElement("li");
    const isTop = p.tops.includes(m.name);
    li.className = isTop ? "is-top" : "";
    li.innerHTML = `<span class="mname"></span>${isTop ? '<span class="tag">top</span>' : ""}`;
    li.querySelector(".mname").textContent = m.name;
    li.title = `${m.name} — ${basename(m.file)}\nClick to use as top · double-click to open`;
    li.onclick = () => { sel.value = m.name; if (sel.value !== m.name) { sel.add(new Option(m.name, m.name)); sel.value = m.name; } LS.set("top." + p.root, m.name); };
    li.ondblclick = () => openFile(m.file, m.line);
    ml.appendChild(li);
  });
  // top select
  const saved = LS.get("top." + p.root, null);
  const names = [...p.tops, ...p.modules.map(m => m.name).filter(n => !p.tops.includes(n))];
  sel.innerHTML = names.length ? "" : '<option value="">—</option>';
  names.forEach(n => sel.add(new Option(n + (p.tops.includes(n) ? "" : " (sub)"), n)));
  sel.value = names.includes(saved) ? saved : (p.tops[0] || names[0] || "");
  const rt = LS.get("runtime." + p.root, null);
  if (rt) $("#inpRun").value = rt;
}
$("#selTop").onchange = (e) => S.project && LS.set("top." + S.project.root, e.target.value);
$("#inpRun").onchange = (e) => S.project && LS.set("runtime." + S.project.root, e.target.value);

async function openProject(path) {
  if (!path) return;
  try {
    status("Opening project…");
    S.project = await api("/api/open", { path });
    renderProject();
    $("#dlgOpen").close();
    status(`Opened ${S.project.name} · ${S.project.files.length} files`);
    toast(`Opened ${S.project.name}`, "ok");
    const last = LS.get("vcd." + S.project.root, null);
    if (last) loadVCD(last, true);
    const cur = LS.get("ui.tab", "console");
    await restoreEdTabs();
    showTab(cur);
  } catch (e) { toast(e.message, "err"); status("Ready"); }
}

function showOpenDialog() {
  const recent = S.config.recent || [];
  const ul = $("#recentList");
  ul.innerHTML = recent.length ? "" : '<li class="empty">Nothing yet</li>';
  recent.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r; li.title = r;
    li.onclick = () => openProject(r);
    ul.appendChild(li);
  });
  $("#openPath").value = S.project ? (S.project.mpf || S.project.root) : "";
  $("#dlgOpen").showModal();
  $("#openPath").focus();
}
$("#projPill").onclick = showOpenDialog;
$("#btnWelcomeOpen").onclick = showOpenDialog;
$("#openGo").onclick = () => openProject($("#openPath").value.trim());
$("#openPath").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); openProject(e.target.value.trim()); } };
async function browse(kind) {
  try {
    const r = await api("/api/browse", { kind });
    if (r.path) { if (kind === "vcd") return r.path; $("#openPath").value = r.path; openProject(r.path); }
  } catch (e) { toast(e.message, "err"); }
  return null;
}
$("#browseFile").onclick = () => browse("file");
$("#browseDir").onclick = () => browse("dir");
$("#btnReload").onclick = async () => {
  if (!S.project) return;
  try { S.project = await api("/api/reload", {}); renderProject(); toast("Project reloaded"); } catch (e) { toast(e.message, "err"); }
};
$("#btnCodeFolder").onclick = () => openInCode(null);

async function openInCode(path, line) {
  try { await api("/api/vscode", { path, line }); status(path ? `Opened ${basename(path)} in VS Code` : "Opened project in VS Code"); }
  catch (e) { toast(e.message, "err"); }
}

/* ---------------------------------------------------------------- console & jobs */
const LOC_RE = /(?<![\w.\/\\-])((?:[A-Za-z]:)?[\w.\-\/\\]+\.(?:sv|svh|v|vh|vhd|vhdl))(?:\((\d+)\)|:(\d+)(?::(\d+))?)/g;

function classify(line) {
  if (line.c === "cmd") return "cmd";
  if (line.c === "done-ok") return "okl";
  if (line.c === "done-err") return "err summary";
  if (line.c === "info") return "info";
  const t = line.t;
  if (line.c === "err" || /\*\* (Error|Fatal)|%Error|\berror\b(?!s?:\s*0)|Fatal:|\bFAIL(ED)?\b/i.test(t) && !/Errors: 0/.test(t)) return "err";
  if (line.c === "warn" || /\*\* Warning|%Warning|\bwarning\b/i.test(t)) return "warn";
  if (/\bPASS(ED)?\b/.test(t)) return "pass";
  return "";
}

function appendLines(lines) {
  const con = $("#console");
  const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const d = document.createElement("div");
    const cls = classify(l);
    d.className = "ln " + cls;
    if (cls === "err" && !/Exiting due to|error\(s\) during|^\s*Errors?:/i.test(l.t)) S.errors++;
    if (cls === "warn") S.warnings++;
    let html = "", last = 0;
    const t = l.t;
    LOC_RE.lastIndex = 0;
    let m;
    let firstLoc = true;
    while ((m = LOC_RE.exec(t))) {
      html += esc(t.slice(last, m.index));
      const ln = m[2] || m[3];
      if (firstLoc && (cls === "err" || cls === "warn") && !/Exiting due to|Location of module/.test(t)) {
        const msg = t.replace(/^#\s*/, "").replace(m[0], "").replace(/^[\s%*:]+/, "").replace(/^\s*:\s*/, "");
        addDiagnostic(m[1], +ln, m[4] ? +m[4] : null, cls === "err" ? "error" : "warning", msg.trim() || t.trim());
      }
      firstLoc = false;
      html += `<a class="loc" data-path="${esc(m[1])}" data-line="${ln}" data-col="${m[4] || ""}" title="Click: open here · Ctrl+click: open in VS Code">${esc(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    html += esc(t.slice(last));
    d.innerHTML = html || "&nbsp;";
    frag.appendChild(d);
  }
  con.appendChild(frag);
  if (atBottom) con.scrollTop = con.scrollHeight;
  const b = $("#consoleBadge");
  if (S.errors) { b.hidden = false; b.className = "badge"; b.textContent = S.errors; }
  else if (S.warnings) { b.hidden = false; b.className = "badge warn"; b.textContent = S.warnings; }
  else b.hidden = true;
}

$("#console").addEventListener("click", (e) => {
  const a = e.target.closest("a.loc");
  if (!a) return;
  const p = resolveLoc(a.dataset.path);
  const line = +a.dataset.line;
  if (e.ctrlKey || e.metaKey || !p.inProject) openInCode(p.path, line);
  else openFile(p.path, line, null, a.dataset.col ? +a.dataset.col : null);
});

function resolveLoc(path) {
  const pr = S.project;
  let full = path.replace(/\\/g, "/");
  if (pr && !/^([A-Za-z]:)?\//.test(full)) full = pr.root.replace(/\\/g, "/") + "/" + full.replace(/^\.\//, "");
  if (pr) {
    const hit = pr.files.find(f => norm(f.path) === norm(full)) || pr.files.find(f => basename(f.path).toLowerCase() === basename(full).toLowerCase());
    if (hit) return { path: hit.path, inProject: true };
  }
  return { path: full, inProject: false };
}

$("#btnClear").onclick = () => { $("#console").innerHTML = ""; S.errors = S.warnings = 0; $("#consoleBadge").hidden = true; };
$("#chkWrap").onchange = (e) => $("#console").classList.toggle("wrap", e.target.checked);

function setRunning(on, kind) {
  $("#btnRun").hidden = on; $("#btnStop").hidden = !on;
  $("#btnCompile").disabled = on;
  const chip = $("#jobChip");
  chip.className = "job-chip" + (on ? " running" : "");
  if (on) chip.textContent = kind === "compile" ? "Compiling…" : kind === "board" ? "Building board…" : kind === "timing" ? "Running Vivado…" : "Simulating…";
}

async function startJob(kind) {
  if (!S.project) { showOpenDialog(); return; }
  await saveAll();
  const top = $("#selTop").value;
  if (kind === "simulate" && !top) { toast("Pick a top-level module (your testbench) first.", "err"); return; }
  try {
    const r = await api("/api/" + kind, { backend: $("#selBackend").value, top, runtime: $("#inpRun").value.trim() || "-all" });
    S.project = r.project; renderProject();
    $("#console").innerHTML = ""; S.errors = S.warnings = 0;
    S.diags = new Map(); applyDiagnostics(); renderProblems();
    S.job = r.id; S.since = 0;
    setRunning(true, kind);
    showTab("console");
    status(kind === "compile" ? "Compiling…" : "Running simulation…");
    poll();
  } catch (e) { toast(e.message, "err"); }
}

async function poll() {
  if (!S.job) return;
  try {
    const r = await api(`/api/job?id=${S.job}&since=${S.since}`);
    if (r.lines.length) { appendLines(r.lines); applyDiagnostics(); }
    S.since = r.next;
    if (r.done) {
      S.job = null;
      setRunning(false);
      renderProblems();
      if (r.kind === "board") {
        const chip = $("#jobChip");
        chip.className = "job-chip " + (r.ok ? "ok" : "fail");
        chip.textContent = (r.ok ? "Board live" : "Board build failed") + ` · ${r.elapsed}s`;
        status(r.ok ? "Virtual lab board running" : "Board build failed" + (S.errors ? ` · ${S.errors} error(s)` : ""));
        if (window.onBoardBuilt) window.onBoardBuilt(r.ok);
        return;
      }
      if (r.kind === "timing") {
        const chip = $("#jobChip");
        chip.className = "job-chip " + (r.ok ? "ok" : "fail");
        chip.textContent = (r.ok ? "Timing done" : "Vivado failed") + ` · ${r.elapsed}s`;
        status(r.ok ? `Timing analysis finished in ${r.elapsed}s` : "Vivado run failed" + (S.errors ? ` · ${S.errors} error(s)` : ""));
        if (window.onTimingDone) window.onTimingDone(r.ok);
        return;
      }
      const chip = $("#jobChip");
      chip.className = "job-chip " + (r.ok ? "ok" : "fail");
      chip.textContent = (r.ok ? "Succeeded" : "Failed") + ` · ${r.elapsed}s`;
      status(`${r.kind === "compile" ? "Compile" : "Simulation"} ${r.ok ? "succeeded" : "failed"} in ${r.elapsed}s` +
        (S.errors ? ` · ${S.errors} error(s)` : "") + (S.warnings ? ` · ${S.warnings} warning(s)` : ""));
      if (r.vcd) {
        await loadVCD(r.vcd);
        if (r.ok) showTab("wave");
      }
      if (!r.ok) toast(r.kind === "compile" ? "Compile failed — see console" : "Simulation failed — see console", "err");
      return;
    }
  } catch (e) { /* transient */ }
  setTimeout(poll, 200);
}

$("#btnCompile").onclick = () => startJob("compile");
$("#btnRun").onclick = () => startJob("simulate");
$("#btnStop").onclick = async () => { try { await api("/api/stop", {}); } catch (e) { toast(e.message, "err"); } };

/* ---------------------------------------------------------------- waveform */
const wave = new WaveViewer({
  tree: $("#tree"), names: $("#names"), waves: $("#waves"), axis: $("#axis"), scroll: $("#waveScroll"),
  filter: $("#treeFilter"), empty: $("#waveEmpty"), cursorLabel: $("#wCursor"),
  onChange: () => {
    const b = $("#waveBadge");
    b.hidden = !wave.data; b.textContent = wave.rows.length;
  },
});

async function loadVCD(path, quiet) {
  try {
    const text = await api("/api/vcd?path=" + encodeURIComponent(path));
    wave.load(text, path);
    const d = wave.data;
    $("#wInfo").textContent = `${basename(path)} · ${Object.keys(wave.vars).length} signals · ${fmtTime(d.maxT, d.tsSec)}`;
    if (S.project) LS.set("vcd." + S.project.root, path);
  } catch (e) { if (!quiet) toast("Could not load waveform: " + e.message, "err"); }
}
$("#wOpen").onclick = async () => { const p = await browse("vcd"); if (p) { await loadVCD(p); showTab("wave"); } };
$("#wZoomIn").onclick = () => wave.zoom(1.5);
$("#wZoomOut").onclick = () => wave.zoom(1 / 1.5);
$("#wFit").onclick = () => wave.fit();
$("#wPrev").onclick = () => wave.edge(-1);
$("#wNext").onclick = () => wave.edge(1);
$("#wClear").onclick = () => wave.clearRows();

/* ---------------------------------------------------------------- editor (CodeMirror, tabs) */
S.tabs = [];
const findTab = (path) => S.tabs.find(t => norm(t.path) === norm(path));
const activeTab = () => (S.file ? findTab(S.file) : null);
const anyDirty = () => S.tabs.some(t => t.dirty);

const editor = SVEditor.create($("#cmHost"), {
  onChange: () => {
    const t = activeTab();
    if (t && !S.loadingDoc && !t.dirty) { t.dirty = true; renderTabs(); }
    if (!S.loadingDoc && window.onEditorChange) window.onEditorChange();
  },
  onCursor: (ln, col) => { $("#edPos").textContent = `Ln ${ln}, Col ${col}`; },
  onGoto: ({ module }) => openFile(module.file, module.line),
  onSave: () => saveFile(),
  hooks: {
    waveValues: (word) => waveMatches(word).filter(() => wave.cursor !== null).map(v => ({
      full: v.full, value: waveValueAt(v, wave.cursor), timeLabel: "Waveform @ " + fmtTime(wave.cursor, wave.data.tsSec),
    })),
    canAddWave: (word) => waveMatches(word).some(v => !wave.rows.some(r => r.full === v.full)),
    addToWave: (word) => addWordToWave(word),
    gotoLine: () => openPalette(":"),
  },
});
function syncEditor() { requestAnimationFrame(() => editor.view.requestMeasure()); }

function rememberEdTabs() {
  if (!S.project || S.restoringTabs) return;
  LS.set("edtabs." + S.project.root, { files: S.tabs.map(t => t.path), active: S.file });
}
async function restoreEdTabs() {
  if (!S.project) return;
  const saved = LS.get("edtabs." + S.project.root, null);
  if (!saved || !saved.files || !saved.files.length) return;
  S.restoringTabs = true;
  try {
    for (const p of saved.files) { if (!findTab(p)) { try { const r = await api("/api/file?path=" + encodeURIComponent(p)); S.tabs.push({ path: p, state: editor.makeState(r.text), dirty: false, mtime: r.mtime }); } catch (e) {} } }
    const act = (saved.active && findTab(saved.active)) || S.tabs[0];
    if (act) { const tab = LS.get("ui.tab", "console"); activate(act); showTab(tab); }
  } finally { S.restoringTabs = false; }
}
function renderTabs() {
  rememberEdTabs();
  const box = $("#edTabs");
  box.innerHTML = "";
  for (const t of S.tabs) {
    const f = S.project && S.project.files.find(x => norm(x.path) === norm(t.path));
    const d = document.createElement("div");
    const errs = (S.diags.get(norm(t.path)) || { items: [] }).items.some(x => x.severity === "error");
    d.className = "ed-tab" + (S.file && norm(t.path) === norm(S.file) ? " active" : "") + (t.dirty ? " dirty" : "") + (errs ? " has-err" : "");
    d.title = (f ? f.rel : t.path) + (t.dirty ? " (unsaved)" : "");
    d.innerHTML = `<span class="kind ${f ? f.kind : "sv"}">${f ? (f.kind === "header" ? "inc" : f.kind) : "sv"}</span><span class="tname"></span><span class="x" title="Close">×</span>`;
    d.querySelector(".tname").textContent = basename(t.path);
    d.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } };
    d.onclick = (e) => { if (e.target.classList.contains("x")) closeTab(t); else activate(t); };
    box.appendChild(d);
    if (d.classList.contains("active")) setTimeout(() => d.scrollIntoView({ block: "nearest", inline: "nearest" }), 0);
  }
  const t = activeTab();
  $("#btnSave").disabled = !(t && t.dirty);
  $("#btnEdCode").disabled = $("#btnFormat").disabled = !t;
  $("#cmEmpty").hidden = !!t;
  const b = $("#editorBadge");
  const dirtyN = S.tabs.filter(x => x.dirty).length;
  b.hidden = !S.tabs.length; b.textContent = S.tabs.length + (dirtyN ? ` · ${dirtyN}●` : "");
  renderExtBanner();
}

function activate(tab) {
  const cur = activeTab();
  if (cur && cur !== tab) cur.state = editor.state;
  S.loadingDoc = true;
  editor.swap(tab.state);
  S.loadingDoc = false;
  S.file = tab.path;
  applyDiagnostics();
  renderTabs();
  renderProject();
  const head = editor.state.selection.main.head, line = editor.state.doc.lineAt(head);
  $("#edPos").textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
  showTab("editor");
  editor.focus();
}

async function openFile(path, line, findRe, col) {
  try {
    let tab = findTab(path);
    if (!tab) {
      const r = await api("/api/file?path=" + encodeURIComponent(path));
      tab = { path, state: editor.makeState(r.text), dirty: false, mtime: r.mtime };
      const cur = activeTab();
      const at = cur ? S.tabs.indexOf(cur) + 1 : S.tabs.length;
      S.tabs.splice(at, 0, tab);
    }
    activate(tab);
    if (findRe && !line) {
      const idx = editor.getDoc().search(findRe);
      if (idx >= 0) line = editor.getDoc().slice(0, idx).split("\n").length;
    }
    if (line) setTimeout(() => editor.gotoLine(line, col), 30);
  } catch (e) { S.loadingDoc = false; toast(e.message, "err"); }
}

function closeTab(tab) {
  if (tab.dirty && !confirm(`${basename(tab.path)} has unsaved changes. Close it anyway and lose them?`)) return;
  const i = S.tabs.indexOf(tab);
  const wasActive = tab === activeTab();
  S.tabs.splice(i, 1);
  if (wasActive) {
    const next = S.tabs[i] || S.tabs[i - 1];
    if (next) { S.file = null; activate(next); }
    else { S.file = null; S.loadingDoc = true; editor.swap(editor.makeState("")); S.loadingDoc = false; renderTabs(); renderProject(); $("#edPos").textContent = ""; }
  } else renderTabs();
}

async function saveFile(tab) {
  tab = tab || activeTab();
  if (!tab) return;
  const isActive = tab === activeTab();
  const text = isActive ? editor.getDoc() : tab.state.doc.toString();
  try {
    const r = await api("/api/save", { path: tab.path, text });
    tab.dirty = false; tab.mtime = r.mtime; tab.conflict = false;
    if (isActive) tab.state = editor.state;
    renderTabs();
    status(`Saved ${basename(tab.path)}`);
    if (window.onEditorChange) window.onEditorChange(0);
  } catch (e) { toast("Save failed: " + e.message, "err"); }
}
async function saveAll() { for (const t of S.tabs.filter(x => x.dirty)) await saveFile(t); }

$("#btnSave").onclick = () => saveFile();
$("#btnFormat").onclick = () => { editor.format(); editor.focus(); };
$("#btnEdCode").onclick = async () => {
  const t = activeTab(); if (!t) return;
  if (t.dirty) await saveFile(t);
  openInCode(t.path, editor.cursorLine());
};

/* files changed outside SV Studio (e.g. in VS Code) */
async function checkExternalChanges() {
  if (document.visibilityState !== "visible" || !S.tabs.length || S.checking) return;
  S.checking = true;
  try {
    const m = await api("/api/mtimes", { paths: S.tabs.map(t => t.path) });
    for (const t of [...S.tabs]) {
      const mt = m[t.path];
      if (!mt || !t.mtime || mt <= t.mtime + 0.0005) continue;
      if (t.dirty) { if (!t.conflict) { t.conflict = mt; renderExtBanner(); } continue; }
      await reloadTab(t, true);
    }
  } catch (e) { /* ignore */ }
  S.checking = false;
}
async function reloadTab(t, quiet) {
  const r = await api("/api/file?path=" + encodeURIComponent(t.path));
  const isActive = t === activeTab();
  const line = isActive ? editor.cursorLine() : null;
  t.state = editor.makeState(r.text); t.mtime = r.mtime; t.dirty = false; t.conflict = false;
  if (isActive) {
    S.loadingDoc = true; editor.swap(t.state); S.loadingDoc = false;
    applyDiagnostics();
    if (line) editor.gotoLine(line);
  }
  renderTabs();
  if (quiet) toast(`Reloaded ${basename(t.path)} (changed on disk)`);
}
function renderExtBanner() {
  const t = activeTab();
  const show = !!(t && t.conflict);
  $("#extBanner").hidden = !show;
  if (show) $("#extMsg").textContent = `${basename(t.path)} was changed outside SV Studio, and you also have unsaved edits here.`;
}
$("#extReload").onclick = () => { const t = activeTab(); if (t) reloadTab(t, false); };
$("#extKeep").onclick = () => { const t = activeTab(); if (t) { t.mtime = t.conflict; t.conflict = false; renderExtBanner(); } };
setInterval(checkExternalChanges, 2000);
window.addEventListener("focus", checkExternalChanges);

/* compiler messages -> inline markers + Problems panel */
function addDiagnostic(path, line, col, severity, message) {
  const p = resolveLoc(path);
  const key = norm(p.path);
  if (!S.diags.has(key)) S.diags.set(key, { path: p.path, inProject: p.inProject, items: [] });
  const list = S.diags.get(key).items;
  if (!list.some(d => d.line === line && d.message === message)) list.push({ line, col, severity, message });
}
// compile/simulate diagnostics (S.diags) merged with live-check diagnostics (S.lint)
function allDiagGroups() {
  const m = new Map();
  for (const [k, g] of S.diags) m.set(k, { path: g.path, inProject: g.inProject, items: [...g.items] });
  for (const [k, g] of (S.lint || new Map())) {
    if (!m.has(k)) m.set(k, { path: g.path, inProject: true, items: [] });
    const t = m.get(k).items;
    g.items.forEach(d => { if (!t.some(x => x.line === d.line && x.message === d.message)) t.push(d); });
  }
  return [...m.values()];
}
function applyDiagnostics() {
  if (S.file) {
    const g = allDiagGroups().find(x => norm(x.path) === norm(S.file));
    editor.setDiagnostics(g ? g.items : []);
  }
  renderProblemsSoon();
}
function renderProblemsSoon() {
  if (S._probRaf) return;
  S._probRaf = requestAnimationFrame(() => { S._probRaf = null; renderProblems(); renderTabs(); });
}
function renderProblems() {
  const box = $("#problems");
  const groups = allDiagGroups().filter(g => g.items.length);
  let nErr = 0, nWarn = 0;
  groups.forEach(g => g.items.forEach(d => d.severity === "error" ? nErr++ : nWarn++));
  const b = $("#problemsBadge");
  b.hidden = !(nErr + nWarn);
  b.className = "badge" + (nErr ? "" : " warn");
  b.textContent = nErr + nWarn;
  if (!groups.length) {
    box.innerHTML = `<div class="empty-big">${S.job ? "Running…" : "No problems detected in the last run."}</div>`;
    return;
  }
  box.innerHTML = "";
  groups.sort((a, b) => (b.items.some(d => d.severity === "error") - a.items.some(d => d.severity === "error")) || a.path.localeCompare(b.path));
  for (const g of groups) {
    const f = S.project && S.project.files.find(x => norm(x.path) === norm(g.path));
    const h = document.createElement("div");
    h.className = "pfile";
    h.innerHTML = `<span>${esc(basename(g.path))}</span><span class="path">${esc(f ? f.rel : g.path)}</span><span class="cnt">${g.items.length}</span>`;
    h.onclick = () => g.inProject ? openFile(g.path, g.items[0].line, null, g.items[0].col) : openInCode(g.path, g.items[0].line);
    box.appendChild(h);
    g.items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.line - b.line);
    for (const d of g.items) {
      const it = document.createElement("div");
      it.className = "pitem " + d.severity;
      it.innerHTML = `<span class="sev">${d.severity === "error" ? "✖" : "⚠"}</span><span class="msg"></span><span class="ln">Ln ${d.line}${d.col ? ":" + d.col : ""}</span>`;
      it.querySelector(".msg").textContent = d.message;
      it.title = "Click to open · Ctrl+click to open in VS Code";
      it.onclick = (e) => (e.ctrlKey || e.metaKey || !g.inProject) ? openInCode(g.path, d.line) : openFile(g.path, d.line, null, d.col);
      box.appendChild(it);
    }
  }
}

/* editor -> waveform */
function leafName(full) { return full.split(".").pop().replace(/\[\d+\]$/, ""); }
function waveMatches(word) {
  if (!wave.data || !word) return [];
  return Object.values(wave.vars).filter(v => leafName(v.full) === word).slice(0, 8);
}
function waveValueAt(v, t) {
  const sg = wave.data.sigs[v.id];
  const k = bsearch(sg.t, t);
  const row = wave.rows.find(r => r.full === v.full);
  return fmtValue(k >= 0 ? sg.v[k] : "x", v.width, row ? row.radix : (v.width > 1 ? "hex" : "bin"));
}
function addWordToWave(word) {
  if (!wave.data) { toast("Run a simulation first, then you can add signals to the waveform."); return; }
  const ms = waveMatches(word).filter(v => !wave.rows.some(r => r.full === v.full)).slice(0, 4);
  if (!ms.length) { toast(waveMatches(word).length ? `'${word}' is already in the waveform` : `No signal called '${word}' in the current waveform`); return; }
  ms.forEach(v => wave.addVar(v.full));
  toast(`Added ${ms.map(v => v.full).join(", ")} to the waveform`, "ok");
}

/* ---------------------------------------------------------------- quick open / command palette */
const COMMANDS = [
  ["Simulate", "F5", () => startJob("simulate"), "▶"],
  ["Compile", "F7", () => startJob("compile"), "⟨⟩"],
  ["Stop simulation", "", () => api("/api/stop", {}), "■"],
  ["Open project…", "Ctrl+O", () => showOpenDialog(), "📂"],
  ["Reload project", "", () => $("#btnReload").click(), "↻"],
  ["Open project folder in VS Code", "", () => openInCode(null), "↗"],
  ["Open current file in VS Code", "", () => $("#btnEdCode").click(), "↗"],
  ["Save file", "Ctrl+S", () => saveFile(), "💾"],
  ["Save all files", "Ctrl+Shift+S", () => saveAll(), "💾"],
  ["Format document", "Shift+Alt+F", () => { editor.format(); editor.focus(); }, "≡"],
  ["Close editor tab", "", () => activeTab() && closeTab(activeTab()), "×"],
  ["Close all saved tabs", "", () => { S.tabs.filter(t => !t.dirty).forEach(closeTab); }, "×"],
  ["Go to line…", "Ctrl+G", () => setTimeout(() => openPalette(":"), 0), ":"],
  ["Add signal under cursor to waveform", "Alt+W", () => addWordToWave(editor.wordAtCursor()), "∿"],
  ["Toggle sidebar", "Ctrl+B", () => toggleSidebar(), "▤"],
  ["Show Console", "", () => showTab("console"), "›"],
  ["Show Problems", "", () => showTab("problems"), "⚠"],
  ["Show Waveform", "", () => showTab("wave"), "∿"],
  ["Show Editor", "", () => showTab("editor"), "✎"],
  ["Waveform: zoom to fit", "F", () => { showTab("wave"); wave.fit(); }, "⤢"],
  ["Waveform: clear view", "", () => wave.clearRows(), "∿"],
  ["Waveform: open VCD file…", "", () => $("#wOpen").click(), "∿"],
  ["Clear console", "", () => $("#btnClear").click(), "⌫"],
  ["Simulator: Questa", "", () => { $("#selBackend").value = "questa"; LS.set("backend", "questa"); }, "⚙"],
  ["Simulator: Verilator", "", () => { $("#selBackend").value = "verilator"; LS.set("backend", "verilator"); }, "⚙"],
  ["Simulator: Icarus", "", () => { $("#selBackend").value = "icarus"; LS.set("backend", "icarus"); }, "⚙"],
  ["Settings", "", () => showSettings(), "⚙"],
];

function fuzzy(q, text) {
  if (!q) return { score: 0, idx: [] };
  const t = text.toLowerCase(), ql = q.toLowerCase();
  let ti = 0, score = 0, prev = -2;
  const idx = [];
  for (const ch of ql) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 6 : 1;
    if (found === 0 || /[\/._\- ]/.test(text[found - 1]) || (text[found] >= "A" && text[found] <= "Z")) score += 4;
    idx.push(found); prev = found; ti = found + 1;
  }
  const sub = t.indexOf(ql);
  if (sub >= 0) score += 20 + (sub === 0 ? 10 : 0);
  return { score: score - text.length * 0.02, idx };
}
function markText(text, idx) {
  if (!idx || !idx.length) return esc(text);
  const set = new Set(idx);
  return [...text].map((c, i) => set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c)).join("");
}

const P = { items: [], sel: 0 };
function openPalette(prefix) {
  $("#palette").hidden = false;
  const inp = $("#palInput");
  inp.value = prefix || "";
  inp.placeholder = "Go to file or module…   ( >  commands   :  line )";
  renderPalette();
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}
function closePalette() { $("#palette").hidden = true; }
function paletteItems(q) {
  if (q.startsWith(">")) {
    const qq = q.slice(1).trim();
    return COMMANDS.map(([label, key, run, ico]) => ({ label, key, run, ico, m: fuzzy(qq, label) }))
      .filter(x => x.m).sort((a, b) => b.m.score - a.m.score);
  }
  if (q.startsWith(":")) {
    const n = parseInt(q.slice(1), 10);
    const t = activeTab();
    if (!t) return [{ label: "Open a file first", none: true }];
    return [{ label: isNaN(n) ? `Type a line number (1–${editor.state.doc.lines})` : `Go to line ${n}`, ico: ":",
      run: isNaN(n) ? null : () => editor.gotoLine(n), sub: basename(t.path) }];
  }
  const out = [];
  const pr = S.project;
  if (!pr) return [{ label: "Open a project first (Ctrl+O)", ico: "📂", run: showOpenDialog }];
  const open = new Set(S.tabs.map(t => norm(t.path)));
  for (const f of pr.files) {
    const m = fuzzy(q, f.rel);
    if (m) out.push({ label: basename(f.rel), sub: f.rel, tag: open.has(norm(f.path)) ? "open" : f.kind, path: f.path, ico: "📄", m: { score: m.score + (open.has(norm(f.path)) ? 3 : 0), idx: m.idx.map(i => i - (f.rel.length - basename(f.rel).length)).filter(i => i >= 0) },
      run: () => openFile(f.path) });
  }
  for (const mo of pr.modules) {
    const m = fuzzy(q, mo.name);
    if (m) out.push({ label: mo.name, sub: `module · ${basename(mo.file)}:${mo.line}`, tag: "module", ico: "◆", m: { score: m.score + 1, idx: m.idx },
      run: () => openFile(mo.file, mo.line) });
  }
  if (!q) {   // recently used first
    out.sort((a, b) => (open.has(norm(b.path || "")) - open.has(norm(a.path || ""))));
    return out.filter(x => x.tag !== "module").concat(out.filter(x => x.tag === "module"));
  }
  return out.sort((a, b) => b.m.score - a.m.score).slice(0, 60);
}
function renderPalette() {
  const q = $("#palInput").value;
  P.items = paletteItems(q);
  P.sel = Math.min(P.sel, Math.max(0, P.items.length - 1));
  if (q !== P.lastQ) P.sel = 0;
  P.lastQ = q;
  const ul = $("#palList");
  ul.innerHTML = "";
  if (!P.items.length) { ul.innerHTML = '<li class="none">No matches</li>'; return; }
  P.items.forEach((it, i) => {
    const li = document.createElement("li");
    if (it.none) { li.className = "none"; li.textContent = it.label; ul.appendChild(li); return; }
    li.className = i === P.sel ? "sel" : "";
    li.innerHTML = `<span class="ico">${it.ico || ""}</span><span class="t">${markText(it.label, it.m && it.m.idx)}</span>` +
      (it.sub ? `<span class="sub">${esc(it.sub)}</span>` : '<span class="sub"></span>') +
      (it.tag ? `<span class="tag">${esc(it.tag)}</span>` : "") + (it.key ? `<kbd class="key">${esc(it.key)}</kbd>` : "");
    li.onmousemove = () => { if (P.sel !== i) { P.sel = i; ul.querySelectorAll("li").forEach((x, j) => x.classList.toggle("sel", j === i)); } };
    li.onclick = () => runPaletteItem(i);
    ul.appendChild(li);
  });
  const selEl = ul.children[P.sel];
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
}
function runPaletteItem(i) {
  const it = P.items[i];
  if (!it || !it.run) return;
  closePalette();
  it.run();
}
$("#palInput").addEventListener("input", renderPalette);
$("#palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); P.sel = Math.min(P.items.length - 1, P.sel + 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); P.sel = Math.max(0, P.sel - 1); renderPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPaletteItem(P.sel); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
});
$("#palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
$("#btnQuick").onclick = () => openPalette("");

/* ---------------------------------------------------------------- layout: resizable panels, sidebar toggle */
const SIZES = { sidebar: [".sidebar", 180, 520], tree: [".sig-tree", 150, 520], names: ["#waveMain", 160, 640] };
function applySize(kind, px) {
  const [sel, lo, hi] = SIZES[kind];
  px = Math.max(lo, Math.min(hi, px));
  if (kind === "names") $("#waveMain").style.setProperty("--names-w", px + "px");
  else $(sel).style.width = px + "px";
  return px;
}
Object.keys(SIZES).forEach(k => { const v = LS.get("size." + k, null); if (v) applySize(k, v); });
document.querySelectorAll(".resizer").forEach(r => {
  r.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const kind = r.dataset.resize;
    const startX = e.clientX;
    const startW = kind === "names" ? $("#names").offsetWidth : $(SIZES[kind][0]).offsetWidth;
    document.body.classList.add("resizing"); r.classList.add("active");
    let last = startW;
    const move = (ev) => { last = applySize(kind, startW + ev.clientX - startX); wave.draw(); };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing"); r.classList.remove("active");
      LS.set("size." + kind, last); wave.draw(); syncEditor();
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  r.addEventListener("dblclick", () => {      // reset to default size
    const kind = r.dataset.resize;
    LS.set("size." + kind, null);
    if (kind === "names") $("#waveMain").style.removeProperty("--names-w"); else $(SIZES[kind][0]).style.width = "";
    wave.draw(); syncEditor();
  });
});
function toggleSidebar() {
  const sb = $(".sidebar");
  sb.classList.toggle("collapsed");
  LS.set("sidebarHidden", sb.classList.contains("collapsed"));
  setTimeout(() => { wave.draw(); syncEditor(); }, 0);
}
if (LS.get("sidebarHidden", false)) $(".sidebar").classList.add("collapsed");

/* ---------------------------------------------------------------- settings */
function showSettings() {
  document.querySelectorAll("[data-cfg]").forEach(el => {
    const v = S.config[el.dataset.cfg];
    if (el.type === "checkbox") el.checked = !!v; else el.value = v || "";
  });
  const t = S.tools;
  $("#detected").innerHTML = `<b>Detected tools</b><br>` +
    `Questa:    ${esc(t.questa || "not found")}<br>Verilator: ${esc(t.verilator || "not found")}<br>` +
    `Icarus:    ${esc(t.icarus || "not found")}<br>VS Code:   ${esc(t.vscode || "not found")}`;
  $("#dlgSettings").showModal();
}
$("#btnSettings").onclick = showSettings;
$("#settingsSave").onclick = async () => {
  const body = {};
  document.querySelectorAll("[data-cfg]").forEach(el => body[el.dataset.cfg] = el.type === "checkbox" ? el.checked : el.value.trim());
  try {
    const r = await api("/api/config", body);
    S.config = r.config; S.tools = r.tools; renderTools();
    $("#dlgSettings").close();
    toast("Settings saved", "ok");
  } catch (e) { toast(e.message, "err"); }
};

/* ---------------------------------------------------------------- keyboard */
document.addEventListener("keydown", (e) => {
  if (!$("#palette").hidden) return;                       // palette handles its own keys
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === "F1" || (mod && e.shiftKey && k === "p")) { e.preventDefault(); openPalette(">"); return; }
  if (mod && !e.shiftKey && k === "p") { e.preventDefault(); openPalette(""); return; }
  if (mod && !e.shiftKey && k === "g") { e.preventDefault(); openPalette(":"); return; }
  if (e.defaultPrevented) return;                          // already handled by the editor
  if (e.key === "F5") { e.preventDefault(); if (!S.job) startJob("simulate"); return; }
  if (e.key === "F7") { e.preventDefault(); if (!S.job) startJob("compile"); return; }
  if (mod && !e.shiftKey && k === "s") { e.preventDefault(); saveFile(); return; }
  if (mod && e.shiftKey && k === "s") { e.preventDefault(); saveAll(); return; }
  if (mod && k === "o") { e.preventDefault(); showOpenDialog(); return; }
  if (mod && k === "b") { e.preventDefault(); toggleSidebar(); return; }
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (!inField && $("#tab-wave").classList.contains("active") && wave.key(e)) e.preventDefault();
});
window.addEventListener("beforeunload", (e) => { if (anyDirty()) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------------------------------------------------------- init */
(async function init() {
  try {
    const r = await api("/api/status");
    S.tools = r.tools; S.config = r.config;
    renderTools();
    if (r.project) {
      S.project = r.project; renderProject();
      const last = LS.get("vcd." + S.project.root, null);
      if (last) loadVCD(last, true);
      status(`Opened ${S.project.name}`);
      await restoreEdTabs();
    } else if ((S.config.recent || []).length && LS.get("ui.reopenProject", true)) {
      try {   // pick up where you left off: reopen the last project
        S.project = await api("/api/open", { path: S.config.recent[0] });
        renderProject();
        const last = LS.get("vcd." + S.project.root, null);
        if (last) loadVCD(last, true);
        status(`Reopened ${S.project.name}`);
        await restoreEdTabs();
      } catch (e) { S.project = null; status("Ready — open a project to start"); }
    } else if ((S.config.recent || []).length) {
      status("Ready — open a project to start");
    }
    showTab(LS.get("ui.tab", "console"));
  } catch (e) { toast("Cannot reach SV Studio backend: " + e.message, "err"); }
  setInterval(() => api("/api/ping").catch(() => status("Backend not running — restart SV Studio")), 20000);
  // closing the window shuts SV Studio down (a reload pings again straight away, which cancels this)
  let byeSent = false;
  const bye = () => { if (byeSent) return; byeSent = true; try { navigator.sendBeacon("/api/bye?token=" + window.SVS_TOKEN); } catch (e) {} };
  window.addEventListener("beforeunload", bye);
  window.addEventListener("pagehide", bye);
  window.addEventListener("pageshow", () => { byeSent = false; });
  try { new EventSource("/api/alive?token=" + window.SVS_TOKEN); } catch (e) {}
})();
