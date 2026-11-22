/* SV Studio – VCD parser and canvas waveform viewer */
"use strict";

const UNIT_SEC = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
const HIDE_SCOPES = new Set(["TOP", "svs_top"]);

function parseVCD(text) {
  const end = text.indexOf("$enddefinitions");
  if (end < 0) throw new Error("Not a VCD file (no $enddefinitions)");
  const head = text.slice(0, end).split(/\s+/).filter(Boolean);
  const root = { name: "", full: "", pfx: "", scopes: [], vars: [], type: "root" };
  const stack = [root];
  const sigs = {};
  let tsSec = 1e-9, tsLabel = "1ns";
  for (let i = 0; i < head.length; i++) {
    const tok = head[i];
    if (tok === "$timescale") {
      let s = "";
      while (head[++i] !== "$end" && i < head.length) s += head[i];
      const m = s.match(/^(\d+)\s*(s|ms|us|ns|ps|fs)$/);
      if (m) { tsSec = +m[1] * UNIT_SEC[m[2]]; tsLabel = m[1] + m[2]; }
    } else if (tok === "$scope") {
      const type = head[++i], name = head[++i];
      while (head[++i] !== "$end" && i < head.length);
      const parent = stack[stack.length - 1];
      const full = parent.pfx ? parent.pfx + "." + name : name;
      const sc = { name, type, full, pfx: (HIDE_SCOPES.has(name) && !parent.pfx) ? "" : full, scopes: [], vars: [] };
      parent.scopes.push(sc); stack.push(sc);
    } else if (tok === "$upscope") {
      while (head[++i] !== "$end" && i < head.length);
      if (stack.length > 1) stack.pop();
    } else if (tok === "$var") {
      const type = head[++i], width = parseInt(head[++i], 10), id = head[++i];
      let name = head[++i], range = "";
      while (head[++i] !== "$end" && i < head.length) range += head[i];
      if (range && !range.includes(":")) name += range;   // single bit of a bit-blasted vector
      const parent = stack[stack.length - 1];
      const v = { name, type, width, id, full: parent.pfx ? parent.pfx + "." + name : name };
      parent.vars.push(v);
      if (!sigs[id]) sigs[id] = { id, width, real: type === "real", t: [], v: [] };
    } else if (tok === "$comment" || tok === "$date" || tok === "$version") {
      while (head[++i] !== "$end" && i < head.length);
    }
  }

  // ---- value changes
  const body = text.slice(end);
  const toks = body.split(/\s+/);
  let t = 0, maxT = 0;
  const push = (id, val) => {
    const s = sigs[id];
    if (!s) return;
    const n = s.v.length;
    if (n && s.v[n - 1] === val) return;
    if (n && s.t[n - 1] === t) { s.v[n - 1] = val; return; }
    s.t.push(t); s.v.push(val);
  };
  for (let i = 1; i < toks.length; i++) {          // toks[0] = "$enddefinitions"
    const tk = toks[i];
    if (!tk) continue;
    const c = tk.charCodeAt(0);
    if (c === 35) { t = Number(tk.slice(1)); if (t > maxT) maxT = t; }           // '#'
    else if (c === 98 || c === 66) { push(toks[++i], tk.slice(1).toLowerCase()); } // 'b'
    else if (c === 114 || c === 82) { push(toks[++i], "r" + tk.slice(1)); }        // 'r'
    else if (c === 36) { if (tk === "$comment") while (toks[++i] !== "$end" && i < toks.length); } // '$'
    else { push(tk.slice(1), tk[0].toLowerCase()); }                               // scalar 0/1/x/z
  }

  // collapse wrapper scopes (Verilator "TOP", SV Studio "svs_top")
  let view = root;
  while (view.vars.length === 0 && view.scopes.length === 1 && (view === root || HIDE_SCOPES.has(view.name)))
    view = view.scopes[0];
  if (view !== root) {
    view = HIDE_SCOPES.has(view.name)
      ? { name: "", full: "", scopes: view.scopes, vars: view.vars, type: "root" }
      : { name: "", full: "", scopes: [view], vars: [], type: "root" };
  }
  return { root: view, sigs, maxT, tsSec, tsLabel };
}

/* ------------------------------------------------------------------ value formatting */
function normBits(val, width) {
  if (val.length >= width) return val.slice(val.length - width);
  const pad = (val[0] === "x" || val[0] === "z") ? val[0] : "0";
  return pad.repeat(width - val.length) + val;
}
function fmtValue(val, width, radix) {
  if (val === undefined || val === null) return "";
  if (val[0] === "r") return (+val.slice(1)).toPrecision(6).replace(/\.?0+$/, "");
  if (width <= 1 && radix !== "dec" && radix !== "sdec") return val;
  const bits = normBits(val, Math.max(width, 1));
  const hasXZ = /[xz]/.test(bits);
  if (radix === "bin") return bits;
  if (radix === "hex") {
    let out = "";
    for (let i = bits.length; i > 0; i -= 4) {
      const g = bits.slice(Math.max(0, i - 4), i);
      if (/x/.test(g)) out = (/^x+$/.test(g) ? "x" : "X") + out;
      else if (/z/.test(g)) out = (/^z+$/.test(g) ? "z" : "Z") + out;
      else out = parseInt(g, 2).toString(16) + out;
    }
    return out;
  }
  if (hasXZ) return /^z+$/.test(bits) ? "z" : "x";
  let n = BigInt("0b" + bits);
  if (radix === "sdec" && bits[0] === "1") n -= (1n << BigInt(bits.length));
  return n.toString();
}
function valueClass(val) {
  if (!val) return "";
  if (/^[x]+$|x/.test(val) && val[0] !== "r") return "x";
  if (/z/.test(val) && val[0] !== "r") return "z";
  return "";
}

function bsearch(arr, t) {           // index of last element <= t, or -1
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function fmtTime(ticks, tsSec, unitHint) {
  const sec = ticks * tsSec;
  const units = ["s", "ms", "us", "ns", "ps", "fs"];
  let u = unitHint;
  if (!u) {
    u = "fs";
    for (const k of units) { if (Math.abs(sec) >= UNIT_SEC[k] * 0.9999) { u = k; break; } }
    if (sec === 0) u = "ns";
  }
  let v = sec / UNIT_SEC[u];
  v = Math.round(v * 1000) / 1000;
  return v + " " + u.replace("us", "µs");
}

const PALETTE = ["#34d399", "#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#60a5fa", "#2dd4bf", "#fb923c"];

/* ------------------------------------------------------------------ viewer */
class WaveViewer {
  constructor(opts) {
    this.el = opts;
    this.data = null;
    this.rows = [];
    this.sel = -1;
    this.t0 = 0;
    this.scale = 1;     // px per tick
    this.cursor = null;
    this.path = null;
    this.ROW = 28;
    this.dpr = window.devicePixelRatio || 1;
    this.onChange = opts.onChange || (() => {});
    this._bind();
  }

  /* ---------- loading */
  load(text, path) {
    const prevPath = this.path, prevRows = this.rows.map(r => ({ full: r.full, radix: r.radix }));
    const prevView = { t0: this.t0, scale: this.scale, cursor: this.cursor };
    this.data = parseVCD(text);
    this.path = path;
    this.vars = {};
    const walk = (sc) => { sc.vars.forEach(v => this.vars[v.full] = v); sc.scopes.forEach(walk); };
    walk(this.data.root);
    let wanted = this._loadSaved(path);
    if (!wanted && prevPath === path && prevRows.length) wanted = prevRows;
    this.rows = [];
    if (wanted) wanted.forEach(w => { const v = this.vars[w.full]; if (v) this._addRow(v, w.radix); });
    if (!this.rows.length) this._defaultRows();
    const keepView = prevPath === path && prevView.scale > 0 && this.data.maxT > 0;
    if (keepView) { this.t0 = prevView.t0; this.scale = prevView.scale; this.cursor = prevView.cursor; }
    else { this.cursor = null; this.fit(); }
    this.sel = this.rows.length ? 0 : -1;
    this.renderTree();
    this.renderNames();
    this.draw();
    this._save();
    this.onChange();
  }

  _defaultRows() {
    const root = this.data.root;
    const first = root.vars.length ? root : (root.scopes[0] || root);
    first.vars.slice(0, 24).forEach(v => this._addRow(v));
    if (this.rows.length < 8 && first.scopes) {
      for (const sc of first.scopes) {
        for (const v of sc.vars) { if (this.rows.length >= 18) break; this._addRow(v); }
        if (this.rows.length >= 18) break;
      }
    }
  }

  _addRow(v, radix) {
    if (this.rows.some(r => r.full === v.full)) return false;
    this.rows.push({
      full: v.full, name: v.name, id: v.id, width: v.width,
      radix: radix || (v.width > 1 ? "hex" : "bin"),
      color: v.width > 1 ? "var(--wavebus)" : PALETTE[0],
    });
    return true;
  }

  addVar(full) { const v = this.vars[full]; if (v && this._addRow(v)) { this.sel = this.rows.length - 1; this._changed(); } }
  addScope(sc) { let n = 0; sc.vars.forEach(v => { if (this._addRow(v)) n++; }); if (n) this._changed(); }
  removeRow(i) { this.rows.splice(i, 1); if (this.sel >= this.rows.length) this.sel = this.rows.length - 1; this._changed(); }
  clearRows() { this.rows = []; this.sel = -1; this._changed(); }
  _changed() { this.renderNames(); this.renderTree(); this.draw(); this._save(); this.onChange(); }

  _key(path) { return "svs.wave." + (path || ""); }
  _save() {
    if (!this.path) return;
    try { localStorage.setItem(this._key(this.path), JSON.stringify(this.rows.map(r => ({ full: r.full, radix: r.radix })))); } catch (e) {}
  }
  _loadSaved(path) {
    try { const s = localStorage.getItem(this._key(path)); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  /* ---------- tree */
  renderTree() {
    const tree = this.el.tree;
    tree.innerHTML = "";
    if (!this.data) { tree.innerHTML = '<div class="empty">Run a simulation to see signals</div>'; return; }
    const filter = (this.el.filter.value || "").trim().toLowerCase();
    const added = new Set(this.rows.map(r => r.full));
    const mkVar = (v, label) => {
      const d = document.createElement("div");
      d.className = "tnode var" + (added.has(v.full) ? " added" : "");
      d.innerHTML = `<span class="caret"></span><span class="nm"></span><span class="w">${v.width > 1 ? v.width : ""}</span><span class="add">＋</span>`;
      d.querySelector(".nm").textContent = label || v.name;
      d.title = v.full + (v.width > 1 ? ` [${v.width} bits]` : "") + "\nClick to add";
      d.onclick = () => this.addVar(v.full);
      return d;
    };
    if (filter) {
      const hits = Object.values(this.vars).filter(v => v.full.toLowerCase().includes(filter)).slice(0, 400);
      hits.forEach(v => tree.appendChild(mkVar(v, v.full)));
      if (!hits.length) tree.innerHTML = '<div class="empty">No matching signals</div>';
      return;
    }
    this._open = this._open || new Set();
    const mkScope = (sc, depth) => {
      const wrap = document.createElement("div");
      const open = this._open.has(sc.full) || (depth < 2 && !this._open.has("!" + sc.full));
      const h = document.createElement("div");
      h.className = "tnode scope";
      h.innerHTML = `<span class="caret">${open ? "▾" : "▸"}</span><span class="ico">◆</span><span class="nm"></span><span class="add" title="Add all signals in this scope">＋all</span>`;
      h.querySelector(".nm").textContent = sc.name;
      h.title = sc.full + " (" + sc.type + ")";
      h.onclick = (e) => {
        if (e.target.classList.contains("add")) { this.addScope(sc); return; }
        if (open) { this._open.delete(sc.full); this._open.add("!" + sc.full); }
        else { this._open.add(sc.full); this._open.delete("!" + sc.full); }
        this.renderTree();
      };
      wrap.appendChild(h);
      if (open) {
        const ch = document.createElement("div");
        ch.className = "tchildren";
        sc.vars.forEach(v => ch.appendChild(mkVar(v)));
        sc.scopes.forEach(s => ch.appendChild(mkScope(s, depth + 1)));
        wrap.appendChild(ch);
      }
      return wrap;
    };
    const r = this.data.root;
    r.vars.forEach(v => tree.appendChild(mkVar(v)));
    r.scopes.forEach(s => tree.appendChild(mkScope(s, 0)));
  }

  /* ---------- names column */
  renderNames() {
    const box = this.el.names;
    box.innerHTML = "";
    this.el.empty.hidden = !!(this.data && this.rows.length);
    if (this.data && !this.rows.length) {
      this.el.empty.hidden = false;
      this.el.empty.querySelector("p").innerHTML = "No signals in view.<br>Click signals in the tree on the left to add them.";
    }
    const RAD = { hex: "h", dec: "d", sdec: "±d", bin: "b" };
    this.rows.forEach((r, i) => {
      const d = document.createElement("div");
      d.className = "nrow" + (i === this.sel ? " sel" : "");
      d.draggable = true;
      const parts = r.full.split(".");
      const scope = parts.length > 1 ? parts[parts.length - 2] + "." : "";
      d.innerHTML = `<span class="sw" style="background:${r.width > 1 ? "var(--wavebus)" : "var(--wave1)"}"></span>
        <span class="nm"><span class="scope"></span><span class="leaf"></span></span>
        <span class="rdx" title="Click to change radix">${RAD[r.radix] || "h"}</span>
        <span class="val"></span><button class="rm" title="Remove (Del)">×</button>`;
      d.querySelector(".scope").textContent = scope;
      d.querySelector(".leaf").textContent = r.name;
      d.title = r.full + (r.width > 1 ? ` [${r.width} bits]` : "");
      d.onclick = (e) => {
        if (e.target.classList.contains("rm")) { this.removeRow(i); return; }
        if (e.target.classList.contains("rdx")) {
          const order = r.width > 1 ? ["hex", "dec", "sdec", "bin"] : ["bin", "dec"];
          r.radix = order[(order.indexOf(r.radix) + 1) % order.length];
          this._save(); this.renderNames(); this.draw(); return;
        }
        this.sel = i; this.renderNames(); this.draw();
      };
      d.ondragstart = (e) => { e.dataTransfer.setData("text/plain", String(i)); };
      d.ondragover = (e) => { e.preventDefault(); d.classList.add("dragover"); };
      d.ondragleave = () => d.classList.remove("dragover");
      d.ondrop = (e) => {
        e.preventDefault();
        const from = +e.dataTransfer.getData("text/plain");
        if (from === i || isNaN(from)) return;
        const [row] = this.rows.splice(from, 1);
        this.rows.splice(i, 0, row);
        this.sel = i; this._changed();
      };
      box.appendChild(d);
    });
    this.updateValues();
  }

  updateValues() {
    const vals = this.el.names.querySelectorAll(".nrow .val");
    this.rows.forEach((r, i) => {
      const el = vals[i];
      if (!el) return;
      if (this.cursor === null || !this.data) { el.textContent = ""; return; }
      const s = this.data.sigs[r.id];
      const k = bsearch(s.t, this.cursor);
      const v = k >= 0 ? s.v[k] : "x";
      el.textContent = fmtValue(v, r.width, r.radix);
      el.style.color = valueClass(v) === "x" ? "var(--wavex)" : valueClass(v) === "z" ? "var(--wavez)" : "";
      el.title = el.textContent;
    });
    this.el.cursorLabel.textContent = this.cursor === null ? "Cursor: —" :
      "Cursor: " + fmtTime(this.cursor, this.data.tsSec);
  }

  /* ---------- view */
  width() { return this.el.waves.parentElement.clientWidth - this.el.names.offsetWidth; }
  fit() {
    if (!this.data) return;
    if (this.width() < 60) { this._needFit = true; return; }   // tab hidden: fit when shown
    this._needFit = false;
    const w = Math.max(100, this.width() - 20);
    const span = Math.max(this.data.maxT, 1);
    this.scale = w / span;
    this.t0 = 0;
    this.draw();
  }
  zoom(f, px) {
    if (!this.data) return;
    if (px === undefined) px = this.cursor !== null ? (this.cursor - this.t0) * this.scale : this.width() / 2;
    if (px < 0 || px > this.width()) px = this.width() / 2;
    const tAt = this.t0 + px / this.scale;
    const span = Math.max(this.data.maxT, 1);
    const minScale = (this.width() - 20) / (span * 4);
    const maxScale = 400 / Math.max(this._minStep(), 1e-9);
    this.scale = Math.min(maxScale, Math.max(minScale, this.scale * f));
    this.t0 = tAt - px / this.scale;
    this._clamp();
    this.draw();
  }
  _minStep() { return 1; }
  pan(dpx) { this.t0 += dpx / this.scale; this._clamp(); this.draw(); }
  _clamp() {
    const span = Math.max(this.data.maxT, 1);
    const vis = this.width() / this.scale;
    this.t0 = Math.max(-vis * 0.05, Math.min(this.t0, span - vis * 0.5));
  }
  setCursor(t) {
    this.cursor = Math.max(0, Math.round(t));
    const vis = this.width() / this.scale;
    if (this.cursor < this.t0 || this.cursor > this.t0 + vis) { this.t0 = this.cursor - vis / 2; this._clamp(); }
    this.draw(); this.updateValues();
  }
  edge(dir) {
    if (!this.data || this.sel < 0) return;
    const s = this.data.sigs[this.rows[this.sel].id];
    const c = this.cursor === null ? (dir > 0 ? -1 : this.data.maxT + 1) : this.cursor;
    let t = null;
    if (dir > 0) { const k = bsearch(s.t, c); if (k + 1 < s.t.length) t = s.t[k + 1]; }
    else { let k = bsearch(s.t, c); if (k >= 0 && s.t[k] === c) k--; if (k >= 0) t = s.t[k]; }
    if (t !== null) this.setCursor(t);
  }

  /* ---------- drawing */
  _canvas(c, w, h) {
    const dpr = this.dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + "px"; c.style.height = h + "px";
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }
  _css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }
  _draw() {
    if (this._needFit && this.data && this.width() >= 60) {
      this._needFit = false;
      this.scale = (this.width() - 20) / Math.max(this.data.maxT, 1);
      this.t0 = 0;
    }
    const W = Math.max(50, this.width());
    const rowsH = this.rows.length * this.ROW;
    const H = Math.max(rowsH, this.el.scroll.clientHeight);
    const axis = this._canvas(this.el.axis, W, 30);
    const g = this._canvas(this.el.waves, W, H);
    const C = {
      grid: "rgba(255,255,255,0.045)", line: this._css("--line"), text: this._css("--muted"),
      w1: this._css("--wave1"), bus: this._css("--wavebus"), x: this._css("--wavex"), z: this._css("--wavez"),
      cur: this._css("--cursor"), sel: "rgba(124,92,255,0.10)", mono: this._css("--mono"),
    };
    if (!this.data) return;
    const ts = this.data.tsSec;
    const t1 = this.t0 + W / this.scale;
    // ---- grid & axis
    const targetPx = 110;
    const rawStep = targetPx / this.scale;
    const p10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = p10;
    for (const m of [1, 2, 5, 10]) { if (m * p10 >= rawStep) { step = m * p10; break; } }
    const stepSec = step * ts;
    let unit = "fs";
    for (const k of ["s", "ms", "us", "ns", "ps", "fs"]) { if (stepSec >= UNIT_SEC[k] * 0.9999) { unit = k; break; } }
    axis.font = `11px ${C.mono}`; axis.fillStyle = C.text; axis.strokeStyle = C.line; axis.textBaseline = "middle";
    const first = Math.ceil(this.t0 / step) * step;
    for (let t = first; t <= t1; t += step) {
      const x = Math.round((t - this.t0) * this.scale) + 0.5;
      axis.beginPath(); axis.moveTo(x, 20); axis.lineTo(x, 30); axis.stroke();
      axis.fillText(fmtTime(t, ts, unit), x + 4, 13);
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      for (let k = 1; k < 5; k++) {
        const xm = Math.round((t + k * step / 5 - this.t0) * this.scale) + 0.5;
        axis.beginPath(); axis.moveTo(xm, 26); axis.lineTo(xm, 30); axis.stroke();
      }
    }
    // end-of-sim marker
    const xe = (this.data.maxT - this.t0) * this.scale;
    if (xe >= 0 && xe <= W) {
      g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(xe, 0, W - xe, H);
    }
    // ---- rows
    g.font = `11.5px ${C.mono}`; g.textBaseline = "middle";
    this.rows.forEach((r, i) => {
      const y = i * this.ROW;
      if (i === this.sel) { g.fillStyle = C.sel; g.fillRect(0, y, W, this.ROW); }
      g.strokeStyle = "rgba(38,45,61,0.5)"; g.beginPath(); g.moveTo(0, y + this.ROW - 0.5); g.lineTo(W, y + this.ROW - 0.5); g.stroke();
      const s = this.data.sigs[r.id];
      if (!s) return;
      this._drawSignal(g, s, r, y + 5, this.ROW - 10, W, C);
    });
    // ---- cursor
    if (this.cursor !== null) {
      const xc = Math.round((this.cursor - this.t0) * this.scale) + 0.5;
      if (xc >= 0 && xc <= W) {
        g.strokeStyle = C.cur; g.lineWidth = 1; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(xc, 0); g.lineTo(xc, H); g.stroke(); g.setLineDash([]);
        const label = fmtTime(this.cursor, ts);
        axis.font = `600 11px ${C.mono}`;
        const tw = axis.measureText(label).width + 12;
        const lx = Math.min(Math.max(xc - tw / 2, 0), W - tw);
        axis.fillStyle = C.cur; axis.beginPath(); axis.roundRect ? axis.roundRect(lx, 3, tw, 17, 5) : axis.rect(lx, 3, tw, 17); axis.fill();
        axis.fillStyle = "#1b0a14"; axis.fillText(label, lx + 6, 12);
      }
    }
  }

  _drawSignal(g, s, r, top, h, W, C) {
    const n = s.t.length;
    if (!n) return;
    const X = (t) => (t - this.t0) * this.scale;
    const tEnd = this.data.maxT;
    let k = Math.max(0, bsearch(s.t, this.t0));
    const bot = top + h, mid = top + h / 2;
    const bus = r.width > 1 || s.real;
    g.lineWidth = 1.5;
    let lastX = -Infinity, denseFrom = null;
    for (; k < n; k++) {
      const ta = s.t[k], tb = k + 1 < n ? s.t[k + 1] : tEnd;
      if (ta > this.t0 + W / this.scale) break;
      let xa = X(ta), xb = X(Math.max(tb, ta));
      if (xb < 0) continue;
      xa = Math.max(xa, -2); xb = Math.min(xb, W + 2);
      const v = s.v[k];
      const cls = valueClass(v);
      // very dense transitions: draw a solid block instead of individual segments
      if (xb - xa < 1.5 && k + 1 < n) {
        if (denseFrom === null) denseFrom = xa;
        continue;
      }
      if (denseFrom !== null) {
        g.fillStyle = bus ? C.bus : C.w1; g.globalAlpha = 0.55;
        g.fillRect(denseFrom, top, Math.max(1, xa - denseFrom), h); g.globalAlpha = 1;
        denseFrom = null;
      }
      if (!bus) {
        const col = cls === "x" ? C.x : cls === "z" ? C.z : C.w1;
        g.strokeStyle = col;
        if (cls) {
          g.fillStyle = cls === "x" ? "rgba(248,113,113,0.18)" : "rgba(251,191,36,0.14)";
          g.fillRect(xa, top, xb - xa, h);
          g.beginPath(); g.moveTo(xa, mid); g.lineTo(xb, mid); g.stroke();
        } else {
          const y = v === "1" ? top : bot;
          g.beginPath();
          if (k > 0 && xa > lastX - 0.5 && X(ta) >= 0) {
            const pv = s.v[k - 1];
            const py = pv === "1" ? top : pv === "0" ? bot : mid;
            g.moveTo(xa, py); g.lineTo(xa, y);
          } else g.moveTo(xa, y);
          g.lineTo(xb, y); g.stroke();
          if (v === "1") { g.fillStyle = "rgba(52,211,153,0.07)"; g.fillRect(xa, top, xb - xa, h); }
        }
      } else {
        const col = cls === "x" ? C.x : cls === "z" ? C.z : C.bus;
        const sl = Math.min(3, (xb - xa) / 2);
        g.strokeStyle = col;
        g.fillStyle = cls === "x" ? "rgba(248,113,113,0.16)" : cls === "z" ? "rgba(251,191,36,0.12)" : "rgba(56,189,248,0.08)";
        g.beginPath();
        g.moveTo(xa, mid); g.lineTo(xa + sl, top); g.lineTo(xb - sl, top); g.lineTo(xb, mid);
        g.lineTo(xb - sl, bot); g.lineTo(xa + sl, bot); g.closePath();
        g.fill(); g.stroke();
        const txt = fmtValue(v, r.width, r.radix);
        const avail = Math.min(xb, W) - Math.max(xa, 0) - 2 * sl - 8;
        if (avail > 10) {
          g.fillStyle = cls === "x" ? C.x : "#e0f2fe";
          let shown = txt;
          if (g.measureText(shown).width > avail) {
            while (shown.length > 1 && g.measureText(shown + "…").width > avail) shown = shown.slice(0, -1);
            shown = shown.length > 1 ? shown + "…" : "";
          }
          const cx = Math.max(xa, 0) + sl + 4;
          if (shown) g.fillText(shown, cx, mid + 0.5);
        }
      }
      lastX = xb;
    }
    if (denseFrom !== null) {
      g.fillStyle = bus ? C.bus : C.w1; g.globalAlpha = 0.55;
      g.fillRect(denseFrom, top, Math.max(1, X(tEnd) - denseFrom), h); g.globalAlpha = 1;
    }
  }

  /* ---------- input */
  _bind() {
    const c = this.el.waves;
    let drag = null;
    c.addEventListener("mousedown", (e) => {
      if (!this.data || e.button !== 0) return;
      drag = { x: e.clientX, t0: this.t0, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) { drag.moved = true; c.classList.add("dragging"); }
      if (drag.moved) { this.t0 = drag.t0 - dx / this.scale; this._clamp(); this.draw(); }
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      c.classList.remove("dragging");
      if (!drag.moved) {
        const rect = c.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const row = Math.floor(py / this.ROW);
        if (row >= 0 && row < this.rows.length) { this.sel = row; this.renderNames(); }
        let t = this.t0 + px / this.scale;
        // snap to a nearby edge of the clicked signal
        if (row >= 0 && row < this.rows.length) {
          const s = this.data.sigs[this.rows[row].id];
          const k = bsearch(s.t, t);
          const cands = [s.t[k], s.t[k + 1]].filter(v => v !== undefined);
          for (const ct of cands) if (Math.abs((ct - t) * this.scale) < 7) { t = ct; break; }
        }
        this.setCursor(t);
      }
      drag = null;
    });
    c.addEventListener("wheel", (e) => {
      if (!this.data) return;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - rect.left);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.pan(e.shiftKey ? e.deltaY : e.deltaX);
      }
    }, { passive: false });
    this.el.axis.addEventListener("wheel", (e) => {
      if (!this.data) return;
      e.preventDefault();
      const rect = this.el.axis.getBoundingClientRect();
      this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - rect.left);
    }, { passive: false });
    this.el.axis.addEventListener("click", (e) => {
      if (!this.data) return;
      const rect = this.el.axis.getBoundingClientRect();
      this.setCursor(this.t0 + (e.clientX - rect.left) / this.scale);
    });
    this.el.filter.addEventListener("input", () => this.renderTree());
    new ResizeObserver(() => this.draw()).observe(this.el.scroll);
  }

  key(e) {
    if (!this.data) return false;
    const k = e.key;
    if (k === "ArrowRight") { this.edge(1); return true; }
    if (k === "ArrowLeft") { this.edge(-1); return true; }
    if (k === "ArrowDown") { this.sel = Math.min(this.rows.length - 1, this.sel + 1); this.renderNames(); this.draw(); return true; }
    if (k === "ArrowUp") { this.sel = Math.max(0, this.sel - 1); this.renderNames(); this.draw(); return true; }
    if (k === "+" || k === "=") { this.zoom(1.5); return true; }
    if (k === "-" || k === "_") { this.zoom(1 / 1.5); return true; }
    if (k === "f" || k === "F") { this.fit(); return true; }
    if ((k === "Delete" || k === "Backspace") && this.sel >= 0) { this.removeRow(this.sel); return true; }
    return false;
  }
}

window.WaveViewer = WaveViewer;
window.parseVCD = parseVCD;
window.fmtValue = fmtValue;
