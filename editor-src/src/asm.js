// RISC-V assembly editor for the SV Studio RISC-V tab (CodeMirror 6).
// Relies on window.RV (static/riscv.js) for mnemonic/register docs.
import { EditorState, StateField, StateEffect, RangeSet, Prec } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  highlightSpecialChars, hoverTooltip, gutter, GutterMarker, Decoration,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter, setDiagnostics, lintKeymap } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";

const RV = () => window.RV;
const REGRE = /^(?:x(?:[12]?\d|3[01])|zero|ra|sp|gp|hp|tp|fp|t[0-6]|s(?:1[01]|\d)|a[0-7])\b/i;

/* ------------------------------------------------------------------ language */
let MNSET = null;
const isOp = (w) => {
  const rv = RV(); if (!rv) return false;
  if (!MNSET) MNSET = new Set([...rv.MNEMONICS, ...rv.B_DIRECTIVES, "subi", "lla", "illegal", "uret", "sret", "mret", "wfi", "csrwi", "csrsi", "csrci"]);
  return MNSET.has(w.toLowerCase());
};
const rvLang = StreamLanguage.define({
  name: "riscv",
  startState: () => ({ first: true }),
  token(stream, st) {
    if (stream.sol()) st.first = true;
    if (stream.eatSpace()) return null;
    if (stream.match(/^(#|;|\/\/)/)) { stream.skipToEnd(); return "comment"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^`(?:[^`\\]|\\.)*`?/)) return "string";
    if (stream.match(/^'(?:\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/)) return "string";
    if (stream.match(/^%[bf]?\d+/i)) return "labelName";
    if (st.first && stream.match(/^\d+(?=\s|:|$)/)) { stream.eat(":"); return "labelName"; }
    if (stream.match(/^\.[A-Za-z_]\w*/)) { st.first = false; return "meta"; }
    if (stream.match(/^%(?:hi|lo|pcrel_hi|pcrel_lo)\b/)) return "meta";
    if (stream.match(/^(?:0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|\$[0-9a-f_]+|@[0-7_]+|\d+[bf]?)\b/i)) return "number";
    if (stream.match(REGRE)) return "typeName";
    const m = stream.match(/^[A-Za-z_.$][\w.$]*/);
    if (m) {
      if (st.first) {
        if (isOp(m[0])) { st.first = false; const rv = RV(); return rv && rv.B_DIRECTIVES.includes(m[0].toLowerCase()) ? "meta" : "keyword"; }
        stream.eat(":");
        return "labelName";                   // a label (with or without ':'); the next word is the mnemonic
      }
      return /^[A-Z][A-Z0-9]+$/.test(m[0]) && RV() && RV().B_CSR[m[0]] !== undefined ? "typeName" : "variableName";
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ";" } },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c792ea", fontWeight: "600" },
  { tag: t.comment, color: "#637089", fontStyle: "italic" },
  { tag: t.string, color: "#c3e88d" },
  { tag: t.number, color: "#f78c6c" },
  { tag: t.meta, color: "#ffcb6b" },
  { tag: t.typeName, color: "#82aaff" },
  { tag: t.labelName, color: "#89ddff", fontWeight: "600" },
  { tag: t.variableName, color: "#d4d9e6" },
]);

/* ------------------------------------------------------------------ breakpoints + exec line */
const bpEffect = StateEffect.define({ map: (v, m) => ({ pos: m.mapPos(v.pos), on: v.on }) });
const bpClear = StateEffect.define();
class BpMarker extends GutterMarker { toDOM() { const d = document.createElement("div"); d.className = "cm-bp"; d.title = "Breakpoint (click / F9 to remove)"; return d; } }
const bpMarker = new BpMarker();
const bpField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(bpClear)) set = RangeSet.empty;
      if (e.is(bpEffect)) {
        if (e.value.on) set = set.update({ add: [bpMarker.range(e.value.pos)] });
        else set = set.update({ filter: (from) => from !== e.value.pos });
      }
    }
    return set;
  },
});
function toggleBp(view, pos) {
  const line = view.state.doc.lineAt(pos);
  let has = false;
  view.state.field(bpField).between(line.from, line.from, () => { has = true; });
  view.dispatch({ effects: bpEffect.of({ pos: line.from, on: !has }) });
}

const execEffect = StateEffect.define();
const execLineDeco = Decoration.line({ class: "cm-execLine" });
const execField = StateField.define({
  create: () => ({ line: 0, deco: Decoration.none }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(execEffect)) {
      const n = e.value;
      if (!n || n > tr.state.doc.lines) return { line: 0, deco: Decoration.none };
      return { line: n, deco: Decoration.set([execLineDeco.range(tr.state.doc.line(n).from)]) };
    }
    if (tr.docChanged && v.line) return { line: 0, deco: Decoration.none };
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
class ArrowMarker extends GutterMarker { toDOM() { const d = document.createElement("div"); d.className = "cm-execArrow"; d.textContent = "▶"; return d; } }
const arrow = new ArrowMarker();

/* ------------------------------------------------------------------ completion + hover */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function docLabels(state) {
  const out = [];
  const text = state.doc.toString();
  const re = /^[ \t]*([A-Za-z_.$][\w.$]*)[ \t]*:|^\s*\.(?:equ|set)\s+([A-Za-z_.$][\w.$]*)|^([A-Za-z_][\w]*)(?=\s|$)/gm;
  let m;
  while ((m = re.exec(text))) { const w = m[1] || m[2] || m[3]; if (w && !(m[3] && isOp(w))) out.push(w); }
  return [...new Set(out)];
}

const B_DIR_DOC = { equ: "name EQU value — define a constant", org: "ORG addr — continue assembling at addr", align: "ALIGN [n[, fill]] — pad to a multiple of n (default 4)",
  defs: "DEFS size[, fill] — reserve bytes", defb: "DEFB values / \"strings\" — bytes", defh: "DEFH values — 16-bit halfwords", defw: "DEFW values — 32-bit words",
  dcb: "same as DEFB", dcw: "same as DEFH", dcd: "same as DEFW", origin: "same as ORG", entry: "mark the entry point (ignored)", export: "export labels (ignored)" };

function completions(ctx) {
  const rv = RV(); if (!rv) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (/(#|;|\/\/)/.test(before.replace(/"(?:[^"\\]|\\.)*"/g, ""))) return null;
  const w = ctx.matchBefore(/[.\w$]*/);
  if (!w || (w.from === w.to && !ctx.explicit)) return null;
  const head = before.replace(/^\s*(?:[\w.$]+:\s*)*/, "");
  const firstWord = !/\s/.test(head.slice(0, w.from - line.from - (before.length - head.length)));
  const bennett = HOOKS.dialect && HOOKS.dialect() === "bennett";
  if (w.text.startsWith(".") && !bennett) {
    return { from: w.from, validFor: /^\.\w*$/, options: rv.DIRECTIVES.map(d => ({ label: d, type: "keyword", detail: "directive" })) };
  }
  const opsHere = firstWord || (bennett && /^\s*[A-Za-z_]\w*\s+[\w.]*$/.test(before) && !isOp(before.trim().split(/\s+/)[0]));
  if (opsHere) {
    return {
      from: w.from, validFor: /^\w*$/,
      options: [...rv.MNEMONICS.map(m => ({ label: m, type: rv.PSEUDO.includes(m) ? "function" : "keyword", detail: rv.DOC[m] || "", boost: rv.PSEUDO.includes(m) ? 0 : 1 })),
        ...(bennett ? Object.entries(B_DIR_DOC).map(([d, doc]) => ({ label: d, type: "keyword", detail: doc })) : [])],
    };
  }
  return {
    from: w.from, validFor: /^[\w.$]*$/,
    options: [
      ...rv.ABI.map((n, i) => ({ label: n, type: "type", detail: `x${i} · ${rv.REG_ROLE[i]}`, boost: 2 })),
      ...docLabels(ctx.state).map(l => ({ label: l, type: "variable", detail: "label" })),
    ],
  };
}

function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const rel = pos - line.from;
  const re = /[A-Za-z_.$][\w.$]*/g;
  let m;
  while ((m = re.exec(line.text))) if (m.index <= rel && rel <= m.index + m[0].length) return { word: m[0], from: line.from + m.index, to: line.from + m.index + m[0].length, line };
  return null;
}

function makeHover(hooks) {
  return hoverTooltip((view, pos) => {
    const rv = RV(); if (!rv) return null;
    const w = wordAt(view.state, pos);
    if (!w) return null;
    const lw = w.word.toLowerCase();
    let html = null;
    const r = rv.regNum(lw);
    if (r >= 0) {
      const v = hooks.regValue ? hooks.regValue(r) : null;
      html = `<div class="h-title"><b>${rv.ABI[r]}</b> <span class="h-dim">x${r}${lw === "fp" ? " (fp)" : lw === "hp" ? " (hp)" : ""}</span></div>` +
        `<div class="h-dim">${esc(rv.REG_ROLE[r])}${rv.REG_SAVER[r] ? ` · ${rv.REG_SAVER[r]}-saved` : ""}</div>` + (v != null ? `<div class="h-code">${esc(v)}</div>` : "");
    } else if (B_DIR_DOC[lw] && hooks.dialect && hooks.dialect() === "bennett") {
      html = `<div class="h-title"><span class="h-kind">directive</span> <b>${esc(lw.toUpperCase())}</b></div><div class="h-code">${esc(B_DIR_DOC[lw])}</div>`;
    } else if (rv.DOC[lw] && rv.MNEMONICS.includes(lw)) {
      html = `<div class="h-title"><span class="h-kind">${rv.PSEUDO.includes(lw) ? "pseudo-instruction" : "instruction"}</span> <b>${esc(lw)}</b></div><div class="h-code">${esc(rv.DOC[lw])}</div>`;
    } else if (hooks.symbol) {
      const s = hooks.symbol(w.word);
      if (s) html = `<div class="h-title"><span class="h-kind">label</span> <b>${esc(w.word)}</b></div><div class="h-code">${esc(s)}</div>`;
    }
    if (!html) return null;
    return { pos: w.from, end: w.to, above: true, create() { const dom = document.createElement("div"); dom.className = "cm-svhover"; dom.innerHTML = html; return { dom }; } };
  }, { hoverTime: 300 });
}

/* ------------------------------------------------------------------ public */
let HOOKS = {};
export function createAsm(parent, opts = {}, theme) {
  const hooks = opts.hooks || {};
  HOOKS = hooks;
  const bpGutter = gutter({
    class: "cm-bpGutter",
    markers: (v) => {
      const bps = v.state.field(bpField);
      const ex = v.state.field(execField);
      if (!ex.line) return bps;
      const pos = v.state.doc.line(ex.line).from;
      let set = bps;
      return set.update({ add: [arrow.range(pos)], sort: true });
    },
    initialSpacer: () => bpMarker,
    domEventHandlers: { mousedown(view, line) { toggleBp(view, line.from); return true; } },
  });
  const bpNotify = EditorView.updateListener.of((u) => {
    if (opts.onBreakpoints && u.transactions.some(tr => tr.effects.some(e => e.is(bpEffect) || e.is(bpClear)) || tr.docChanged)) opts.onBreakpoints();
    if (u.docChanged && opts.onChange) opts.onChange();
    if ((u.selectionSet || u.docChanged) && opts.onCursor) {
      const head = u.state.selection.main.head; const line = u.state.doc.lineAt(head);
      opts.onCursor(line.number, head - line.from + 1);
    }
  });
  const extensions = [
    bpField, execField, bpGutter, lineNumbers(), highlightActiveLineGutter(), lintGutter(),
    highlightSpecialChars(), history(), drawSelection(), dropCursor(), closeBrackets(),
    highlightActiveLine(), highlightSelectionMatches(),
    rvLang, syntaxHighlighting(highlight), theme, indentUnit.of("    "), EditorState.tabSize.of(8),
    autocompletion({ override: [completions], activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
    makeHover(hooks),
    Prec.high(keymap.of([
      { key: "Mod-/", run: toggleComment },
      { key: "Mod-s", run: () => { opts.onSave && opts.onSave(); return true; }, preventDefault: true },
      { key: "Mod-Space", run: startCompletion },
      { key: "F9", run: (v) => { toggleBp(v, v.state.selection.main.head); return true; } },
    ])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    bpNotify,
    EditorView.theme({
      ".cm-bpGutter .cm-gutterElement": { width: "16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
      ".cm-bp": { width: "10px", height: "10px", borderRadius: "50%", background: "#f43f5e", boxShadow: "0 0 6px rgba(244,63,94,.7)" },
      ".cm-execArrow": { color: "#fbbf24", fontSize: "11px", lineHeight: "1" },
      ".cm-execLine": { backgroundColor: "rgba(251,191,36,.16) !important", boxShadow: "inset 3px 0 0 #fbbf24" },
    }),
  ];
  const view = new EditorView({ state: EditorState.create({ doc: opts.doc || "", extensions }), parent });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(text) { view.setState(EditorState.create({ doc: text, extensions })); },
    makeState: (text) => EditorState.create({ doc: text, extensions }),
    saveState: () => view.state,
    loadState(st) { view.setState(st); },
    breakpointsOf(st) {
      const out = []; const doc = st.doc;
      st.field(bpField).between(0, doc.length, (from) => { out.push(doc.lineAt(from).number); });
      return out;
    },
    breakpoints() {
      const out = []; const doc = view.state.doc;
      view.state.field(bpField).between(0, doc.length, (from) => { out.push(doc.lineAt(from).number); });
      return out;
    },
    setBreakpoints(lines) {
      const doc = view.state.doc;
      view.dispatch({ effects: [bpClear.of(null), ...lines.filter(n => n >= 1 && n <= doc.lines).map(n => bpEffect.of({ pos: doc.line(n).from, on: true }))] });
    },
    setExecLine(n, scroll = true) {
      const effects = [execEffect.of(n)];
      if (n && scroll && n <= view.state.doc.lines) effects.push(EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "nearest", yMargin: 60 }));
      view.dispatch({ effects });
    },
    setDiagnostics(list) {
      const doc = view.state.doc;
      const diags = list.filter(d => d.line >= 1 && d.line <= doc.lines).map(d => {
        const line = doc.line(d.line);
        const from = line.from + (/^\s*/.exec(line.text)[0].length);
        return { from, to: Math.max(from + 1, line.to), severity: d.severity, message: d.message };
      });
      view.dispatch(setDiagnostics(view.state, diags));
    },
    gotoLine(n) {
      const doc = view.state.doc; const line = doc.line(Math.max(1, Math.min(n, doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view.focus();
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    focus: () => view.focus(),
  };
}
