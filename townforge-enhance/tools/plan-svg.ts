// 把一块 Placemaker 地块画进**整座城**的 2D 平面图，只框住这块地。
//
// 跑：
//   npx tsx tools/plan-svg.ts               # 默认 formalGarden
//   npx tsx tools/plan-svg.ts parking
//
// 和 `inspect:pm` 的分工：那个只画 pm/* 分组、用软件光栅化出 3D，看"这块地本身对不对"；
// 这个是**真 2D 渲染器**（`render/svg.ts`，编辑器画布用的同一条路径），看"编辑器里长什么样"。
// 两者都要有：3D 能看出高度/穿模，2D 才能看出线宽、颜色、和周边道路的压盖关系。
//
// 顺带当回归用：绿篱的 `bar` 分支曾经因为 `r <= 0` 在 2D 里被整段吞掉，
// 这里打印圆头条带的数量，一眼能看出它是不是又没画。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Model } from '../src/town/model';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { renderSVG } from '../src/render/svg';
import type { PlacemakerPlan } from '../src/bridge/placemaker';

interface Meta {
  name: string; generator: string; patch: number; nPatches: number; citySeed: number;
  layout: 'grid' | 'field' | 'radial' | 'tensor'; origin: [number, number]; lotRing?: [number, number][];
  /** 烘焙时是否保留了原地块的建筑（`--keep`）。true 时要把体块一起画出来，才看得出铺装有没有绕开楼。 */
  keepBuildings?: boolean;
}

mkdirSync('out', { recursive: true });

const index = JSON.parse(readFileSync('src/bridge/data/index.json', 'utf8')) as Meta[];
const want = process.argv[2] ?? 'formalGarden';
// 名字优先；同名生成器有多份烘焙时取"整块换掉"的那份（`--keep` 的件是绕着楼裁过的，
// 拿它当默认会在不知情的时候换掉图面）。要看 keep 的就传全名。
const meta = index.find((m) => m.name === want)
  ?? index.find((m) => m.generator === want && !m.keepBuildings)
  ?? index.find((m) => m.generator === want);
if (!meta) {
  console.error(`[plan] 索引里没有 "${want}"。可选：${[...new Set(index.map((m) => m.generator))].join(', ')}`);
  process.exit(2);
}

const plan = JSON.parse(readFileSync(`src/bridge/data/${meta.name}.plan.json`, 'utf8')) as PlacemakerPlan;
const model = new Model({ nPatches: meta.nPatches, seed: meta.citySeed, layout: meta.layout });
model.generate();

const lot = {
  plan,
  origin: new Pt(meta.origin[0], meta.origin[1]),
  patchIndex: meta.patch,
  group: 'pm',
  ...(meta.lotRing ? { lotRing: meta.lotRing } : {}),
  // 保留建筑的那批（`--keep`）：体块要留在场景里，才能看出铺装是不是真的绕开了楼
  ...(meta.keepBuildings ? { keepBuildings: true } : {}),
};

// 视口框到地块（meta 里的环是米，换成世界单位再加 origin）
const ring = meta.lotRing ?? [];
const pad = 6;
const bounds = ring.length > 0
  ? {
      minX: meta.origin[0] + Math.min(...ring.map((p) => p[0])) / UNIT_M - pad,
      maxX: meta.origin[0] + Math.max(...ring.map((p) => p[0])) / UNIT_M + pad,
      minY: meta.origin[1] + Math.min(...ring.map((p) => p[1])) / UNIT_M - pad,
      maxY: meta.origin[1] + Math.max(...ring.map((p) => p[1])) / UNIT_M + pad,
    }
  : undefined;

const svg = renderSVG(model, { placemaker: [lot], ...(bounds ? { bounds } : {}) });
const name = `plan-${plan.generator}`;
writeFileSync(`out/${name}.svg`, svg);

// 绿篱在 2D 里是一个 `<line stroke-linecap="round">`。
// 注意别只匹配 `stroke-linecap="round"`：园路是 `<polyline>`，也用圆头，会把数目算大 4 倍。
const bars = (svg.match(/<line [^>]*stroke-linecap="round"/g) ?? []).length;
console.log(`[plan] ${plan.generator}  网格 ${model.patches.length} 块  绿篱 ${bars} 段`);
if (bars === 0 && meta.generator === 'formalGarden') {
  console.log('[plan] 不对：formalGarden 应该有几十段绿篱。2D 那边是不是又把 `bar` 分支吞了？');
}

await sharp(Buffer.from(svg), { density: 150 }).resize({ width: 1200 }).png().toFile(`out/${name}.png`);
console.log(`[plan] out/${name}.{svg,png}`);
