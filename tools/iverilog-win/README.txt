Icarus Verilog 13.0 for Windows (x64), bundled with SV Studio so Windows users can simulate
without installing anything (no WSL needed).

Built from the unmodified upstream source, tag v13_0 (commit dfeee90):
    https://github.com/steveicarus/iverilog/tree/v13_0
cross-compiled with MinGW-w64 (x86_64-w64-mingw32, static runtime):
    sh autoconf.sh
    ./configure --host=x86_64-w64-mingw32 --prefix=/ LDFLAGS="-static -static-libgcc -static-libstdc++"
    make && make install DESTDIR=...
Only the Verilog/SystemVerilog simulation parts are included (iverilog, vvp, ivl, ivlpp, the vvp
target and the standard VPI modules). Binaries are stripped.

Icarus Verilog is Copyright (c) Stephen Williams and contributors, licensed under the GNU General
Public License version 2 or later (see COPYING). The source code is available at the link above.
