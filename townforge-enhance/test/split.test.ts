// 地块切碎的测试：`splitLot` 是"让路网型生成器别面对楼"的关键一步。
//
// 跑：npx tsx test/split.test.ts
//
// 要守住的三件事：
//   1) 切出来的每一块都是**简单多边形**（无洞）—— 带洞的环 Placemaker 的 shape 吃不下；
//   2) 每块都不含建筑（否则等于没切，SiteSafety 还是会删车道）；
//   3) 保留下来的总面积接近"地块减去建筑"，别把好地也一起丢了。

import { splitLot, partsArea } from '../src/bridge/split';
import { unionArea } from '../src/bridge/area';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

type R = [number, number][];
const rect = (x0: number, y0: number, w: number, h: number): R =>
  [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];

/** 每个环必须至少 3 点、面积为正、且首尾不重合（feeding shape 的前置条件）。 */
function isSimpleish(r: R): boolean {
  if (r.length < 3) return false;
  const first = r[0], last = r[r.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) return false;
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(s) / 2 > 0;
}

// ─────────────────────────────────────────────────────────── 1. 空地：全保留

{
  const lot = rect(0, 0, 120, 120);
  const r = splitLot(lot, [], { gridSize: 40, minAreaM2: 100 });
  ok(r.parts.length === 9, '120×120 按 40 切 → 9 块', `${r.parts.length} 块`);
  ok(near(partsArea(r.parts), 14400), '面积总和 = 地块面积', partsArea(r.parts).toFixed(1));
  ok(r.parts.every(isSimpleish), '每块都是简单多边形');
  ok(r.uncuttable === 0, '无建筑时不丢块');
}

// ─────────────────────────────────────────────────────────── 2. 中间一栋楼：挖掉楼、保住周围的边

{
  const lot = rect(0, 0, 120, 120);
  const bld = [rect(45, 45, 30, 30)];   // 900 m²，落在正中那格里
  const r = splitLot(lot, bld, { gridSize: 40, minAreaM2: 60 });
  ok(r.parts.length > 8, '中间有楼 → 靠递归细分多切出几块', `${r.parts.length} 块`);
  ok(r.parts.every(isSimpleish), '每块都是简单多边形（无洞、无重复点）');

  // 关键断言：保留块 + 楼拼起来必须还原整块地 —— 说明没漏切、也没重叠
  const u = unionArea([...r.parts, ...bld]);
  ok(near(u.area, 14400, 30), '保留块 + 建筑 = 原地块', u.area.toFixed(1));

  // 楼边上的地保住了：只丢了楼本身那份（900），不是整格（1600）
  ok(partsArea(r.parts) > 14400 - 1000, '只损失建筑本身，没有整格牺牲',
    `${partsArea(r.parts).toFixed(0)} m²`);
}

// ─────────────────────────────────────────────────────────── 3. 楼压边、跨格

{
  const lot = rect(0, 0, 120, 120);
  const bld = [rect(38, 50, 20, 20)];   // 跨在 x=40 那条格线上
  const r = splitLot(lot, bld, { gridSize: 40, minAreaM2: 60 });
  const u = unionArea([...r.parts, ...bld]);
  ok(near(u.area, 14400, 30), '跨格的楼：保留块与楼拼起来仍等于整块地', u.area.toFixed(1));
  ok(r.parts.every(isSimpleish), '跨格情形下每块仍是简单多边形');
}

// ─────────────────────────────────────────────────────────── 4. 小碎块被过滤

{
  const lot = rect(0, 0, 100, 100);
  const bld = [rect(20, 20, 60, 60)];   // 只留周边一圈，每格 < minArea 时该丢
  const r = splitLot(lot, bld, { gridSize: 25, minAreaM2: 300 });
  // 楼 60×60 盖住中间，剩下的只有 20 m 宽的边带；切成 25 格时边带会被再切
  ok(partsArea(r.parts) < 10000 - 3600 + 1, '只剩边带时保留面积不超过"地块 − 楼"',
    `${partsArea(r.parts).toFixed(0)} m²`);
  ok(r.parts.every(isSimpleish), '细边带仍是简单多边形');
  const loose = splitLot(lot, bld, { gridSize: 25, minAreaM2: 10 });
  ok(loose.uncuttable >= r.uncuttable, '放宽 minArea 不会让"切不动"的块变少',
    `${r.uncuttable} → ${loose.uncuttable}`);
}

// ─────────────────────────────────────────────────────────── 5. 边界情形

{
  ok(splitLot([], []).parts.length === 0, '空地块 → 0 块');
  ok(splitLot(rect(0, 0, 10, 10), [], { gridSize: 40, minAreaM2: 500 }).parts.length === 0,
    '地块比 minArea 还小 → 0 块');
  const full = splitLot(rect(0, 0, 80, 80), [rect(0, 0, 80, 80)], { gridSize: 40, minAreaM2: 10 });
  ok(full.parts.length === 0, '整块被楼盖满 → 0 块', `${full.parts.length} 块`);
}

// ─────────────────────────────────────────────────────────── 6. 顺序稳定（可复现）

{
  const lot = rect(0, 0, 150, 90);
  const bld = [rect(30, 30, 40, 30)];
  const a = splitLot(lot, bld, { gridSize: 35, minAreaM2: 120 });
  const b = splitLot(lot, bld, { gridSize: 35, minAreaM2: 120 });
  ok(a.parts.length === b.parts.length, '两次切分块数一致');
  ok(JSON.stringify(a.parts) === JSON.stringify(b.parts), '两次切分结果逐点一致（可复现）');
  const areas = a.parts.map((p) => partsArea([p]));
  ok(areas.every((v, i) => i === 0 || areas[i - 1] >= v), '按面积降序');
}

console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log('全部通过。');
