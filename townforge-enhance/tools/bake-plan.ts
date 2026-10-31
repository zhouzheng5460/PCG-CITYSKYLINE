// 把 TownForge 的某一块地交给 Placemaker 规划，再把 Plan 收回来。
//
// 为什么需要这个脚本：浏览器里跑不了 dotnet，所以「TownForge 的地块 → Placemaker 出方案」
// 这一步只能离线做。做成烘焙之后，运行时就是"读 JSON"，两端彻底解耦。
//
// 链路：
//   Model(nPatches, seed)
//     → patch[i].ward.getCityBlock()        可建区（已按相邻路宽内缩，与道路横断面同源）
//     → 转米 + 平移到原点                     Placemaker 只认米，且不关心世界坐标
//     → patch.shape 每条边 → 一条街           patch 的边就是道路中线
//     → dotnet PlacemakerDriver --emit       一个 8 ms 的纯函数调用
//     → src/bridge/data/<name>.plan.json     给 buildScene 读
//
// 用法：
//   npx tsx tools/bake-plan.ts                          # 默认 24 块 / seed 8 / 第 3 块 / parking
//   npx tsx tools/bake-plan.ts --patch 5 --gen plaza
//   npx tsx tools/bake-plan.ts --patch 42 --gens park,pond,polishGarden   # 同地块跑一批
//   npx tsx tools/bake-plan.ts --patch 90 --gens plaza,parking --keep     # 保留建筑，只铺地面
//   npx tsx tools/bake-plan.ts --all                    # 所有地块各烘一个 parking
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../src/town/model';
import { ModernWard } from '../src/town/modern';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { buildingObstacles } from '../src/bridge/obstacles';
import { splitLot } from '../src/bridge/split';
import { clipPlanToBuildings } from '../src/bridge/clip';
import type { SolidFeature } from '../src/scene/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const coreLib = resolve(root, '../placemaker-core-lib');
const dataDir = join(root, 'src/bridge/data');
const caseDir = join(root, 'tmp/pm-cases');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes('--' + name);

const nPatches = Number(arg('n', '24'));
const seed = Number(arg('seed', '8'));
/** 要烘的生成器。`--gen parking` 单个，`--gens park,pond,polishGarden` 一批（同一个地块，便于对比）。 */
const gens = (arg('gens', '') || arg('gen', 'parking'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const layout = arg('layout', 'tensor') as 'grid' | 'field' | 'radial' | 'tensor';
const all = flag('all');
/**
 * 保留原地块建筑，只让 Placemaker 铺地面。
 *
 * 打开后会把建筑轮廓写成 `obstacles` 传给 Core，`Composer.Compose` 末尾的
 * `SiteSafety.Apply` 会把压到建筑地界的路、对象、铺装、区域一起裁掉。
 * 关掉（默认）就是「整块地换掉」，旧建筑跟着消失，这时候再传障碍物反而是错的 ——
 * 楼都不在了，还绕着它避让，出来的就是一块块莫名其妙的空地。
 */
const keep = flag('keep');

/**
 * 保留建筑时，把地块按建筑切碎成若干小块，逐块规划再合并（需要配合 `--keep`）。
 *
 * **实测结论：对 parking 无效，已被 `--clip` 取代。**
 * 切碎后每块只有几百 m²，且大多不临街，parking 的出入口一步就过不去
 * （`Reason.NeedsEntrance`）：40 m 网格得 117 个对象，80 m 网格 206 个，
 * 都低于不切的 420 个。留着这个开关是因为它对"铺装为主、出入口不敏感"的
 * 生成器（铺地、林地）仍可能有用，但处理透水/车位这类别再用它。
 */
const doSplit = flag('split') && !flag('clip');

/**
 * 让 Core「不知道有楼」地把地块排满，再由 bake 层按建筑**裁剪**（见 src/bridge/clip.ts）。
 *
 * 与 `--keep` 的区别：`--keep` 把建筑作为 obstacles 传给 Core，SiteSafety 遇到就整条删
 * （parking 的 53 条车道只剩 1 条）；`--clip` 不传障碍，生成完再切，路网保持连通。
 *
 * p90 那块的实测对比（13123 m²，4 栋楼占 43%）：
 *
 * |          | SiteSafety(--keep) | clip(--clip) |
 * |----------|--------------------|--------------|
 * | 车道      | 1 条               | 22 条 + 17 段 |
 * | 网线总长  | 35 m               | **291 m**    |
 * | 实体      | 400                | 420          |
 * | 铺装      | 7132 m²            | 6779 m²      |
 * | 压楼      | 0                  | 0            |
 *
 * 代价是铺设面积少了约 350 m²（自交碎块在源头被筛掉），换来路网连通 —— 值。
 */
const doClip = flag('clip');

mkdirSync(dataDir, { recursive: true });
mkdirSync(caseDir, { recursive: true });

// ─────────────────────────────────────────────────────────── dotnet 定位

const dll = join(coreLib, 'Driver/bin/Release/net6.0/PlacemakerDriver.dll');
const dotnet = process.env.DOTNET_EXE ?? 'C:\\Program Files\\dotnet\\dotnet.exe';
if (!existsSync(dll)) {
  console.error(`[bake] 找不到 ${dll}`);
  console.error('  先编译： cd ../placemaker-core-lib && dotnet build Driver/Driver.csproj -c Release');
  process.exit(2);
}

// ─────────────────────────────────────────────────────────── 建城

console.log(`[bake] Model n=${nPatches} seed=${seed} layout=${layout}`);
const model = new Model({ nPatches, seed, layout });
model.generate();

interface Cand {
  index: number;
  block: Pt[];
  ring: Pt[];      // patch.shape（含路），用来取街道
  area: number;
  solids: SolidFeature[];   // 该地块原本的体块，--keep 时当障碍物传给 Placemaker
}

/** 取所有"已规划过"的地块（有 ModernWard 且有 lot），它们是城市的正常内容。 */
const cands: Cand[] = [];
model.patches.forEach((patch, index) => {
  if (!(patch.ward instanceof ModernWard)) return;
  const block = patch.ward.getCityBlock();
  if (block.length < 3) return;
  const blk = Array.from(block);
  const ring = Array.from(patch.shape);
  cands.push({
    index,
    block: blk,
    ring,
    area: Math.abs(block.square) * UNIT_M * UNIT_M,
    solids: patch.ward.lot?.solids ?? [],
  });
});

if (cands.length === 0) {
  console.error('[bake] 没有一个可规划的地块');
  process.exit(1);
}

console.log(`[bake] 候选地块 ${cands.length} 个，面积（米²）${cands.map((c) => Math.round(c.area)).join(', ')}`);

// ─────────────────────────────────────────────────────────── 选目标

const pickIdx = Number(arg('patch', '-1'));

/**
 * 默认挑"最像一块正常开发用地"的地块。
 *
 * 为什么不能随便挑一块大的：Voronoi 会产生 520 m × 150 m 这种细长条带，或者 60 个点的
 * 碎边角 —— 面积不小，但 Placemaker 在上面只能沿边挤车位，出来的东西不具代表性，
 * 拿它当样板会得出"这桥接不行"的错误结论。
 *
 * 打分 = 紧凑度² × 面积适配度：
 *   紧凑度 = 地块面积 / 外接矩形面积（1 = 方正，0.3 = 细长）
 *   面积适配 = min(面积/12000, 12000/面积)（1 = 正好 12000 m²，两侧都衰减）
 */
const score = (c: Cand) => {
  const xs = c.block.map((p) => p.x), ys = c.block.map((p) => p.y);
  const bw = (Math.max(...xs) - Math.min(...xs)) * UNIT_M;
  const bh = (Math.max(...ys) - Math.min(...ys)) * UNIT_M;
  const compact = bw * bh > 0 ? c.area / (bw * bh) : 0;
  const fit = Math.min(c.area / 12000, c.area > 0 ? 12000 / c.area : 0);
  return compact * compact * fit;
};

const targets = all
  ? cands
  : [cands.find((c) => c.index === pickIdx)
     ?? [...cands].sort((a, b) => score(b) - score(a))[0]];

const index: Record<string, unknown>[] = [];

// 一个地块 × 一批生成器 = 若干份 Plan。地块几何每个生成器都重算一遍，
// 因为那只涉及几十个点（`edgeWidthAt` 也是查表），比把状态提前抽出来更不容易出错。
const jobs = targets.flatMap((t) => gens.map((gen) => ({ t, gen })));

for (const { t, gen } of jobs) {
  const name = `city${nPatches}-s${seed}-p${t.index}-${gen}`;

  // 平移到原点：Placemaker 的坐标从 (0,0) 起算，原点偏多远它不关心，
  // 但 RingT / RingSegment 这些"沿环的参数"在大坐标上会掉精度。
  const minX = Math.min(...t.block.map((p) => p.x));
  const minY = Math.min(...t.block.map((p) => p.y));
  const toM = (p: Pt): [number, number] => [
    round((p.x - minX) * UNIT_M),
    round((p.y - minY) * UNIT_M),
  ];

  const ringM = t.block.map(toM);

  // 街道：patch.shape 的每条边就是一条道路中线（"道路中线就是地块边"），
  // 宽取该边的红线宽（mm 级精度够了，JSON 里不写浮点尾巴）。
  const streets = [];
  for (let i = 0; i < t.ring.length; i++) {
    const v0 = t.ring[i];
    const v1 = t.ring[(i + 1) % t.ring.length];
    const w = model.edgeWidthAt(v0, v1) * UNIT_M;
    if (!(w > 1)) continue;
    streets.push({
      id: 1000 + i,
      a: [round((v0.x - minX) * UNIT_M), round((v0.y - minY) * UNIT_M)],
      b: [round((v1.x - minX) * UNIT_M), round((v1.y - minY) * UNIT_M)],
      width: round(w),
      sidewalk: true,
      speed: 50,
    });
  }

  // 建筑轮廓 → Core 认的定向四边形（理由见 src/bridge/obstacles.ts：最小外接矩形会凭空封地）。
  // 只有 --keep 才传：整块换掉的时候楼都不在了，再绕着它避让只会得到一块块莫名其妙的空地。
  const obstacles = keep ? buildingObstacles(t.solids, toM) : [];

  // --split：可建区减去建筑，切成若干块没有楼的小地，逐块让 Placemaker 规划再合并。
  // 不切的后果实测过：parking 在地块被 4 栋楼占 43% 时，53 条车道会只剩 1 条
  // （SiteSafety 遇到建筑是**删**整条，不是绕）。
  const sp = doSplit && keep && obstacles.length > 0
    ? splitLot(ringM, obstacles.map((o) => o.quad), {
        gridSize: Number(arg('grid', '40')),
        minAreaM2: Number(arg('minpart', '80')),
      })
    : null;

  /** 要喂给 Placemaker 的形状：切碎时是若干小块，否则就是整块地。 */
  const pieces: { ring: [number, number][]; tag: string }[] =
    sp && sp.parts.length > 0
      ? sp.parts.map((p, i) => ({ ring: p, tag: `part${i}` }))
      : [{ ring: ringM, tag: 'whole' }];

  console.log(
    `\n[bake] ${name}  地块 ${Math.round(t.area)} m²  环 ${ringM.length} 点  街 ${streets.length} 条` +
    (keep ? `  楼 ${t.solids.length} 栋 → 障碍 ${obstacles.length} 条` : '') +
    (sp ? `  切碎 → ${pieces.length} 块（切不动 ${sp.uncuttable}，太小 ${sp.skippedTiny}）` : ''),
  );

  // 逐块 emit。块多了要合并成一份 plan —— 坐标同为 toM 变换后的米制，直接拼接即可。
  type AnyPlan = {
    generator?: string; seed?: number; area?: number; ready?: boolean; readyKey?: string;
    surfaces: unknown[]; nets: unknown[]; objects: unknown[]; areas: unknown[];
    regions: unknown[]; zoning: unknown[]; paint: unknown[]; terraform: unknown[];
    stats: unknown[]; facts: Record<string, unknown>; issues: unknown[];
    unknownRoles?: { surfaces?: number; nets?: number; objects?: number; areas?: number };
  };
  const collected: AnyPlan[] = [];
  /**
   * 真正落过盘的临时文件路径。**不要**事后按 pieces 重新拼名字：
   * 单块的时候文件名没有 `.whole` 后缀（见下面的 `suffix`），拼出来的是个不存在的路径，
   * 读取就 ENOENT。踩过一次（--gens 烘焙单块地块时整批崩掉）。
   */
  const tmpWritten: string[] = [];
  let emitFailed = false;

  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi];
    const suffix = pieces.length > 1 ? `.${piece.tag}` : '';
    const caseJson = {
      generator: gen,
      seed: Number(arg('ps', '1234')),
      shape: { ring: piece.ring },
      // 街道要跟着传：parking 这类生成器的第一步就是找**出入口**
      // （`Reason.NeedsEntrance`），不给街会整块拒绝、什么都不出。
      // 子块的形状已经把建筑排除在外，所以不会生成压在楼上的路。
      streets,
      ...(obstacles.length > 0 && !doClip ? { obstacles } : {}),
    };

    const casePath = join(caseDir, `${name}${suffix}.json`);
    const planPath = join(dataDir, `${name}${suffix}.plan.tmp.json`);
    tmpWritten.push(planPath);
    writeFileSync(casePath, JSON.stringify(caseJson, null, 1));

    try {
      const out = execFileSync(dotnet, [dll, '--emit', casePath, planPath], {
        cwd: coreLib,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const line of out.split(/\r?\n/)) if (line.trim()) console.log('   ' + line.trim());
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      console.error(`   emit 失败（${piece.tag}）`, err.status ?? '', err.stderr ?? '');
      emitFailed = true;
      break;
    }

    collected.push(JSON.parse(readFileSync(planPath, 'utf8')) as AnyPlan);
  }

  if (emitFailed || collected.length === 0) continue;

  // ── 写出：单块原样搬（字节级可比）/ 多块合并 / --clip 时先合并再按建筑裁
  const planPath = join(dataDir, `${name}.plan.json`);
  const tmpPaths = tmpWritten;

  const mergeAll = (): AnyPlan => {
    if (collected.length === 1) return collected[0];
    const merged: AnyPlan = {
      generator: gen,
      seed: Number(arg('ps', '1234')),
      area: collected.reduce((s, p) => s + (p.area ?? 0), 0),
      ready: collected.every((p) => p.ready !== false),
      surfaces: [], nets: [], objects: [], areas: [],
      regions: [], zoning: [], paint: [], terraform: [],
      stats: [], facts: {}, issues: [],
      unknownRoles: { surfaces: 0, nets: 0, objects: 0, areas: 0 },
    };
    for (const p of collected) {
      merged.surfaces.push(...p.surfaces);
      merged.nets.push(...p.nets);
      merged.objects.push(...p.objects);
      merged.areas.push(...p.areas);
      merged.regions.push(...p.regions);
      merged.zoning.push(...p.zoning);
      merged.paint.push(...p.paint);
      merged.terraform.push(...p.terraform);
      merged.issues.push(...p.issues);
      Object.assign(merged.facts, p.facts);
      const u = p.unknownRoles;
      const acc = merged.unknownRoles!;
      acc.surfaces = (acc.surfaces ?? 0) + (u?.surfaces ?? 0);
      acc.nets = (acc.nets ?? 0) + (u?.nets ?? 0);
      acc.objects = (acc.objects ?? 0) + (u?.objects ?? 0);
      acc.areas = (acc.areas ?? 0) + (u?.areas ?? 0);
    }
    return merged;
  };

  if (doClip && obstacles.length > 0) {
    const base = mergeAll();
    const { plan: clipped, stats } = clipPlanToBuildings(
      base as unknown as Parameters<typeof clipPlanToBuildings>[0],
      obstacles.map((o) => o.quad),
    );
    writeFileSync(planPath, JSON.stringify(clipped, null, 1));
    console.log(
      `   裁剪 → 面 ${stats.surfacesIn}→${stats.surfacesOut}（切掉 ${stats.surfaceCutArea.toFixed(0)} m²）` +
      ` · 对象丢 ${stats.objDropped}` +
      ` · 渠 留 ${stats.netKept} / 丢 ${stats.netDropped}（被楼盖住 ${stats.netCutLen.toFixed(0)} m）` +
      (stats.netSplit > 0 ? ` · 切段生成 ${stats.netSplit} 条` : '') +
      (stats.surfaceRejected > 0 ? ` · 退化面拒收 ${stats.surfaceRejected}` : '') +
      ` · 残留穿楼 ${stats.netResidualLen.toFixed(1)} m`,
    );
  } else if (collected.length === 1) {
    writeFileSync(planPath, readFileSync(tmpPaths[0], 'utf8'));
  } else {
    const merged = mergeAll();
    writeFileSync(planPath, JSON.stringify(merged, null, 1));
    console.log(`   合并 ${collected.length} 块 → ${merged.surfaces.length} 面 / ${merged.nets.length} 网 / ${merged.objects.length} 物`);
  }
  for (const tp of tmpPaths) rmSync(tp, { force: true });

  // meta 单独存：origin 是"Plan 的 (0,0) 在世界坐标里的位置"，buildScene 靠它把
  // 收回来的东西放回原处。放进 plan 里会污染协议（C# 端不知道世界坐标这回事）。
  const meta = {
    name,
    generator: gen,
    seed: Number(arg('ps', '1234')),
    patch: t.index,
    nPatches,
    citySeed: seed,
    layout,
    /** Placemaker 的 (0,0) 对应的世界坐标 */
    origin: [round(minX), round(minY)],
    /** 地块在米制下的包围盒，便于核对尺度 */
    sizeM: [round(Math.max(...ringM.map((p) => p[0]))), round(Math.max(...ringM.map((p) => p[1])))],
    areaM2: Math.round(t.area),
    /**
     * 地块环（米，相对 Plan 原点）。桥接靠它补一层草地底：
     * park / greenwayPark / picnicGrounds 这类生成器**只画路径和树，不铺地面**
     * （CS2 里地面是地形，本来就长草），不给底的话桥接出来是一片裸地。
     */
    lotRing: ringM,
    /**
     * 这份 Plan 是不是绕着原地块的建筑生成的。
     * true = 场景要保留该 patch 的体块（`PlacemakerLot.keepBuildings`），
     * false = 整块换掉。烘焙时就要定下来：Core 侧的避让是**生成时**做的，
     * 到运行时再改主意，铺装已经被裁掉了，楼一删就是一堆空地。
     */
    keepBuildings: keep,
    /** 传给 Placemaker 的障碍四边形条数（一栋多角楼可能拆成好几条） */
    obstacles: obstacles.length,
    buildings: keep ? t.solids.length : 0,
    /** --split 把地块切成了几块（省略 = 没切）。桥接侧不需要它，用于诊断与画图。 */
    ...(sp ? { splitParts: pieces.length, splitUncuttable: sp.uncuttable } : {}),
    /**
     * 这份 Plan 的建筑避让是由**谁**做的：
     * - `core`：把建筑作为 obstacles 交给 Core，SiteSafety 整条删（parking 只剩 1 条车道）
     * - `clip`：Core 不知情地排满，bake 层再按建筑裁剪（车道保住 22 条）
     */
    ...(doClip ? { clipStrategy: 'clip' as const } : (keep ? { clipStrategy: 'core' as const } : {})),
  };
  writeFileSync(join(dataDir, `${name}.meta.json`), JSON.stringify(meta, null, 1));
  index.push(meta);
}

// index.json 按目录里**现有的** meta 重建，而不是只记本次的：
// 分多次烘不同地块时，早先那批不能被抹掉；反过来说，删了某个 meta 也会自动从索引里消失。
{
  const metas = readdirSync(dataDir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')))
    // 同一个地块跑一批生成器时面积全都一样，光按面积排会退化成 readdir 顺序；
    // 补一个文件名次序，索引才是稳定的（测试和联系表都按索引取第一条）。
    .sort((a, b) => b.areaM2 - a.areaM2 || String(a.name).localeCompare(String(b.name)));
  writeFileSync(join(dataDir, 'index.json'), JSON.stringify(metas, null, 1));
  console.log(`\n[bake] 写出 index.json（${metas.length} 项）`);
}

console.log(`\n[bake] 产物在 ${dataDir}`);

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
