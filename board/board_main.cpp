// SV Studio - live harness for the virtual COMP12111 lab board.
// Runs the Verilated design continuously, reads commands from stdin and prints the board state
// to stdout as "@S {json}" lines (~30 per second). Other output ($display etc.) passes through.
//
// Commands (one per line):
//   b <hex>        keypad + switches (button[23:0])        s <hex>   Simple_buttons[3:0]
//   pause | resume  pause / resume the whole simulation
//   reset | step | stop | run <hz>     MU0 control (hz = proc clock rate, 0 = as fast as possible)
//   base <hex>     memory window start                     w <addr> <data>   write memory (hex)
//   quit

#include "Vsvs_board_top.h"
#include "Vsvs_board_top__Dpi.h"
#include "verilated.h"

#include "board_core.h"


void svs_board_tick(int d0, int d1, int d2, int d3, int d4, int d5, int lights, int leds, int dac,
                    int buzz_period, int buzz_age, int pf, int ph, int pdin, int pcc, int mdin,
                    int* o_buttons, int* o_simplep, int* o_slowp, int* o_pclk, int* o_prst,
                    int* o_maddr, int* o_mwen, int* o_mdout) {
  svs_core_tick(d0, d1, d2, d3, d4, d5, lights, leds, dac, buzz_period, buzz_age, pf, ph, pdin, pcc, mdin,
                o_buttons, o_simplep, o_slowp, o_pclk, o_prst, o_maddr, o_mwen, o_mdout);
}

int main(int argc, char** argv) {
  const std::unique_ptr<VerilatedContext> ctx{new VerilatedContext};
  ctx->commandArgs(argc, argv);
  const std::unique_ptr<Vsvs_board_top> top{new Vsvs_board_top{ctx.get()}};
  start_stdin_reader();
  Pacer pace;
  long long cyc = 0;
  int batch = 256;
  top->Clk = 0;
  top->eval();
  printf("[SV Studio] virtual board running (Verilator)\n");
  fflush(stdout);
  while (!ctx->gotFinish() && !g_quit) {
    process_commands();
    if (g_quit) break;
    pace.update(cyc);
    if (g_paused) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      continue;
    }
    const auto start = Clock::now();
    for (int i = 0; i < batch; i++) {
      top->Clk = 1; top->eval();
      top->Clk = 0; top->eval();
    }
    cyc += batch;
    // keep each batch well under 0.5 ms so Clk_1kHz stays accurate
    const double took = std::chrono::duration<double>(Clock::now() - start).count();
    if (took < 0.0001 && batch < 65536) batch *= 2;
    else if (took > 0.0003 && batch > 16) batch /= 2;
  }
  top->final();
  printf("[SV Studio] virtual board stopped\n");
  fflush(stdout);
  return 0;
}
