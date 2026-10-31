// 面积口径的测试：`src/bridge/area.ts` 是"铺了多少地"的唯一算法。
//
// 跑：npx tsx test/area.test.ts
//
// 这里踩过两次坑，每次都是**算错了但看起来像真的数据**：
//   1. 各面直接相加 → 分层叠放的方案算出 120%，误判成"铺装溢出了地块"；
//   2. 并集时把洞也加进去 → 绕开建筑的方案算出 146%（union > sum），比 1 更离谱。
// 所以这两个方向都要有断言钉住。

import { ringArea, signedRingArea, sumArea, unionArea } from '../src/bridge/area';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

type R = [number, number][];
const rect = (x0: number, y0: number, w: number, h: number): R =>
  [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];

// ─────────────────────────────────────────────────────────── 1. 基本面积

{
  ok(near(ringArea(rect(0, 0, 10, 5)), 50), '10×5 矩形 = 50 m²', String(ringArea(rect(0, 0, 10, 5))));
  // 顶点顺序反了，面积不该变（abs）
  const cw = [...rect(0, 0, 10, 5)].reverse();
  ok(near(ringArea(cw), 50), '顺时针顶点面积相同', String(ringArea(cw)));
  ok(signedRingArea(cw) < 0, '顺时针的带符号面积为负', String(signedRingArea(cw)));
  ok(signedRingArea(rect(0, 0, 10, 5)) > 0, '逆时针的带符号面积为正');
  ok(ringArea([[0, 0], [1, 1]]) === 0, '点数不足返回 0');
  ok(ringArea([]) === 0, '空环返回 0');
}

// ─────────────────────────────────────────────────────────── 2. 相加 vs 并集

{
  const a = rect(0, 0, 10, 10);   // 100
  const b = rect(5, 0, 10, 10);   // 100，与 a 重叠 5×10 = 50
  ok(near(sumArea([a, b]), 200), '简单相加 = 200', String(sumArea([a, b])));
  const u = unionArea([a, b]);
  ok(u.ok, '并集计算成功');
  ok(near(u.area, 150), '并集 = 150（重叠只算一次）', String(u.area));
  ok(near(sumArea([a, b]) / u.area, 200 / 150, 1e-6), '层数 = 相加/并集 = 1.33');
}

// ─────────────────────────────────────────────────────────── 3. 洞必须减掉

{
  // 大环套小环：铺装绕开一栋楼，polygon-clipping 会把它表达成 [外环, 洞]
  const outer = rect(0, 0, 20, 20);   // 400
  const hole = rect(5, 5, 10, 10);    // 100，顺时针
  // 直接把两个环的绝对值相加会得到 500（错误），带符号相加才是 300
  ok(near(ringArea(outer) + ringArea([...hole].reverse()), 500), '取绝对值相加 = 500（错误口径）');
  const signed = signedRingArea(outer) + signedRingArea([...hole].reverse());
  ok(near(Math.abs(signed), 300), '带符号相加 = 300（洞被扣掉）', String(signed));

  // 用 union 造一个带洞的真实情形：四块拼成回字形，中间空出来
  const ring4: R[] = [
    rect(0, 0, 20, 5),     // 下
    rect(0, 15, 20, 5),    // 上
    rect(0, 5, 5, 10),     // 左
    rect(15, 5, 5, 10),    // 右
  ];
  const u = unionArea(ring4);
  ok(u.ok, '回字形并集计算成功');
  // 四块互不重叠，自身合计 300；并集把它们拼成一个带洞的多边形，
  // 正确的并集仍是 300。若实现把洞当正面积加，会错成 400+100=500。
  ok(near(u.area, 400 - 100), '回字形并集 = 300（中间 100 是空的，洞必须扣掉）', String(u.area));
  ok(near(sumArea(ring4), 300), '四块简单相加 = 300', String(sumArea(ring4)));
}

// ─────────────────────────────────────────────────────────── 4. 退化输入不炸

{
  ok(unionArea([]).area === 0, '空输入 = 0');
  ok(unionArea([rect(0, 0, 4, 4)]).area === 16, '单个环直接返回它的面积');
  const u = unionArea([rect(0, 0, 4, 4), [[0, 0], [1, 0]] as R]);
  ok(u.ok && near(u.area, 16), '点数不足的环被忽略，不影响结果', String(u.area));
}

console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log('全部通过。');
