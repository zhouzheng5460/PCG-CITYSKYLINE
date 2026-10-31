# placemaker-core-lib

把 Placemaker 的 `Core/`（465 个 .cs）从 Cities: Skylines II 的 ECS 环境里**抽出来，做成纯 .NET 6 类库**——路线 B 的可行性验证工程。

> **当前状态：已验证可用。** `PlacemakerCore.dll` 编译成功，0 警告 0 错误（465 个 Core 文件，未引用任何游戏程序集）；自检 38 条全绿；驱动器跑通 **7 个路网场景**（出入口建议 / 接驳渠 / 连通性），并通过反射把 **130 个 `[AreaGenerator]` 全部跑了一遍**：**128 个能出内容，0 个抛异常、0 个超时**（详见「阶段 3」）。

原始 `Placemaker.csproj` 硬引用 `Cities2_Data/Managed/*.dll`（Game、Colossal.*、Unity.*），本机没装 CS2，所以原工程在这里**无法编译**。本工程换掉这条路：不引用任何游戏程序集，只补一层 `Unity.Mathematics`。

## 结构

```
placemaker-core-lib/
├─ PlacemakerCore.csproj        # 用 glob 直接编译原始 Core 源码（不复制文件）
├─ Compatibility/
│  └─ UnityMathematics.cs       # 手写 Unity.Mathematics 子集（按实际用量，非全集）
├─ SelfTest/                    # 最小自检程序（无测试框架依赖，失败即非零退出）
├─ Driver/
│  ├─ Program.cs                # 阶段 2：7 个路网场景 + SVG 渲染
│  └─ Sweep.cs                  # 阶段 3：反射枚举全部生成器，4 种语境各跑一次
├─ tools/
│  ├─ scan-math-surface.mjs     # 静态核对：Core 用到的 API vs 兼容层已声明的 API
│  ├─ lint-shim.mjs             # 编译前查重复签名（CS0111/CS0102）
│  └─ contact-sheet.mjs         # 把 out/sweep/*.svg 拼成一张联系表
├─ build.bat                    # 一键：编译 + 自检 + 场景 + 全量扫描，写 build.log
└─ MATH_SURFACE_REPORT.md       # 静态核对结果（自动生成）
```

`PlacemakerCore.csproj` 用 `<Compile Include="..\placemaker-master\placemaker-master\Core\**\*.cs" />`，**不复制**源码。改 Core 后本工程即时生效，不会出现两份代码漂移。

## 为什么能抽出来

对 `Core/` 全部 465 个文件逐项核实过依赖面：

| 检查项 | 命中数 |
|---|---|
| `using Unity.Mathematics` | 341 |
| `using Unity.Entities` / `Unity.Burst` / `Unity.Collections` | **0** |
| `using Game` / `using Colossal.*` | **0** |
| `[BurstCompile]` / `NativeArray<` / `NativeList<` | **0** |
| `UnityEngine.` | **0** |
| `unsafe` / `stackalloc` | **0** |

结论：`Core/` 只依赖 `System.*` + `Unity.Mathematics`，是**引擎无关的纯算法层**。`Game/`（173 文件，112 处 `Unity.Entities`、47 处 `Colossal.*`）才是 ECS 适配层，没被编进来。

## 数学兼容层怎么定的范围

不是照抄 Unity.Mathematics 全集，而是**先扫描再实现**：

- 统计 Core 实际调用的 41 个 `math.*` 函数及其**参数个数**（如 `math.sincos` 只用到 3 参形式）
- 统计 20 个数学类型的实际构造重载、成员访问、swizzle
- 生成 `MATH_SURFACE_REPORT.md` 做 diff，直到五类缺口全为 0

复跑扫描：

```bash
node tools/scan-math-surface.mjs
```

扫描过程中排掉的几个坑：

- **`half` 是假信号**。全文出现 427 次，看着像用了 `Unity.Mathematics.half` 类型，实际全是叫 `half` / `half8` 的**局部变量**（如 `float half8 = LotSize * 0.5f;`）。若按类型去实现，反而会引入一套错误的 float 语义。
- **`<` `>` 不是泛型括号**。第一版扫描把 `math.max(a < 0 ? 0 : a, b)` 里的比较运算符当成嵌套深度，导致大量参数个数误报。
- **构造重载要单独认**。`public float2(float x, float y)` 没有返回类型，普通"方法"正则抓不到，会被误判成"只声明了 1 个参数"。
- **`System.Random` 与 `Unity.Mathematics.Random` 同名**，同时 `using` 两个命名空间会 CS0104 二义。自检程序里用别名 `Rng` 规避。

## 与官方实现的差异（有意为之）

| 项 | 差异 | 影响 |
|---|---|---|
| `math.hash` | 官方是 xxhash 的特定实现，这里是自写确定性混淆 | 同一 seed 在本库和游戏里图案不同；统计性质与可复现性一致。要对齐只需替换 `hash` 一节 |
| `Random` | 官方私有 xorshift 变体 → 这里标准 xorshift32 | 同上；`NextFloat ∈ [0,1)`、`NextInt(min,max)` 左闭右开等语义已对齐 |
| `half` | 不实现 | Core 未使用（见上） |
| `normalizesafe` | 阈值用 `1e-12` | 官方用 `1.1754944e-38`；1e-12 以下已是数值噪声，对布局决策无实质差别 |

`Random` 必须是**可变 struct**：Core 里大量 `ref Random rng` 传参、靠推进 `state` 取随机数。这一点如果做成 class 或只读 struct，语义会整个变质。

## 怎么跑

双击 `build.bat`（或在命令行里跑），它会：

1. `dotnet build PlacemakerCore.csproj`（编译 465 个 Core 文件 + 兼容层）
2. `dotnet run --project SelfTest`（跑 38 条断言）
3. `dotnet run --project Driver -- out --no-sweep`（7 个路网场景 → `out/plan-*.svg`，并检查车道网连通性）
4. `dotnet run --project Driver -- out --sweep`（130 个生成器 × 4 语境 → `out/sweep/*.svg`、`out/sweep.md`、`out/sweep.csv`）
5. `dotnet run --project Driver -- out --recipes`（13 个手写嵌套 + 69 个自带 recipe → `out/recipes/*.svg`、`out/recipes.md`、`out/recipes.csv`）
6. 全程输出写入 `build.log`；失败时把 `error` 行直接打到屏幕上

另有一条独立入口，不参与 `build.bat`：

```bash
dotnet run --project Driver -c Release -- --emit cases/parking-150x100.json out/emit/plan.json
```

```
ALL GREEN                     → 库可用，图已生成
FAILED + error 行             → 把 build.log 发回，按报错补兼容层
```

拼联系表（可选，需 sharp）：

```bash
node tools/contact-sheet.mjs   # → out/sweep-sheet.png   130 个生成器的联系表
node tools/recipe-sheet.mjs    # → out/recipes-sheet.png 13 个嵌套用例的联系表
node tools/render-recipe.mjs c02_roads_park   # 单张 SVG → PNG
```

### 驱动器在验证什么

编译通过只说明"类型对得上"。`Driver` 把 Core 当黑盒来用，验的是另一件事——**算法真的能跑出结果**：

```csharp
var gen  = new ParkingLayer();
var input = new AreaInput {
    Shape  = new AreaShape { Ring = ring, Source = AreaSource.Drawn },
    Site   = new SiteContext { LayoutScale = 1f, EdgeMargin = 2f },
    Settings = gen.Defaults(),
    Seed   = 1234u,
    RegionTags = new[] { "root" },
};
var plan = gen.Plan(input, CancellationToken.None);
```

`AreaInput` 的全部输入都是可自造的（高度函数默认 `_ => 0f`、路网/障碍物默认为空），所以**不需要游戏运行时**就能出结果。输出 `AreaPlan` 里是 `Surfaces` / `Nets`(三次贝塞尔) / `Objects` / `Areas` / `Regions` / `Stats` / `Issues` / `Facts`，驱动器把它们按角色上色画成 SVG。

自检覆盖：float2/3/4 运算与 swizzle、向量几何、限幅插值、sincos、float2x2、`hash` 确定性、`Random` 同种子可复现与区间约束、`Random` 状态推进（struct 可变性）、以及**真实 Core 代码**（`Placemaker.Core.Layers.Common.Hashing`）的调用。

## 阶段 2：接真实路网，验证出入口与连通

第一版驱动器只跑了「四周无路」的地块，`EntranceSuggest` 直接返回空、`CheckReady` 报 `NeedsEntrance`——那只证明算法**正确地说没路**，没证明有路时能用。这一版给 `SiteContext.NearbyNets` 喂真实路（三次贝塞尔 + 宽度 + 单双向），一次覆盖 `EntranceSuggest` 的全部分支：

| 场景 | 路网 | 放置前 | 放置后 | 建议 | 车位 | 接驳口/其中挂接 | 连通分量 | 孤立车道 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|
| `none` | 无 | NOT | NOT | 0 | 318 | 0/0 | 1 | 0 | 431 ms |
| `street` | 南侧 190 m | NOT | **READY** | 1 | 313 | 1/0 | 1 | 0 | 27 ms |
| `alley` | 同上 + `entranceStyle=alley` | NOT | **READY** | 1 | 313 | 1/**1** | 1 | 0 | 21 ms |
| `corner` | 西南转角两条街 | NOT | **READY** | 2 | 309 | 2/0 | 1 | 0 | 21 ms |
| `short` | 南侧仅 60 m | NOT | **READY** | 1 | 313 | 1/0 | 1 | 0 | 18 ms |
| `wide` | 240×90，240 m 临街 | NOT | **READY** | 2 | 506 | 2/0 | 1 | 0 | 44 ms |
| `attach` | 无路网快照，仅边界附着 | NOT | **READY** | 1 | 313 | 1/0 | 1 | 0 | 18 ms |

### 读出来的四条真实行为

1. **`CheckReady` 根本不看路网**，只数 `input.Markers`：一个双向出入口，或「单向进 + 单向出」各一个，就算就绪。路网只在 `SuggestMarkers` 里参与。
2. **「入口与出口分开」有距离门槛**：地块面积 > 6000 或周长 > 320 时，两点间距须 ≥ `max(40, 周长 × 0.15)`。15000 m² / 150 m 临街 → 门槛 75 m，而从中点算起最多只有 ~70 m，**只能放一个双向口**；240 m 临街的 `wide` 才拉开 `entry@t=0.498 / exit@t=0.915`。所以「大块地一定有两个口」是错的。
3. **`connect` 与 `alley` 的差别不只是外观**：默认 `connect` 走 LocalConnect，渠头停在路缘做 free node，`StartAttach/EndAttach` 保持 `-1`；只有 `alley` 形态才写 `EndAttach = road.ExternalId`（`alley` 场景 id 命中，`1/1`）。这也是「图上看着连上了」和「数据里真的挂上了」的差别。
4. **出入口是实打实吃车位的**：150×100 从 318 → 313；转角两个接驳 → 309（每个口切掉一排位）。

`attach` 场景仍留一条 `EntranceNoRoad` 警告，是正确行为：只有边界附着、没有路网快照，算法不知道渠该往哪接。

### 连通性怎么验的

不靠看图。`Analyze()` 做两路证据：

- **几何**：把每条中心线按 8 等分采样成折线，两段只要「端点落在对方折线 1 m 内」（含 T 型接入）就并进同一节点，用并查集求连通分量；再从 `DriveConnector` 所在分量出发，数有多少 `DriveAisle` 走不到它。
- **显式**：`PlannedNet.StartAttach/EndAttach` 是否命中我们喂进去的既有道路 `ExternalId`。

结果：7 个场景全部 **1 个连通分量、0 条孤立车道**——接驳渠 → 周边环路 → 各排车位之间的纵向车道，是真的连成一张网。



静态扫描能保证**函数名和参数个数**不缺，但保证不了下面这几件"语法层面才暴露"的事。第一轮 75 个错误全部落在这几类，且全在兼容层里（Core 自身 0 语法错误）：

| 类型 | 报错 | 真相 |
|---|---|---|
| 显式窄化 | CS0030 `(int2)math.floor(float2)` ×31 | 必须提供 `explicit operator int2(float2)`；`int3←float3`、`int4←float4` 同理 |
| 向量索引器 | CS0021 `float2[along]`、`int3[e]` ×23 | Unity.Mathematics 的向量类型都有 `this[int]`，Core 用它遍历分量 |
| swizzle 可写 | CS0200 `pos.xz += ...` ×3 | 双分量 swizzle 必须是**带 setter 的属性**，只读属性会让 `+=` 失败 |
| 长整型重载 | CS0266 `long = math.max(long, ...)` | 缺 `max(long,long)` 时编译器会把 long 隐式提到 float，返回值再赋回 long 就炸 |
| 双精度重载 | CS1503 `atan2(double,double)`、`cmax(double2)` | `Geometry` 层（Arrangement / PlanarGraph / Poly.Ops）走双精度，float-only 的实现不够用 |

`tools/lint-shim.mjs` 可以在跑编译器之前先抓出"同一类型里签名重复"（CS0111/CS0102）这类必然错误：

```bash
node tools/lint-shim.mjs
```

## 阶段 3：130 个生成器全量扫描

`Driver/Sweep.cs` 用反射枚举 `Core` 里所有 `[AreaGenerator]` 的实现类，`Activator.CreateInstance` 之后当普通对象调 `Plan(...)`。目的不是跑某一个图层，而是回答一个工程问题：**「能抽出来」是只对停车层成立，还是对整个 `IAreaGenerator` 契约成立？**

同一块地（按各自 `MinArea` 缩放到 6000–40000 m²）、同一个种子 1234，每个生成器跑 4 种语境：

| 语境 | 给了什么 |
|---|---|
| `bare` | 孤立地块，四周无路 |
| `street` | 南侧贴一条 8 m 双向街 |
| `grid` | `street` + 覆盖全地块的分区网格（`ZoneGrid`，8 m 格） |
| `wet` | `street` + 北侧 38% 水面（水深 1.6 m） |

### 结果

| 判定 | 数量 | 含义 |
|---|---|---|
| OK | **128** | 至少一种语境下有内容 |
| EMPTY | 2 | 上下文依赖，见下 |
| THROW / TIMEOUT / 构造失败 | **0** | 契约「不因坏几何抛异常」成立 |

按「最少需要什么」拆：

| 最少语境 | 数量 | 是哪些 |
|---|---|---|
| `bare` 就能跑 | **109** | park / plaza / playground / campground / 各类场地、废墟、农场… |
| 需要临街 | 1 | `edgeZoning`（沿街商铺，没街就没铺面） |
| 需要分区网格 | **17** | 9 个 `zoning*` + 8 个 `polish*` |
| 需要水面 | 1 | `shore`（无水下给 `Issue.NoWater`，属正确拒绝） |
| 全都空 | 2 | `ai`、`decals`，见下 |

520 次运行（130 × 4）墙钟 **10 秒**，最慢单个 470 ms（`stripMall`）。

产物：`out/sweep/<id>.svg`（128 张）、`out/sweep.md`（索引 + 逐项证据）、`out/sweep.csv`（4 语境 × 130 行）、`out/sweep-sheet.png`（联系表）、`out/highlights.png`（split / plaza / park / pond / campground / roads 放大对比）。

### 三个「看着失败、其实是设计」的

1. **`zoning*` / `polish*` 需要 `SiteContext.ZoneGrids`**。`PlanZoning` 第一件事就是 `foreach (var g in site.ZoneGrids)`——分区是「沿路一格一格排地块」，没有网格就没有可排的地。我按 `ZoneGuard` 的约定自己造了一个：`Cell = 8 m`、`Position` 是**网格中心**、`Direction = (0,-1)` 让第 0 行贴着南侧那条街、`Cells = null` 表示全部可建。造出来之后 17 个全部产出。**这是全库唯一需要「游戏数据」的地方，而这份数据是可以合成出来的。**

2. **`decals` 默认主题是 `leaves`**：落叶只落在树冠下，而树是**父图层**通过 `ReservedSpace.Discs` 留给它的；没有父层 → 没有宿主 → 一片叶子都不放。
   > 阶段 4 更正：即使给了父层（`park ─ decals`），它仍然是 0 件。s33 之后落叶改走**地形贴图**（`plan.Paint`），`DecalsAddOn` 这条对象通道在当前版本已空转，别再指望它。

3. **`ai` 不吃 `AreaInput`**：它读 `AiPlan.Current`——一个 `public static readonly` 单例，由 LLM 构建器填。**130 个生成器里唯一一个破坏纯函数契约的**；移植时要单独处理（把 AI 结果塞进 `AreaInput`，或保留单例并接受不能并发/重入）。

### 两个会在接游戏时咬人的点

- **`AssetAvailability.Has()` 在没有发布快照时返回 `true`**（「未知 = 假定有」）。所以离线跑**不会**报「没装资产」，而是照常规划、`AssetRef` 里是空 id。接真实资产前必须先 `Publish(...)` 一份目录，否则桥到 GLB 时没有模型可用。
- **分区走的是第四条输出通道**：`plan.Zoning`（`A/B/C/D` 四边形 + `ZoneId`），不是 surfaces/nets/objects。只统计前三条会把 17 个分区图层误判成「没产出」——第一版 SVG 渲染就踩了这个坑。

## 阶段 4：Recipe 父/子图层嵌套

阶段 3 只证明「130 个生成器各自能跑」。真正要接到 TownForge 上，产出的是**一整块街区**：路网先铺，块地交给公园，公园中心挖出广场再交给广场层，临街条带交给分区层。这条链只有走 `Composer` 才能验证。

`Driver/Recipes.cs` 做三件事，全部经由 `RecipeJson.Parse`（和游戏读存档同一条代码路径）：

| 组 | 数量 | 是什么 |
|---|--:|---|
| 手写嵌套 | 13 | 覆盖 `Composition.cs` 头注释列出的每一种组合（add-on / block / edge / part / place / regionOverrides / 三层 / 失败隔离） |
| 仓库自带 | 69 | `Recipes/*.json` 原文件，验证真实文件兼容性 |
| 负向 | 3 | 子层 id 不存在、根层 id 不存在、target 落空 |

站点固定 200 × 140 = 28000 m²，南侧一条 8 m 双向街，8 m 分区网格铺满。手写用例落盘在 `out/recipes-cases/*.json`，改完重跑即可。

### 每个用例都做三项结构断言

看图「像不像」不算验证，所以每个用例都算了三个硬指标：

1. **target 命中**：recipe 里写了 `target "block"`，父层到底有没有 `block` 区域。写错标签会被抓出来（`c11` 故意写成 `park ─ plaza(target block)`，报 `0/1`）。
2. **被点名区域已填**：被某个 target 点过名的区域，有没有子步骤真的落进去。没落进去 = 空洞。
3. **归属包含**：子层对象有多少落在它被指派的那个区域环内（`Poly.Contains` 逐个数）。

`green:0` / `paved` / `core` 这类是给子层看的**说明性区域**，没人点名属正常，不计入空洞 —— 第一版把 49 个区域全算进去，报出「43 个空洞」的假警报。

### 结果

**82 个用例 / 148 层 / 7.1 秒，PASS 82、FAIL 0、CRASH 0，被点名却没人填的区域 0 个。**

最典型的四张：

| 用例 | 形态 | 结果 |
|---|---|---|
| `c02_roads_park` | `roads ─ park(target block)` | 路网切出 6 个块，6 个块各跑一次 park；37/37、33/33… 对象 100% 落在自己那块里 |
| `c06_park_plaza_place` | `park ─ plaza(target place:plaza)` | 公园为子层**挖出**直径 ~50 m 的圆广场，广场层填了 78 面 + 66 物件，64/66 在环内（2 个是压边的树） |
| `c07_roads_split_parks` | `roads ─ split(block) ─┬ park(part:0) └ plaza(part:1)` | 19 层；6 块 ×（切分 + 公园 + 广场）全链条，18/18 区域被填 |
| `c12_split_zoning_park` | `split ─┬ zoningTownCentre(part:0) └ park(part:1)` | 一半出 15 个分区格、一半出公园 —— 最接近真实"开发地块"的一张 |

产物：`out/recipes/<id>.svg`（82 张多图层图，图例标 `#i 图层 id @区域键`）、`out/recipes-sheet.png`（13 张手写用例的联系表）、`out/recipes.md`（总表 + 逐层明细）、`out/recipes.csv`。

### 读出来的五条真实行为

1. **`place:*` 是"父层为子层挖地"的唯一机制**。park 不会平白无故做广场；是因为 `ChildTargets` 里有 `place:plaza`，它才把广场那块从自己的种植/铺装里剔出来并登记成区域。反过来，`roads` 的 `block`/`edge` 是**先有区域、子层再挑**，方向相反。这两种父子关系在代码里是两套路径（`ReservePlaces` vs `plan.Regions`），接 GLB 时要分开处理。

2. **子层顺序就是优先级**。`Composer` 按 `Children` 数组顺序跑，先跑的先 `Reserve` 空间。但实测（`c03` vs `c13`，只把两个子层对调）分区格数量一模一样（都是 8 格）—— 说明真正拦住分区的不是顺序，而是下面第 3 条。

3. **`zoning*` 不能在 `roads` 的 `block` 里分区**。6 个块跑 6 次 `zoningSuburb`，一共只出 8 个分区格，其余全被 `CutoutNotZonable` 拒掉 —— 因为 `ZoneGuard` 要保证「build 范围内的城市地块不被重新分区」。分区要生效，得在**没有 cutout 的自由地块**上做（`c12` 的 `split part:0` 就正常出 15 格）。

4. **`edgeZoning(target edge)` 作为 roads 子层已经被删掉了**。`RecipeJson.Read` 里的 `RoadsLayer.Migrate` 会把这种子层移出并改写 `preZone`，而 `RoadPreZone.Offered = false`（"zoning is the Zoning category's job"）。老存档读进来不会报错，但那个子层**静默消失**；判断"recipe 有没有被迁移过"只能比 `Layers.Count`。

5. **失败隔离真的成立**。`c09` 一个子层 id 不存在 → 报 6 条 `UnknownLayer`（每个块一条），兄弟 `park` 照常出 6 层；`c10` 根层 id 不存在 → 只有 1 条 `Error`、0 层、不抛异常；`c11` target 落空 → 不报错，只是 `TargetsHit 0/1`。**这三种情况都不该让整张 recipe 失败**，桥接层要能分别处理。

### 给桥接层的三个约定

- **`AreaPlan.StepPath` 是唯一的层级线索**，格式 `<步骤索引链>@<区域键>`，例如 `0/0/1@part:0`。父层 = 去掉最后一个 `/段`。同一个父步骤会对 N 个区域各跑一次，所以 `StepPath` 的路径部分**不唯一**（6 个块 → 6 个 `0/0`），别拿它当主键。
- **`target` 匹配规则**是 `target == region.Key` 或 `target ∈ region.Tags`，两者都算命中；但子层实际跑在哪个区域，只能从它自己的 `StepPath` 尾巴读出来。
- **顺序敏感**：同一批对象既会出现在 `plan.Paint`（地形贴图，park 的草地在这儿）、`plan.Surfaces`（真正的面）、又会出现在 `plan.Zoning`。桥 GLB 时三者都要，少一条就会看到"公园是块空地"。

## 阶段 5：`--emit` —— 把 Plan 导出给外部引擎

阶段 1–4 都只在"自己看"：出 SVG、出表格。要真正用在别的引擎里（TownForge），缺一个把
`AreaPlan` 说成人话的出口。`Driver/Emit.cs` 就是这个出口。

```bash
dotnet run --project Driver -c Release -- --emit cases/parking-150x100.json out/emit/plan.json
```

**输入**（只需要"地块 + 临街"，其余可选）：

```json
{
  "generator": "parking",
  "seed": 1234,
  "shape": { "ring": [[0,0],[150,0],[150,100],[0,100]] },
  "streets": [
    { "id": 9001, "a": [-20,-8], "b": [170,-8], "width": 8, "sidewalk": true }
  ],
  "settings": {},
  "markers": [],
  "zoneGrids": [],
  "water": { "axis": "z", "at": 62, "depth": 1.6, "side": "above" }
}
```

**输出**：七条通道降到二维，`surfaces / nets / objects / areas / regions / zoning / paint`，
外加 `stats` / `facts` / `issues`。CS2 特有的东西（`AssetRef`、`Control`、`Category`、`Upgrades`）
全部丢掉 —— 外部引擎一个都用不上。

### 三条约定

| 约定 | 内容 | 为什么 |
|---|---|---|
| 单位 | 一律**米** | Core 的 `MinArea` / `CheckReady` / `minApart` 全按米算；换算必须在调用方做，否则"这块地能不能跑"和"这块地多大"来自两套单位 |
| 坐标 | 平面写 `[x, z]` | Core 的 `float3` 里 y 是高度、xz 才是平面；拍平时只取 xz，高度单列在各自的 `y` 字段 |
| 角色 | 小驼峰字符串（`driveAisle` / `parkingBay`） | 消费方不需要认识 C# 枚举 |

### 顺序：先建议出入口，再判就绪

第一版按 `CheckReady → SuggestMarkers → Plan` 调，结果 parking 一律 `ready=no`
（`Reason.NeedsEntrance`）——因为 `CheckReady` **只数 `input.Markers`**，完全不看路网。

正确的顺序是 `SuggestMarkers → CheckReady → Plan`：玩家还没点出入口时，工具一打开就把建议口
画出来了，此刻是 ready 的。`SuggestMarkers` 不依赖已有 marker，所以可以先跑。

### 找生成器不用 `GeneratorRegistry.All`

它用 `Activator.CreateInstance` 一次建全部，任何一个 ctor 抛异常就整体失败（阶段 3 踩过）。
`Emit` 只反射遍历类型、`new` 到目标那一个为止。

### 验证过的数字

| 地块 | 生成器 | 结果 |
|---|---|---|
| 150×100 m（15000 m²，南侧一条街） | `parking` | 39 面 / 41 渠 / 683 对象 / 313 车位 / 16 ms |
| 梯形（12491 m²，136.7 × 107.5 m，46 条临街边） | `parking` | 36 面 / 45 渠 / 593 对象 / **276 车位 / 2 个出入口** / 19 ms |

第二行是 TownForge 的真实地块（`tools/bake-plan.ts` 从 `Model` 里取的），
消费端的验证在 `townforge-enhance/test/placemaker.test.ts`（24 项）与 `bridge-glb.test.ts`（9 项）。

## 许可

`Core/` 来自 Placemaker（GPL-3.0）。本工程编译它，因此**产物是 GPL-3.0 衍生作品**：一旦对外分发（含闭源分发二进制），必须同样以 GPL-3.0 提供源码。仅在本地/内部使用不触发分发义务。`Compatibility/UnityMathematics.cs` 为本工程自写，但与本库链接分发时同样受整体许可约束。

## 下一步

- [x] 本机编译通过 + 自检全绿
- [x] 接真实入口：`IAreaGenerator.Plan(AreaInput, CancellationToken)` → `AreaPlan`
- [x] 接真实路网：`SiteContext.NearbyNets` → `EntranceSuggest` → 接驳渠，7 场景 + 连通性检查
- [x] 全量扫描：130 个生成器 × 4 语境，128 个出内容，0 异常
- [ ] 换成 `RoadsLayer` 出街网，与 TownForge 的 `modern.ts` 布局做同尺度对比
- [ ] 把 `ComposedPlan`（4 条输出通道：surfaces / nets / objects+zoning / paint）桥到 TownForge 的 `TownModel`，做"Placemaker 布局 + TownForge 出图"
- [x] 跑通 recipe 组合：13 个手写嵌套 + 69 个自带 recipe，82/82 PASS，0 空洞
