// Placemaker → TownForge 的桥。
//
// Placemaker（C#，GPL-3.0）是一个**室外场地设计器**：它产出铺装面、园路、道具、车位、
// 分区框，但**不产建筑**——`ObjectRole` 里根本没有 Building，建筑在它那里只是"要避开的障碍物"。
// 所以这条桥接管的不是"整块地的内容"，而是「地块内容里的室外那一半」：
//
//   TownForge 负责            Placemaker 接管
//   ─────────────────         ──────────────────
//   建筑体块 / 屋顶 / 墙面  ←  保留
//   铺装 / 绿化 / 车位      ←  换成 128 个生成器里的任意一个
//
// 协议见 `PlacemakerPlan`：C# 端 `PlacemakerDriver --emit <case.json> <plan.json>` 产出。
//
// 三条硬约定，写在这里免得后面又踩：
//
//   1) **单位**。Plan 里一律是米（Placemaker 的 MinArea / CheckReady / minApart 全按米算，
//      换算必须在调用方做，否则"这块地能不能跑"和"这块地多大"会来自两套单位）。
//      进到这里统一除 `UNIT_M` 变成世界单位。
//
//   2) **坐标**。Plan 的平面坐标是 `[x, z]`，和 TownForge 的 `Pt(x, y)` 一一对应
//      （3D 里 Pt.y 就是 world z）。**不要翻转任何一个轴**——Placemaker 的 +z 和 TownForge 的
//      +y 都是"北"，翻一下就成镜像图，而且镜像后所有车位朝向都反了，很难一眼看出来。
//
//   3) **朝向**。`yaw` 弧度绕 +Y，0 = 朝 +Z。转成 TownForge 的 `rot`（2D 画布弧度，0 = +X）时
//      是 `rot = yaw - π/2`，因为 2D 里 0 度指向 +X、3D 里 0 度指向 +Z。
//
// 车位是**点**不是面（Placemaker 只给 `{x, z, yaw, scale}`），必须自己重塑成车位线，
// 见 `baysToMarkings()` —— 那一段是本模块唯一有算法的地方。

import { Pt } from '../core/geom';
import { UNIT_M } from '../road/spec';
import type { MatKey } from '../scene/palette';
import type { PathFeature, PropFeature, PropKind, SurfaceFeature } from '../scene/types';
import { toCCW } from '../scene/types';
import { fitHedgeBars, type HedgeBar } from './hedge';

// ─────────────────────────────────────────────────────────── Plan JSON 类型

/** Plan 里一个平面点：`[x, z]`，单位米。 */
export type PlanPoint = [number, number];

export type PlanSurfaceRole = 'ground' | 'paving' | 'asphalt' | 'grass' | 'plaza' | 'water' | 'decorative';

export type PlanNetRole =
  | 'street' | 'avenue' | 'culDeSac' | 'roundabout' | 'perimeterRoad'
  | 'pathway' | 'pathwayWide'
  | 'driveAisle' | 'driveConnector' | 'alley'
  | 'fence' | 'other';

export type PlanObjectRole =
  | 'tree' | 'bush' | 'planter'
  | 'bench' | 'lamp' | 'bin' | 'centerpiece' | 'furniture' | 'fencePiece' | 'decal'
  | 'parkingBay' | 'charger' | 'arrow'
  | 'marker' | 'animalSpawner' | 'accessPoint' | 'culDeSacCap' | 'roundaboutIsland'
  | 'other';

export interface PlanSurface {
  role: PlanSurfaceRole;
  /** 地面高度（米）。铺装基本都是 0。 */
  y?: number;
  ring: PlanPoint[];
  category?: string;
}

/** 一条渠：三次贝塞尔，直线时 b/c 就在 a→d 的三等分点上。 */
export interface PlanNet {
  role: PlanNetRole;
  a: PlanPoint;
  b: PlanPoint;
  c: PlanPoint;
  d: PlanPoint;
  /** >= 0 = 这一端显式接到既有道路（对应 NearbyNet.ExternalId）；-1 = 自由端。 */
  startAttach?: number;
  endAttach?: number;
  category?: string;
}

export interface PlanObject {
  role: PlanObjectRole;
  x: number;
  z: number;
  y?: number;
  /** 绕 +Y 的弧度，0 = 朝 +Z。 */
  yaw?: number;
  scale?: number;
  elevation?: number;
  roll?: number;
  pitch?: number;
}

export interface PlanRegion {
  key: string;
  tags: string[];
  ring: PlanPoint[];
}

export interface PlanZoning {
  zoneId: string;
  /** 分区四边形：A/B/C/D 四个角。 */
  quad: [PlanPoint, PlanPoint, PlanPoint, PlanPoint];
}

export interface PlanPaint {
  layer: number;
  strength: number;
  ring: PlanPoint[];
}

export interface PlanIssue {
  severity: 'info' | 'warning' | 'error';
  key: string;
  args?: (string | number)[];
}

export interface PlacemakerPlan {
  protocol: string;
  generator: string;
  units: 'meters';
  seed: number;
  area: number;
  ready: boolean;
  readyKey?: string;
  markers?: { given: number; auto: number };
  elapsedMs?: number;
  settings?: Record<string, unknown>;
  error?: string;
  empty?: string;
  /**
   * Driver 统计的「角色名没映射上」的元素数（按通道分开）。
   * Core 加了新枚举值而 Driver/桥接没跟上时，这些元素会被静默丢掉——读到非零就该报警。
   */
  unknownRoles?: { surfaces?: number; nets?: number; objects?: number; areas?: number };
  surfaces: PlanSurface[];
  nets: PlanNet[];
  objects: PlanObject[];
  areas: { role: string; ring: PlanPoint[] }[];
  regions: PlanRegion[];
  zoning: PlanZoning[];
  paint: PlanPaint[];
  terraform: { kind: string; target: number; permanent: boolean; ring: PlanPoint[] }[];
  stats: { key: string; value: number; unit?: string }[];
  facts: Record<string, number>;
  issues: PlanIssue[];
}

// ─────────────────────────────────────────────────────────── 映射表

/** 铺装角色 → 材质。停车坪单独用 asphaltLot，比车行道略深一点就够，再深就读成"空洞"了。 */
const MAT_BY_SURFACE: Record<PlanSurfaceRole, MatKey> = {
  ground: 'ground',
  paving: 'paver',
  asphalt: 'asphaltLot',
  grass: 'grass',
  plaza: 'stonePave',
  water: 'water',
  decorative: 'gravel',
};

/** 铺装基准高度。**不按 role 分层，而是按数组顺序递增** —— Placemaker 是先铺大底再铺细节的，
 *  按顺序叠上去才能让"后铺的压在先铺的上面"这件事成立。role 之间靠这点微小高差不够，
 *  所以步长取 2e-4（39 个面一共抬 8e-3，仍在人行道 0.019 之下）。 */
const SURFACE_Y0 = 0.008;
const SURFACE_DY = 2e-4;

/** 车位线高度。和 TownForge 自己画的 lot 车位线一致（modern.ts 用 0.0305）。 */
const BAY_LINE_Y = 0.0305;

/** 渠角色 → [宽度(米), 材质, 竖起来的高度(0 = 平铺)]。 */
const NET_SPEC: Record<PlanNetRole, [number, MatKey, number]> = {
  street: [8, 'asphalt', 0],
  avenue: [14, 'asphalt', 0],
  culDeSac: [7, 'asphalt', 0],
  roundabout: [8, 'asphalt', 0],
  perimeterRoad: [6, 'asphalt', 0],
  pathway: [2, 'paver', 0],
  pathwayWide: [3.5, 'paver', 0],
  driveAisle: [5.5, 'asphalt', 0],
  driveConnector: [6, 'asphalt', 0],
  alley: [4, 'gravel', 0],
  fence: [0.18, 'fence', 1.4],
  other: [3, 'concrete', 0],
};

/** 对象角色 → TownForge 的 PropKind。null = 不画（贴花由地形贴图负责，点标记没有几何意义）。 */
const PROP_BY_OBJECT: Record<PlanObjectRole, PropKind | null> = {
  tree: 'treeRound',
  // 灌木必须是 `shrub`（1.3 m 高的一丛），不能是 `treeSmall`（4.3 m 的小树）：
  // Placemaker 的 bush 在花园里是几百个排成行当绿篱用的，映射成小树就成了"一排松树苗"。
  bush: 'shrub',
  planter: 'planter',
  bench: 'bench',
  lamp: 'lamp',
  bin: 'bin',
  centerpiece: 'fountain',
  furniture: 'bench',
  fencePiece: 'bollard',
  decal: null,
  parkingBay: null,       // 单独走 baysToMarkings
  charger: 'bollard',
  arrow: null,
  marker: null,
  animalSpawner: null,
  accessPoint: null,
  culDeSacCap: null,
  roundaboutIsland: null,
  other: null,
};

// ─────────────────────────────────────────────────────────── 选项与结果

export interface BridgeOptions {
  /** 地块左下角在世界里的位置（世界单位）。Plan 的 (0,0) 会落在这里。 */
  origin: Pt;
  /** 额外缩放，默认 1（= 严格按 UNIT_M 换算）。只在需要微调地块大小时用。 */
  scale?: number;
  /** 导出分组前缀，默认 'pm'。同一块地多个生成器时用不同前缀，DCC 里能分选中。 */
  group?: string;
  /** 是否画车位线，默认 true。 */
  bayLines?: boolean;
  /**
   * 是否把成排的灌木拟合成绿篱，默认 true。
   *
   * Placemaker 排绿篱时整条线共用一个 yaw，随手撒的灌木每颗 yaw 都不同，所以这个
   * 判断只看 yaw、不猜距离（细节见 `bridge/hedge.ts` 的头注释）。关掉就退回"一颗一颗小锥"。
   */
  hedges?: boolean;
  /** 是否画 net（通道、园路、围栏），默认 true。 */
  nets?: boolean;
  /** 是否画 terraform 抬起的台地（先只做平铺圈，不做高度）。默认 true。 */
  terraform?: boolean;
  /** 最多画多少条车位分隔线（护栏，防止一个巨型停车场把面数打爆）。默认 4000。 */
  maxBayLines?: number;
  /**
   * 地块环（米，Plan 坐标系，同 `caseJson.shape.ring`）。
   *
   * 给了就在最底层铺一层草地。**这不是可选的装饰**：Placemaker 里地面是地形，
   * 生成器只管"往上画"——`park` / `greenwayPark` / `picnicGrounds` / `natureReserve`
   * 的 `surfaces` 干脆是空的，只出园路和树。不补底的话，桥接结果是一堆树漂在裸地上。
   *
   * 环从哪儿来：烘焙时写进了 meta 的 `lotRing`（见 tools/bake-plan.ts）。
   */
  lotRing?: PlanPoint[];
  /** 底层草地的材质，默认 `grass`。 */
  groundMat?: MatKey;
  /** 树里换成针叶的比例（0~1），默认 1/3。Placemaker 不区分树种，靠这个制造疏密变化。 */
  coniferRatio?: number;
}

export interface BridgeResult {
  surfaces: SurfaceFeature[];
  props: PropFeature[];
  paths: PathFeature[];
  /** 被丢弃的面（自交、退化、点数不足）。非 0 说明 Plan 几何有问题，值得看一眼。 */
  dropped: number;
  /** 车位重塑的统计，给控制台/测试断言用。 */
  bays: { total: number; rows: number; lines: number };
  /** 本次桥接用到的生成器 id 与种子，便于复现。 */
  meta: { generator: string; seed: number; area: number; ready: boolean };
}

// ─────────────────────────────────────────────────────────── 主函数

/**
 * 角色名对不上时的报警。**只有真丢了东西才说话**，正常路径一句多余输出都没有。
 *
 * 两个来源：
 * - `plan.unknownRoles`：Driver 侧 RoleName 落到兜底 "other" 的计数（Core 新枚举值）。
 * - `extra`：桥接映射表里根本没有的 role（JSON 比代码新）。
 */
function warnUnknownRoles(plan: PlacemakerPlan, extra: Map<string, number>): void {
  const u = plan.unknownRoles;
  const nSurf = u?.surfaces ?? 0;
  const nNet = u?.nets ?? 0;
  const nObj = u?.objects ?? 0;
  const nArea = u?.areas ?? 0;
  const fromDriver = nSurf + nNet + nObj + nArea;
  if (fromDriver > 0) {
    console.warn(
      `[bridge] ${plan.generator}: Driver 报告 ${fromDriver} 个角色名未映射的元素` +
        `（surf ${nSurf} / net ${nNet} / obj ${nObj} / area ${nArea}），它们不会出现在场景里。` +
        `若 Core 新增了角色，需同步 Emit.cs 的 RoleName 与本文件的映射表。`,
    );
  }
  if (extra.size > 0) {
    const list = [...extra.entries()].map(([r, n]) => `${r}×${n}`).join('、');
    console.warn(`[bridge] ${plan.generator}: plan.objects 里有映射表不认识的角色（${list}），已丢弃。`);
  }
}

export function bridgePlan(plan: PlacemakerPlan, opts: BridgeOptions): BridgeResult {
  const sc = opts.scale ?? 1;
  const g = opts.group ?? 'pm';
  const k = (1 / UNIT_M) * sc;

  const toPt = (p: PlanPoint): Pt => new Pt(p[0] * k + opts.origin.x, p[1] * k + opts.origin.y);

  const surfaces: SurfaceFeature[] = [];
  const props: PropFeature[] = [];
  const paths: PathFeature[] = [];
  let dropped = 0;
  /** plan.objects 里出现、但映射表不认识的 role → 个数。收完在结尾统一报一次。 */
  const unknownObjRoles = new Map<string, number>();

  /** 折算出世界单位的环；点数不足或退化返回 null。 */
  const ringOf = (pts: PlanPoint[] | undefined): Pt[] | null => {
    if (!pts || pts.length < 3) return null;
    const out: Pt[] = [];
    for (const p of pts) {
      const q = toPt(p);
      const last = out[out.length - 1];
      // 换算 + 缩放之后可能产生重合点（1e-6 级别），留着会让 earcut 出零宽裂缝
      if (last && Math.abs(last.x - q.x) < 1e-6 && Math.abs(last.y - q.y) < 1e-6) continue;
      out.push(q);
    }
    if (out.length >= 3) {
      const f = out[0], l = out[out.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) out.pop();
    }
    if (out.length < 3) return null;
    if (!simpleRing(out)) return null;
    return toCCW(out);
  };

  // 0) 草地底：铺在最下面一层，比所有铺装低一档。
  //    为什么需要：Placemaker 管"往上画"，地面是地形。绿地类生成器大多不铺地面，
  //    不补底出来就是裸地上一堆树。铺装类（parking / formalGarden）自己铺满整块地，
  //    底下的草被完全盖住，代价只是多一个和地块同形的多边形。
  if (opts.lotRing) {
    const ring = ringOf(opts.lotRing);
    if (ring) {
      surfaces.push({
        name: `${g}_ground`,
        group: `${g}/surface/ground`,
        ring,
        mat: opts.groundMat ?? 'grass',
        y: SURFACE_Y0 - SURFACE_DY,
      });
    } else {
      dropped++;
    }
  }

  // 1) 铺装面：按数组顺序叠高度
  plan.surfaces.forEach((s, i) => {
    const ring = ringOf(s.ring);
    if (!ring) { dropped++; return; }
    surfaces.push({
      name: `${g}_surf_${i}_${s.role}`,
      group: `${g}/surface/${s.role}`,
      ring,
      mat: MAT_BY_SURFACE[s.role] ?? 'ground',
      y: SURFACE_Y0 + i * SURFACE_DY,
    });
  });

  // 2) terraform 抬台：只把轮廓铺一层深色，不做高度（TownForge 的地面是平的，
  //    真要抬起来得改 mesh 生成，那是另一件事）
  if (opts.terraform !== false) {
    plan.terraform.forEach((t, i) => {
      if (t.kind === 'level') return;
      const ring = ringOf(t.ring);
      if (!ring) { dropped++; return; }
      surfaces.push({
        name: `${g}_terr_${i}`,
        group: `${g}/terraform`,
        ring,
        mat: t.kind === 'lower' ? 'water' : 'soil',
        y: SURFACE_Y0 + (plan.surfaces.length + i) * SURFACE_DY,
      });
    });
  }

  // 3) 渠：贝塞尔 → 折线
  if (opts.nets !== false) {
    plan.nets.forEach((n, i) => {
      const spec = NET_SPEC[n.role] ?? NET_SPEC.other;
      const a = toPt(n.a), b = toPt(n.b), c = toPt(n.c), d = toPt(n.d);
      const pts = sampleBezier(a, b, c, d);
      if (pts.length < 2) { dropped++; return; }
      paths.push({
        name: `${g}_net_${i}_${n.role}`,
        group: `${g}/net/${n.role}`,
        pts,
        width: (spec[0] / UNIT_M) * sc,
        mat: spec[1],
        y: 0.014,
        ...(spec[2] > 0 ? { height: (spec[2] / UNIT_M) * sc } : {}),
      });
    });
  }

  // 4) 道具
  //
  // 树要混：Placemaker 的 `tree` 不区分树种（只有一个 scale），一律按阔叶树画会丢掉
  // TownForge 自己的疏密变化，一律按针叶画就成了苗圃。按**树的序号**每 n 棵换一棵针叶
  // （不用对象下标，因为对象数组里树可能被别的角色隔开）。
  let treeSeen = 0;
  const coniferEvery = Math.max(2, Math.round(1 / Math.max(0.05, Math.min(1, opts.coniferRatio ?? 1 / 3))));

  // 先算绿篱：成排的灌木不画成一颗颗小锥，而是连成一段（判断依据见 bridge/hedge.ts）
  const bushIdx = plan.objects.map((o, i) => (o.role === 'bush' ? i : -1)).filter((i) => i >= 0);
  const hedge = opts.hedges === false
    ? { bars: [] as HedgeBar[], inRun: bushIdx.map(() => false) }
    : fitHedgeBars(bushIdx.map((i) => plan.objects[i]));
  const absorbed = new Set<number>();
  bushIdx.forEach((objIdx, n) => { if (hedge.inRun[n]) absorbed.add(objIdx); });

  hedge.bars.forEach((bar, i) => {
    const a = toPt(bar.a), b = toPt(bar.b);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-4) return;
    props.push({
      name: `${g}_hedge_${i}`,
      group: `${g}/prop/hedge`,
      kind: 'hedge',
      at: new Pt((a.x + b.x) / 2, (a.y + b.y) / 2),
      rot: Math.atan2(b.y - a.y, b.x - a.x),
      scale: 1,
      seed: i,
      len,
    });
  });

  plan.objects.forEach((o, i) => {
    if (absorbed.has(i)) return;
    // 映射表里根本没有这个 role —— 不是"故意不画"（那种是映射成 null），
    // 而是数据比代码新（Core 加了角色，桥接没跟上）。别静默吞掉，记下来结尾报。
    if (!(o.role in PROP_BY_OBJECT)) {
      unknownObjRoles.set(o.role, (unknownObjRoles.get(o.role) ?? 0) + 1);
      return;
    }
    let kind = PROP_BY_OBJECT[o.role];
    if (!kind) return;
    if (o.role === 'tree') {
      treeSeen++;
      if (treeSeen % coniferEvery === 0) kind = 'conifer';
    }
    const p = toPt([o.x, o.z]);
    props.push({
      name: `${g}_obj_${i}_${o.role}`,
      group: `${g}/prop/${kind}`,
      kind,
      at: p,
      rot: yawToRot(o.yaw ?? 0),
      scale: o.scale ?? 1,
      seed: i,
    });
  });

  // 5) 车位：点 → 分隔线
  const bayRows = opts.bayLines === false ? [] : baysToMarkings(plan.objects, { k, origin: opts.origin });
  const lines = bayRows.reduce((s, r) => s + r.lines.length + r.fronts.length, 0);
  const cap = opts.maxBayLines ?? 4000;
  if (lines <= cap) {
    let n = 0;
    for (const row of bayRows) {
      for (const [p0, p1] of row.lines) {
        const ring = bayLineRing(p0, p1, 0.12 / UNIT_M);
        if (!ring) { dropped++; continue; }
        surfaces.push({
          name: `${g}_bay_${n++}`,
          group: `${g}/marking/bay`,
          ring,
          mat: 'markWhite',
          y: BAY_LINE_Y,
        });
      }
      // 每排两侧的前缘线：让车位读成"一整排"，而不是一根根孤立的针
      for (const [f0, f1] of row.fronts) {
        const ring = bayLineRing(f0, f1, 0.12 / UNIT_M);
        if (ring) {
          surfaces.push({
            name: `${g}_bayfront_${n++}`,
            group: `${g}/marking/bay`,
            ring,
            mat: 'markWhite',
            y: BAY_LINE_Y,
          });
        }
      }
    }
  } else {
    // 超过护栏就整批不画：宁可没有车位线，也不要一座 5000 面的"线城"
    dropped += lines;
  }

  warnUnknownRoles(plan, unknownObjRoles);

  return {
    surfaces,
    props,
    paths,
    dropped,
    bays: { total: countBays(plan.objects), rows: bayRows.length, lines: Math.min(lines, cap) },
    meta: {
      generator: plan.generator,
      seed: plan.seed,
      area: plan.area,
      ready: plan.ready,
    },
  };
}

// ─────────────────────────────────────────────────────────── 车位重塑

interface BayRow {
  /** 排内所有车位的中心（世界坐标） */
  centers: Pt[];
  /** 分隔线：相邻车位中点，垂直于排列方向，长度 = 车位进深 */
  lines: [Pt, Pt][];
  /** 前缘线：排的两侧各一条，沿排列方向。两端必须**同侧**，
   *  写成 (lo, fixed-½深) → (hi, fixed+½深) 会得到一条斜穿整排的对角线。 */
  fronts: [Pt, Pt][];
}

/**
 * 把 `parkingBay` 点重塑成车位线。
 *
 * 为什么必须重塑：Placemaker 的车位是**点**（CS2 里车位是个 zone cell，不是对象），
 * 只有 `{x, z, yaw, scale}`。而我们要的是画在地上的线。直接每个点画一个矩形会得到
 * 313 个互相重叠的方块；画成线才对。
 *
 * 做法（利用了实测到的两个性质，见 `tmp` 里的探查）：
 *   - 车位朝向只有 4 个值（0°/90°/180°/270°），所以按 yaw 分 4 组就够；
 *   - 同一组里，垂直于排列方向的坐标只有少数几个值（本例 5 个 = 5 排），
 *     所以按该坐标聚类就能把车位切成排。
 *
 * 排内相邻两个车位的**中点**正好是分隔线所在位置，所以宽度不用猜——从间距直接得来。
 * 只有进深要猜：取宽度的 2 倍（标准车位 2.5×5.0）。
 */
export function baysToMarkings(
  objects: PlanObject[],
  opts: { k?: number; origin?: Pt } = {},
): BayRow[] {
  const k = opts.k ?? 1 / UNIT_M;
  const off = opts.origin;
  const bays = objects.filter((o) => o.role === 'parkingBay');
  if (bays.length === 0) return [];

  // 按朝向分 4 组。yaw 归一到 [0, 2π) 之后四舍五入到 90° —— 量化误差不会让车位错组，
  // 因为 Placemaker 的车位本来就只有这 4 个方向。
  const groups = new Map<number, PlanObject[]>();
  for (const b of bays) {
    const q = Math.round(norm2pi(b.yaw ?? 0) / (Math.PI / 2)) % 4;
    const list = groups.get(q) ?? [];
    list.push(b);
    groups.set(q, list);
  }

  const rows: BayRow[] = [];
  for (const [quadrant, list] of groups) {
    // 0 / 2 → 车位朝 ±Z，排列沿 X（"横排"）；1 / 3 → 排列沿 Z（"竖排"）
    const alongX = quadrant === 0 || quadrant === 2;
    const perp = (b: PlanObject) => (alongX ? b.z : b.x);   // 垂直于排列方向的坐标
    const along = (b: PlanObject) => (alongX ? b.x : b.z);  // 排列方向上的坐标

    // 按 perp 聚类（容差 0.6 m：一排车位在垂直于排列方向上必然共线）
    const sorted = [...list].sort((a, b) => perp(a) - perp(b));
    let bucket: PlanObject[] = [];
    const flush = () => {
      if (bucket.length === 0) return;
      // 一段"排"里可能夹着断口（斜地块上轴对齐排被边界切开，会留下几十米的空档），
      // 所以 buildRow 返回的是**若干连续段**，而不是一整排。
      for (const row of buildRow(bucket, alongX, perp, along, k, off)) rows.push(row);
      bucket = [];
    };
    for (const b of sorted) {
      if (bucket.length > 0 && Math.abs(perp(b) - perp(bucket[0])) > 0.6) flush();
      bucket.push(b);
    }
    flush();
  }
  return rows;
}

/** 把一排里断开的车位切成连续段，每段单独画线。 */
function buildRow(
  bucket: PlanObject[],
  alongX: boolean,
  perp: (b: PlanObject) => number,
  along: (b: PlanObject) => number,
  k: number,
  off?: Pt,
): BayRow[] {
  if (bucket.length === 0) return [];
  const items = [...bucket].sort((a, b) => along(a) - along(b));
  const ox = off?.x ?? 0, oy = off?.y ?? 0;
  const M = (x: number, z: number) => new Pt(x * k + ox, z * k + oy);

  // 车位宽：取相邻间距的中位数。中位数而不是平均 —— 斜地块上跨段的长间隔会把平均拉飞。
  const gaps: number[] = [];
  for (let i = 1; i < items.length; i++) {
    const d = along(items[i]) - along(items[i - 1]);
    if (d > 1.2 && d < 6) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const w = gaps.length > 0 ? Math.min(4, Math.max(2, gaps[gaps.length >> 1])) : 2.5;
  const depth = w * 2;
  const fixed = perp(items[0]);

  // 按 along 的连续性切段：间距超过 1.6 个车位宽就是断口。
  // 不切的话，一条"前缘线"会横穿整块地把中间的车位排全划掉 —— 图上非常显眼。
  const segs: PlanObject[][] = [];
  let cur: PlanObject[] = [items[0]];
  for (let i = 1; i < items.length; i++) {
    if (along(items[i]) - along(items[i - 1]) > w * 1.6) {
      segs.push(cur);
      cur = [];
    }
    cur.push(items[i]);
  }
  segs.push(cur);

  const out: BayRow[] = [];
  for (const seg of segs) {
    if (seg.length === 0) continue;
    const lo = along(seg[0]);
    const hi = along(seg[seg.length - 1]);

    // 分隔线：每段 N+1 条（首尾各一条 + 每个车位之间一条）
    const lines: [Pt, Pt][] = [];
    for (const a of [lo - w / 2, ...seg.map((b) => along(b) + w / 2)]) {
      const x = alongX ? a : fixed;
      const z = alongX ? fixed : a;
      const p0 = alongX ? M(x, z - depth / 2) : M(x - depth / 2, z);
      const p1 = alongX ? M(x, z + depth / 2) : M(x + depth / 2, z);
      lines.push([p0, p1]);
    }

    // 前缘：段的两侧各一条，沿排列方向。两端必须同侧 —— 写成
    // (lo, fixed-½深) → (hi, fixed+½深) 会得到一条斜穿整段的对角线。
    const lo2 = lo - w / 2, hi2 = hi + w / 2;
    const fronts: [Pt, Pt][] = [fixed - depth / 2, fixed + depth / 2].map((s) => {
      const a = alongX ? M(lo2, s) : M(s, lo2);
      const b = alongX ? M(hi2, s) : M(s, hi2);
      return [a, b] as [Pt, Pt];
    });

    out.push({ centers: seg.map((b) => M(b.x, b.z)), lines, fronts });
  }
  return out;
}

/** 线段 → 细长矩形环（两端各留半宽，做成平头而不是斜头）。 */
function bayLineRing(a: Pt, b: Pt, halfW: number): Pt[] | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return null;
  const ux = dx / len, uy = dy / len;
  const nx = -uy * halfW, ny = ux * halfW;
  const ex = ux * halfW, ey = uy * halfW;
  // 顺序是 -n 一侧走到底、再回 +n 一侧 —— 这样环是 CCW，和 `ringOf()` 出来的面一致。
  // 反过来（+n 先走）是 CW：下游 mesh.ts 会 ensureCCW 兜住，但那就成了"桥接的约定要靠
  // 别人擦屁股"，一旦有人直接拿 ring 去用就会整片朝下。
  const ring = [
    new Pt(a.x - ex - nx, a.y - ey - ny),
    new Pt(b.x + ex - nx, b.y + ey - ny),
    new Pt(b.x + ex + nx, b.y + ey + ny),
    new Pt(a.x - ex + nx, a.y - ey + ny),
  ];
  return ring;
}

function countBays(objects: PlanObject[]): number {
  let n = 0;
  for (const o of objects) if (o.role === 'parkingBay') n++;
  return n;
}

// ─────────────────────────────────────────────────────────── 小工具

/** 三次贝塞尔采样成折线。段数按弦长走，直线只要 2 个点。 */
export function sampleBezier(a: Pt, b: Pt, c: Pt, d: Pt): Pt[] {
  const chord = Pt.distance(a, d);
  // 控制点偏离弦的程度决定弯曲度；直线（b/c 在弦上）直接给 2 点
  const bulge = Math.abs(segDist(b, a, d)) + Math.abs(segDist(c, a, d));
  if (bulge < 1e-3 || chord < 1e-6) return [a, d];
  const n = Math.min(24, Math.max(4, Math.ceil(chord / 2)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = 1 - t;
    out.push(
      new Pt(
        s * s * s * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t * t * t * d.x,
        s * s * s * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t * t * t * d.y,
      ),
    );
  }
  return out;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Pt.distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** yaw（3D，0 = +Z）→ rot（2D 画布，0 = +X）。 */
export function yawToRot(yaw: number): number {
  return yaw - Math.PI / 2;
}

function norm2pi(v: number): number {
  const t = v % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/**
 * 环是否简单（无自交）。
 *
 * 为什么不用 `zones.isSimpleRing`：那版对"顶点恰好落在另一条边上"放过（cross < 1e-9），
 * 布尔量化之后这种贴合很常见。但铺装面是要三角化的，顶点压在对边上 earcut 会吐零宽裂缝，
 * 导出 glTF 后就是绕序异常。这里按符号严格相异判，和 modern.ts 的 simpleRing 同源。
 */
function simpleRing(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const cr = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    if (Math.abs(cr(a, b, c)) < 1e-12) return false;   // 三点共线 → 退化
  }
  // 非相邻边相交检测。面都不大（几十个点），O(n²) 足够。
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      if (segmentsCross(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

function segmentsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
