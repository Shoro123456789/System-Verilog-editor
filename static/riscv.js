// SV Studio — RISC-V (RV32IM + Zicsr counters) assembler, disassembler and emulator.
// Pure JS, no DOM: used by rvsim.js in the browser and by tests under node.
(function (root) {
"use strict";

/* ------------------------------------------------------------------ registers */
const ABI = ["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"];
const REG_ROLE = ["hard-wired zero", "return address", "stack pointer", "global/heap pointer", "thread pointer",
  "temporary", "temporary", "temporary", "saved / frame pointer", "saved", "argument / return value", "argument / return value",
  "argument", "argument", "argument", "argument", "argument", "argument / syscall number", "saved", "saved", "saved",
  "saved", "saved", "saved", "saved", "saved", "saved", "saved", "temporary", "temporary", "temporary", "temporary"];
// who must preserve it across a call: "callee" = the called function must restore it
const REG_SAVER = ABI.map((n, i) => i === 0 ? "" : i === 2 || n[0] === "s" ? "callee" : i === 3 || i === 4 ? "" : "caller");
const REGMAP = new Map();
ABI.forEach((n, i) => { REGMAP.set(n, i); REGMAP.set("x" + i, i); });
REGMAP.set("fp", 8); REGMAP.set("hp", 3);
const regNum = (s) => REGMAP.has(s.toLowerCase()) ? REGMAP.get(s.toLowerCase()) : -1;

/* ------------------------------------------------------------------ instruction table */
const R = { add: [0, 0], sub: [0, 32], sll: [1, 0], slt: [2, 0], sltu: [3, 0], xor: [4, 0], srl: [5, 0], sra: [5, 32], or: [6, 0], and: [7, 0],
  mul: [0, 1], mulh: [1, 1], mulhsu: [2, 1], mulhu: [3, 1], div: [4, 1], divu: [5, 1], rem: [6, 1], remu: [7, 1] };
const IALU = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
const SHI = { slli: [1, 0], srli: [5, 0], srai: [5, 32] };
const LOAD = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
const STORE = { sb: 0, sh: 1, sw: 2 };
const BR = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
const CSR = { csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7 };
const CSRNAMES = { cycle: 0xC00, time: 0xC01, instret: 0xC02, cycleh: 0xC80, timeh: 0xC81, instreth: 0xC82,
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
  mcycle: 0xB00, minstret: 0xB02, mhartid: 0xF14 };
const CSRBYNUM = Object.fromEntries(Object.entries(CSRNAMES).map(([k, v]) => [v, k]));

// One-line docs shown in hover/completion.
const DOC = {
  add: "rd = rs1 + rs2", sub: "rd = rs1 - rs2", sll: "rd = rs1 << rs2[4:0]", slt: "rd = (rs1 < rs2) signed ? 1 : 0",
  sltu: "rd = (rs1 < rs2) unsigned ? 1 : 0", xor: "rd = rs1 ^ rs2", srl: "rd = rs1 >> rs2 (logical)", sra: "rd = rs1 >> rs2 (arithmetic)",
  or: "rd = rs1 | rs2", and: "rd = rs1 & rs2", mul: "rd = (rs1 * rs2)[31:0]", mulh: "rd = (rs1 * rs2)[63:32] signed×signed",
  mulhsu: "rd = (rs1 * rs2)[63:32] signed×unsigned", mulhu: "rd = (rs1 * rs2)[63:32] unsigned", div: "rd = rs1 / rs2 (signed)",
  divu: "rd = rs1 / rs2 (unsigned)", rem: "rd = rs1 % rs2 (signed)", remu: "rd = rs1 % rs2 (unsigned)",
  addi: "rd = rs1 + imm12", slti: "rd = (rs1 < imm) signed", sltiu: "rd = (rs1 < imm) unsigned", xori: "rd = rs1 ^ imm",
  ori: "rd = rs1 | imm", andi: "rd = rs1 & imm", slli: "rd = rs1 << shamt", srli: "rd = rs1 >> shamt (logical)", srai: "rd = rs1 >> shamt (arithmetic)",
  lb: "rd = sign-extend mem8[rs1+imm]", lh: "rd = sign-extend mem16[rs1+imm]", lw: "rd = mem32[rs1+imm]",
  lbu: "rd = zero-extend mem8[rs1+imm]", lhu: "rd = zero-extend mem16[rs1+imm]",
  sb: "mem8[rs1+imm] = rs2", sh: "mem16[rs1+imm] = rs2", sw: "mem32[rs1+imm] = rs2",
  beq: "if rs1 == rs2 goto label", bne: "if rs1 != rs2 goto label", blt: "if rs1 < rs2 (signed) goto label",
  bge: "if rs1 >= rs2 (signed) goto label", bltu: "if rs1 < rs2 (unsigned) goto label", bgeu: "if rs1 >= rs2 (unsigned) goto label",
  lui: "rd = imm20 << 12", auipc: "rd = pc + (imm20 << 12)", jal: "rd = pc+4; goto label  (jal label ⇒ rd = ra)",
  jalr: "rd = pc+4; goto rs1+imm", ecall: "environment call (a7 = service number)", ebreak: "breakpoint — pauses the simulator",
  fence: "memory ordering (no-op here)", csrrw: "rd = csr; csr = rs1", csrrs: "rd = csr; csr |= rs1", csrrc: "rd = csr; csr &= ~rs1",
  csrrwi: "rd = csr; csr = uimm", csrrsi: "rd = csr; csr |= uimm", csrrci: "rd = csr; csr &= ~uimm",
  // pseudo
  nop: "addi zero, zero, 0", li: "rd = immediate (lui + addi if needed)", la: "rd = address of label (auipc + addi)",
  mv: "rd = rs  (addi rd, rs, 0)", not: "rd = ~rs  (xori rd, rs, -1)", neg: "rd = -rs  (sub rd, zero, rs)",
  seqz: "rd = (rs == 0)", snez: "rd = (rs != 0)", sltz: "rd = (rs < 0)", sgtz: "rd = (rs > 0)",
  beqz: "if rs == 0 goto label", bnez: "if rs != 0 goto label", blez: "if rs <= 0 goto label", bgez: "if rs >= 0 goto label",
  bltz: "if rs < 0 goto label", bgtz: "if rs > 0 goto label", bgt: "if rs1 > rs2 goto label", ble: "if rs1 <= rs2 goto label",
  bgtu: "if rs1 > rs2 (unsigned) goto label", bleu: "if rs1 <= rs2 (unsigned) goto label",
  j: "goto label  (jal zero, label)", jr: "goto rs  (jalr zero, 0(rs))", ret: "return  (jalr zero, 0(ra))",
  call: "call function  (jal ra, label)", tail: "tail call  (jal zero, label)", rdcycle: "rd = cycle counter",
  rdinstret: "rd = instructions retired", rdtime: "rd = time counter", csrr: "rd = csr", csrw: "csr = rs", csrs: "csr |= rs", csrc: "csr &= ~rs",
};
const PSEUDO = ["nop", "li", "la", "mv", "not", "neg", "seqz", "snez", "sltz", "sgtz", "beqz", "bnez", "blez", "bgez", "bltz", "bgtz",
  "bgt", "ble", "bgtu", "bleu", "j", "jr", "ret", "call", "tail", "rdcycle", "rdinstret", "rdtime", "csrr", "csrw", "csrs", "csrc"];
const REAL = [...Object.keys(R), ...Object.keys(IALU), ...Object.keys(SHI), ...Object.keys(LOAD), ...Object.keys(STORE),
  ...Object.keys(BR), "lui", "auipc", "jal", "jalr", "ecall", "ebreak", "fence", ...Object.keys(CSR)];
const MNEMONICS = [...REAL, ...PSEUDO];
const DIRECTIVES = [".text", ".data", ".rodata", ".bss", ".section", ".word", ".half", ".short", ".byte", ".2byte", ".4byte", ".long",
  ".ascii", ".asciz", ".string", ".space", ".zero", ".skip", ".align", ".balign", ".p2align", ".equ", ".set", ".globl", ".global",
  ".org", ".end", ".option", ".type", ".size", ".file", ".ident", ".attribute", ".local", ".weak"];

/* ------------------------------------------------------------------ encoders */
const u32 = (v) => v >>> 0;
const encR = (f7, rs2, rs1, f3, rd, op) => u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
const encI = (imm, rs1, f3, rd, op) => u32(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
const encS = (imm, rs2, rs1, f3, op) => u32((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op);
const encB = (imm, rs2, rs1, f3) => u32((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) |
  (f3 << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | 0x63);
const encU = (imm20, rd, op) => u32(((imm20 & 0xfffff) << 12) | (rd << 7) | op);
const encJ = (imm, rd) => u32((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) |
  (((imm >> 12) & 0xff) << 12) | (rd << 7) | 0x6f);
const hiLo = (v) => { v = v | 0; const lo = (v << 20) >> 20; const hi = ((v - lo) >>> 12) & 0xfffff; return [hi, lo]; };

/* ------------------------------------------------------------------ expressions */
class AsmError extends Error {}

function parseNumber(tok) {
  const t = tok.replace(/_/g, "");
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^0b[01]+$/i.test(t)) return parseInt(t.slice(2), 2);
  if (/^0o[0-7]+$/i.test(t)) return parseInt(t.slice(2), 8);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

function unescapeChar(s, i) { // returns [char code, next index]; s[i] is char after backslash
  const c = s[i];
  const map = { n: 10, t: 9, r: 13, 0: 0, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, e: 27 };
  if (c === "x") { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)); if (m) return [parseInt(m[0], 16), i + 1 + m[0].length]; }
  if (c in map) return [map[c], i + 1];
  return [c.charCodeAt(0), i + 1];
}

// Evaluates an expression; lookup(name) returns a number or undefined.
function evalExpr(src, lookup, pc) {
  if (DIALECT === "bennett") return evalExprB(src, lookup, pc);
  const s = src.trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (m) => { throw new AsmError(m || `bad expression "${src}"`); };
  function primary() {
    ws();
    const c = s[i];
    if (c === "(") { i++; const v = expr(); ws(); if (s[i] !== ")") fail("missing )"); i++; return v; }
    if (c === "-") { i++; return -primary(); }
    if (c === "+") { i++; return primary(); }
    if (c === "~") { i++; return ~primary(); }
    if (c === "'") {
      i++; let code;
      if (s[i] === "\\") [code, i] = unescapeChar(s, i + 1); else code = s.charCodeAt(i++);
      if (s[i] !== "'") fail("bad character literal"); i++; return code;
    }
    if (c === "%") {
      const m = /^%(hi|lo|pcrel_hi|pcrel_lo)\s*\(/.exec(s.slice(i)); if (!m) fail();
      i += m[0].length; const v = expr(); ws(); if (s[i] !== ")") fail("missing )"); i++;
      const [hi, lo] = hiLo(m[1].startsWith("pcrel") ? v - (m[1] === "pcrel_hi" ? pc : 0) : v);
      return m[1].endsWith("hi") ? hi : lo;
    }
    if (c === "." && !/[A-Za-z_.$0-9]/.test(s[i + 1] || "")) { i++; return pc; }
    let m = /^[0-9][0-9a-zA-Z_]*/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      if (/^\d+[bf]$/.test(m[0])) { const v = lookup(m[0]); if (v === undefined) fail(`undefined local label ${m[0]}`); return v; }
      const v = parseNumber(m[0]); if (v === null) fail(`bad number "${m[0]}"`); return v;
    }
    m = /^[A-Za-z_.$][\w.$]*/.exec(s.slice(i));
    if (m) { i += m[0].length; const v = lookup(m[0]); if (v === undefined) throw new AsmError(`undefined symbol "${m[0]}"`); return v; }
    fail();
  }
  const ops = [["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
  function level(n) {
    if (n === ops.length) return primary();
    let v = level(n + 1);
    for (;;) {
      ws();
      const op = ops[n].find(o => s.startsWith(o, i) && !(o === "%" && /^%(hi|lo|pcrel)/.test(s.slice(i))));
      if (!op) return v;
      i += op.length;
      const r = level(n + 1);
      switch (op) {
        case "|": v = v | r; break; case "^": v = v ^ r; break; case "&": v = v & r; break;
        case "<<": v = v << r; break; case ">>": v = v >> r; break;
        case "+": v = v + r; break; case "-": v = v - r; break; case "*": v = Math.imul(v, r); break;
        case "/": if (!r) fail("divide by zero"); v = Math.trunc(v / r); break; case "%": if (!r) fail("divide by zero"); v = v % r; break;
      }
    }
  }
  const expr = () => level(0);
  if (!s) fail("missing operand");
  const v = expr(); ws();
  if (i < s.length) fail();
  return v;
}

/* ------------------------------------------------------------------ source scanning */
// Strip comments (# // ;) outside quotes; split into label(s) + statement.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"') { q = c; continue; }
    if (c === "'" ) { // char literal 'x' or '\n'
      const m = /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/.exec(line.slice(i)); if (m) { i += m[0].length - 1; continue; }
    }
    if (c === "#" || c === ";" || (c === "/" && line[i + 1] === "/")) return line.slice(0, i);
  }
  return line;
}

function splitArgs(s) {
  const out = []; let cur = "", depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") { cur += s[++i] || ""; } else if (c === q) q = null; continue; }
    if (c === '"') { q = c; cur += c; continue; }
    if (c === "'") { const m = /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/.exec(s.slice(i)); if (m) { cur += m[0]; i += m[0].length - 1; continue; } }
    if (c === "(") depth++; else if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

function parseString(arg) {
  const t = arg.trim();
  if (t[0] !== '"' || t[t.length - 1] !== '"' || t.length < 2) throw new AsmError(`expected a "string", got ${arg}`);
  const bytes = [];
  for (let i = 1; i < t.length - 1;) {
    if (t[i] === "\\") { const [c, n] = unescapeChar(t, i + 1); bytes.push(c & 0xff); i = n; }
    else { const cp = t.codePointAt(i); const enc = new TextEncoder().encode(String.fromCodePoint(cp)); bytes.push(...enc); i += cp > 0xffff ? 2 : 1; }
  }
  return bytes;
}

/* ------------------------------------------------------------------ Bennett (UoM riscasm) dialect */
// Bennett's assembler is derived from the UoM ARM assembler (aasm): ';' comments, labels with or
// without ':', DEFW/DEFB/DEFS/ALIGN/ORG/EQU directives, offset[reg] memory operands, %b1 local labels,
// $hex/@octal numbers, word operators (AND, OR, MOD...) and ARM-style operator precedence.
let DIALECT = "gnu";
const B_DIRECTIVES = ["equ", "org", "origin", "align", "defs", "defb", "dcb", "defh", "dcw", "defw", "dcd", "entry", "export"];
const B_UNSUPPORTED = ["include", "get", "import", "literal", "literals", "pool", "ltorg", "rn", "cn", "cp", "record", "structure",
  "struct", "rec_align", "struct_align", "alias", "byte", "halfword", "half", "word", "double", "doubleword", "if", "else", "endif", "fi",
  "arch", "architecture", "arm", "thumb", "set", "define", "def"];
const B_EXTRA = ["subi", "lla", "illegal", "uret", "sret", "mret", "wfi", "csrwi", "csrsi", "csrci", "rdcycleh", "rdtimeh", "rdinstreth"];
const B_CSR = (() => {
  const o = { USTATUS: 0x000, FFLAGS: 0x001, FRM: 0x002, FCSR: 0x003, UIE: 0x004, UTVEC: 0x005, USCRATCH: 0x040, UEPC: 0x041, UCAUSE: 0x042,
    UTVAL: 0x043, UIP: 0x044, SSTATUS: 0x100, SEDELEG: 0x102, SIDELEG: 0x103, SIE: 0x104, STVEC: 0x105, SCOUNTEREN: 0x106, SSCRATCH: 0x140,
    SEPC: 0x141, SCAUSE: 0x142, STVAL: 0x143, SIP: 0x144, SAT: 0x180, MSTATUS: 0x300, MISA: 0x301, MEDELEG: 0x302, MIDELEG: 0x303, MIE: 0x304,
    MTVEC: 0x305, MCOUNTEREN: 0x306, MCOUNTINHIBIT: 0x320, MSCRATCH: 0x340, MEPC: 0x341, MCAUSE: 0x342, MTVAL: 0x343, MIP: 0x344,
    TSELECT: 0x7A0, TDATA1: 0x7A1, TDATA2: 0x7A2, TDATA3: 0x7A3, DCSR: 0x7B0, DPC: 0x7B1, DSCRATCH0: 0x7B2, DSCRATCH1: 0x7B3,
    MCYCLE: 0xB00, MINSTRET: 0xB02, MCYCLEH: 0xB80, MINSTRETH: 0xB82, CYCLE: 0xC00, TIME: 0xC01, INSTRET: 0xC02, CYCLEH: 0xC80,
    TIMEH: 0xC81, INSTRETH: 0xC82, MVENDORID: 0xF11, MARCHID: 0xF12, MIMPID: 0xF13, MHARTID: 0xF14 };
  for (let i = 3; i < 32; i++) { o["MHPMEVENT" + i] = 0x320 + i; o["MHPMCOUNTER" + i] = 0xB00 + i; o["MHPMCOUNTER" + i + "H"] = 0xB80 + i; o["HPMCOUNTER" + i] = 0xC00 + i; o["HPMCOUNTER" + i + "H"] = 0xC80 + i; }
  for (let i = 0; i < 4; i++) o["PMPCFG" + i] = 0x3A0 + i;
  for (let i = 0; i < 16; i++) o["PMPADDR" + i] = 0x3B0 + i;
  return o;
})();

// aasm expression syntax and precedence (high to low): shifts, AND, OR/XOR, * / MOD, + -, comparisons
function evalExprB(src, lookup, pc) {
  const s = src.trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (m) => { throw new AsmError(m || `bad expression "${src}"`); };
  const kw = (w) => { const m = new RegExp("^" + w + "(?![\\w])", "i").exec(s.slice(i)); return m ? m[0].length : 0; };
  function primary() {
    ws();
    const c = s[i];
    if (c === "(") { i++; const v = level(0); ws(); if (s[i] !== ")") fail("')' expected"); i++; return v; }
    if (c === "-") { i++; return -primary(); }
    if (c === "+") { i++; return primary(); }
    if (c === "~") { i++; return ~primary(); }
    if (c === "|") { i++; const v = primary() >>> 0; return v ? 31 - Math.clz32(v) : -1; }
    if (c === "'" || c === "`") {
      i++; let code;
      if (s[i] === "\\") [code, i] = unescapeChar(s, i + 1); else code = s.charCodeAt(i++);
      if (s[i] !== c) fail("bad character constant"); i++; return code;
    }
    if (c === "%") {
      const m = /^%([bf]?)(\d+)/i.exec(s.slice(i)); if (!m) fail("Bad local label");
      i += m[0].length;
      const v = lookup("%" + m[1].toLowerCase() + m[2]); if (v === undefined) throw new AsmError(`Label not found: local label ${m[0]}`); return v;
    }
    if (c === "." && !/[\w]/.test(s[i + 1] || "")) { i++; return pc; }
    let m;
    if ((m = /^\$([0-9a-f_]+)/i.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[1].replace(/_/g, ""), 16); }
    if ((m = /^@([0-7_]+)/.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[1].replace(/_/g, ""), 8); }
    if ((m = /^:([01_]+)/.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[1].replace(/_/g, ""), 2); }
    if ((m = /^0x([0-9a-f_]+)/i.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[1].replace(/_/g, ""), 16); }
    if ((m = /^0b([01_]+)/i.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[1].replace(/_/g, ""), 2); }
    if ((m = /^[0-9][0-9_]*(?![\w])/.exec(s.slice(i)))) { i += m[0].length; return parseInt(m[0].replace(/_/g, ""), 10); }
    if ((m = /^[A-Za-z_][\w]*/.exec(s.slice(i)))) {
      i += m[0].length; const v = lookup(m[0]);
      if (v === undefined && (B_UNSUPPORTED.includes(m[0].toLowerCase()) || B_DIRECTIVES.includes(m[0].toLowerCase())))
        throw new AsmError(`Label not found: "${m[0]}" is a reserved word in Bennett's assembler (a directive) and can't be a label — rename it`);
      if (v === undefined) throw new AsmError(`Label not found: "${m[0]}"` + (lookup(m[0].toLowerCase()) !== undefined || lookup(m[0].toUpperCase()) !== undefined ? " (labels are case-sensitive)" : ""));
      return v;
    }
    fail(c === "#" ? "Bennett doesn't use '#' — write immediates as plain numbers, and comments start with ';'" : "Operand expected");
  }
  const LV = [
    [["<<", (a, b) => a << b], [">>", (a, b) => a >>> b], ["LSL", (a, b) => a << b], ["SHL", (a, b) => a << b], ["LSR", (a, b) => a >>> b], ["SHR", (a, b) => a >>> b]],
    [["AND", (a, b) => a & b]],
    [["OR", (a, b) => a | b], ["EOR", (a, b) => a ^ b], ["XOR", (a, b) => a ^ b], ["|", (a, b) => a | b], ["^", (a, b) => a ^ b]],
    [["*", (a, b) => Math.imul(a, b)], ["/", (a, b) => { if (!b) fail("divide by zero"); return Math.trunc(a / b); }], ["DIV", (a, b) => { if (!b) fail("divide by zero"); return Math.trunc(a / b); }],
      ["\\", (a, b) => { if (!b) fail("divide by zero"); return a % b; }], ["MOD", (a, b) => { if (!b) fail("divide by zero"); return a % b; }]],
    [["+", (a, b) => a + b], ["-", (a, b) => a - b]],
    [["<>", (a, b) => a !== b], ["!=", (a, b) => a !== b], [">=", (a, b) => (a >>> 0) >= (b >>> 0)], ["<=", (a, b) => (a >>> 0) <= (b >>> 0)],
      ["=", (a, b) => a === b], [">", (a, b) => (a >>> 0) > (b >>> 0)], ["<", (a, b) => (a >>> 0) < (b >>> 0)],
      ["EQ", (a, b) => a === b], ["NE", (a, b) => a !== b], ["HI", (a, b) => (a >>> 0) > (b >>> 0)], ["HS", (a, b) => (a >>> 0) >= (b >>> 0)],
      ["LO", (a, b) => (a >>> 0) < (b >>> 0)], ["LS", (a, b) => (a >>> 0) <= (b >>> 0)], ["GT", (a, b) => (a | 0) > (b | 0)], ["GE", (a, b) => (a | 0) >= (b | 0)],
      ["LT", (a, b) => (a | 0) < (b | 0)], ["LE", (a, b) => (a | 0) <= (b | 0)]],
  ];
  // evaluation order: level 0 = lowest precedence (comparisons) ... level 5 = shifts
  const ORDER = [5, 4, 3, 2, 1, 0];
  function level(n) {
    if (n === ORDER.length) return primary();
    let v = level(n + 1);
    for (;;) {
      ws();
      let hit = null;
      for (const [sym, fn] of LV[ORDER[n]]) {
        const len = /^[A-Z]/.test(sym) ? kw(sym) : (s.startsWith(sym, i) ? sym.length : 0);
        if (len && !(sym === "<" && s[i + 1] === "<") && !(sym === ">" && s[i + 1] === ">")) { hit = [len, fn]; break; }
      }
      if (!hit) return v;
      i += hit[0];
      const r = level(n + 1);
      const out = hit[1](v | 0, r | 0);
      v = typeof out === "boolean" ? (out ? -1 : 0) : out | 0;
    }
  }
  if (!s) fail("Operand expected");
  const v = level(0); ws();
  if (i < s.length) fail(s[i] === "(" ? "Operator expected — Bennett writes memory operands as offset[reg], e.g. 4[sp]" : s[i] === "#" ? "Bennett comments start with ';', not '#'" : "Operator expected");
  return v;
}

function stripCommentB(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "`") { q = c; continue; }
    if (c === "'") { const m = /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/.exec(line.slice(i)); if (m) { i += m[0].length - 1; continue; } q = c; continue; }
    if (c === ";") return line.slice(0, i);
  }
  return line;
}
function splitArgsB(s) {
  const out = []; let cur = "", depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") cur += s[++i] || ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "`") { q = c; cur += c; continue; }
    if (c === "'") { const m = /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/.exec(s.slice(i)); if (m) { cur += m[0]; i += m[0].length - 1; continue; } q = c; cur += c; continue; }
    if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}
// whole-argument string "abc" / 'abc' / `abc` -> bytes, else null
function stringArgB(a) {
  const t = a.trim();
  if (t.length < 2 || !/^["'`]/.test(t) || t[t.length - 1] !== t[0]) return null;
  if (t[0] === "'" && /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'$/.test(t)) return null;   // 'a' is a number
  const bytes = [];
  for (let i = 1; i < t.length - 1;) {
    if (t[i] === "\\") { const [c, n] = unescapeChar(t, i + 1); bytes.push(c & 0xff); i = n; }
    else if (t[i] === t[0]) throw new AsmError("Garbage — a quote inside a string must be escaped, e.g. \\'");
    else { bytes.push(...new TextEncoder().encode(t[i])); i++; }
  }
  return bytes;
}
// offset[reg] / [reg]  ->  (offset)(reg) so the common encoder can use it
function normMemB(a) {
  const m = /^(.*?)\[\s*([A-Za-z0-9]+)\s*\]\s*$/.exec(a.trim());
  if (m) return `(${m[1].trim() || "0"})(${m[2]})`;
  const g = /\(\s*([A-Za-z]\w*)\s*\)\s*$/.exec(a.trim());
  if (g && regNum(g[1]) >= 0) throw new AsmError(`Bennett writes memory operands as offset[reg] — use ${a.trim().replace(/\(\s*(\w+)\s*\)\s*$/, "[$1]")}`);
  return a;
}

/* ------------------------------------------------------------------ assembler */
// Returns { ok, errors[], warnings[], segments, symbols, lineToAddr, addrToLine, entry, textRange, dataRange }
// opts.dialect: "gnu" (default; .text/.word, 4(sp), # comments) or "bennett" (UoM riscasm syntax)
function assemble(source, opts = {}) {
  const dialect = opts.dialect === "bennett" ? "bennett" : "gnu";
  const prevDialect = DIALECT;
  DIALECT = dialect;
  try { return assembleInner(source, opts, dialect); } finally { DIALECT = prevDialect; }
}

function assembleInner(source, opts, dialect) {
  const B = dialect === "bennett";
  const textBase = opts.textBase ?? 0;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let errors = [], warnings = [];
  const B_MN = new Set([...MNEMONICS, ...B_EXTRA]);

  // pass 1 is repeated until label values settle (li/la sizes depend on values, as in riscasm)
  let est = new Map();          // symbol estimates from the previous iteration
  let P;
  for (let iter = 0; iter < 8; iter++) {
    P = pass1(est);
    const next = layout(P).symbols;
    let same = next.size === est.size;
    if (same) for (const [k, v] of next) if (est.get(k) !== v) { same = false; break; }
    est = next;
    if (same) break;
  }

  function pass1(est) {
    const err = (ln, msg) => errs.push({ line: ln, message: msg, severity: "error" });
    const warn = (ln, msg) => warns.push({ line: ln, message: msg, severity: "warning" });
    const errs = [], warns = [];
    const items = [], consts = new Map(), labels = new Map(), locals = [];
    const secOff = { text: 0, data: 0 };
    let sec = "text", ended = false;
    const look = (n) => consts.has(n) ? consts.get(n) : labels.has(n) ? undefined : est.get(n);
    const lookAny = (n) => consts.has(n) ? consts.get(n) : est.get(n);

    for (let li = 0; li < lines.length && !ended; li++) {
      const ln = li + 1;
      let s, op, args, labelNames = [];
      try {
        if (B) {
          s = stripCommentB(lines[li]).replace(/\s+$/, "");
          if (!s.trim()) continue;
          let m = /^\s*([A-Za-z_][\w]*|\d+)(:?)(?=\s|$)/.exec(s);
          let rest = s;
          if (m && !(B_MN.has(m[1].toLowerCase()) && !m[2]) && !B_DIRECTIVES.includes(m[1].toLowerCase()) && !B_UNSUPPORTED.includes(m[1].toLowerCase())) {
            if (/^\d+$/.test(m[1]) && m[2]) throw new AsmError(`local labels are written without ':' in Bennett — "${m[1]}  nop", referenced as %b${m[1]} / %f${m[1]}`);
            labelNames.push(m[1]);
            rest = s.slice(m[0].length);
          } else if (!m) {
            const t = /^\s*(\S+)/.exec(s);
            if (t && /^[.#]/.test(t[1])) throw new AsmError(t[1][0] === "#" ? "Bennett comments start with ';', not '#'" : `"${t[1]}" is GNU syntax — Bennett uses DEFW/DEFB/DEFS/ALIGN/ORG/EQU (no leading dot) and has no sections`);
            if (t) throw new AsmError("Syntax error");
          }
          rest = rest.trim();
          if (!rest) { op = null; args = []; }
          else {
            const sp = rest.search(/\s/);
            op = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase();
            const argStr = sp < 0 ? "" : rest.slice(sp + 1).trim();
            args = argStr ? splitArgsB(argStr) : [];
          }
        } else {
          s = stripComment(lines[li]).trim();
          if (!s) continue;
          let m;
          while ((m = /^([A-Za-z_.$][\w.$]*|\d+)\s*:(?!=)/.exec(s))) { labelNames.push(m[1]); s = s.slice(m[0].length).trim(); }
          if ((m = /^([A-Za-z_.$][\w.$]*)\s*=\s*(.+)$/.exec(s))) s = `.equ ${m[1]}, ${m[2]}`;
          if (!s) { op = null; args = []; }
          else {
            const sp = s.search(/\s/);
            op = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
            const rest = sp < 0 ? "" : s.slice(sp + 1).trim();
            args = rest ? splitArgs(rest) : [];
          }
        }
      } catch (e) { if (e instanceof AsmError) { err(ln, e.message); continue; } throw e; }

      // ---- labels
      const isEqu = B ? op === "equ" : false;
      const defineLabels = () => {
        for (const name of labelNames) {
          if (/^\d+$/.test(name)) { locals.push({ name, sec, off: secOff[sec], idx: items.length }); continue; }
          if (labels.has(name) || consts.has(name)) err(ln, `label "${name}" is defined more than once`);
          else if (regNum(name) >= 0 || B_MN.has(name.toLowerCase())) err(ln, `"${name}" is a register/instruction name and can't be a label`);
          else labels.set(name, { sec, off: secOff[sec], ln });
        }
      };
      if (!isEqu && !(B && op === "align")) defineLabels();
      if (!op) continue;
      const push = (kind, size, extra = {}) => { items.push({ ln, sec, off: secOff[sec], size, kind, op, args, ...extra }); secOff[sec] += size; };
      try {
        if (B) {
          if (B_UNSUPPORTED.includes(op)) {
            const nxt = (args[0] || "").split(/\s+/)[0].toLowerCase();
            if (!labelNames.length && (B_MN.has(nxt) || B_DIRECTIVES.includes(nxt) || !args.length))
              throw new AsmError(`"${op}" is a reserved word in Bennett's assembler (the ${op.toUpperCase()} directive), so it can't be used as a label — rename it (e.g. ${op}_fn)`);
            throw new AsmError(`the ${op.toUpperCase()} directive isn't supported by SV Studio's Bennett assembler`);
          }
          if (op[0] === "." || op[0] === "#") throw new AsmError(op[0] === "#" ? "Bennett comments start with ';', not '#'" : `"${op}" is GNU syntax — Bennett uses DEFW/DEFB/DEFS/ALIGN/ORG/EQU (no leading dot)`);
          switch (op) {
            case "equ":
              if (args.length !== 1) throw new AsmError("EQU needs one value: name EQU value");
              if (!labelNames.length) continue;          // riscasm accepts and ignores an unlabelled EQU
              { let v; try { v = evalExprB(args[0], lookAny, secOff[sec]); } catch (e) { v = 0; if (iterLast) throw e; }
                for (const n of labelNames) { if (consts.has(n) || labels.has(n)) err(ln, `label "${n}" is defined more than once`); consts.set(n, v | 0); } }
              continue;
            case "org": case "origin": {
              const v = evalExprB(args[0] || "", lookAny, secOff.text);
              items.push({ ln, sec, off: v >>> 0, size: 0, kind: "org", op, args });
              secOff.text = v >>> 0;
              continue;
            }
            case "align": {
              const a = args.length ? evalExprB(args[0], lookAny, 0) : 4;
              if (a <= 0) throw new AsmError("ALIGN needs a positive value");
              const pad = (a - (secOff.text % a)) % a;
              if (args.length > 1) { defineLabels(); push("bytes", pad, { bytes: null, fill: evalExprB(args[1], lookAny, 0) & 0xff }); }
              else { push("gap", pad); defineLabels(); }
              continue;
            }
            case "defs": {
              const n = evalExprB(args[0] || "", lookAny, secOff.text);
              if (n < 0 || n > 16 * 1024 * 1024) throw new AsmError(`bad size ${n}`);
              if (args.length > 1) push("bytes", n, { bytes: null, fill: evalExprB(args[1], lookAny, 0) & 0xff });
              else push("gap", n);
              continue;
            }
            case "defb": case "dcb": case "defh": case "dcw": case "defw": case "dcd": {
              if (!args.length) throw new AsmError(`${op.toUpperCase()} needs a value`);
              const width = /b$/.test(op) ? 1 : /^(defh|dcw)$/.test(op) ? 2 : 4;
              const elems = [];
              for (const a of args) { const str = stringArgB(a); if (str) for (const c of str) elems.push(String(c)); else elems.push(a); }
              if (width > 1 && secOff.text % width) warn(ln, `${op.toUpperCase()} at an address that isn't a multiple of ${width} (Bennett doesn't align it for you — add ALIGN)`);
              push("data", width * elems.length, { width, args: elems });
              continue;
            }
            case "entry": case "export": continue;
          }
          if (!B_MN.has(op)) throw new AsmError(`Mnemonic not found: "${op}"`);
          if (secOff.text % 4) warn(ln, "instruction is not on a word boundary (add ALIGN before it)");
          args = args.map(a => normMemB(a));
          { look.pc = secOff.text; push("inst", 4 * instSize(op, args, look, lookAny)); }
          continue;
        }
        // ---------------- GNU
        if (op[0] === ".") {
          switch (op) {
            case ".text": sec = "text"; break;
            case ".data": case ".rodata": case ".bss": case ".sdata": case ".sbss": sec = "data"; break;
            case ".section": sec = (args[0] || "").startsWith(".text") ? "text" : "data"; break;
            case ".globl": case ".global": case ".local": case ".weak": case ".option": case ".type": case ".size": case ".file":
            case ".ident": case ".attribute": case ".extern": break;
            case ".end": ended = true; break;
            case ".equ": case ".set": {
              if (args.length !== 2) throw new AsmError(`${op} needs: name, value`);
              let v; try { v = evalExpr(args[1], lookAny, secOff[sec]); } catch (e) { v = 0; if (iterLast) throw e; }
              consts.set(args[0], v);
              break;
            }
            case ".word": case ".4byte": case ".long": if (!args.length) throw new AsmError(`${op} needs a value`); alignAuto(4); push("data", 4 * args.length, { width: 4 }); break;
            case ".half": case ".short": case ".2byte": if (!args.length) throw new AsmError(`${op} needs a value`); alignAuto(2); push("data", 2 * args.length, { width: 2 }); break;
            case ".byte": if (!args.length) throw new AsmError(`${op} needs a value`); push("data", args.length, { width: 1 }); break;
            case ".ascii": case ".asciz": case ".string": {
              const bytes = [];
              for (const a of args) { bytes.push(...parseString(a)); if (op !== ".ascii") bytes.push(0); }
              push("bytes", bytes.length, { bytes });
              break;
            }
            case ".space": case ".zero": case ".skip": {
              const n = evalExpr(args[0] || "", lookAny, secOff[sec]);
              if (n < 0 || n > 16 * 1024 * 1024) throw new AsmError(`bad size ${n}`);
              push("bytes", n, { bytes: null, fill: args[1] ? evalExpr(args[1], lookAny, 0) & 0xff : 0 });
              break;
            }
            case ".align": case ".p2align": case ".balign": {
              const v = evalExpr(args[0] || "", lookAny, 0);
              const a = op === ".balign" ? v : 1 << v;
              if (a <= 0 || a & (a - 1)) throw new AsmError(`alignment must be a power of two`);
              push("bytes", (a - (secOff[sec] % a)) % a, { bytes: null, fill: 0 });
              break;
            }
            case ".org": {
              if (sec !== "text") throw new AsmError(".org is only supported in .text (use .space in .data)");
              const v = evalExpr(args[0] || "", lookAny, secOff[sec]);
              const off = v - textBase;
              if (off < secOff.text) throw new AsmError(`.org 0x${v.toString(16)} moves backwards`);
              push("bytes", off - secOff.text, { bytes: null, fill: 0 });
              break;
            }
            default: throw new AsmError(`unknown directive ${op}`);
          }
        } else {
          if (secOff[sec] % 4) warn(ln, "instruction is not word-aligned (add .align 2 before it)");
          if (op === "tail" || !MNEMONICS.includes(op)) { if (!MNEMONICS.includes(op)) throw new AsmError(`unknown instruction "${op}"`); }
          look.pc = (sec === "text" ? textBase : 0) + secOff[sec];
          push("inst", 4 * instSize(op, args, look, lookAny));
        }
      } catch (e) {
        if (e instanceof AsmError) err(ln, e.message); else throw e;
      }
      function alignAuto(n) { // GNU mode: auto-align .word/.half (like RARS); labels at this spot move with it
        const cur = secOff[sec], pad = (n - (cur % n)) % n;
        if (!pad) return;
        for (const v of labels.values()) if (v.sec === sec && v.off === cur) v.off += pad;
        for (const l of locals) if (l.sec === sec && l.off === cur) l.off += pad;
        items.push({ ln, sec, off: cur, size: pad, kind: "bytes", bytes: null, fill: 0, op, args: [] });
        secOff[sec] += pad;
      }
    }
    return { items, consts, labels, locals, secOff, errs, warns };
  }

  function layout(P) {
    let textEnd = 0;
    for (const it of P.items) if (it.sec === "text") textEnd = Math.max(textEnd, it.off + it.size);
    textEnd = Math.max(textEnd, P.secOff.text);
    const dataBase = opts.dataBase ?? (((textBase + textEnd + 15) & ~15) >>> 0);
    const base = { text: textBase, data: dataBase };
    const symbols = new Map();
    for (const [k, v] of P.consts) symbols.set(k, v);
    for (const [k, v] of P.labels) symbols.set(k, (base[v.sec] + v.off) >>> 0);
    return { textEnd, dataBase, base, symbols };
  }

  // ---------- final layout + pass 2
  var iterLast = true;
  P = pass1(est);
  errors = P.errs; warnings = P.warns;
  const L = layout(P);
  const { base, symbols } = L;
  const textSize = L.textEnd;
  const symLine = new Map([...P.labels].map(([k, v]) => [k, v.ln]));
  const textBytes = new Uint8Array(textSize);
  const dataBytes = new Uint8Array(P.secOff.data);
  const filled = new Uint8Array(textSize);       // for Bennett: which bytes the program defines
  const buf = { text: textBytes, data: dataBytes };
  const addrToLine = new Map(), lineToAddr = new Map(), listing = [];
  const err = (ln, msg) => errors.push({ line: ln, message: msg, severity: "error" });
  const warn = (ln, msg) => warnings.push({ line: ln, message: msg, severity: "warning" });
  const locals = P.locals;
  P.items.forEach((it, idx) => {
    const addr = (base[it.sec] + it.off) >>> 0;
    if ((it.kind === "inst" || it.size) && it.kind !== "gap" && !lineToAddr.has(it.ln)) lineToAddr.set(it.ln, addr);
    const localAt = (name, dir) => {
      if (dir !== "f") for (let j = locals.length - 1; j >= 0; j--) if (locals[j].name === name && locals[j].idx <= idx) return (base[locals[j].sec] + locals[j].off) >>> 0;
      if (dir !== "b") for (const l of locals) if (l.name === name && l.idx > idx) return (base[l.sec] + l.off) >>> 0;
      return undefined;
    };
    const lookup = (n) => {
      let m;
      if (B && (m = /^%([bf]?)(\d+)$/.exec(n))) return localAt(m[2], m[1] || (m[1] === "" ? "" : m[1]));
      if (!B && /^\d+[bf]$/.test(n)) return localAt(n.slice(0, -1), n.slice(-1));
      return symbols.get(n);
    };
    const b = buf[it.sec];
    const put = (off, val, w) => { for (let k = 0; k < w; k++) { b[off + k] = (val >>> (8 * k)) & 0xff; if (it.sec === "text") filled[off + k] = 1; } };
    try {
      if (it.kind === "inst") {
        const words = encodeInst(it.op, it.args, addr, lookup, it.size / 4);
        if (words.length * 4 !== it.size) throw new AsmError(`internal size mismatch for ${it.op}`);
        words.forEach((w, k) => { put(it.off + 4 * k, w, 4); addrToLine.set(addr + 4 * k, it.ln); listing.push({ addr: addr + 4 * k, word: w, ln: it.ln }); });
        if (B && it.op === "tail") warn(it.ln, "Bennett's assembler encodes TAIL as JAL RA (a call, not a jump) — SV Studio does the same so behaviour matches");
      } else if (it.kind === "data") {
        it.args.forEach((a, k) => {
          const v = B ? evalExprB(a, lookup, addr + k * it.width) : evalExpr(a, lookup, addr + k * it.width);
          const lim = 2 ** (8 * it.width);
          if (!B && it.width < 4 && (v < -(lim / 2) || v >= lim)) warn(it.ln, `value ${v} doesn't fit in ${8 * it.width} bits (truncated)`);
          put(it.off + k * it.width, v, it.width);
        });
        for (let k = 0; k < it.size; k += 4) addrToLine.set((addr + k) >>> 0, it.ln);
      } else if (it.kind === "bytes") {
        if (it.bytes) { b.set(it.bytes, it.off); if (it.sec === "text") filled.fill(1, it.off, it.off + it.size); }
        else { if (it.fill) b.fill(it.fill, it.off, it.off + it.size); if (it.sec === "text") filled.fill(1, it.off, it.off + it.size); }
      }
    } catch (e) {
      if (e instanceof AsmError) err(it.ln, e.message); else throw e;
    }
  });

  if (!errors.length && textSize === 0) warnings.push({ line: 1, message: "no instructions", severity: "warning" });
  let entry = textBase;
  if (!B) for (const n of ["_start", "main", "start"]) if (P.labels.has(n) && P.labels.get(n).sec === "text") { entry = symbols.get(n); break; }

  return {
    ok: errors.length === 0, errors: errors.sort((a, b) => a.line - b.line), warnings, dialect,
    segments: [{ addr: textBase, bytes: textBytes, name: B ? "program" : "text" }, { addr: L.dataBase, bytes: dataBytes, name: "data" }],
    symbols, symLine, addrToLine, lineToAddr, listing, entry,
    textRange: [textBase, textBase + textSize], dataRange: [L.dataBase, L.dataBase + P.secOff.data],
  };
}

const isMemOperand = (a) => /\)\s*$/.test(a || "");

function liWords(v) { v = v | 0; return v >= -2048 && v <= 2047 ? 1 : (v & 0xfff) === 0 ? 1 : 2; }
function instSize(op, args, look, lookAny) {
  if (op === "li") {
    if (args.length !== 2) throw new AsmError("li needs: rd, value");
    let v; try { v = evalExpr(args[1], lookAny || look, 0); } catch (e) { return 2; }
    return liWords(v);
  }
  if (op === "la" || op === "lla") return 2;
  if ((op === "call" || op === "tail") && args.length === 1) {   // auipc+jalr when the target is beyond jal's ±1 MiB
    let t; try { t = evalExpr(args[0], lookAny || look, 0); } catch (e) { return 1; }
    return t === undefined || Math.abs(t - (look.pc || 0)) < 0xF0000 ? 1 : 2;
  }
  if ((op in LOAD) && args.length === 2 && !isMemOperand(args[1])) return 2;    // lw rd, symbol
  if ((op in STORE) && args.length === 3) return 2;                            // sw rs, symbol, rt
  return 1;
}

function reg(a, what = "register") {
  if (DIALECT === "bennett" && /^hp$/i.test((a || "").trim())) throw new AsmError("Bad register — Bennett's assembler calls x3 gp, not hp");
  const r = regNum((a || "").trim());
  if (r < 0) throw new AsmError(a ? `"${a}" is not a register` : `missing ${what}`);
  return r;
}
function nargs(op, args, n, form) { if (args.length !== n) throw new AsmError(`${op} expects ${form}`); }
function imm12(v, what = "immediate") { if (v < -2048 || v > 2047) throw new AsmError(`${what} ${v} doesn't fit in 12 bits (-2048..2047)`); return v; }
function memOperand(a, lookup, pc) {
  const m = /^(.*)\(\s*([\w$]+)\s*\)\s*$/.exec(a.trim());
  if (!m) throw new AsmError(`expected offset(register), got "${a}"`);
  return [m[1].trim() ? evalExpr(m[1], lookup, pc) : 0, reg(m[2])];
}
function csrNum(a, lookup) {
  const t = a.trim();
  if (DIALECT === "bennett") {
    if (B_CSR[t] !== undefined) return B_CSR[t];
    if (B_CSR[t.toUpperCase()] !== undefined) throw new AsmError(`Bennett's CSR names are upper-case — write ${t.toUpperCase()}`);
  } else {
    const n = CSRNAMES[t.toLowerCase()];
    if (n !== undefined) return n;
  }
  const v = evalExpr(a, lookup, 0);
  if (v < 0 || v > 0xfff) throw new AsmError(`bad CSR ${a}`);
  return v;
}

function encodeInst(op, a, pc, lookup, nwords) {
  const ev = (x) => evalExpr(x, lookup, pc);
  const off = (x, bits) => {
    const t = ev(x) - pc;
    const lim = 2 ** (bits - 1);
    if (t < -lim || t >= lim) throw new AsmError(`target ${x} is out of range for ${op} (±${lim} bytes)`);
    if (t & 1) throw new AsmError(`target ${x} is not 2-byte aligned`);
    return t;
  };
  if (op in R) { nargs(op, a, 3, "rd, rs1, rs2"); const [f3, f7] = R[op]; return [encR(f7, reg(a[2]), reg(a[1]), f3, reg(a[0]), 0x33)]; }
  if (op in IALU) { nargs(op, a, 3, "rd, rs1, imm"); return [encI(imm12(ev(a[2])), reg(a[1]), IALU[op], reg(a[0]), 0x13)]; }
  if (op in SHI) {
    nargs(op, a, 3, "rd, rs1, shamt"); const sh = ev(a[2]);
    if (sh < 0 || sh > 31) throw new AsmError(`shift amount ${sh} must be 0..31`);
    const [f3, f7] = SHI[op]; return [encR(f7, sh, reg(a[1]), f3, reg(a[0]), 0x13)];
  }
  if (op in LOAD) {
    if (a.length === 2 && !isMemOperand(a[1])) { // lw rd, symbol
      const rd = reg(a[0]); const [hi, lo] = hiLo(ev(a[1]) - pc);
      return [encU(hi, rd, 0x17), encI(lo, rd, LOAD[op], rd, 0x03)];
    }
    nargs(op, a, 2, "rd, offset(rs1)"); const [o, rs1] = memOperand(a[1], lookup, pc);
    return [encI(imm12(o, "offset"), rs1, LOAD[op], reg(a[0]), 0x03)];
  }
  if (op in STORE) {
    if (a.length === 3) { // sw rs2, symbol, rt
      const rt = reg(a[2]); const [hi, lo] = hiLo(ev(a[1]) - pc);
      return [encU(hi, rt, 0x17), encS(lo, reg(a[0]), rt, STORE[op], 0x23)];
    }
    nargs(op, a, 2, "rs2, offset(rs1)"); const [o, rs1] = memOperand(a[1], lookup, pc);
    return [encS(imm12(o, "offset"), reg(a[0]), rs1, STORE[op], 0x23)];
  }
  if (op in BR) { nargs(op, a, 3, "rs1, rs2, label"); return [encB(off(a[2], 13), reg(a[1]), reg(a[0]), BR[op])]; }
  if (op in CSR) {
    nargs(op, a, 3, "rd, csr, rs1/uimm");
    const src = op.endsWith("i") ? ev(a[2]) : reg(a[2]);
    if (op.endsWith("i") && (src < 0 || src > 31)) throw new AsmError("CSR immediate must be 0..31");
    return [encI(csrNum(a[1], lookup), src, CSR[op], reg(a[0]), 0x73)];
  }
  switch (op) {
    case "lui": case "auipc": {
      nargs(op, a, 2, "rd, imm20");
      if (DIALECT === "bennett") {
        const v = ev(a[1]) >>> 0;
        if (v & 0xfff) throw new AsmError(`Value out of range — Bennett's ${op} takes the full 32-bit value with the low 12 bits zero (e.g. ${op} a0, 0x12345000)`);
        return [encU(v >>> 12, reg(a[0]), op === "lui" ? 0x37 : 0x17)];
      }
      const v = ev(a[1]);
      if (v < -524288 || v > 0xfffff) throw new AsmError(`${op} immediate ${v} doesn't fit in 20 bits`);
      return [encU(v, reg(a[0]), op === "lui" ? 0x37 : 0x17)];
    }
    case "jal":
      if (a.length === 1) return [encJ(off(a[0], 21), 1)];
      nargs(op, a, 2, "rd, label"); return [encJ(off(a[1], 21), reg(a[0]))];
    case "jalr":
      if (a.length === 1) return [encI(0, reg(a[0]), 0, 1, 0x67)];
      if (a.length === 2) { const [o, rs1] = memOperand(a[1], lookup, pc); return [encI(imm12(o), rs1, 0, reg(a[0]), 0x67)]; }
      if (DIALECT === "bennett") throw new AsmError("Bennett writes jalr as: jalr rd, offset[rs]  (or jalr rs)");
      nargs(op, a, 3, "rd, rs1, imm"); return [encI(imm12(ev(a[2])), reg(a[1]), 0, reg(a[0]), 0x67)];
    case "ecall": return [0x00000073];
    case "ebreak": return [0x00100073];
    case "fence": return [0x0ff0000f];
    // ---- pseudo
    case "nop": return [0x00000013];
    case "li": {
      nargs(op, a, 2, "rd, value"); const rd = reg(a[0]); const v = ev(a[1]);
      if (v < -(2 ** 31) || v > 0xffffffff) throw new AsmError(`li value ${v} doesn't fit in 32 bits`);
      const vi = v | 0;
      if (nwords === 1 && vi >= -2048 && vi <= 2047) return [encI(vi, 0, 0, rd, 0x13)];
      const [hi, lo] = hiLo(vi);
      if (nwords === 1 && lo === 0) return [encU(hi, rd, 0x37)];
      if (nwords === 1) throw new AsmError("li value changed size between passes");
      return [encU(hi, rd, 0x37), encI(lo, rd, 0, rd, 0x13)];
    }
    case "la": case "lla": { nargs(op, a, 2, "rd, label"); const rd = reg(a[0]); const [hi, lo] = hiLo(ev(a[1]) - pc); return [encU(hi, rd, 0x17), encI(lo, rd, 0, rd, 0x13)]; }
    case "mv": nargs(op, a, 2, "rd, rs"); return [encI(0, reg(a[1]), 0, reg(a[0]), 0x13)];
    case "not": nargs(op, a, 2, "rd, rs"); return [encI(-1, reg(a[1]), 4, reg(a[0]), 0x13)];
    case "neg": nargs(op, a, 2, "rd, rs"); return [encR(32, reg(a[1]), 0, 0, reg(a[0]), 0x33)];
    case "seqz": nargs(op, a, 2, "rd, rs"); return [encI(1, reg(a[1]), 3, reg(a[0]), 0x13)];
    case "snez": nargs(op, a, 2, "rd, rs"); return [encR(0, reg(a[1]), 0, 3, reg(a[0]), 0x33)];
    case "sltz": nargs(op, a, 2, "rd, rs"); return [encR(0, 0, reg(a[1]), 2, reg(a[0]), 0x33)];
    case "sgtz": nargs(op, a, 2, "rd, rs"); return [encR(0, reg(a[1]), 0, 2, reg(a[0]), 0x33)];
    case "beqz": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), 0, reg(a[0]), 0)];
    case "bnez": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), 0, reg(a[0]), 1)];
    case "blez": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), reg(a[0]), 0, 5)];
    case "bgez": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), 0, reg(a[0]), 5)];
    case "bltz": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), 0, reg(a[0]), 4)];
    case "bgtz": nargs(op, a, 2, "rs, label"); return [encB(off(a[1], 13), reg(a[0]), 0, 4)];
    case "bgt": nargs(op, a, 3, "rs1, rs2, label"); return [encB(off(a[2], 13), reg(a[0]), reg(a[1]), 4)];
    case "ble": nargs(op, a, 3, "rs1, rs2, label"); return [encB(off(a[2], 13), reg(a[0]), reg(a[1]), 5)];
    case "bgtu": nargs(op, a, 3, "rs1, rs2, label"); return [encB(off(a[2], 13), reg(a[0]), reg(a[1]), 6)];
    case "bleu": nargs(op, a, 3, "rs1, rs2, label"); return [encB(off(a[2], 13), reg(a[0]), reg(a[1]), 7)];
    case "j": nargs(op, a, 1, "label"); return [encJ(off(a[0], 21), 0)];
    case "jr": nargs(op, a, 1, "rs"); return [encI(0, reg(a[0]), 0, 0, 0x67)];
    case "ret": nargs(op, a, 0, "no operands"); return [encI(0, 1, 0, 0, 0x67)];
    case "call": case "tail": {
      nargs(op, a, 1, "label");
      const rd = op === "call" || DIALECT === "bennett" ? 1 : 0;
      if (nwords === 2) { const [hi, lo] = hiLo(ev(a[0]) - pc); return [encU(hi, rd === 1 ? 1 : 6, 0x17), encI(lo, rd === 1 ? 1 : 6, 0, rd, 0x67)]; }
      return [encJ(off(a[0], 21), rd)];
    }
    case "subi": nargs(op, a, 3, "rd, rs1, imm"); return [encI(imm12(-ev(a[2])), reg(a[1]), 0, reg(a[0]), 0x13)];
    case "illegal": return [0];
    case "uret": return [0x00200073];
    case "sret": return [0x10200073];
    case "mret": return [0x30200073];
    case "wfi": return [0x10500073];
    case "csrwi": nargs(op, a, 2, "csr, uimm"); return [encI(csrNum(a[0], lookup), ev(a[1]) & 31, 5, 0, 0x73)];
    case "csrsi": nargs(op, a, 2, "csr, uimm"); return [encI(csrNum(a[0], lookup), ev(a[1]) & 31, 6, 0, 0x73)];
    case "csrci": nargs(op, a, 2, "csr, uimm"); return [encI(csrNum(a[0], lookup), ev(a[1]) & 31, 7, 0, 0x73)];
    case "rdcycleh": nargs(op, a, 1, "rd"); return [encI(0xC80, 0, 2, reg(a[0]), 0x73)];
    case "rdtimeh": nargs(op, a, 1, "rd"); return [encI(0xC81, 0, 2, reg(a[0]), 0x73)];
    case "rdinstreth": nargs(op, a, 1, "rd"); return [encI(0xC82, 0, 2, reg(a[0]), 0x73)];
    case "rdcycle": nargs(op, a, 1, "rd"); return [encI(0xC00, 0, 2, reg(a[0]), 0x73)];
    case "rdtime": nargs(op, a, 1, "rd"); return [encI(0xC01, 0, 2, reg(a[0]), 0x73)];
    case "rdinstret": nargs(op, a, 1, "rd"); return [encI(0xC02, 0, 2, reg(a[0]), 0x73)];
    case "csrr": nargs(op, a, 2, "rd, csr"); return [encI(csrNum(a[1], lookup), 0, 2, reg(a[0]), 0x73)];
    case "csrw": nargs(op, a, 2, "csr, rs"); return [encI(csrNum(a[0], lookup), reg(a[1]), 1, 0, 0x73)];
    case "csrs": nargs(op, a, 2, "csr, rs"); return [encI(csrNum(a[0], lookup), reg(a[1]), 2, 0, 0x73)];
    case "csrc": nargs(op, a, 2, "csr, rs"); return [encI(csrNum(a[0], lookup), reg(a[1]), 3, 0, 0x73)];
  }
  throw new AsmError(`unknown instruction "${op}"`);
}

/* ------------------------------------------------------------------ decode / disassemble */
const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits);
function decode(w) {
  w = w >>> 0;
  const op = w & 0x7f, rd = (w >> 7) & 31, f3 = (w >> 12) & 7, rs1 = (w >> 15) & 31, rs2 = (w >> 20) & 31, f7 = w >>> 25;
  const iImm = w >> 20;
  const sImm = ((w >> 25) << 5) | ((w >> 7) & 31);
  const bImm = sx((((w >>> 31) & 1) << 12) | (((w >> 7) & 1) << 11) | (((w >> 25) & 0x3f) << 5) | (((w >> 8) & 0xf) << 1), 13);
  const uImm = w & 0xfffff000;
  const jImm = sx((((w >>> 31) & 1) << 20) | (((w >> 12) & 0xff) << 12) | (((w >> 20) & 1) << 11) | (((w >> 21) & 0x3ff) << 1), 21);
  return { w, op, rd, f3, rs1, rs2, f7, iImm, sImm, bImm, uImm, jImm };
}

function disasm(w, pc, opts = {}) {
  const d = decode(w);
  const rn = (r) => opts.xnames ? "x" + r : ABI[r];
  const sym = opts.symbolAt || (() => null);
  const tgt = (t) => { t = t >>> 0; const s = sym(t); return s ? s : "0x" + t.toString(16); };
  const { op, rd, f3, rs1, rs2, f7, iImm } = d;
  const find = (tbl, pred) => Object.keys(tbl).find(pred);
  switch (op) {
    case 0x33: { const n = find(R, k => R[k][0] === f3 && R[k][1] === f7); if (!n) break;
      if (n === "sub" && rs1 === 0) return `neg ${rn(rd)}, ${rn(rs2)}`;
      return `${n} ${rn(rd)}, ${rn(rs1)}, ${rn(rs2)}`; }
    case 0x13: {
      if (f3 === 1 || f3 === 5) { const n = find(SHI, k => SHI[k][0] === f3 && SHI[k][1] === f7); if (!n) break; return `${n} ${rn(rd)}, ${rn(rs1)}, ${rs2}`; }
      const n = find(IALU, k => IALU[k] === f3);
      if (n === "addi" && rd === 0 && rs1 === 0 && iImm === 0) return "nop";
      if (n === "addi" && rs1 === 0) return `li ${rn(rd)}, ${iImm}`;
      if (n === "addi" && iImm === 0) return `mv ${rn(rd)}, ${rn(rs1)}`;
      if (n === "xori" && iImm === -1) return `not ${rn(rd)}, ${rn(rs1)}`;
      return `${n} ${rn(rd)}, ${rn(rs1)}, ${iImm}`; }
    case 0x03: { const n = find(LOAD, k => LOAD[k] === f3); if (!n) break; return `${n} ${rn(rd)}, ${iImm}(${rn(rs1)})`; }
    case 0x23: { const n = find(STORE, k => STORE[k] === f3); if (!n) break; return `${n} ${rn(rs2)}, ${d.sImm}(${rn(rs1)})`; }
    case 0x63: { const n = find(BR, k => BR[k] === f3); if (!n) break; const t = tgt(pc + d.bImm);
      if (rs2 === 0 && (n === "beq" || n === "bne")) return `${n}z ${rn(rs1)}, ${t}`;
      return `${n} ${rn(rs1)}, ${rn(rs2)}, ${t}`; }
    case 0x37: return `lui ${rn(rd)}, 0x${(d.uImm >>> 12).toString(16)}`;
    case 0x17: return `auipc ${rn(rd)}, 0x${(d.uImm >>> 12).toString(16)}`;
    case 0x6f: { const t = tgt(pc + d.jImm);
      if (rd === 0) return d.jImm === 0 ? `j . (halt loop)` : `j ${t}`;
      if (rd === 1) return `jal ${t}`;
      return `jal ${rn(rd)}, ${t}`; }
    case 0x67: if (f3) break;
      if (rd === 0 && rs1 === 1 && iImm === 0) return "ret";
      if (rd === 0 && iImm === 0) return `jr ${rn(rs1)}`;
      return `jalr ${rn(rd)}, ${iImm}(${rn(rs1)})`;
    case 0x73:
      if (w === 0x73) return "ecall";
      if (w === 0x00100073) return "ebreak";
      if (f3) { const n = find(CSR, k => CSR[k] === f3); const csr = (w >>> 20) & 0xfff; const cn = CSRBYNUM[csr] || "0x" + csr.toString(16);
        if (n === "csrrs" && rs1 === 0) return `csrr ${rn(rd)}, ${cn}`;
        return `${n} ${rn(rd)}, ${cn}, ${f3 >= 5 ? rs1 : rn(rs1)}`; }
      break;
    case 0x0f: return "fence";
  }
  return `.word 0x${(w >>> 0).toString(16).padStart(8, "0")}`;
}

/* ------------------------------------------------------------------ machine */
const BENNETT_MEM = 10004;   // COMP15111 emulator: addresses 0..10000 (0x2710) are readable
const BENNETT_SYSCALLS = { 0: "print char (a0)", 1: "read char → a0", 2: "print string at a0", 3: "print integer a0", 5: "halt" };
const SYSCALLS = {
  1: "print_int(a0)", 4: "print_string(a0)", 5: "read_int → a0", 8: "read_string(a0 buf, a1 len)", 10: "exit",
  11: "print_char(a0)", 12: "read_char → a0", 34: "print_hex(a0)", 35: "print_bin(a0)", 36: "print_unsigned(a0)",
  93: "exit(a0)", 64: "write(a0 fd, a1 buf, a2 len)", 63: "read(a0 fd, a1 buf, a2 len)",
};

class Machine {
  constructor(opts = {}) {
    // mode "bennett": COMP15111 emulator behaviour — 10,000 bytes of memory, all registers (incl. sp) start at 0,
    // and Bennett's ecall services (a7 = 0 putc, 1 getc, 2 puts, 3 print int, 5 halt)
    this.mode = opts.mode === "bennett" ? "bennett" : "generic";
    this.memSize = this.mode === "bennett" ? BENNETT_MEM : (opts.memSize || 1 << 20);
    this.mem = new Uint8Array(this.memSize);
    this.x = new Int32Array(32);
    this.historyCap = opts.historyCap || 200000;
    this.output = opts.output || (() => {});
    this.reset();
  }
  reset(keepMem = false) {
    if (!keepMem) this.mem.fill(0);
    this.x.fill(0);
    this.pc = 0;
    if (this.mode !== "bennett") this.x[2] = this.memSize;   // sp = top of memory (Bennett leaves it at 0)
    this.inputQueue = "";
    this.cycles = 0;
    this.status = "ready";                 // ready | running | paused | halted | fault | input
    this.message = "";
    this.exitCode = null;
    this.hist = [];                        // undo records
    this.histDropped = 0;
    this.frames = [];                      // call stack for ABI checks
    this.abiWarnings = [];
    this.csr = new Map();
    this.pendingInput = null;
    this.lastWrite = null;
    this.memWrites = new Map();            // addr -> cycle of last write (for highlight)
  }
  load(asm) {
    this.reset();
    for (const s of asm.segments) {
      if (!s.bytes.length) continue;
      if (s.addr + s.bytes.length > this.memSize) throw new Error(`${s.name} segment (0x${s.addr.toString(16)}+${s.bytes.length}) doesn't fit in ${this.memSize >> 10} KiB of memory`);
      this.mem.set(s.bytes, s.addr);
    }
    this.pc = asm.entry >>> 0;
    this.program = asm;
  }
  loadBinary(bytes, addr) {
    this.reset();
    if (addr + bytes.length > this.memSize) throw new Error("file doesn't fit in memory");
    this.mem.set(bytes, addr); this.pc = addr; this.program = null;
  }
  // ---- memory
  checkAddr(a, n, write) {
    if (a < 0 || a + n > this.memSize) {
      let msg = `${write ? "store to" : "load from"} 0x${(a >>> 0).toString(16)} is outside memory (0..0x${(this.memSize - 1).toString(16)})`;
      if (this.mode === "bennett") {
        msg += write ? ". Bennett silently ignores this store" : ". In Bennett this load returns 0xDEADBEFF";
        const sp = this.x[2] >>> 0;
        if (sp === 0 || sp > this.memSize) msg += ` — sp is 0x${sp.toString(16)}: Bennett starts every register at 0, so set the stack pointer first (e.g. li sp, 0x2700)`;
      }
      throw new Fault(msg);
    }
    if (a % n) throw new Fault(`misaligned ${n * 8}-bit ${write ? "store to" : "load from"} 0x${a.toString(16)} (address must be a multiple of ${n})`);
  }
  read(a, n, signed) {
    a = a >>> 0; this.checkAddr(a, n, false);
    const m = this.mem;
    if (n === 1) return signed ? (m[a] << 24) >> 24 : m[a];
    if (n === 2) { const v = m[a] | (m[a + 1] << 8); return signed ? (v << 16) >> 16 : v; }
    return m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24);
  }
  peek32(a) { a = a >>> 0; if (a + 4 > this.memSize) return 0; const m = this.mem; return (m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24)) >>> 0; }
  write(a, n, v, rec) {
    a = a >>> 0; this.checkAddr(a, n, true);
    if (rec) rec.mem = [a, n, this.read(a, n, false)];
    for (let k = 0; k < n; k++) this.mem[a + k] = (v >>> (8 * k)) & 0xff;
    this.memWrites.set(a & ~3, this.cycles);
    this.lastWrite = [a, n];
  }
  setReg(r, v, rec) { if (r) { rec.rd = r; rec.old = this.x[r]; this.x[r] = v | 0; } }
  readCSR(n) {
    switch (n) { case 0xC00: case 0xC02: case 0xB00: case 0xB02: case 0xC01: return this.cycles | 0;
      case 0xC80: case 0xC81: case 0xC82: return Math.floor(this.cycles / 2 ** 32) | 0; case 0xF14: return 0; case 0x301: return 0x40001100; }
    return this.csr.get(n) | 0;
  }
  // ---- execution
  step() {
    if (this.status === "halted" || this.status === "fault") return false;
    if (this.status === "input") return false;
    const pc = this.pc >>> 0;
    const rec = { pc, rd: 0, old: 0, mem: null, frame: null, cyc: this.cycles };
    try {
      if (pc % 4) throw new Fault(`pc 0x${pc.toString(16)} is not word-aligned`);
      if (pc + 4 > this.memSize) throw new Fault(`pc 0x${pc.toString(16)} is outside memory`);
      const w = this.peek32(pc);
      if (w === 0) throw new Fault(`illegal instruction 0x00000000 at 0x${pc.toString(16)} — the program ran past the end of its code. End it with an exit ecall (li a7, 10; ecall) or a "j ." loop.`);
      const d = decode(w);
      const x = this.x;
      let next = (pc + 4) >>> 0;
      const r1 = x[d.rs1], r2 = x[d.rs2];
      switch (d.op) {
        case 0x33: {
          let v;
          if (d.f7 === 1) {
            switch (d.f3) {
              case 0: v = Math.imul(r1, r2); break;
              case 1: v = Number((BigInt(r1) * BigInt(r2)) >> 32n); break;
              case 2: v = Number((BigInt(r1) * BigInt(r2 >>> 0)) >> 32n); break;
              case 3: v = Number((BigInt(r1 >>> 0) * BigInt(r2 >>> 0)) >> 32n); break;
              case 4: v = r2 === 0 ? -1 : (r1 === -2147483648 && r2 === -1) ? r1 : Math.trunc(r1 / r2); break;
              case 5: v = r2 === 0 ? -1 : Math.floor((r1 >>> 0) / (r2 >>> 0)); break;
              case 6: v = r2 === 0 ? r1 : (r1 === -2147483648 && r2 === -1) ? 0 : r1 % r2; break;
              case 7: v = r2 === 0 ? r1 : (r1 >>> 0) % (r2 >>> 0); break;
            }
          } else if (d.f7 === 0 || d.f7 === 32) {
            switch (d.f3) {
              case 0: v = d.f7 ? r1 - r2 : r1 + r2; break;
              case 1: v = r1 << (r2 & 31); break;
              case 2: v = r1 < r2 ? 1 : 0; break;
              case 3: v = (r1 >>> 0) < (r2 >>> 0) ? 1 : 0; break;
              case 4: v = r1 ^ r2; break;
              case 5: v = d.f7 ? r1 >> (r2 & 31) : r1 >>> (r2 & 31); break;
              case 6: v = r1 | r2; break;
              case 7: v = r1 & r2; break;
            }
            if ((d.f7 === 32) && d.f3 !== 0 && d.f3 !== 5) v = undefined;
          }
          if (v === undefined) throw illegal(w, pc);
          this.setReg(d.rd, v, rec); break;
        }
        case 0x13: {
          const im = d.iImm; let v;
          switch (d.f3) {
            case 0: v = r1 + im; break; case 2: v = r1 < im ? 1 : 0; break; case 3: v = (r1 >>> 0) < (im >>> 0) ? 1 : 0; break;
            case 4: v = r1 ^ im; break; case 6: v = r1 | im; break; case 7: v = r1 & im; break;
            case 1: if (d.f7) throw illegal(w, pc); v = r1 << d.rs2; break;
            case 5: if (d.f7 === 32) v = r1 >> d.rs2; else if (d.f7 === 0) v = r1 >>> d.rs2; else throw illegal(w, pc); break;
          }
          this.setReg(d.rd, v, rec); break;
        }
        case 0x03: {
          const a = (r1 + d.iImm) >>> 0; let v;
          switch (d.f3) { case 0: v = this.read(a, 1, true); break; case 1: v = this.read(a, 2, true); break; case 2: v = this.read(a, 4); break;
            case 4: v = this.read(a, 1, false); break; case 5: v = this.read(a, 2, false); break; default: throw illegal(w, pc); }
          this.setReg(d.rd, v, rec); break;
        }
        case 0x23: {
          const a = (r1 + d.sImm) >>> 0; const n = [1, 2, 4][d.f3]; if (!n) throw illegal(w, pc);
          this.write(a, n, r2, rec); break;
        }
        case 0x63: {
          let t;
          switch (d.f3) { case 0: t = r1 === r2; break; case 1: t = r1 !== r2; break; case 4: t = r1 < r2; break; case 5: t = r1 >= r2; break;
            case 6: t = (r1 >>> 0) < (r2 >>> 0); break; case 7: t = (r1 >>> 0) >= (r2 >>> 0); break; default: throw illegal(w, pc); }
          if (t) next = (pc + d.bImm) >>> 0;
          break;
        }
        case 0x37: this.setReg(d.rd, d.uImm, rec); break;
        case 0x17: this.setReg(d.rd, pc + d.uImm, rec); break;
        case 0x6f: {
          next = (pc + d.jImm) >>> 0;
          if (d.rd === 0 && d.jImm === 0) { this.halt("Program finished (reached a \"j .\" loop)."); this.cycles++; return false; }
          this.setReg(d.rd, pc + 4, rec);
          if (d.rd === 1) this.pushFrame(next, pc, rec);
          break;
        }
        case 0x67: {
          if (d.f3) throw illegal(w, pc);
          next = ((r1 + d.iImm) & ~1) >>> 0;
          this.setReg(d.rd, pc + 4, rec);
          if (d.rd === 1) this.pushFrame(next, pc, rec);
          else if (d.rd === 0 && d.rs1 === 1) this.popFrame(next, pc, rec);
          break;
        }
        case 0x0f: break;
        case 0x73: {
          if (w === 0x73) { const r = this.ecall(rec); if (r === "wait") return false; if (r === "exit") { this.cycles++; this.hist.push(rec); return false; } }
          else if ((w === 0x00200073 || w === 0x10200073 || w === 0x30200073 || w === 0x10500073)) { /* uret/sret/mret/wfi: no-op here */ }
          else if (w === 0x00100073) { this.pc = next; this.cycles++; this.hist.push(rec); this.status = "paused"; this.message = `ebreak at 0x${pc.toString(16)}`; return false; }
          else {
            const csr = (w >>> 20) & 0xfff; const old = this.readCSR(csr); const src = d.f3 >= 5 ? d.rs1 : r1;
            let nv = old;
            switch (d.f3 & 3) { case 1: nv = src; break; case 2: nv = old | src; break; case 3: nv = old & ~src; break; default: throw illegal(w, pc); }
            const writes = (d.f3 & 3) === 1 || d.rs1 !== 0;
            if (writes) { if ((csr >> 10) === 3) throw new Fault(`CSR ${CSRBYNUM[csr] || csr} is read-only`); rec.csr = [csr, this.csr.get(csr)]; this.csr.set(csr, nv | 0); }
            this.setReg(d.rd, old, rec);
          }
          break;
        }
        default: throw illegal(w, pc);
      }
      this.pc = next;
      this.cycles++;
      this.hist.push(rec);
      if (this.hist.length > this.historyCap) { const drop = this.hist.length - this.historyCap + 10000; this.hist.splice(0, drop); this.histDropped += drop; }
      return true;
    } catch (e) {
      if (e instanceof Fault) { this.status = "fault"; this.message = e.message; return false; }
      throw e;
    }
  }
  halt(msg, code = 0) { this.status = "halted"; this.message = msg; this.exitCode = code; }
  pushFrame(target, pc, rec) {
    const saved = [];
    for (let r = 0; r < 32; r++) if (REG_SAVER[r] === "callee") saved.push(this.x[r]);
    this.frames.push({ target, callPc: pc, ret: (pc + 4) >>> 0, saved, cyc: this.cycles });
    rec.frame = { push: true };
    if (this.frames.length > 10000) this.frames.shift();
  }
  popFrame(target, pc, rec) {
    const i = this.frames.map(f => f.ret).lastIndexOf(target);
    if (i < 0) return;
    const f = this.frames[i];
    const popped = this.frames.splice(i);
    rec.frame = { popped };
    const changed = [];
    let k = 0;
    for (let r = 0; r < 32; r++) if (REG_SAVER[r] === "callee") { if (this.x[r] !== f.saved[k]) changed.push(r); k++; }
    if (changed.length) {
      const fn = this.program ? (this.symbolAt(f.target) || "0x" + f.target.toString(16)) : "0x" + f.target.toString(16);
      const msg = `${fn} returned without restoring ${changed.map(r => ABI[r]).join(", ")} (callee-saved — save them on the stack first)`;
      this.abiWarnings.push({ cyc: this.cycles, pc, msg, regs: changed });
      rec.abiWarn = true;
    }
  }
  symbolAt(a) {
    if (!this.program) return null;
    if (!this._symRev) this._symRev = null;
    if (!this._symRevFor || this._symRevFor !== this.program) {
      this._symRevFor = this.program; this._symRev = new Map();
      for (const [k, v] of this.program.symbols) if (this.program.symLine.has(k) && !this._symRev.has(v)) this._symRev.set(v, k);
    }
    return this._symRev.get(a >>> 0) || null;
  }
  readString(a, max = 4096) {
    let s = ""; const bytes = [];
    for (let i = 0; i < max; i++) { const b = this.read(a + i, 1, false); if (!b) break; bytes.push(b); }
    try { s = new TextDecoder().decode(new Uint8Array(bytes)); } catch (e) { s = String.fromCharCode(...bytes); }
    return s;
  }
  // input typed by the user is queued (like a terminal); read services take from it or wait
  takeLine() { const i = this.inputQueue.indexOf("\n"); if (i < 0) return null; const l = this.inputQueue.slice(0, i); this.inputQueue = this.inputQueue.slice(i + 1); return l; }
  ecall(rec) {
    const a7 = this.x[17], a0 = this.x[10];
    const out = (s) => this.output(s);
    const wait = (kind) => { this.status = "input"; this.pendingInput = kind; return "wait"; };
    if (this.mode === "bennett") {
      switch (a7) {
        case 0: out(String.fromCharCode(a0 & 0xff)); break;
        case 1: if (!this.inputQueue.length) return wait("char");
          rec.inQ = this.inputQueue; this.setReg(10, this.inputQueue.charCodeAt(0) & 0xff, rec); this.inputQueue = this.inputQueue.slice(1); break;
        case 2: { let t = ""; for (let i = 0; i < 128; i++) { const b = this.read((a0 + i) >>> 0, 1, false); if (!b) break; t += String.fromCharCode(b); } out(t); break; }
        case 3: out(String(a0 | 0)); break;
        case 5: this.pc = (this.pc + 4) >>> 0; this.halt("Program halted (ecall with a7 = 5)."); return "exit";
        default:
          this.status = "paused";
          this.message = `ecall with a7 = ${a7}: not a Bennett service, so Bennett would wait here forever. Services: a7 = 0 print char (a0), 1 read char → a0, 2 print string at a0, 3 print integer a0, 5 halt.`;
          return "wait";
      }
      return "ok";
    }
    switch (a7) {
      case 1: out(String(a0)); break;
      case 4: out(this.readString(a0 >>> 0)); break;
      case 11: out(String.fromCharCode(a0 & 0xff)); break;
      case 34: out("0x" + (a0 >>> 0).toString(16).padStart(8, "0")); break;
      case 35: out((a0 >>> 0).toString(2).padStart(32, "0")); break;
      case 36: out(String(a0 >>> 0)); break;
      case 64: { const n = this.x[12] >>> 0; let t = ""; for (let i = 0; i < n && i < 65536; i++) t += String.fromCharCode(this.read(this.x[11] + i, 1, false)); out(t); this.setReg(10, n, rec); break; }
      case 10: this.pc = (this.pc + 4) >>> 0; this.halt("Program exited (ecall 10).", 0); return "exit";
      case 93: this.pc = (this.pc + 4) >>> 0; this.halt(`Program exited with code ${a0} (ecall 93).`, a0); return "exit";
      case 12: { if (!this.inputQueue.length) return wait("char"); rec.inQ = this.inputQueue; this.setReg(10, this.inputQueue.charCodeAt(0), rec); this.inputQueue = this.inputQueue.slice(1); break; }
      case 5: case 8: case 63: {
        const q0 = this.inputQueue; const line = this.takeLine();
        if (line === null) return wait(a7 === 5 ? "int" : "line");
        rec.inQ = q0;
        if (a7 === 5) { const n = parseInt(line.trim(), 10); this.setReg(10, isNaN(n) ? 0 : n, rec); break; }
        const buf = (a7 === 8 ? a0 : this.x[11]) >>> 0, len = (a7 === 8 ? this.x[11] : this.x[12]) >>> 0;
        const bytes = new TextEncoder().encode(line + "\n");
        const n = Math.min(bytes.length, a7 === 8 ? Math.max(0, len - 1) : len);
        const writes = [];
        for (let i = 0; i < n; i++) { writes.push([buf + i, this.read(buf + i, 1, false)]); this.mem[buf + i] = bytes[i]; }
        if (a7 === 8 && len) { writes.push([buf + n, this.read(buf + n, 1, false)]); this.mem[buf + n] = 0; }
        rec.memBlock = writes;
        if (a7 === 63) this.setReg(10, n, rec);
        break;
      }
      default:
        this.status = "paused";
        this.message = `Unknown ecall service a7=${a7}. Supported: ${Object.entries(SYSCALLS).map(([k, v]) => k + " " + v).join(", ")}`;
        return "wait";
    }
    return "ok";
  }
  provideInput(text) { this.inputQueue += text; if (this.status === "input") { this.status = "paused"; this.pendingInput = null; } }
  stepBack() {
    const rec = this.hist.pop();
    if (!rec) return false;
    if (rec.rd) this.x[rec.rd] = rec.old;
    if (rec.mem) { const [a, n, v] = rec.mem; for (let k = 0; k < n; k++) this.mem[a + k] = (v >>> (8 * k)) & 0xff; }
    if (rec.memBlock) for (let i = rec.memBlock.length - 1; i >= 0; i--) this.mem[rec.memBlock[i][0]] = rec.memBlock[i][1];
    if (rec.csr) { if (rec.csr[1] === undefined) this.csr.delete(rec.csr[0]); else this.csr.set(rec.csr[0], rec.csr[1]); }
    if (rec.frame) { if (rec.frame.push) this.frames.pop(); else if (rec.frame.popped) this.frames.push(...rec.frame.popped); }
    if (rec.abiWarn) this.abiWarnings.pop();
    if (rec.inQ !== undefined) this.inputQueue = rec.inQ;
    this.pc = rec.pc;
    this.cycles = rec.cyc;
    this.status = "paused"; this.message = ""; this.exitCode = null; this.pendingInput = null;
    return true;
  }
  // Value history for one register: [{cyc, pc, old, value}] oldest first (from undo log)
  regHistory(r, limit = 500) {
    const out = [];
    for (let i = this.hist.length - 1; i >= 0 && out.length < limit; i--) {
      const h = this.hist[i];
      if (h.rd === r) out.push({ cyc: h.cyc, pc: h.pc, old: h.old, value: 0 });
    }
    let cur = this.x[r];               // value after a write = old value of the next write (or the current value)
    for (const e of out) { e.value = cur; cur = e.old; }
    return out.reverse();
  }
}
class Fault extends Error {}
const illegal = (w, pc) => new Fault(`illegal instruction 0x${(w >>> 0).toString(16).padStart(8, "0")} at 0x${pc.toString(16)}`);

/* ------------------------------------------------------------------ hex / kmd loaders */
function parseHexText(text) { // one hex word per line (Bennett/Verilog style), optional @addr lines
  const words = []; let addr = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.replace(/\/\/.*|#.*/, "").trim(); if (!t) continue;
    for (const tok of t.split(/\s+/)) {
      if (tok[0] === "@") { addr = parseInt(tok.slice(1), 16); continue; }
      const v = parseInt(tok.replace(/^0x/i, ""), 16); if (isNaN(v)) throw new Error(`bad hex value "${tok}"`);
      words.push(v >>> 0);
    }
  }
  const b = new Uint8Array(words.length * 4);
  words.forEach((w, i) => { for (let k = 0; k < 4; k++) b[i * 4 + k] = (w >>> (8 * k)) & 0xff; });
  return { bytes: b, addr };
}

const api = { BENNETT_MEM, BENNETT_SYSCALLS, B_CSR, B_DIRECTIVES, assemble, disasm, decode, Machine, ABI, REG_ROLE, REG_SAVER, regNum, MNEMONICS, PSEUDO, DIRECTIVES, DOC, SYSCALLS,
  CSRNAMES, evalExpr, parseHexText, AsmError };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RV = api;
})(typeof window !== "undefined" ? window : globalThis);
