// SV Studio editor: CodeMirror 6 + SystemVerilog language features.
// Bundled with esbuild into static/editor.bundle.js (exposes window.SVEditor).
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, hoverTooltip,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment,
} from "@codemirror/commands";
import {
  StreamLanguage, indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting,
  HighlightStyle, indentUnit, indentRange,
} from "@codemirror/language";
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion as snip,
  startCompletion,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter, setDiagnostics, lintKeymap } from "@codemirror/lint";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { tags as t } from "@lezer/highlight";
import { createAsm } from "./asm.js";

/* ------------------------------------------------------------------ language */
const svLang = StreamLanguage.define(verilog);

const KEYWORDS = ("module endmodule program endprogram interface endinterface package endpackage import export " +
  "input output inout ref always always_ff always_comb always_latch begin end if else case casez casex endcase " +
  "default assign posedge negedge or and not initial final for foreach while do repeat forever function endfunction " +
  "task endtask typedef parameter localparam generate endgenerate genvar return unique unique0 priority automatic " +
  "static wait fork join join_any join_none disable modport class endclass extends new virtual const break continue " +
  "assert assume cover property endproperty sequence endsequence inside with iff timeunit timeprecision").split(" ");
const TYPES = "logic wire reg bit byte int integer shortint longint real time string signed unsigned enum struct union packed void".split(" ");
const SYSTASKS = [
  ["$display", "print a line"], ["$write", "print without newline"], ["$monitor", "print whenever args change"],
  ["$strobe", "print at end of time step"], ["$finish", "end simulation"], ["$stop", "pause simulation"],
  ["$time", "current sim time"], ["$realtime", "current sim time (real)"], ["$readmemh", "load hex file into memory"],
  ["$readmemb", "load binary file into memory"], ["$dumpfile", "VCD file name"], ["$dumpvars", "signals to dump"],
  ["$random", "random 32-bit"], ["$urandom", "unsigned random"], ["$urandom_range", "random in range"],
  ["$signed", "cast to signed"], ["$unsigned", "cast to unsigned"], ["$clog2", "ceil(log2(n))"], ["$bits", "width in bits"],
  ["$error", "report error"], ["$fatal", "report fatal error"], ["$warning", "report warning"], ["$info", "report info"],
  ["$fopen", "open file"], ["$fclose", "close file"], ["$fwrite", "write to file"], ["$fdisplay", "write line to file"],
  ["$sformatf", "format string"], ["$countones", "number of 1 bits"], ["$isunknown", "any X/Z bits?"],
];
const DIRECTIVES = ["timescale", "define", "include", "ifdef", "ifndef", "elsif", "else", "endif", "undef", "default_nettype", "resetall"];

const SNIPPETS = [
  snip("module ${name} (\n\tinput  logic clk,\n\tinput  logic rst,\n\t${}\n);\n\t\nendmodule", { label: "module", detail: "module template", type: "keyword", boost: 2 }),
  snip("always_ff @(posedge ${clk}) begin\n\tif (${rst}) begin\n\t\t${}\n\tend else begin\n\t\t\n\tend\nend", { label: "always_ff", detail: "clocked block with reset", type: "keyword", boost: 2 }),
  snip("always_comb begin\n\t${}\nend", { label: "always_comb", detail: "combinational block", type: "keyword", boost: 2 }),
  snip("always @(posedge ${clk}) begin\n\t${}\nend", { label: "always @(posedge)", detail: "clocked block", type: "keyword" }),
  snip("case (${sel})\n\t${value}: ${};\n\tdefault: ;\nendcase", { label: "case", detail: "case statement", type: "keyword", boost: 1 }),
  snip("if (${cond}) begin\n\t${}\nend", { label: "if", detail: "if block", type: "keyword" }),
  snip("if (${cond}) begin\n\t${}\nend else begin\n\t\nend", { label: "ifelse", detail: "if / else block", type: "keyword" }),
  snip("for (int ${i} = 0; ${i} < ${n}; ${i}++) begin\n\t${}\nend", { label: "for", detail: "for loop", type: "keyword" }),
  snip("initial begin\n\t${}\nend", { label: "initial", detail: "initial block", type: "keyword", boost: 1 }),
  snip("assign ${lhs} = ${rhs};", { label: "assign", detail: "continuous assignment", type: "keyword" }),
  snip("typedef enum logic [${1:0}] {${IDLE}, ${}} ${state_t};", { label: "typedef enum", detail: "enumerated type", type: "keyword" }),
  snip("function automatic ${logic} ${name}(${});\n\t\nendfunction", { label: "function", detail: "function", type: "keyword" }),
  snip("task automatic ${name}(${});\n\t\nendtask", { label: "task", detail: "task", type: "keyword" }),
  snip("generate\n\tfor (genvar ${i} = 0; ${i} < ${N}; ${i}++) begin : ${gen}\n\t\t${}\n\tend\nendgenerate", { label: "generate for", detail: "generate loop", type: "keyword" }),
  snip("always #${5} ${clk} = ~${clk};", { label: "clock", detail: "testbench clock generator", type: "keyword" }),
  snip("$display(\"${fmt}\", ${});", { label: "$display", detail: "print a line", type: "function", boost: 3 }),
  snip("$dumpfile(\"${wave}.vcd\");\n$dumpvars(0, ${top});", { label: "$dumpfile + $dumpvars", detail: "dump waveforms", type: "function" }),
  snip("$readmemh(\"${file}.hex\", ${mem});", { label: "$readmemh", detail: "load hex file into memory", type: "function", boost: 2 }),
  snip("`timescale 1ns/1ps", { label: "`timescale 1ns/1ps", detail: "time unit / precision", type: "keyword" }),
];

/* ------------------------------------------------------------------ project-aware completion */
let project = { modules: [], defines: [] };
let gotoHandler = null;
let hooks = {};

function instSnippet(m) {
  const params = m.params || [];
  const ports = m.ports || [];
  let s = m.name;
  if (params.length) s += " #(\n" + params.map((p, i) => `\t.${p.name}(\${${p.default.replace(/[{}$\\]/g, "")}})${i < params.length - 1 ? "," : ""}`).join("\n") + "\n)";
  s += " ${u_" + m.name + "} (";
  if (ports.length) s += "\n" + ports.map((p, i) => `\t.${p.name}(\${${p.name}})${i < ports.length - 1 ? "," : ""}`).join("\n") + "\n";
  s += ");";
  return s;
}

function portDetail(p) { return [p.dir, p.type].filter(Boolean).join(" "); }

// which module instance (if any) encloses the cursor:  Mod #(..) inst ( ... |
function enclosingInstance(text) {
  const tail = text.slice(-4000);
  const lastSemi = tail.lastIndexOf(";");
  const seg = tail.slice(lastSemi + 1);
  const m = seg.match(/\b([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\)\s*)?\s+[A-Za-z_]\w*\s*(?:\[[^\]]*\]\s*)?\(([\s\S]*)$/);
  if (!m) return null;
  const mod = project.modules.find(x => x.name === m[1]);
  if (!mod) return null;
  const used = new Set([...m[2].matchAll(/\.(\w+)\s*\(/g)].map(x => x[1]));
  return { ...mod, ports: mod.ports.filter(p => !used.has(p.name)) };
}

function docWords(state, exclude) {
  const text = state.doc.toString();
  const seen = new Map();
  const re = /\b([A-Za-z_]\w{1,})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const w = m[1];
    if (exclude.has(w) || seen.has(w)) continue;
    seen.set(w, true);
    if (seen.size > 2000) break;
  }
  return [...seen.keys()];
}

const KWSET = new Set([...KEYWORDS, ...TYPES]);

function inCommentOrString(before) {
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const code = line.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (code.includes("//")) return true;                        // line comment
  if ((code.match(/"/g) || []).length % 2 === 1) return true;   // inside a string
  return before.lastIndexOf("/*") > before.lastIndexOf("*/");  // block comment
}

function svCompletions(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos);
  if (inCommentOrString(before) && !ctx.explicit) return null;
  // $system tasks
  let w = ctx.matchBefore(/\$\w*/);
  if (w) {
    return {
      from: w.from, validFor: /^\$\w*$/,
      options: [...SNIPPETS.filter(s => s.label.startsWith("$")),
        ...SYSTASKS.map(([l, d]) => ({ label: l, detail: d, type: "function" }))],
    };
  }
  // `directives and `defines
  w = ctx.matchBefore(/`\w*/);
  if (w) {
    return {
      from: w.from + 1, validFor: /^\w*$/,
      options: [...DIRECTIVES.map(d => ({ label: d, type: "keyword", detail: "directive" })),
        ...project.defines.map(d => ({ label: d.name, type: "constant", detail: d.value ? "= " + d.value : "`define", boost: 2 }))],
    };
  }
  // .port inside an instantiation
  w = ctx.matchBefore(/\.\w*/);
  if (w) {
    const mod = enclosingInstance(ctx.state.sliceDoc(Math.max(0, w.from - 4000), w.from));
    if (mod && mod.ports.length) {
      return {
        from: w.from + 1, validFor: /^\w*$/,
        options: mod.ports.map((p, i) => snip(`${p.name}(\${${p.name}})`, {
          label: p.name, detail: portDetail(p) + `  · ${mod.name}`, type: "property", boost: 10 - Math.min(i, 9) / 10,
        })),
      };
    }
    return null;
  }
  w = ctx.matchBefore(/[A-Za-z_]\w*/);
  if (!w && !ctx.explicit) return null;
  const from = w ? w.from : ctx.pos;
  // don't pop up for the instance name typed right after a module name
  const atLineStart = /(^|[;\n]\s*|begin\s+|end\s+)$/.test(before.slice(0, from - Math.max(0, ctx.pos - 4000)));
  const opts = [];
  for (const m of project.modules) {
    opts.push(snip(instSnippet(m), {
      label: m.name, type: "class", boost: 3,
      detail: `module · ${m.ports.length} ports`,
      info: () => {
        const el = document.createElement("div");
        el.className = "cm-modinfo";
        el.innerHTML = `<b>${m.name}</b>` + (m.ports.length ? "<br>" + m.ports.map(p =>
          `<span class="dir">${p.dir || ""}</span> ${p.type ? `<span class="ty">${p.type}</span> ` : ""}${p.name}`).join("<br>") : "<br><i>no ports</i>") +
          "<br><span class='hint'>Enter inserts an instantiation</span>";
        return el;
      },
    }));
  }
  for (const s of SNIPPETS) if (!s.label.startsWith("$") && !s.label.startsWith("`")) opts.push(s);
  for (const k of KEYWORDS) opts.push({ label: k, type: "keyword", boost: -1 });
  for (const k of TYPES) opts.push({ label: k, type: "type", boost: -1 });
  const modNames = new Set(project.modules.map(m => m.name));
  for (const word of docWords(ctx.state, new Set([...KWSET, ...modNames]))) {
    if (w && word === ctx.state.sliceDoc(w.from, w.to)) continue;
    opts.push({ label: word, type: "variable", boost: 1 });
  }
  return { from, options: opts, validFor: /^\w*$/ };
}

/* ------------------------------------------------------------------ smart Enter: auto-close begin/case/fork */
const BLOCK_CLOSERS = [
  [/\bbegin(\s*:\s*\w+)?\s*$/, "end"],
  [/^\s*(unique\s+|priority\s+)?case[zx]?\s*\(.*\)\s*$/, "endcase"],
  [/\bfork\s*$/, "join"],
];
function smartEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const beforeCursor = line.text.slice(0, sel.head - line.from);
  const after = line.text.slice(sel.head - line.from);
  if (after.trim()) return false;
  const code = beforeCursor.replace(/\/\/.*$/, "");
  const rule = BLOCK_CLOSERS.find(([re]) => re.test(code));
  if (!rule) return false;
  const indent = /^\s*/.exec(line.text)[0];
  // already closed? look at the next non-blank line's indentation
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const tx = state.doc.line(n).text;
    if (!tx.trim()) continue;
    const ind = /^\s*/.exec(tx)[0].length;
    if (ind > indent.length) return false;                                  // body already exists
    if (ind === indent.length && new RegExp("^\\s*" + rule[1] + "\\b").test(tx)) return false; // closer already there
    break;
  }
  const unit = state.facet(indentUnit);
  const insert = "\n" + indent + unit + "\n" + indent + rule[1];
  view.dispatch({
    changes: { from: sel.head, insert },
    selection: { anchor: sel.head + 1 + indent.length + unit.length },
    scrollIntoView: true, userEvent: "input",
  });
  return true;
}

/* ------------------------------------------------------------------ theme */
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--syn-var)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--strong)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--strong)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--sel-bg) !important" },
  ".cm-gutters": { backgroundColor: "var(--bg2)", color: "var(--dim)", borderRight: "1px solid var(--line)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--text)" },
  ".cm-activeLine": { backgroundColor: "rgba(var(--fg-rgb),.035)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "44px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--dim)", cursor: "pointer" },
  ".cm-matchingBracket": { backgroundColor: "rgba(56,189,248,.18)", outline: "1px solid rgba(56,189,248,.5)" },
  ".cm-selectionMatch": { backgroundColor: "rgba(251,191,36,.14)" },
  ".cm-searchMatch": { backgroundColor: "rgba(251,191,36,.28)", outline: "1px solid rgba(251,191,36,.6)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(244,114,182,.35)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderTop: "1px solid var(--line)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "var(--sans)" },
  ".cm-textfield": { backgroundColor: "var(--bg2)", border: "1px solid var(--line2)", borderRadius: "6px", color: "var(--text)", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "6px", color: "var(--text)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line2)", borderRadius: "8px", boxShadow: "0 12px 30px -10px rgba(0,0,0,.7)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12.5px", maxHeight: "18em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px !important", lineHeight: "1.5" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--sel-bg)", color: "var(--strong)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "1em", fontFamily: "var(--sans)", fontSize: "11.5px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent-text)", fontWeight: "700" },
  ".cm-completionInfo": { padding: "8px 12px", fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "1.6" },
  ".cm-completionIcon": { opacity: ".8", width: "1.4em" },
  ".cm-completionIcon-class:after": { content: "'◆'", color: "var(--accent-text)" },
  ".cm-completionIcon-property:after": { content: "'●'", color: "#38bdf8" },
  ".cm-completionIcon-variable:after": { content: "'x'", color: "#34d399" },
  ".cm-completionIcon-type:after": { content: "'T'", color: "var(--syn-type)" },
  ".cm-completionIcon-constant:after": { content: "'`'", color: "var(--syn-label)" },
  ".cm-diagnostic": { padding: "4px 8px", fontFamily: "var(--mono)", fontSize: "12px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--err)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--err)", textUnderlineOffset: "4px", backgroundColor: "rgba(248,113,113,.08)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "4px" },
  ".cm-lint-marker": { width: "12px", height: "12px" },
  ".cm-gotoLink": { textDecoration: "underline", textUnderlineOffset: "3px", cursor: "pointer", color: "var(--accent-text)" },
  ".cm-tooltip-hover": { maxWidth: "520px" },
  ".cm-svhover": { padding: "8px 12px", fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "1.6" },
  ".cm-svhover .h-title": { fontFamily: "var(--sans)", marginBottom: "4px" },
  ".cm-svhover .h-kind": { color: "var(--accent-text)", fontSize: "11px" },
  ".cm-svhover .h-file, .cm-svhover .h-dim": { color: "var(--dim)", fontFamily: "var(--sans)", fontSize: "11px" },
  ".cm-svhover .dir": { color: "var(--syn-kw)" }, ".cm-svhover .ty": { color: "var(--syn-type)" },
  ".cm-svhover .h-code": { color: "var(--text)", background: "var(--bg2)", padding: "3px 8px", borderRadius: "5px" },
  ".cm-svhover .h-wave": { marginTop: "6px", paddingTop: "6px", borderTop: "1px solid var(--line)" },
  ".cm-svhover .h-wave b": { color: "var(--hl)" }, ".cm-svhover .h-path": { color: "var(--muted)" },
  ".cm-svhover .h-btn": { marginTop: "6px", background: "var(--panel2)", border: "1px solid var(--line2)", color: "var(--text)", borderRadius: "6px", padding: "2px 8px", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "12px" },
  ".cm-svhover .h-btn:hover": { borderColor: "var(--accent)" },
  ".cm-flashLine": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", transition: "background-color 1s" },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-kw)" },
  { tag: t.comment, color: "var(--syn-com)", fontStyle: "italic" },
  { tag: t.string, color: "var(--syn-str)" },
  { tag: t.number, color: "var(--syn-num)" },
  { tag: [t.meta], color: "var(--syn-meta)" },                       // $system tasks
  { tag: [t.definition(t.variableName)], color: "var(--syn-label)" },  // `macros, #delays
  { tag: t.variableName, color: "var(--syn-var)" },
  { tag: t.bracket, color: "var(--syn-punct)" },
]);

/* ------------------------------------------------------------------ ctrl+click go to definition */
function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const rel = pos - line.from;
  const re = /[A-Za-z_]\w*/g;
  let m;
  while ((m = re.exec(line.text))) {
    if (m.index <= rel && rel <= m.index + m[0].length) return { word: m[0], from: line.from + m.index, to: line.from + m.index + m[0].length };
  }
  return null;
}

function gotoDefinition(view, pos) {
  const w = wordAt(view.state, pos);
  if (!w) return false;
  const mod = project.modules.find(m => m.name === w.word);
  if (mod && gotoHandler) { gotoHandler({ kind: "module", module: mod }); return true; }
  // local declaration in this file
  const text = view.state.doc.toString();
  const decl = new RegExp("\\b(?:logic|wire|reg|bit|int|integer|input|output|inout|parameter|localparam|genvar|byte|real|state_t|\\w+_t)\\b[^;()]*?\\b" + w.word + "\\b");
  const m = decl.exec(text);
  if (m) {
    const at = m.index + m[0].lastIndexOf(w.word);
    view.dispatch({ selection: { anchor: at, head: at + w.word.length }, scrollIntoView: true });
    return true;
  }
  return false;
}

function findDecl(state, word) {
  const text = state.doc.toString();
  const re = new RegExp("^[^\\n]*\\b(?:logic|wire|reg|bit|int|integer|input|output|inout|parameter|localparam|genvar|byte|real|\\w+_t)\\b[^;\\n]*?\\b" + word + "\\b[^\\n]*", "m");
  const m = re.exec(text);
  if (!m) return null;
  return { text: m[0].trim().replace(/\s+/g, " ").slice(0, 120), line: state.doc.lineAt(m.index).number };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const svHover = hoverTooltip((view, pos) => {
  const w = wordAt(view.state, pos);
  if (!w || KWSET.has(w.word)) return null;
  const mod = project.modules.find(m => m.name === w.word);
  const decl = mod ? null : findDecl(view.state, w.word);
  const wave = !mod && hooks.waveValues ? hooks.waveValues(w.word) : null;
  if (!mod && !decl && !(wave && wave.length)) return null;
  return {
    pos: w.from, end: w.to, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-svhover";
      if (mod) {
        dom.innerHTML = `<div class="h-title"><span class="h-kind">module</span> <b>${esc(mod.name)}</b> <span class="h-file">${esc((mod.file || "").replace(/\\/g, "/").split("/").pop())}:${mod.line || 1}</span></div>` +
          (mod.ports.length ? `<div class="h-ports">${mod.ports.map(p => `<div><span class="dir">${esc(p.dir || "")}</span> <span class="ty">${esc(p.type || "")}</span> ${esc(p.name)}</div>`).join("")}</div>` : `<div class="h-dim">no ports</div>`) +
          `<div class="h-dim">Ctrl+click or F12 to open</div>`;
      } else {
        let html = "";
        if (decl) html += `<div class="h-code">${esc(decl.text)}</div><div class="h-dim">declared on line ${decl.line}</div>`;
        if (wave && wave.length) {
          html += `<div class="h-wave"><div class="h-dim">${esc(wave[0].timeLabel)}</div>` +
            wave.slice(0, 4).map(v => `<div><span class="h-path">${esc(v.full)}</span> = <b>${esc(v.value)}</b></div>`).join("") + "</div>";
        }
        if (hooks.addToWave && hooks.canAddWave && hooks.canAddWave(w.word)) {
          html += `<button class="h-btn">＋ Add to waveform <span class="h-dim">(Alt+W)</span></button>`;
        }
        dom.innerHTML = html;
        const b = dom.querySelector(".h-btn");
        if (b) b.onclick = () => hooks.addToWave(w.word);
      }
      return { dom };
    },
  };
}, { hoverTime: 350 });

function formatDoc(view) {
  const changes = indentRange(view.state, 0, view.state.doc.length);
  if (!changes.empty) view.dispatch({ changes, userEvent: "format" });
  return true;
}

function addWordToWave(view) {
  const w = wordAt(view.state, view.state.selection.main.head);
  if (w && hooks.addToWave) hooks.addToWave(w.word);
  return true;
}

/* ------------------------------------------------------------------ public API */
function create(parent, opts = {}) {
  gotoHandler = opts.onGoto || null;
  hooks = opts.hooks || {};
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && opts.onChange) opts.onChange();
    if ((u.selectionSet || u.docChanged) && opts.onCursor) {
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head);
      opts.onCursor(line.number, head - line.from + 1);
    }
  });
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), foldGutter({ openText: "▾", closedText: "▸" }), lintGutter(),
    highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    svLang, syntaxHighlighting(highlight), theme, indentUnit.of("  "), EditorState.tabSize.of(4),
    autocompletion({ override: [svCompletions], activateOnTyping: true, maxRenderedOptions: 60, icons: true }),
    Prec.high(keymap.of([
      { key: "Enter", run: smartEnter },
      { key: "Mod-/", run: toggleComment },
      { key: "Mod-s", run: () => { opts.onSave && opts.onSave(); return true; }, preventDefault: true },
      { key: "F12", run: (v) => gotoDefinition(v, v.state.selection.main.head) },
      { key: "Mod-Space", run: startCompletion },
      { key: "Shift-Alt-f", run: formatDoc },
      { key: "Alt-w", run: addWordToWave },
      { key: "Mod-g", run: () => { hooks.gotoLine && hooks.gotoLine(); return true; } },
    ])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
      ...completionKeymap, ...lintKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        if (gotoDefinition(view, pos)) { e.preventDefault(); return true; }
        return false;
      },
    }),
    svHover,
    updateListener,
  ];
  const view = new EditorView({ state: EditorState.create({ doc: "", extensions: [extensions, EditorView.editable.of(false)] }), parent });
  let readOnly = true;

  return {
    view,
    setDoc(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
      readOnly = false;
    },
    getDoc() { return view.state.doc.toString(); },
    makeState(text) { return EditorState.create({ doc: text, extensions }); },
    swap(state) {
      view.setState(state);
      readOnly = false;
      view.dispatch({ effects: EditorView.scrollIntoView(state.selection.main.head, { y: "center" }) });
    },
    get state() { return view.state; },
    format() { return formatDoc(view); },
    wordAtCursor() { const w = wordAt(view.state, view.state.selection.main.head); return w ? w.word : null; },
    focus() { view.focus(); },
    gotoLine(n, col) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(n, doc.lines)));
      const pos = col ? Math.min(line.to, line.from + col - 1) : line.from + (/^\s*/.exec(line.text)[0].length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    },
    cursorLine() { return view.state.doc.lineAt(view.state.selection.main.head).number; },
    setDiagnostics(list) {
      const doc = view.state.doc;
      const diags = [];
      for (const d of list) {
        if (d.line < 1 || d.line > doc.lines) continue;
        const line = doc.line(d.line);
        let from = line.from + (/^\s*/.exec(line.text)[0].length), to = line.to;
        if (d.col) { from = Math.min(line.to, line.from + d.col - 1); const w = /^\w+/.exec(line.text.slice(from - line.from)); to = w ? from + w[0].length : Math.min(line.to, from + 1); }
        if (to <= from) to = Math.min(doc.length, from + 1);
        diags.push({ from, to, severity: d.severity, message: d.message, source: d.source });
      }
      view.dispatch(setDiagnostics(view.state, diags));
    },
    setProject(p) { project = { modules: (p && p.modules) || [], defines: (p && p.defines) || [] }; },
    get readOnly() { return readOnly; },
  };
}

window.SVEditor = { create, createAsm: (parent, opts) => createAsm(parent, opts, theme) };
