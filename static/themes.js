/* SV Studio – colour themes and animation level. Loaded in <head> so the saved theme applies
   before the page paints (no flash). Every colour in the UI comes from these CSS variables. */
(function () {
"use strict";

// Base = the default "Midnight" palette; other themes override what they change.
const BASE = {
  bg: "#0d1017", bg2: "#121620", panel: "#161b26", panel2: "#1b2130", line: "#262d3d", line2: "#313a4e",
  text: "#e6e9f2", text2: "#cdd3e1", muted: "#8b93a7", dim: "#5d6579", strong: "#ffffff",
  accent: "#7c5cff", "accent-grad": "#5b8cff", "accent-text": "#c4b5fd", accent2: "#22d3ee",
  ok: "#34d399", warn: "#fbbf24", err: "#f87171", hl: "#fde68a", "fg-rgb": "255, 255, 255",
  "sel-bg": "rgba(124, 92, 255, .35)",
  "syn-kw": "#c792ea", "syn-com": "#637089", "syn-str": "#c3e88d", "syn-num": "#f78c6c", "syn-meta": "#ffcb6b",
  "syn-def": "#89ddff", "syn-var": "#d4d9e6", "syn-type": "#82aaff", "syn-label": "#89ddff", "syn-punct": "#8b93a7",
  wave1: "#34d399", wavebus: "#38bdf8", wavex: "#f87171", wavez: "#fbbf24", cursor: "#f472b6",
};

const LIGHT = {   // shared by the light themes
  "fg-rgb": "0, 0, 0", strong: "#000000", hl: "#9a3412", ok: "#059669", warn: "#b45309", err: "#dc2626",
  wave1: "#059669", wavebus: "#0369a1", wavex: "#dc2626", wavez: "#b45309", cursor: "#db2777",
};

const THEMES = [
  { id: "midnight", name: "Midnight (default)", dark: true, v: {} },
  { id: "onedark", name: "One Dark", dark: true, v: {
    bg: "#21252b", bg2: "#1e2227", panel: "#282c34", panel2: "#2f343d", line: "#3a3f4b", line2: "#4b5263",
    text: "#dcdfe4", text2: "#c4c8d0", muted: "#8e95a3", dim: "#636b78", accent: "#61afef", "accent-grad": "#56b6c2", "accent-text": "#9fd0f7",
    "sel-bg": "rgba(97, 175, 239, .3)", "syn-kw": "#c678dd", "syn-com": "#7f848e", "syn-str": "#98c379", "syn-num": "#d19a66",
    "syn-meta": "#e5c07b", "syn-def": "#56b6c2", "syn-var": "#e06c75", "syn-type": "#61afef", "syn-label": "#56b6c2", hl: "#e5c07b" } },
  { id: "dracula", name: "Dracula", dark: true, v: {
    bg: "#21222c", bg2: "#1e1f29", panel: "#282a36", panel2: "#303341", line: "#383a4a", line2: "#44475a",
    text: "#f8f8f2", text2: "#e2e2dc", muted: "#9aa0be", dim: "#6272a4", accent: "#bd93f9", "accent-grad": "#ff79c6", "accent-text": "#d6bcfc",
    "sel-bg": "rgba(189, 147, 249, .3)", "syn-kw": "#ff79c6", "syn-com": "#6272a4", "syn-str": "#f1fa8c", "syn-num": "#bd93f9",
    "syn-meta": "#ffb86c", "syn-def": "#8be9fd", "syn-var": "#f8f8f2", "syn-type": "#8be9fd", "syn-label": "#50fa7b", ok: "#50fa7b", err: "#ff5555", hl: "#f1fa8c" } },
  { id: "nord", name: "Nord", dark: true, v: {
    bg: "#2b303b", bg2: "#272c36", panel: "#2e3440", panel2: "#353c4a", line: "#3b4252", line2: "#4c566a",
    text: "#eceff4", text2: "#d8dee9", muted: "#a3adbf", dim: "#7b88a1", accent: "#88c0d0", "accent-grad": "#81a1c1", "accent-text": "#b4d8e3",
    "sel-bg": "rgba(136, 192, 208, .25)", "syn-kw": "#81a1c1", "syn-com": "#6f7d96", "syn-str": "#a3be8c", "syn-num": "#b48ead",
    "syn-meta": "#ebcb8b", "syn-def": "#8fbcbb", "syn-var": "#d8dee9", "syn-type": "#88c0d0", "syn-label": "#8fbcbb", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", hl: "#ebcb8b" } },
  { id: "tokyonight", name: "Tokyo Night", dark: true, v: {
    bg: "#16161e", bg2: "#1a1b26", panel: "#1f2335", panel2: "#24283b", line: "#292e42", line2: "#3b4261",
    text: "#c0caf5", text2: "#a9b1d6", muted: "#7f88b0", dim: "#565f89", accent: "#7aa2f7", "accent-grad": "#bb9af7", "accent-text": "#a9c1fa",
    "sel-bg": "rgba(122, 162, 247, .28)", "syn-kw": "#bb9af7", "syn-com": "#565f89", "syn-str": "#9ece6a", "syn-num": "#ff9e64",
    "syn-meta": "#e0af68", "syn-def": "#7dcfff", "syn-var": "#c0caf5", "syn-type": "#2ac3de", "syn-label": "#7dcfff", ok: "#9ece6a", err: "#f7768e", hl: "#e0af68" } },
  { id: "catppuccin", name: "Catppuccin Mocha", dark: true, v: {
    bg: "#181825", bg2: "#11111b", panel: "#1e1e2e", panel2: "#262637", line: "#313244", line2: "#45475a",
    text: "#cdd6f4", text2: "#bac2de", muted: "#9399b2", dim: "#6c7086", accent: "#cba6f7", "accent-grad": "#f5c2e7", "accent-text": "#dcc5fa",
    "sel-bg": "rgba(203, 166, 247, .28)", "syn-kw": "#cba6f7", "syn-com": "#6c7086", "syn-str": "#a6e3a1", "syn-num": "#fab387",
    "syn-meta": "#f9e2af", "syn-def": "#89dceb", "syn-var": "#cdd6f4", "syn-type": "#89b4fa", "syn-label": "#94e2d5", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", hl: "#f9e2af" } },
  { id: "monokai", name: "Monokai", dark: true, v: {
    bg: "#1e1f1c", bg2: "#1a1a17", panel: "#272822", panel2: "#30312a", line: "#3b3c35", line2: "#49483e",
    text: "#f8f8f2", text2: "#e6e6dc", muted: "#a59f85", dim: "#75715e", accent: "#a6e22e", "accent-grad": "#66d9ef", "accent-text": "#c9f07f",
    "sel-bg": "rgba(166, 226, 46, .22)", "syn-kw": "#f92672", "syn-com": "#75715e", "syn-str": "#e6db74", "syn-num": "#ae81ff",
    "syn-meta": "#fd971f", "syn-def": "#66d9ef", "syn-var": "#f8f8f2", "syn-type": "#66d9ef", "syn-label": "#a6e22e", ok: "#a6e22e", err: "#f92672", hl: "#e6db74" } },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, v: {
    bg: "#002b36", bg2: "#00252f", panel: "#073642", panel2: "#0b3f4c", line: "#0e4552", line2: "#1b5563",
    text: "#eee8d5", text2: "#d3cdb9", muted: "#93a1a1", dim: "#657b83", accent: "#268bd2", "accent-grad": "#2aa198", "accent-text": "#7cbde8",
    "sel-bg": "rgba(38, 139, 210, .3)", "syn-kw": "#859900", "syn-com": "#586e75", "syn-str": "#2aa198", "syn-num": "#d33682",
    "syn-meta": "#b58900", "syn-def": "#cb4b16", "syn-var": "#93a1a1", "syn-type": "#268bd2", "syn-label": "#6c71c4", ok: "#859900", warn: "#b58900", err: "#dc322f", hl: "#b58900" } },
  { id: "github-dark", name: "GitHub Dark", dark: true, v: {
    bg: "#0d1117", bg2: "#010409", panel: "#161b22", panel2: "#1c2128", line: "#30363d", line2: "#3d444d",
    text: "#e6edf3", text2: "#c9d1d9", muted: "#8d96a0", dim: "#6e7681", accent: "#2f81f7", "accent-grad": "#a371f7", "accent-text": "#79c0ff",
    "sel-bg": "rgba(56, 139, 253, .3)", "syn-kw": "#ff7b72", "syn-com": "#8b949e", "syn-str": "#a5d6ff", "syn-num": "#79c0ff",
    "syn-meta": "#d2a8ff", "syn-def": "#ffa657", "syn-var": "#e6edf3", "syn-type": "#ffa657", "syn-label": "#7ee787", ok: "#3fb950", warn: "#d29922", err: "#f85149", hl: "#e3b341" } },
  { id: "contrast", name: "High Contrast", dark: true, v: {
    bg: "#000000", bg2: "#000000", panel: "#0a0a0a", panel2: "#141414", line: "#6b6b6b", line2: "#9a9a9a",
    text: "#ffffff", text2: "#ffffff", muted: "#d0d0d0", dim: "#a8a8a8", accent: "#00b7ff", "accent-grad": "#00e1ff", "accent-text": "#7fdcff",
    "sel-bg": "rgba(0, 183, 255, .4)", "syn-kw": "#ff7af6", "syn-com": "#9fe870", "syn-str": "#ffd36e", "syn-num": "#b5f5ff",
    "syn-meta": "#ffb347", "syn-def": "#7fffd4", "syn-var": "#ffffff", "syn-type": "#7fd0ff", "syn-label": "#7fffd4", hl: "#ffff00" } },
  { id: "github-light", name: "GitHub Light", dark: false, v: { ...LIGHT,
    bg: "#ffffff", bg2: "#f6f8fa", panel: "#ffffff", panel2: "#eef1f4", line: "#d8dee4", line2: "#c3cad3",
    text: "#1f2328", text2: "#2f363d", muted: "#59636e", dim: "#818b98", accent: "#0969da", "accent-grad": "#8250df", "accent-text": "#0550ae",
    accent2: "#0891b2", "sel-bg": "rgba(9, 105, 218, .2)", "syn-kw": "#cf222e", "syn-com": "#6e7781", "syn-str": "#0a3069", "syn-num": "#0550ae",
    "syn-meta": "#8250df", "syn-def": "#953800", "syn-var": "#1f2328", "syn-type": "#953800", "syn-label": "#116329", "syn-punct": "#57606a" } },
  { id: "solarized-light", name: "Solarized Light", dark: false, v: { ...LIGHT,
    bg: "#fdf6e3", bg2: "#f5efdc", panel: "#fdf6e3", panel2: "#eee8d5", line: "#e0d9c4", line2: "#cfc8b2",
    text: "#3c4b52", text2: "#4f5f66", muted: "#657b83", dim: "#93a1a1", accent: "#268bd2", "accent-grad": "#2aa198", "accent-text": "#1c6fa8",
    accent2: "#2aa198", "sel-bg": "rgba(38, 139, 210, .2)", "syn-kw": "#859900", "syn-com": "#93a1a1", "syn-str": "#2aa198", "syn-num": "#d33682",
    "syn-meta": "#b58900", "syn-def": "#cb4b16", "syn-var": "#3c4b52", "syn-type": "#268bd2", "syn-label": "#6c71c4", "syn-punct": "#657b83" } },
  { id: "latte", name: "Catppuccin Latte", dark: false, v: { ...LIGHT,
    bg: "#eff1f5", bg2: "#e6e9ef", panel: "#f5f6f9", panel2: "#dce0e8", line: "#ccd0da", line2: "#bcc0cc",
    text: "#4c4f69", text2: "#5c5f77", muted: "#6c6f85", dim: "#8c8fa1", accent: "#8839ef", "accent-grad": "#ea76cb", "accent-text": "#7029d6",
    accent2: "#04a5e5", "sel-bg": "rgba(136, 57, 239, .18)", "syn-kw": "#8839ef", "syn-com": "#9ca0b0", "syn-str": "#40a02b", "syn-num": "#fe640b",
    "syn-meta": "#df8e1d", "syn-def": "#179299", "syn-var": "#4c4f69", "syn-type": "#1e66f5", "syn-label": "#179299", "syn-punct": "#7c7f93" } },
];

const readSaved = (k, d) => {
  const st = window.SVS_STATE || {};
  if (Object.prototype.hasOwnProperty.call(st, k) && st[k] !== null) return st[k];
  try { const v = localStorage.getItem("svs." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
};

function applyTheme(id) {
  const th = THEMES.find(t => t.id === id) || THEMES[0];
  const vars = { ...BASE, ...th.v };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty("--" + k, v);
  root.style.colorScheme = th.dark ? "dark" : "light";
  root.dataset.theme = th.id;
  root.dataset.themeKind = th.dark ? "dark" : "light";
  return th;
}

// Animation level: "full" (default), "reduced" (only feedback like flashes), "off"
function applyMotion(level) {
  if (!["full", "reduced", "off"].includes(level)) level = "full";
  document.documentElement.dataset.motion = level;
  return level;
}

window.SVTheme = { THEMES, applyTheme, applyMotion };
applyTheme(readSaved("ui.theme", "midnight"));
applyMotion(readSaved("ui.motion", "full"));
})();
