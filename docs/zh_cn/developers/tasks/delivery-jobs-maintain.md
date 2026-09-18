# 开发手册 - DeliveryJobs 转交委托

`DeliveryJobs`（任务名「转交委托」）按用户配置的地区与仓储节点遍历全部仓储节点，完成送货委托的装箱、接取与转交，可选把货物交给 [AutoDelivery](../components/auto-delivery.md) 全自动送掉。任务遵循「Pipeline 管流程，Go 管算法」：Pipeline（`assets/resource/pipeline/DeliveryJobs*`）负责界面识别、点击与按配置分派；Go Service 只提供 `DeliveryJobsResolveOngoingDepotAction`（`agent/go-service/deliveryjobs/`），用于从任务详情解析残留任务归属哪个仓储节点。

## 要点速览

- **入口**：`assets/tasks/DeliveryJobs.json` 的 `DeliveryJobs` 任务 → Pipeline 入口 `DeliveryJobsMain`，分组 `regional_development`。任务名与全部 option 名是配置持久化键，改名会让用户已有配置失效。
- **两级配置**：先开关地区（四号谷地 / 武陵），再逐个仓储节点选处理方式（六选一）。处理方式决定该仓储节点走哪条流程。
- **生成产物不要手改**：`pipeline/DeliveryJobs.json`、`pipeline/DeliveryJobs/{Region,Depot}/**`、`PriorityItems.json`、`assets/tasks/DeliveryJobs.json` 全部由 `tools/pipeline-generate/DeliveryJobs/` 生成。手写流程节点只在 `PackCargo.json`、`TransferJob.json`、`AutoDelivery.json` 三个文件里。
- **anchor 是这套流程的骨架**：跨节点、跨仓储节点的「下一步去哪」几乎全靠 anchor 表达，因为同一个共享节点会被多个仓储节点、多个模式复用。改流程前先看本文的 [anchor 一览](#anchor-一览)。
- **`DeliveryJobsReturnToDepotNode` 表示「本仓储节点的落点」**：凡是「从任务界面离开后要回到仓储节点」的流程，落点都由发起方声明。新增同类流程时必须先声明它，否则会落到上一个仓储节点留下的陈旧值。

## 流程总览

```text
DeliveryJobsMain
  └─ DeliveryJobsLoop                    只支持从地区建设界面开始（识别 InRegionalDevelopment）
       ├─ DeliveryJobsAuto               首次进入：按当前所在地区自动选起始地区（max_hit 1）
       │    └─ DeliveryJobsAuto{Region}  Or(InRegionalDevelopment{Region}, DeliveryJobsIn{Region}LocalDepotNode)
       ├─ DeliveryJobs{Region}           SubTask 进本地区地区建设 → DeliveryJobs{Region}Loop
       └─ DeliveryJobsFinished

每个地区（DeliveryJobs{Region}Loop，anchor: DeliveryJobsGoToDepot = 本地区仓储节点场景）
  ├─ SubTask 先进本地区仓储节点场景
  ├─ [JumpBack] DeliveryJobsEnter{Depot}DeliveryJob   × 本地区每个仓储节点：查看任务 → 转交
  ├─ [JumpBack] DeliveryJobsEnter{Depot}Cargo         × 本地区每个仓储节点：进入货物 → 装箱
  ├─ DeliveryJobsLoop                                 下一个地区
  └─ [JumpBack] SceneEnterMenuRegionalDevelopment     回地区建设界面
```

地区循环的 `next` 里，同一个仓储节点的两个入口都带 `[JumpBack]`：任一入口的整条链（装箱、接取、转交、全自动送货、残留任务分派）跑完后回到循环节点，再试下一个候选。所以「处理完一个仓储节点后自动继续下一个」是循环节点重入实现的，不需要每个仓储节点自己声明后继。

进入仓储节点后，按该节点的处理方式分流：

```text
接取并转交（Transfer）
  DeliveryJobsEnter{Depot}DeliveryJob ─> DeliveryJobsClickTransferJob ─> DeliveryJobsConfirmTaskTransfer
                                                                          └─ [Anchor]DeliveryJobsReturnToDepotNode

全自动送货（AutoDelivery）
  DeliveryJobsEnter{Depot}DeliveryJob ─> DeliveryJobsAutoDelivery{Depot} ─> DeliveryJobsDeliverByAutoDelivery
  （装箱接取后转交的入口改为 DeliveryJobsGoToDepot 锚点直连 DeliveryJobsAutoDelivery{Depot}）
  失败 → on_error → DeliveryJobsTransferOngoingJob（仅在「送货失败后自动转交任务」开启时）

按报价处理（ByQuote）
  装箱 ─> 货物竞价 ─> 调度申请界面
    ├─ DeliveryJobsOngoingDelivery            有残留货物 → 见「残留送货任务」
    └─ [Anchor]DeliveryJobsRedistributionBidAction = DeliveryJobsDecide{Depot}Quote
         ├─ 报价 ≥ 阈值 → DeliveryJobs{Depot}QuoteAtLeastMinimum → [Anchor]DeliveryJobsQuoteAction
         ├─ 报价 < 阈值 → DeliveryJobs{Depot}QuoteBelowMinimum  → [Anchor]DeliveryJobsQuoteAction
         └─ 识别不到报价 → DeliveryJobsBidPriceRecognitionFailed（停在报价页提示用户，不接取）

仅接取委托（AcceptJobOnly）
  装箱 ─> 调度申请界面 ─> 接取 ─> 回仓储节点，不转交

仅装箱货物（PackCargoOnly）
  装箱 ─> 调度申请界面 ─> 关闭页面回仓储节点，不接取

不处理（Disabled）
  两个入口节点都 enabled: false，该仓储节点既不接取也不装箱
```

## 仓储节点处理方式

每个仓储节点一个 `select`，默认「接取并转交」。六种方式通过覆盖该仓储节点的节点属性实现，覆盖内容见下表（`deliveryEnabled` / `cargoEnabled` 即 `DeliveryJobsEnter{Depot}DeliveryJob` / `DeliveryJobsEnter{Depot}Cargo` 的 `enabled`）。

| 处理方式 | 入口启用 | 装箱识别文本 | 调度申请界面动作 | 接取后去向 |
| ------------------ | ------------------------------------- | ------------------------------------- | --------------------------- | -------------------------------------- |
| 接取并转交 | 两者都启用 | 查看报价 / 货物装箱 | `DeliveryJobsRedistributionBidNextStep` | `DeliveryJobsDeliverQuickly` → 回仓储节点 |
| 全自动送货 | 两者都启用 | 查看报价 / 货物装箱 | `DeliveryJobsRedistributionBidNextStep` | `DeliveryJobsAutoDelivery{Depot}` |
| 按报价处理 | 只启用货物入口 | 查看报价 / 货物装箱 | `DeliveryJobsDecide{Depot}Quote` | 由报价分支决定 |
| 仅接取委托 | 只启用货物入口 | 查看报价 / 货物装箱 | `DeliveryJobsRedistributionBidNextStep` | 回仓储节点，不转交 |
| 仅装箱货物 | 只启用货物入口 | 只有货物装箱 | `DeliveryJobsBackToDepotFromBid` | 关闭调度申请界面回仓储节点 |
| 不处理 | 两者都停用 | — | — | — |

几处容易误读的地方：

- **「接取并转交」的转交不在装箱流程里。** 装箱接取后只回到仓储节点，真正转交是由地区循环下一轮命中 `DeliveryJobsEnter{Depot}DeliveryJob`（识别「查看任务」按钮）触发的。所以同一个仓储节点在一次任务里可能被访问两次。
- **「仅接取委托」和「仅装箱货物」靠停用 `DeliveryJobsEnter{Depot}DeliveryJob` 实现「不转交」**，不是靠流程判断；因此该仓储节点已有的送货任务在这两种模式下完全不被触碰。
- **「仅装箱货物」的装箱识别只认「货物装箱」**，不认「查看报价」。这是为了让它在货箱已装满时也命中入口，而「查看报价」只在未装满时出现。
- **「不处理」不覆盖残留任务分派节点**，它走模板默认的 `DeliveryJobsSkipOngoingDelivery`（见「残留送货任务」）。

## 按报价处理

选择「按报价处理」后，该仓储节点会额外出现三个选项：

| 选项 | 类型 | 默认 | 作用 |
| ---------------------------------------- | ------ | ------ | -------------------------------------------------------- |
| 报价处理阈值 | input | 119000 | 与当前选中报价比较的整数值，校验 `^\d+$` |
| 达到或高于阈值时 | select | 接取并转交 | 报价 ≥ 阈值时执行哪个动作 |
| 低于阈值时 | select | 仅接取委托 | 报价 < 阈值时执行哪个动作 |

阈值与两侧动作的选项是**每个仓储节点独立**的（`DeliveryJobsQuoteThreshold{DepotId}`、`DeliveryJobsAtLeastMinimumQuoteAction{DepotId}`、`DeliveryJobsBelowMinimumQuoteAction{DepotId}`），只在该仓储节点选「按报价处理」时才出现。

实现要点：

- 阈值以 `pipeline_type: string` 注入 `ExpressionRecognition.expression`，实际比较式是 `{DeliveryJobsSelectedBidPrice}>=<阈值>` 与 `{DeliveryJobsSelectedBidPrice}<{阈值}`。**`pipeline_type` 必须保持 `string`**：设为 `int` 会尝试把整个表达式转成整数，最终得到 `null`。
- 两侧动作都是四选一，取值与仓储节点处理方式**不共用**：`接取并转交` / `全自动送货` / `仅接取委托` / `不处理`。没有「按报价处理」和「仅装箱货物」——报价页已经在接取环节，再嵌套一层报价没有意义。
- 动作节点由 `DeliveryJobs{Depot}QuoteAtLeastMinimum` / `QuoteBelowMinimum` 声明两个锚点后交给 `[Anchor]DeliveryJobsQuoteAction`：
    - `DeliveryJobsQuoteAction` → 执行哪个动作：`DeliveryJobsQuoteTransferJob`（接取并返回仓储节点转交）、`DeliveryJobsQuoteAcceptJobOnly`（接取后继续）、`DeliveryJobsQuoteDoNotAccept`（关闭报价页不接取）；
    - `DeliveryJobsGoToDepot` → 接取完成后回仓储节点的方式，取值 `DeliveryJobsReturnAndTransfer{Depot}`（回仓储节点并转交）、`DeliveryJobsAutoDelivery{Depot}`（交给全自动送货）或本仓储节点场景（只回去）。
- 报价 OCR 失败（`DeliveryJobsBidPriceRecognitionFailed`）直接 `StopTask` 并停在报价页，不猜、不自动接取。

## anchor 一览

DeliveryJobs 的共享节点不知道自己在为哪个仓储节点服务，全靠 anchor 传递上下文。当前用到九个：

| anchor | 声明者 | 消费者 | 含义 |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `DeliveryJobsReturnToDepotNode` | `DeliveryJobsEnter{Depot}DeliveryJob`、`DeliveryJobsEnter{Depot}PriceDeliveryJob`、`DeliveryJobsEnter{Depot}Cargo`、`DeliveryJobsOngoingDeliveryFor{DepotId}`、`DeliveryJobsAutoDelivery{Depot}` | `DeliveryJobsConfirmTaskTransfer`、`DeliveryJobsSkipOngoingDelivery` | 本仓储节点的落点 |
| `DeliveryJobsGoToDepot` | `DeliveryJobs{Region}Loop`、`DeliveryJobsEnter{Depot}Cargo`、`DeliveryJobs{Depot}QuoteAtLeastMinimum/BelowMinimum` | `DeliveryJobsBackToDepot` | 从大世界回仓储节点的下一步 |
| `DeliveryJobsSelectPriorityItems` | `DeliveryJobsEnter{Depot}Cargo` | `DeliveryJobsSelectTypeOfGoodsToPackNextStep` | 本地区的装箱优先级入口 |
| `DeliveryJobsRedistributionBidAction` | `DeliveryJobsEnter{Depot}Cargo` | `DeliveryJobsInCargoRedistributionBid` | 调度申请界面上的分派动作 |
| `DeliveryJobsAfterAcceptJob` | `DeliveryJobsEnter{Depot}Cargo` | `DeliveryJobsRedistributionBidNextStep` | 接取任务后的去向 |
| `DeliveryJobsQuoteAction` | `DeliveryJobs{Depot}QuoteAtLeastMinimum/BelowMinimum` | 同名节点自身的 `next` | 报价达标 / 不达标时执行哪个动作 |
| `DeliveryJobsCurrentPriorityItem` | `DeliveryJobsStartFill{Region}Priority{1..4}` | `DeliveryJobsSelectPriorityItemLoop` | 当前优先级要查找的物品 |
| `DeliveryJobsNextPriority` | `DeliveryJobsStartFill{Region}Priority{1..4}` | `DeliveryJobsFillCorrespondingGoods`、`DeliveryJobsItemListAtBottom` | 当前优先级装不满或列表已到底时试哪个后续优先级 |
| `DeliveryJobsAfterAutoDelivery` | `DeliveryJobsAutoDelivery{Depot}` | `DeliveryJobsDeliverByAutoDelivery` | 全自动送货成功后回到地区循环 |

### `DeliveryJobsReturnToDepotNode`：本仓储节点的落点

转交确认后要回到哪里，取决于这次转交是在哪个界面发起的：仓储节点界面发起的转交仍在仓储节点界面结束；任务界面发起的转交会落在菜单列表，需要重新进仓储节点。`DeliveryJobsConfirmTaskTransfer` 不判断界面，只按这个锚点跳转。规则是**谁知道自己正在处理哪个仓储节点，谁就声明它**：

| 声明者 | 值 | 场景 |
| ------------------------------------------ | ---------------- | ------------------------------------------------ |
| `DeliveryJobsEnter{Depot}DeliveryJob` | `InLocalDepotNode` | 在仓储节点界面发起转交，转交后只需等界面加载 |
| `DeliveryJobsEnter{Depot}PriceDeliveryJob` | `InLocalDepotNode` | 同上（报价达标路径） |
| `DeliveryJobsEnter{Depot}Cargo` | 本仓储节点场景 | 兜底：残留任务解析失败时 `DeliveryJobsSkipOngoingDelivery` 也要有落点 |
| `DeliveryJobsOngoingDeliveryFor{DepotId}` | 本仓储节点场景 | 残留送货任务：回到它归属的仓储节点 |
| `DeliveryJobsAutoDelivery{Depot}` | 本仓储节点场景 | 全自动送货失败后转交，需要从任务界面退出 |

消费者有两个，都是「离开任务界面后要回到仓储节点」：`DeliveryJobsConfirmTaskTransfer`（转交确认）与 `DeliveryJobsSkipOngoingDelivery`（跳过不处理的残留任务）。

> [!IMPORTANT]
>
> **共享节点不得声明这个锚点。** `DeliveryJobsTransferOngoingJob`、`DeliveryJobsClickTransferJob`、`DeliveryJobsDeliverByAutoDelivery` 都排在声明者之后、消费者之前执行，一旦声明就会把发起方的值覆盖掉。`DeliveryJobsAutoDelivery{Depot}` 之所以必须声明，是因为「送货失败后自动转交任务」的 `on_error` 直接接到转交流程、绕过了 `DeliveryJobsOngoingDeliveryFor{DepotId}`，不声明就会拿到陈旧值。

排查同类问题的通用问法：**这个节点的落点是否取决于从哪个界面进入？** 如果是，落点就必须由发起方声明；写死或由共享节点兜底，都会在某个入口上失效。

## 残留送货任务

在调度申请界面识别到「有待运送的货物，请先完成送货」时，`DeliveryJobsInCargoRedistributionBid` 的 `next` 会先命中 `DeliveryJobsOngoingDelivery`，进入残留任务处理，而不是执行本仓储节点的调度申请动作：

```text
DeliveryJobsOngoingDelivery            调度申请界面识别到已有待运送货物
  └─ DeliveryJobsEnsureOngoingDeliveryMission   SubTask AutoDeliveryEnsureDeliveryMissionSelected
  │                                            进任务界面并选中那条送货任务
  └─ DeliveryJobsResolveOngoingDepot     识别 And(AutoDeliveryInDeliveryMissionDetail, AutoDeliveryCheckAreaText)
       │                                 Go 动作 DeliveryJobsResolveOngoingDepotAction：
       │                                 用任务详情「当前区域」的 OCR 文本匹配仓储节点，
       │                                 把 next 覆盖为 DeliveryJobsOngoingDeliveryFor{DepotId}
       └─ DeliveryJobsOngoingDeliveryFor{DepotId}   按该仓储节点的处理方式分派（next 由选项覆盖）
```

分派依据是**残留任务归属仓储节点**的处理方式，与当前正在遍历哪个仓储节点无关——残留任务可能来自上一个仓储节点，也可能来自本次根本没遍历到的节点：

| 归属仓储节点的处理方式 | 去向 | 结果 |
| ------------------------------- | ---------------------------------- | ------------------------------------------ |
| 接取并转交 | `DeliveryJobsTransferOngoingJob` | 转交后回本仓储节点，继续地区循环 |
| 全自动送货 | `DeliveryJobsAutoDelivery{DepotId}` | 送掉后回地区循环 |
| 按报价处理 / 仅接取委托 / 仅装箱货物 | `DeliveryJobsSkipOngoingDelivery` | 退出任务界面，回本仓储节点继续遍历 |
| 不处理 | 同上（不覆盖分派节点，走模板默认） | 同上 |

任务详情里的区域名与仓储节点名在五种语言下逐字一致，Go 侧 `DeliveryJobsResolveOngoingDepotAction` 才能用区域 ID 直接拼出 `DeliveryJobsOngoingDeliveryFor{ID}` 这个节点名；这条恒等关系由 `model.mjs` 在生成时断言，两边不各写一套映射。

`DeliveryJobsSkipOngoingDelivery` 走的是 `[Anchor]DeliveryJobsReturnToDepotNode`：此时停在任务详情界面，锚点由发起方声明为本仓储节点场景，正好是从菜单列表回到仓储节点的路径。

## 全自动送货

「全自动送货」只在 `delivery_destinations.json` 中有归属终点的仓储节点上提供——没有终点的仓储节点无处可送，仓储节点模式与两侧报价分支都不给出这个选项。

- DeliveryJobs 不直接把 `AutoDelivery` 放进 `next`。各仓储节点的 `DeliveryJobsAutoDelivery{Depot}` 只负责声明回跳锚点（`DeliveryJobsAfterAutoDelivery`、`DeliveryJobsReturnToDepotNode`），再交给公共调用节点 `DeliveryJobsDeliverByAutoDelivery`。
- `DeliveryJobsDeliverByAutoDelivery` 用 strict `SubTask` 包裹 `AutoDelivery`，组件内部任意环节失败都会浮现在自身动作上，`on_error` 只需在这一处配置。当前处于取货还是送货阶段由组件根据任务详情自行判断，调用方无需为详情切换配置额外入口或 anchor。
- 「送货时优先使用滑索」开关通过 `AutoDeliveryNavigateDepot` / `AutoDeliveryNavigateDestination` 的 `attach.zip` 传给 AutoDelivery。它只允许导航在预计更快且滑索已供电、可正常上下索时使用滑索，不保证每条路线都会选择滑索。
- 「送货失败后自动转交任务」开关把 `DeliveryJobsDeliverByAutoDelivery.on_error` 设为 `DeliveryJobsTransferOngoingJob`。关闭时全自动送货失败即停止整个任务；开启时改为自动转交当前任务并继续地区循环。该功能仍处于测试阶段。
- 送货成功后由 `DeliveryJobsAfterAutoDelivery` 回到本地区循环节点。

## 装箱货物优先级

启用「填入指定货物」后，`DeliveryJobsSelectTypeOfGoodsToPackNextStep` 的 `next` 从默认的「装满货物」改为 `[Anchor]DeliveryJobsSelectPriorityItems`，流程改走优先级查找。该选项按地区展开，每个地区可设 4 个优先级槽位（`WhatToFill{Region}Priority1..4`）。

- 每个槽位独立配置物品，取值是稳定 item ID，显示名复用 `iconRecognition.name.*`；默认优先级 1 为砂叶粉末，优先级 2 至 4 为「不指定」。
- 单个优先级的流程：`DeliveryJobsStartFill{Region}Priority{n}` 声明 `DeliveryJobsCurrentPriorityItem` / `DeliveryJobsNextPriority` → `DeliveryJobsResetItemListLoop`（列表滚到顶部）→ `DeliveryJobsSelectPriorityItemLoop` 用 IconRecognition（`grid_type=shipment`）从顶部完整查找该物品 → `DeliveryJobsFillCorrespondingGoods` 单击进度条最右侧填到最大 → 未装满、或列表滚到底仍未找到时走 `DeliveryJobsNextPriority` 试下一个已配置槽位。
- 所有已配置物品都装不满时 `DeliveryJobsConfiguredFillItemsInsufficient` 报错并停在装箱界面，不静默继续。
- 未启用该选项时走 `DeliveryJobsCargoFillToMax`，使用游戏默认的填充至满。

## 选项配置一览

| 选项 | 类型 | 默认 | 作用 |
| ------------------------------------------------ | ------ | -------------- | ------------------------------------------------ |
| 四号谷地 / 武陵 | switch | 开 | 启停地区；关闭即 `enabled: false` 该地区节点 |
| `{仓储节点}` | select | 接取并转交 | 该仓储节点的处理方式（六选一） |
| 报价处理阈值 | input | 119000 | 仅「按报价处理」时出现 |
| 达到或高于阈值时 / 低于阈值时 | select | 接取并转交 / 仅接取委托 | 仅「按报价处理」时出现 |
| 填入指定货物 | switch | 关 | 启用后展开每地区 4 个优先级槽位 |
| `{地区} · 优先级 1..4` | select | 砂叶粉末 / 不指定 | 仅启用「填入指定货物」时出现 |
| 送货时优先使用滑索 | switch | 关 | 传给 AutoDelivery 的 `attach.zip` |
| 送货失败后自动转交任务 | switch | 关 | 设置 `DeliveryJobsDeliverByAutoDelivery.on_error` |

旧版的全局「仅接取任务」「仅装箱货物」开关已被逐仓储节点选项取代，旧版的单货物配置也不会迁移到新的优先级配置；升级后需要重新选择各仓储节点的处理方式。

## 运行期提示与失败行为

- 报价识别失败：停在报价页并提示用户手动确认，不自动接取。
- 装箱物品不足：停在装箱界面并报错，提示调整优先级或补充库存。
- 全自动送货失败：由「送货失败后自动转交任务」决定停止任务还是转交后继续。
- 仓储节点未解锁：SceneManager 进不去对应场景，任务终止。

## 生成器与维护

生成、数据来源、新增地区或仓储节点的步骤，见 [`tools/pipeline-generate/DeliveryJobs/README.md`](../../../../tools/pipeline-generate/DeliveryJobs/README.md)。这里只列改流程时需要知道的手写文件：

| 文件 | 职责 |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `DeliveryJobs/PackCargo.json` | 装箱、调度申请界面、报价动作、残留任务处理、回仓储节点 |
| `DeliveryJobs/TransferJob.json` | 点击转交 → 确认转交 → 按 `DeliveryJobsReturnToDepotNode` 跳转 |
| `DeliveryJobs/AutoDelivery.json` | `DeliveryJobsDeliverByAutoDelivery`，全自动送货的唯一调用点 |
| `DeliveryJobs.json` | 任务入口与主循环（生成，但流程结构变更需改 `core-template.jsonc`） |

改动检查清单：

- 新增「离开任务界面后回仓储节点」的流程 → 先确认发起方声明了 `DeliveryJobsReturnToDepotNode`。
- 给共享节点加 anchor → 确认它在所有声明者之后、消费者之前都不会覆盖发起方的值。
- 改锚点取值 → 全仓库搜旧值，`assets/tasks/DeliveryJobs.json` 与测试里可能有硬编码的节点名。
- 提交前至少运行 `node --test tools/pipeline-generate/DeliveryJobs/*.test.mjs`、`pnpm check`、`pnpm test`。
