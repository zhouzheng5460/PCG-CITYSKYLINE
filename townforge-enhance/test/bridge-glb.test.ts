// Placemaker 规划的地块 → TownForge 的 GLB。这是"接上了"的最终判据。
//
// 跑：npx tsx test/bridge-glb.test.ts
// 前置：npx tsx tools/bake-plan.ts   （产出 src/bridge/data/*.plan.json + *.meta.json）
//
// 和 placemaker.test.ts 的分工：
//   placemaker.test.ts  只管"Plan → Scene 片段"的几何正确性（尺度、方向、绕序、自交）
//   本文件              管"进了 GLB 之后还对不对"（三角形绕序、节点分组、体积、看得见）
//
// 绕序是最容易在桥接里悄悄错掉的一项：Placemaker 的环是 CCW，TownForge 的 earcut 也是
// CCW 输入，但两边对"高度轴"的约定不同（Placemaker 的 y 是高度、TownForge 的 Pt.y 是平面）。
// 一旦映射错了就会得到整片朝下的面 —— 渲染器里看着像"消失"，而几何计数全是对的。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../src/town/model';
import { Pt } from '../src/core/geom';
import { buildTownMeshes } from '../src/export/build3d';
import { checkWinding, exportGLB } from '../src/export/glb';
import { renderPrimitives } from './soft3d';
import type { PlacemakerPlan } from '../src/bridge/placemaker';
import type { PlacemakerLot } from '../src/scene/build';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = join(root, 'src/bridge/data');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

interface BakeMeta {
  name: string; generator?: string; patch: number; nPatches: number; citySeed: number;
  layout: 'grid' | 'field' | 'radial' | 'tensor'; origin: [number, number];
  sizeM: [number, number]; areaM2: number; lotRing?: [number, number][];
  /** 烘焙时用 `--keep` 保留了原地块的建筑（Plan 已经绕着它们裁过） */
  keepBuildings?: boolean;
}

const indexPath = join(dataDir, 'index.json');
if (!existsSync(indexPath)) {
  console.error('[bridge-glb] 找不到 src/bridge/data/index.json');
  console.error('  先跑： npx tsx tools/bake-plan.ts');
  process.exit(2);
}

// 不硬编码文件名：地块编号会随 city 重建而变（generate() 与 buildPatches+buildAll 的
// patch 顺序不一定一样），写死名字就会读到过期的形状。
// 按生成器 id 取（默认 parking）——同一块地现在烘了十几个生成器，面积完全一样，
// "取面积最大的那个"已经选不出东西来了。
const bakeIndex = JSON.parse(readFileSync(indexPath, 'utf8')) as BakeMeta[];
const wanted = process.env.PM_BAKE;
const wantGen = process.env.PM_GEN ?? 'parking';
const meta =
  (wanted ? bakeIndex.find((m) => m.name === wanted) : undefined)
  // 默认取"整块换掉"的那份：`--keep` 的件是围着原地块建筑裁过的，
  // 拿它当基线会把"被楼切掉的铺装"当成正常形态（专门验它的是 bridge-obstacles.test.ts）。
  ?? bakeIndex.find((m) => m.generator === wantGen && !m.keepBuildings)
  ?? bakeIndex.find((m) => m.generator === wantGen)
  ?? bakeIndex[0];
if (!meta) {
  console.error('[bridge-glb] index.json 是空的，先跑 npx tsx tools/bake-plan.ts');
  process.exit(2);
}

const planPath = join(dataDir, `${meta.name}.plan.json`);
if (!existsSync(planPath)) {
  console.error(`[bridge-glb] 找不到 ${planPath}`);
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PlacemakerPlan;

let failures = 0;
let pass = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; return; }
  failures++;
  console.log(`  FAIL ${name} ${detail}`);
};

// ─────────────────────────────────────────────────────────── 建城（参数必须和烘焙时一致）

const model = new Model({ nPatches: meta.nPatches, seed: meta.citySeed, layout: meta.layout });
model.generate();

console.log(`城市 n=${meta.nPatches} seed=${meta.citySeed} layout=${meta.layout}`);
console.log(`接管地块 #${meta.patch}  ${meta.areaM2} m²  Plan: ${plan.generator} / ${plan.objects.length} 对象`);

// ─────────────────────────────────────────────────────────── 基线：不用 Placemaker 的同一座城

const baseMeshes = buildTownMeshes(model, {});
const baseTris = baseMeshes.reduce((s, p) => s + p.indices.length / 3, 0);

// ─────────────────────────────────────────────────────────── 接管

const lot: PlacemakerLot = {
  plan,
  origin: new Pt(meta.origin[0], meta.origin[1]),
  patchIndex: meta.patch,
  group: 'pm',
  // 草地底：绿地类生成器不铺地面，靠这一环。parking 自己铺满，加了也看不出来。
  ...(meta.lotRing ? { lotRing: meta.lotRing } : {}),
  // --keep 的烘焙件：Plan 是绕着原地块建筑生成的，场景必须把楼留下来，
  // 否则铺装中间会留下一块块和楼一样大的洞（PM_BAKE=city24-s8-p90-plaza 可复现）。
  ...(meta.keepBuildings ? { keepBuildings: true } : {}),
};

const pmMeshes = buildTownMeshes(model, { placemaker: [lot] });
const pmTris = pmMeshes.reduce((s, p) => s + p.indices.length / 3, 0);

console.log(`\n三角形  ${baseTris} → ${pmTris}  (${((pmTris / baseTris - 1) * 100).toFixed(1)}%)`);
console.log(`网格    ${baseMeshes.length} → ${pmMeshes.length}`);

// ─────────────────────────────────────────────────────────── 断言

check('接管后网格数不为零', pmMeshes.length > 0, String(pmMeshes.length));
check('接管后三角形数增加（说明内容真的进来了）', pmTris > baseTris, `${baseTris} → ${pmTris}`);

// 绕序：每一个三角形都要朝外
let badTris = 0;
for (const p of pmMeshes) badTris += checkWinding(p);
check('绕序全部正确', badTris === 0, `${badTris} 个三角形法线朝下`);

// 分组：Placemaker 的内容必须能按 group 在 DCC 里单独选中
const pmGroups = new Set(pmMeshes.filter((p) => p.group.startsWith('pm/')).map((p) => p.group));
check('有 pm/* 分组', pmGroups.size >= 2, [...pmGroups].join(' '));
// 草地底：给了 lotRing 就必须有一层 ground（绿地生成器全靠它，parking 也有但不显眼）
if (meta.lotRing) {
  check('有草地底分组', [...pmGroups].some((g) => g.includes('surface/ground')), [...pmGroups].join(' '));
}
// 车位线只有 parking 才有；用 PM_GEN 换成公园时这条不该跟着失败
if (plan.objects.some((o) => o.role === 'parkingBay')) {
  check('有车位线分组', [...pmGroups].some((g) => g.includes('marking/bay')), [...pmGroups].join(' '));
}

// 覆盖：原本那块地的 TownForge 内容应该消失了（否则会两层铺装打架）
const coveredSurfaceCount = (m: ReturnType<typeof buildTownMeshes>) =>
  m.filter((p) => p.group.startsWith('lot/')).length;
const baseLotGroups = coveredSurfaceCount(baseMeshes);
const pmLotGroups = coveredSurfaceCount(pmMeshes);
check('原地块内容已被让出', pmLotGroups <= baseLotGroups, `${baseLotGroups} → ${pmLotGroups}`);

// Placemaker 的内容不能跑出城市太远（坐标映射错了会飞到几万单位外）
let farPts = 0;
for (const p of pmMeshes) {
  if (!p.group.startsWith('pm/')) continue;
  for (let i = 0; i < p.positions.length; i += 3) {
    const x = p.positions[i], z = p.positions[i + 2];
    if (Math.abs(x) > 500 || Math.abs(z) > 500) farPts++;
  }
}
check('没有飞出去的顶点', farPts === 0, `${farPts} 个顶点在 ±500 之外`);

// ─────────────────────────────────────────────────────────── 导出 GLB

const glb = exportGLB(pmMeshes, 'townforge-pm');
const glbPath = join(outDir, `${meta.name}.glb`);
writeFileSync(glbPath, glb.bytes);

const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
check('GLB magic', dv.getUint32(0, true) === 0x46546c67);
check('GLB 长度字段自洽', dv.getUint32(8, true) === glb.bytes.byteLength);

console.log(`\nGLB     ${(glb.bytes.byteLength / 1024 / 1024).toFixed(2)} MB  →  ${glbPath}`);

// ─────────────────────────────────────────────────────────── 出图

import sharp from 'sharp';

const shot = renderPrimitives(pmMeshes, { size: 900, azimuth: 40, elevation: 34 });
await sharp(Buffer.from(shot.rgba), { raw: { width: shot.width, height: shot.height, channels: 4 } })
  .png().toFile(join(outDir, `${meta.name}-3d.png`));

const top = renderPrimitives(pmMeshes, { size: 900, azimuth: 0, elevation: 89, zoom: 1.35 });
await sharp(Buffer.from(top.rgba), { raw: { width: top.width, height: top.height, channels: 4 } })
  .png().toFile(join(outDir, `${meta.name}-top.png`));

console.log(`图      ${join(outDir, `${meta.name}-3d.png`)}`);
console.log(`        ${join(outDir, `${meta.name}-top.png`)}`);

console.log(`\n断言    ${pass} 通过 / ${failures} 失败`);
if (failures > 0) process.exit(1);
console.log('全部通过。');
