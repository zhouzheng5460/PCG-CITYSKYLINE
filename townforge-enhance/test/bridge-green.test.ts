// 绿地一族（park / campground / pond / 花园 / 球场…）过桥后的体检。
//
// 跑：npx tsx test/bridge-green.test.ts
//
// 和 placemaker.test.ts 的分工：那个用 parking 打尺度、方向、车位重塑这些"硬指标"；
// 这个扫全部已烘的绿地生成器，管的是**批量**才会暴露的问题：
//
//   1) 有没有生成器桥出坏面（自交 / 点数不足）—— 一份 Plan 手画得出来，二十份就不一定；
//   2) 草地底是不是都补上了 —— Placemaker 管"往上画"，地面是地形，
//      park / greenwayPark / picnicGrounds / natureReserve 的 surfaces 干脆是空的；
//   3) 道具会不会跑到地块外面去（换算 + 原点偏移的经典翻车点）；
//   4) polish* 一族到底能不能单用 —— 结论是不能，这里把它钉成"已知限制"，
//      哪天 Core 变了、它们开始出东西了，这条断言会炸出来提醒重新评估。
//
// 不做 GLB（那要建城，慢），几何合法性和面数统计在联系表里看。

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { bridgePlan } from '../src/bridge/placemaker';
import type { PlacemakerPlan } from '../src/bridge/placemaker';
import { buildProp } from '../src/export/props';
import { PROP_STYLE, propDraw } from '../src/scene/propStyle';
import { fitHedgeBars } from '../src/bridge/hedge';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../src/bridge/data');

interface Meta {
  name: string;
  generator: string;
  origin: [number, number];
  areaM2: number;
  lotRing: [number, number][];
}

const metas = readdirSync(dataDir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as Meta)
  .sort((a, b) => a.generator.localeCompare(b.generator));

if (metas.length === 0) {
  console.error('[bridge-green] 没有烘焙数据，先跑 npx tsx tools/bake-plan.ts --patch 42 --gens ...');
  process.exit(2);
}

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

/** 允许作为地块底色的材质（paint 通道能把草地刷成泥土/沙，见 bridge/placemaker.ts）。 */
const GROUND_MATS = ['grass', 'soil', 'gravel', 'grassDark'];

function isSimple(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const seg = (i: number): [Pt, Pt] => [ring[i], ring[(i + 1) % n]];
  const cross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
    const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b] = seg(i), [c, d] = seg(j);
      if (cross(a, b, c, d)) return false;
    }
  }
  return true;
}

/** 环的有向面积（世界单位²）。桥接统一输出 CCW，所以必须为正。 */
function area2(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

const rows: { gen: string; surf: number; props: number; paths: number; tris: number }[] = [];
const polish: Meta[] = [];

for (const meta of metas) {
  const plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as PlacemakerPlan;
  const origin = new Pt(meta.origin[0], meta.origin[1]);
  const res = bridgePlan(plan, { origin, group: 'pm', lotRing: meta.lotRing });
  const g = plan.generator;

  // ── 草地底 ────────────────────────────────────────────────
  const base = res.surfaces[0];
  ok(base?.group === 'pm/surface/ground', `[${g}] 第一层是草地底`, String(base?.group));
  // 底色可以是草，也可以是 paint 通道指定的大面积地表（堆场刷了泥土 → soil）。
  // 这里钉住的是"它有且只有一个底色"，不是"必须是草"。
  ok(GROUND_MATS.includes(base?.mat), `[${g}] 底色是草或泥土/沙`, String(base?.mat));
  const baseArea = Math.abs(area2(base.ring)) * UNIT_M * UNIT_M;
  ok(Math.abs(baseArea - plan.area) <= plan.area * 0.01,
    `[${g}] 草地面积 = 地块面积`, `${baseArea.toFixed(0)} vs ${plan.area.toFixed(0)} m²`);
  ok(res.surfaces.slice(1).every((s) => s.y > base.y), `[${g}] 草地压在所有铺装之下`);

  // ── 几何 ──────────────────────────────────────────────────
  ok(res.dropped === 0, `[${g}] 没有被丢弃的面`, `dropped=${res.dropped}`);

  let nonSimple = 0, cw = 0;
  for (const s of res.surfaces) {
    if (!isSimple(s.ring)) nonSimple++;
    if (area2(s.ring) <= 0) cw++;
  }
  ok(nonSimple === 0, `[${g}] 所有面都是简单环`, `${nonSimple}/${res.surfaces.length}`);
  ok(cw === 0, `[${g}] 所有面都逆时针`, `${cw}/${res.surfaces.length}`);

  let badPath = 0;
  for (const p of res.paths) if (p.pts.length < 2 || !(p.width > 0)) badPath++;
  ok(badPath === 0, `[${g}] 通道都有 2 点以上且宽度为正`, `${badPath}/${res.paths.length}`);

  // ── 道具落在地块内 ────────────────────────────────────────
  // 放宽 1.5 m：树冠有半径，靠边那几棵的中心点本身就在环上。
  const xs = meta.lotRing.map((p) => p[0]);
  const zs = meta.lotRing.map((p) => p[1]);
  const lo = new Pt(origin.x + Math.min(...xs) / UNIT_M - 1.5, origin.y + Math.min(...zs) / UNIT_M - 1.5);
  const hi = new Pt(origin.x + Math.max(...xs) / UNIT_M + 1.5, origin.y + Math.max(...zs) / UNIT_M + 1.5);
  const outside = res.props.filter((p) => p.at.x < lo.x || p.at.x > hi.x || p.at.y < lo.y || p.at.y > hi.y);
  ok(outside.length === 0, `[${g}] 道具都落在地块内`, `${outside.length} 个在外`);

  // ── 映射不丢东西 ──────────────────────────────────────────
  // 不写死"必须有几个"，只要求对象少的生成器也真的出了道具（park 至少该有树）。
  if (plan.objects.length > 20) {
    ok(res.props.length > 0, `[${g}] 有对象就出道具`, `${res.props.length}`);
  }
  ok(res.props.length <= plan.objects.length, `[${g}] 道具数不超过对象数`);

  rows.push({
    gen: g,
    surf: res.surfaces.length,
    props: res.props.length,
    paths: res.paths.length,
    tris: res.surfaces.length * 2, // 粗略：一块地铺 20 边形 ≈ 20 个三角形，这里只做量级对比
  });

  if (g.startsWith('polish')) polish.push(meta);
}

// ─────────────────────────────────────────────────────────── polish* 的已知限制

ok(polish.length > 0, '烘过 polish* 一族', String(polish.length));
for (const meta of polish) {
  const plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as PlacemakerPlan;
  const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
  ok(plan.surfaces.length === 0 && plan.objects.length === 0 && plan.nets.length === 0,
    `[${plan.generator}] 单独用不出内容（只会剩草地底）`,
    `surf=${plan.surfaces.length} net=${plan.nets.length} obj=${plan.objects.length}`);
  ok(res.surfaces.length === 1, `[${plan.generator}] 过桥后只有草地底`, String(res.surfaces.length));
}

// ─────────────────────────────────────────────────────────── 样式兼容（道具种类）

// 这一段管的是"接进来之后长得对不对"，不是"几何合不合法"：
// Placemaker 只给 `tree` / `bush` 两个粗糙的角色，落到 TownForge 的道具库上得挑对种类。
// 第一版把 bush 映射成 treeSmall（4.3 m 的小针叶树），结果花园里 197 丛绿篱变成一排松树苗。
{
  const kindsOf = new Set<string>();
  let bushPlans = 0, shrubOk = 0, treePlans = 0, mixOk = 0;
  let hedgePlans = 0, hedgeBars = 0;

  for (const meta of metas) {
    const plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as PlacemakerPlan;
    const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
    for (const p of res.props) kindsOf.add(p.kind);

    // 每颗 bush 都得有归宿：要么自己画成 `shrub`，要么被并进某段绿篱。
    // 成排的那批（同一条线共用 yaw）连成段，随手撒的留散点 —— 规则见 bridge/hedge.ts。
    const bushes = plan.objects.filter((o) => o.role === 'bush');
    const nShrub = bushes.length;
    if (nShrub > 0) {
      bushPlans++;
      const absorbed = fitHedgeBars(bushes).inRun.filter(Boolean).length;
      const got = res.props.filter((p) => p.kind === 'shrub').length;
      if (got + absorbed === nShrub) shrubOk++;
    }
    const bars = res.props.filter((p) => p.kind === 'hedge');
    if (bars.length > 0) { hedgePlans++; hedgeBars += bars.length; }
    // 绿篱段必须有真实长度，否则 3D 里是一个看不见的退化盒子
    ok(bars.every((b) => (b.len ?? 0) > 0.5),
      `[${plan.generator}] 绿篱段都有长度`, bars.map((b) => (b.len ?? 0).toFixed(2)).join(','));

    const nTree = plan.objects.filter((o) => o.role === 'tree').length;
    if (nTree >= 10) {
      treePlans++;
      const round = res.props.filter((p) => p.kind === 'treeRound').length;
      const conifer = res.props.filter((p) => p.kind === 'conifer').length;
      // 默认 1/3 针叶；两种都要有，全是一种就等于没做混种
      if (round > 0 && conifer > 0 && round + conifer === nTree && Math.abs(conifer - nTree / 3) <= nTree / 3) mixOk++;
    }
  }

  ok(bushPlans > 0 && shrubOk === bushPlans, '每颗 bush 都有归宿（shrub 或绿篱段）', `${shrubOk}/${bushPlans}`);
  // 只有"整条线共用 yaw"的生成器才该出绿篱。实测只有 formalGarden 是这样，
  // 一旦别的生成器开始出绿篱，说明判据被放松了，假阳性要复查（比如 natureReserve 变出一片假绿篱）。
  ok(hedgePlans > 0 && hedgeBars >= 20, '有成排布置的生成器接出了绿篱', `${hedgePlans} 个生成器 / ${hedgeBars} 段`);
  ok(hedgePlans <= 2, '绿篱只在少数"刻意排布"的生成器上出现', `${hedgePlans} 个`);
  ok(treePlans > 0 && mixOk === treePlans, 'tree 混成阔叶 + 针叶，比例约 2:1', `${mixOk}/${treePlans}`);
  ok(!kindsOf.has('treeSmall'), '桥接不再产出 treeSmall（那是"小树"，不是灌木）', [...kindsOf].join(','));

  // 每一种道具都得在样式表里有位置，否则 2D 两个渲染器会各画各的、或者干脆不画。
  // 长椅/垃圾桶/护柱这类在整城视图里只有 1~2 px，样式表里本来就标了 r=0（画了只是噪点），
  // 所以它们不算"漏画"；除此之外的种类必须可见。
  const SMALL_2D = ['bench', 'bin', 'bollard', 'sign', 'shelter', 'car', 'flagpole'];
  const invisible = [...kindsOf].filter((k) => {
    if (SMALL_2D.includes(k)) return false;
    const s = PROP_STYLE[k as keyof typeof PROP_STYLE];
    return !s || (s.r <= 0 && s.shape !== 'bar');
  });
  ok(invisible.length === 0, '除已知小件外，道具在 2D 都可见', invisible.join(','));
  for (const k of ['treeRound', 'shrub', 'planter', 'lamp', 'hedge']) {
    ok(kindsOf.has(k), `有 ${k}`, [...kindsOf].join(','));
  }

  // 2D 的"画什么"只有一个判断点（`propDraw`）。这里钉住最容易被改坏的那个分支：
  // `hedge` 的 r 是 0（没半径、只有长度），曾经被 `r <= 0` 提前跳过 ——
  // 结果绿篱在 3D 里有、在编辑器和导出的 SVG 里都没有。
  const hedgeDraw = propDraw({ kind: 'hedge', scale: 1, len: 12.4 });
  ok(hedgeDraw?.shape === 'bar', '绿篱在 2D 画成条（不是被 r=0 吞掉）', JSON.stringify(hedgeDraw));
  ok(hedgeDraw?.shape === 'bar' && Math.abs(hedgeDraw.len - 12.4) < 1e-9, '绿篱用实例给的 12.4 m 长度');
  const hedgeDefault = propDraw({ kind: 'hedge', scale: 2 });
  ok(hedgeDefault?.shape === 'bar' && Math.abs(hedgeDefault.len - 1.2) < 1e-9,
    '没给长度时退回样式表默认值 × 缩放', JSON.stringify(hedgeDefault));
  ok(propDraw({ kind: 'tree', scale: 1 })?.shape === 'dot', '树在 2D 画成点');
  ok(propDraw({ kind: 'bench', scale: 1 }) === null, '长椅在 2D 不画（整城视图里只有 1 px）');

  // 几何：灌木必须是"矮一截"，不是缩小版的树
  const mk = (kind: 'shrub' | 'treeRound' | 'tree', i: number) => ({
    name: kind, group: `t/${kind}`, kind, at: new Pt(3, 4), rot: 0, scale: 1, seed: i,
  });
  const topOf = (prims: { positions: number[] }[]) =>
    Math.max(...prims.flatMap((p) => p.positions.filter((_, k) => k % 3 === 1)));
  const shrubH = topOf(buildProp(mk('shrub', 1)));
  const roundH = topOf(buildProp(mk('treeRound', 1)));
  const treeH = topOf(buildProp(mk('tree', 1)));
  ok(shrubH < 0.3, '灌木不到 0.3 世界单位高（≈2 m）', shrubH.toFixed(2));
  ok(roundH > shrubH * 3, '阔叶树比灌木高 3 倍以上', `${roundH.toFixed(2)} vs ${shrubH.toFixed(2)}`);
  ok(Math.abs(roundH - treeH) < 0.3, '阔叶树和原有树总高接近（只是冠形不同）', `${roundH.toFixed(2)} vs ${treeH.toFixed(2)}`);
  ok(buildProp(mk('shrub', 3)).length >= 2, '灌木是两丛拼的，不是单个锥');
}

// ─────────────────────────────────────────────────────────── 报告

console.log('=== 绿地一族过桥体检 ===');
console.log('生成器'.padEnd(18), '面', '道具', '通路', '  ');
for (const r of rows) {
  console.log(r.gen.padEnd(22), String(r.surf).padStart(4), String(r.props).padStart(5), String(r.paths).padStart(5));
}

const emptyGround = rows.filter((r) => r.surf === 1).map((r) => r.gen);
if (emptyGround.length) console.log(`\n只有草地底（生成器本身不画东西）：${emptyGround.join(', ')}`);

if (fails.length) {
  console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log(`\n断言 ${pass} 通过 / 0 失败`);
console.log('全部通过。');
