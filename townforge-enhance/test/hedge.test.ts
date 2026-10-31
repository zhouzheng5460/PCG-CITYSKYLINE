// `fitHedgeBars` 的单元测试：把成排的灌木拟合成绿篱。
//
// 跑：npx tsx test/hedge.test.ts
//
// 这一组全用**手造的坐标**，不读烘焙数据 —— 拟合规则本身要能单独验，
// 不然改阈值只能靠"看图上像不像"，谁也不敢动。
//
// 要守住的三件事：
//   1) 真成排的（同 yaw、等距共线）必须连起来，且连出来的段位置/长度对；
//   2) 随手撒的（yaw 不一致，或者间隔乱）**不能**连 —— 假阳性会让半片林地凭空
//      长出十几段绿篱，比不连更糟；
//   3) 相邻但平行的两条线不能串成一段（花床和花床之间那条空档必须留着）。

import { fitHedgeBars, yawToDir } from '../src/bridge/hedge';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

const D = Math.PI / 180;
/** 一排沿 +x 的灌木，间距 step，yaw = 90°（法向朝 +z，所以走向是 +x）。 */
const row = (n: number, step = 3.3, x0 = 0, z0 = 0, yaw = 90 * D) =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, z: z0, yaw }));

const lenOf = (b: { a: [number, number]; b: [number, number] }) =>
  Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ─────────────────────────────────────────────────────────── 1. 该连的连上

{
  const r = fitHedgeBars(row(5));
  ok(r.bars.length === 1, '5 颗等距同向 → 1 段绿篱', `${r.bars.length} 段`);
  const b = r.bars[0];
  // 4 个间隔 3.3 = 13.2，两头各延长半身位 0.75
  ok(near(lenOf(b), 13.2 + 1.5, 0.05), '段长 = 跨距 + 一个身位', lenOf(b).toFixed(2));
  ok(near(Math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0]), 0, 1e-9), '走向是 +x', String(b.dir));
  ok(r.inRun.every(Boolean), '5 颗全被吸收', r.inRun.map(Number).join(''));
}

{
  // yaw 是法向：改成 0° 时这条线应该沿 z 走
  const col = Array.from({ length: 4 }, (_, i) => ({ x: 5, z: i * 3, yaw: 0 }));
  const r = fitHedgeBars(col);
  ok(r.bars.length === 1, '竖向排列也认', `${r.bars.length} 段`);
  const d = Math.atan2(r.bars[0].b[1] - r.bars[0].a[1], r.bars[0].b[0] - r.bars[0].a[0]);
  ok(near(Math.abs(d), Math.PI / 2, 1e-6), '走向是 ±z', d.toFixed(4));
  ok(near(r.bars[0].a[0], 5, 0.01), '段的 x 落在原来那条线上', String(r.bars[0].a[0]));
}

ok(near(yawToDir(90 * D), 0, 1e-12), 'yaw → 走向 = yaw − 90°', String(yawToDir(90 * D)));

{
  // 反向法向（yaw 与 90° 等价，差 180°）应该落在同一组，不被切成两段
  const mixed = [
    { x: 0, z: 0, yaw: 90 * D },
    { x: 3.3, z: 0, yaw: -90 * D },
    { x: 6.6, z: 0, yaw: 270 * D },
    { x: 9.9, z: 0, yaw: 90 * D },
  ];
  const r = fitHedgeBars(mixed);
  ok(r.bars.length === 1, 'yaw 差 180° 视为同一条线（法向朝里朝外等价）', `${r.bars.length} 段`);
}

// ─────────────────────────────────────────────────────────── 2. 不该连的别乱连

{
  // 只有 2 颗同向：不够 minYawGroup，保持散点
  const r = fitHedgeBars(row(2));
  ok(r.bars.length === 0, '2 颗同向不连（凑巧而已）', `${r.bars.length} 段`);
  ok(r.inRun.every((v) => !v), '2 颗都不被吸收');
}

{
  // 4 颗密但每颗朝向都不同 —— 就是 park / natureReserve 那种随手撒
  const scatter = Array.from({ length: 12 }, (_, i) => ({
    x: (i * 7.3) % 40,
    z: (i * 11.9) % 40,
    yaw: (i * 47) * D,
  }));
  const r = fitHedgeBars(scatter);
  ok(r.bars.length === 0, 'yaw 各不相同的散点不连', `${r.bars.length} 段`);
}

{
  // 同向、但间隔忽大忽小到断开：一段 3.3，然后空 30 m，再来一段
  const split = [
    { x: 0, z: 0, yaw: 90 * D },
    { x: 3.3, z: 0, yaw: 90 * D },
    { x: 6.6, z: 0, yaw: 90 * D },
    { x: 36.6, z: 0, yaw: 90 * D },
    { x: 39.9, z: 0, yaw: 90 * D },
    { x: 43.2, z: 0, yaw: 90 * D },
  ];
  const r = fitHedgeBars(split);
  ok(r.bars.length === 2, '中间空 30 m → 切成两段', `${r.bars.length} 段`);
  const spans = r.bars.map(lenOf).sort((a, b) => a - b);
  ok(spans.every((s) => near(s, 6.6 + 1.5, 0.05)), '两段长度都 = 跨距 + 一个身位', spans.map((s) => s.toFixed(1)).join(','));
}

{
  // 两条平行线相距 5 m，各自 4 颗同向 —— 必须各成一段，不能连成一条斜线
  const a = Array.from({ length: 4 }, (_, i) => ({ x: i * 3.3, z: 0, yaw: 90 * D }));
  const b = Array.from({ length: 4 }, (_, i) => ({ x: i * 3.3, z: 5, yaw: 90 * D }));
  const r = fitHedgeBars([...a, ...b]);
  ok(r.bars.length === 2, '两条平行线各成一段（法向分桶）', `${r.bars.length} 段`);
  const zs = r.bars.map((x) => x.a[1]).sort();
  ok(near(zs[0], 0, 0.3) && near(zs[1], 5, 0.3), '两段的 z 分别落在 0 和 5', zs.map((z) => z.toFixed(2)).join(','));
}

{
  // 长边 + 短边（矩形花床的典型形状）：短边只有 2 颗也得连
  const rect = [
    // 下边（法向朝 -z → yaw 90 也行，取模 180 等价）
    { x: 0, z: 0, yaw: 90 * D },
    { x: 3.3, z: 0, yaw: 90 * D },
    { x: 6.6, z: 0, yaw: 90 * D },
    // 上边
    { x: 0, z: 6, yaw: 90 * D },
    { x: 3.3, z: 6, yaw: 90 * D },
    { x: 6.6, z: 6, yaw: 90 * D },
    // 左边 2 颗（法向朝 -x → yaw 0）
    { x: 0, z: 3, yaw: 0 },
    { x: 0, z: 6, yaw: 0 },
    // 右边 2 颗
    { x: 6.6, z: 3, yaw: 0 },
    { x: 6.6, z: 6, yaw: 0 },
  ];
  const r = fitHedgeBars(rect);
  ok(r.bars.length === 4, '矩形花床 → 四条边各一段', `${r.bars.length} 段`);
  ok(r.inRun.every(Boolean), '10 颗全被吸收', `${r.inRun.filter(Boolean).length}/10`);
}

{
  // 整体闸：成排的 8 颗（同向）+ 一批朝向铺满角度区间的散点。
  // 一旦朝向种类超过区间的一定比例，就判定这份 Plan 是"随机旋转"，整份都不连。
  const designed = row(8);
  const rotated = Array.from({ length: 30 }, (_, i) => ({ x: (i * 13) % 60, z: (i * 29) % 60, yaw: i * 6 * D }));
  const only = fitHedgeBars(designed);
  const mixed = fitHedgeBars([...designed, ...rotated]);
  ok(only.bars.length === 1, '只有成排灌木时出 1 段');
  ok(mixed.bars.length === 0, '掺进朝向铺满区间的散点后整份不连（整体闸）', `${mixed.bars.length} 段`);
}

{
  // 两道闸都能单独关掉，方便排查"为什么这段没连上"
  const six = row(6);
  const spread = Array.from({ length: 30 }, (_, i) => ({ x: (i * 13) % 60, z: (i * 29) % 60, yaw: i * 6 * D }));
  ok(fitHedgeBars([...six, ...spread], { yawSpreadMax: 1 }).bars.length >= 1,
    'yawSpreadMax=1（关掉整体闸）后仍能连出成排的那 6 颗');
}

// ─────────────────────────────────────────────────────────── 3. 产物自身的合法性

{
  const r = fitHedgeBars(row(6));
  const b = r.bars[0];
  ok(lenOf(b) > 0, '段长 > 0');
  ok(b.members.length === 6, 'members 记全了被吸收的下标', String(b.members.length));
  ok(new Set(b.members).size === 6, 'members 不重复');
}

{
  // 同一份输入跑两次，产物必须逐位相同（Map 迭代顺序 / 排序不稳会露出来）
  const input = [...row(4), ...row(4, 3.3, 0, 8), ...Array.from({ length: 6 }, (_, i) => ({ x: i * 2, z: -9, yaw: 30 * D }))];
  const a = JSON.stringify(fitHedgeBars(input));
  const b = JSON.stringify(fitHedgeBars(input));
  ok(a === b, '纯函数：同一输入两次结果相同');
}

{
  // 阈值可调：把 minYawGroup 降到 2，两颗同向就该连
  const two = row(2);
  ok(fitHedgeBars(two).bars.length === 0, '默认不连两颗');
  ok(fitHedgeBars(two, { minYawGroup: 2 }).bars.length === 1, 'minYawGroup=2 时两颗也连');
}

// ─────────────────────────────────────────────────────────── 报告

if (fails.length) {
  console.log(`断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log(`断言 ${pass} 通过 / 0 失败`);
console.log('全部通过。');
