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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../src/town/model';
import { ModernWard } from '../src/town/modern';
import { Pt } from '../src/core/geom';
import { UNIT_M } from '../src/road/spec';
import { buildingObstacles } from '../src/bridge/obstacles';
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

  const caseJson = {
    generator: gen,
    seed: Number(arg('ps', '1234')),
    shape: { ring: ringM },
    streets,
    ...(obstacles.length > 0 ? { obstacles } : {}),
  };

  const casePath = join(caseDir, `${name}.json`);
  const planPath = join(dataDir, `${name}.plan.json`);
  writeFileSync(casePath, JSON.stringify(caseJson, null, 1));

  console.log(
    `\n[bake] ${name}  地块 ${Math.round(t.area)} m²  环 ${ringM.length} 点  街 ${streets.length} 条` +
    (keep ? `  楼 ${t.solids.length} 栋 → 障碍 ${obstacles.length} 条` : ''),
  );
  try {
    const out = execFileSync(dotnet, [dll, '--emit', casePath, planPath], {
      cwd: coreLib,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split(/\r?\n/)) if (line.trim()) console.log('   ' + line.trim());
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    console.error('   emit 失败', err.status ?? '', err.stderr ?? '');
    continue;
  }

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
