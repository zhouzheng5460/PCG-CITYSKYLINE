// 「保留建筑 + 只铺地面」这条链路的体检。
//
// 跑：npx tsx test/bridge-obstacles.test.ts
//
// 背景：Placemaker 的地块规划默认是「整块换掉」，旧建筑跟着消失。要让它只铺地面、
// 把楼留着，就得把建筑轮廓当 `Obstacles` 传过去，Core 才会在 `SiteSafety.Apply`
// 里把压到地界的路/对象/铺装裁掉（placemaker-master/Core/Build/SiteSafety.cs）。
//
// 这里管三件事：
//   1) 轮廓 → 四边形的换算对不对（Core 只吃四条边，而体块有 4~7 个点）；
//   2) 烘焙出来的 Plan 有没有真的绕开建筑 —— 用**面积账**验，不靠看图：
//      铺装 + 建筑占地 ≈ 地块面积。如果障碍物没生效，铺装会盖在楼底下，
//      两项相加就会明显超过 100%；
//   3) 对象（树、车位、长椅…）有没有落在楼里。
//
// 也顺手钉死一条取舍：`--keep` 只在烘焙时决定，运行时不改。因为避让是**生成时**做的，
// 运行时把楼删掉，剩下的就是一堆围着空气的铺装。

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import { Model } from '../src/town/model';
import { ModernWard } from '../src/town/modern';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { buildingObstacles, buildingQuads, quadArea } from '../src/bridge/obstacles';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../src/bridge/data');

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ─────────────────────────────────────────────────────────── 1. 轮廓 → 四边形

{
  /** 世界单位（1 = 7 m）下的环，转成米。和 bake-plan 用的是同一套换算。 */
  const toM = (p: Pt): [number, number] => [p.x * UNIT_M, p.y * UNIT_M];
  const area = (r: Pt[]) => {
    let s = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2 * UNIT_M * UNIT_M;
  };

  // 4 点：原样一条，面积分毫不差（这是最常见的情况，133/254 栋）
  const rect = [new Pt(0, 0), new Pt(4, 0), new Pt(4, 3), new Pt(0, 3)];
  const q1 = buildingQuads(rect, toM);
  ok(q1.length === 1, '4 点轮廓 → 1 条四边形', String(q1.length));
  ok(near(quadArea(q1[0]), area(rect), 1e-6), '4 点轮廓面积不变', `${quadArea(q1[0]).toFixed(2)} vs ${area(rect).toFixed(2)}`);

  // 6 点 L 形：拆成几块，面积加起来必须还是原来的（拆多拆少都行，不能多也不能少）
  const lshape = [
    new Pt(0, 0), new Pt(6, 0), new Pt(6, 2), new Pt(2, 2), new Pt(2, 6), new Pt(0, 6),
  ];
  const q2 = buildingQuads(lshape, toM);
  const sum2 = q2.reduce((s, q) => s + quadArea(q), 0);
  ok(q2.length > 1, '6 点轮廓拆成多条', String(q2.length));
  ok(near(sum2, area(lshape), 0.5), '6 点轮廓面积守恒', `${sum2.toFixed(1)} vs ${area(lshape).toFixed(1)}`);

  // 每条四边形都得是四条边、面积为正 —— Core 的偏移算法不接受零长边
  for (const [i, q] of q2.entries()) {
    ok(q.length === 4, `L 形第 ${i} 块是四边形`, String(q.length));
    const distinct = new Set(q.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`)).size;
    ok(distinct === 4, `L 形第 ${i} 块四点互不重合`, String(distinct));
    ok(quadArea(q) > 0.01, `L 形第 ${i} 块面积为正`, quadArea(q).toFixed(3));
  }

  // 三角形的第四点落在 a-c 边上，不能把形状撑出去
  const tri = [new Pt(0, 0), new Pt(5, 0), new Pt(0, 5)];
  const q3 = buildingQuads(tri, toM);
  ok(q3.length === 1, '三角形 → 1 条四边形', String(q3.length));
  ok(near(quadArea(q3[0]), area(tri), 1e-6), '三角形面积不变', `${quadArea(q3[0]).toFixed(1)} vs ${area(tri).toFixed(1)}`);

  // 太小的体块不值得避让（Core 那边也会丢 0.5 m² 以下的）。
  // 0.1 世界单位 = 0.7 m，三角约 0.25 m²，低于 2 m² 的门槛。
  const tiny = [{ ring: [new Pt(0, 0), new Pt(0.1, 0), new Pt(0.1, 0.1)] }];
  ok(buildingObstacles(tiny, toM).length === 0, '小体块被过滤', `${buildingObstacles(tiny, toM).length} 条`);

  // 换算：同一个环，给不同的 toM 应该整条跟着平移
  const shift = (p: Pt): [number, number] => [p.x * UNIT_M + 100, p.y * UNIT_M + 50];
  const q4 = buildingQuads(rect, shift);
  ok(q4.length === 1 && near(quadArea(q4[0]), quadArea(q1[0]), 1e-6), '平移不改变面积', quadArea(q4[0]).toFixed(2));
  ok(q4[0][0][0] - q1[0][0][0] === 100 && q4[0][0][1] - q1[0][0][1] === 50, '平移量原样进坐标');
}

// ─────────────────────────────────────────────────────────── 2. 烘焙件的面积账

interface Meta {
  name: string;
  generator: string;
  patch: number;
  nPatches: number;
  citySeed: number;
  layout: 'grid' | 'field' | 'radial' | 'tensor';
  areaM2: number;
  keepBuildings?: boolean;
  obstacles?: number;
  buildings?: number;
}

const metas = readdirSync(dataDir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as Meta)
  .sort((a, b) => a.name.localeCompare(b.name));

const keepMetas = metas.filter((m) => m.keepBuildings);
ok(keepMetas.length > 0, '至少有一份 --keep 的烘焙件', `共 ${metas.length} 份`);

/** 点在环内（射线法）。只用来验"对象有没有落在楼里"。 */
function inside(p: [number, number], ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p[1]) !== (b.y > p[1]) && p[0] < ((b.x - a.x) * (p[1] - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** 两个多边形相交的面积（m²）。polygon-clipping 的输入是 [[ring]] 这种嵌套。 */
function overlap(a: [number, number][], b: [number, number][]): number {
  try {
    const out = polygonClipping.intersection([a as never], [b as never]);
    let s = 0;
    for (const poly of out) for (const ring of poly) s += quadArea(ring as never);
    return s;
  } catch {
    return 0;   // 退化输入当作不重叠（Core 也是这么容忍的）
  }
}

const rows: { gen: string; paved: number; bld: number; overlap: number; inside: number; objects: number }[] = [];

for (const meta of keepMetas) {
  const plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as {
    surfaces: { ring: [number, number][] }[];
    objects: { x: number; z: number; role: string }[];
    paint?: { layer: number; strength: number; ring: [number, number][] }[];
  };

  /**
   * 这块地的地面是**刷出来的泥土**（`paint` 通道大面积、高强度），还是**铺装**。
   *
   * 关系到下面那条覆盖率的门槛：堆场（`carYard`）的场地本来就是泥地，
   * 铺装只占 8%，剩下的是刷出来的土层 —— 拿"铺装必须填满"去要求它，等于要求
   * 一个泥土停车场铺上沥青。判定口径和 `bridge/placemaker.ts` 的
   * `groundMatFromPaint()` 一致：单块 ≥ 地块 20% 且强度 ≥ 0.8。
   */
  const dirtGround = (plan.paint ?? []).some((q) => {
    if (q.strength < 0.8) return false;
    let t = 0;
    for (let i = 0; i < q.ring.length; i++) { const a = q.ring[i], b = q.ring[(i + 1) % q.ring.length]; t += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(t) / 2 >= meta.areaM2 * 0.2;
  });

  // 复算烘焙时用的那一套坐标：地块环的最小角为原点，乘 UNIT_M。
  const model = new Model({ nPatches: meta.nPatches, seed: meta.citySeed, layout: meta.layout });
  model.generate();
  const ward = model.patches[meta.patch]?.ward;
  ok(ward instanceof ModernWard, `${meta.generator}: patch ${meta.patch} 还是 ModernWard`);
  const block = ward instanceof ModernWard ? Array.from(ward.getCityBlock()) : [];
  const solids = ward instanceof ModernWard ? ward.lot?.solids ?? [] : [];
  ok(block.length >= 3, `${meta.generator}: 地块环有效`, String(block.length));
  ok(solids.length > 0, `${meta.generator}: 该地块确实有建筑`, String(solids.length));

  const minX = Math.min(...block.map((p) => p.x));
  const minY = Math.min(...block.map((p) => p.y));
  const toM = (p: Pt): [number, number] => [p.x - minX, p.y - minY].map((v) => Math.round(v * UNIT_M * 1000) / 1000) as [number, number];

  const quads = buildingObstacles(solids, toM);
  ok(
    quads.length === meta.obstacles,
    `${meta.generator}: meta.obstacles 与重算一致`,
    `${meta.obstacles} vs ${quads.length}`,
  );

  // 面积账：铺装 + 建筑 ≈ 地块。铺装要是盖在楼底下，两项相加会明显超 100%
  const paved = plan.surfaces.reduce((s, x) => s + quadArea(x.ring), 0);
  const bld = solids.reduce((s, x) => {
    let t = 0;
    for (let i = 0; i < x.ring.length; i++) { const a = x.ring[i], b = x.ring[(i + 1) % x.ring.length]; t += a.x * b.y - b.x * a.y; }
    return s + Math.abs(t) / 2;
  }, 0) * UNIT_M * UNIT_M;

  // 逐块查重叠：任何一块铺装都不许压进建筑
  let worst = 0;
  for (const s of plan.surfaces) for (const q of quads) worst = Math.max(worst, overlap(s.ring, q.quad));
  ok(worst < 1, `${meta.generator}: 铺装不压建筑`, `最大重叠 ${worst.toFixed(2)} m²`);

  // 对象也不许落在楼里
  const bad = plan.objects.filter((o) => solids.some((s) => inside([o.x, o.z], s.ring)));
  ok(bad.length === 0, `${meta.generator}: 没有对象落在建筑里`, bad.slice(0, 4).map((o) => o.role).join(','));

  const covered = (paved + bld) / meta.areaM2;
  // 铺装型（plaza / parking）：铺装 + 建筑要几乎填满地块。
  // 泥土型（堆场）：铺装只占少数，地面是 paint 刷出来的泥土，门槛按"地确实被用起来了"给。
  const lo = dirtGround ? 0.4 : 0.85;
  ok(
    covered > lo && covered < 1.02,
    `${meta.generator}: 铺装${dirtGround ? '（泥地场地，铺装只占少数）' : ''} + 建筑几乎填满地块`,
    `${(covered * 100).toFixed(0)}%（铺装 ${(paved / meta.areaM2 * 100).toFixed(0)}% + 建筑 ${(bld / meta.areaM2 * 100).toFixed(0)}%，门槛 ${(lo * 100).toFixed(0)}%）`,
  );

  rows.push({ gen: `${meta.generator} (p${meta.patch})`, paved, bld, overlap: worst, inside: bad.length, objects: plan.objects.length });
}

// ─────────────────────────────────────────────────────────── 3. 报告

console.log('=== 保留建筑 + 只铺地面 ===');
for (const r of rows) {
  console.log(
    r.gen.padEnd(20),
    '铺装', String(Math.round(r.paved)).padStart(6), 'm²',
    '建筑', String(Math.round(r.bld)).padStart(6), 'm²',
    '重叠', r.overlap.toFixed(2).padStart(6), 'm²',
    '楼内对象', String(r.inside).padStart(2),
    '| 对象合计', String(r.objects).padStart(4),
  );
}

if (fails.length) {
  console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log(`\n断言 ${pass} 通过 / 0 失败`);
console.log('全部通过。');
