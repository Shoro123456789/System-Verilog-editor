# SV Studio

A modern desktop IDE for SystemVerilog, built for the University of Manchester COMP12111 labs
but usable for any SystemVerilog project. Open a Questa/ModelSim project (`.mpf`) or a folder of
`.sv` files, then edit, compile, simulate and view waveforms in one window.

- **Simulators:** Icarus Verilog (built in, no install needed), Verilator 5+, Questa / ModelSim
- **Built-in editor** with errors underlined as you type, autocomplete, go-to-definition and tabs
- **Waveform viewer** built in, so no GTKWave is needed
- **Virtual lab board:** run `*_Board` designs live with the keypad, switches, displays and traffic lights,
  and step through MU0 programs
- **FPGA timing** results from Vivado, or from your lab build logs
- **RISC-V simulator** (COMP15111, Bennett-style): assemble and debug RV32IM programs with step-back,
  register history, ABI names and calling-convention checks. Runs on Windows and Linux with nothing to install
- **Updates itself** from this GitHub repo

---

## Quick start

| | Windows 10/11 | Linux (Ubuntu 22.04+, x86-64) |
|---|---|---|
| 1. Download | [**Download ZIP**](https://github.com/Shoro123456789/System-Verilog-editor/archive/refs/heads/main.zip) and unzip it, e.g. to `Documents\SV Studio` | `git clone https://github.com/Shoro123456789/System-Verilog-editor.git` |
| 2. Start | Double-click **`SVStudio.exe`** | `cd System-Verilog-editor && ./svstudio.sh` |
| 3. Open a project | **Open** → pick your project folder or `.mpf` | same |
| 4. Simulate | Choose the testbench under **Top** and press **Simulate** (Icarus works straight away) | same |

On both systems that's enough for editing, live error checking and simulating with Icarus. Everything
below is optional extra setup.

---

## Windows: full setup

### 1. Install SV Studio
1. Download the [ZIP](https://github.com/Shoro123456789/System-Verilog-editor/archive/refs/heads/main.zip) (or clone the repo) and
   unzip it somewhere you'll keep it. Unzip it first rather than running it from inside the zip.
2. Double-click **`SVStudio.exe`**. Python is built in, so nothing else is needed.
   - The first time, Windows SmartScreen may say *"Windows protected your PC"*, because the exe isn't
     code-signed. Click **More info → Run anyway**.
   - Keep `SVStudio.exe` next to its `runtime` folder and the rest of the files.
   - To get a shortcut, right-click `SVStudio.exe` → *Pin to Start* / *Pin to taskbar*.
3. *(Alternative)* If you have Python 3.11+ from [python.org](https://www.python.org/downloads/) with *"Add python.exe to PATH"*
   ticked, you can start it with **`SV Studio.bat`** instead. If that window closes straight away, use
   `SV Studio (debug console).bat` to see why.

### 2. Simulators (optional: Icarus is already built in)
- **Verilator** is much faster (the **Board** tab runs about 50x faster with it). It runs inside WSL:
  1. Open PowerShell **as Administrator**, run `wsl --install`, and restart the PC.
  2. Open **Ubuntu** from the Start menu, create a user, then run:
     ```bash
     sudo apt update && sudo apt install -y verilator build-essential
     ```
  3. Restart SV Studio. It finds Verilator inside WSL automatically, and the status bar shows *Verilator (WSL)*.
- **Questa Starter Edition** is free and the same simulator the labs use. Install *Questa – Intel FPGA Starter
  Edition* with Quartus Prime Lite from the Altera download centre, then get the free `SW-QUESTA`
  licence from the Altera Self-Service Licensing Center. In SV Studio, **⚙ Settings** → set *Questa bin folder* (e.g.
  `C:\altera_lite\25.1std\questa_fse\win64`) and *Questa license file*.

### 3. Other optional tools
- **VS Code**: install it normally. The **Open in VS Code** button then opens files at the right line.
- **Vivado** gives real FPGA timing results in the **Timing** tab. The free *Vivado ML Standard* edition supports Spartan-7. SV
  Studio finds it in `C:\Xilinx\…` or `C:\AMDDesignTools\…`, or you can set its path in Settings.

---

## Linux: full setup (Ubuntu / Debian)

### 1. Install SV Studio
```bash
sudo apt install -y git python3 python3-tk          # python3-tk gives the Browse… file dialogs
git clone https://github.com/Shoro123456789/System-Verilog-editor.git ~/SVStudio
cd ~/SVStudio
./svstudio.sh                                        # optionally followed by a project path
```
It opens in Chrome/Chromium "app mode" if either is installed, otherwise in your default browser.
Python 3.11+ is recommended (Ubuntu 24.04 has 3.12). With older Python it still works, but live
error checking installs itself with pip the first time.

**No sudo?** (e.g. a shared university machine) SV Studio still runs with the system `python3`. The
built-in Icarus works, and you can download the repo as a ZIP instead of using git.

### 2. Simulators (optional: Icarus is already built in)
```bash
sudo apt install -y verilator build-essential       # Verilator: faster simulations and a ~50x faster Board tab
sudo apt install -y iverilog                         # optional: a system Icarus is used instead of the built-in one
```
- Ubuntu **24.04** ships Verilator 5, which works. Ubuntu **22.04** ships Verilator 4, which is **too old** for SV Studio.
  On 22.04, install Verilator 5 from the [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build/releases)
  (unpack it and add its `bin` folder to `PATH`), or just use Icarus.
- **Questa** and **Vivado** for Linux are detected the same way as on Windows, and you can set their paths in ⚙ Settings.

### 3. Other distributions
Fedora, Arch and others work too. Install `python3`, `tkinter`, and optionally `verilator`, `make` and
`gcc-c++` with your package manager. The built-in Icarus and live check need **x86-64** and glibc 2.35 or newer.
On other CPUs, install `iverilog` from your package manager.

---

## Updating
SV Studio checks this repo every time it starts. When there's an update, it opens an **update window**
straight away. The window shows the version change, what's new, and each step (check → download → install
→ restart) with a progress bar. When it's done, SV Studio reopens where you left off. If an update fails,
the window says why and offers **Try again** or **Continue without updating**. While SV Studio is
running, an **Update & restart** bar appears when there's something new. **⚙ Settings → Updates**
lets you choose *automatic*, *ask first* or *never*. If you cloned with git, it runs `git pull` instead.

## Troubleshooting

| Problem | Fix |
|---|---|
| *"Windows protected your PC"* | **More info → Run anyway**. The exe just isn't code-signed. |
| *Failed to start embedded python interpreter* | Make sure the `runtime` folder is next to `SVStudio.exe` and you unzipped the whole download, or use `SV Studio.bat`. |
| *Verilator not found* on Windows | Install it **inside WSL** (see above), then restart SV Studio. |
| *GNU Make cannot build in directories containing spaces* | Already handled: SV Studio builds inside WSL's home folder. Update SV Studio if you still see this. |
| *Live check off* (status bar) | Hover over the chip to see the reason, and click it to retry. It needs Python 3.11+ when started with Python yourself. |
| Missing Xilinx primitives (`AND4B3`, `FDC`, `ICAPE2`…) | SV Studio supplies built-in models automatically for Verilator and Icarus. |
| Nothing happens on start (Windows) | Run `SV Studio (debug console).bat`, or read `%USERPROFILE%\.svstudio.log`. |

## Using it

1. Click the project pill (top left) and open your `.mpf` file or project folder.
   - Files are compiled in the project's compile order. Paths copied from another machine (e.g. the lab PCs) are matched by filename in the project folder.
2. Pick the **Simulator** and the **Top** module (your testbench, detected automatically).
3. **Run for:** `-all` runs until `$finish`/`$stop`. Or give a time such as `500ns`, `20us` or `1ms`. Use a time limit if your testbench never calls `$finish`.
4. Press **Simulate** (`F5`), or **Compile** (`F7`) to check syntax only.
5. Errors in the console are clickable: **click** opens the line in the built-in editor, **Ctrl+click** opens it in VS Code.
6. The Waveform tab opens automatically when the simulation finishes.

### Editor features

| Feature | How |
|---|---|
| Auto-indent | Automatic on Enter; `end`, `endcase`, `endmodule` etc. snap back when typed |
| Auto-close blocks | Press Enter after `begin`, `case (…)` or `fork` and the matching `end`/`endcase`/`join` is added |
| Autocomplete | Pops up as you type: keywords, signals in the file, `$display`/`$readmemh`…, `` `defines `` |
| Instantiate a module | Type a project module name and pick it: inserts the instance with every port connected by name (`Tab` jumps between fields) |
| Port completion | Type `.` inside an instance to list that module's remaining ports, with direction and width |
| Snippets | `always_ff`, `always_comb`, `case`, `for`, `initial`, `module`, `typedef enum`, `clock`… |
| Errors in the editor | After Compile/Simulate, errors and warnings are underlined with a gutter marker; hover for the message |
| Go to definition | `Ctrl`+click or `F12` on a module name (or a signal, to its declaration) |
| Other | `Ctrl+/` toggle comment, `Ctrl+F` find/replace, `Ctrl+Space` force completion, bracket matching, code folding, multi-cursor (`Alt`+click) |

### Workspace features

| Feature | How |
|---|---|
| Quick Open | `Ctrl+P`: fuzzy-search files and modules (type `alu`, `tbmu`…) |
| Command palette | `Ctrl+Shift+P` or `F1`: every action, searchable (simulate, switch simulator, format, toggle sidebar…) |
| Go to line | `Ctrl+G`, or type `:42` in Quick Open |
| Editor tabs | Several files open at once; `●` = unsaved, middle-click or × to close, `Ctrl+Shift+S` saves all. All files are saved automatically before Compile/Simulate |
| Edits from VS Code | Open files reload automatically when they change on disk. If you also have unsaved edits, a banner asks which version to keep |
| Problems panel | Every error and warning from the last run, grouped by file. Click to jump there |
| Hover info | Hover a module for its ports, or a signal for its declaration and its value at the waveform cursor |
| Add to waveform | `Alt+W` on a signal in the editor (or the button in its hover box) adds it to the waveform view |
| Format document | `Shift+Alt+F` or the ≡ button re-indents the whole file |
| Layout | Drag panel edges to resize (double-click an edge to reset); `Ctrl+B` hides the sidebar |

### Waveform controls

| Action | How |
|---|---|
| Add signal | Click it in the signal tree (`＋all` on a scope adds all of its signals) |
| Zoom | `Ctrl` + scroll, `+` / `-`, or scroll over the time axis |
| Zoom to fit | `F` or the ⤢ button |
| Pan | Drag the waves, or `Shift` + scroll |
| Cursor | Click; it snaps to nearby edges. The value column shows values at the cursor |
| Next/previous edge | `→` / `←` (for the selected signal) |
| Change radix | Click the `H`/`D`/`±D`/`B` badge (hex / unsigned / signed / binary) |
| Reorder / remove | Drag a row / `Delete` or the × button |

Your chosen signals and radixes are remembered and kept when you re-run the simulation.

## Live error checking

Errors are checked as you type, without compiling. SV Studio runs [slang](https://github.com/MikePopoloski/slang)
over the whole project (including your unsaved edits) about half a second after you stop typing.
Problems are underlined in the editor and listed under **Problems**, marked *live*. It catches syntax
errors, undeclared signals, wrong port names on instances, width truncation and missing `case`
defaults. The *Live check* chip in the status bar shows whether it's running.

slang ships with SV Studio as a Python wheel in `vendor/` (Windows and Linux, x86-64, Python 3.11+).
On other systems SV Studio installs it once with `pip install --user pyslang`.

## Built-in Icarus Verilog

SV Studio includes Icarus Verilog 13 for **Windows** (`tools/iverilog-win`) and **Linux x86-64**
(`tools/iverilog-linux`, built on Ubuntu 22.04). So the **Icarus** simulator works with nothing else
installed: no WSL, no apt, no download. An `iverilog` on your PATH is used instead if you have one, and
the built-in copy can be switched off in Settings. Icarus is GPL software. See `README.txt` in those
folders for the source and build details. The builds are reproducible from
`.github/workflows/build-icarus-linux.yml`, and `tools/iverilog-win/README.txt` describes the Windows build.

## Virtual lab board (COMP12111)

The **Board** tab runs a design live on a virtual version of the Spartan-7 lab board. It works with
any module that instantiates the lab's `BoardV3` wrapper (`Display_Decoder_Board`, `Traffic_Light_Board`,
`MU0_Board` …). Pick it under **Board design** and press **Start board**. Nothing needs installing:
**Engine → Auto** uses Verilator 5 if it's installed (about 50x faster, but the first build takes a
minute), and otherwise SV Studio's built-in Icarus Verilog. Icarus starts in about a second and is fine for the
displays, switches and 1 Hz traffic lights, but MU0 tops out at a few thousand instructions per second.

- **Inputs:** the 4×4 keypad (`button[15:0]`, laid out 1 2 3 F / 4 5 6 E / 7 8 9 D / A 0 B C, or type
  0–9/A–F), switches A–H (`button[23:16]`, A = bit 23) and the four `Simple_buttons`. Shift-click
  latches a button.
- **Outputs:** six 14-segment displays (`Digit5` … `Digit0`), the traffic lights (`Crossing_A`,
  `Crossing_B`), the two S7 LEDs and the buzzer (tick *Buzzer sound* to hear it).
- **MU0:** for designs containing MU0, a Bennett-style panel shows ACC, PC and the N/Z flags. It has
  Reset / Step / Run / Stop with a selectable clock speed, a live memory view with disassembly (click a
  word to change it), the memory-mapped I/O registers, and loading of any `.mem` file in the project.
- **Timing:** `Clk_1Hz` and `Clk_1kHz` follow real time. `Clk` (100 MHz on the real board) runs as fast
  as your PC can simulate it, roughly 10–20 MHz with Verilator or ~0.5 MHz with Icarus, and the bar shows the speed.

SV Studio does this by compiling your design with `board/BoardV3_virtual.sv` instead of
`BoardLib/BoardV3.v`. The model has the same ports, but talks to the UI instead of scanning the real
keypad and displays: through DPI and a small C++ harness with Verilator, or through a VPI module
(`tools/board-vpi/`, built by `.github/workflows/build-board-vpi.yml`) with Icarus. Your files aren't changed. The simulation is functional (no FPGA timing), and the
UART/Ackie link and the warm-boot reset aren't modelled. The traffic-light colours for
`Crossing_A`, and which end Digit0 sits at, are assumptions; each lamp is labelled with its bit.

## Themes and animations

Open **Settings** (the gear icon) to choose one of 13 colour themes. The dark themes are Midnight, One Dark,
Dracula, Nord, Tokyo Night, Catppuccin Mocha, Monokai, Solarized Dark, GitHub Dark and High Contrast;
the light themes are GitHub Light, Solarized Light and Catppuccin Latte. A theme applies straight away,
including the code editors and waveforms. You can also switch from the command palette
(`Ctrl+Shift+P`, then type "Theme").

Animations are short (under 0.2 s) and never hold anything up: views fade in, dialogs pop,
the tab underline slides, changed registers flash, and the RISC-V Run button glows while a
program runs. Set them to **Reduced** (feedback only) or **Off** in Settings. Your system's
"reduce motion" setting is respected too.

## Where SV Studio keeps your settings

SV Studio saves its state in its own folder, `~/.svstudio` (on Windows, `C:\Users\<you>\.svstudio`).
The file `ui-state.json` there holds the open RISC-V tabs, including unsaved text and breakpoints,
the editor tabs for each project, the last tab you used, panel sizes, and view options.
On start-up SV Studio reopens your last project and puts everything back where you left it.
Delete the file to reset the layout. Tool paths and recent projects stay in `~/.svstudio.json`.

## RISC-V simulator (COMP15111)

The **RISC-V** tab is a built-in assembler and debugger for RV32IM programs, similar to Bennett but
running natively on Windows and Linux with no install. It works without opening a project.

It has two **modes**:

- **Bennett (COMP15111)**, the default, matches Bennett 1.2.16 and its `riscasm` assembler:
  - **Syntax:** `;` comments; labels with or without `:`; `DEFW`/`DEFH`/`DEFB`/`DEFS`/`ALIGN`/`ORG`/`EQU`;
    memory operands written `4[sp]`; local labels `1` referenced as `%b1`/`%f1`; `$hex`, `@octal` and
    `AND`/`OR`/`MOD` in expressions; full-value `lui` (`lui a0, 0x12345000`); upper-case CSR names.
  - **Machine:** 10,000 bytes of memory, every register (including `sp`) starts at 0, and execution starts at address 0.
  - **ecall services** (number in `a7`): 0 print char `a0`, 1 read char into `a0`, 2 print string at `a0`,
    3 print integer `a0`, 5 halt.
  - **Tested against Bennett:** `tests/riscv/test_bennett.js` checks the encoding against output recorded from
    Bennett's own assembler. GNU-only syntax gets an error explaining the Bennett form.
- **Generic RV32 (GNU)** uses GNU/RARS syntax (`.text`, `.word`, `4(sp)`, `#` comments), RARS ecalls,
  and memory up to 16 MiB with `sp` set for you.

When you open a file, SV Studio switches to the mode that matches its syntax.

- **Assemble** (F7) a `.s` file. Errors and warnings are underlined as you type.
- **Run** (F5), **step** (F11), **step over** a call (F10), **step out** (Shift+F10), and **step back**
  (Shift+F11). Step back undoes one instruction at a time, including memory writes, for the last 200,000 instructions.
- **Breakpoints:** click left of a line number, or press F9.
- **Registers** use ABI names (`a0`, `sp`, `s1`…) or `x0`–`x31`, shown in hex, signed, unsigned, binary or char.
  The register changed by the last instruction is highlighted.
- **Register history:** click a register to see every value it held, a sparkline of how it changed, and
  the instruction that wrote each value. Click a row to jump to that line.
- **Calling-convention check:** on every `ret`, SV Studio checks that the function restored the
  callee-saved registers (`s0`–`s11`, `sp`). If it didn't, you get a warning naming the function and the registers.
- **Panes:** Trace (the last 300 instructions and what each changed), Memory (words or bytes; follow `sp`;
  double-click to edit), Call stack, Code (disassembly), and Symbols.
- **Hover** an instruction for what it does, a register for its role and current value, or a label for its address.
- **Console I/O** through `ecall`, with input typed into the console. Generic mode also supports
  RARS print/read int, string and char, exit (10 and 93), and write/read (64/63).
- **Generic mode assembler** supports labels, numeric local labels (`1:` / `1b` / `1f`), `.text`/`.data`,
  `.word`/`.half`/`.byte`, `.asciz`, `.space`, `.align`, `.equ`, `%hi`/`%lo`, and the usual pseudo-instructions.
- **Tabs:** open several programs at once with **+** or **Open**. Each tab keeps its own breakpoints, mode,
  run state and console. Unsaved tabs are kept when you close SV Studio.
- **Resizable panels:** drag the bar above the console or below the registers. Double-click a bar to reset it.
- **Open** `.s`, `.kmd` (Bennett's listing format, including symbols), `.hex`/`.txt` or `.bin` files.
- **Not supported:** the lab FPGA boards, and the rarely used `RECORD`, `INCLUDE`, `IF` and literal-pool
  directives in Bennett mode. Out-of-range memory accesses stop with an explanation, where Bennett would
  silently return `0xDEADBEFF` or drop the store.

## FPGA timing (Vivado)

The **Timing** tab shows whether a design meets timing on the lab board's Spartan-7
(`xc7s25ftgb196-1`, 100 MHz `Clk`):

- **Run Vivado** synthesises, places and routes the design with the same steps as the lab build
  script, then runs static timing analysis. It shows setup/hold slack (WNS/TNS/WHS/THS), a rough
  maximum clock speed, the clocks, resources used, the worst paths (click a register to jump to it)
  and every synthesis warning, with your own code first and plain-English hints. Warnings in your
  files also appear under **Problems**. It needs Vivado: the free ML Standard edition supports
  Spartan-7. Vivado is found automatically in the usual install folders, or you can set its path in
  Settings. Reports are kept in `.svstudio/timing/<design>/`.
- **Without Vivado**, if you've built the design in the lab, SV Studio reads the timing summary and
  warnings from `synthesis/<design>/vivado.log`. Switch between *This PC* and *Lab build* when you
  have both.
- **Constraints:** on the lab machines the lab's own `.xdc` files are used. Elsewhere SV Studio uses
  a 100 MHz clock on `Clk`, generated clocks for `Clk_25MHz`, `Clk_1kHz`, `Clk_1Hz` and `proc_clk`,
  and false paths on the asynchronous board I/O. Pin locations come from a lab `post_route_io.rpt`,
  or from SV Studio's built-in copy of the board pinout. These approximate the lab's timing
  constraints, which aren't public, so the numbers can differ slightly from a lab build.

## SVStudio.exe and updates (details)

`SVStudio.exe` is a small launcher with Python built in (PyInstaller, one-folder build in `runtime/`).
It runs the `svstudio.py` next to it, which is what lets SV Studio update itself by replacing plain
files. It's built and smoke-tested on Windows by `.github/workflows/build-exe.yml` whenever `launcher/`
changes. Closing the SV Studio window shuts everything down, so no Python process is left running.

Updates replace the app's own files with the latest `main` (your projects are never touched). Local
edits to SV Studio's files are overwritten, so to hack on SV Studio, use a git clone.

## Settings (⚙)

- **Questa bin folder:** set this if Questa isn't auto-detected, e.g. `C:\altera_lite\25.1std\questa_fse\win64` or `C:\intelFPGA_lite\23.1std\questa_fse\win64`.
- **Questa license file:** path to your free licence `.dat`. SV Studio sets `LM_LICENSE_FILE` and `SALT_LICENSE_SERVER` for you.
- Extra flags for `vlog`, `vcom`, `vsim`, Verilator and iverilog, e.g. `-timescale 1ns/1ps`.

## What it writes into your project folder

- `work/`: the Questa library (the same one the Questa GUI project uses).
- `.svstudio/`: build files, `run.do`, and the waveform `wave.vcd`. You can open this in GTKWave too.

If your testbench already calls `$dumpfile("x.vcd")`, SV Studio uses that file instead of adding its own dump.

## Notes and limits

- **Questa** is the reference. Use it to check anything that will be marked.
- **Verilator** is 2-state (no X/Z) and needs your testbench to be the top, with no ports. On Windows it runs through WSL. The first build of a project on a `C:` drive is slow (~20–60 s) because WSL reads Windows files slowly; rebuilds are quicker.
- **Icarus** has partial SystemVerilog support. Some constructs Questa accepts will fail, such as assigning to an enum without a cast.
- Memories/arrays are not included in VCD dumps by default. Add them in your own `$dumpvars` if needed.
- The server listens on `127.0.0.1` only and every API call needs a per-session token.

## Rebuilding the editor bundle (developers only)

`static/editor.bundle.js` is prebuilt, so you don't need Node.js to use SV Studio. To change the editor, edit `editor-src/src/editor.js`, then run:

```bash
cd editor-src
npm install
npm run build
```
