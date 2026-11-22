// 8-bit up counter with enable and synchronous reset
module counter (
  input  logic       clk, rst, en,
  output logic [7:0] count,
  output logic       wrap
);
  always_ff @(posedge clk) begin
    if (rst)     count <= 8'd0;
    else if (en) count <= count + 8'd1;
  end
  assign wrap = en && (count == 8'hFF);
endmodule
