// 兼容层自查：在跑编译器之前抓出「同一类型里签名单重复」这类必然报错（CS0111 / CS0102）。
// 用法：node tools/lint-shim.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'Compatibility', 'UnityMathematics.cs');
const src = readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

// 按顶层 {...} 切出每个类型体
const typeRe = /public\s+(?:readonly\s+)?(?:partial\s+)?(?:struct|class)\s+([A-Za-z_]\w*)/g;
const types = [];
let m;
while ((m = typeRe.exec(src))) {
  const name = m[1];
  const start = src.indexOf('{', m.index);
  if (start < 0) continue;
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) continue;
  types.push({ name, body: src.slice(start + 1, end), line: src.slice(0, m.index).split('\n').length });
}

function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim());
}

// 只保留参数类型，去掉名字与默认值
function paramType(p) {
  let t = p.replace(/=.*$/, '').trim();
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z_]\w*$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

const problems = [];
for (const t of types) {
  const sigs = new Map();
  const members = new Map();
  const bodyLines = t.body.split(/\r?\n/);
  bodyLines.forEach((ln, idx) => {
    // 方法 / 运算符 / 构造函数
    const mm = ln.match(/^\s*public\s+(?:static\s+|readonly\s+|const\s+|new\s+|override\s+|virtual\s+)*(?:[\w\.<>\[\],\?\s]+?\s+)?(operator\s*[^\s(]+|[A-Za-z_]\w*)\s*\(/);
    if (mm) {
      const open = ln.indexOf('(', mm.index + mm[0].length - 1);
      let depth = 0, close = -1;
      for (let i = open; i < ln.length; i++) {
        if (ln[i] === '(') depth++;
        else if (ln[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      const ps = close > 0 ? splitTop(ln.slice(open + 1, close)).map(paramType).join(',') : '??';
      const key = mm[1].replace(/\s+/g, '') + '(' + ps + ')';
      if (sigs.has(key)) problems.push(`  [重复签名] ${t.name}.${key}  (行 ${t.line + 1 + sigs.get(key)} 与 ${t.line + 1 + idx})`);
      else sigs.set(key, idx);
      return;
    }
    // 字段 / 属性
    const fm = ln.match(/^\s*public\s+(?:static\s+|readonly\s+|const\s+)*[\w\.<>\[\],\?\s]+?\s([A-Za-z_]\w*)\s*(?:;|=|\{|=>)/);
    if (fm) {
      const n = fm[1];
      if (members.has(n)) problems.push(`  [重复成员] ${t.name}.${n}  (行 ${t.line + 1 + members.get(n)} 与 ${t.line + 1 + idx})`);
      else members.set(n, idx);
    }
    // 索引器 this[int]
    if (/this\s*\[/.test(ln)) {
      if (members.has('this[]')) problems.push(`  [重复索引器] ${t.name}.this[]`);
      members.set('this[]', idx);
    }
  });
}

console.log('类型数:', types.length, '→', types.map(t => t.name).join(', '));
if (!problems.length) {
  console.log('未发现重复签名/重复成员。');
} else {
  console.log('发现 ' + problems.length + ' 处问题：');
  console.log(problems.join('\n'));
  process.exitCode = 1;
}
