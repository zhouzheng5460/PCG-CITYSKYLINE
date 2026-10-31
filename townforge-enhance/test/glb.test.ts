import { writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { Model } from '../src/town/model';
import { buildTownMeshes } from '../src/export/build3d';
import { exportGLB, checkWinding } from '../src/export/glb';
import { mergePrimitives } from '../src/export/mesh';
import { renderPrimitives } from './soft3d';
import { makeZone } from '../src/town/zones';
import { Pt } from '../src/core/geom';

mkdirSync('out', { recursive: true });

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const zone = makeZone('z1', '禁建', { kind: 'rect', a: new Pt(-45, -20), b: new Pt(-10, 25) });

// 顶点焊接单元测试：两个共享一条边的四边形（同法线），焊后应剩 6 个顶点（8−2 共享）
{
  const mk = (ox: number) => ({
    name: 'q',
    group: 'g',
    positions: [ox + 0, 0, 0, ox + 1, 0, 0, ox + 1, 0, 1, ox + 0, 0, 1],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    color: [1, 1, 1] as [number, number, number],
  });
  const merged = mergePrimitives([mk(0), mk(1)], 'm', 'g')!;
  const vc = merged.positions.length / 3;
  check('顶点焊接：共享边合并', vc === 6, `实际 ${vc}`);
  check('顶点焊接：三角形数不变', merged.indices.length === 12, `${merged.indices.length}`);
}

const cases: { name: string; opts: ConstructorParameters<typeof Model>[0] }[] = [
  { name: 'glb-city', opts: { nPatches: 15, seed: 682063530, plaza: true } },
  { name: 'glb-zone', opts: { nPatches: 15, seed: 682063530, plaza: true, zones: [zone] } },
];

for (const c of cases) {
  const m = new Model(c.opts);
  m.generate();
  const prims = buildTownMeshes(m, { heightScale: 1 });

  // 绕序自检
  let badTris = 0;
  for (const p of prims) badTris += checkWinding(p);
  const totalTris = prims.reduce((s, p) => s + p.indices.length / 3, 0);
  console.log(`${c.name}: ${prims.length} 网格 / ${totalTris} 三角形 / 绕序异常 ${badTris}`);
  check('绕序全部正确', badTris === 0, `${badTris}`);

  const glb = exportGLB(prims, 'townforge');
  writeFileSync(`out/${c.name}.glb`, glb.bytes);

  // 结构校验
  const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
  check('GLB magic', dv.getUint32(0, true) === 0x46546c67);
  check('GLB version=2', dv.getUint32(4, true) === 2);
  check('GLB length 字段正确', dv.getUint32(8, true) === glb.bytes.byteLength, `${dv.getUint32(8, true)} vs ${glb.bytes.byteLength}`);

  const jsonLen = dv.getUint32(12, true);
  check('JSON chunk 类型', dv.getUint32(16, true) === 0x4e4f534a);
  const jsonText = new TextDecoder().decode(glb.bytes.subarray(20, 20 + jsonLen));
  const gltf = JSON.parse(jsonText);
  check('glTF 版本 2.0', gltf.asset.version === '2.0');
  check('有 mesh', gltf.meshes.length === prims.length, `${gltf.meshes.length} vs ${prims.length}`);

  // 索引分量类型：顶点 < 65536 的网格用 Uint16(5123)，否则 Uint32(5125)
  let u16 = 0;
  let u32 = 0;
  let badComp = 0;
  for (let i = 0; i < gltf.meshes.length; i++) {
    const idxAcc = gltf.meshes[i].primitives[0].indices;
    const ct = gltf.accessors[idxAcc].componentType;
    const expect = prims[i].positions.length / 3 < 65536 ? 5123 : 5125;
    if (ct !== expect) badComp++;
    if (ct === 5123) u16++;
    else u32++;
  }
  check('索引分量类型正确', badComp === 0, `${badComp}`);
  console.log(`  索引: Uint16 ${u16} 网格 / Uint32 ${u32} 网格`);

  const binOffset = 20 + jsonLen;
  const binLen = dv.getUint32(binOffset, true);
  check('BIN chunk 类型', dv.getUint32(binOffset + 4, true) === 0x004e4942);
  check('BIN 长度与 buffer 声明一致', binLen >= gltf.buffers[0].byteLength);

  // accessor 越界检查
  let oob = 0;
  for (const acc of gltf.accessors) {
    const bv = gltf.bufferViews[acc.bufferView];
    const compSize = acc.componentType === 5123 ? 2 : 4;
    const numComp = acc.type === 'VEC3' ? 3 : 1;
    if (bv.byteOffset + bv.byteLength > gltf.buffers[0].byteLength) oob++;
    if (acc.byteOffset + acc.count * numComp * compSize > bv.byteLength) oob++;
  }
  check('accessor 未越界', oob === 0, `${oob}`);

  console.log(`  GLB ${(glb.bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // 软件渲染验证：全景轴测 + 俯视 + 近景
  const img = renderPrimitives(prims, { size: 900, azimuth: 40, elevation: 32 });
  await sharp(Buffer.from(img.rgba), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(`out/${c.name}.png`);

  const top = renderPrimitives(prims, { size: 900, azimuth: 0, elevation: 89, zoom: 1.5 });
  await sharp(Buffer.from(top.rgba), { raw: { width: top.width, height: top.height, channels: 4 } })
    .png()
    .toFile(`out/${c.name}-top.png`);

  const close = renderPrimitives(prims, { size: 900, azimuth: 20, elevation: 45, zoom: 3.2 });
  await sharp(Buffer.from(close.rgba), { raw: { width: close.width, height: close.height, channels: 4 } })
    .png()
    .toFile(`out/${c.name}-close.png`);
  console.log(`  rendered out/${c.name}.png / -top / -close`);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
