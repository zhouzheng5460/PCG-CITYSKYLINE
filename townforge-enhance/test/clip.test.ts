// 按建筑裁剪方案的测试：`clipPlanToBuildings` 是"路网型生成器"能不能用的关键。
//
// 跑：npx tsx test/clip.test.ts
//
// 要守住的四件事：
//   1) 铺装不许压楼（差集要真的生效，退化时宁可丢块）；
//   2) 楼里的对象要丢掉（灯、树、车位长在楼里没意义）；
//   3) 跨楼的渠要**切成段**保留，而不是整条删 —— 这条是这套方案存在的理由：
//      SiteSafety 是整条删，一块地上 53 条车道会只剩 1 条；
//   4) 裁完不能还有渠穿楼（否则 3D 里就是穿模）。

import { clipPlanToBuildings } from '../src/bridge/clip';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

type R = [number, number][];
const rect = (x0: number, y0: number, w: number, h: number): R =>
  [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
const line = (x0: number, y0: number, x1: number, y1: number) => ({
  role: 'driveAisle',
  a: [x0, y0] as [number, number],
  b: [x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3] as [number, number],
  c: [x0 + ((x1 - x0) * 2) / 3, y0 + ((y1 - y0) * 2) / 3] as [number, number],
  d: [x1, y1] as [number, number],
});

const makePlan = () => ({
  surfaces: [{ role: 'asphalt', ring: rect(0, 0, 100, 100) }],   // 10000 m²
  nets: [
    line(0, 50, 100, 50),    // 横穿建筑（楼在 y 40..60）
    line(0, 80, 100, 80),    // 完全在楼外
  ],
  objects: [
    { role: 'parkingBay', x: 10, z: 10 },    // 楼外
    { role: 'parkingBay', x: 50, z: 50 },    // 楼里 → 丢
    { role: 'tree', x: 45, z: 45 },          // 楼里 → 丢
  ],
});

const BLD = rect(40, 40, 20, 20);   // 400 m²

// ─────────────────────────────────────────────────────────── 1. 铺装：差集

{
  const { plan, stats } = clipPlanToBuildings(makePlan(), [BLD]);
  ok(plan.surfaces.length >= 1, '差集后仍有铺装', `${plan.surfaces.length} 面`);
  ok(near(stats.surfaceCutArea, 400, 1), '切掉的面积 = 建筑面积', stats.surfaceCutArea.toFixed(1));
  ok(stats.surfaceRejected === 0, '没有退化面被拒收', String(stats.surfaceRejected));

  // 关键：差集结果不能与建筑重叠
  let worst = 0;
  for (const s of plan.surfaces) {
    for (const q of [BLD]) {
      // 简单的点采样估计（这里只需要知道"有没有"，不需要精确面积）
      // 采样点避开楼的边界：射线法对正好落在边上的点判定不稳定，
      // 用它当"穿模证据"会得到假阳性（边界点被算成 inside）。
      for (let x = q[0][0] + 0.5; x <= q[1][0] - 0.5; x += 1) {
        for (let y = q[0][1] + 0.5; y <= q[2][1] - 0.5; y += 1) {
          let inside = false;
          const ring = s.ring;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
          }
          if (inside) worst++;
        }
      }
    }
  }
  ok(worst === 0, '铺装没有一个采样点落在楼里', `${worst} 个点`);
}

// ─────────────────────────────────────────────────────────── 2. 对象：楼里的丢掉

{
  const { plan, stats } = clipPlanToBuildings(makePlan(), [BLD]);
  ok(plan.objects.length === 1, '楼里的对象被丢掉，楼外的留下', `${plan.objects.length} 个`);
  ok(stats.objDropped === 2, '记录丢了 2 个', String(stats.objDropped));
  ok(plan.objects[0].x === 10, '留下的是楼外那个');
}

// ─────────────────────────────────────────────────────────── 3. 渠：切段而不是整条删

{
  const { plan, stats } = clipPlanToBuildings(makePlan(), [BLD], { samples: 20 });
  ok(stats.netDropped === 0, '没有整条被丢（关键：不像 SiteSafety 那样删干净）', String(stats.netDropped));
  ok(stats.netSplit > 0, '横穿建筑的那条被切成了多段', String(stats.netSplit));
  ok(plan.nets.length >= 2, '最终至少保留了被切开的段 + 楼外那条', `${plan.nets.length} 条`);

  // 保留长度应该接近 100（楼外那条）+ 80（被切后剩下的两段，楼宽 20）
  const total = plan.nets.reduce((s, n) =>
    s + Math.hypot(n.d[0] - n.a[0], n.d[1] - n.a[1]), 0);
  ok(total > 170 && total < 210, '保留的渠总长接近 180 m', total.toFixed(1));
}

// ─────────────────────────────────────────────────────────── 4. 裁完不许穿楼

{
  const { stats } = clipPlanToBuildings(makePlan(), [BLD], { samples: 24 });
  ok(stats.netResidualLen < 1, '裁剪后没有残留穿楼的渠', `${stats.netResidualLen.toFixed(2)} m`);
}

// ─────────────────────────────────────────────────────────── 5. 没有建筑时原样通过

{
  const base = makePlan();
  const { plan, stats } = clipPlanToBuildings(base, []);
  ok(plan === base, '无建筑时直接返回原对象（不改几何）');
  ok(stats.objDropped === 0 && stats.netDropped === 0, '无建筑时不丢任何东西');
  ok(stats.surfacesOut === 1, '铺装面数不变');
}

// ─────────────────────────────────────────────────────────── 6. 整条都在楼里：丢掉

{
  const p = {
    surfaces: [],
    nets: [line(42, 50, 58, 50)],      // 完全在楼内
    objects: [],
  };
  const { plan, stats } = clipPlanToBuildings(p, [BLD], { samples: 12 });
  ok(plan.nets.length === 0, '整条在楼里的渠被丢掉', `${plan.nets.length} 条`);
  ok(stats.netDropped === 1, '记为丢弃 1 条', String(stats.netDropped));
}

console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log('全部通过。');
