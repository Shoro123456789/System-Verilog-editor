// SV Studio - virtual lab board: logic shared by the Verilator harness (board_main.cpp) and the
// Icarus Verilog VPI module (board_vpi.cpp). Header-only; include it from exactly one .cpp file.
//
// The UI talks to the simulation through stdin/stdout: commands in (one per line), "@S {json}" state
// lines out (~30 per second).
//   b <hex>   keypad + switches (button[23:0])        s <hex>   Simple_buttons[3:0]
//   pause | resume                                    reset | step | stop | run <hz>   (MU0; hz 0 = max)
//   base <hex>  memory window start                   w <addr> <data>  write memory (hex)        quit
#pragma once
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

using Clock = std::chrono::steady_clock;

static std::mutex g_mu;
static std::deque<std::string> g_cmds;

// UI -> design
static unsigned g_buttons = 0, g_simple = 0, g_slow = 0;
// design -> UI
static unsigned o_d[6], o_lights, o_leds, o_dac, o_bzp, o_bza;

// ---- MU0 / Ackie emulation
enum { M_IDLE, M_RUN, M_STEP, M_RESET };
static int mode = M_RESET, reset_left = 2;
static double proc_hz = 10;
static long long budget = 0;          // proc clock half-periods allowed when rate limited
static int pclk = 0, prst = 1, half = 0;
static const int HALF = 4;            // ticks (25 MHz cycles) per proc_clk half period
static bool seen_low = false;
static int step_guard = 0;
static unsigned p_fetch = 0, p_halted = 0, p_cc = 0;
static long long instrs = 0, pcycles = 0;
static bool was_fetch = false;

// memory/register sequencer (uses the Ackie memory port, like Bennett does)
static const int WIN = 64, NIO = 16, NREG = 3;
static const int NITEMS = NREG + WIN + NIO;
static unsigned regs[NREG], win[WIN], io[NIO];
static unsigned win_base = 0, maddr = 0, mwen = 0, mdout = 0;
static int seq_idx = 0, seq_phase = 0, wr_phase = 0;
static std::deque<std::pair<unsigned, unsigned>> writes;

static unsigned item_addr(int i) {
  if (i < NREG) return (unsigned)i;                         // srcC = mem_addr[1:0]: 0 Acc, 1 PC, 2 flags
  if (i < NREG + WIN) return (win_base + (unsigned)(i - NREG)) & 0xFFF;
  return 0xFF0u + (unsigned)(i - NREG - WIN);
}

static void proc_edge_fall() {
  // half a proc clock after a rising edge: state has settled
  bool f = p_fetch != 0;
  if (f && !was_fetch) instrs++;
  if (mode == M_STEP) {
    if (!f) seen_low = true;
    else if (seen_low) mode = M_IDLE;
    if (++step_guard > 64) mode = M_IDLE;
  }
  was_fetch = f;
  if (p_halted && mode != M_RESET) mode = M_IDLE;
}

static void svs_core_tick(int d0, int d1, int d2, int d3, int d4, int d5, int lights, int leds, int dac,
                    int buzz_period, int buzz_age, int pf, int ph, int pdin, int pcc, int mdin,
                    int* o_buttons, int* o_simplep, int* o_slowp, int* o_pclk, int* o_prst,
                    int* o_maddr, int* o_mwen, int* o_mdout) {
  o_d[0] = d0; o_d[1] = d1; o_d[2] = d2; o_d[3] = d3; o_d[4] = d4; o_d[5] = d5;
  o_lights = lights; o_leds = leds; o_dac = dac; o_bzp = buzz_period; o_bza = buzz_age;
  p_fetch = pf; p_halted = ph; p_cc = pcc;

  // ---- proc clock
  if (mode == M_RESET) {
    prst = 1;
    if (++half >= HALF) {
      half = 0;
      pclk ^= 1;
      if (!pclk && --reset_left <= 0) { prst = 0; mode = M_IDLE; instrs = 0; pcycles = 0; was_fetch = false; }
    }
  } else if (mode == M_RUN || mode == M_STEP) {
    if (++half >= HALF) {
      bool limited = mode == M_RUN && proc_hz > 0;
      if (limited && budget <= 0) {
        half = HALF;  // wait for budget
      } else {
        half = 0;
        if (limited) budget--;
        pclk ^= 1;
        if (pclk) pcycles++;
        else proc_edge_fall();
      }
    }
  } else if (pclk && ++half >= HALF) {  // finish a half-high clock after stopping
    half = 0; pclk = 0;
  }

  // ---- memory port: pending writes first, then round-robin reads
  if (wr_phase == 1) { mwen = 0; wr_phase = 0; }
  else if (seq_phase == 0 && !writes.empty()) {
    auto w = writes.front(); writes.pop_front();
    maddr = w.first & 0xFFF; mdout = w.second & 0xFFFF; mwen = 1; wr_phase = 1;
  } else if (seq_phase == 0) {
    maddr = item_addr(seq_idx); seq_phase = 1;
  } else if (seq_phase == 1) {
    seq_phase = 2;
  } else {
    unsigned v = (seq_idx < NREG) ? ((unsigned)pdin & 0xFFFF) : ((unsigned)mdin & 0xFFFF);
    if (seq_idx < NREG) regs[seq_idx] = v;
    else if (seq_idx < NREG + WIN) win[seq_idx - NREG] = v;
    else io[seq_idx - NREG - WIN] = v;
    seq_idx = (seq_idx + 1) % NITEMS;
    seq_phase = 0;
  }

  *o_buttons = (int)g_buttons; *o_simplep = (int)g_simple; *o_slowp = (int)g_slow;
  *o_pclk = pclk; *o_prst = prst; *o_maddr = (int)maddr; *o_mwen = (int)mwen; *o_mdout = (int)mdout;
}

static bool g_paused = false, g_quit = false;

static void handle(const std::string& line) {
  char cmd[32] = {0};
  unsigned a = 0, b = 0;
  double hz = 0;
  if (sscanf(line.c_str(), "%31s", cmd) != 1) return;
  std::string c(cmd);
  if (c == "b" && sscanf(line.c_str(), "b %x", &a) == 1) g_buttons = a & 0xFFFFFF;
  else if (c == "s" && sscanf(line.c_str(), "s %x", &a) == 1) g_simple = a & 0xF;
  else if (c == "pause") g_paused = true;
  else if (c == "resume") g_paused = false;
  else if (c == "reset") { mode = M_RESET; reset_left = 2; half = 0; }
  else if (c == "step") { if (mode != M_RESET) { mode = M_STEP; seen_low = false; step_guard = 0; } }
  else if (c == "stop") { if (mode != M_RESET) mode = M_IDLE; }
  else if (c == "run" && sscanf(line.c_str(), "run %lf", &hz) == 1) {
    proc_hz = hz; budget = 0;
    if (mode != M_RESET) mode = M_RUN;
  }
  else if (c == "base" && sscanf(line.c_str(), "base %x", &a) == 1) win_base = a & 0xFFF;
  else if (c == "w" && sscanf(line.c_str(), "w %x %x", &a, &b) == 2) writes.emplace_back(a, b);
  else if (c == "quit") g_quit = true;
}

static void print_state(double t, double mhz) {
  static char buf[8192];
  int n = snprintf(buf, sizeof buf,
                   "@S {\"t\":%.3f,\"mhz\":%.2f,\"paused\":%d,\"d\":[%u,%u,%u,%u,%u,%u],\"l\":%u,\"s7\":%u,"
                   "\"dac\":%u,\"bzp\":%u,\"bza\":%u,\"btn\":%u,\"sb\":%u,"
                   "\"mu0\":{\"mode\":%d,\"halted\":%u,\"fetch\":%u,\"hz\":%.3f,\"instrs\":%lld,\"cycles\":%lld,"
                   "\"acc\":%u,\"pc\":%u,\"flags\":%u,\"base\":%u,\"mem\":[",
                   t, mhz, g_paused ? 1 : 0, o_d[0], o_d[1], o_d[2], o_d[3], o_d[4], o_d[5], o_lights, o_leds,
                   o_dac, o_bzp, o_bza, g_buttons, g_simple, mode, p_halted, p_fetch, proc_hz, instrs, pcycles,
                   regs[0], regs[1], regs[2], win_base);
  for (int i = 0; i < WIN; i++) n += snprintf(buf + n, sizeof buf - n, i ? ",%u" : "%u", win[i]);
  n += snprintf(buf + n, sizeof buf - n, "],\"io\":[");
  for (int i = 0; i < NIO; i++) n += snprintf(buf + n, sizeof buf - n, i ? ",%u" : "%u", io[i]);
  snprintf(buf + n, sizeof buf - n, "]}}\n");
  fputs(buf, stdout);
  fflush(stdout);
}


// ---- things both back ends do between ticks
static void start_stdin_reader() {
  std::thread([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      std::lock_guard<std::mutex> lk(g_mu);
      g_cmds.push_back(line);
    }
    std::lock_guard<std::mutex> lk(g_mu);
    g_cmds.push_back("quit");
  }).detach();
}

static void process_commands() {
  std::lock_guard<std::mutex> lk(g_mu);
  while (!g_cmds.empty()) { handle(g_cmds.front()); g_cmds.pop_front(); }
}

struct Pacer {   // real-time slow clocks, MU0 clock budget, speed measurement, state output
  Clock::time_point t0 = Clock::now(), last_out = t0, last_rate = t0, last_loop = t0;
  long long cyc_mark = 0;
  double mhz = 0, budget_acc = 0;
  void update(long long cyc) {
    const auto now = Clock::now();
    const double t = std::chrono::duration<double>(now - t0).count();
    const double dt = std::chrono::duration<double>(now - last_loop).count();
    last_loop = now;
    // high for the second half of each period, like BoardLib/Clocks.v
    g_slow = (std::fmod(t, 1.0) >= 0.5 ? 1u : 0u) | (std::fmod(t * 1000.0, 1.0) >= 0.5 ? 2u : 0u);
    if (mode == M_RUN && proc_hz > 0) {
      budget_acc += proc_hz * 2.0 * dt;
      const long long add = (long long)budget_acc;
      budget_acc -= (double)add;
      budget = std::min<long long>(budget + add, (long long)(proc_hz * 0.2) + 4);
    }
    if (now - last_rate >= std::chrono::milliseconds(500)) {
      const double span = std::chrono::duration<double>(now - last_rate).count();
      mhz = (double)(cyc - cyc_mark) / span / 1e6;
      cyc_mark = cyc;
      last_rate = now;
    }
    if (now - last_out >= std::chrono::milliseconds(33)) {
      print_state(t, mhz);
      last_out = now;
    }
  }
};
