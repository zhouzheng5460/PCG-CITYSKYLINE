// 把 src/bridge/data 里所有烘焙好的 Plan 铺成一张联系表，一眼看出"哪些生成器值得接"。
//
// 跑：npx tsx tools/contact-sheet.ts
// 产出：out/bridge-sheet.svg + out/bridge-sheet.png
//
// 为什么要有这个东西：二十份 Plan 的数字（面数、道具数）看不出问题，
// 但"树全挤在西北角""园路横穿围栏""整块地变成水面"这类问题看一秒就出来了。
// 单元格共用一把尺子（所有 Plan 都在同一块地上），所以疏密是可以横向对比的。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { MAT } from '../src/scene/palette';
import type { MatKey } from '../src/scene/palette';
import { propDraw } from '../src/scene/propStyle';
import { bridgePlan } from '../src/bridge/placemaker';
import type { PlacemakerPlan, PlanPoint } from '../src/bridge/placemaker';
import type { PathFeature, PropFeature, SurfaceFeature } from '../src/scene/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = join(root, 'src/bridge/data');
const outDir = join(root, 'out');
mkdirSync(outDir, { recursive: true });

interface Meta {
  name: string;
  generator: string;
  origin: [number, number];
  areaM2: number;
  lotRing: PlanPoint[];
  /** `--keep` 的件是绕着原地块建筑裁过的，和别的生成器放一起比没有意义 */
  keepBuildings?: boolean;
}

const allMetas = readdirSync(dataDir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as Meta);

// 一张表只能比"同一块地"上的生成器。现在库里有两块地（p42 绿地那批、p90 保留建筑那批），
// 所以先挑条目最多的那一组；`--keep` 的件单独排除（铺装被楼裁过，放进来会显得那个生成器很差）。
const groups = new Map<string, Meta[]>();
for (const m of allMetas) {
  if (m.keepBuildings) continue;
  const k = `${m.areaM2}`;
  const arr = groups.get(k);
  if (arr) arr.push(m); else groups.set(k, [m]);
}
const metas = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
metas.sort((a, b) => a.generator.localeCompare(b.generator));

const skipped = allMetas.length - metas.length;
if (skipped > 0) console.log(`[sheet] 跳过 ${skipped} 份别的场地 / --keep 的烘焙件`);

if (!metas.length) {
  console.error('[sheet] src/bridge/data 里没有 meta，先跑 npx tsx tools/bake-plan.ts --patch 42 --gens ...');
  process.exit(2);
}

interface Cell {
  gen: string;
  surfaces: SurfaceFeature[];
  props: PropFeature[];
  paths: PathFeature[];
  note: string;
}

const cells: Cell[] = metas.map((meta) => {
  const plan = JSON.parse(readFileSync(join(dataDir, `${meta.name}.plan.json`), 'utf8')) as PlacemakerPlan;
  const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
  const own = plan.surfaces.length + plan.nets.length + plan.objects.length;
  return {
    gen: plan.generator,
    surfaces: res.surfaces,
    props: res.props,
    paths: res.paths,
    note: own === 0 ? '无内容（只有草地底）' : `${res.surfaces.length - 1} 面 · ${res.props.length} 道具 · ${res.paths.length} 路`,
  };
});

// ─────────────────────────────────────────────────────────── 布局

const COLS = 5;
const CELL = 300;
const PAD = 26;
const LABEL = 26;
const ROWS = Math.ceil(cells.length / COLS);
const W = COLS * CELL;
const H = ROWS * (CELL + LABEL) + PAD * 2 + 34;

// 共用一把尺子：所有单元格用同一个缩放，密度才可比。
const allX: number[] = [], allY: number[] = [];
for (const c of cells) {
  for (const s of c.surfaces) for (const p of s.ring) { allX.push(p.x); allY.push(p.y); }
  for (const p of c.paths) for (const q of p.pts) { allX.push(q.x); allY.push(q.y); }
}
const spanX = Math.max(...allX) - Math.min(...allX);
const spanY = Math.max(...allY) - Math.min(...allY);
const span = Math.max(spanX, spanY) * 1.06;
const scale = (CELL - 16) / span;
const cxOf = (i: number) => (i % COLS) * CELL + CELL / 2;
const cyOf = (i: number) => PAD + 34 + Math.floor(i / COLS) * (CELL + LABEL) + CELL / 2;
const midX = (Math.min(...allX) + Math.max(...allX)) / 2;
const midY = (Math.min(...allY) + Math.max(...allY)) / 2;

const hex = (c: [number, number, number]) =>
  '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

// 道具怎么画直接吃 `scene/propStyle.ts` 的 `propDraw` —— 联系表要能反映"编辑器里看到的样子"。
// 自己再抄一份半径/颜色表就等于给漂移留了口子（第一版就是这么干的，结果新加的
// shrub / treeRound 在表里没有键，整张表里一棵树都看不见）。

const path = (ring: Pt[]) => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('') + 'Z';
const line = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}">
<rect width="${W}" height="${H.toFixed(0)}" fill="#f6f6f4"/>
<text x="${PAD}" y="${PAD + 10}" font-family="ui-sans-serif,Segoe UI,sans-serif" font-size="16" fill="#222">Placemaker → TownForge 联系表 · 同一地块（${metas[0].areaM2} m²）× ${cells.length} 个生成器</text>
<text x="${PAD}" y="${PAD + 26}" font-family="ui-sans-serif,Segoe UI,sans-serif" font-size="11" fill="#888">比例尺 ${(scale / UNIT_M).toFixed(2)} px/m　·　所有单元格同一把尺子，疏密可直接对比</text>
`;

cells.forEach((c, i) => {
  const cx = cxOf(i), cy = cyOf(i);
  svg += `<g transform="translate(${cx.toFixed(1)},${cy.toFixed(1)}) scale(${scale.toFixed(5)}) translate(${(-midX).toFixed(2)},${(-midY).toFixed(2)})">`;
  // 底：按 y 从低到高铺，等价于 Plan 里的绘制顺序
  for (const s of [...c.surfaces].sort((a, b) => a.y - b.y)) {
    svg += `<path d="${path(s.ring)}" fill="${hex(MAT[(s.mat as MatKey)] ?? MAT.ground)}" fill-opacity="0.95" stroke="none"/>`;
  }
  // 地块轮廓：不然整块地表是一团色，看不出边界是斜的还是缺角的
  const ground = c.surfaces.find((s) => s.group.endsWith('/surface/ground'));
  if (ground) {
    svg += `<path d="${path(ground.ring)}" fill="none" stroke="#3c4a3a" stroke-width="${(0.7 / scale).toFixed(3)}"/>`;
  }
  // 通路：线宽用真实宽度，缩到 0.4px 以下就没法看了
  for (const p of c.paths) {
    const w = Math.max(p.width, 0.55 / scale);
    svg += `<path d="${line(p.pts)}" fill="none" stroke="${hex(MAT.paver)}" stroke-width="${w.toFixed(3)}" stroke-linecap="round"/>`;
  }
  // 道具：按样式表画（圆点 / 绿篱那种沿 rot 的短棒）
  for (const p of c.props) {
    const d = propDraw(p);
    if (!d) continue;
    const col = hex(MAT[d.mat]);
    if (d.shape === 'bar') {
      const half = d.len * 0.5;
      const dx = Math.cos(p.rot) * half, dy = Math.sin(p.rot) * half;
      svg += `<line x1="${(p.at.x - dx).toFixed(2)}" y1="${(p.at.y - dy).toFixed(2)}" x2="${(p.at.x + dx).toFixed(2)}" y2="${(p.at.y + dy).toFixed(2)}" stroke="${col}" stroke-width="${d.width.toFixed(3)}" stroke-linecap="round"/>`;
    } else {
      svg += `<circle cx="${p.at.x.toFixed(2)}" cy="${p.at.y.toFixed(2)}" r="${d.r.toFixed(3)}" fill="${col}"/>`;
    }
  }
  svg += '</g>';

  const textX = (i % COLS) * CELL + CELL / 2;
  const textY = PAD + 34 + Math.floor(i / COLS) * (CELL + LABEL) + CELL + 14;
  const empty = c.note.startsWith('无内容');
  svg += `<text x="${textX}" y="${textY}" text-anchor="middle" font-family="ui-sans-serif,Segoe UI,sans-serif" font-size="13" fill="${empty ? '#b0442c' : '#222'}">${c.gen}</text>`;
  svg += `<text x="${textX}" y="${textY + 13}" text-anchor="middle" font-family="ui-sans-serif,Segoe UI,sans-serif" font-size="10" fill="#888">${c.note}</text>`;
});

svg += '</svg>';

const svgPath = join(outDir, 'bridge-sheet.svg');
writeFileSync(svgPath, svg);
console.log(`[sheet] ${cells.length} 个生成器 → ${svgPath}`);

await sharp(Buffer.from(svg)).png().toFile(join(outDir, 'bridge-sheet.png'));
console.log(`[sheet] png → ${join(outDir, 'bridge-sheet.png')}`);
