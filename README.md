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

两者都自带 README，细节看各自的。

## 前置条件

- .NET SDK 6.0+
- Node.js 18+
- **Placemaker 上游源码**：`placemaker-core-lib` 用相对路径直接编译 `..\placemaker-master\placemaker-master\Core\**\*.cs`，**不复制文件**（改上游即时生效，不会出现两份代码漂移）。所以需要先放好上游：

  ```
  PCG-CitySkyline/
  ├─ placemaker-core-lib/
  ├─ townforge-enhance/
  └─ placemaker-master/          ← 需自行获取，GPL-3.0
     └─ placemaker-master/Core/
  ```

  上游不在本仓库内（体积与许可原因）。来源是 Placemaker 的公开仓库 release 源码包。

## 跑起来

```bash
# 1) 内核库：编译 + 自检 + 7 个路网场景 + 130 个生成器扫描 + 82 个配方
cd placemaker-core-lib
./build.bat                      # Windows；产物在 out/，日志 build.log

# 2) 城市生成器
cd ../townforge-enhance
npm install
npm run dev                      # 本地编辑器 (vite)
npm run bake                     # 烘焙 Placemaker 方案 → src/bridge/data/
npm run test:bridge              # 桥接
npm run test:hedge               # 绿篱拟合
npm run test:bridge-green        # 绿地一族（20 份方案）
npm run test:obstacles           # 建筑避让
npm run test:bridge-glb          # GLB 导出
```

## 已验证的结果

| 项目 | 结果 |
| --- | --- |
| 内核库编译 | 465 个 Core 文件，**0 错误 0 警告**，未引用任何游戏程序集 |
| 自检 | 38 条全绿 |
| 生成器覆盖 | 130 个 `[AreaGenerator]` 反射全跑，**128 个有输出**，0 抛异常 0 超时 |
| 配方 | 82 个（13 嵌套用例 + 69 官方配方）全部渲染成功 |
| 绿地一族 | 20 个生成器出方案；单个方案最多 304 个道具实体 |
| 建筑避让 | 4 塔楼占地块 43% 的工况下，铺装 + 建筑覆盖 **97%**，压进建筑重叠 **0.00 m²** |
| 回归不变量 | 全城基线三角形数 **175507**（未接 Placemaker）与 **181696**（接 parking）逐位不变 |

## 几个必须知道的坑

这些是踩出来的，写下来省得重踩：

1. **Placemaker 不产建筑。** `ObjectRole` 里根本没有 Building。它是纯室外场地设计器，建筑只以「障碍物四边形」的形式出现，用来避让。
2. **七通道只消费四个。** Placemaker 的方案有 `surfaces / nets / objects / areas / regions / zoning / paint / terraform`，桥接目前只用前四个；`regions`（77 条）、`areas`、`zoning`、`paint` 都丢了，`terraform` 也没真做地形起伏。
3. **`polish*` 是表面精修层。** 它只改已有地面的材质贴花，给它裸地就输出 0 个元素——而且返回 `ready=yes`，很容易误判成「可用」。
4. **绿地生成器不铺地面。** `park / greenwayPark / picnicGrounds / natureReserve` 的 surfaces 为空（在 CS2 里地面就是地形）。所以要单独补草地底，否则场景是空的。
5. **`gen.Plan()` 绕过 `Composer`。** 正常管线里 `SiteSafety.Apply` 由 `Composer.Compose` 调用，直接调 `Plan()` 就不会跑——障碍物会被收下但没人用。驱动器里手动补了一次。
6. **`SiteSafety` 的语义是「删」不是「绕」。** 面积型生成器（广场、花园）贴着楼断得很干净；路网型（停车场 53 条车道被切成 1 条）会被切坏。
7. **绿篱的判据是 yaw。** Placemaker 排绿篱时整条线共用同一 yaw（yaw 是线的**法向**，走向 = yaw+90°）；随机撒点时每颗朝向都不同。用这个差异区分「成排」和「散点」，两道闸：整体朝向档数 + 组内至少 3 颗。
8. **TownForge 的坐标系约定**：`UNIT_M = 7`（1 单位 = 7 米），`[x,z] → Pt(x,y)`，`rot = yaw − π/2`。错一处整层旋转。

## 许可

两个上游都是 **GPL-3.0**，本仓库的两个子工程都是它们的派生作品，因此整体同样以 GPL-3.0 分发：

- `placemaker-core-lib` — 派生自 Placemaker（Cities: Skylines II 场地设计器），GPL-3.0
- `townforge-enhance` — 派生自 TownGeneratorOS（watabou/TownGeneratorOS），GPL-3.0

上游的 LICENSE 与版权声明归各自作者。若要再分发，请保留同样的许可与来源说明。
