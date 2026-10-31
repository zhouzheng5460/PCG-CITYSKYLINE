// 放大一块地的**局部**再看：整块地那个尺度下，2.6 m 的台地不到 2 像素。
//
// 跑：
//   npx tsx tools/zoom-pm.ts carYard 74 14 12     # 生成器/全名、平面中心、半窗（米）
//   npx tsx tools/zoom-pm.ts park 60 40 20
//
// 和 inspect-pm 的分工：那个自动贴到整块地（判"铺装/绿化整体对不对"），
// 这个贴到 ±N 米的小窗（判"料堆有没有真的立起来、道具是不是踩在堆上"）。
//
// 实现上按**三角形中心**裁窗口，不是按顶点：`build3d` 会把同类道具合并成一个
// 整块网格，按"顶点全在窗内"筛会把它们整组丢掉（第一次就是这么只看见 terraform 的）。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { Model } from '../src/town/model';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { buildTownMeshes } from '../src/export/build3d';
import { renderPrimitives } from '../test/soft3d';
import type { Primitive } from '../src/export/mesh';
import type { PlacemakerPlan } from '../src/bridge/placemaker';

interface Meta {
  name: string; generator: string; patch: number; nPatches: number; citySeed: number;
  layout: 'grid' | 'field' | 'radial' | 'tensor'; origin: [number, number];
  lotRing?: [number, number][]; keepBuildings?: boolean;
}

const [, , want = 'carYard', cx = '0', cz = '0', half = '12'] = process.argv;
const index = JSON.parse(readFileSync('src/bridge/data/index.json', 'utf8')) as Meta[];
// 全名优先；只给生成器名时取面积最大的那份（`--keep` 的件会更大，正好是更全的那个）
const meta = index.find((m) => m.name === want)
  ?? index.filter((m) => m.generator === want).sort((a, b) => a.name.localeCompare(b.name))[0];
if (!meta) {
  console.error(`[zoom] 索引里没有 "${want}"`);
  process.exit(2);
}
const planPath = `src/bridge/data/${meta.name}.plan.json`;
if (!existsSync(planPath)) {
  console.error(`[zoom] 找不到 ${planPath}`);
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PlacemakerPlan;

const model = new Model({ nPatches: meta.nPatches, seed: meta.citySeed, layout: meta.layout });
model.generate();

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

// 窗口中心：Plan 坐标（米）+ 地块原点
const k = 1 / UNIT_M;
const wx = Number(cx) * k + meta.origin[0];
const wz = Number(cz) * k + meta.origin[1];
const h = Number(half) * k;

const near: Primitive[] = [];
for (const p of meshes) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const remap = new Map<number, number>();
  for (let t = 0; t < p.indices.length; t += 3) {
    let mx = 0;
    let mz = 0;
    let far = false;
    for (let q = 0; q < 3; q++) {
      const vi = p.indices[t + q];
      const x = p.positions[vi * 3];
      const z = p.positions[vi * 3 + 2];
      mx += x;
      mz += z;
      // 大块地面三角形的中心可能落在窗口里，但顶点伸到地块尽头 —— 会撑爆取景
      if (Math.abs(x - wx) > h * 2 || Math.abs(z - wz) > h * 2) far = true;
    }
    if (far) continue;
    mx /= 3;
    mz /= 3;
    if (Math.abs(mx - wx) > h || Math.abs(mz - wz) > h) continue;
    for (let q = 0; q < 3; q++) {
      const vi = p.indices[t + q];
      let ni = remap.get(vi);
      if (ni === undefined) {
        ni = pos.length / 3;
        remap.set(vi, ni);
        pos.push(p.positions[vi * 3], p.positions[vi * 3 + 1], p.positions[vi * 3 + 2]);
        nrm.push(p.normals[vi * 3], p.normals[vi * 3 + 1], p.normals[vi * 3 + 2]);
      }
      idx.push(ni);
    }
  }
  if (idx.length) near.push({ ...p, positions: pos, normals: nrm, indices: idx });
}

const tris = near.reduce((s, p) => s + p.indices.length / 3, 0);
console.log(`[zoom] ${meta.name} @ ${cx},${cz} ±${half}m  网格 ${near.length}  三角形 ${tris}`);
const byGroup: Record<string, number> = {};
for (const p of near) byGroup[p.group] = (byGroup[p.group] ?? 0) + p.indices.length / 3;
for (const [g, n] of Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${g.padEnd(28)} ${n}`);
}

mkdirSync('out', { recursive: true });
for (const [tag, az, el] of [['iso', 35, 24], ['side', 10, 6]] as const) {
  const img = renderPrimitives(near, { size: 900, azimuth: az, elevation: el });
  const file = `out/zoom-${meta.name}-${tag}.png`;
  await sharp(Buffer.from(img.rgba), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png().toFile(file);
  console.log(`[zoom] ${file}`);
}
