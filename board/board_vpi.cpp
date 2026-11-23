// SV Studio - virtual lab board for Icarus Verilog: a VPI module (svs_board.vpi) providing
//   $svs_board_tick(d0..d5, lights, leds, dac, buzz_period, buzz_age, p_fetch, p_halted, p_din, p_cc,
//                   m_din,  o_buttons, o_simple, o_slow, o_pclk, o_prst, o_maddr, o_mwen, o_mdout)
// which BoardV3_virtual.sv calls once per 25 MHz cycle (16 inputs, 8 int outputs). Same behaviour as
// the Verilator harness; the logic lives in board_core.h.
#include "vpi_user.h"
#include "board_core.h"

static const int NIN = 16, NOUT = 8;
static vpiHandle g_args[NIN + NOUT];
static bool g_have_args = false;
static long long g_ticks = 0;
static Pacer* g_pace = nullptr;

static PLI_INT32 tick_compiletf(PLI_BYTE8*) {
  vpiHandle call = vpi_handle(vpiSysTfCall, nullptr);
  vpiHandle it = vpi_iterate(vpiArgument, call);
  int n = 0;
  while (it && vpi_scan(it)) n++;
  if (n != NIN + NOUT) {
    vpi_printf((PLI_BYTE8*)"$svs_board_tick: expected %d arguments, got %d\n", NIN + NOUT, n);
    vpi_control(vpiFinish, 1);
  }
  return 0;
}

static int get_int(vpiHandle h) {
  s_vpi_value v;
  v.format = vpiIntVal;
  vpi_get_value(h, &v);
  return v.value.integer;
}

static void put_int(vpiHandle h, int x) {
  s_vpi_value v;
  v.format = vpiIntVal;
  v.value.integer = x;
  vpi_put_value(h, &v, nullptr, vpiNoDelay);
}

static void between_ticks() {
  process_commands();
  g_pace->update(g_ticks * 4);   // Clk cycles = 4 x 25 MHz ticks
  while (g_paused && !g_quit) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    process_commands();
    g_pace->update(g_ticks * 4);
  }
  if (g_quit) {
    printf("[SV Studio] virtual board stopped\n");
    fflush(stdout);
    vpi_control(vpiFinish, 0);
  }
}

static PLI_INT32 tick_calltf(PLI_BYTE8*) {
  if (!g_have_args) {
    vpiHandle it = vpi_iterate(vpiArgument, vpi_handle(vpiSysTfCall, nullptr));
    for (int i = 0; i < NIN + NOUT; i++) g_args[i] = vpi_scan(it);
    if (g_args[NIN + NOUT - 1]) vpi_free_object(it);
    g_have_args = true;
    g_pace = new Pacer();
    start_stdin_reader();
    printf("[SV Studio] virtual board running (Icarus Verilog)\n");
    fflush(stdout);
  }
  int in[NIN];
  for (int i = 0; i < NIN; i++) in[i] = get_int(g_args[i]);
  int out[NOUT];
  svs_core_tick(in[0], in[1], in[2], in[3], in[4], in[5], in[6], in[7], in[8], in[9], in[10], in[11], in[12],
                in[13], in[14], in[15], &out[0], &out[1], &out[2], &out[3], &out[4], &out[5], &out[6], &out[7]);
  for (int i = 0; i < NOUT; i++) put_int(g_args[NIN + i], out[i]);
  if ((++g_ticks & 63) == 0) between_ticks();
  return 0;
}

static void register_tasks() {
  s_vpi_systf_data tf;
  memset(&tf, 0, sizeof tf);
  tf.type = vpiSysTask;
  tf.tfname = (PLI_BYTE8*)"$svs_board_tick";
  tf.calltf = tick_calltf;
  tf.compiletf = tick_compiletf;
  vpi_register_systf(&tf);
}

extern "C" {
#if defined(_WIN32)
__declspec(dllexport)
#endif
void (*vlog_startup_routines[])(void) = {register_tasks, nullptr};
}
