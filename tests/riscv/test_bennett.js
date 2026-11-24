// Checks SV Studio's Bennett-dialect assembler against output recorded from Bennett's own
// assembler (riscasm 0.10, Bennett 1.2.16).  Run: node tests/riscv/test_bennett.js
const RV = require("../../static/riscv.js");
const cases = require("./bennett_golden.json");
let pass = 0, fail = 0;
for (const c of cases) {
  const r = RV.assemble(c.src + "\n", { dialect: "bennett" });
  let bad = null;
  if (!c.ok) { if (r.ok) bad = "Bennett rejects this, SV Studio accepts it"; }
  else if (!r.ok) bad = "SV Studio rejects: " + r.errors[0].message;
  else for (const [a, b] of Object.entries(c.bytes)) if (r.segments[0].bytes[+a] !== b) { bad = `byte at 0x${(+a).toString(16)} differs`; break; }
  if (bad) { fail++; console.log("FAIL:", bad, "\n" + c.src + "\n"); } else pass++;
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
