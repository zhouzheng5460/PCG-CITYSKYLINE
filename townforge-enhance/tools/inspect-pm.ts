// 只看 Placemaker 那一层（不带城市），判断"这块地本身对不对"。
//
// 跑：
//   npx tsx tools/inspect-pm.ts               # 默认 parking
//   npx tsx tools/inspect-pm.ts park
//   npx tsx tools/inspect-pm.ts formalGarden
//
// 和 test/bridge-glb.test.ts 出图的区别：那个是整座城 + 这块地，用来判断"接得自然不自然"；
// 这个是**只有 pm/* 分组**，缩放会自动贴到这块地上，用来判断"铺装/绿化/道具本身对不对"。
// 城里的图在 900 px 下这块地只有 120 px，看不见细节，两种图都要有。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { Model } from '../src/town/model';
import { ModernWard } from '../src/town/modern';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { buildTownMeshes } from '../src/export/build3d';
import { renderPrimitives } from '../test/soft3d';
import type { PlacemakerPlan } from '../src/bridge/placemaker';

mkdirSync('out', { recursive: true });

interface Meta {
  name: string; generator: string; patch: number; nPatches: number; citySeed: number;
  layout: 'grid' | 'field' | 'radial' | 'tensor'; origin: [number, number]; lotRing?: [number, number][];
  /** `--keep` 烘焙件：原地块的建筑要在图里，才看得出铺装是不是真的绕着楼走 */
  keepBuildings?: boolean;
}

const index = JSON.parse(readFileSync('src/bridge/data/index.json', 'utf8')) as Meta[];
const want = process.argv[2] ?? 'parking';
// 名字优先，其次"整块换掉"的那份：`--keep` 的烘焙件是绕着原地块建筑裁过的，
// 拿它当默认会在不知情的时候换掉基线（要看它就把全名传进来）。
const meta = index.find((m) => m.name === want)
  ?? index.find((m) => m.generator === want && !m.keepBuildings)
  ?? index.find((m) => m.generator === want);
if (!meta) {
  console.error(`[inspect] 索引里没有 "${want}"。可选：${[...new Set(index.map((m) => m.generator))].join(', ')}`);
  process.exit(2);
}

const planPath = `src/bridge/data/${meta.name}.plan.json`;
if (!existsSync(planPath)) {
  console.error(`[inspect] 找不到 ${planPath}`);
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PlacemakerPlan;

const model = new Model({ nPatches: meta.nPatches, seed: meta.citySeed, layout: meta.layout });
model.generate();

/** 这块地的可建区（世界坐标）。`--keep` 时用来分辨"哪些网格属于这一块"。 */
const ward = model.patches[meta.patch]?.ward;
const block = ward instanceof ModernWard ? Array.from(ward.getCityBlock()) : null;

/** 射线法判点在环内。 */
function inRing(x: number, y: number, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

const meshes = buildTownMeshes(model, {
  placemaker: [{
    plan,
    origin: new Pt(meta.origin[0], meta.origin[1]),
    patchIndex: meta.patch,
    group: 'pm',
    ...(meta.lotRing ? { lotRing: meta.lotRing } : {}),
    ...(meta.keepBuildings ? { keepBuildings: true } : {}),
  }],
});

// 平时只看 pm/*；`--keep` 的件要连原地块的建筑一起画，否则铺装中间那些
// 和楼一样大的洞看起来像 bug。
//
// 建筑没有 pm/ 前缀，而体块名（`cbd_podium`、`parcel_cbd`…）在每块地里都叫一样，
// 按名字挑会把整座城的楼都选进来（踩过）。按**几何**挑：顶点全部落在地块环内的网格
// 才算这一块的 —— 相邻地块的楼和树都在环外。
const onlyPm = meshes.filter((p) => {
  if (p.group.startsWith('pm/')) return true;
  if (!meta.keepBuildings || !block) return false;
  for (let i = 0; i < p.positions.length; i += 3) {
    if (!inRing(p.positions[i], p.positions[i + 2], block)) return false;
  }
  return true;
});
const groups = [...new Set(onlyPm.map((p) => p.group))].sort();
console.log(`[inspect] ${plan.generator}  网格组 ${groups.length} 个  三角形 ${onlyPm.reduce((s, p) => s + p.indices.length / 3, 0)}`);
for (const g of groups) console.log('   ' + g);

const top = renderPrimitives(onlyPm, { size: 800, azimuth: 0, elevation: 89, zoom: 1 });
await sharp(Buffer.from(top.rgba), { raw: { width: top.width, height: top.height, channels: 4 } })
  .png().toFile(`out/inspect-${plan.generator}-top.png`);

const d = renderPrimitives(onlyPm, { size: 800, azimuth: 35, elevation: 40 });
await sharp(Buffer.from(d.rgba), { raw: { width: d.width, height: d.height, channels: 4 } })
  .png().toFile(`out/inspect-${plan.generator}-3d.png`);

console.log(`[inspect] out/inspect-${plan.generator}-{top,3d}.png`);
