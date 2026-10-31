---
name: egm-classic-review
description: 原版 EGM 五阶段评审的 DSH 适配版（阶段 5–9：Initial Zoom Out / 复述测试 / 敌意评审 / 中期 Zoom Out / 实现就绪）。由用户通过技能入口或点名技能触发，模型不得自行调用；所有金鱼派发走 egm_dispatch 或 egm_dispatch_batch，需用户在 EGM 面板点击「允许本轮评审」或输入 /egm-review-access / /egm-unsafe 确认无隔离。产物落在 .egm/classic/<slug>/，报告标注非隔离、非等价。
when-to-use: 用户说「按原版 EGM 审这份设计」「跑五阶段评审」「egm-classic-review <文档>」，或刚用 egm-classic-draft 写完设计想要完整评审时。
model-invocable: false
---

# 原版五阶段评审（DSH 适配版）

## 0. 先认清这是什么

这是上游 `egm-review`（`vendor/egm/skills/egm-review/SKILL.md`，pin `a8380ab5`）的**工序适配版**，不是原版运行时。

- 原版正文原样在 `vendor/egm/`，细节以它为准；但它的宿主假设在这里不成立（`ask_question`、`spawn_agent`/`Agent`、`${CLAUDE_PLUGIN_ROOT}`）。
- **工具通道**：单角色支持 `egm_dispatch`，多角色阶段（Stage 7 与 Stage 9）优先使用 `egm_dispatch_batch` 批量并发派发。
- **材料新机制**：
  - `range` 传入后工具在房间内生成**真实切片裁剪副本**并映射原文件行号；澄清：原版在已查 review-loop 中对 range 仅是提示词指令，上游本身并无强裁剪保证，不得声称原版有强裁剪保证；本地切片裁剪虽经物理裁剪，但**裁剪不是权限隔离**，硬性禁越读未证实，不允许把“没输出目录”说成从未运行，仍须标注 `strictGoldfishReview: false`。
  - `sources` 必须指定工作区内普通文件受控复制副本，禁止整目录盲传，最少材料原则。
- **门控与配额**：0.8.0 优先支持在 EGM 面板持续可找到的「评审许可」区点击「允许本轮评审」（勾选风险说明）；命令提供一键授权 `/egm-review-access 确认无隔离`（`/egm-review-access revoke` 撤销）；旧分步命令 `/egm-open` 与 `/egm-unsafe 确认无隔离` 保留作为无 UI fallback。批次配额预检：不足整批先拒绝。
- **独立 fresh 汇总代办**：Stage 7 与 Stage 9 的多角色报告由批次独立 spawn 的 fresh 汇总子会话整理，由插件父侧落盘；汇总不占用评审配额；`manifest.allPassed` 仅代表报告全部完成（仍需阅读发现并裁决，绝非设计通过），`manifest.partial` 保留证据缺口，严禁主会话代评补意见。
- 当前对话可见真实 working 态工作提示动画，但不得声称实机已验收。
- 开工前读：`resources/classic-fidelity.md`（能力边界）、`resources/classic-stages.md`（阶段/角色/检查点）、`resources/classic-dispatch.md`（工具契约）。

> **路径基准**：`resources/`、`vendor/`、`agents/` 均以**插件包根**（DSH 的 plugin root）为准，**不是 SKILL.md 同目录**。若找不到文件，应按环境提供的绝对清单复查，**绝对不能自己瞎编模板继续**。
> `.egm/`、`docs/designs/` 等产物相对**当前工作区**。

## 1. 输入

- `TargetFile`（必需）：设计文档路径。没给就问「审哪个文件？」，拿到路径再动；不要拿聊天内容凑。
- `Step`（可选）：`5`–`9` 的单个阶段，或预设 `interactive` / `uninterrupted` / `feature_spec` / `implementation`。
- `GoldfishContext`（可选）：额外阅读清单。**只允许传文档明确点名或引用的源码普通文件**，≤50 条，受控复制，走 `sources`；不要扫全仓库或传目录。

## 2. 流程

### Step 1 绑定预设

用户已经说了阶段或预设就照办，不再问。没说就 `ask_user_question` 问一次（一个问题、四个选项、写明代价）：

1. `interactive`：5→6→7→8→9，每阶段停下让你看（默认，最稳，9 次派发）
2. `uninterrupted`：同样五阶段但不停顿，最后出一份汇总（9 次派发，中途不能插话）
3. `feature_spec`：只跑到 Stage 8，不进实现就绪（视角偏设计，6 次派发）
4. `implementation`：只跑 Stage 9，需要目标详设（3 次派发；没有详设时不能假装已完成 Stage 9）

### Step 2 语义切分

- `feature_spec` 跳过：`FeatureRange = 全文`，`DetailedRange = 无`。
- 否则读文档，找 `## Detailed Implementation Plan`（同义：`## Implementation Plan`、`## Work Breakdown`、`## Implementation Steps`）：
  - 唯一一处：`FeatureRange = 1..L-1`，`DetailedRange = L..末尾`，一句话告诉用户切在哪。
  - 多处冲突：`ask_user_question` 单选「用第 L 行 / 我另给行号」。
  - 找不到：`FeatureRange = 全文`，`DetailedRange = 无`，告知只能跑 5–8。

### Step 3 固定评审对象

1. 在 `.egm/classic/<slug>/` 下写一份 `design.md`（`<slug>` 用文档名 + 日期，例如 `backup-tool-20261028`）。**派发前先快照**：后面所有阶段都审这份快照，防止评审中途文档被改导致阶段之间对象不一致。
2. 报告头里写清「审的是快照，源文档是哪个」。

### Step 4 评审授权与门控（用户动作，不是工具）

1. **界面交互（优先推荐）**：请用户在 EGM 面板持续可找到的「评审许可」区阅读风险说明、勾选确认框，并点击「允许本轮评审」按钮（通过原生命令一键开启 2 小时/20 次窗口与 10 分钟/6 次许可，面板展示真实剩余次数与到期时间，用尽就地重新确认续期）。
2. **命令通道（推荐一键命令）**：请用户输入 `/egm-review-access 确认无隔离`（或带 `grant` 前缀），一次性开启 2 小时/20 次窗口与 10 分钟/6 次许可；撤销用 `/egm-review-access revoke`。
3. **分步备用命令（无 UI fallback）**：
   - 先请用户输入 `/egm-open`：打开 2 小时 / 20 次派发窗口（只开窗口，不触发守门流程）。没开就 `E_GATE_NOT_OPEN`。
   - 再请用户输入 `/egm-unsafe 确认无隔离`：开 10 分钟 / 6 次非隔离许可（必须输入完整确认语）。没有就 `E_READONLY_UNVERIFIED`。
   说明：这只代表接受“只读无法验证”，不代表隔离成立；`/egm-safe` 或 `/egm-review-access revoke` 可随时关掉两者。

完整五阶段共需 9 次派发，单次许可最多 6 次：先跑 Stage 5、6、7（5 次），**中途剩余 1 次不足以跑 Stage 8、9（需 4 次），必须停下由用户在「评审许可」区重新点击允许（或输入 `/egm-review-access 确认无隔离` / `/egm-unsafe 确认无隔离`）续授权后方可继续跑 Stage 8、9**。系统不自动补配额。`feature_spec` 需 6 次，`implementation` 需 3 次。
配额预检：批次派发前检查剩余配额，**不足时整批先拒绝**，绝不跑半截。
用户不做就停手。**不许**自己假装开门/有许可、不许换别的子代理通道、不许在同上下文里演一遍评审。

### Step 5 逐阶段派发

阶段间依赖顺序不变。Stage 7 与 Stage 9 优先使用 `egm_dispatch_batch`（concurrency: 3），其余单角色阶段可调 `egm_dispatch`：

| 阶段 | 派发方式 | 角色 | range | materials | 汇总处理 |
| --- | --- | --- | --- | --- | --- |
| 5 | `egm_dispatch` | `zoom_out` | 不传（全文） | 无 | 单角色原报告 |
| 6 | `egm_dispatch` | `comprehension` | `FeatureRange` 切片 | 无 | 单角色原报告 |
| 7 | **优先 `egm_dispatch_batch`** | `design_critic` + `structural` + `style` | `FeatureRange` 切片 | 无 | 同批快照，独立 fresh 汇总代办整理落盘 `critic_report.md` |
| 8 | `egm_dispatch` | `zoom_out` | 不传（全文） | `zoom_out_report.md`（Stage 5 报告） | 单角色原报告 |
| 9 | **优先 `egm_dispatch_batch`** | `implementation_readiness` + `codebase_details` + `style` | `DetailedRange` 切片 | 目标详设（若与快照不同） | 同批快照，独立 fresh 汇总代办整理落盘 `implementation_readiness_report.md` |

- `range`：生成真实切片裁剪副本供金鱼阅读，行号映射回原文件；报告写清「切片真实裁剪副本，原文件第 N–M 行」。
- `sources`：必须是工作区内普通文件受控复制，禁止传整目录。
- Stage 8/9 的 `materials` 由**调用方负责**：工具不校验哪份是 Stage 5 报告、也不校验详设对不对得上。真的没有就在报告里写缺口，不许默认它有，也不许拿别的文件冒充。

每次调用后：
- `ok:true`（单角色）或 `manifest.allPassed:true` 且 `summaryFailed:false`（批量）→ 代表报告全部完成（仍需阅读发现并裁决，绝非设计通过），将报告（或批次汇总代办生成的报告）写到 `.egm/classic/<slug>/<阶段报告名>.md`；记录 `scratch`、`standard`、`range`、`strictGoldfishReview:false`。
- `manifest.partial:true`、`manifest.allPassed:false` 或 `ok:false` → 明确报错与失败项；`manifest.partial` 属于报告部分完成而非设计通过，保留证据缺口；**报告缺失绝不代表通过，执行失败绝不是成功**；严禁主会话代评补意见。

阶段报告名（沿用原版）：`zoom_out_report.md`、`comprehension_report.md`、`critic_report.md`、`intermediate_zoom_out_report.md`、`implementation_readiness_report.md`。

### Step 6 检查点（证据与方案先行）

1. **正文先行呈现**：在进入检查点之前，**必须在正常可见文本中先列出该阶段的评审结论、发现条目（经源码核查并标明 `confirmed` / `disproven` / `unverified`、行号依据与严重后果）以及具体可执行的修改建议方案**：
   - `confirmed`：已核实成立，作为阻塞项或修改依据；
   - `disproven`：已证伪，移入审计明细备查，绝不计入阻塞项；
   - `unverified`：未核实，如实披露缺口，不自动等于确认或合格通过；
   - 严禁不展示结果与方案就提前弹窗，严禁捏造证据。
2. **角色分工与动作含义**：
   - 金鱼只做独立审查不写代码；大象（主会话）负责整理方案与修改设计图纸；
   - `egm-task-revise`（按建议修改）：只改设计文档不改业务源码；
   - `egm-task-proceed`（按当前方案动手）：按方案开始实现才写代码，且绝不绕过阻塞项；
   - `egm-task-review`：仅补审。
3. **分流推进与专有动作**：
   - **该阶段无发现/无阻塞（全绿）**：在正文中明确告知该阶段通过，直接进入下一阶段或收尾，**严禁无端弹窗询问「处理发现」「我认风险」等无关选项**。
   - **存在待处理发现**：在正文完整列出问题与具体拟改方案后，优先通过 `egm-actions` 专有动作围栏输出直选按钮（`egm-task-revise`、`egm-task-review`、`egm-task-proceed`、`egm-task-hold`；任务已暂缓时用 `egm-task-resume`），取代常规问卷。卡片里的 `taskId` / `taskRevision` 只填命令上下文给出的真实值（`taskRevision` 为方案版本整数），不知道就省略。用户若已授权当前范围内修改，直接按授权执行推进。
   - **「先保留方案」只阻止后续排程**：正在运行的金鱼/工具不会中止，禁止提供「停止」按钮或声称已停下。
   - `uninterrupted` 在正常阶段之间不提问、不暂停；仍须遵守许可不足、出错或用户要求暂停时停下。
4. **不设人为硬性重审/修订上限**：删除固定重审 1 次或修图纸轮数硬上限，按反馈持续修订；重复无进展时汇报具体原因与替代建议，严禁强迫接受风险或停止。真实金鱼派发配额与修图纸轮数严格分开。尚未处理的发现记为「未解决」，不替用户写成「已接受的风险」。

### Step 7 收尾

- `uninterrupted`：把五份阶段报告汇总成 `consolidated_review_report.md`（跨阶段去重、按 🔴/🟡/🟢 排、附「哪条来自哪阶段」的追溯表）。
- 任何预设：**必须在普通文本中完整呈现最终评审结论、主要风险项清单（带 `文件:行号` 与后果）以及具体的解决建议**；报告全文与完整留痕落盘供查阅。**严禁在正文中只留路径与数字统计而隐匿具体问题**。

## 3. 不许做的事

- 不许把这份技能说成「原版五阶段跑通了」。同阶段内并行不等于整套五阶段实机等价跑通。
- 不许把裁剪副本宣称为系统权限隔离。
- 不许把 `manifest.allPassed` 说成「设计通过」或「没有缺陷」（仅代表报告全部完成，仍需阅读发现并裁决）；**报告缺失绝不代表通过，执行失败绝不是成功**；不许把 `manifest.partial` 说成报告全部完成，严禁在同上下文里代替金鱼挑刺补意见。
- 不许将用户允许评审（开启派发窗口或非隔离许可）等同于方案审批通过或源码修改授权；修改代码必须在用户看到清晰方案并获得明确开工批准后单独推进。
- 不许在用户未见证据与方案前提前弹出 `ask_user_question`；不许在全绿通过时无端弹出风险选项。
- 不许跳过 Stage 5 直接跑 Stage 8：Stage 8 要读 Stage 5 报告，缺了就在报告里明说「不算完整中期 Zoom Out」。
- 不许在没有目标详设时假装跑了 Stage 9。
- 不许把 `sources` 当垃圾桶：只传文档点名的普通文件，禁止传目录。
- 不许在同上下文里代替金鱼挑刺；`E_SUBAGENTS_UNAVAILABLE` 就停。

## 4. 与原版的差异（必须让用户知道）

| 原版 | 这里 |
| --- | --- |
| 行区间 FeatureRange/DetailedRange | 真实切片裁剪副本并映射行号；但裁剪非权限隔离，上游在 review-loop 仅是指令提示，本地仍标 `strictGoldfishReview:false` |
| synthesizer 串起阶段、并行 A/B | Stage 7/9 支持 `egm_dispatch_batch` 阶段内并发 + 独立 fresh 汇总代办落盘；跨阶段依赖由技能顺序编排，不宣称五阶段整体等价 |
| 严格只读金鱼 | 非隔离、只读未验证，结果标 `strictGoldfishReview:false` |
| `ask_question` | `ask_user_question`（一问一屏） |
| 报告写工作目录 | 统一写 `.egm/classic/<slug>/` |

细节与证据见 `resources/classic-fidelity.md`。
