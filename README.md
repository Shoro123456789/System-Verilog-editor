# SV Studio

A modern desktop front end for SystemVerilog projects. Open a Questa/ModelSim project (`.mpf`) or a folder of `.sv` files, compile, simulate, view waveforms, and jump to errors or edit files in VS Code.

- **Simulators:** Questa / ModelSim (including the free Questa Starter Edition), Verilator 5+, Icarus Verilog
- **Waveform viewer built in:** no GTKWave needed
- **Editor built in** with IDE features, plus one-click **Open in VS Code** (at the right line)
- Only needs Python 3.8+ and no extra packages

## Install

1. Install **Python 3** from python.org. On Windows, tick *"Add python.exe to PATH"*.
2. Install at least one simulator:
   - **Questa Starter Edition** (free, same tool as the university labs). Download it with Quartus Prime Lite from the Altera FPGA download centre, and generate the free `SW-QUESTA` licence in the Self-Service Licensing Center.
   - **Icarus Verilog**: Windows installer at bleyer.org/icarus, or `sudo apt install iverilog`.
   - **Verilator** (Linux only, so on Windows it runs inside WSL): in an admin PowerShell run `wsl --install` and reboot. Then open *Ubuntu* and run `sudo apt update && sudo apt install verilator build-essential`. SV Studio on Windows detects it inside WSL automatically. Icarus installed in WSL (`sudo apt install iverilog`) is picked up the same way.
3. Install **VS Code** and make sure the `code` command works (the installer adds it to PATH).
4. Unzip SV Studio anywhere, e.g. `Documents\SV Studio`.

## Run

- **Windows:** double-click **`SV Studio.bat`**. A window opens (Edge/Chrome app mode).
  If nothing happens, use `SV Studio (debug console).bat` to see the error.
- **Linux / macOS / WSL:** `./svstudio.sh` (optionally followed by a project path).
- Command line: `python svstudio.py path\to\project.mpf`

The app quits on its own a few minutes after you close its window. Optionally, `pip install pywebview` gives a true native window instead of the browser app window.

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

## Virtual lab board (COMP12111)

The **Board** tab runs a design live on a virtual version of the Spartan-7 lab board. It works with
any module that instantiates the lab's `BoardV3` wrapper (`Display_Decoder_Board`, `Traffic_Light_Board`,
`MU0_Board` …). Pick it under **Board design** and press **Start board**. It needs Verilator (on
Windows, Verilator inside WSL). The first build takes about a minute.

- **Inputs:** the 4×4 keypad (`button[15:0]`, laid out 1 2 3 F / 4 5 6 E / 7 8 9 D / A 0 B C, or type
  0–9/A–F), switches A–H (`button[23:16]`, A = bit 23) and the four `Simple_buttons`. Shift-click
  latches a button.
- **Outputs:** six 14-segment displays (`Digit5` … `Digit0`), the traffic lights (`Crossing_A`,
  `Crossing_B`), the two S7 LEDs and the buzzer (tick *Buzzer sound* to hear it).
- **MU0:** for designs containing MU0, a Bennett-style panel shows ACC, PC and the N/Z flags. It has
  Reset / Step / Run / Stop with a selectable clock speed, a live memory view with disassembly (click a
  word to change it), the memory-mapped I/O registers, and loading of any `.mem` file in the project.
- **Timing:** `Clk_1Hz` and `Clk_1kHz` follow real time. `Clk` (100 MHz on the real board) runs as fast
  as your PC can simulate it, usually 10–20 MHz, and the bar shows the speed.

SV Studio does this by compiling your design with `board/BoardV3_virtual.sv` instead of
`BoardLib/BoardV3.v`. The model has the same ports, but talks to the UI instead of scanning the real
keypad and displays. Your files aren't changed. The simulation is functional (no FPGA timing), and the
UART/Ackie link and the warm-boot reset aren't modelled. The traffic-light colours for
`Crossing_A`, and which end Digit0 sits at, are assumptions; each lamp is labelled with its bit.

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
