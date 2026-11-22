`timescale 1ns/1ps
module tb_counter;
  logic clk = 0, rst = 1, en = 0;
  logic [7:0] count;
  logic wrap;

  counter dut (.clk(clk), .rst(rst), .en(en), .count(count), .wrap(wrap));

  always #5 clk = ~clk;

  initial begin
    #20 rst = 0;
    #10 en = 1;
    repeat (300) @(posedge clk);
    en = 0;
    #50;
    $display("count = %0d", count);
    $finish;
  end
endmodule
