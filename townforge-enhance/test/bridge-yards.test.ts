// 第一批"低面高物"生成器（堆场 / 废料场 / 跑道 / 球场）过桥后的体检。
//
// 跑：npx tsx test/bridge-yards.test.ts
// 前置：npx tsx tools/bake-plan.ts --patch 42 --gens carYard,junkYard,runningTrack,scrapyard,pitch
//
// 为什么单独一个文件：这五个生成器的**产出形态**和绿地那一族不一样，
// 它们的身份不在铺装上，而在两种被老桥接整类丢掉的东西里：
//
//   1) `furniture`（车场 809 件、废车场 717 件）——通用角色，原来一律映射成长椅。
//      一块 800 张长椅的车场等于没有接。
//   2) `decal`（跑道 642 件、球场 340 件）——标线不是"线"，是沿线每隔 1.5 m 撒的一串贴花。
//      不摊成窄条的话，球场只剩一块草皮，连边线都没有。
//
// 所以这里钉的不是"有没有东西"，而是"东西的**种类对不对**"：
// 堆场里不许出现长椅、球场必须真的画出线、整块贴花不许铺成一块白板。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pt } from '../src/core/geom';
import { bridgePlan, type PlacemakerPlan } from '../src/bridge/placemaker';
import type { PropKind } from '../src/scene/types';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../src/bridge/data');

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

interface Meta { name: string; generator: string; origin: [number, number]; lotRing: [number, number][] }

function load(gen: string): { plan: PlacemakerPlan; meta: Meta } {
  const meta = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.meta.json`), 'utf8')) as Meta;
  const plan = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.plan.json`), 'utf8')) as PlacemakerPlan;
  return { plan, meta };
}

function kinds(res: ReturnType<typeof bridgePlan>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const p of res.props) m[p.kind] = (m[p.kind] ?? 0) + 1;
  return m;
}

// ─────────────────────────────────────────────── 1) 真实烘焙件的形态

const YARDS = ['carYard', 'junkYard', 'scrapyard'];
const FIELDS = ['pitch', 'runningTrack'];

for (const gen of YARDS) {
  const { plan, meta } = load(gen);
  const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
  const k = kinds(res) as Record<PropKind, number>;
  const g = res.surfaces[0];

  ok(res.props.length > 0, `[${gen}] 出了道具`, `${res.props.length}`);
  ok(res.dropped === 0, `[${gen}] 没有被丢弃的面`, `dropped=${res.dropped}`);

  // 核心断言：杂物不许变长椅。这五个生成器里 0 个 bench 角色，所以一个长椅都不该有。
  ok((k.bench ?? 0) === 0, `[${gen}] 没有误映射成长椅`, `bench=${k.bench ?? 0}`);
  // 堆场三件套都要在：盒子（料箱/托盘/隔离墩）、桶（油桶/轮胎）、车（废车）
  ok((k.crate ?? 0) > 0, `[${gen}] 有箱类道具`, `crate=${k.crate ?? 0}`);
  ok((k.barrel ?? 0) > 0, `[${gen}] 有桶类道具`, `barrel=${k.barrel ?? 0}`);
  ok(((k.car ?? 0) + (k.rock ?? 0)) > 0, `[${gen}] 有废车或石堆`, `car=${k.car ?? 0} rock=${k.rock ?? 0}`);

  // paint 通道：车场/废料场把整块地刷成了泥土（一条覆盖全地块的 layer 3 @ 0.85），
  // 底色得跟着变，否则一块泥土堆场在场景里是一片草坪 —— 这是覆盖率之外最影响
  // "读得出是什么"的一项。scrapyard 没有这种大面积刷子（17 块小补丁），所以不在名单里。
  if (gen === 'carYard' || gen === 'junkYard') {
    ok(g?.mat === 'soil', `[${gen}] 地块底色来自 paint（泥土）`, String(g?.mat));
  } else {
    ok(g?.mat === 'grass', `[${gen}] 没有大面积刷地表，底色仍是草`, String(g?.mat));
  }
  ok(res.markings.strips === 0, `[${gen}] 没有标线贴花`, `${res.markings.strips}`);
}

for (const gen of FIELDS) {
  const { plan, meta } = load(gen);
  const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
  const fieldLine = plan.objects.filter((o) => o.role === 'decal' && o.category === 'decal.fieldline').length;

  ok(fieldLine > 100, `[${gen}] Plan 里有成串的白线贴花`, `${fieldLine}`);
  ok(res.markings.strips === fieldLine, `[${gen}] 每条白线贴花都变成一条标线`, `${res.markings.strips} vs ${fieldLine}`);
  ok(res.markings.frames === 0, `[${gen}] 这块地没用整场贴花`, `${res.markings.frames}`);

  // 标线是面，不是道具：它们走 surfaces 通道，和车位线同一套（同材质同高度）。
  const marks = res.surfaces.filter((s) => s.group === 'pm/marking/field');
  ok(marks.length === fieldLine, `[${gen}] 标线都在 marking/field 分组里`, `${marks.length}`);
  ok(marks.every((s) => s.mat === 'markWhite'), `[${gen}] 标线是白色`);
  ok(marks.every((s) => s.ring.length === 4), `[${gen}] 标线是四边形窄条`);
  const g = res.surfaces[0];
  ok(res.surfaces.slice(1).every((s) => s.y > g.y), `[${gen}] 底色压在所有标线之下`);

  // 标线不许把面数打爆：一条 1.5 m 的窄条 = 2 个三角形，642 条也才 1284。
  ok(res.surfaces.length < 1500, `[${gen}] 面数在预算内`, `${res.surfaces.length}`);
  ok(res.dropped === 0, `[${gen}] 没有被丢弃的面`, `dropped=${res.dropped}`);
  ok(g?.mat === 'grass', `[${gen}] 地块底色仍是草地`, String(g?.mat));
}

// ─────────────────────────────────────────────── 2) 映射表本身（合成数据，不依赖烘焙）
//
// 真实数据只能覆盖"现在 Core 会产出的分类"。这几条是给**将来**的：
// 出现新分类时应该是"多一个灰盒子"，不是"多一排长椅"，更不是静默消失。

const synthetic = {
  protocol: 'placemaker-plan/1',
  generator: 'synthetic',
  units: 'meters' as const,
  seed: 1,
  area: 1000,
  ready: true,
  surfaces: [],
  nets: [],
  objects: [
    { role: 'furniture' as const, x: 10, z: 10, category: 'industrial.wreck' },
    { role: 'furniture' as const, x: 20, z: 10, category: 'industrial.barrel' },
    { role: 'furniture' as const, x: 30, z: 10, category: 'rock' },
    { role: 'furniture' as const, x: 40, z: 10, category: 'brand.new.category' },
    { role: 'furniture' as const, x: 50, z: 10 },
    { role: 'decal' as const, x: 60, z: 10, yaw: 0, category: 'decal.fieldline' },
    { role: 'decal' as const, x: 70, z: 10, category: 'decal.leaves' },
    { role: 'decal' as const, x: 80, z: 10, yaw: 0, category: 'decal.markings' },
    { role: 'bench' as const, x: 90, z: 10 },
  ],
  areas: [], regions: [], zoning: [], terraform: [], stats: [], facts: {}, issues: [], paint: [],
};
const syn = bridgePlan(synthetic, { origin: new Pt(0, 0), group: 'pm' });
const sk = kinds(syn) as Record<PropKind, number>;

ok((sk.car ?? 0) === 1, '[合成] industrial.wreck → car', JSON.stringify(sk));
ok((sk.barrel ?? 0) === 1, '[合成] industrial.barrel → barrel', JSON.stringify(sk));
ok((sk.rock ?? 0) === 1, '[合成] rock → rock', JSON.stringify(sk));
ok((sk.crate ?? 0) === 2, '[合成] 未知分类 / 没写分类 → crate（不是长椅）', JSON.stringify(sk));
ok((sk.bench ?? 0) === 1, '[合成] 真正的 bench 角色仍是 bench', JSON.stringify(sk));

ok(syn.markings.strips === 1, '[合成] 白线贴花 → 1 条标线', String(syn.markings.strips));
ok(syn.markings.frames === 1, '[合成] 整场贴花 → 1 个外框', String(syn.markings.frames));
ok(syn.markings.skipped === 1, '[合成] 落叶贴花不画', String(syn.markings.skipped));
// 整场贴花是 68 × 52.5 m 的半场纹理：只画外框（4 条），铺成实心面就是一块白板。
const frames = syn.surfaces.filter((s) => s.group === 'pm/marking/field');
ok(frames.length === 5, '[合成] 1 条白线 + 4 条外框', String(frames.length));
const frameArea = frames.slice(1).reduce((sum, s) => sum + Math.abs(area2(s.ring)), 0);
const solidArea = (68 / 7) * (52.5 / 7);
ok(frameArea < solidArea * 0.05, '[合成] 外框面积远小于整块贴花', `${frameArea.toFixed(2)} vs ${solidArea.toFixed(2)}`);

// ─────────────────────────────────────────────── 3) 汇总

function area2(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

if (fails.length > 0) {
  console.error(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
console.log(`断言 ${pass} 通过 / 0 失败`);
console.log('全部通过。');
