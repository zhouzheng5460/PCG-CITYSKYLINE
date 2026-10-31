// 未知角色报警的测试：确认"角色名对不上"这件事不会静默发生。
//
// 跑：npx tsx test/unknown-role.test.ts
//
// 背景：Emit.cs 的 RoleName 对未映射的枚举值兜底成 "other"，桥接的 PROP_BY_OBJECT 又把它
// 映射成 null（不画）——两层兜底叠起来，Core 将来加一个新角色时，元素会**无声消失**，
// 表现是"这个生成器怎么比预期少了几百个道具"，没人能定位。
//
// 这个测试守的就是：两条报警通道都得真的响。

import { readFileSync } from 'node:fs';
import { bridgePlan } from '../src/bridge/placemaker';
import type { PlacemakerPlan } from '../src/bridge/placemaker';
import { Pt } from '../src/core/geom';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

const DATA = 'src/bridge/data/city24-s8-p90-park.plan.json';
const base = JSON.parse(readFileSync(DATA, 'utf8')) as PlacemakerPlan;

/** 跑一次桥接，把 console.warn 全收下来。 */
function run(plan: PlacemakerPlan): { props: number; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  try {
    const r = bridgePlan(plan, { origin: new Pt(0, 0) });
    return { props: r.props.length, warns };
  } finally {
    console.warn = orig;
  }
}

const clone = (p: PlacemakerPlan): PlacemakerPlan => structuredClone(p);

// ─────────────────────────────────────────────────────────── 1. 干净数据不吵

{
  const { warns } = run(base);
  ok(warns.length === 0, '原始方案零警告', warns.join(' | '));
  ok(base.unknownRoles !== undefined, '烘焙产物带 unknownRoles 字段',
    String(base.unknownRoles));
  const u = base.unknownRoles!;
  ok((u.surfaces ?? 0) + (u.nets ?? 0) + (u.objects ?? 0) + (u.areas ?? 0) === 0,
    '原始方案 unknownRoles 全 0', JSON.stringify(u));
}

// ─────────────────────────────────────────────────────────── 2. 映射表不认识的角色

{
  const p = clone(base);
  p.objects = p.objects.slice(0, 40);
  const before = run(clone(p)).props;
  (p.objects[3] as { role: string }).role = 'ufoPad';
  const after = run(p);
  ok(after.warns.length === 1, '混入 1 个未知角色 → 1 条警告', `${after.warns.length} 条`);
  ok(/ufoPad/.test(after.warns[0] ?? ''), '警告里点名了那个角色', after.warns[0] ?? '');
  ok(/映射表不认识/.test(after.warns[0] ?? ''), '警告说明了原因', after.warns[0] ?? '');
  ok(after.props === before - 1, '该元素确实被丢掉（不是画了个错的）',
    `${before} → ${after.props}`);
}

// ─────────────────────────────────────────────────────────── 3. Driver 侧统计

{
  const p = clone(base);
  p.unknownRoles = { surfaces: 0, nets: 0, objects: 7, areas: 0 };
  const { warns } = run(p);
  ok(warns.length === 1, 'Driver 侧非零 → 1 条警告', `${warns.length} 条`);
  ok(/Driver 报告 7 个/.test(warns[0] ?? ''), '警告里带上了条数', warns[0] ?? '');
  ok(/Emit\.cs/.test(warns[0] ?? ''), '警告指了修的地方（Emit.cs 与映射表）', warns[0] ?? '');
}

// ─────────────────────────────────────────────────────────── 4. 两条通道同时命中

{
  const p = clone(base);
  p.objects = p.objects.slice(0, 40);
  (p.objects[3] as { role: string }).role = 'ufoPad';
  p.unknownRoles = { surfaces: 2, nets: 0, objects: 7, areas: 0 };
  const { warns } = run(p);
  ok(warns.length === 2, '两条通道各报一条', `${warns.length} 条`);
  ok(warns.some((w) => /Driver 报告 9 个/.test(w)), '总数按四通道求和（2+7=9）', warns.join(' | '));
  ok(warns.some((w) => /ufoPad/.test(w)), '另一条点名 ufoPad', warns.join(' | '));
}

// ─────────────────────────────────────────────────────────── 5. 全零的 unknownRoles 不吵

{
  const p = clone(base);
  p.unknownRoles = { surfaces: 0, nets: 0, objects: 0, areas: 0 };
  const { warns } = run(p);
  ok(warns.length === 0, '全 0 的 unknownRoles 不产生警告', warns.join(' | '));
}

console.log(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log('全部通过。');
