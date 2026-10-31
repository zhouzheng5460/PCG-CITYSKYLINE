// 给每个烘焙方案打分：用**数字**代替肉眼看 png。
//
// 跑：npm run score                    # 全部方案
//     npm run score -- --gen park      # 只看某个生成器
//     npm run score -- --csv out/score.csv
//
// 为什么需要：批量接入生成器时，"这个方案好不好"以前只能打开图看。一旦要接十几个，
// 就得靠能对齐、能排序、能进测试的数字。这里只算 Plan 自身几何，不重跑 Model，秒出。
//
// 指标口径（与 test/bridge-obstacles.test.ts 保持一致，避免两套账）：
//   铺装 m²   = surfaces 的**并集**面积（重叠只算一次、洞扣掉），见 src/bridge/area.ts
//   覆盖 %    = 铺装 m² / 地块 m²
//   层        = 各面简单相加 / 并集，>1 说明铺装分层叠放（草坪底 + 铺装压在上面）
//   实体密度  = 实体个数 / 千 m²
//   网线 m    = 每条贝塞尔采样 12 段的折线长之和

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ringArea, sumArea, unionArea } from '../src/bridge/area';

const dataDir = 'src/bridge/data';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const onlyGen = arg('gen', '');
const csvPath = arg('csv', '');

interface Meta {
  name: string;
  generator: string;
  patch: number;
  areaM2: number;
  keepBuildings?: boolean;
  obstacles?: number;
  buildings?: number;
}

interface PlanJson {
  generator: string;
  area: number;
  surfaces: { role: string; ring: [number, number][] }[];
  nets: { role: string; a: [number, number]; b: [number, number]; c: [number, number]; d: [number, number] }[];
  objects: { role: string }[];
  terraform: { kind: string; ring: [number, number][] }[];
  unknownRoles?: { surfaces?: number; nets?: number; objects?: number; areas?: number };
}

/** 贝塞尔弧长，采样 12 段足够（这些渠都是缓弯）。 */
function bezLen(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number {
  const N = 12;
  let len = 0;
  let px = a[0], py = a[1];
  for (let i = 1; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const x = u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0];
    const y = u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1];
    len += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return len;
}

interface Row {
  name: string;
  gen: string;
  lot: number;
  paved: number;
  layers: number;
  cover: number;
  props: number;
  density: number;
  netLen: number;
  bld: number;
  unknown: number;
  topRoles: string;
}

const metas = readdirSync(dataDir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as Meta)
  .filter((m) => !onlyGen || m.generator === onlyGen)
  .sort((a, b) => a.name.localeCompare(b.name));

if (metas.length === 0) {
  console.error(`没有匹配的方案（--gen ${onlyGen || '(未指定)'}）`);
  process.exit(2);
}

const rows: Row[] = [];
for (const meta of metas) {
  let plan: PlanJson;
  try {
    plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as PlanJson;
  } catch {
    console.log(`跳过 ${meta.name}（没有 plan.json）`);
    continue;
  }
  const pavedSum = sumArea(plan.surfaces.map((x) => x.ring));
  const un = unionArea(plan.surfaces.map((x) => x.ring));
  const paved = un.area;
  if (!un.ok && plan.surfaces.length > 1) {
    console.warn(`[score] ${meta.name}: 并集计算退化（多边形自交/零宽），铺装面积取的是简单相加，可能偏高`);
  }
  const layers = paved > 0.01 ? pavedSum / paved : 0;
  const netLen = plan.nets.reduce((s, n) => s + bezLen(n.a, n.b, n.c, n.d), 0);
  const counts = new Map<string, number>();
  for (const o of plan.objects) counts.set(o.role, (counts.get(o.role) ?? 0) + 1);
  const topRoles = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([r, n]) => `${r}×${n}`).join(' ');
  const u = plan.unknownRoles;
  const unknown = (u?.surfaces ?? 0) + (u?.nets ?? 0) + (u?.objects ?? 0) + (u?.areas ?? 0);
  const lot = meta.areaM2 || plan.area || 1;

  rows.push({
    name: meta.name,
    gen: meta.generator,
    lot,
    paved,
    layers,
    cover: paved / lot,
    props: plan.objects.length,
    density: plan.objects.length / (lot / 1000),
    netLen,
    bld: meta.buildings ?? 0,
    unknown,
    topRoles,
  });
}

// 覆盖率高 → 低；同档按实体数降序
rows.sort((a, b) => b.cover - a.cover || b.props - a.props);

const pad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

const header = `${padR('方案', 30)} ${padR('gen', 18)} ${pad('地块', 8)} ${pad('铺装', 8)} ${pad('覆盖', 6)} ${pad('层', 4)} ${pad('实体', 6)} ${pad('密度', 7)} ${pad('网线m', 8)} ${pad('楼', 3)}`;
console.log(header);
console.log('-'.repeat(header.length));

for (const r of rows) {
  const flag = r.unknown > 0 ? ' !!' : '';
  console.log(
    `${padR(r.name, 30)} ${padR(r.gen, 18)} ${pad(r.lot.toFixed(0), 8)} ${pad(r.paved.toFixed(0), 8)} ` +
    `${pad((r.cover * 100).toFixed(0) + '%', 6)} ${pad(r.layers.toFixed(2), 4)} ${pad(String(r.props), 6)} ${pad(r.density.toFixed(1), 7)} ` +
    `${pad(r.netLen.toFixed(0), 8)} ${pad(String(r.bld), 3)}${flag}`,
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log('');
console.log(`共 ${rows.length} 份；平均覆盖 ${(avg(rows.map((r) => r.cover)) * 100).toFixed(0)}%，` +
  `平均实体 ${avg(rows.map((r) => r.props)).toFixed(0)} 个，` +
  `平均网线 ${avg(rows.map((r) => r.netLen)).toFixed(0)} m`);
if (rows.some((r) => r.unknown > 0)) {
  console.log('!! 有方案存在未映射角色（见 unknownRoles），这些元素不会进场景。');
}

if (csvPath) {
  const lines = ['name,generator,lot_m2,paved_union_m2,cover,surface_layers,props,density_per_1000m2,net_len_m,buildings,unknown_roles'];
  for (const r of rows) {
    lines.push([r.name, r.gen, r.lot.toFixed(0), r.paved.toFixed(1), r.cover.toFixed(4),
      r.layers.toFixed(2), r.props, r.density.toFixed(2), r.netLen.toFixed(1), r.bld, r.unknown].join(','));
  }
  writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`CSV → ${csvPath}`);
}
