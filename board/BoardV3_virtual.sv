// SV Studio - virtual COMP12111 lab board (Spartan-7 board, BoardV3 interface).
//
// Drop-in replacement for the lab's BoardLib/BoardV3.v, used only by SV Studio's live
// "Board" view. It keeps exactly the same ports, but instead of scanning the real keypad
// and multiplexing the real displays it talks to the SV Studio UI through DPI:
//   - button[23:0], Simple_buttons, Clk_1Hz, Clk_1kHz come from the UI (slow clocks follow
//     wall-clock time, so Clk_1Hz really ticks once a second)
//   - Digit0..5, Crossing_A/B, S7_leds, Buzzer go to the UI
//   - the Ackie/Bennett side (proc_clk, proc_reset, mem_*) is driven by the UI's MU0 controls
// Clk (100 MHz on the real board) runs as fast as the simulator can manage.

`timescale 1ns/1ps

module BoardV3 (
    input  wire Reset,
    input  wire Clk,
    output reg  Clk_1Hz,
    output reg  Clk_1kHz,
    output wire Clk_25MHz,
    output wire Clk_100MHz,

    input  wire [ 5:0] keycol_pin,
    output wire [ 3:0] keyrow_pin,
    output reg  [23:0] button,

    input  wire [3:0] Simple_buttons_pin,
    output reg  [3:0] Simple_buttons,

    input  wire [1:0] S7_leds,
    output wire [1:0] S7_leds_pin,

    input  wire [14:0] Digit0,
    input  wire [14:0] Digit1,
    input  wire [14:0] Digit2,
    input  wire [14:0] Digit3,
    input  wire [14:0] Digit4,
    input  wire [14:0] Digit5,
    output wire [14:0] Segments_pin,
    output wire [ 5:0] Columns_pin,

    input  wire [ 4:0] Crossing_A,
    input  wire [ 5:0] Crossing_B,
    output wire [10:0] Traffic_lights_pin,

    input  wire Buzzer,
    output wire Buzzer_pin,

    input  wire        dac_we,
    input  wire [11:0] dac_data,
    output wire [11:0] dac_data_pin,
    output wire        dac_cs_pin,
    output wire        dac_load_pin,
    output wire        dac_pd_pin,
    output wire        dac_we_pin,

    inout  wire [3:0] ftdi,

    output reg         proc_reset,
    output reg         proc_clk,
    input  wire        proc_fetch,
    input  wire        proc_halted,
    input  wire [15:0] proc_din,
    input  wire [ 3:0] proc_cc,

    output reg         mem_wen,
    output reg  [11:0] mem_addr,
    output reg  [15:0] mem_dout,
    input  wire [15:0] mem_din,

    output wire        bp_mem_data_write,
    output wire        bp_mem_write_en,
    output wire [15:0] breakpoint_adr,
    input  wire        bp_detected,
    input  wire        bp_mem_data_read
);

`ifdef VERILATOR
  import "DPI-C" function void svs_board_tick(
      input int d0, input int d1, input int d2, input int d3, input int d4, input int d5,
      input int lights, input int leds, input int dac,
      input int buzz_period, input int buzz_age,
      input int p_fetch, input int p_halted, input int p_din, input int p_cc, input int m_din,
      output int o_buttons, output int o_simple, output int o_slow,
      output int o_pclk, output int o_prst, output int o_maddr, output int o_mwen, output int o_mdout);
`endif

  initial begin
    Clk_1Hz = 1'b0; Clk_1kHz = 1'b0; button = 24'd0; Simple_buttons = 4'd0;
    proc_reset = 1'b1; proc_clk = 1'b0; mem_wen = 1'b0; mem_addr = 12'd0; mem_dout = 16'd0;
  end

  // 25 MHz = 100 MHz / 4, as on the real board
  reg [1:0] div = 2'd0;
  always @(posedge Clk) div <= div + 2'd1;
  assign Clk_25MHz  = div[1];
  assign Clk_100MHz = Clk;

  // Buzzer: measure the period (in Clk cycles) so the UI can play the right note
  reg        bz_q = 1'b0;
  reg [31:0] bz_cnt = 32'd0;
  reg [31:0] bz_period = 32'd0;
  always @(posedge Clk) begin
    bz_q <= Buzzer;
    if (Buzzer && !bz_q) begin
      bz_period <= bz_cnt + 32'd1;
      bz_cnt <= 32'd0;
    end else if (bz_cnt != 32'hFFFF_FFFF) bz_cnt <= bz_cnt + 32'd1;
  end

  // Exchange state with the UI once per 25 MHz cycle, between 25 MHz edges
  int t_buttons, t_simple, t_slow, t_pclk, t_prst, t_maddr, t_mwen, t_mdout;
  always @(posedge Clk) begin
    if (div == 2'd0) begin
`ifdef VERILATOR
      svs_board_tick({17'd0, Digit0}, {17'd0, Digit1}, {17'd0, Digit2},
                     {17'd0, Digit3}, {17'd0, Digit4}, {17'd0, Digit5},
                     {21'd0, Crossing_A, Crossing_B}, {30'd0, S7_leds}, {20'd0, dac_data},
                     bz_period, bz_cnt,
                     {31'd0, proc_fetch}, {31'd0, proc_halted}, {16'd0, proc_din}, {28'd0, proc_cc},
                     {16'd0, mem_din},
                     t_buttons, t_simple, t_slow, t_pclk, t_prst, t_maddr, t_mwen, t_mdout);
`else   // Icarus Verilog: the same exchange through SV Studio's VPI module (svs_board.vpi)
      $svs_board_tick({17'd0, Digit0}, {17'd0, Digit1}, {17'd0, Digit2},
                      {17'd0, Digit3}, {17'd0, Digit4}, {17'd0, Digit5},
                      {21'd0, Crossing_A, Crossing_B}, {30'd0, S7_leds}, {20'd0, dac_data},
                      bz_period, bz_cnt,
                      {31'd0, proc_fetch}, {31'd0, proc_halted}, {16'd0, proc_din}, {28'd0, proc_cc},
                      {16'd0, mem_din},
                      t_buttons, t_simple, t_slow, t_pclk, t_prst, t_maddr, t_mwen, t_mdout);
`endif
      button         <= t_buttons[23:0];
      Simple_buttons <= t_simple[3:0];
      Clk_1Hz        <= t_slow[0];
      Clk_1kHz       <= t_slow[1];
      proc_clk       <= t_pclk[0];
      proc_reset     <= t_prst[0];
      mem_addr       <= t_maddr[11:0];
      mem_wen        <= t_mwen[0];
      mem_dout       <= t_mdout[15:0];
    end
  end

  // Pins are not used in the virtual board
  assign keyrow_pin         = 4'b1111;
  assign S7_leds_pin        = S7_leds;
  assign Segments_pin       = 15'd0;
  assign Columns_pin        = 6'd0;
  assign Traffic_lights_pin = {Crossing_A[4:3], Crossing_B[5:0], Crossing_A[2:0]};
  assign Buzzer_pin         = Buzzer;
  assign dac_data_pin       = dac_data;
  assign dac_pd_pin         = 1'b1;
  assign dac_we_pin         = dac_we;
  assign dac_cs_pin         = 1'b0;
  assign dac_load_pin       = 1'b0;
  assign bp_mem_data_write  = 1'b0;
  assign bp_mem_write_en    = 1'b0;
  assign breakpoint_adr     = 16'd0;

endmodule
