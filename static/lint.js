/* SV Studio – live error checking with slang (as you type) */
"use strict";

S.lint = new Map();
const LINT = { timer: null, busy: false, again: false, state: "unknown" };

function scheduleLint(ms = 450) {
  clearTimeout(LINT.timer);
  LINT.timer = setTimeout(runLint, ms);
}
window.onEditorChange = (ms) => scheduleLint(ms === undefined ? 450 : ms);

function setLintChip(r) {
  const c = $("#lintChip");
  LINT.state = r.state;
  c.className = "chip " + (r.state === "ok" ? "on" : r.state === "installing" || r.state === "unknown" ? "busy" : "");
  c.textContent = r.state === "ok" ? "Live check" : r.state === "installing" ? "Live check: installing…" : r.state === "unknown" ? "Live check: starting…" : "Live check off";
  c.title = r.state === "ok" ? `Errors are checked as you type (${r.msg}${r.ms !== undefined ? `, ${r.ms} ms` : ""})` : (r.msg || "");
}

async function runLint() {
  if (!S.project) return;
  if (LINT.busy) { LINT.again = true; return; }
  LINT.busy = true;
  try {
    const files = {};
    const cur = activeTab();
    for (const t of S.tabs || []) if (t.dirty) files[t.path] = t === cur ? editor.getDoc() : t.state.doc.toString();
    const r = await api("/api/lint", { files });
    setLintChip(r);
    if (r.diags) {
      const m = new Map();
      for (const [p, items] of Object.entries(r.diags)) {
        if (items.length) m.set(norm(p), { path: p, inProject: true, items: items.map(d => ({ ...d, live: true })) });
      }
      S.lint = m;
      applyDiagnostics();
    } else if (r.state === "installing" || r.state === "unknown") {
      setTimeout(() => scheduleLint(0), 2500);
    }
  } catch (e) { /* backend busy or restarting */ }
  finally {
    LINT.busy = false;
    if (LINT.again) { LINT.again = false; scheduleLint(100); }
  }
}

// mark live-check entries in the Problems list
const _renderProblems = renderProblems;
renderProblems = function () {   // eslint-disable-line no-global-assign
  _renderProblems();
  const live = new Set();
  for (const g of S.lint.values()) g.items.forEach(d => live.add(d.line + "|" + d.message));
  document.querySelectorAll("#problems .pitem").forEach(el => {
    const ln = (el.querySelector(".ln").textContent.match(/Ln (\d+)/) || [])[1];
    if (live.has(ln + "|" + el.querySelector(".msg").textContent)) el.classList.add("live");
  });
};

const _renderProject3 = renderProject;
renderProject = function () {   // eslint-disable-line no-global-assign
  _renderProject3();
  if (S.project !== LINT.proj) { LINT.proj = S.project; scheduleLint(50); }
};
if (S.project) scheduleLint(50);
COMMANDS.push(["Re-check all files now (live check)", "", () => scheduleLint(0), "✓"]);
