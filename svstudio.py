#!/usr/bin/env python3
"""
SV Studio - compile, simulate and view waveforms for Questa SystemVerilog projects.

Runs a small local web server (127.0.0.1 only) and opens a modern UI window.
Backends: Questa / ModelSim (vlog + vsim), Verilator 5+, Icarus Verilog.
No third-party Python packages required.

Usage:
    python svstudio.py [path/to/project.mpf | path/to/folder] [--port N] [--no-window]
"""
import argparse
import glob
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_NAME = "SV Studio"
VERSION = "1.0.0"
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CONFIG_PATH = Path.home() / ".svstudio.json"
BUILD_DIR = ".svstudio"           # created inside the project folder
WRAPPER_TOP = "svs_top"
IS_WIN = platform.system() == "Windows"
FROZEN = bool(getattr(sys, "frozen", False))   # running inside SVStudio.exe (built-in Python)


def self_argv():
    """Command that starts SV Studio again (SVStudio.exe, or python + svstudio.py)."""
    return [sys.executable] if FROZEN else [sys.executable, str(APP_DIR / "svstudio.py")]
TOKEN = secrets.token_hex(16)

HDL_KINDS = {
    ".sv": "sv", ".v": "v", ".svh": "header", ".vh": "header",
    ".vhd": "vhdl", ".vhdl": "vhdl",
}
SKIP_DIRS = {BUILD_DIR, "work", "obj_dir", ".git", "node_modules", "__pycache__", ".vscode"}

DEFAULT_CONFIG = {
    "questa_bin": "",          # folder containing vlog/vsim (auto-detected if empty)
    "license_file": "",        # sets LM_LICENSE_FILE / SALT_LICENSE_SERVER for Questa
    "vscode_path": "",         # path to `code` (auto-detected if empty)
    "vlog_flags": "",
    "vcom_flags": "-2008",
    "vsim_flags": "",
    "verilator_flags": "",
    "iverilog_flags": "",
    "use_bundled_icarus": True,
    "auto_update": "auto",      # "auto" (install updates when SV Studio starts), "notify" or "off"  # Windows: use the Icarus Verilog that ships with SV Studio
    "vivado_path": "",          # vivado / vivado.bat (auto-detected if empty)
    "compile_before_sim": True,
    "recent": [],
}


# --------------------------------------------------------------------------- config
_config_lock = threading.Lock()


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg


def save_config(cfg):
    with _config_lock:
        try:
            CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        except Exception as e:
            print("Could not save config:", e)


CONFIG = load_config()


# --------------------------------------------------------------------------- tool discovery
def _exe(name):
    return name + ".exe" if IS_WIN else name


def questa_candidates():
    pats = []
    if IS_WIN:
        for drive in ("C:", "D:"):
            pats += [
                drive + "/intelFPGA*/*/questa_fse/win64",
                drive + "/intelFPGA*/*/questa_fe/win64",
                drive + "/altera*/*/questa_fse/win64",
                drive + "/altera*/*/questa_fe/win64",
                drive + "/questasim*/win64",
                drive + "/Questa*/win64",
                drive + "/modeltech*/win*",
                drive + "/intelFPGA*/*/modelsim_ase/win32aloem",
            ]
    else:
        home = str(Path.home())
        for base in (home, "/opt", "/tools", "/usr/local"):
            pats += [
                base + "/intelFPGA*/*/questa_fse/bin",
                base + "/intelFPGA*/*/questa_fe/bin",
                base + "/altera*/*/questa_fse/bin",
                base + "/altera*/*/questa_fe/bin",
                base + "/questasim*/bin",
                base + "/questa*/bin",
                base + "/mentor/questasim*/bin",
                base + "/siemens/questa*/bin",
            ]
    out = []
    for p in pats:
        out += sorted(glob.glob(p), reverse=True)
    return out


def find_questa_bin():
    cand = []
    if CONFIG.get("questa_bin"):
        cand.append(CONFIG["questa_bin"])
    w = shutil.which("vsim")
    if w:
        cand.append(str(Path(w).parent))
    cand += questa_candidates()
    for d in cand:
        if d and (Path(d) / _exe("vsim")).exists() and (Path(d) / _exe("vlog")).exists():
            return str(Path(d))
    return None


def find_vscode():
    if CONFIG.get("vscode_path") and Path(CONFIG["vscode_path"]).exists():
        return CONFIG["vscode_path"]
    for n in ("code", "code-insiders", "codium"):
        w = shutil.which(n)
        if w:
            return w
    if IS_WIN:
        la = os.environ.get("LOCALAPPDATA", "")
        for p in (
            la + r"\Programs\Microsoft VS Code\bin\code.cmd",
            r"C:\Program Files\Microsoft VS Code\bin\code.cmd",
            la + r"\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
        ):
            if Path(p).exists():
                return p
    if platform.system() == "Darwin":
        p = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
        if Path(p).exists():
            return p
    return None


# ---- WSL (lets the Windows app use Linux-only tools such as Verilator)
_wsl_lock = threading.Lock()
_wsl_cache = {}


def wsl_available():
    if not IS_WIN or not shutil.which("wsl"):
        return False
    return wsl_tool("sh") is not None


def wsl_tool(name):
    """Path of `name` inside the default WSL distro, or None. Cached; first call may boot WSL."""
    if not IS_WIN:
        return None
    with _wsl_lock:
        if name in _wsl_cache:
            return _wsl_cache[name]
        res = None
        wsl = shutil.which("wsl")
        if wsl:
            try:
                r = subprocess.run([wsl, "-e", "sh", "-lc", f"command -v {name}"], capture_output=True,
                                   timeout=60, stdin=subprocess.DEVNULL, creationflags=0x08000000)
                out = r.stdout.decode("utf-8", "replace").replace("\x00", "").strip()
                if r.returncode == 0 and out.startswith("/"):
                    res = out.splitlines()[0]
            except Exception:
                pass
        _wsl_cache[name] = res
        return res


def wsl_home():
    """$HOME inside WSL (cached)."""
    if "__home__" in _wsl_cache:
        return _wsl_cache["__home__"]
    home = None
    try:
        r = subprocess.run([shutil.which("wsl") or "wsl.exe", "-e", "sh", "-c", "echo $HOME"], capture_output=True,
                           timeout=60, stdin=subprocess.DEVNULL, creationflags=0x08000000 if IS_WIN else 0)
        out = r.stdout.decode("utf-8", "replace").replace("\x00", "").strip()
        home = out if out.startswith("/") else None
    except Exception:
        pass
    _wsl_cache["__home__"] = home
    return home


def verilator_mdir(root, via_wsl):
    """Where Verilator builds. GNU make can't build in a path containing spaces, and WSL builds are much
    faster on the Linux filesystem than on /mnt/c - so build outside the project when needed."""
    tag = re.sub(r"\W+", "_", Path(root).name)[:40] + "_" + hashlib.md5(str(root).lower().encode()).hexdigest()[:8]
    if via_wsl:
        home = wsl_home()
        base = f"{home}/.cache/svstudio" if home and " " not in home else "/tmp/svstudio"
        d = f"{base}/{tag}"
        try:
            subprocess.run([shutil.which("wsl") or "wsl.exe", "-e", "mkdir", "-p", d], capture_output=True,
                           timeout=60, stdin=subprocess.DEVNULL, creationflags=0x08000000 if IS_WIN else 0)
        except Exception:
            pass
        return d
    if " " in str(root):
        base = Path(tempfile.gettempdir()) / "svstudio"
        if " " in str(base):
            base = Path("/tmp/svstudio") if not IS_WIN else Path(os.environ.get("SystemDrive", "C:") + "/svstudio_build")
        d = base / tag
        d.mkdir(parents=True, exist_ok=True)
        return str(d)
    d = Path(root) / BUILD_DIR / "obj_dir"
    d.mkdir(parents=True, exist_ok=True)
    return str(d.resolve())


# Verilator aborts on $stop (and loses the end of the waveform). Questa testbenches often end with
# $stop, so SV Studio swaps in a handler that ends the simulation cleanly, like $finish.
VL_STOP_CPP = """#include "verilated.h"
// Generated by SV Studio: make $stop end the simulation cleanly (like $finish) instead of aborting.
void vl_stop(const char* filename, int linenum, const char* hier) VL_MT_UNSAFE {
    if (false && hier) {}
    VL_PRINTF("- %s:%d: Verilog $stop (ending simulation)\\n", filename, linenum);
    Verilated::threadContextp()->gotFinish(true);
}
"""


def write_build_file(path, text, via_wsl):
    """Write a file into a Verilator build dir (which may live inside WSL)."""
    if via_wsl:
        subprocess.run([shutil.which("wsl") or "wsl.exe", "-e", "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
                       input=text.encode(), capture_output=True, timeout=60,
                       creationflags=0x08000000 if IS_WIN else 0)
    else:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(text, encoding="utf-8")
    return path


def clean_dep_files(mdir, via_wsl):
    """Remove Verilator's *__ver.d. It lists sources relative to the project, but make runs inside the
    build dir, so a second build in the same dir would fail with 'No rule to make target'."""
    try:
        if via_wsl:
            subprocess.run([shutil.which("wsl") or "wsl.exe", "-e", "sh", "-c", 'rm -f "$1"/*__ver.d', "sh", mdir],
                           capture_output=True, timeout=60, creationflags=0x08000000 if IS_WIN else 0)
        else:
            for f in glob.glob(os.path.join(mdir, "*__ver.d")):
                os.remove(f)
    except Exception:
        pass


def verilate_and_make(job, cmd, mdir, prefix, root, via_wsl):
    """Run Verilator (without --build), drop its *__ver.d, then run make in the build dir."""
    if run_cmd(job, cmd, root) != 0:
        return False
    clean_dep_files(mdir, via_wsl)
    jobs = str(max(2, min(16, os.cpu_count() or 2)))
    if via_wsl:
        mk = [shutil.which("wsl") or "wsl.exe", "-e", "make", "-C", mdir, "-f", f"{prefix}.mk", "-j", jobs]
    else:
        mk = [shutil.which("make") or "make", "-C", mdir, "-f", f"{prefix}.mk", "-j", jobs]
    return run_cmd(job, mk, root) == 0


def write_stop_handler(mdir, via_wsl):
    """Put svs_stop.cpp inside the Verilator build dir (make runs there, so paths stay space-free)."""
    return write_build_file(f"{mdir}/svs_stop.cpp", VL_STOP_CPP, via_wsl)


def to_wsl_path(p):
    s = str(p).replace("\\", "/")
    m = re.match(r"^([A-Za-z]):/?(.*)$", s)
    if m:
        return f"/mnt/{m.group(1).lower()}/{m.group(2)}".rstrip("/") or "/"
    m = re.match(r"^//(?:wsl\$|wsl\.localhost)/[^/]+(/.*)?$", s, re.I)
    if m:
        return m.group(1) or "/"
    return s


def _tool_label(name):
    p = shutil.which(name)
    if p:
        return p
    if name == "iverilog" and CONFIG.get("use_bundled_icarus", True) and bundled_icarus_bin():
        return "built-in: " + str(Path(bundled_icarus_bin()) / "iverilog.exe")
    w = wsl_tool(name)
    return f"WSL: {w}" if w else None


def tool_status():
    q = find_questa_bin()
    return {
        "questa": q,
        "verilator": _tool_label("verilator"),
        "icarus": _tool_label("iverilog"),
        "vscode": find_vscode(),
        "vivado": find_vivado(),
        "platform": platform.system(),
        "version": VERSION,
    }


# --------------------------------------------------------------------------- project parsing
def _strip_comments(text):
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def _resolve(raw, root):
    s = raw.strip().strip('"').strip("{}").replace("\\", "/")
    s = os.path.expandvars(s)
    p = Path(s)
    if not p.is_absolute() and not re.match(r"^[A-Za-z]:/", s):
        p = (root / s)
    if p.exists():
        return p.resolve(), True
    # file was moved / project copied from another machine: look by name
    name = Path(s).name
    direct = root / name
    if direct.exists():
        return direct.resolve(), True
    for f in root.rglob(name):
        if not any(part in SKIP_DIRS for part in f.parts):
            return f.resolve(), True
    return p, False


def _mpf_folder(props):
    m = re.search(r"\bfolder\s+(\{[^}]*\}|\S+)", props)
    return m.group(1).strip("{}") if m else ""


def parse_mpf(mpf):
    root = mpf.parent
    text = mpf.read_text(encoding="utf-8", errors="replace")
    files, props, fnames, fprops = {}, {}, {}, {}
    for line in text.splitlines():
        m = re.match(r"\s*Project_Folder_(\d+)\s*=\s*(.+?)\s*$", line)
        if m:
            fnames[int(m.group(1))] = m.group(2).strip("{}")
            continue
        m = re.match(r"\s*Project_Folder_P_(\d+)\s*=\s*(.*)$", line)
        if m:
            fprops[int(m.group(1))] = m.group(2)
            continue
        m = re.match(r"\s*Project_File_(\d+)\s*=\s*(.+?)\s*$", line)
        if m:
            files[int(m.group(1))] = m.group(2)
            continue
        m = re.match(r"\s*Project_File_P_(\d+)\s*=\s*(.*)$", line)
        if m:
            props[int(m.group(1))] = m.group(2)
    # Questa virtual folders can be nested: build each folder's full path
    parent = {}
    for i, name in fnames.items():
        parent[name] = _mpf_folder(fprops.get(i, ""))

    def folder_path(name, depth=0):
        if not name or name == "Top Level" or depth > 20:
            return ""
        up = folder_path(parent.get(name, ""), depth + 1)
        return f"{up}/{name}" if up else name

    out = []
    for idx, raw in files.items():
        path, exists = _resolve(raw, root)
        order = idx
        m = re.search(r"\bcompile_order\s+(-?\d+)", props.get(idx, ""))
        if m:
            order = int(m.group(1))
        out.append({"path": str(path), "exists": exists, "order": order,
                    "vfolder": folder_path(_mpf_folder(props.get(idx, "")))})
    out.sort(key=lambda f: f["order"])
    return out


def scan_folder(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if Path(fn).suffix.lower() in HDL_KINDS:
                out.append({"path": str(Path(dirpath, fn).resolve()), "exists": True})
        if len(out) > 500:
            break
    # crude ordering: packages first, testbenches last
    def key(f):
        n = Path(f["path"]).name.lower()
        return (0 if "pkg" in n or "package" in n else 2 if re.search(r"(^tb|_tb|test)", n) else 1, n)
    out.sort(key=key)
    for i, f in enumerate(out):
        f["order"] = i
    return out


MOD_DECL = re.compile(r"^\s*(?:module|program|interface)\s+(?:automatic\s+|static\s+)?(\w+)", re.M)


# ---- Built-in behavioural models of common Xilinx UNISIM primitives (used by schematic netlists).
#      Only added to a build when the design instantiates them and doesn't define them itself.
def _build_prims():
    P = {}
    for n in range(2, 6):
        ins = [f"I{i}" for i in range(n)]
        for base, op, neg in (("AND", "&", False), ("OR", "|", False), ("NAND", "&", True), ("NOR", "|", True)):
            for b in range(0, n + 1):
                name = f"{base}{n}" + (f"B{b}" if b else "")
                terms = [f"~{x}" if i < b else x for i, x in enumerate(ins)]
                expr = f" {op} ".join(terms)
                if neg:
                    expr = f"~({expr})"
                P[name] = f"module {name} (output O, input {', '.join(ins)});\n  assign O = {expr};\nendmodule\n"
        for base, neg in (("XOR", False), ("XNOR", True)):
            expr = " ^ ".join(ins)
            P[f"{base}{n}"] = f"module {base}{n} (output O, input {', '.join(ins)});\n  assign O = {'~(' + expr + ')' if neg else expr};\nendmodule\n"
    for name in ("BUF", "BUFG", "IBUF", "OBUF", "BUFH"):
        P[name] = f"module {name} (output O, input I);\n  assign O = I;\nendmodule\n"
    P["INV"] = "module INV (output O, input I);\n  assign O = ~I;\nendmodule\n"
    P["GND"] = "module GND (output G);\n  assign G = 1'b0;\nendmodule\n"
    P["VCC"] = "module VCC (output P);\n  assign P = 1'b1;\nendmodule\n"
    P["M2_1"] = "module M2_1 (output O, input D0, D1, S0);\n  assign O = S0 ? D1 : D0;\nendmodule\n"
    P["M2_1E"] = "module M2_1E (output O, input D0, D1, S0, E);\n  assign O = E & (S0 ? D1 : D0);\nendmodule\n"
    ff = {  # name: (ports, sensitivity, body)
        "FD":   ("input C, D", "posedge C", "Q <= D;"),
        "FDE":  ("input C, CE, D", "posedge C", "if (CE) Q <= D;"),
        "FDC":  ("input C, CLR, D", "posedge C or posedge CLR", "if (CLR) Q <= 1'b0; else Q <= D;"),
        "FDCE": ("input C, CE, CLR, D", "posedge C or posedge CLR", "if (CLR) Q <= 1'b0; else if (CE) Q <= D;"),
        "FDP":  ("input C, D, PRE", "posedge C or posedge PRE", "if (PRE) Q <= 1'b1; else Q <= D;"),
        "FDPE": ("input C, CE, D, PRE", "posedge C or posedge PRE", "if (PRE) Q <= 1'b1; else if (CE) Q <= D;"),
        "FDR":  ("input C, D, R", "posedge C", "if (R) Q <= 1'b0; else Q <= D;"),
        "FDRE": ("input C, CE, D, R", "posedge C", "if (R) Q <= 1'b0; else if (CE) Q <= D;"),
        "FDS":  ("input C, D, S", "posedge C", "if (S) Q <= 1'b1; else Q <= D;"),
        "FDSE": ("input C, CE, D, S", "posedge C", "if (S) Q <= 1'b1; else if (CE) Q <= D;"),
    }
    for name, (ports, sens, body) in ff.items():
        P[name] = (f"module {name} #(parameter [0:0] INIT = 1'b0) (output reg Q, {ports});\n"
                   f"  initial Q = INIT;\n  always @({sens}) {body}\nendmodule\n")
    return P


PRIMS = _build_prims()
PRIMS_FILE = "xilinx_prims.v"
INST_RE = re.compile(r"\b([A-Za-z_]\w*)(?:\s*#\s*\((?:[^()]|\([^()]*\))*\)\s*|\s+)([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(")
END_RE = re.compile(r"\bend(?:module|interface|program)\b")


def analyse_modules(files):
    texts, modules = {}, {}
    for f in files:
        if not f["exists"] or f["kind"] not in ("sv", "v"):
            continue
        try:
            t = _strip_comments(Path(f["path"]).read_text(encoding="utf-8", errors="replace"))
        except Exception:
            continue
        texts[f["path"]] = t
        for m in MOD_DECL.finditer(t):
            header = t[m.end(): m.end() + 2000]
            semi = header.find(";")
            hdr = header[:semi if semi >= 0 else len(header)]
            # remove parameter list  #( ... )
            hdr_np = re.sub(r"#\s*\((?:[^()]|\([^()]*\))*\)", "", hdr)
            ports = bool(re.search(r"\(\s*[^)\s]", hdr_np))
            plist = _parse_ports(hdr_np)
            e = END_RE.search(t, m.end())
            body = t[m.end() + (semi if semi >= 0 else 0): e.start() if e else len(t)]
            dm = re.search(r"\$dumpfile\s*\(\s*\"([^\"]+)\"", body)
            params = _parse_params(hdr)
            line = t.count("\n", 0, m.start() + len(m.group(0)) - len(m.group(0).lstrip())) + 1
            modules[m.group(1)] = {"name": m.group(1), "file": f["path"], "has_ports": ports,
                                   "ports": plist, "params": params, "line": line,
                                   "_body": body, "dumpfile": dm.group(1) if dm else None}
    for name, info in modules.items():
        used = {mm.group(1) for mm in INST_RE.finditer(info.pop("_body"))}
        info["deps"] = sorted(u for u in used if u in modules and u != name)
        info["prims"] = sorted(u for u in used if u in PRIMS and u not in modules)
    instantiated = {d for m in modules.values() for d in m["deps"]}
    for name, info in modules.items():
        info["instantiated"] = name in instantiated
    tops = [m for m in modules.values() if not m["instantiated"]]
    tops.sort(key=lambda m: (m["has_ports"], 0 if re.search(r"tb|test|bench", m["name"], re.I) else 1, m["name"]))
    dumpfile = next((m["dumpfile"] for m in modules.values() if m["dumpfile"]), None)
    return sorted(modules.values(), key=lambda m: m["name"]), [m["name"] for m in tops], dumpfile


def _balanced(text, start):
    """Contents of the (...) group starting at text[start] == '('."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    return text[start + 1:]


def _parse_ports(hdr_np):
    i = hdr_np.find("(")
    if i < 0:
        return []
    out, direction, dtype = [], "", ""
    for seg in _balanced(hdr_np, i).split(","):
        seg = " ".join(seg.split())
        if not seg:
            continue
        m = re.match(r"^(input|output|inout|ref)\b\s*(.*)$", seg)
        if m:
            direction, rest = m.group(1), m.group(2)
            dm = re.match(r"^((?:(?:wire|logic|reg|bit|var|signed|unsigned|int|integer|byte)\s*)*(?:\[[^\]]*\]\s*)*)", rest)
            dtype = dm.group(1).strip() if dm else ""
        nm = re.search(r"([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=.*)?$", seg)
        if nm and nm.group(1) not in ("input", "output", "inout", "logic", "wire", "reg"):
            out.append({"name": nm.group(1), "dir": direction, "type": dtype})
    return out


def _parse_params(hdr):
    m = re.search(r"#\s*\(", hdr)
    if not m:
        return []
    out = []
    for seg in _balanced(hdr, m.end() - 1).split(","):
        pm = re.search(r"([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*=\s*(.+)$", " ".join(seg.split()))
        if pm:
            out.append({"name": pm.group(1), "default": pm.group(2).strip()})
    return out


def collect_defines(files):
    out = {}
    for f in files:
        if not f["exists"] or f["kind"] == "vhdl":
            continue
        try:
            t = Path(f["path"]).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for m in re.finditer(r"^\s*`define\s+(\w+)(?:[ \t]+([^\n]*))?", t, re.M):
            out.setdefault(m.group(1), (m.group(2) or "").strip()[:60])
    return [{"name": k, "value": v} for k, v in sorted(out.items())]


def design_closure(proj, top):
    """Modules reachable from `top` (inclusive)."""
    mods = {m["name"]: m for m in proj["modules"]}
    seen, stack = set(), [top]
    while stack:
        n = stack.pop()
        if n in seen or n not in mods:
            continue
        seen.add(n)
        stack.extend(mods[n]["deps"])
    return seen, mods


def load_project(path):
    p = Path(os.path.expandvars(path.strip().strip('"'))).expanduser()
    if not p.exists():
        raise ValueError(f"Path not found: {p}")
    p = p.resolve()
    mpf = None
    if p.is_file() and p.suffix.lower() == ".mpf":
        mpf = p
    elif p.is_dir():
        mpfs = sorted(p.glob("*.mpf"))
        if mpfs:
            mpf = mpfs[0]
    elif p.is_file() and p.suffix.lower() in HDL_KINDS:
        p = p.parent
    else:
        raise ValueError("Open a Questa .mpf project file, a folder, or an HDL source file.")
    root = mpf.parent if mpf else p
    files = parse_mpf(mpf) if mpf else scan_folder(root)
    if mpf and not files:
        files = scan_folder(root)
    for f in files:
        f["kind"] = HDL_KINDS.get(Path(f["path"]).suffix.lower(), "other")
        try:
            f["rel"] = os.path.relpath(f["path"], root).replace("\\", "/")
        except ValueError:
            f["rel"] = f["path"]
    # sidebar grouping: Questa project folders if the .mpf uses them, else real directories
    use_virtual = any(f.get("vfolder") for f in files)
    for f in files:
        if use_virtual:
            f["group"] = f.get("vfolder", "")
        else:
            d = f["rel"].rsplit("/", 1)[0] if "/" in f["rel"] else ""
            f["group"] = d if not d.startswith("..") else str(Path(f["path"]).parent).replace("\\", "/")
    modules, tops, dumpfile = analyse_modules(files)
    proj = {
        "name": (mpf.stem if mpf else root.name),
        "root": str(root),
        "mpf": str(mpf) if mpf else None,
        "files": files,
        "modules": modules,
        "tops": tops,
        "dumpfile": dumpfile,
        "defines": collect_defines(files),
    }
    proj["board_tops"] = board_tops(proj)
    recent = [r for r in CONFIG.get("recent", []) if r != str(mpf or root)]
    CONFIG["recent"] = [str(mpf or root)] + recent[:9]
    save_config(CONFIG)
    return proj


# --------------------------------------------------------------------------- jobs
class Job:
    def __init__(self, kind):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.lines = []
        self.done = False
        self.ok = None
        self.vcd = None
        self.proc = None
        self.cancelled = False
        self.started = time.time()
        self.lock = threading.Lock()

    def log(self, text, cls=""):
        with self.lock:
            for ln in str(text).splitlines() or [""]:
                self.lines.append({"t": ln, "c": cls})

    def snapshot(self, since):
        with self.lock:
            return {
                "id": self.id, "kind": self.kind, "lines": self.lines[since:],
                "next": len(self.lines), "done": self.done, "ok": self.ok, "vcd": self.vcd,
                "elapsed": round(time.time() - self.started, 2),
            }


JOBS = {}


def _quote(a):
    return f'"{a}"' if (" " in a or not a) else a


def _env():
    env = os.environ.copy()
    lic = CONFIG.get("license_file")
    if lic:
        env["LM_LICENSE_FILE"] = lic
        env["SALT_LICENSE_SERVER"] = lic
    q = find_questa_bin()
    if q:
        env["PATH"] = q + os.pathsep + env.get("PATH", "")
    return env


def run_cmd(job, cmd, cwd, transform=None):
    if job.cancelled:
        return -1
    job.log("$ " + " ".join(_quote(str(c)) for c in cmd), "cmd")
    kw = {}
    if IS_WIN:
        kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    else:
        kw["start_new_session"] = True
    try:
        job.proc = subprocess.Popen(
            [str(c) for c in cmd], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=_env(), **kw)
    except FileNotFoundError:
        job.log(f"Command not found: {cmd[0]}", "err")
        return 127
    for line in job.proc.stdout:
        line = line.rstrip("\r\n")
        job.log(transform(line) if transform else line)
    rc = job.proc.wait()
    job.proc = None
    return rc


def kill_job(job):
    job.cancelled = True
    p = job.proc
    if not p:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=0x08000000)
        else:
            os.killpg(p.pid, signal.SIGTERM)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def _split(flags):
    import shlex
    try:
        return shlex.split(flags or "", posix=not IS_WIN)
    except ValueError:
        return (flags or "").split()


def _runtime_literal(rt):
    rt = (rt or "").strip()
    if not rt or rt in ("-all", "all"):
        return None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(fs|ps|ns|us|ms|s)?$", rt)
    if not m:
        raise ValueError(f"Bad run time '{rt}'. Use -all or e.g. 500ns, 20us, 1ms.")
    return m.group(1) + (m.group(2) or "ns")


def _src_files(proj, job, verilog_only=False, top=None):
    """Files to compile. With `top`, only files defining modules the top needs (plus files with no
    modules, e.g. defines/packages) - skips board-only wrappers that use FPGA hardware blocks."""
    keep = None
    if top and any(m["name"] == top for m in proj["modules"]):
        need, mods = design_closure(proj, top)
        defining = {}
        for m in proj["modules"]:
            defining.setdefault(m["file"], set()).add(m["name"])
        keep = {f for f, names in defining.items() if names & need}
        keep |= {f["path"] for f in proj["files"] if f["path"] not in defining}
    out = []
    skipped = 0
    for f in proj["files"]:
        if keep is not None and f["path"] not in keep and f["kind"] in ("sv", "v"):
            skipped += 1
            continue
        if not f["exists"]:
            job.log(f"Warning: missing file {f['path']}", "warn")
            continue
        if f["kind"] == "header" or f["kind"] == "other":
            continue
        if verilog_only and f["kind"] == "vhdl":
            job.log(f"Skipping VHDL file (not supported by this backend): {f['rel']}", "warn")
            continue
        out.append(f)
    if skipped:
        job.log(f"Compiling the {len(out)} file(s) needed by '{top}' ({skipped} unrelated file(s) skipped).", "info")
    return out


def _prims_needed(proj, top=None):
    if top and any(m["name"] == top for m in proj["modules"]):
        need, mods = design_closure(proj, top)
        used = {p for n in need for p in mods[n]["prims"]}
    else:
        used = {p for m in proj["modules"] for p in m["prims"]}
    return sorted(used)


def _prims_file(job, proj, top=None):
    """Write the built-in primitive models if the design needs them. Returns path relative to root."""
    used = _prims_needed(proj, top)
    if not used:
        return None
    build = Path(proj["root"]) / BUILD_DIR
    build.mkdir(exist_ok=True)
    (build / PRIMS_FILE).write_text(
        "// Behavioural simulation models of Xilinx UNISIM primitives, generated by SV Studio.\n"
        "// Lets schematic netlists simulate without the Xilinx unisims library.\n`timescale 1ns/1ps\n\n"
        + "\n".join(PRIMS[n] for n in sorted(PRIMS)), encoding="utf-8")
    shown = ", ".join(used[:12]) + (" …" if len(used) > 12 else "")
    job.log(f"Using SV Studio's built-in models for Xilinx primitives: {shown}", "info")
    return f"{BUILD_DIR}/{PRIMS_FILE}"


def _incdirs(proj):
    dirs = {proj["root"]}
    for f in proj["files"]:
        dirs.add(str(Path(f["path"]).parent))
    return sorted(dirs)


def _rel(path, root):
    try:
        r = os.path.relpath(path, root)
        return r.replace("\\", "/") if not r.startswith("..") else path.replace("\\", "/")
    except ValueError:
        return path


def _dump_target(proj, build, top=None):
    """Returns (vcd_path_relative_to_root, need_wrapper_dump)."""
    if top and any(m["name"] == top for m in proj["modules"]):
        need, mods = design_closure(proj, top)
        df = next((mods[n]["dumpfile"] for n in sorted(need) if mods[n].get("dumpfile")), None)
    else:
        df = proj.get("dumpfile")
    if df:
        return df, False
    return f"{BUILD_DIR}/wave.vcd", True


def _write_wrapper(proj, top, build, runtime):
    vcd_rel, need_dump = _dump_target(proj, build, top)
    lines = [f"module {WRAPPER_TOP};", f"  {top} {top}();"]
    if need_dump:
        lines += ["  initial begin", f'    $dumpfile("{vcd_rel}");', f"    $dumpvars(0, {WRAPPER_TOP});", "  end"]
    if runtime:
        lines += [f"  initial begin #{runtime}; $display(\"[SV Studio] run time limit {runtime} reached\"); $finish; end"]
    lines.append("endmodule")
    wp = build / "svs_wrapper.sv"
    wp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return wp, vcd_rel


# ---- Questa
def questa_compile(job, proj):
    qbin = find_questa_bin()
    if not qbin:
        job.log("Questa/ModelSim not found. Set its bin folder in Settings, or choose Verilator/Icarus.", "err")
        return False
    root = proj["root"]
    vlib, vlog, vcom = (str(Path(qbin) / _exe(n)) for n in ("vlib", "vlog", "vcom"))
    if not (Path(root) / "work" / "_info").exists():
        if run_cmd(job, [vlib, "work"], root) != 0:
            return False
    files = _src_files(proj, job)
    if not files:
        job.log("No source files to compile.", "err")
        return False
    incs = ["+incdir+" + _rel(d, root) for d in _incdirs(proj)]
    prims = _prims_file(job, proj)
    if prims:
        files = [{"path": str(Path(root) / prims), "kind": "v"}] + files
    # group consecutive files of the same language to keep compile order
    groups = []
    for f in files:
        lang = "vhdl" if f["kind"] == "vhdl" else "verilog"
        if groups and groups[-1][0] == lang:
            groups[-1][1].append(f)
        else:
            groups.append((lang, [f]))
    for lang, grp in groups:
        paths = [_rel(f["path"], root) for f in grp]
        if lang == "verilog":
            cmd = [vlog, "-work", "work"] + incs + _split(CONFIG.get("vlog_flags")) + paths
        else:
            cmd = [vcom, "-work", "work"] + _split(CONFIG.get("vcom_flags")) + paths
        if run_cmd(job, cmd, root) != 0:
            return False
    return True


def questa_sim(job, proj, top, runtime):
    qbin = find_questa_bin()
    root = Path(proj["root"])
    build = root / BUILD_DIR
    build.mkdir(exist_ok=True)
    vcd_rel, need_dump = _dump_target(proj, build, top)
    rt = _runtime_literal(runtime)
    do = []
    if need_dump:
        do += [f"vcd file {{{vcd_rel}}}", f"vcd add -r /{top}/*"]
    do += [f"run {rt if rt else '-all'}"]
    if need_dump:
        do += ["vcd flush"]
    do += ["quit -f"]
    dofile = build / "run.do"
    dofile.write_text("\n".join(do) + "\n", encoding="utf-8")
    cmd = [str(Path(qbin) / _exe("vsim")), "-c", "-onfinish", "stop", "-voptargs=+acc"] + \
          _split(CONFIG.get("vsim_flags")) + ["-do", f"{BUILD_DIR}/run.do", f"work.{top}"]
    rc = run_cmd(job, cmd, str(root))
    return rc, root / vcd_rel


# ---- Verilator / Icarus (native, bundled, or through WSL on Windows)
BUNDLED_ICARUS = APP_DIR / "tools" / "iverilog-win"
_bundled_cache = {}


def bundled_icarus_bin():
    """bin folder of the Icarus Verilog build shipped with SV Studio (Windows only), or None.
    Icarus passes its own path to sub-commands, so if SV Studio lives in a folder with spaces the
    bundle is copied once to a space-free folder."""
    if not IS_WIN or not (BUNDLED_ICARUS / "bin" / "iverilog.exe").exists():
        return None
    if "bin" in _bundled_cache:
        return _bundled_cache["bin"]
    src = BUNDLED_ICARUS
    if " " in str(src):
        # Not under AppData: the Microsoft Store build of Python silently redirects writes there to
        # a private folder that other programs (cmd.exe, which Icarus uses internally) can't see.
        for base in (Path.home() / ".svstudio", Path(os.environ.get("SystemDrive", "C:") + "\\svstudio_tools")):
            if " " in str(base):
                continue
            dest = base / "iverilog-13"
            try:
                if not (dest / "bin" / "iverilog.exe").exists() or \
                        (dest / "bin" / "iverilog.exe").stat().st_size != (src / "bin" / "iverilog.exe").stat().st_size:
                    shutil.rmtree(dest, ignore_errors=True)
                    shutil.copytree(src, dest)
                src = dest
                break
            except OSError:
                continue
    _bundled_cache["bin"] = str(src / "bin")
    return _bundled_cache["bin"]


def _bundled_icarus_args(pre, name):
    """Point the built-in Icarus at its own lib/ivl folder explicitly (-B for iverilog, -M for vvp)
    instead of relying on it finding itself from the .exe location."""
    b = bundled_icarus_bin()
    if not pre or not b or Path(pre[0]).parent != Path(b):
        return []
    lib = str(Path(b).parent / "lib" / "ivl")
    return ["-B", lib] if name == "iverilog" else ["-M", lib]


def _tool(name, root):
    """argv prefix for running `name` with cwd=root, plus a path converter for its arguments."""
    p = shutil.which(name)
    if p:
        return [p], (lambda x: x), False
    if name in ("iverilog", "vvp") and CONFIG.get("use_bundled_icarus", True) and bundled_icarus_bin():
        return [str(Path(bundled_icarus_bin()) / f"{name}.exe")], (lambda x: x), False
    if IS_WIN and wsl_tool(name):
        return [shutil.which("wsl") or "wsl.exe", "--cd", to_wsl_path(root), "-e", name], to_wsl_path, True
    return None, None, False


def _wsl_missing(job, names, pkg):
    if IS_WIN and wsl_available():
        job.log(f"{names[0]} is not installed in WSL. Open Ubuntu (WSL) and run:", "err")
        job.log(f"    sudo apt update && sudo apt install {pkg}", "err")
        job.log("Then restart SV Studio (or press Save in Settings to re-detect tools).", "err")
    elif IS_WIN:
        job.log(f"{names[0]} does not run natively on Windows. Install WSL first: open PowerShell as admin and run", "err")
        job.log("    wsl --install", "err")
        job.log(f"reboot, open Ubuntu, run  sudo apt update && sudo apt install {pkg}  and restart SV Studio.", "err")
        if names[0] == "Verilator":
            job.log("Or pick Questa / Icarus in the Simulator menu instead.", "err")
    else:
        job.log(f"{names[0]} not found on PATH. Install it with:  sudo apt install {pkg}", "err")


def verilator_build(job, proj, top, runtime, lint_only=False):
    root = Path(proj["root"])
    pre, conv, via_wsl = _tool("verilator", str(root))
    if not pre:
        _wsl_missing(job, ["Verilator"], "verilator build-essential")
        return False, None, False
    if via_wsl and not lint_only and not wsl_tool("make"):
        _wsl_missing(job, ["make / g++ (needed to build Verilator simulations)"], "build-essential")
        return False, None, False
    if via_wsl:
        job.log("Running Verilator inside WSL (first build on a Windows drive can take a while)…", "info")
    build = root / BUILD_DIR
    build.mkdir(exist_ok=True)
    files = [conv(_rel(f["path"], str(root))) for f in _src_files(proj, job, verilog_only=True, top=top)]
    prims = _prims_file(job, proj, top)
    if prims:
        files = [conv(prims)] + files
    incs = ["-I" + conv(_rel(d, str(root))) for d in _incdirs(proj)]
    flags = _split(CONFIG.get("verilator_flags"))
    base = pre + ["--timing", "--timescale", "1ns/1ps", "-Wno-fatal", "-Wno-lint", "-Wno-style",
                  "-Wno-MULTITOP", "-Wno-TIMESCALEMOD"] + incs + flags
    if lint_only:
        tops = ["--top-module", top] if top else []
        return run_cmd(job, base + ["--lint-only"] + tops + files, str(root)) == 0, None, via_wsl
    wp, vcd_rel = _write_wrapper(proj, top, build, _runtime_literal(runtime))
    mdir = verilator_mdir(str(root), via_wsl)
    job.verilator_mdir = mdir
    stop_cpp = write_stop_handler(mdir, via_wsl)
    cmd = base + ["--main", "--exe", "--trace", "--top-module", WRAPPER_TOP,
                  "-Mdir", mdir, "-o", "Vsim", "-CFLAGS", "-DVL_USER_STOP"] + \
        files + [conv(_rel(str(wp), str(root))), stop_cpp]
    ok = verilate_and_make(job, cmd, mdir, "V" + WRAPPER_TOP, str(root), via_wsl)
    return ok, vcd_rel, via_wsl


def verilator_sim(job, proj, top, runtime):
    ok, vcd_rel, via_wsl = verilator_build(job, proj, top, runtime)
    if not ok:
        return 1, None
    root = Path(proj["root"])
    mdir = job.verilator_mdir
    if via_wsl:
        cmd = [shutil.which("wsl") or "wsl.exe", "--cd", to_wsl_path(str(root)), "-e", f"{mdir}/Vsim"]
    else:
        exe = Path(mdir) if Path(mdir).is_absolute() else root / mdir
        cmd = [str(exe / ("Vsim.exe" if IS_WIN else "Vsim"))]
    rc = run_cmd(job, cmd, str(root))
    return rc, root / vcd_rel


def icarus_build(job, proj, top, runtime, compile_only=False):
    root = Path(proj["root"])
    pre, conv, via_wsl = _tool("iverilog", str(root))
    if not pre:
        _wsl_missing(job, ["Icarus Verilog"], "iverilog")
        if IS_WIN:
            job.log("(Alternatively install the native Windows build from bleyer.org/icarus and tick 'add to PATH'.)", "err")
        return False, None
    build = root / BUILD_DIR
    build.mkdir(exist_ok=True)
    files = [conv(_rel(f["path"], str(root))) for f in _src_files(proj, job, verilog_only=True, top=top)]
    prims = _prims_file(job, proj, top)
    if prims:
        files = [conv(prims)] + files
    incs = ["-I" + conv(_rel(d, str(root))) for d in _incdirs(proj)]
    if top and compile_only:
        vcd_rel, opts, extra = None, ["-s", top], []
    elif top:
        wp, vcd_rel = _write_wrapper(proj, top, build, _runtime_literal(runtime))
        opts, extra = ["-s", WRAPPER_TOP], [conv(_rel(str(wp), str(root)))]
    else:
        vcd_rel, opts, extra = None, [], []
    # all options before the source files: the Windows build of iverilog stops reading options at the first file
    cmd = pre + _bundled_icarus_args(pre, "iverilog") + ["-g2012", "-o", f"{BUILD_DIR}/sim.vvp"] + opts + incs + \
        _split(CONFIG.get("iverilog_flags")) + files + extra
    return run_cmd(job, cmd, str(root)) == 0, vcd_rel


def icarus_sim(job, proj, top, runtime):
    ok, vcd_rel = icarus_build(job, proj, top, runtime)
    if not ok:
        return 1, None
    root = Path(proj["root"])
    pre, _, _ = _tool("vvp", str(root))
    rc = run_cmd(job, (pre or ["vvp"]) + _bundled_icarus_args(pre, "vvp") + ["-n", f"{BUILD_DIR}/sim.vvp"], str(root))
    return rc, root / vcd_rel


# --------------------------------------------------------------------------- virtual lab board
# Live simulation of designs built on the COMP12111 lab board wrapper (BoardV3). The lab's
# BoardV3 is swapped for board/BoardV3_virtual.sv, which exchanges keypad/switch/display/LED
# state and the Ackie (Bennett) MU0 port with the UI through a small C++ harness.
BOARD_DIR = APP_DIR / "board"
BOARD_MODULE = "BoardV3"
BOARD_TOP = "svs_board_top"


def board_tops(proj):
    """Modules that instantiate the lab board wrapper directly (e.g. Display_Decoder_Board)."""
    return [m["name"] for m in proj["modules"] if BOARD_MODULE in m["deps"]]


def _board_closure(proj, top):
    mods = {m["name"]: m for m in proj["modules"]}
    seen, stack = set(), [top]
    while stack:
        n = stack.pop()
        if n in seen or n not in mods or n == BOARD_MODULE:
            continue
        seen.add(n)
        stack.extend(mods[n]["deps"])
    return seen, mods


def board_info(proj, top):
    need, mods = _board_closure(proj, top)
    return {"top": top, "mu0": any(n == "MU0" or n.startswith("MU0_Memory") for n in need)}


def _board_wrapper(proj, top):
    mod = next(m for m in proj["modules"] if m["name"] == top)
    conns = []
    for p in mod["ports"]:
        n, d = p["name"], p["dir"]
        if d == "input":
            if n.lower() in ("clk", "clock"):
                conns.append(f".{n}(Clk)")
            elif "keycol" in n.lower():
                conns.append(f".{n}('1)")      # no key pressed (active-low columns)
            else:
                conns.append(f".{n}('0)")
        else:
            conns.append(f".{n}()")
    return ("// Generated by SV Studio for the virtual lab board\n`timescale 1ns/1ps\n"
            f"module {BOARD_TOP} (input logic Clk);\n  {top} dut (\n    " + ",\n    ".join(conns) +
            "\n  );\nendmodule\n")


def board_build(job, proj, top):
    """Build the live board simulation. Returns argv to run it (cwd = project root) or None."""
    root = Path(proj["root"])
    if not any(m["name"] == top for m in proj["modules"]):
        job.log(f"Module '{top}' not found.", "err")
        return None
    if top not in board_tops(proj):
        job.log(f"'{top}' doesn't instantiate the lab board ({BOARD_MODULE}). Pick a *_Board module.", "err")
        return None
    pre, conv, via_wsl = _tool("verilator", str(root))
    if not pre:
        _wsl_missing(job, ["Verilator (the virtual board needs it)"], "verilator build-essential")
        return None
    if via_wsl and not wsl_tool("make"):
        _wsl_missing(job, ["make / g++ (needed to build the virtual board)"], "build-essential")
        return None
    need, mods = _board_closure(proj, top)
    defining = {}
    for m in proj["modules"]:
        defining.setdefault(m["file"], set()).add(m["name"])
    files = []
    for f in proj["files"]:
        if f["kind"] not in ("sv", "v") or not f["exists"]:
            continue
        names = defining.get(f["path"])
        if names is None or names & need:
            if names and BOARD_MODULE in names:
                continue
            files.append(conv(_rel(f["path"], str(root))))
    build = root / BUILD_DIR
    build.mkdir(exist_ok=True)
    used = sorted({p for n in need for p in mods[n]["prims"]})
    if used:
        (build / PRIMS_FILE).write_text("`timescale 1ns/1ps\n\n" + "\n".join(PRIMS[n] for n in sorted(PRIMS)),
                                        encoding="utf-8")
        files.insert(0, conv(f"{BUILD_DIR}/{PRIMS_FILE}"))
        job.log("Using SV Studio's built-in models for Xilinx primitives: " + ", ".join(used[:12]), "info")
    shutil.copyfile(BOARD_DIR / "BoardV3_virtual.sv", build / "BoardV3_virtual.sv")
    (build / "svs_board_top.sv").write_text(_board_wrapper(proj, top), encoding="utf-8")
    files += [conv(f"{BUILD_DIR}/BoardV3_virtual.sv"), conv(f"{BUILD_DIR}/svs_board_top.sv")]
    mdir = verilator_mdir(str(root), via_wsl)
    mdir = mdir.rstrip("/\\") + "_board" if not mdir.endswith("obj_dir") else str(Path(mdir).parent / "obj_board")
    if not via_wsl:
        Path(mdir).mkdir(parents=True, exist_ok=True)
    main_cpp = write_build_file(f"{mdir}/board_main.cpp",
                                (BOARD_DIR / "board_main.cpp").read_text(encoding="utf-8"), via_wsl)
    incs = ["-I" + conv(_rel(d, str(root))) for d in _incdirs(proj)]
    job.log(f"Building the virtual lab board for '{top}' ({len(files)} files, lab {BOARD_MODULE} replaced by SV Studio's model)…", "info")
    if via_wsl:
        job.log("Running Verilator inside WSL - the first build takes a minute.", "info")
    cmd = pre + ["--cc", "--exe", "--no-timing", "--timescale", "1ns/1ps",
                 "-Wno-fatal", "-Wno-lint", "-Wno-style", "-Wno-MULTITOP", "-Wno-TIMESCALEMOD",
                 "-Wno-STMTDLY", "-Wno-PINCONNECTEMPTY", "-O3", "-CFLAGS", "-O2", "-LDFLAGS", "-pthread",
                 "--top-module", BOARD_TOP, "-Mdir", mdir, "-o", "Vboard"] + incs + files + [main_cpp]
    if not verilate_and_make(job, cmd, mdir, "V" + BOARD_TOP, str(root), via_wsl):
        return None
    if via_wsl:
        return [shutil.which("wsl") or "wsl.exe", "--cd", to_wsl_path(str(root)), "-e", f"{mdir}/Vboard"]
    exe = Path(mdir) / ("Vboard.exe" if IS_WIN else "Vboard")
    return [str(exe)]


class BoardSession:
    def __init__(self, proj, top, info):
        self.proj, self.top, self.info = proj, top, info
        self.proc = None
        self.state = None
        self.seq = 0
        self.lines = []
        self.lock = threading.Lock()
        self.alive = False
        self.exit_code = None

    def start(self, argv):
        kw = {"creationflags": 0x08000000} if IS_WIN else {"start_new_session": True}
        self.proc = subprocess.Popen(argv, cwd=self.proj["root"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                     bufsize=1, env=_env(), **kw)
        self.alive = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            line = line.rstrip("\r\n")
            if line.startswith("@S "):
                try:
                    st = json.loads(line[3:])
                except ValueError:
                    continue
                with self.lock:
                    self.state = st
                    self.seq += 1
            else:
                with self.lock:
                    self.lines.append(line)
                    del self.lines[:-500]
        self.exit_code = self.proc.wait()
        self.alive = False

    def send(self, cmd):
        if not self.alive or not self.proc or not self.proc.stdin:
            raise ValueError("The virtual board isn't running")
        try:
            self.proc.stdin.write(cmd.strip() + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            raise ValueError("The virtual board isn't running")

    def snapshot(self, since):
        with self.lock:
            return {"alive": self.alive, "top": self.top, "info": self.info, "state": self.state, "seq": self.seq,
                    "log": self.lines[since:] if since <= len(self.lines) else self.lines[-50:],
                    "next": len(self.lines), "exit": self.exit_code}

    def stop(self):
        p = self.proc
        if not p:
            return
        try:
            if self.alive:
                p.stdin.write("quit\n")
                p.stdin.flush()
                p.wait(timeout=2)
        except Exception:
            pass
        if p.poll() is None:
            try:
                if IS_WIN:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, creationflags=0x08000000)
                else:
                    os.killpg(p.pid, signal.SIGTERM)
            except Exception:
                p.kill()
        self.alive = False


BOARD = {"session": None}


def board_worker(job, proj, top):
    try:
        job.log(f"{APP_NAME} · virtual lab board · project: {proj['name']}", "info")
        if BOARD["session"]:
            BOARD["session"].stop()
            BOARD["session"] = None
        argv = board_build(job, proj, top)
        if argv and not job.cancelled:
            sess = BoardSession(proj, top, board_info(proj, top))
            sess.start(argv)
            BOARD["session"] = sess
            job.log("Board is live - switch to the Board tab.", "info")
            job.ok = True
        else:
            job.ok = False
    except Exception as e:
        job.log(f"Error: {e}", "err")
        job.ok = False
    finally:
        el = time.time() - job.started
        job.log(("✔ Board started" if job.ok else "✖ Board build failed") + f" in {el:.1f}s",
                "done-ok" if job.ok else "done-err")
        job.done = True


def parse_memfile(path):
    """$readmemh-style file -> list of (addr, value)."""
    out, addr = [], 0
    text = _strip_comments(Path(path).read_text(encoding="utf-8", errors="replace"))
    for tok in text.split():
        if tok.startswith("@"):
            addr = int(tok[1:], 16)
            continue
        tok = tok.replace("_", "")
        if re.fullmatch(r"[0-9a-fA-F]+", tok):
            out.append((addr & 0xFFF, int(tok, 16) & 0xFFFF))
            addr += 1
    return out


# --------------------------------------------------------------------------- FPGA timing (Vivado)
# Runs the same Vivado flow as the lab build script (synth -> place -> route on the board's
# Spartan-7) and reports static timing, or reads the timing summary out of a lab build log.
FPGA_PART = "xc7s25ftgb196-1"
LAB_XDC_DIR = "/cadtools5/questa_custom/resource/comp12111"   # on the Tootill lab machines


def find_vivado():
    p = (CONFIG.get("vivado_path") or "").strip().strip('"')
    if p:
        pp = Path(p)
        if pp.is_dir():
            for c in ("bin/vivado.bat", "bin/vivado", "vivado.bat", "vivado"):
                if (pp / c).exists():
                    return str(pp / c)
        elif pp.exists():
            return str(pp)
    w = shutil.which("vivado")
    if w:
        return w
    if IS_WIN:
        pats = ["C:/Xilinx/Vivado/*/bin/vivado.bat", "C:/Xilinx/*/Vivado/bin/vivado.bat",
                "C:/AMDDesignTools/*/Vivado/bin/vivado.bat", "D:/Xilinx/Vivado/*/bin/vivado.bat"]
    else:
        pats = ["/tools/Xilinx/Vivado/*/bin/vivado", "/tools/Xilinx/*/Vivado/bin/vivado",
                "/opt/Xilinx/Vivado/*/bin/vivado", "/opt/Xilinx/*/Vivado/bin/vivado",
                str(Path.home() / "Xilinx/Vivado/*/bin/vivado"), "/cadtools5/Xilinx_Vivado_*/Vivado/*/bin/vivado"]
    hits = []
    for pat in pats:
        hits += glob.glob(pat)

    def ver(h):
        return [int(x) for x in re.findall(r"(\d{4})\.(\d)", h.replace("\\", "/"))[-1]] if re.search(r"\d{4}\.\d", h) else [0]
    hits.sort(key=ver)
    return hits[-1] if hits else None


SYNTH_HINTS = {
    "Synth 8-327": "Latch inferred: a combinational block doesn't assign this signal on every path. Add a default value or an else/default branch.",
    "Synth 8-7137": "Usually caused by mixing blocking (=) and non-blocking (<=) assignments to the same register in an always_ff block.",
    "Synth 8-3352": "Multi-driven net: the signal is assigned in more than one place.",
    "Synth 8-689": "Port width mismatch in an instance connection.",
    "Synth 8-7023": "An instance leaves some ports unconnected.",
    "Synth 8-6014": "Register removed because its output is never used.",
    "Synth 8-3332": "Register removed because its output is never used.",
    "Synth 8-3848": "Net has no driver - it will be tied to a constant.",
    "Synth 8-3917": "Output pin driven by a constant. Normal for board outputs your design doesn't use.",
    "Synth 8-7129": "Input pin not used. Normal for board inputs your design doesn't use.",
    "Synth 8-4446": "Instance outputs unconnected. Normal for unused parts of the board wrapper.",
    "Synth 8-155": "case statement without a default branch.",
    "Synth 8-567": "Signal read in a combinational block but missing from the sensitivity list.",
}

VIV_MSG_RE = re.compile(r"^(CRITICAL WARNING|WARNING|ERROR): \[([^\]]+)\] (.*?)(?: \[([^\[\]]+?):(\d+)\])?\s*$")


def _map_src(path, proj):
    """Map a path from a Vivado log (possibly from a lab machine) to a project file."""
    if not path:
        return None
    p = path.replace("\\", "/")
    by_rel = {f["rel"].lower(): f for f in proj["files"]}
    for f in proj["files"]:
        if f["path"].replace("\\", "/").lower() == p.lower():
            return f
    parts = p.split("/")
    for i in range(1, len(parts)):
        f = by_rel.get("/".join(parts[i:]).lower())
        if f:
            return f
    base = parts[-1].lower()
    same = [f for f in proj["files"] if Path(f["path"]).name.lower() == base]
    return same[0] if len(same) == 1 else None


def _board_lib_files(proj):
    if not any(m["name"] == BOARD_MODULE for m in proj["modules"]):
        return set()
    need, mods = design_closure(proj, BOARD_MODULE)
    return {mods[n]["file"] for n in need}


def parse_vivado_messages(text, proj):
    lib = _board_lib_files(proj)
    out, seen = [], set()
    for line in text.splitlines():
        m = VIV_MSG_RE.match(line.strip())
        if not m:
            continue
        sev, mid, msg, fpath, ln = m.groups()
        key = (sev, mid, msg, fpath, ln)
        if key in seen:
            continue
        seen.add(key)
        f = _map_src(fpath, proj) if fpath else None
        out.append({"sev": "error" if sev == "ERROR" else "critical" if sev.startswith("CRITICAL") else "warning",
                    "id": mid, "msg": msg, "file": f["path"] if f else fpath, "rel": f["rel"] if f else None,
                    "line": int(ln) if ln else None, "user": bool(f) and f["path"] not in lib,
                    "hint": SYNTH_HINTS.get(mid)})
    rank = {"error": 0, "critical": 1, "warning": 2}
    out.sort(key=lambda w: (rank[w["sev"]], not w["user"], w["id"], w["rel"] or "", w["line"] or 0))
    return out


def _vivado_line_transform(proj):
    """Rewrite Vivado messages so file references become project-relative (clickable, go to Problems)."""
    def tf(line):
        m = VIV_MSG_RE.match(line.strip())
        if m and m.group(4):
            f = _map_src(m.group(4), proj)
            loc = f["rel"] if f else Path(m.group(4)).name
            return f"{m.group(1)}: [{m.group(2)}] {m.group(3)}  {loc}:{m.group(5)}"
        return line
    return tf


def parse_timing_summary(text):
    r = {}
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if "WNS(ns)" in ln and "TNS(ns)" in ln:
            for nxt in lines[i + 1:i + 5]:
                vals = nxt.split()
                if len(vals) >= 8 and re.fullmatch(r"-?[\d.]+|NA", vals[0]):
                    num = lambda v: None if v == "NA" else float(v)
                    r.update(wns=num(vals[0]), tns=num(vals[1]), tns_fail=int(vals[2]), tns_total=int(vals[3]),
                             whs=num(vals[4]), ths=num(vals[5]), ths_fail=int(vals[6]), ths_total=int(vals[7]))
                    if len(vals) >= 9:
                        r["wpws"] = num(vals[8])
                    break
            break
    clocks, in_clk = [], False
    for ln in lines:
        if re.match(r"^\s*Clock\s+Waveform\(ns\)\s+Period\(ns\)", ln):
            in_clk = True
            continue
        if in_clk:
            m = re.match(r"^\s*(\S+)\s+\{([^}]*)\}\s+([\d.]+)\s+([\d.]+)", ln)
            if m:
                clocks.append({"name": m.group(1), "period": float(m.group(3)), "freq": float(m.group(4))})
            elif clocks and not ln.strip():
                in_clk = False
    r["clocks"] = clocks
    r["checks"] = []
    for ln in lines:
        m = re.match(r"^\s*There (?:is|are) (\d+) (.+?)\.?\s*(?:\(HIGH\)|\(MEDIUM\)|\(LOW\))?\s*$", ln)
        if m and int(m.group(1)) > 0 and not re.search(r"(input|output) delay", m.group(2)):
            r["checks"].append(f"{m.group(1)} {m.group(2)}")
    if "All user specified timing constraints are met" in text:
        r["met"] = True
    elif "Timing constraints are not met" in text:
        r["met"] = False
    return r


def parse_utilization(text):
    want = {"Slice LUTs": "lut", "Slice Registers": "ff", "Block RAM Tile": "bram", "Bonded IOB": "io", "DSPs": "dsp"}
    out = {}
    for ln in text.splitlines():
        cells = [c.strip() for c in ln.split("|")]
        if len(cells) > 6 and cells[1].rstrip("*") in want and want[cells[1].rstrip("*")] not in out:
            try:
                out[want[cells[1].rstrip("*")]] = {"used": float(cells[2]), "avail": float(cells[-3]) if cells[-3] else None,
                                                   "pct": float(cells[-2]) if cells[-2] else None}
            except ValueError:
                pass
    return out


def parse_paths(text):
    out = []
    for ln in text.splitlines():
        c = ln.split("\t")
        if len(c) < 11:
            continue
        def f(v):
            try:
                return float(v)
            except ValueError:
                return None
        out.append({"kind": "setup" if c[0] == "max" else "hold", "slack": f(c[1]), "from": c[2], "to": c[3],
                    "delay": f(c[4]), "levels": int(c[5]) if c[5].isdigit() else None, "sclk": c[6], "eclk": c[7],
                    "req": f(c[8]), "smod": c[9], "emod": c[10]})
    return out


def _timing_dir(proj, top):
    return Path(proj["root"]) / BUILD_DIR / "timing" / re.sub(r"\W+", "_", top)


def read_run_results(proj, top):
    d = _timing_dir(proj, top)
    summ = d / "timing_summary.rpt"
    log = d / "vivado.log"
    if not log.exists():
        return None
    res = {"source": "run", "dir": str(d), "log": str(log), "when": log.stat().st_mtime, "completed": summ.exists(),
           "part": FPGA_PART}
    if summ.exists():
        res.update(parse_timing_summary(summ.read_text(errors="replace")))
    if (d / "utilization.rpt").exists():
        res["util"] = parse_utilization((d / "utilization.rpt").read_text(errors="replace"))
    if (d / "paths.tsv").exists():
        res["paths"] = parse_paths((d / "paths.tsv").read_text(errors="replace"))
    if (d / "constraints.txt").exists():
        res["constraints"] = (d / "constraints.txt").read_text(errors="replace").strip()
    res["messages"] = parse_vivado_messages(log.read_text(errors="replace"), proj)
    return res


def read_lab_results(proj, top):
    """Timing summary from the lab's own Vivado build (synthesis/<top>/vivado*.log)."""
    logs = [Path(p) for p in glob.glob(str(Path(proj["root"]) / "synthesis" / top / "vivado*.log"))]
    logs = [p for p in logs if p.stat().st_size > 2000]
    if not logs:
        return None
    logs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    best = None
    for p in logs:
        t = p.read_text(errors="replace")
        m = None
        for m in re.finditer(r"Post Routing Timing Summary \| WNS=(-?[\d.]+)\s*\| TNS=(-?[\d.]+)\s*\| WHS=(-?[\d.]+|N/A)\s*\| THS=(-?[\d.]+|N/A)", t):
            pass
        if m or best is None:
            best = (p, t, m)
        if m:
            break
    p, t, m = best
    num = lambda v: None if v in (None, "N/A") else float(v)
    res = {"source": "lab", "log": str(p), "when": p.stat().st_mtime, "completed": bool(m), "part": FPGA_PART,
           "messages": parse_vivado_messages(t, proj)}
    dm = re.search(r"Start of session at:\s*(.+)", t) or re.search(r"\| Date\s*:\s*(.+)", t)
    if dm:
        res["date"] = dm.group(1).strip()
    if m:
        res.update(wns=num(m.group(1)), tns=num(m.group(2)), whs=num(m.group(3)), ths=num(m.group(4)))
        res["met"] = (res["wns"] is None or res["wns"] >= 0) and (res["whs"] is None or res["whs"] >= 0)
    return res


def physical_xdc(proj):
    """Pin constraints: from a lab post_route_io.rpt in the project if there is one, else SV Studio's copy."""
    rpts = sorted(glob.glob(str(Path(proj["root"]) / "synthesis" / "*" / "post_route_io.rpt")),
                  key=lambda p: Path(p).stat().st_mtime, reverse=True)
    for rp in rpts:
        x = xdc_from_io_report(Path(rp).read_text(errors="replace"))
        if x:
            return x, _rel(rp, proj["root"])
    return (BOARD_DIR / "BoardV3_physical.xdc").read_text(encoding="utf-8"), "SV Studio's built-in board pinout"


def xdc_from_io_report(text):
    hdr, out = None, []
    for ln in text.splitlines():
        if not ln.startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if cells and cells[0] == "Pin Number":
            hdr = cells
            continue
        if not hdr or len(cells) != len(hdr):
            continue
        row = dict(zip(hdr, cells))
        sig = row.get("Signal Name", "")
        if not sig or row.get("Use") not in ("INPUT", "OUTPUT", "BIDIR"):
            continue
        props = [f"PACKAGE_PIN {row['Pin Number']}"]
        if row.get("IO Standard"):
            props.append(f"IOSTANDARD {row['IO Standard']}")
        if row.get("Pull Type") in ("PULLUP", "PULLDOWN", "KEEPER"):
            props.append(f"PULLTYPE {row['Pull Type']}")
        out.append(f"set_property -dict {{{' '.join(props)}}} [get_ports {{{sig}}}]")
    if not out:
        return None
    return "# Board pinout (generated by SV Studio from a lab post_route_io.rpt)\n" + "\n".join(out) + \
        "\nset_property CONFIG_VOLTAGE 3.3 [current_design]\nset_property CFGBVS VCCO [current_design]\n"


TIMING_XDC = """# Timing constraints (SV Studio). The board clock is 100 MHz on pin Clk.
create_clock -period 10.000 -name Clk [get_ports Clk]
# On this board Clk isn't on a clock-capable pin, so (like the lab build) allow general routing to the BUFG
set_property CLOCK_DEDICATED_ROUTE FALSE [get_nets -quiet Clk_IBUF]
# Clocks made by dividing Clk in BoardLib (Clocks.v) and by Ackie (proc_clk for MU0)
foreach {name pat div} {Clk_25MHz */Clk_25MHz_reg/Q 4  Clk_1kHz */Clk_1kHz_reg/Q 100000  Clk_1Hz */Clk_1Hz_reg/Q 100000000  proc_clk */proc_clk_reg/Q 32} {
  set p [get_pins -quiet -hierarchical -filter "NAME =~ $pat"]
  if {[llength $p]} { create_generated_clock -name $name -source [get_ports Clk] -divide_by $div [lindex $p 0] }
}
# Buttons, switches and displays are slow, asynchronous board signals
set_false_path -from [get_ports -filter {DIRECTION != OUT && NAME != Clk}]
set_false_path -to [get_ports -filter {DIRECTION != IN}]
"""

TIMING_TCL_TAIL = r"""
opt_design
power_opt_design
place_design -directive Explore
route_design -directive Explore
report_timing_summary -max_paths 10 -report_unconstrained -file timing_summary.rpt
report_utilization -file utilization.rpt
proc svs_mod {pin} {
  if {[catch {
    set c [get_cells -quiet -of_objects [get_pins -quiet $pin]]
    if {$c eq ""} { return "" }
    set par [get_property PARENT $c]
    if {$par eq ""} { return [get_property TOP [current_design]] }
    set pc [get_cells -quiet $par]
    set r [get_property ORIG_REF_NAME $pc]
    if {$r eq ""} { set r [get_property REF_NAME $pc] }
  } err]} { return "" }
  return $r
}
set fh [open paths.tsv w]
foreach kind {max min} {
  foreach p [get_timing_paths -quiet -delay_type $kind -max_paths 10 -nworst 1 -sort_by slack] {
    set sp [get_property STARTPOINT_PIN $p]
    set ep [get_property ENDPOINT_PIN $p]
    puts $fh [join [list $kind [get_property SLACK $p] $sp $ep [get_property DATAPATH_DELAY $p] \
      [get_property LOGIC_LEVELS $p] [get_property STARTPOINT_CLOCK $p] [get_property ENDPOINT_CLOCK $p] \
      [get_property REQUIREMENT $p] [svs_mod $sp] [svs_mod $ep]] "\t"]
  }
}
close $fh
puts "SVS_TIMING_DONE"
exit
"""


def _tcl_path(p):
    return "{" + str(p).replace("\\", "/") + "}"


def timing_worker(job, proj, top):
    try:
        job.log(f"{APP_NAME} · FPGA timing (Vivado) · {top} · part {FPGA_PART}", "info")
        viv = find_vivado()
        if not viv:
            job.log("Vivado not found. Install Vivado (the free ML Standard edition covers Spartan-7) or set its path in Settings.", "err")
            job.ok = False
            return
        need, mods = design_closure(proj, top)
        files = [f for f in proj["files"] if f["exists"] and f["kind"] in ("sv", "v")
                 and any(mods[n]["file"] == f["path"] for n in need)]
        d = _timing_dir(proj, top)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
        # $readmemh files are looked up relative to the run directory in synthesis
        for dp, dn, fn in os.walk(proj["root"]):
            dn[:] = [x for x in dn if x not in SKIP_DIRS and not x.startswith(".")]
            for f in fn:
                if f.lower().endswith((".mem", ".hex")):
                    try:
                        shutil.copyfile(Path(dp, f), d / f)
                    except OSError:
                        pass
        lab_t, lab_p = Path(LAB_XDC_DIR, "BoardV3_timing.xdc"), Path(LAB_XDC_DIR, "BoardV3_physical.xdc")
        if lab_t.exists() and lab_p.exists():
            xdcs, note = [lab_t, lab_p], f"the lab's constraint files ({LAB_XDC_DIR})"
        else:
            phys, src = physical_xdc(proj)
            (d / "board_timing.xdc").write_text(TIMING_XDC, encoding="utf-8")
            (d / "board_pins.xdc").write_text(phys, encoding="utf-8")
            xdcs, note = [d / "board_timing.xdc", d / "board_pins.xdc"], f"Clk = 100 MHz, pins from {src}"
        (d / "constraints.txt").write_text(note, encoding="utf-8")
        job.log(f"Constraints: {note}", "info")
        incs = " ".join(_tcl_path(x) for x in _incdirs(proj))
        tcl = [f"set_param general.maxThreads {max(1, min(8, os.cpu_count() or 2))}"]
        for f in files:
            tcl.append(f"read_verilog {'-sv ' if f['kind'] == 'sv' else ''}{_tcl_path(f['path'])}")
        tcl.append(f"synth_design -top {top} -part {FPGA_PART} -fsm_extraction off -include_dirs [list {incs}]")
        tcl += [f"read_xdc {_tcl_path(x)}" for x in xdcs]
        (d / "run.tcl").write_text("\n".join(tcl) + "\n" + TIMING_TCL_TAIL, encoding="utf-8")
        job.log(f"Running Vivado on {len(files)} files: synthesis, place and route. This takes a few minutes…", "info")
        rc = run_cmd(job, [viv, "-mode", "batch", "-source", "run.tcl", "-nojournal", "-log", "vivado.log", "-notrace"],
                     str(d), transform=_vivado_line_transform(proj))
        job.ok = rc == 0 and (d / "timing_summary.rpt").exists() and not job.cancelled
        if job.ok:
            r = read_run_results(proj, top)
            if r.get("wns") is not None:
                job.log(f"Timing: WNS {r['wns']:.3f} ns · WHS {r.get('whs') or 0:.3f} ns · "
                        + ("all constraints met" if r.get("met") else "NOT met"), "info" if r.get("met") else "warn")
    except Exception as e:
        job.log(f"Error: {e}", "err")
        job.ok = False
    finally:
        el = time.time() - job.started
        job.log(("✔ Timing analysis finished" if job.ok else "✖ Timing analysis failed") + f" in {el:.1f}s",
                "done-ok" if job.ok else "done-err")
        job.done = True


# --------------------------------------------------------------------------- live checking (slang)
# slang (via its Python bindings, pyslang) parses and elaborates the whole project in a few
# milliseconds, so the editor can show errors as you type, without running a simulator.
VENDOR_DIR = APP_DIR / "vendor"
LINT = {"mod": None, "state": "unknown", "msg": "", "lock": threading.Lock(), "installing": False}
LINT_IGNORE = {"newline-eof", "empty-output-connection", "width-expand", "sign-conversion", "sign-compare",
               "unused-def", "unused-but-set-variable", "unused-variable", "unused-net", "unused-port"}
LINT_STUBS = """
module ICAPE2 #(parameter DEVICE_ID = 0, parameter ICAP_WIDTH = "X32", parameter SIM_CFG_FILE_NAME = "NONE")
  (output [31:0] O, input CLK, input CSIB, input RDWRB, input [31:0] I);
endmodule
module glbl; endmodule
"""


def _try_import_pyslang():
    try:
        import pyslang  # noqa
        return pyslang
    except Exception:
        return None


def _vendored_pyslang():
    """Unpack the pyslang wheel shipped with SV Studio (Windows / Linux x86-64, Python 3.11+), plus the
    nanobind_backend wheel it needs for this Python version, and import it."""
    if sys.version_info < (3, 11):
        LINT["msg"] = f"Python {sys.version_info.major}.{sys.version_info.minor} is too old for the built-in slang (needs 3.11+)"
        return None
    plat = "win_amd64" if IS_WIN else "manylinux" if sys.platform.startswith("linux") else None
    if not plat or platform.machine().lower() not in ("amd64", "x86_64"):
        return None
    tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    slang = sorted(VENDOR_DIR.glob(f"pyslang-*{plat}*.whl"))
    nb = sorted(VENDOR_DIR.glob(f"nanobind_backend-*-{tag}-*{plat}*.whl"))
    if not slang:
        return None
    if not nb:
        LINT["msg"] = f"No built-in slang support for Python {sys.version_info.major}.{sys.version_info.minor}"
        return None
    import zipfile
    name = "lib_" + slang[-1].stem.split("-")[1] + "_" + tag + "_" + plat
    err = None
    for base in (VENDOR_DIR, Path.home() / ".svstudio_vendor"):
        dest = base / name
        try:
            if not (dest / "pyslang").exists() or not (dest / "nanobind_backend").exists():
                tmp = dest.with_name(dest.name + ".tmp")
                shutil.rmtree(tmp, ignore_errors=True)
                for whl in (slang[-1], nb[-1]):
                    with zipfile.ZipFile(whl) as z:
                        z.extractall(tmp)
                shutil.rmtree(dest, ignore_errors=True)
                tmp.rename(dest)
            if str(dest) not in sys.path:
                sys.path.insert(0, str(dest))
            import pyslang  # noqa
            return pyslang
        except Exception as e:
            err = e
            continue
    if err:
        LINT["msg"] = f"Couldn't load the built-in slang: {err}"
    return None


def _pip_install_pyslang():
    if FROZEN:   # SVStudio.exe: no pip, and the bundled wheel should already have worked
        LINT["state"] = "off"
        LINT["msg"] = "Live checking unavailable. " + (LINT["msg"] or "Couldn't load the built-in slang.")
        return
    LINT["installing"] = True
    LINT["state"], LINT["msg"] = "installing", "Installing the slang checker (pip install pyslang)…"
    try:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--user", "--disable-pip-version-check", "pyslang"],
                           capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL,
                           creationflags=0x08000000 if IS_WIN else 0)
        import importlib, site
        importlib.invalidate_caches()
        try:
            up = site.getusersitepackages()
            if up not in sys.path:
                sys.path.append(up)
        except Exception:
            pass
        mod = _try_import_pyslang()
        if mod:
            LINT["mod"], LINT["state"], LINT["msg"] = mod, "ok", "slang " + getattr(mod, "__version__", "")
        else:
            LINT["state"] = "off"
            LINT["msg"] = (LINT["msg"] + ". " if LINT["msg"] else "") + "Couldn't install pyslang with pip (" + \
                ((r.stderr or r.stdout).strip().splitlines() or ["pip failed"])[-1][:200] + ")"
    except Exception as e:
        LINT["state"], LINT["msg"] = "off", f"Live checking unavailable: {e}"
    finally:
        LINT["installing"] = False


def lint_init(retry=False):
    with LINT["lock"]:
        if LINT["mod"] or LINT["installing"] or (LINT["state"] == "off" and not retry):
            return
        LINT["msg"] = ""
        mod = _try_import_pyslang() or _vendored_pyslang()
        if mod:
            LINT["mod"], LINT["state"], LINT["msg"] = mod, "ok", "slang " + getattr(mod, "__version__", "")
            return
    threading.Thread(target=_pip_install_pyslang, daemon=True).start()


def lint_project(proj, overrides):
    """Check every HDL file in the project with slang. `overrides` maps path -> unsaved editor text.
    Returns {path: [diag, …]} for project files, with diagnostics in lab board-library files limited
    to errors."""
    ps = LINT["mod"]
    if not ps:
        return None
    ov = {os.path.normcase(os.path.abspath(k)): v for k, v in (overrides or {}).items()}
    files = [f for f in proj["files"] if f["exists"] and f["kind"] in ("sv", "v")]
    sm = ps.SourceManager()
    for d in _incdirs(proj):
        try:
            sm.addUserDirectories(d)
        except Exception:
            pass
    pp = ps.parsing.PreprocessorOptions()
    pp.predefines = [f"{d['name']}={d['value']}" if d["value"] else d["name"]
                     for d in proj.get("defines", []) if "(" not in d["name"]]
    pp.additionalIncludePaths = _incdirs(proj)
    co = ps.ast.CompilationOptions()
    co.errorLimit = 10000
    try:
        co.defaultTimeScale = ps.TimeScale.fromString("1ns/1ps")
    except Exception:
        pass
    bag = ps.Bag([pp, co])
    comp = ps.ast.Compilation(bag)
    known = {m["name"] for m in proj["modules"]}
    stubs = "`timescale 1ns/1ps\n" + "".join(PRIMS[n] for n in sorted(PRIMS) if n not in known) + \
        "".join(b + "endmodule\n" for b in re.split(r"endmodule\n", LINT_STUBS) if b.strip()
                and re.search(r"module (\w+)", b).group(1) not in known)
    comp.addSyntaxTree(ps.syntax.SyntaxTree.fromText(stubs, sm, "svs_stubs.v", "", bag))
    by_path = {}
    for f in files:
        key = os.path.normcase(os.path.abspath(f["path"]))
        text = ov.get(key)
        if text is None:
            try:
                text = Path(f["path"]).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
        by_path[key] = f["path"]
        try:
            tree = ps.syntax.SyntaxTree.fromText(text, sm, Path(f["path"]).name, f["path"], bag)
        except RuntimeError:  # already pulled in by an `include - parse it again under another name
            alt = f["path"] + ".svs"
            by_path[os.path.normcase(os.path.abspath(alt))] = f["path"]
            tree = ps.syntax.SyntaxTree.fromText(text, sm, Path(f["path"]).name, alt, bag)
        comp.addSyntaxTree(tree)
    eng = ps.DiagnosticEngine(sm)
    lib = _board_lib_files(proj)
    out = {f["path"]: [] for f in files}
    seen = set()
    for d in comp.getAllDiagnostics():
        loc = d.location
        try:
            full = sm.getFullPath(loc.buffer) if hasattr(loc, "buffer") else ""
        except Exception:
            full = ""
        if not full:
            try:
                full = str(sm.getFileName(loc))
            except Exception:
                continue
        path = by_path.get(os.path.normcase(os.path.abspath(str(full))))
        if not path:
            continue
        sev = eng.getSeverity(d.code, loc)
        sev_name = str(sev).rsplit(".", 1)[-1].lower()
        if sev_name in ("ignored", "note"):
            continue
        opt = eng.getOptionName(d.code)
        msg = eng.formatMessage(d)
        if opt in LINT_IGNORE or "time scale" in msg:
            continue
        is_err = sev_name in ("error", "fatal")
        if path in lib and not is_err:
            continue
        line, col = sm.getLineNumber(loc), sm.getColumnNumber(loc)
        k = (path, line, col, msg)
        if k in seen:
            continue
        seen.add(k)
        out[path].append({"line": line, "col": col, "severity": "error" if is_err else "warning",
                          "message": msg + (f" [{opt}]" if opt else ""), "code": opt or str(d.code)})
    return out


ERR_RE = re.compile(r"(\*\* Error|%Error|\berror\b|Fatal)", re.I)


def job_worker(job, action, proj, backend, top, runtime):
    try:
        root = proj["root"]
        job.log(f"{APP_NAME} · {action} · backend: {backend} · project: {proj['name']}", "info")
        if action == "compile":
            if backend == "questa":
                ok = questa_compile(job, proj)
            elif backend == "verilator":
                ok, _, _ = verilator_build(job, proj, top, runtime, lint_only=True)
            else:
                ok, _ = icarus_build(job, proj, top, runtime, compile_only=True)
            job.ok = ok and not job.cancelled
        else:
            if not top:
                raise ValueError("Choose a top-level module (your testbench) first.")
            mod = next((m for m in proj["modules"] if m["name"] == top), None)
            if mod and mod["has_ports"] and backend != "questa":
                job.log(f"Warning: '{top}' has ports. Pick your testbench as the top module.", "warn")
            if backend == "questa":
                if CONFIG.get("compile_before_sim", True):
                    if not questa_compile(job, proj):
                        job.ok = False
                        return
                rc, vcd = questa_sim(job, proj, top, runtime)
            elif backend == "verilator":
                rc, vcd = verilator_sim(job, proj, top, runtime)
            else:
                rc, vcd = icarus_sim(job, proj, top, runtime)
            had_errors = any(ERR_RE.search(l["t"]) and l["c"] != "cmd" and "Errors: 0" not in l["t"]
                             for l in job.lines[-400:])
            if vcd and Path(vcd).exists() and Path(vcd).stat().st_mtime >= job.started - 1:
                job.vcd = str(Path(vcd).resolve())
            elif vcd and not job.cancelled:
                job.log(f"No waveform file produced ({vcd}).", "warn")
            job.ok = not job.cancelled and (rc == 0 or (job.vcd is not None and not had_errors))
        if job.cancelled:
            job.log("Stopped by user.", "warn")
    except Exception as e:
        job.log(f"Error: {e}", "err")
        job.ok = False
    finally:
        el = time.time() - job.started
        job.log(("✔ " if job.ok else "✖ ") + f"{action.capitalize()} {'finished' if job.ok else 'failed'} in {el:.1f}s",
                "done-ok" if job.ok else "done-err")
        job.done = True


# --------------------------------------------------------------------------- helpers
def browse_dialog(kind, start):
    """Native file/folder dialog via tkinter in a subprocess (thread-safe)."""
    code = (
        "import sys, tkinter as tk\nfrom tkinter import filedialog\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        f"k = {kind!r}; s = {start!r} or None\n"
        "if k == 'dir': p = filedialog.askdirectory(initialdir=s, title='Open project folder')\n"
        "elif k == 'vcd': p = filedialog.askopenfilename(initialdir=s, title='Open VCD waveform', filetypes=[('VCD', '*.vcd'), ('All', '*.*')])\n"
        "else: p = filedialog.askopenfilename(initialdir=s, title='Open Questa project', filetypes=[('Questa project', '*.mpf'), ('HDL', '*.sv *.v'), ('All', '*.*')])\n"
        "import os\nout = os.environ.get('SVS_OUT')\n"
        "open(out, 'w', encoding='utf-8').write(p or '') if out else sys.stdout.write(p or '')\n"
    )
    try:
        exe = sys.executable
        if IS_WIN and exe.lower().endswith("pythonw.exe") and Path(exe[:-5] + ".exe").exists():
            exe = exe[:-5] + ".exe"
        kw = {"creationflags": 0x08000000} if IS_WIN else {}
        fd, out = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            r = subprocess.run([exe, "-c", code], capture_output=True, text=True, timeout=600,
                               env=dict(os.environ, SVS_OUT=out), **kw)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr and r.stderr.strip() else "dialog failed")
            return Path(out).read_text(encoding="utf-8").strip()
        finally:
            try:
                os.remove(out)
            except OSError:
                pass
    except Exception as e:
        raise RuntimeError(f"Native dialog unavailable ({e}). Paste the path instead.")


def open_vscode(path, line=None, root=None):
    code = find_vscode()
    if not code:
        raise RuntimeError("VS Code not found. Install it with the 'code' command on PATH, or set it in Settings.")
    args = [code]
    if root:
        args.append(root)
    if path and line:
        args += ["-g", f"{path}:{line}"]
    elif path:
        args.append(path)
    kw = {"creationflags": 0x08000000} if IS_WIN else {"start_new_session": True}
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)


def _allowed(path, root):
    try:
        p = Path(path).resolve()
        r = Path(root).resolve()
        return p == r or r in p.parents
    except Exception:
        return False


# --------------------------------------------------------------------------- HTTP
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}

STATE = {"project": None, "last_ping": 0.0, "bye": 0.0, "streams": 0, "had_stream": False, "stream_end": 0.0}


class Handler(BaseHTTPRequestHandler):
    server_version = "SVStudio/" + VERSION

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_ok(self):
        return self.headers.get("X-SVS-Token") == TOKEN

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _alive_stream(self):
        """The window keeps this request open; when the window closes the connection drops, which is
        how SV Studio knows to shut down (a reload reconnects within a moment)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        STATE["streams"] += 1
        STATE["had_stream"] = True
        STATE["last_ping"] = time.time()
        try:
            while True:
                self.wfile.write(b": alive\n\n")
                self.wfile.flush()
                time.sleep(1)
        except Exception:
            pass
        finally:
            STATE["streams"] -= 1
            STATE["stream_end"] = time.time()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "bad host"})
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if not u.path.startswith("/api/"):
            rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
            f = (STATIC_DIR / rel).resolve()
            if STATIC_DIR.resolve() not in f.parents or not f.exists():
                return self._send(404, "not found", "text/plain")
            data = f.read_bytes()
            if f.name == "index.html":
                data = data.replace(b"__SVS_TOKEN__", TOKEN.encode())
            return self._send(200, data, MIME.get(f.suffix, "application/octet-stream"))
        if u.path == "/api/alive" and q.get("token") == TOKEN:
            return self._alive_stream()
        if not self._api_ok():
            return self._send(403, {"error": "forbidden"})
        try:
            if u.path == "/api/ping":
                STATE["last_ping"] = time.time()
                return self._send(200, {"ok": True})
            if u.path == "/api/status":
                STATE["last_ping"] = time.time()
                return self._send(200, {"tools": tool_status(), "config": CONFIG, "project": STATE["project"]})
            if u.path == "/api/job":
                job = JOBS.get(q.get("id"))
                if not job:
                    return self._send(404, {"error": "no such job"})
                return self._send(200, job.snapshot(int(q.get("since", 0))))
            if u.path == "/api/update/check":
                if CONFIG.get("auto_update", "auto") == "off" and not q.get("force"):
                    return self._send(200, {"available": False, "mode": "off", "current": local_commit()})
                return self._send(200, check_update(force=bool(q.get("force"))))
            if u.path == "/api/timing/info":
                proj = STATE["project"]
                if not proj:
                    return self._send(400, {"error": "Open a project first"})
                top = q.get("top", "")
                return self._send(200, {"vivado": find_vivado(), "part": FPGA_PART,
                                        "run": read_run_results(proj, top) if top else None,
                                        "lab": read_lab_results(proj, top) if top else None})
            if u.path == "/api/board/memfiles":
                proj = STATE["project"]
                files = []
                if proj:
                    for dp, dn, fn in os.walk(proj["root"]):
                        dn[:] = sorted(d for d in dn if d not in SKIP_DIRS and not d.startswith("."))
                        for f in sorted(fn):
                            if f.lower().endswith(".mem"):
                                full = str(Path(dp, f))
                                files.append({"path": full, "rel": _rel(full, proj["root"])})
                        if len(files) > 50:
                            break
                return self._send(200, {"files": files})
            if u.path == "/api/board/state":
                sess = BOARD["session"]
                if not sess:
                    return self._send(200, {"alive": False, "state": None})
                return self._send(200, sess.snapshot(int(q.get("since", 0))))
            if u.path == "/api/file":
                proj = STATE["project"]
                path = q.get("path", "")
                if not proj or not _allowed(path, proj["root"]):
                    return self._send(403, {"error": "File is outside the project folder"})
                return self._send(200, {"path": path, "text": Path(path).read_text(encoding="utf-8", errors="replace"),
                                        "mtime": Path(path).stat().st_mtime})
            if u.path == "/api/vcd":
                path = q.get("path", "")
                if not path.lower().endswith(".vcd") or not Path(path).is_file():
                    return self._send(404, {"error": "VCD not found"})
                data = Path(path).read_bytes()
                return self._send(200, data, "text/plain; charset=utf-8")
        except Exception as e:
            return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "unknown endpoint"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/bye" and self._host_ok() and parse_qs(u.query).get("token", [""])[0] == TOKEN:
            STATE["bye"] = time.time()   # window closed (or reloading - a ping within a few seconds cancels)
            return self._send(200, {"ok": True})
        if not self._host_ok() or not self._api_ok():
            return self._send(403, {"error": "forbidden"})
        try:
            b = self._body()
            if u.path == "/api/open":
                STATE["project"] = load_project(b["path"])
                return self._send(200, STATE["project"])
            if u.path == "/api/reload":
                if not STATE["project"]:
                    return self._send(400, {"error": "No project open"})
                STATE["project"] = load_project(STATE["project"]["mpf"] or STATE["project"]["root"])
                return self._send(200, STATE["project"])
            if u.path in ("/api/compile", "/api/simulate"):
                proj = STATE["project"]
                if not proj:
                    return self._send(400, {"error": "Open a project first"})
                proj = STATE["project"] = load_project(proj["mpf"] or proj["root"])  # pick up new files
                if any(not j.done for j in JOBS.values()):
                    return self._send(409, {"error": "A job is already running"})
                job = Job(u.path.rsplit("/", 1)[1])
                JOBS[job.id] = job
                threading.Thread(target=job_worker, daemon=True, args=(
                    job, job.kind, proj, b.get("backend", "questa"), b.get("top"), b.get("runtime", "-all"))).start()
                return self._send(200, {"id": job.id, "project": proj})
            if u.path == "/api/board/start":
                proj = STATE["project"]
                if not proj:
                    return self._send(400, {"error": "Open a project first"})
                proj = STATE["project"] = load_project(proj["mpf"] or proj["root"])
                if any(not j.done for j in JOBS.values()):
                    return self._send(409, {"error": "A job is already running"})
                top = b.get("top") or ""
                if top not in board_tops(proj):
                    return self._send(400, {"error": "Pick a module that uses the lab board (e.g. Display_Decoder_Board)."})
                job = Job("board")
                JOBS[job.id] = job
                threading.Thread(target=board_worker, daemon=True, args=(job, proj, top)).start()
                return self._send(200, {"id": job.id, "project": proj})
            if u.path == "/api/update/apply":
                if any(not j.done for j in JOBS.values()):
                    return self._send(409, {"error": "Wait for the running job to finish first"})
                job = Job("update")
                JOBS[job.id] = job
                threading.Thread(target=update_worker, daemon=True, args=(job,)).start()
                return self._send(200, {"id": job.id})
            if u.path == "/api/timing/run":
                proj = STATE["project"]
                if not proj:
                    return self._send(400, {"error": "Open a project first"})
                proj = STATE["project"] = load_project(proj["mpf"] or proj["root"])
                if any(not j.done for j in JOBS.values()):
                    return self._send(409, {"error": "A job is already running"})
                top = b.get("top") or ""
                if not any(m["name"] == top for m in proj["modules"]):
                    return self._send(400, {"error": "Pick the design to analyse"})
                job = Job("timing")
                JOBS[job.id] = job
                threading.Thread(target=timing_worker, daemon=True, args=(job, proj, top)).start()
                return self._send(200, {"id": job.id, "project": proj})
            if u.path == "/api/lint":
                proj = STATE["project"]
                if not proj:
                    return self._send(200, {"state": "noproject", "diags": {}})
                if not LINT["mod"]:
                    lint_init(retry=bool(b.get("retry")))
                    return self._send(200, {"state": LINT["state"], "msg": LINT["msg"], "diags": None})
                t0 = time.time()
                with LINT["lock"]:
                    diags = lint_project(proj, b.get("files") or {})
                return self._send(200, {"state": "ok", "msg": LINT["msg"], "diags": diags,
                                        "ms": round((time.time() - t0) * 1000)})
            if u.path == "/api/board/cmd":
                sess = BOARD["session"]
                if not sess:
                    return self._send(400, {"error": "The virtual board isn't running"})
                for c in (b.get("cmds") or [b.get("cmd", "")]):
                    if c:
                        sess.send(str(c)[:200])
                return self._send(200, {"ok": True})
            if u.path == "/api/board/loadmem":
                sess, proj = BOARD["session"], STATE["project"]
                if not sess or not proj:
                    return self._send(400, {"error": "The virtual board isn't running"})
                path = b.get("path", "")
                if not _allowed(path, proj["root"]):
                    return self._send(403, {"error": "File is outside the project folder"})
                words = parse_memfile(path)
                sess.send("stop")
                for a, v in words:
                    sess.send(f"w {a:x} {v:x}")
                sess.send("reset")
                return self._send(200, {"ok": True, "words": len(words)})
            if u.path == "/api/board/stop":
                if BOARD["session"]:
                    BOARD["session"].stop()
                    BOARD["session"] = None
                return self._send(200, {"ok": True})
            if u.path == "/api/stop":
                for j in JOBS.values():
                    if not j.done:
                        kill_job(j)
                return self._send(200, {"ok": True})
            if u.path == "/api/save":
                proj = STATE["project"]
                if not proj or not _allowed(b["path"], proj["root"]):
                    return self._send(403, {"error": "File is outside the project folder"})
                Path(b["path"]).write_text(b["text"], encoding="utf-8", newline="")
                return self._send(200, {"ok": True, "mtime": Path(b["path"]).stat().st_mtime})
            if u.path == "/api/mtimes":
                proj = STATE["project"]
                out = {}
                for path in b.get("paths", [])[:200]:
                    try:
                        out[path] = Path(path).stat().st_mtime if proj and _allowed(path, proj["root"]) else None
                    except OSError:
                        out[path] = None
                return self._send(200, out)
            if u.path == "/api/vscode":
                proj = STATE["project"]
                open_vscode(b.get("path"), b.get("line"), proj["root"] if proj else None)
                return self._send(200, {"ok": True})
            if u.path == "/api/browse":
                start = STATE["project"]["root"] if STATE["project"] else str(Path.home())
                return self._send(200, {"path": browse_dialog(b.get("kind", "file"), start)})
            if u.path == "/api/config":
                for k, v in b.items():
                    if k in DEFAULT_CONFIG and k != "recent":
                        CONFIG[k] = v
                save_config(CONFIG)
                with _wsl_lock:
                    _wsl_cache.clear()
                return self._send(200, {"config": CONFIG, "tools": tool_status()})
        except Exception as e:
            return self._send(400, {"error": str(e)})
        return self._send(404, {"error": "unknown endpoint"})


# --------------------------------------------------------------------------- self-update from GitHub
UPDATE_REPO = "Shoro123456789/System-Verilog-editor"
UPDATE_BRANCH = "main"
UPDATE = {"checked": 0.0, "info": None, "lock": threading.Lock(), "applying": False}
UPDATE_SKIP = {".git", ".github", "__pycache__"}


def local_commit():
    """Commit SV Studio was installed from: written by the updater, substituted into version.txt by
    GitHub/git archive downloads, or read from a git checkout."""
    p = APP_DIR / ".svs_commit"
    if p.exists():
        v = p.read_text(errors="replace").strip()
        if re.fullmatch(r"[0-9a-f]{40}", v):
            return v
    p = APP_DIR / "version.txt"
    if p.exists():
        v = p.read_text(errors="replace").strip()
        if re.fullmatch(r"[0-9a-f]{40}", v):
            return v
    if (APP_DIR / ".git").exists() and shutil.which("git"):
        try:
            r = subprocess.run(["git", "-C", str(APP_DIR), "rev-parse", "HEAD"], capture_output=True, text=True,
                               timeout=10, creationflags=0x08000000 if IS_WIN else 0)
            if r.returncode == 0:
                return r.stdout.strip()
        except Exception:
            pass
    return None


def _gh_get(url, accept="application/vnd.github+json", timeout=8):
    import urllib.request
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": f"SVStudio/{VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def check_update(force=False):
    with UPDATE["lock"]:
        if not force and UPDATE["info"] and time.time() - UPDATE["checked"] < 1800:
            return UPDATE["info"]
        cur = local_commit()
        info = {"current": cur, "latest": None, "available": False, "commits": [], "error": None,
                "git": (APP_DIR / ".git").exists(), "mode": CONFIG.get("auto_update", "auto")}
        try:
            c = json.loads(_gh_get(f"https://api.github.com/repos/{UPDATE_REPO}/commits/{UPDATE_BRANCH}"))
            info["latest"] = c["sha"]
            info["date"] = c["commit"]["committer"]["date"]
            info["available"] = cur != c["sha"]
            if info["available"] and cur:
                try:
                    cmp = json.loads(_gh_get(f"https://api.github.com/repos/{UPDATE_REPO}/compare/{cur}...{c['sha']}"))
                    info["commits"] = [x["commit"]["message"].splitlines()[0] for x in cmp.get("commits", [])][-20:]
                    if cmp.get("status") == "behind":   # local is newer than GitHub (e.g. a dev checkout)
                        info["available"] = False
                except Exception:
                    pass
            if info["available"] and not info["commits"]:
                info["commits"] = [c["commit"]["message"].splitlines()[0]]
        except Exception as e:
            info["error"] = f"Couldn't check for updates: {e}"
        UPDATE["info"], UPDATE["checked"] = info, time.time()
        return info


def apply_update(log=print):
    """Download the latest version from GitHub and copy it over this installation."""
    import io
    import zipfile
    info = check_update(force=True)
    if info.get("error"):
        raise RuntimeError(info["error"])
    if not info["available"]:
        log("Already up to date.")
        return False
    sha = info["latest"]
    if info["git"] and shutil.which("git"):
        log("Updating the git checkout (git pull)…")
        r = subprocess.run(["git", "-C", str(APP_DIR), "pull", "--ff-only"], capture_output=True, text=True,
                           timeout=180, creationflags=0x08000000 if IS_WIN else 0)
        log((r.stdout + r.stderr).strip())
        if r.returncode != 0:
            raise RuntimeError("git pull failed - you may have local changes. Update manually.")
        return True
    log(f"Downloading {UPDATE_REPO} @ {sha[:7]}…")
    data = _gh_get(f"https://codeload.github.com/{UPDATE_REPO}/zip/{sha}", accept="*/*", timeout=120)
    z = zipfile.ZipFile(io.BytesIO(data))
    names = [n for n in z.namelist() if not n.endswith("/")]
    prefix = names[0].split("/", 1)[0] + "/"
    if "svstudio.py" not in {n[len(prefix):] for n in names}:
        raise RuntimeError("Downloaded archive doesn't look like SV Studio")
    changed = 0
    for n in names:
        rel = n[len(prefix):]
        if not rel or rel.split("/", 1)[0] in UPDATE_SKIP:
            continue
        dest = APP_DIR / rel
        content = z.read(n)
        if rel == "version.txt":
            content = (sha + "\n").encode()
        try:
            if dest.exists() and dest.read_bytes() == content:
                continue
        except OSError:
            pass
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".svs_new")
        tmp.write_bytes(content)
        try:
            os.replace(tmp, dest)
        except OSError as e:
            try:   # a running .exe (e.g. SVStudio.exe) can't be overwritten on Windows, but it can be renamed
                old = dest.with_name(dest.name + ".old")
                if old.exists():
                    old.unlink()
                os.replace(dest, old)
                os.replace(tmp, dest)
            except OSError:
                tmp.unlink(missing_ok=True)
                log(f"Couldn't replace {rel}: {e}")
                continue
        changed += 1
    (APP_DIR / ".svs_commit").write_text(sha + "\n")
    log(f"Updated {changed} file(s) to {sha[:7]}.")
    with UPDATE["lock"]:
        UPDATE["info"] = None
    return True


RUN = {"args": None, "mode": None, "port": None, "httpd": None}


def restart_app():
    """Start a fresh SV Studio process (running the updated code) and exit this one."""
    a = RUN["args"]
    argv = self_argv()
    if a and a.project:
        argv.append(a.project)
    if RUN["mode"] == "webview" or (a and a.no_window):
        argv += (["--no-window"] if a and a.no_window else []) + ["--port", str(RUN["port"]), "--wait-port"]
    else:   # the old window stays open and reloads itself once the new server answers
        argv += ["--port", str(RUN["port"]), "--wait-port", "--reuse-window"]
    if a and a.keep_alive:
        argv.append("--keep-alive")
    if BOARD["session"]:
        BOARD["session"].stop()
    for j in JOBS.values():
        if not j.done:
            kill_job(j)
    kw = {"creationflags": 0x00000008 | 0x00000200} if IS_WIN else {"start_new_session": True}
    subprocess.Popen(argv, cwd=str(APP_DIR), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True, env=dict(os.environ, SVS_NO_UPDATE="1"), **kw)
    if RUN["httpd"]:
        threading.Thread(target=RUN["httpd"].shutdown, daemon=True).start()
    time.sleep(0.4)
    os._exit(0)


def update_worker(job):
    try:
        job.log(f"{APP_NAME} · updating from github.com/{UPDATE_REPO}", "info")
        changed = apply_update(lambda m: job.log(m, "info"))
        job.ok = True
        job.restart = changed
        if changed:
            job.log("Restarting SV Studio…", "info")
    except Exception as e:
        job.log(f"Update failed: {e}", "err")
        job.ok = False
    finally:
        job.log("✔ Update finished" if job.ok else "✖ Update failed", "done-ok" if job.ok else "done-err")
        job.done = True
        if job.ok and getattr(job, "restart", False):
            threading.Timer(1.0, restart_app).start()


def startup_update():
    """With auto_update = "auto", install a pending update before the app starts (then re-launch)."""
    for old in APP_DIR.glob("*.old"):   # leftovers from replacing a running .exe
        try:
            old.unlink()
        except OSError:
            pass
    if CONFIG.get("auto_update", "auto") != "auto" or os.environ.get("SVS_NO_UPDATE"):
        return False
    try:
        info = check_update(force=True)
        if info.get("available") and not info.get("error"):
            print(f"Updating SV Studio to {info['latest'][:7]}…")
            return apply_update()
    except Exception as e:
        print("Auto-update skipped:", e)
    return False


# --------------------------------------------------------------------------- window
def _free_port(preferred, wait=False):
    if wait:   # restarting after an update: wait for the old process to release the port
        for _ in range(60):
            try:
                s = socket.socket()
                if not IS_WIN:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", preferred))
                s.close()
                return preferred
            except OSError:
                time.sleep(0.25)
    for port in list(range(preferred, preferred + 10)) + [0]:
        try:
            s = socket.socket()
            if not IS_WIN:  # ignore sockets in TIME_WAIT from a previous run (Windows doesn't block on those)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
            p = s.getsockname()[1]
            s.close()
            return p
        except OSError:
            continue
    return 0


def open_window(url):
    """Prefer pywebview (native window), then Edge/Chrome app mode, then the default browser."""
    try:
        import webview  # optional: pip install pywebview
        return ("webview", webview)
    except Exception:
        pass
    cands = []
    if IS_WIN:
        pf = [os.environ.get(k, "") for k in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
        for base in pf:
            cands += [base + r"\Microsoft\Edge\Application\msedge.exe",
                      base + r"\Google\Chrome\Application\chrome.exe"]
    elif platform.system() == "Darwin":
        cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    else:
        cands += [shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
    for c in cands:
        if c and Path(c).exists():
            try:
                subprocess.Popen([c, f"--app={url}", "--window-size=1500,920"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return ("app", None)
            except Exception:
                pass
    webbrowser.open(url)
    return ("browser", None)


def main():
    ap = argparse.ArgumentParser(description=f"{APP_NAME} {VERSION}")
    ap.add_argument("project", nargs="?", help=".mpf file or project folder to open")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-window", action="store_true", help="don't open a window, just print the URL")
    ap.add_argument("--keep-alive", action="store_true", help="keep running after the window is closed")
    ap.add_argument("--wait-port", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--reuse-window", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if sys.stdout is None:  # started with pythonw (no console): log to a file instead
        log = open(Path.home() / ".svstudio.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log

    if startup_update():   # updated on disk: run the new version instead
        env = dict(os.environ, SVS_NO_UPDATE="1")
        kw = {"creationflags": 0x00000008 | 0x00000200} if IS_WIN else {}
        subprocess.Popen(self_argv() + sys.argv[1:], cwd=str(APP_DIR), env=env, **kw)
        return

    if args.project:
        try:
            STATE["project"] = load_project(args.project)
        except Exception as e:
            print("Could not open project:", e)

    if IS_WIN:
        threading.Thread(target=lambda: [wsl_tool(n) for n in ("verilator", "iverilog", "make")], daemon=True).start()
    threading.Thread(target=lint_init, daemon=True).start()

    port = _free_port(args.port, wait=args.wait_port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"{APP_NAME} {VERSION} running at {url}  (Ctrl+C to quit)")
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    mode, webview = ("none", None) if (args.no_window or args.reuse_window) else open_window(url)
    RUN.update(args=args, mode=mode, port=httpd.server_address[1], httpd=httpd)
    try:
        if mode == "webview":
            webview.create_window(APP_NAME, url, width=1500, height=920, min_size=(1000, 640))
            webview.start()
        else:
            # exit when the window is closed: straight away if the page said goodbye (and didn't come back,
            # as it does on a reload), otherwise once it has stopped pinging for a minute
            while True:
                time.sleep(1)
                if args.keep_alive or args.no_window:
                    continue
                now = time.time()
                closed = (STATE["bye"] and now - STATE["bye"] > 4 and STATE["last_ping"] < STATE["bye"]) or \
                    (STATE["had_stream"] and STATE["streams"] == 0 and now - STATE["stream_end"] > 4)
                idle = STATE["last_ping"] and now - STATE["last_ping"] > 180
                busy = any(not j.done for j in JOBS.values())
                if closed or (idle and not busy):
                    print("Window closed - exiting.")
                    break
    except KeyboardInterrupt:
        pass
    finally:
        for j in JOBS.values():
            if not j.done:
                kill_job(j)
        if BOARD["session"]:
            BOARD["session"].stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
