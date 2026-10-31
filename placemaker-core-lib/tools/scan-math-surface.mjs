// 静态核对：Placemaker Core 用到的 Unity.Mathematics API 面 vs Compatibility/UnityMathematics.cs 已声明的面
// 用途：本机无法启动 dotnet（被策略拦截），用静态 diff 代替编译器的第一轮报错。
// 用法：node tools/scan-math-surface.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CORE_DIR = resolve(ROOT, '..', 'placemaker-master', 'placemaker-master', 'Core');
const SHIM = resolve(ROOT, 'Compatibility', 'UnityMathematics.cs');

// ---------- 1. 读源码并剥掉注释/字符串 ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.cs')) out.push(p);
  }
  return out;
}

// 把注释、字符串字面量、字符字面量替换成等长空白，保持索引对齐（便于取原位置报错）
function stripNoise(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === '"' || (c === '@' && c2 === '"') || (c === '$' && c2 === '"')) {
      // 字符串：@"..." 与 $"..." 简化处理
      let j = i;
      if (c === '@' || c === '$') { out[i] = ' '; j = i + 1; }
      const verbatim = src[j] === '@';
      if (verbatim) j++;
      if (src[j] !== '"') { i = j; continue; }
      out[j] = ' '; j++;
      while (j < n) {
        if (verbatim) {
          if (src[j] === '"' && src[j + 1] === '"') { out[j] = ' '; out[j + 1] = ' '; j += 2; continue; }
          if (src[j] === '"') { out[j] = ' '; j++; break; }
        } else {
          if (src[j] === '\\') { out[j] = ' '; if (j + 1 < n) out[j + 1] = ' '; j += 2; continue; }
          if (src[j] === '"') { out[j] = ' '; j++; break; }
          if (src[j] === '\n') break;
        }
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j;
    } else if (c === "'") {
      // 字符字面量
      let j = i + 1;
      out[i] = ' ';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\') { out[j] = ' '; if (j + 1 < n) out[j + 1] = ' '; j += 2; continue; }
        out[j] = ' '; j++;
      }
      if (j < n) { out[j] = ' '; j++; }
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

// ---------- 2. 参数个数统计（按顶层逗号切） ----------
// 从 '(' 后一个字符开始，返回顶层逗号数量 -> arity
function arityAt(text, openParenIdx) {
  // 注意：绝不把 '<' '>' 当括号 —— Core 里大量 math.max(a < 0 ? 0 : a, b) 这类比较表达式
  let i = openParenIdx + 1;
  let depth = 0;
  let commas = 0;
  let any = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' && depth === 0) {
      return any ? commas + 1 : 0;
    } else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) commas++;
    if (!/\s/.test(c)) any = true;
    i++;
  }
  return -1;
}

// ---------- 3. 扫描 Core ----------
// 注意：不含 half —— 已核实 Core 里 427 次 "half" 全是局部变量名（half / half8），不是类型。
// 把它列进来只会产生 half.x / half.y 之类的假阳性。
const MATH_TYPES = ['float2', 'float3', 'float4', 'float2x2', 'float3x3', 'float4x4',
  'int2', 'int3', 'int4', 'uint2', 'uint3', 'uint4', 'double2', 'double3', 'double4',
  'bool2', 'bool3', 'bool4', 'quaternion', 'Random'];

const files = walk(CORE_DIR);
const mathCalls = new Map();       // name -> Map(arity -> count)
const mathIdents = new Map();      // name -> count   (math.X 非调用)
const memberAccess = new Map();    // `${type}.${member}` -> count
const ctorArities = new Map();     // `${type}#${arity}` -> count
const filesWithMath = new Set();

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const src = stripNoise(raw);

  // math.X(...)  或 math.X  /  Unity.Mathematics.math.X
  const re = /(?:Unity\s*\.\s*Mathematics\s*\.\s*)?\bmath\s*\.\s*([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const after = src.slice(re.lastIndex).match(/^\s*\(/);
    if (after) {
      const openIdx = re.lastIndex + after[0].length - 1;
      const a = arityAt(src, openIdx);
      if (!mathCalls.has(name)) mathCalls.set(name, new Map());
      const mm = mathCalls.get(name);
      mm.set(a, (mm.get(a) || 0) + 1);
    } else {
      mathIdents.set(name, (mathIdents.get(name) || 0) + 1);
    }
    filesWithMath.add(f);
  }

  // new T(...)
  const rec = new RegExp(`\\bnew\\s+(${MATH_TYPES.join('|')})\\s*\\(`, 'g');
  while ((m = rec.exec(src))) {
    const a = arityAt(src, rec.lastIndex - 1);
    const k = `${m[1]}#${a}`;
    ctorArities.set(k, (ctorArities.get(k) || 0) + 1);
  }

  // T.member  （静态字段/属性/方法/分量/swap）
  const rmem = new RegExp(`\\b(${MATH_TYPES.join('|')})\\s*\\.\\s*([A-Za-z_]\\w*)`, 'g');
  while ((m = rmem.exec(src))) {
    const k = `${m[1]}.${m[2]}`;
    memberAccess.set(k, (memberAccess.get(k) || 0) + 1);
  }
}

// ---------- 4. 解析兼容层 ----------
const shimRaw = readFileSync(SHIM, 'utf8');
const shim = stripNoise(shimRaw);

function blockOf(src, headerRe) {
  const m = headerRe.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index);
  if (i < 0) return null;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return { body: src.slice(start + 1, i), at: m.index }; }
  }
  return null;
}

// 解析一个类型体：返回 { 方法: Map(name->Set(arity)), 成员: Set(name), 运算符: Set(sig), 构造: Set(arity) }
function parseBody(body, typeName) {
  const methods = new Map();
  const members = new Set();
  const ops = new Set();
  const ctors = new Set();

  // 运算符
  const rop = /public\s+static\s+([\w\.<>\[\]]+)\s+operator\s*([^\s(]+)\s*\(/g;
  let m;
  while ((m = rop.exec(body))) ops.add(`${m[2]}/${arityAt(body, rop.lastIndex - 1)}`);

  // 构造函数：public TypeName(...)  —— 没有返回类型，必须单独认
  if (typeName) {
    const rc = new RegExp(`public\\s+${typeName}\\s*\\(`, 'g');
    while ((m = rc.exec(body))) ctors.add(arityAt(body, rc.lastIndex - 1));
  }

  // 方法：public [static] Ret Name(
  const rm = /public\s+(?:static\s+|readonly\s+|const\s+|override\s+|virtual\s+|extern\s+|new\s+)*[\w\.<>\[\],\?\s]+?\b([A-Za-z_]\w*)\s*\(/g;
  while ((m = rm.exec(body))) {
    const name = m[1];
    if (name === 'operator' || name === typeName) continue;
    const a = arityAt(body, rm.lastIndex - 1);
    if (!methods.has(name)) methods.set(name, new Set());
    methods.get(name).add(a);
  }

  // 字段 / 属性：public [static] [readonly] [const] Type Name ; 或 = 或 { 或 =>
  const rf = /public\s+(?:static\s+|readonly\s+|const\s+|new\s+|override\s+|virtual\s+)*[\w\.<>\[\],\?\s]+?\b([A-Za-z_]\w*)\s*(?:;|=|\{|=>)/g;
  while ((m = rf.exec(body))) members.add(m[1]);

  return { methods, members, ops, ctors };
}

const shimTypes = new Map();
const typeRe = /public\s+(?:readonly\s+)?(?:partial\s+)?(?:struct|class)\s+([A-Za-z_]\w*)/g;
let tm;
while ((tm = typeRe.exec(shim))) {
  const name = tm[1];
  const blk = blockOf(shim.slice(tm.index), /public\s+(?:readonly\s+)?(?:partial\s+)?(?:struct|class)\s+\w+/);
  if (!blk) continue;
  shimTypes.set(name, parseBody(blk.body, name));
}

// math 静态类
const mathBlk = blockOf(shim, /public\s+static\s+(?:partial\s+)?class\s+math\b/);
const shimMath = mathBlk ? parseBody(mathBlk.body, 'math') : { methods: new Map(), members: new Set(), ops: new Set(), ctors: new Set() };

// ---------- 5. Diff ----------
const report = { coreFiles: files.length, filesUsingMath: filesWithMath.size, missing: [], arityMismatch: [], missingIdent: [], missingMember: [], missingCtor: [], stats: {} };

for (const [name, arities] of [...mathCalls].sort((a, b) => total(b[1]) - total(a[1]))) {
  const decl = shimMath.methods.get(name);
  if (!decl) { report.missing.push({ name, arities: [...arities.keys()], count: total(arities) }); continue; }
  const bad = [...arities.keys()].filter(a => !decl.has(a));
  if (bad.length) report.arityMismatch.push({ name, used: bad, declared: [...decl].sort(), count: bad.reduce((s, a) => s + arities.get(a), 0) });
}
for (const [name, c] of [...mathIdents].sort((a, b) => b[1] - a[1])) {
  if (!shimMath.members.has(name) && !shimMath.methods.has(name)) report.missingIdent.push({ name, count: c });
}
for (const [k, c] of [...memberAccess].sort((a, b) => b[1] - a[1])) {
  const [t, mem] = k.split('.');
  const st = shimTypes.get(t);
  if (!st) { report.missingMember.push({ member: k, count: c, reason: `类型 ${t} 未定义` }); continue; }
  if (!st.members.has(mem) && !st.methods.has(mem)) report.missingMember.push({ member: k, count: c, reason: `成员未声明` });
}
for (const [k, c] of [...ctorArities].sort((a, b) => b[1] - a[1])) {
  const [t, a] = k.split('#');
  const st = shimTypes.get(t);
  if (!st) { report.missingCtor.push({ ctor: `${t}(${a} args)`, count: c, reason: `类型 ${t} 未定义` }); continue; }
  if (!st.ctors.has(Number(a))) {
    report.missingCtor.push({
      ctor: `${t}(${a} args)`,
      count: c,
      reason: `构造参数个数不符（已声明: ${st.ctors.size ? [...st.ctors].sort((x, y) => x - y).join(',') : '无'})`,
    });
  }
}

function total(mp) { let s = 0; for (const v of mp.values()) s += v; return s; }

report.stats = {
  mathCallNames: mathCalls.size,
  mathIdentNames: mathIdents.size,
  mathTypeMembers: memberAccess.size,
  shimMathMethods: shimMath.methods.size,
  shimTypes: [...shimTypes.keys()].join(','),
};

const lines = [];
lines.push('# Unity.Mathematics 兼容层静态核对');
lines.push('');
lines.push(`- Core .cs 文件：${report.coreFiles}，其中使用 math：${report.filesUsingMath}`);
lines.push(`- Core 用到 math 函数名：${report.stats.mathCallNames}；math 标识符：${report.stats.mathIdentNames}`);
lines.push(`- 兼容层 math 方法数：${report.stats.shimMathMethods}`);
lines.push('');
lines.push('## 1. 缺失的函数（编译器会报 CS0117）');
if (!report.missing.length) lines.push('无。');
for (const x of report.missing) lines.push(`- \`math.${x.name}\`  arity=[${x.arities}]  调用 ${x.count} 次`);
lines.push('');
lines.push('## 2. 参数个数不匹配（编译器会报 CS1501）');
if (!report.arityMismatch.length) lines.push('无。');
for (const x of report.arityMismatch) lines.push(`- \`math.${x.name}\`  用到的 arity=[${x.used}]  已声明 arity=[${x.declared}]  影响 ${x.count} 次`);
lines.push('');
lines.push('## 3. 缺失的标识符（math.CONST）');
if (!report.missingIdent.length) lines.push('无。');
for (const x of report.missingIdent) lines.push(`- \`math.${x.name}\`  ${x.count} 次`);
lines.push('');
lines.push('## 4. 缺失的类型成员（分量/静态属性）');
if (!report.missingMember.length) lines.push('无。');
for (const x of report.missingMember) lines.push(`- \`${x.member}\`  ${x.count} 次  (${x.reason})`);
lines.push('');
lines.push('## 5. 缺失的构造重载');
if (!report.missingCtor.length) lines.push('无。');
for (const x of report.missingCtor) lines.push(`- \`new ${x.ctor}\`  ${x.count} 次  (${x.reason})`);
lines.push('');
lines.push('## 附：Core 用到的全部 math 函数（按调用次数）');
for (const [n, a] of [...mathCalls].sort((x, y) => total(y[1]) - total(x[1]))) {
  lines.push(`- ${n}: ${total(a)}  arity=[${[...a.keys()].sort().join(',')}]`);
}

const outPath = resolve(ROOT, 'MATH_SURFACE_REPORT.md');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(lines.slice(0, 60).join('\n'));
console.log('\n>>> 完整报告: ' + outPath);
