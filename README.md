# PCG-CitySkyline

把两个成熟的开源城市/场地生成器拆开、重新接线，做一条能出 3D 资产的程序化城市流水线。

- **Placemaker**（Cities: Skylines II 的场地设计器，GPL-3.0，465 个 .cs）——它的内核逻辑写死在游戏 ECS 里，本工程把它抽成不依赖游戏的纯 .NET 类库。
- **TownGeneratorOS**（Medieval Fantasy City Generator 的源码，Haxe）——本工程把它移植成 TypeScript，并换上一整套现代城市内容层。
- **桥接层**——让 Placemaker 输出的「规划方案」驱动 TownForge 的场景，得到可导出的 GLB。

一句话：**Placemaker 负责「这块地上该有什么」，TownForge 负责「长成什么样、怎么导出」。**

## 目录

| 目录 | 内容 | 语言 |
| --- | --- | --- |
| `placemaker-core-lib/` | 从 CS2 版 Placemaker 抽出的内核库 + 自检 + 驱动器（场景 / 全量扫描 / 配方） | C# / .NET 6 |
| `townforge-enhance/` | TS 版城市生成器：现代城市内容层、禁建区、路宽可编辑、GLB 导出、Placemaker 桥接 | TypeScript |
| `placemaker-master/` | Placemaker 上游的 `Core/`（465 个 .cs）+ `Recipes/`（83 个配方），编译所需的源码，**已内置** | C# |

前两个子工程各带一份 README，细节看各自的。

## 前置条件

- .NET SDK 6.0+
- Node.js 18+

**没有第二步**。上游源码已经随仓库分发：`placemaker-master/placemaker-master/Core/` 与 `Recipes/`，clone 下来就能编译、能跑配方。UI / Lang / docs / Tests 等与本工程无关的部分（100M+）没有带。

`placemaker-core-lib` 的 csproj 用 glob 直接编译上面那份 Core，**不复制文件**——改 Core 即时生效，不会出现两份代码漂移。

## 跑起来

```bash
git clone git@github.com:zhouzheng5460/PCG-CITYSKYLINE.git
cd PCG-CITYSKYLINE

# 1) 内核库：编译 + 自检 + 7 个路网场景 + 130 个生成器扫描 + 82 个配方
cd placemaker-core-lib
./build.bat -y                   # -y = 跑完不停；双击运行则省略，会在结尾等你看结果
                                 # 产物在 out/，日志 build.log，全绿会打印 ALL GREEN

# 2) 城市生成器
cd ../townforge-enhance
npm ci                           # 按 package-lock 精确装依赖
npm run dev                      # 本地编辑器 (vite)
npm run test:bridge              # 桥接
npm run test:hedge               # 绿篱拟合
npm run test:bridge-green        # 绿地一族（20 份方案）
npm run test:yards               # 堆场 / 废车场 / 跑道 / 球场（5 份方案）
npm run test:obstacles           # 建筑避让
npm run test:bridge-glb          # GLB 导出
npm run score                    # 所有方案的覆盖率 / 密度 / 网线长度
```

烘焙一份新方案（需要先 `build.bat` 出 `PlacemakerDriver.dll`）：

```bash
npx tsx tools/bake-plan.ts --patch 42 --gens carYard,junkYard,runningTrack,scrapyard,pitch
npx tsx tools/bake-plan.ts --patch 90 --gen carYard --keep --clip   # 保留建筑，按楼裁剪
npx tsx tools/plan-svg.ts pitch        # 真 2D 渲染器出图（编辑器同一条路径）
npx tsx tools/inspect-pm.ts pitch      # 单块地 3D 预览
```

## 已验证的结果

| 项目 | 结果 |
| --- | --- |
| 内核库编译 | 465 个 Core 文件，**0 错误 0 警告**，未引用任何游戏程序集 |
| 自检 | 38 条全绿 |
| 生成器覆盖 | 130 个 `[AreaGenerator]` 反射全跑，**128 个有输出**，0 抛异常 0 超时 |
| 配方 | 82 个（13 嵌套用例 + 69 官方配方）全部渲染成功 |
| 生成器接入总数 | **31 个**（parking 1 + 绿地/花园 19 + 堆场/球场 5 + 铺装/商业 6）；`plaza` / `parking` / `park` 另有 3 个保留建筑的 `--keep` 组合 |
| 堆场 / 球场一族 | 5 个生成器出方案：`carYard` 809 件道具、`junkYard` 717、`scrapyard` 509、`runningTrack` 651（其中 642 条白线）、`pitch` 360（340 条白线） |
| 铺装 / 商业一族 | 6 个生成器出方案：`marketSquare` 356 件道具、`mallPark` 300、`stripMall` 265、`abandonedLot` 258、`outdoorMall` 162、`shopsPark` 113；`stripMall` 铺装 30% + 宗地 27% |
| 建筑避让 | 4 塔楼占地块 43% 的工况下，铺装 + 建筑覆盖 **97%**，压进建筑重叠 **0.00 m²** |
| 回归不变量 | 全城基线三角形数 **175507**（未接 Placemaker）与 **181696**（接 parking）逐位不变 |

## 几个必须知道的坑

这些是踩出来的，写下来省得重踩：

1. **Placemaker 不产建筑。** `ObjectRole` 里根本没有 Building。它是纯室外场地设计器，建筑只以「障碍物四边形」的形式出现，用来避让。
2. **七通道只消费五个半。** Placemaker 的方案有 `surfaces / nets / objects / areas / regions / zoning / paint / terraform`，桥接用 `surfaces / nets / objects / zoning / terraform`，外加 `paint` 的**底色**（见第 11 条）；`regions`、`areas` 仍然丢，`terraform` 也只画轮廓不抬高度。`zoning` 是**留给建筑的宗地**（见第 13 条），丢了会让商铺类生成器看起来像规划失败。
3. **`polish*` 是表面精修层。** 它只改已有地面的材质贴花，给它裸地就输出 0 个元素——而且返回 `ready=yes`，很容易误判成「可用」。
4. **绿地生成器不铺地面。** `park / greenwayPark / picnicGrounds / natureReserve` 的 surfaces 为空（在 CS2 里地面就是地形）。所以要单独补草地底，否则场景是空的。
5. **`gen.Plan()` 绕过 `Composer`。** 正常管线里 `SiteSafety.Apply` 由 `Composer.Compose` 调用，直接调 `Plan()` 就不会跑——障碍物会被收下但没人用。驱动器里手动补了一次。
6. **`SiteSafety` 的语义是「删」不是「绕」。** 面积型生成器（广场、花园）贴着楼断得很干净；路网型（停车场 53 条车道被切成 1 条）会被切坏。解法是**别让它面对有楼的地块**：让 Core 不知道有楼地排满，再由 bake 层按建筑裁剪（`bake --clip`）。同一块 13123 m²、4 栋楼占 43% 的地块上，车道从 1 条恢复到 39 条、网线总长 35 m → 291 m，铺装覆盖率 99%，压楼 0 m²。
7. **绿篱的判据是 yaw。** Placemaker 排绿篱时整条线共用同一 yaw（yaw 是线的**法向**，走向 = yaw+90°）；随机撒点时每颗朝向都不同。用这个差异区分「成排」和「散点」，两道闸：整体朝向档数 + 组内至少 3 颗。
8. **TownForge 的坐标系约定**：`UNIT_M = 7`（1 单位 = 7 米），`[x,z] → Pt(x,y)`，`rot = yaw − π/2`。错一处整层旋转。
9. **`furniture` 是通用角色，必须看 `category`。** Placemaker 把「任何带资产的杂项」都叫 `furniture`：堆场的集装箱、废车、油桶、隔离墩，公园里的野餐桌和菜畦，全是它。20 份方案里出现 25 种分类、2500 多件——原来一律映射成长椅，于是自然保护区长了 314 张长椅（那是 `rock` 石块）、车场 809 张。驱动器现在把 `category` 写进对象（`Emit.cs`），桥接按分类查表，查不到的走 `crate`（一个灰盒子）而不是长椅。
10. **标线不是「线」，是沿线撒的贴花串。** 球场的白线在 Plan 里是 `decal` 对象，沿线段每隔 `lineSpacing`（默认 1.5 m）放一件，只有点位和朝向，尺寸在资产网格里。桥接按分类给尺寸、把点位摊成 1.7 m 的窄条（比 1.5 m 略长，让它们重叠而不是对接，否则细线渲染出来是一串虚线）；整场贴花（68 × 52.5 m 的半场纹理）**不能**铺成实心面，只画外框。
11. **`paint` 是刷地表材质，不是几何。** `layer` 1 干草 / 2 林地 / 3 泥土 / 4 沙，`strength` 是强度。照原样画成实心面会得到一块纯色板，200 多块叠起来必然 z-fighting。桥接只用它决定**地块底色**：某一块 ≥ 地块 20% 且强度 ≥ 0.8 时，把最底层地面换成对应材质。`carYard` 的铺装只占 21%，剩下 79% 是刷出来的泥土——改底色前那是一片草坪。
12. **`bake-plan.ts` 的临时文件不要事后拼名字。** 单块地时文件名没有 `.whole` 后缀，`--gens` 批量烘焙会拿到不存在的路径直接 ENOENT。现在按实际落盘的路径记录。
13. **`zoning` 是「留给建筑的地」，不是可以丢的通道。** 它有 `zoneId`（`EU Commercial Low`）和一块四边形，标的是「这里将来长一栋楼」。`stripMall` 铺装只占 30%，剩下 27% 就是它——不画的话那块地是一片没来由的草坪。现在铺一层砾石（`pm/zoning/<zoneId>` 分组），读作「场地平整过、等着盖」。
14. **商场和市场族不自己找门。** 源码原话：the player places them on the outline, nothing is suggested and Build waits for a way in for cars。没有门就整块 `ready=no`、一个面都不出（`stripMall` / `mallPark` / `marketSquare` 全中）。烘焙工具只能在**被拒绝时**替它放一个：最长临街边中点、kind `entrance`（双向车行门，商场族和市场族都认）。**不能无条件塞门**——公园族的 `entrance` 是步行门，塞了会改掉已有 25 份方案的布局。

## 许可

两个上游都是 **GPL-3.0**，本仓库的两个子工程都是它们的派生作品，因此整体同样以 GPL-3.0 分发：

- `placemaker-core-lib` — 派生自 Placemaker（Cities: Skylines II 场地设计器），GPL-3.0。其 `Core/` 与 `Recipes/` 原样内置在 `placemaker-master/`，许可证见该目录下的 `LICENSE`。
- `townforge-enhance` — 派生自 TownGeneratorOS（[watabou/TownGeneratorOS](https://github.com/watabou/TownGeneratorOS)），GPL-3.0。

上游的 LICENSE 与版权声明归各自作者（Placemaker 只通过 [Paradox Mods](https://mods.paradoxplaza.com/mods/163638/Windows) 发布）。本仓库内置上游源码仅为满足 GPL-3.0 的源码可得性要求，不做任何修改。若要再分发，请保留同样的许可与来源说明。
