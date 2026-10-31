// 第二批「铺装/商业」生成器（stripMall / outdoorMall / shopsPark / mallPark /
// abandonedLot / marketSquare）过桥后的体检。
//
// 跑：npx tsx test/bridge-shops.test.ts
// 前置：npx tsx tools/bake-plan.ts --patch 42 \
//         --gens stripMall,outdoorMall,shopsPark,mallPark,abandonedLot,marketSquare
//
// 这一批暴露的是三个**结构性**问题，不是"画得丑"：
//
//   1) 商场/市场族**自己不找门**。源码原话："The player places them on the outline;
//      nothing is suggested and Build waits for a way in for cars." 自动城市里没人放门，
//      于是整块地 `ready=no`、一个面都不出。烘焙工具只能替它放一个（见 autoEntranceMarkers）。
//   2) `zoning` 通道 = 留给建筑的宗地。以前整类丢掉，于是 stripMall 只铺了 30% 的地，
//      剩下 27% 是一块没来由的草坪 —— 看着像规划失败，实际是"那块地等着盖楼"。
//   3) `furniture` 的分类表漏了几项：市场广场的 162 个路桩被画成 1.1 m 的灰盒子，
//      废弃地块的 7 段残墙也是；`centerpiece.statue` 还被画成蓝色水盘。
//
// 所以这里钉的是：门补了没有、宗地铺了没有、有没有重叠、分类对不对。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pt } from '../src/core/geom';
import { unionArea } from '../src/bridge/area';
import { bridgePlan, type PlacemakerPlan } from '../src/bridge/placemaker';
import { propDraw } from '../src/scene/propStyle';
import type { SurfaceFeature } from '../src/scene/types';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../src/bridge/data');
const UNIT_M = 7;

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

interface Meta {
  name: string;
  generator: string;
  origin: [number, number];
  lotRing: [number, number][];
  areaM2: number;
  autoEntrance?: number;
}

const load = (gen: string) => {
  const meta = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.meta.json`), 'utf8')) as Meta;
  const plan = JSON.parse(readFileSync(join(dataDir, `city24-s8-p42-${gen}.plan.json`), 'utf8')) as PlacemakerPlan;
  const res = bridgePlan(plan, { origin: new Pt(meta.origin[0], meta.origin[1]), group: 'pm', lotRing: meta.lotRing });
  return { meta, plan, res };
};

/** 世界单位的环 → 平方米的环，喂给 area.ts。 */
const toM = (s: SurfaceFeature) => s.ring.map((p) => [p.x * UNIT_M, p.y * UNIT_M] as [number, number]);

const countCat = (plan: PlacemakerPlan, role: string, category?: string) =>
  plan.objects.filter((o) => o.role === role && (category === undefined || o.category === category)).length;

const countKind = (res: ReturnType<typeof bridgePlan>, kind: string) =>
  res.props.filter((p) => p.kind === kind).length;

const SHOPS = ['stripMall', 'outdoorMall', 'shopsPark', 'mallPark', 'abandonedLot', 'marketSquare'];

// ─────────────────────────────────────────────── 1) 出入口是工具替它放的

// 这三份在第一次 emit 时被 Core 以 `Reason.NeedsEntrance` 整块拒绝。
const GATED = ['stripMall', 'mallPark', 'marketSquare'];
const UNGATED = ['outdoorMall', 'shopsPark', 'abandonedLot'];

for (const gen of GATED) {
  const { meta, plan, res } = load(gen);

  ok((meta.autoEntrance ?? 0) >= 1, `[${gen}] 被拒绝过一次，工具补了门`, String(meta.autoEntrance));
  // `markers.given` 是 Driver 收到的门数：>0 说明门真的进了 AreaInput，
  // 而不是"恰好 ready"（比如某天 Core 改了默认行为，这条会先炸）。
  ok((plan.markers?.given ?? 0) >= 1, `[${gen}] 门真的传进了 Core`, JSON.stringify(plan.markers));
  ok(plan.ready === true, `[${gen}] 补门之后 ready`);
  ok(res.surfaces.length > 0 && res.props.length > 0, `[${gen}] 出了面与道具`,
    `surf=${res.surfaces.length} prop=${res.props.length}`);
  ok(res.dropped === 0, `[${gen}] 没有被丢弃的面`, `dropped=${res.dropped}`);
}

for (const gen of UNGATED) {
  const { meta, plan } = load(gen);
  // 反向断言：**不许给本来就 ready 的生成器塞门**。
  // 塞了会改掉它们已有的布局（公园族的 entrance 是步行的，和车行门不是一回事），
  // 25 份已验收的输出就都要重看一遍。
  ok((meta.autoEntrance ?? 0) === 0, `[${gen}] 没被补门（本来就 ready）`, String(meta.autoEntrance));
  ok((plan.markers?.given ?? 0) === 0, `[${gen}] Core 收到的门数是 0`, JSON.stringify(plan.markers));
}

// ─────────────────────────────────────────────── 2) 宗地：铺出来，且不压在铺装上

const ZONED = ['stripMall', 'outdoorMall', 'shopsPark', 'mallPark'];

for (const gen of ZONED) {
  const { meta, plan, res } = load(gen);
  const zone = res.surfaces.filter((s) => s.group.startsWith('pm/zoning/'));
  const paved = res.surfaces.filter((s) => s.group.startsWith('pm/surface/') && s.group !== 'pm/surface/ground');

  ok(plan.zoning.length > 0, `[${gen}] Plan 里有宗地`, `${plan.zoning.length}`);
  ok(zone.length === plan.zoning.length, `[${gen}] 每块宗地都铺了地面`, `${zone.length} vs ${plan.zoning.length}`);

  const zoneM2 = unionArea(zone.map(toM)).area;
  const pavedM2 = unionArea(paved.map(toM)).area;
  const allM2 = unionArea([...zone, ...paved].map(toM)).area;
  // 宗地是"留给建筑的地"，铺装是"人能走的地"，两者在 Core 里互斥。
  // 如果这里重叠，说明高度排序或分组搞错了 —— 一栋楼的位置上会盖着一层沥青。
  const overlap = pavedM2 + zoneM2 - allM2;
  ok(overlap < Math.max(1, zoneM2 * 0.02), `[${gen}] 宗地不与铺装重叠`, `${overlap.toFixed(0)} m²`);

  // 账要能对上：铺装 + 宗地加起来应该占掉地块的相当一部分。
  // stripMall 这种"停车场 + 一排待建商铺"是 30% + 27%，铺装比例低是**正常**的。
  // 门槛取 45% 而不是 50%：shopsPark 实际是 50.4%，贴着线容易在重烘时误报；
  // 宗地一旦掉线，它直接从 50% 掉到 32%，45% 照样抓得住。
  const share = (pavedM2 + zoneM2) / meta.areaM2;
  ok(share > 0.45, `[${gen}] 铺装 + 宗地占掉近一半地块`, `${(share * 100).toFixed(0)}%`);

  // 宗地压在草地底之上（否则会被底色盖掉，等于没铺）。
  const ground = res.surfaces[0];
  ok(ground?.group === 'pm/surface/ground', `[${gen}] 第一层仍是草地底`, String(ground?.group));
  ok(zone.every((s) => s.y > ground.y), `[${gen}] 宗地在底色之上`);
}

// stripMall 单独钉一个数：这一批里它最能说明"覆盖率低不等于规划失败"。
{
  const { meta, plan, res } = load('stripMall');
  const pavedM2 = unionArea(res.surfaces.filter((s) => s.group.startsWith('pm/surface/') && s.group !== 'pm/surface/ground').map(toM)).area;
  const zoneM2 = unionArea(res.surfaces.filter((s) => s.group.startsWith('pm/zoning/')).map(toM)).area;
  ok(pavedM2 / meta.areaM2 < 0.4, '[stripMall] 铺装本身确实不足 40%', `${(pavedM2 / meta.areaM2 * 100).toFixed(0)}%`);
  ok(zoneM2 / meta.areaM2 > 0.2, '[stripMall] 宗地本身超过 20%', `${(zoneM2 / meta.areaM2 * 100).toFixed(0)}%`);
  ok(plan.zoning.every((z) => z.zoneId.length > 0), '[stripMall] 宗地都带分区名（分组能分开）');
}

// ─────────────────────────────────────────────── 3) 分类映射：种类对不对

{
  // 市场广场：162 个路桩排成列，是那个广场的秩序。映射成灰盒子就全毁了。
  const { plan, res } = load('marketSquare');
  const cat = countCat(plan, 'furniture', 'bollard');
  ok(cat > 100, '[marketSquare] Plan 里有大量 bollard 分类', String(cat));
  ok(countKind(res, 'bollard') === cat, '[marketSquare] 每个 bollard 都成了路桩', `${countKind(res, 'bollard')} vs ${cat}`);

  // 中心物：`centerpiece.statue` 不许再画成喷泉（蓝色水盘）。
  const statue = countCat(plan, 'centerpiece', 'centerpiece.statue');
  ok(statue === 1, '[marketSquare] Plan 里有一尊雕像', String(statue));
  ok(countKind(res, 'statue') === statue, '[marketSquare] 雕像 → statue', `${countKind(res, 'statue')}`);
  ok(countKind(res, 'fountain') === countCat(plan, 'centerpiece', 'centerpiece.fountain'),
    '[marketSquare] 喷泉只剩真正的喷泉', `${countKind(res, 'fountain')}`);
}

{
  // 废弃地块：7 段残墙 + 30 堆瓦砾 + 112 丛杂草。这三样是那块地的全部身份。
  const { plan, res } = load('abandonedLot');
  const walls = countCat(plan, 'furniture', 'ruins.wall');
  ok(walls > 0, '[abandonedLot] Plan 里有残墙', String(walls));
  ok(countKind(res, 'ruinWall') === walls, '[abandonedLot] 残墙 → ruinWall（不是灰盒子）', `${countKind(res, 'ruinWall')}`);
  ok(countKind(res, 'rock') >= countCat(plan, 'furniture', 'ruins.rubble'),
    '[abandonedLot] 瓦砾 → rock', `${countKind(res, 'rock')}`);
  ok(countKind(res, 'shrub') === countCat(plan, 'bush'), '[abandonedLot] 杂草 → 灌木', `${countKind(res, 'shrub')}`);
  // 一块"长满草的空地"底色必须是草：扩写 subtype 默认 overgrown，
  // paint 只有一小块 layer 1 @0.4，达不到改底色的门槛。
  ok(res.surfaces[0]?.mat === 'grass', '[abandonedLot] 底色是草（overgrown）', String(res.surfaces[0]?.mat));
}

// ─────────────────────────────────────────────── 4) 新道具在 2D 里看得见
//
// `ruinWall` / `statue` 一个都不会出现在"整城视图只有 1 px"的名单里：
// 残墙 3.2 m、雕像基座 2.4 m。看不见就等于给场景加了 0 个信息。

ok(propDraw({ kind: 'ruinWall', scale: 1 })?.shape === 'bar', '残墙在 2D 画成一段线');
ok(propDraw({ kind: 'statue', scale: 1 })?.shape === 'dot', '雕像在 2D 画成点');

// ─────────────────────────────────────────────── 5) 汇总

if (fails.length > 0) {
  console.error(`\n断言 ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
console.log(`断言 ${pass} 通过 / 0 失败（${SHOPS.length} 个生成器）`);
console.log('全部通过。');
