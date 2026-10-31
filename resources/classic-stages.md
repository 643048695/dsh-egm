# 原版五阶段评审：角色、标准、阶段与检查点

本文件是 `egm-classic-review` / `egm-classic-review-loop` 的共同参照。
**代码里的唯一事实来源是 `lib/dispatch.js` 的 `EGM_ROLES` / `STAGE_ROLES`**；本表若与代码冲突，以代码为准，并回来改本文件。

原版出处：`vendor/egm/skills/egm-review/SKILL.md`（编排）、`vendor/egm/skills/egm-review-loop/SKILL.md`（循环驱动）、
`vendor/egm/agents/*.md`（人格卡）、`vendor/egm/resources/document_standards/*.md`（标准）。

## 阶段表

| 阶段 | 名称 | 允许的角色（`role`） | 固定标准（工具复制给金鱼） | 原版审的对象 | DSH 实际输入与派发方式 |
| --- | --- | --- | --- | --- | --- |
| 5 | 初始 Zoom Out | `zoom_out` | `zoom-out-standard.md` | 整份文档 | 整份文档；单角色 `egm_dispatch` |
| 6 | 复述测试 | `comprehension` | `re-implementation-standard.md` | FeatureRange + DetailedRange | FeatureRange 裁剪副本；单角色 `egm_dispatch`（+ 需要时把范围说明写进 `materials`） |
| 7 | 敌意评审 | `design_critic`、`structural`、`style` | 前两个绑 `feature-spec-standard.md`；`style` 不绑标准 | FeatureRange | FeatureRange 裁剪副本；**优先 `egm_dispatch_batch`**（3 任务并发，同批快照，独立 fresh 汇总代办） |
| 8 | 中期 Zoom Out | `zoom_out` | `zoom-out-standard.md` | 整份文档 + Stage 5 报告 | 整份文档 + `materials=[zoom_out_report.md]`；单角色 `egm_dispatch` |
| 9 | 实现就绪 | `implementation_readiness`、`codebase_details`、`style` | 前两个绑 `implementation-readiness-standard.md`；`style` 不绑标准 | DetailedRange | DetailedRange 裁剪副本 + `materials=[目标详设]`；**优先 `egm_dispatch_batch`**（3 任务并发，同批快照，独立 fresh 汇总代办） |

Stage 7 与 Stage 9 优先使用 `egm_dispatch_batch` 批量并发派发（concurrency 默认 3 最大 3），同批共用不可变图纸快照，并由独立 fresh 汇总子会话整理落盘；单角色阶段（5、6、8）可继续使用单角色 `egm_dispatch`。

### 角色短名对照

| 短名（工具 `role`） | 上游人格卡 | 上游别名 |
| --- | --- | --- |
| `design_critic` | `vendor/egm/agents/design_critic.md` | 上游 `egm_review` Stage 7 写成 `egm-design`，`egm_review_loop` 写 `design_critic`；以工具短名为准 |
| `structural` | `vendor/egm/agents/structural.md` | `egm-structural` |
| `style` | `vendor/egm/agents/style.md` | `egm-style` |
| `zoom_out` | `vendor/egm/agents/zoom_out.md` | `egm-zoom-out` |
| `comprehension` | `vendor/egm/agents/comprehension.md` | `egm-comprehension` |
| `implementation_readiness` | `vendor/egm/agents/implementation_readiness.md` | `egm-implementation-readiness` |
| `codebase_details` | `vendor/egm/agents/codebase_details.md` | `egm-codebase-details` |

## 语义切分与受控材料控制

1. 找主切分标题：`## Detailed Implementation Plan`；同义：`## Implementation Plan`、`## Work Breakdown`、`## Implementation Steps`。
2. 找到唯一一处 → `FeatureRange = 1..(L-1)`，`DetailedRange = L..End`。
3. 多处冲突/结构不标准 → 用 `ask_user_question` 给一个单选：默认那行 / 自定义（让用户直接写行号）。
4. 完全没有实现计划 → `FeatureRange = 全文`，`DetailedRange = 无`，只能跑 Stage 5–8。

### 范围与源码控制规则
- **range 真实裁剪与映射**：`range: { start, end }` 传入后，工具在评审房间内生成真实的文档切片裁剪副本供金鱼阅读，并将行号映射回原文件；
  - 澄清：原版在已查 review-loop 中对 range 仅是提示词指令，上游本身并无强裁剪保证，不得声称原版有强裁剪保证；
  - DSH 的真实裁剪副本虽然在文件系统上裁剪了副本，但**裁剪不是权限隔离**，仍须标注 `strictGoldfishReview: false`；
  - 找不到切点就别瞎传区间；不传 `range` = 整份文档（Stage 5 / 8 与 `feature_spec` 预设的 FeatureRange=全文 都不传）。
  - `brainstorm` 模式不接受 `range`。
- **sources 受控普通文件复制**：必须指定工作区内普通文件并受控复制副本，禁止整目录盲传；按角色最少材料原则配置。

## 预设（原版 Step 2）

| 预设 | 跑哪些阶段 | 行为 |
| --- | --- | --- |
| `interactive`（默认，选项 0） | 5 → 6 → 7 → 8 → 9 | 每阶段落报告 + 一个检查点单选 |
| `uninterrupted` | 5 → 6 → 7 → 8 → 9 | 连续推进，最后汇总成 `consolidated_review_report.md` |
| `feature_spec` | 5 → 6 → 7 → 8 | `FeatureRange=全文`，跑完 Stage 8 停，不进 Stage 9 |
| `implementation` | 仅 9 | 需要目标详设；没有就明说只能审现有文档 |

原版用 `Step` 参数指定预设或单个阶段（`5`..`9`）。DSH 侧同样接受：用户说「只跑阶段 7」就只跑 7。

## 检查点（原版 Subflow Checkpoint Gates）

### 交互准则（证据与方案先行）
1. **正文先行呈现**：在进入检查点提问之前，**必须在正常可见文本中先列出该阶段的评审结论、发现条目（带 `文件:行号` 代码依据与后果）以及具体可执行的拟改方案**。严禁不给方案直接弹窗反问用户。
2. **分流推进**：
   - **全绿（无阻塞项/无发现）**：正文直接告知该阶段通过并顺畅推进，**严禁无端弹窗询问「处理发现」「修一轮再来」「我认风险」**。
   - **存在待处理发现**：在正文完整列出问题与具体修改建议后，才通过检查点由用户决策。
3. **安全许可与开工审批严格区分**：用户允许评审（开启窗口或非隔离许可）仅为只读审查授权，绝不等于方案审批通过，更不等于代码修改授权；修改源码必须建立在清晰方案与用户真实批准之上。
4. **失败语义**：**报告缺失绝不代表通过，执行失败绝不是成功**；缺失或失败必须如实记录缺口并提示补审，严禁当作无阻塞绿灯放行。

`interactive` 及需要阶段确认的预设在存在待处理发现时，先展示经核实的问题与具体修法，再使用 interaction-contract.md 的 egm-actions 直接按钮；不使用例行下一步问卷与提交。已有范围内授权则直接推进。`uninterrupted` 正常阶段之间不停；许可不足、出错或用户要求暂停时仍需停下。

- Stage 5 / 6 / 8：`0` 按建议方案修改文档（推荐） · `1` 进入下一阶段 · `2` 暂停并退出。
- Stage 7 / 9：`0` 用 `egm-classic-resolve` 按拟改方案处理发现（推荐） · `1` 我手改文档（暂停后重跑） · `2` 保持现状进下一阶段（知情认风险） · `3` 暂停并退出。
- **不设每阶段重审或图纸修订的固定轮数上限**。按反馈继续修订；重复无进展时如实说明原因与建议，不强迫接受风险。未处理发现保持「未解决」。真实金鱼派发配额与许可时效另行检查。

暂停/恢复是文字约定，不是强制机制：暂停就停手；用户说改完了，就重读源文档、重新生成快照、重算切分、重跑当前阶段，并保留旧快照和报告的追溯关系。

## 派发预算与授权门控（严格保留）

派发前必须获得用户授权，缺一返回错误。0.8.0 优先推荐在 EGM 面板持续可找到的「评审许可」区勾选风险说明后点击「允许本轮评审」，也可使用命令通道：
- **一键授权（推荐命令）**：`/egm-review-access 确认无隔离`（一键开启 2 小时/20 次窗口 + 10 分钟/6 次许可）；`/egm-review-access revoke` 撤销。
- **分步备用命令（无 UI fallback）**：
  1. **`/egm-open`**：打开 2 小时 / 20 次派发窗口，只开窗口、不触发守门流程；没开就 `E_GATE_NOT_OPEN`。未注册专用授权模型工具，常规流程要求用户明确操作；插件门控不构成硬权限边界。（`/egm` 也能开窗口，但会同时起 egm-gate，classic 流程别用。）
  2. **`/egm-unsafe 确认无隔离`**：开 10 分钟 / 6 次非隔离许可；没有就 `E_READONLY_UNVERIFIED`。

### 配额扣减与分批策略
- 完整五阶段 = 1（Stage 5） + 1（Stage 6） + 3（Stage 7） + 1（Stage 8） + 3（Stage 9） = **9 次派发**。
- `egm_dispatch_batch` 在启动批次前做配额预检：按任务数（每鱼扣一次）扣减许可；**若剩余配额不足，整批直接拒绝**，不启动部分任务。汇总子会话代办不占用评审配额。
- 一次许可只有 6 次，无法一次跑完全部 9 次：
  1. 第一批：Stage 5、Stage 6、Stage 7（共 5 次，剩余 1 次）。
  2. 第二批：此时剩余 1 次不足以运行 Stage 8+9（共 4 次），**必须停下请用户在「评审许可」区重新确认允许（或重新输入 `/egm-review-access 确认无隔离` / `/egm-unsafe 确认无隔离`）续授权**，放行后再跑 Stage 8、Stage 9；系统不自动补配额。
- 严禁扩大或假装授权；`manifest.allPassed` 仅代表报告全部完成（仍需阅读发现并裁决），`manifest.partial` 不是设计通过，失败或 partial 需如实说明证据缺口，严禁主会话代评。
