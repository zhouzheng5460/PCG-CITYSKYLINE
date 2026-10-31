// terraform 通道的体检：台地/料堆必须是**有体积的台体**，不是贴地面的薄板。
//
// 跑：npx tsx test/bridge-terrain.test.ts
// 前置：npx tsx tools/bake-plan.ts --patch 42 --gens carYard,junkYard,scrapyard,pond
//
// 为什么单列一个文件：这条通道以前整类被当成"铺一层土色面"，三个后果 —
//
//   1) 2.6 m 高的垃圾堆和 0.3 m 高的格子长得一模一样（都只是一块平地）；
//   2) 65 块薄板按 0.2 mm 步长叠在同一条地上，深度缓冲上是必然的 z-fighting；
//   3) 摆在这些堆上的箱子/油桶还站在 y≈0，堆一抬起来就全埋进土里。
//
// 所以这里钉的是：**高度从哪儿来**（`target`，不是顶点高度 —— 顶点全是 0）、
// **道具跟着抬**、以及几个只有合成数据才能覆盖的边界（全零 hs、真坡度、太矮）。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pt } from '../src/core/geom';
import { bridgePlan, type PlacemakerPlan } from '../src/bridge/placemaker';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../src/bridge/data');

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

interface Meta { name: string; generator: string; origin: [number, number]; lotRing: [number, number][] }

function load(gen: string): { plan: PlacemakerPlan; meta: Meta } {
  const meta = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.meta.json`), 'utf8')) as Meta;
  const plan = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.plan.json`), 'utf8')) as PlacemakerPlan;
  return { plan, meta };
}

function run(gen: string, extra: Record<string, unknown> = {}) {
  const { plan, meta } = load(gen);
  return {
    plan,
    res: bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing, ...extra }),
  };
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * 点是否**够得着**这个环（里面有，或离边不到 `slack`）。
 *
 * 桥接是按"中心 + 半径 0.5 m 的四个探针"取最高的那格的，所以一件压在格子
 * 边界外一点的料也会被抬起来 —— 这不是 bug，是刻意的（见 `moundTopAt` 注释：
 * 宁可微微悬空，也不要被邻居的墙面劈开）。断言照着这个口径写。
 */
function nearRing(p: Pt, ring: Pt[], slack: number): boolean {
  if (inRing(p, ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= slack) return true;
  }
  return false;
}

// ─────────────────────────────────────────────── 1) 真实烘焙件

const YARDS = ['carYard', 'junkYard', 'scrapyard'];

for (const gen of YARDS) {
  const { plan, res } = run(gen);
  const raises = (plan.terraform ?? []).filter((t) => t.kind === 'raise');
  const maxTarget = Math.max(...raises.map((t) => t.target));

  ok(res.mounds.length === raises.length, `[${gen}] 每个 raise 环都成了台体`, `${res.mounds.length} / ${raises.length}`);
  ok(res.mounds.length > 0, `[${gen}] 有台体`, `${res.mounds.length}`);
  // 这一条是整轮的关键：以前这些环是 `surfaces` 里的土色薄板
  ok(
    res.surfaces.every((s) => !s.group.includes('terraform/raise')),
    `[${gen}] 抬起来的环不再出现在面里`,
    res.surfaces.filter((s) => s.group.includes('terraform/raise')).length + ' 块残留',
  );
  ok(
    Math.abs(res.terrain.maxH - maxTarget) < 0.02,
    `[${gen}] 最高台地等于最高的 target`,
    `${res.terrain.maxH.toFixed(2)} m vs ${maxTarget.toFixed(2)} m`,
  );
  ok(res.mounds.every((m) => m.hs.length === m.ring.length), `[${gen}] hs 与 ring 一一对应`);
  ok(res.mounds.every((m) => m.hs.every((h) => h > 0)), `[${gen}] 没有零高度的台体`);

  // 道具必须跟着抬，否则全埋在土里。
  // 只统计抬过 15 cm 的：Core 会给一些贴地件的 `y` 是 0.008~0.1 这种零头，
  // 那是"站在地面上"的微调，不该拿台地的口径去要求它。
  const lifted = res.props.filter((p) => (p.baseY ?? 0) * 7 > 0.15);
  ok(lifted.length > 0, `[${gen}] 有道具被抬到堆顶`, `${lifted.length} / ${res.props.length}`);
  // 反向：抬高的道具脚下必须真的有一块台地。
  // 门槛取 0.3 m：Core 还会给一批贴地件 0.17~0.20 m 的 `y`（地形跟随的零头，
  // 离最近的台地几米远），那是地面本身的起伏，不该拿台地的口径去要求它。
  const high = lifted.filter((p) => (p.baseY ?? 0) * 7 > 0.3);
  const floating = high.filter((p) => !res.mounds.some((m) => nearRing(p.at, m.ring, 0.5 * (1 / 7) + 1e-9)));
  ok(floating.length === 0, `[${gen}] 抬高的道具都踩在台地上`, `${floating.length} 件悬空`);
  ok(high.length > 0, `[${gen}] 有道具抬到 0.3 m 以上（真的站在堆上）`, `${high.length}`);
  // 抬起来的高度不能超过最高台地（说明没乱加）
  // baseY 比台顶再抬 0.002 世界单位（约 1.4 cm）以免与顶面共面，容差要给到
  const tooHigh = lifted.filter((p) => (p.baseY ?? 0) > res.terrain.maxH * (1 / 7) + 0.01);
  ok(tooHigh.length === 0, `[${gen}] 抬升高度不超过最高台地`, `${tooHigh.length} 件越界`);
}

// carYard 的最高料堆 2.6 m —— 写死一个数，防止哪天变成 0（全零 hs 那个坑）
{
  const { res } = run('carYard');
  ok(Math.abs(res.terrain.maxH - 2.6) < 0.05, '[carYard] 最高料堆仍是 2.6 m', res.terrain.maxH.toFixed(2));
}

// ─────────────────────────────────────────────── 2) 下挖：有水面就不补

{
  const { plan, res } = run('pond');
  const lowers = (plan.terraform ?? []).filter((t) => t.kind === 'lower');
  ok(lowers.length > 0, '[pond] 原始数据里确实有 lower 环', `${lowers.length}`);
  ok(res.terrain.lowered === 0, '[pond] 已有水面时不补下挖水面', `${res.terrain.lowered}`);
  ok(
    res.surfaces.every((s) => !s.group.includes('terraform/lower')),
    '[pond] 没有多余的 lower 面',
  );
  ok(res.mounds.length === 1, '[pond] 岛子的 raise 成了台体', `${res.mounds.length}`);
  ok(res.surfaces.some((s) => s.mat === 'water'), '[pond] 水面还在');
}

// ─────────────────────────────────────────────── 3) 开关与门槛

{
  const { res } = run('carYard', { terraform: false });
  ok(res.mounds.length === 0, '[terraform:false] 不出台体', `${res.mounds.length}`);
  ok(res.props.every((p) => p.baseY === undefined), '[terraform:false] 道具也不抬');
}

{
  const { res } = run('carYard', { minMoundHeight: 99 });
  ok(res.mounds.length === 0, '[minMoundHeight] 门槛能一刀切掉', `${res.mounds.length}`);
  ok(res.terrain.skipped > 0, '[minMoundHeight] 被切掉的会计数', `${res.terrain.skipped}`);
}

// ─────────────────────────────────────────────── 4) 合成数据：只有这些边界才覆盖得到

/** 一块 20×20 m 的地，只放指定的 terraform 环。 */
function synth(terraform: PlacemakerPlan['terraform']): PlacemakerPlan {
  return {
    protocol: 'placemaker-plan/1',
    generator: 'synth',
    units: 'meters',
    seed: 1,
    area: 400,
    ready: true,
    settings: {},
    surfaces: [],
    nets: [],
    objects: [],
    areas: [],
    regions: [],
    zoning: [],
    paint: [],
    terraform,
    stats: [],
    facts: {},
    issues: [],
  } as unknown as PlacemakerPlan;
}

const square = (h: number, x0: number, z0: number, s: number) => [
  [x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s],
] as [number, number][];

{
  // 顶点高度全是 0、高度在 target 里 —— 这就是真实数据的样子。
  // 判据如果写成"顶点和 target 差多少"，这里会被当成 0 m 的坡，料堆原地消失。
  const p = synth([{ kind: 'raise', target: 1.5, permanent: true, ring: square(1.5, 0, 0, 10), hs: [0, 0, 0, 0] }]);
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  ok(res.mounds.length === 1, '[合成] 全零 hs 的环仍然出台体', `${res.mounds.length}`);
  ok(
    res.mounds.length === 1 && res.mounds[0].hs.every((h) => Math.abs(h * 7 - 1.5) < 1e-6),
    '[合成] 高度取 target 而不是全零的顶点高度',
    JSON.stringify(res.mounds[0]?.hs),
  );
}

{
  // 真有坡度：顶点高度不再是常数，必须逐顶点采用
  const p = synth([{ kind: 'raise', target: 1.0, permanent: true, ring: square(1, 0, 0, 10), hs: [0.2, 0.6, 1.0, 0.4] }]);
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  const hs = res.mounds[0]?.hs ?? [];
  ok(hs.length === 4 && new Set(hs.map((h) => h.toFixed(4))).size === 4, '[合成] 有坡度时逐顶点采用', JSON.stringify(hs));
  ok(Math.abs(Math.max(...hs) * 7 - 1.0) < 1e-6, '[合成] 坡度最大值仍是 target', `${(Math.max(...hs) * 7).toFixed(2)}`);
}

{
  const p = synth([{ kind: 'raise', target: 0.05, permanent: true, ring: square(0.05, 0, 0, 10), hs: [0, 0, 0, 0] }]);
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  ok(res.mounds.length === 0, '[合成] 5 cm 的台地不出（看不见）', `${res.mounds.length}`);
  ok(res.terrain.skipped === 1, '[合成] 计入 skipped', `${res.terrain.skipped}`);
}

{
  // 首尾闭合的环（polygon-clipping 的产物就是这种），不能炸
  const sq = square(1, 0, 0, 10);
  const closed = [...sq, sq[0]] as [number, number][];
  const p = synth([{ kind: 'raise', target: 1, permanent: true, ring: closed, hs: [0, 0, 0, 0, 0] }]);
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  ok(res.mounds.length === 1, '[合成] 闭合环仍能出台体', `${res.mounds.length}`);
  ok(res.mounds[0].ring.length === 4, '[合成] 闭合的重复末点被去掉', `${res.mounds[0]?.ring.length}`);
  ok(res.mounds[0].hs.length === res.mounds[0].ring.length, '[合成] 去点后 hs 同步');
}

{
  // 顺时针给的环：绕序要翻，hs 必须跟着翻（否则四个角的高度错位）
  const ccw = square(1, 0, 0, 10);
  const cw = [ccw[0], ccw[3], ccw[2], ccw[1]] as [number, number][];
  const p = synth([{ kind: 'raise', target: 1, permanent: true, ring: cw, hs: [0.1, 1.0, 0.2, 0.3] }]);
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  const m = res.mounds[0];
  ok(m !== undefined, '[合成] 顺时针环能出台体');
  if (m) {
    // 找出最低点和最高点各自对应的平面位置，顺时针输入时它们必须仍然对得上
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < m.hs.length; i++) {
      if (m.hs[i] < m.hs[lo]) lo = i;
      if (m.hs[i] > m.hs[hi]) hi = i;
    }
    // 顺时针输入是 [(0,0),(0,10),(10,10),(10,0)]，hs[1]=1.0 落在 (0,10)
    const hiPt = m.ring[hi];
    ok(
      Math.abs(hiPt.x * 7) < 0.01 && Math.abs(hiPt.y * 7 - 10) < 0.01,
      '[合成] 绕序翻转后最高点仍在 (0,10)',
      `(${(hiPt.x * 7).toFixed(1)},${(hiPt.y * 7).toFixed(1)})`,
    );
    ok(m.hs.length === 4 && Math.abs(m.hs[lo] * 7 - 0.1) < 1e-6, '[合成] 最低点仍是 0.1 m', `${(m.hs[lo] * 7).toFixed(2)}`);
  }
}

{
  // 道具在一座 2 m 土台上：底高必须抬到 2 m，而不是贴地
  const p = synth([{ kind: 'raise', target: 2, permanent: true, ring: square(2, 0, 0, 12), hs: [0, 0, 0, 0] }]);
  (p.objects as unknown[]).push({ role: 'furniture', category: 'industrial.crate', x: 6, z: 6, yaw: 0 });
  (p.objects as unknown[]).push({ role: 'furniture', category: 'industrial.crate', x: 18, z: 18, yaw: 0 });
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  const onTop = res.props.find((q) => q.at.x * 7 < 7 && q.at.y * 7 < 7);
  const offTop = res.props.find((q) => q.at.x * 7 > 15);
  ok(onTop?.baseY !== undefined, '[合成] 台地上的道具被抬起');
  ok(
    onTop !== undefined && Math.abs((onTop.baseY ?? 0) * 7 - 2) < 0.1,
    '[合成] 抬到台地高度',
    `${((onTop?.baseY ?? 0) * 7).toFixed(2)} m`,
  );
  ok(offTop?.baseY === undefined, '[合成] 台地外的道具不抬');
}

{
  // Core 自带的对象高度（`o.y`）优先于按环推算：`scrapyard` 有 194 件、
  // `carYard` 96 件的 y 与台地 target 一一对得上，那是权威值。
  const p = synth([]);
  (p.objects as unknown[]).push({ role: 'furniture', category: 'industrial.scrap', x: 6, z: 6, y: 3.2, yaw: 0 });
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  ok(
    res.props[0] !== undefined && Math.abs((res.props[0].baseY ?? 0) * 7 - 3.2) < 0.05,
    '[合成] 采用 Core 给的对象高度',
    `${((res.props[0]?.baseY ?? 0) * 7).toFixed(2)} m`,
  );
  // 关掉 terraform 就连这个高度一起不认：地面是平的，认了就是凭空浮着
  const off = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm', terraform: false });
  ok(off.props[0]?.baseY === undefined, '[terraform:false] 也不认 Core 给的高度');
}

{
  // 台地与 Core 给的高度同时存在时取大的：宁可微微悬空，也不要埋进土里
  const p = synth([{ kind: 'raise', target: 2, permanent: true, ring: square(2, 0, 0, 12), hs: [0, 0, 0, 0] }]);
  (p.objects as unknown[]).push({ role: 'furniture', category: 'industrial.crate', x: 6, z: 6, y: 0.2, yaw: 0 });
  const res = bridgePlan(p, { origin: new Pt(0, 0), group: 'pm' });
  ok(
    res.props[0] !== undefined && Math.abs((res.props[0].baseY ?? 0) * 7 - 2) < 0.1,
    '[合成] 台地高度盖过更小的 o.y',
    `${((res.props[0]?.baseY ?? 0) * 7).toFixed(2)} m`,
  );
}

// ─────────────────────────────────────────────── 收尾

if (fails.length > 0) {
  console.error(`断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`断言 ${pass} 通过 / 0 失败`);
