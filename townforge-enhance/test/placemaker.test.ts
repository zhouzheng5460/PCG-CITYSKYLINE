// Placemaker → TownForge 桥接的端到端验证。
//
// 跑：npx tsx test/placemaker.test.ts
//
// 数据来自 C# 端：
//   cd placemaker-core-lib
//   dotnet run --project Driver -c Release -- --emit cases/parking-150x100.json out/emit/parking-150x100.json
//
// 验证四件事（都是"看起来对但事实上错"的高危项）：
//   1) 尺度：150×100 m 的地块换算后应该正好是 21.43×14.29 世界单位；
//   2) 方向：不翻转任何轴 —— 地块的南边（z=0）必须落在世界坐标 y=0 一侧；
//   3) 几何：所有面都是简单环，没有自交、没有退化；
//   4) 车位：313 个点必须重塑成线，而不是 313 个重叠方块。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { bridgePlan, baysToMarkings, sampleBezier, yawToRot } from '../src/bridge/placemaker';
import type { PlacemakerPlan } from '../src/bridge/placemaker';
import type { SurfaceFeature, PropFeature, PathFeature } from '../src/scene/types';
import { MAT } from '../src/scene/palette';

const here = dirname(fileURLToPath(import.meta.url));
const coreLib = resolve(here, '../../placemaker-core-lib');
const dataDir = resolve(here, '../src/bridge/data');

// 两条路都支持：
//   PM_PLAN=/abs/path.json          直接指定（给临时探路用）
//   PM_GEN=park                     指定生成器，默认 parking
//   默认                             读烘焙索引里第一个 parking
// 不硬编码文件名，因为地块编号会随城市重建而变（见 bridge-glb.test.ts 的注释）。
// 也**不能**再取"面积最大的那一项"：同一块地现在烘了十几个生成器，面积全都一样。
let planPath = process.env.PM_PLAN;
if (!planPath) {
  const indexPath = join(dataDir, 'index.json');
  if (existsSync(indexPath)) {
    const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as { name: string; generator: string; keepBuildings?: boolean }[];
    const want = process.env.PM_GEN ?? 'parking';
    // 优先取"整块换掉"的那份：`--keep` 的烘焙件是围着原地块建筑生成的（铺装被裁过），
    // 拿它当尺度/方向的基线会把"被楼切掉的停车场"当成正常形态。
    const hit = idx.find((e) => e.generator === want && !e.keepBuildings)
      ?? idx.find((e) => e.generator === want)
      ?? idx[0];
    if (hit) planPath = join(dataDir, `${hit.name}.plan.json`);
  }
}
if (!planPath) planPath = join(coreLib, 'out/emit/parking-150x100.json');

if (!existsSync(planPath)) {
  console.error(`[bridge] 找不到 ${planPath}`);
  console.error('  先跑： npx tsx tools/bake-plan.ts   （或 cd ../placemaker-core-lib && dotnet run --project Driver -c Release -- --emit cases/parking-150x100.json out/emit/parking-150x100.json）');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PlacemakerPlan;

// ─────────────────────────────────────────────────────────── 断言工具

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}
function close(a: number, b: number, eps: number) { return Math.abs(a - b) <= eps; }

// ─────────────────────────────────────────────────────────── 1. 基本协议

ok(plan.protocol === 'placemaker-plan/1', '协议版本是 placemaker-plan/1', plan.protocol);
ok(plan.ready === true, '生成器就绪', plan.readyKey ?? '');
ok(plan.units === 'meters', '单位声明是米');
ok(plan.surfaces.length > 0, '有铺装面', String(plan.surfaces.length));
ok(plan.objects.length > 0, '有对象', String(plan.objects.length));

// ─────────────────────────────────────────────────────────── 2. 桥接

const ORIGIN = new Pt(10, 20);   // 故意给一个非零原点，验证偏移真的生效
const res = bridgePlan(plan, { origin: ORIGIN, group: 'parking' });

ok(res.meta.generator === plan.generator, 'meta 带回生成器 id', res.meta.generator);
ok(res.dropped === 0, '没有面被丢弃（自交/退化）', `dropped=${res.dropped}`);

// ─────────────────────────────────────────────────────────── 3. 尺度与方向

// 地块尺寸从 Plan 自己算，不硬编码 —— 烘焙出来的地块换一块，这里就得跟着换。
// 取的是**铺装面**的包围盒（通道会伸出地块接路，不能算进来）。
const rawX = plan.surfaces.flatMap((s) => s.ring.map((p) => p[0]));
const rawZ = plan.surfaces.flatMap((s) => s.ring.map((p) => p[1]));
const W = (Math.max(...rawX) - Math.min(...rawX)) / UNIT_M;
const H = (Math.max(...rawZ) - Math.min(...rawZ)) / UNIT_M;

// 地块本身的东西（铺装、道具）必须在地块内。
// 通道是例外：接驳车道（driveConnector）本来就该伸出地块通到路缘，
// 实测 minZ = -4.00 m，正好是 8 m 街（中心 -8）的路缘。所以通道单独放宽 4.5 m。
const inPts: Pt[] = [];
for (const s of res.surfaces) inPts.push(...s.ring);
for (const p of res.props) inPts.push(p.at);

const pathPts: Pt[] = [];
for (const p of res.paths) pathPts.push(...p.pts);

const minX = Math.min(...inPts.map((p) => p.x));
const maxX = Math.max(...inPts.map((p) => p.x));
const minY = Math.min(...inPts.map((p) => p.y));
const maxY = Math.max(...inPts.map((p) => p.y));

ok(close(minX, ORIGIN.x, 0.35), '西边界落在 origin.x 附近', `${minX.toFixed(3)} vs ${ORIGIN.x}`);
ok(close(maxX, ORIGIN.x + W, 0.35), '东边界落在 origin.x + 地块宽', `${maxX.toFixed(3)} vs ${(ORIGIN.x + W).toFixed(3)}`);
ok(close(minY, ORIGIN.y, 0.35), '南边界落在 origin.y 附近（y 轴没被翻转）', `${minY.toFixed(3)} vs ${ORIGIN.y}`);
ok(close(maxY, ORIGIN.y + H, 0.35), '北边界落在 origin.y + 地块高', `${maxY.toFixed(3)} vs ${(ORIGIN.y + H).toFixed(3)}`);

{
  const reach = Math.min(...pathPts.map((p) => p.y));
  const REACH_M = 4.5;   // 允许伸出到路缘
  ok(reach >= ORIGIN.y - REACH_M / UNIT_M - 0.01, '通道最多只伸到路缘', `${reach.toFixed(3)} vs ${(ORIGIN.y - REACH_M / UNIT_M).toFixed(3)}`);
}

// 方向：Plan 里的 z 越大越靠北，换算后 y 必须也越大。取两个车位验证单调性。
const baysIn = plan.objects.filter((o) => o.role === 'parkingBay');
if (baysIn.length >= 2) {
  const south = baysIn.reduce((a, b) => (a.z < b.z ? a : b));
  const north = baysIn.reduce((a, b) => (a.z > b.z ? a : b));
  const sPt = new Pt(south.x / UNIT_M, south.z / UNIT_M);
  const nPt = new Pt(north.x / UNIT_M, north.z / UNIT_M);
  ok(sPt.y < nPt.y, 'z 增大 → y 增大（没有镜像）', `${sPt.y.toFixed(2)} < ${nPt.y.toFixed(2)}`);
}

// ─────────────────────────────────────────────────────────── 4. 几何合法性

let degenerate = 0;
for (const s of res.surfaces) {
  if (s.ring.length < 3) { degenerate++; continue; }
  if (!isSimple(s.ring)) degenerate++;
}
ok(degenerate === 0, '所有铺装面都是简单环', `坏面 ${degenerate}`);

let badPath = 0;
for (const p of res.paths) if (p.pts.length < 2 || p.width <= 0) badPath++;
ok(badPath === 0, '所有通道都有 2 点以上且宽度为正', `坏通道 ${badPath}`);

// ─────────────────────────────────────────────────────────── 5. 车位重塑

ok(res.bays.total === baysIn.length, '车位总数对得上', `${res.bays.total} vs ${baysIn.length}`);
// 段数会被"排内断口"抬高：停车场里一排车位常被车道打断，每段单独画线才是对的。
// 断口不切的话，一条前缘线会横穿整块地把中间那几排划掉（图上极显眼）。
// 段数上限放得很宽是有原因的：斜地块（张量场切出来的梯形）上，车位沿每段边界
// 各自排布，一段只有 2~3 个车位是常态。实测 276 车位 / 99 段，平均每段 2.8 个。
ok(res.bays.rows >= 4 && res.bays.rows <= 220, '车位被聚成多段', `rows=${res.bays.rows}`);
ok(res.bays.lines >= res.bays.total, '车位线不少于车位数（每车位至少一条分隔线）', `${res.bays.lines} vs ${res.bays.total}`);

// 车位线不能全挤在一个角落：检查它们的质心大致落在地块中心
const baySurf = res.surfaces.filter((s) => s.group.endsWith('/marking/bay'));
const bayCenterX = baySurf.reduce((s, f) => s + avg(f.ring.map((p) => p.x)), 0) / Math.max(1, baySurf.length);
const bayCenterY = baySurf.reduce((s, f) => s + avg(f.ring.map((p) => p.y)), 0) / Math.max(1, baySurf.length);
ok(
  close(bayCenterX, ORIGIN.x + W / 2, W * 0.25) && close(bayCenterY, ORIGIN.y + H / 2, H * 0.25),
  '车位线质心接近地块中心',
  `(${bayCenterX.toFixed(1)}, ${bayCenterY.toFixed(1)}) vs (${(ORIGIN.x + W / 2).toFixed(1)}, ${(ORIGIN.y + H / 2).toFixed(1)})`,
);

// ─────────────────────────────────────────────────────────── 6. 纯函数的小检查

{
  const a = new Pt(0, 0), d = new Pt(10, 0);
  const straight = sampleBezier(a, a, d, d);   // 控制点都在弦上 = 直线
  ok(straight.length === 2, '直线贝塞尔只采 2 点', String(straight.length));

  const curved = sampleBezier(a, new Pt(5, 5), new Pt(5, 5), d);
  ok(curved.length > 2, '弯曲贝塞尔采多点', String(curved.length));
  ok(curved.length <= 25, '弯曲贝塞尔采样有上限', String(curved.length));

  ok(close(yawToRot(0), -Math.PI / 2, 1e-9), 'yaw 0（+Z）→ rot -90°（2D 里朝 -Y）');
  ok(close(yawToRot(Math.PI / 2), 0, 1e-9), 'yaw 90°（+X）→ rot 0°（2D 里朝 +X）');
}

// ─────────────────────────────────────────────────────────── 6.5 草地底（lotRing）

// 地块环不在 Plan 里（C# 端不知道世界坐标，也不知道地块环），烘焙时写进了 meta。
// parking 自己把整块地都铺满了，所以这里只验证"补底只多一个面、没动别的东西"；
// 绿地生成器（park 之类）完全不铺地面，补底是它们唯一的来源，见 bridge-green.test.ts。
{
  const metaPath = planPath.replace(/\.plan\.json$/, '.meta.json');
  const meta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { lotRing?: [number, number][] })
    : {};
  ok(Array.isArray(meta.lotRing) && meta.lotRing!.length >= 3, 'meta 里带地块环 lotRing', String(meta.lotRing?.length ?? 0));

  if (meta.lotRing) {
    const withBase = bridgePlan(plan, { origin: ORIGIN, group: 'parking', lotRing: meta.lotRing });
    const base = withBase.surfaces[0];
    ok(withBase.surfaces.length === res.surfaces.length + 1, '补草地底只多一个面', `${withBase.surfaces.length} vs ${res.surfaces.length}`);
    ok(base?.mat === 'grass', '草地底材质是草', String(base?.mat));
    ok(base?.group === 'parking/surface/ground', '草地底单独成组', String(base?.group));
    ok(base.y < res.surfaces[0].y, '草地底压在所有铺装之下', `${base.y} < ${res.surfaces[0].y}`);
    // 环是米制的，换算回世界单位后面积应当等于 Plan 自己报的地块面积
    const a = Math.abs(base.ring.reduce((s, p, i) => {
      const q = base.ring[(i + 1) % base.ring.length];
      return s + p.x * q.y - q.x * p.y;
    }, 0)) / 2 * UNIT_M * UNIT_M;
    ok(close(a, plan.area, plan.area * 0.01), '草地面积等于地块面积（±1%）', `${a.toFixed(0)} vs ${plan.area.toFixed(0)} m²`);
  }
}

// ─────────────────────────────────────────────────────────── 7. 出图

mkdirSync(join(here, 'out'), { recursive: true });
const svg = renderSvg(res.surfaces, res.props, res.paths, plan,
  new Pt(ORIGIN.x + Math.min(...rawX) / UNIT_M, ORIGIN.y + Math.min(...rawZ) / UNIT_M), W, H);
const svgPath = join(here, 'out', `bridge-${plan.generator}.svg`);
writeFileSync(svgPath, svg);

// ─────────────────────────────────────────────────────────── 报告

const nSurf = res.surfaces.length;
const nSolid = 0;
console.log('=== Placemaker → TownForge 桥接验证 ===');
console.log(`plan   ${plan.generator}  seed=${plan.seed}  area=${plan.area} m²  ready=${plan.ready}`);
console.log(`输入   surf=${plan.surfaces.length} net=${plan.nets.length} obj=${plan.objects.length}  (${(plan.elapsedMs ?? 0).toFixed(0)} ms in C#)`);
console.log(`输出   surfaces=${nSurf}  props=${res.props.length}  paths=${res.paths.length}  solids=${nSolid}  dropped=${res.dropped}`);
console.log(`车位   total=${res.bays.total}  rows=${res.bays.rows}  lines=${res.bays.lines}`);
console.log(`范围   x ${minX.toFixed(2)}..${maxX.toFixed(2)}  y ${minY.toFixed(2)}..${maxY.toFixed(2)}  （期望 ${ORIGIN.x}..${(ORIGIN.x + W).toFixed(2)} / ${ORIGIN.y}..${(ORIGIN.y + H).toFixed(2)}）`);
console.log(`图     ${svgPath}`);
console.log(`断言   ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log('');
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
console.log('全部通过。');

// ─────────────────────────────────────────────────────────── 工具

function avg(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function isSimple(ring: Pt[]): boolean {
  const n = ring.length;
  const d = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    if (Math.abs(d(a, b, c)) < 1e-9) return false;
  }
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2);
      if ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0)) return false;
    }
  }
  return true;
}

/** 轻量 SVG：只为本测试看图用，不复用 render/svg.ts（那个吃的是 Model）。 */
function renderSvg(
  surfaces: SurfaceFeature[], props: PropFeature[], paths: PathFeature[],
  src: PlacemakerPlan, origin: Pt, w: number, h: number,
): string {
  const pad = 18;
  const scale = 980 / Math.max(w, h);
  const px = (v: number) => (v - origin.x) * scale + pad;
  const py = (v: number) => (v - origin.y) * scale + pad;
  const W = w * scale + pad * 2;
  const Hh = h * scale + pad * 2 + 64;

  const color = (mat: string) => {
    const c = MAT[mat as keyof typeof MAT] ?? [0.5, 0.5, 0.5];
    return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  };
  const pathOf = (ring: { x: number; y: number }[]) =>
    ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join('') + 'Z';

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${Hh.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${Hh.toFixed(0)}">`;
  s += `<rect width="100%" height="100%" fill="#f7f5f0"/>`;

  // 铺装（按 y 从低到高）
  const sorted = [...surfaces].sort((a, b) => a.y - b.y);
  for (const f of sorted) {
    s += `<path d="${pathOf(f.ring)}" fill="${color(f.mat)}" stroke="#00000018" stroke-width="0.4"/>`;
  }

  // 通道
  for (const p of paths) {
    const d = p.pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${px(q.x).toFixed(2)},${py(q.y).toFixed(2)}`).join('');
    s += `<path d="${d}" fill="none" stroke="${color(p.mat)}" stroke-width="${(p.width * scale * 1.15).toFixed(2)}" stroke-linecap="round" stroke-opacity="0.55"/>`;
  }

  // 道具
  for (const p of props) {
    const r = p.kind === 'tree' ? 2.6 : p.kind === 'treeSmall' ? 1.7 : 1.2;
    const fill = p.kind === 'tree' ? '#3f6b2c' : p.kind === 'treeSmall' ? '#5a8a3a'
      : p.kind === 'lamp' ? '#c9a227' : p.kind === 'bollard' ? '#7a8894' : '#8a7a66';
    s += `<circle cx="${px(p.at.x).toFixed(2)}" cy="${py(p.at.y).toFixed(2)}" r="${r}" fill="${fill}" fill-opacity="0.9"/>`;
  }

  // 地块边界
  const ring = src.surfaces.flatMap((x) => x.ring);
  if (ring.length > 0) {
    s += `<rect x="${pad}" y="${pad}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="none" stroke="#2b4a6f" stroke-width="1.4" stroke-dasharray="6 4"/>`;
  }

  s += `<text x="${pad}" y="${(pad + h * scale + 24).toFixed(0)}" font-family="monospace" font-size="14" fill="#222">${src.generator}  seed=${src.seed}  ${src.area} m²  ·  ${surfaces.length} surfaces / ${props.length} props / ${paths.length} paths</text>`;
  s += `<text x="${pad}" y="${(pad + h * scale + 44).toFixed(0)}" font-family="monospace" font-size="12" fill="#666">${(w * UNIT_M).toFixed(0)} × ${(h * UNIT_M).toFixed(0)} m 地块 = ${w.toFixed(2)} × ${h.toFixed(2)} 世界单位（1 单位 = ${UNIT_M} m）· 原点 (${origin.x}, ${origin.y})</text>`;
  s += '</svg>';
  return s;
}
