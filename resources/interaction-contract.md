# EGM 选择回传、评审授权与结果呈现约定

## 1. 结果与推荐修改方案先行，严禁例行下一步使用问卷

- **结果与修复方案必须先于动作呈现**：
  金鱼评审（单角色或多角色批次）完成后，模型**必须首先在正常可见回复正文中完整清晰地呈现评审发现与具体修复方案**：
  1. 真实缺陷与阻碍清单：文件路径、行号、具体问题、危害后果（如子代理超时、报错或未覆盖，如实列为未覆盖/未跑通，绝不冒充全部完成或声称全通过）；
  2. 具体的、可落地的推荐修改方案：针对每项阻碍具体给出明确的改动计划、修改依据与验证方式；
  3. 结果摘要：明确红/黄/绿灯结论与核心关键项。

- **声称核验与代码比对（Claim Verification against Source/Revision）**：
  金鱼/子代理提出的各项批评与缺陷声称，在向用户呈现为行动项或风险决策前，模型必须对照实际提供的源码与当前图纸版本进行代码核验（code/source checking）：
  1. **标记核验状态与出处（provenance）**：
     - `confirmed`（已核实成立）：与实际代码/图纸完全对齐，因果后果明确，作为阻塞项（blocker）或整改依据；
     - `disproven`（已证伪/不成立）：经查验源码证明原逻辑已有防御或声称不实。必须如实放入审计明细（audit detail / 附录）中备查，但**绝不计入阻塞项（blockers），不得据此判定红灯**；
     - `unverified`（未核实/无代码依据）：因缺少对应源码文件或未覆盖到而未核实。**未核实绝不自动等同于确认成立，也绝不自动当作合格通过**，必须如实披露证据缺口。
  2. **严禁编造证据，不得宣称模型绝对保证**：绝不凭空补充不存在的文件行号或捏造反证，绝不声称无幻觉保证。实际代码覆盖范围与缺失证据必须透明公开。

- **已有授权直接推进，严禁例行下一步使用问卷**：
  用户若已明确授权当前范围内的修复或按建议方案推进，展示结果、核验状态与具体修法后，直接按既有授权继续，**绝不调用 `ask_user_question` 弹出例行下一步问卷**。只有出现全新范围或必要权限时才需确认。

---

## 2. 任务动作卡：插件独占 `egm-actions` 专有围栏与直接点击按钮

评审发现与修复方案呈现完毕后，若需要用户对后续走向进行拍板，**严禁调用 `ask_user_question` 弹出多项问卷+提交界面**。必须使用 **EGM 独占的 `egm-actions` 围栏** 输出直接点击的动作按钮：

```egm-actions
{
  "title": "评审后续操作",
    "items": [
    { "type": "button", "label": "按推荐修改图纸", "action": "egm-task-revise" },
    { "type": "button", "label": "继续复核", "action": "egm-task-review" },
    { "type": "button", "label": "按方案开始实现", "action": "egm-task-proceed" },
    { "type": "button", "label": "先保留方案", "action": "egm-task-hold" }
  ],
  "taskId": "egm-xxxxxx-xxxxxx",
  "taskRevision": 3
}
```

亦支持字面 XML 块：

```html
<egm-actions>
{
  "title": "评审后续操作",
    "items": [
    { "type": "button", "label": "按推荐修改图纸", "action": "egm-task-revise" },
    { "type": "button", "label": "继续复核", "action": "egm-task-review" },
    { "type": "button", "label": "按方案开始实现", "action": "egm-task-proceed" },
    { "type": "button", "label": "先保留方案", "action": "egm-task-hold" }
  ],
  "taskId": "egm-xxxxxx-xxxxxx",
  "taskRevision": 3
}
</egm-actions>
```

### 动作卡规则与边界：
`taskId` 与 `taskRevision` 只可使用命令上下文提供的真实值（`taskRevision` 是"方案版本"，为整数）；不知道就省略两字段，插件会在点击时读取当前任务，且无绑定卡仅允许最新回复。严禁照抄示例虚构 ID 或编号。旧字段名 `revision` 仍然兼容，但新卡片请统一使用 `taskRevision`。

1. **角色分工与执行边界**：
   - **金鱼只做独立审查**：零上下文独立挑刺，绝不执行修复或写代码，严禁新增所谓的“施工金鱼”；
   - **大象负责整理与修图纸**：主会话负责梳理方案、核对代码以及修改设计图纸；
   - **`egm-task-revise`（按推荐修改图纸）**：**只改设计文档/图纸，绝对不改动任何业务源码**；
   - **`egm-task-proceed`（按方案开始实现）**：明确含义为「按方案开始实现」，此时才获准动工编写代码或修改业务源码，且**绝对不绕过未闭环的阻塞项**；
   - **`egm-task-review`（继续复核）**：仅用于针对修改后的图纸进行针对性补审；
   - **`egm-task-hold`（先保留方案）**：保留当前设计图纸与方案现状，只阻止后续排程。**正在运行的金鱼/工具不会因此中止**；没有可靠的宿主停止接口时不得提供「停止」按钮或声称已经停下。
   - **`egm-task-resume` / `egm-task-complete` / `egm-task-reopen`**：继续（解除暂缓并回到暂缓前的阶段）/ 结项（保留图纸与报告，只结束任务）/ 重新打开（已结项任务回到进行中，并推进方案版本）。
2. **按需展示相关选项**：仅输出当前场景真正相关的按钮（如无需复核时不放「继续复核」，无修改方案时不放「按推荐修改图纸」），不机械凑齐；
3. **替代路线走自然语言**：具体的替代路线（alternative route）在正文文本中阐述，由用户在后续常规消息中直接提出，不提供虚假无动作的替代按钮；
4. **不设人为修图纸轮数硬上限**：删除固定修图纸 2 轮额度限制，严禁在次数用尽时强迫用户接受风险或强制停止；按用户反馈持续修订同一方案，修图纸轮数与真实金鱼派发配额/许可时效严格解耦分开；
5. **无 GenUI 依赖，严禁使用 `dsh-ui`**：EGM 拥有专用动作渲染器，任务动作卡严禁使用 `dsh-ui`，防止 GenUI 竞争与组件冲突；模型完全没给动作卡时，底栏「当前方案」面板仍按后端给出的可用动作执行；
6. **点击执行机制**：用户点击动作按钮时，前端直接在当前会话内通过远程 RPC 触发固定的宿主命令（第三个参数是方案版本）：
   - 按推荐修改图纸：`/egm-action revise <taskId> <taskRevision>`
   - 继续复核：`/egm-action review <taskId> <taskRevision>`
   - 按方案开始实现：`/egm-action proceed <taskId> <taskRevision>`
   - 先保留方案：`/egm-action hold <taskId> <taskRevision>`
   - 继续 / 结项 / 重新打开：`/egm-action resume|complete|reopen <taskId> <taskRevision>`
   - 恢复历史方案：`/egm-restore <归档文件名>`
   同一动作重复点击或刷新后重试时，后端复用同一个操作记录（operationId），不会变成两次执行；上一个操作还在「送达待确认」时新操作会被拒绝并说明原因。
   命令执行后通过 steer context 注入上下文并推进，不使用普通的 `conversation.send`。
7. **与 `egm-review` 授权卡严格区分**：
   - `egm-review` 两动作围栏（`egm-review-grant` / `egm-review-deny`）**专门且仅用于**用户针对 `accessIsolated: false` 子代理的安全授权（开派发窗口与运行许可），绝非隐式授权；
   - `egm-actions` 专用于评审完毕后的业务决策与任务推进，两者职责与围栏标记严格隔离。

---

## 3. 同任务持续演进与启动模式记忆

1. **同任务持续微调，不重复初始化**：
   用户后续发送的常规消息是对**同一个任务 / 同一份图纸**进行调整与演进（同一只大象持续工作）。模型必须在当前任务与图纸基础上继续推进，**严禁反复调用 `/egm` 或重新执行 bootstrap 引导流程**。
2. **保留已敲定的有效决策**：
   前期已确认并落盘的有效决策（settled valid decisions）持续保留，后续微调不得无故推翻或重置。
3. **图纸版本（方案版本 specRevision）与评审结论有效性**：
   当图纸内容发生实质变更时产生新的**方案版本**（`taskRevision` / specRevision）。普通对话、复核、暂缓等操作**不会**推进方案版本——普通聊天既不改版本也不解除暂缓。方案版本推进后，**仅使受改动影响部分的评审结论失效**；严禁声称旧报告审过了新修改的内容，未受影响的结论保持有效。后端按图纸内容哈希核对评审新鲜度：图纸在最近一次成功评审之后又被改过时，「开始实现」会被拒绝，除非用户在明确知情的第二次确认下覆盖。
4. **统一引用注入的真实路径**：
   图纸、状态与报告文件路径以 kickoff 时注入的真实路径为准（如 `.egm/<slug>.md`、`.egm/<slug>.json` 及 `.egm/classic/<slug>/`）。
5. **仅显式指示才开新任务，不重复弹出模式选择**：
   启动模式（对话框 vs 卡片启动）一旦选择并记忆后持续生效，不重复询问。**只有当用户明确要求「开启另一个任务 / 处理新需求」时，才创建新任务**。

---

## 4. 评审授权：插件独占 `egm-review` 标记与专用按钮

金鱼评审的授权豁免普通卡片的 `ask_user_question` 约束。本机无法证实只读隔离（`accessIsolated: false`），子代理可能读取或修改工作区文件，必须由用户明确点击确认。

图纸就绪而许可不足时，在回复中输出以下 **插件独占的 `egm-review` 围栏或字面 XML 块**，等待用户点击。

**严禁使用通用 `dsh-ui` 围栏输出授权卡片，防止 GenUI 竞争与冲突。新提示必须使用 `egm-review` 专有块，EGM 渲染器独占识别并渲染；不要要求用户复制命令、输入“是”，或寻找另一个插件。**

```egm-review
{"title":"是否允许本轮金鱼评审","gap":10,"items":[{"type":"text","content":"金鱼评审的只读隔离尚未验证，可能访问或修改工作区文件。允许本轮评审吗？"},{"type":"row","items":[{"type":"button","label":"是，允许评审","action":"egm-review-grant"},{"type":"button","label":"否，先不审","action":"egm-review-deny"}]}]}
```

亦支持字面 XML 块：

```html
<egm-review>
{"title":"是否允许本轮金鱼评审","gap":10,"items":[{"type":"text","content":"金鱼评审的只读隔离尚未验证，可能访问或修改工作区文件。允许本轮评审吗？"},{"type":"row","items":[{"type":"button","label":"是，允许评审","action":"egm-review-grant"},{"type":"button","label":"否，先不审","action":"egm-review-deny"}]}]}
</egm-review>
```

宿主对历史会话中的旧版 `dsh-ui` 围栏保持向后兼容（由前端识别），新生成提示一律使用 `egm-review` 专有标记。

---

## 5. 点击执行与内部上下文通知流（二阶段机制）

用户点击「是，允许评审」或「否，先不审」按钮时，前端执行以下确定的两阶段操作：

1. **第一阶段：真实授权/撤销命令**
   - 允许评审：前端调用真实宿主命令 `/egm-review-access 确认无隔离`（一键开启 2 小时/20 次窗口 + 10 分钟/6 次许可）。
   - 暂不评审：前端调用真实宿主命令 `/egm-review-access revoke`（关闭许可与窗口）。
   - 若该命令执行失败，界面提示授权失败，操作终止。
2. **第二阶段：内部上下文继续通知（折叠）**
   - 第一阶段命令成功后，前端调用通知命令：
     - 允许评审：`/egm-review-access notify grant`（或 `/egm-review-access continue grant`）
     - 暂不评审：`/egm-review-access notify deny`（或 `/egm-review-access continue deny`）
   - 后端通过 `source.kind: 'context', form: 'notice'` 注入默认折叠的内部上下文通知，直接唤醒/继续 AI 任务。
   - **零可见杂音与保护草稿**：通知不产生普通用户可见聊天气泡，不向消息队列塞入普通用户消息，绝对不触碰、不覆盖、不清除用户在输入框中已键入的草稿和已附加的文件。
   - **严格区分授权成功与通知失败**：由于第一阶段真实许可已经生效，即便第二阶段通知命令因网络或宿主原因失败，前端与模型也必须保留授权成功状态（`ok: true, sendOk: false`），**严禁要求用户再次授权或重复执行授权命令（no duplicate / no regrant）**。

---

## 6. 备用入口

EGM 面板中的「评审许可」区持续可用。在无界面的终端或用户明确需要命令行时，提供：
- 授权：`/egm-review-access 确认无隔离`
- 撤销：`/egm-review-access revoke`
- 旧分步命令 `/egm-open` 与 `/egm-unsafe 确认无隔离` 保留作为最底层的终端降级手段。

---

## 7. 授权边界

- 插件内专用按钮经真实命令激活或撤销当前会话许可；前端与历史专有动作 `[genui-action] egm-review-grant` / `egm-review-deny` 保持向后兼容。
- 普通文字「是」「好」「同意」「否」不会自动更改系统安全许可。不要把需求讨论中的肯定当成安全许可。
- 模型不得替用户执行授权命令或伪造点击。打开面板、读取规程、本地记住启动方式均不发放许可。
- 许可绑定当前会话；不能确认所属会话时，一律拒绝操作（fail-closed）。只读隔离仍未经证实，结果继续标注非严格评审。
- 撤销关闭后续派发，不中断已在运行的评审任务。

---

## 8. 收到继续通知时的行为准则

- **收到允许评审通知**（`egm-review-grant` 或 `/egm-review-access notify grant`）：
  沿原方案和既定范围继续进行金鱼评审；实际派发仍以工具当前许可检查为准，不重复要求复制命令或重复授权。
- **收到暂不评审通知**（`egm-review-deny` 或 `/egm-review-access notify deny`）：
  保留图纸，停止派金鱼，沿既定图纸继续处理当前任务的其余非评审部分，不绕过门控。
- **结果呈现与修改**：
  先输出完整评审发现（含代码核查状态）与具体修复建议；确有分歧需要定夺时输出 `egm-actions` 专有动作围栏，不使用常规问卷 `ask_user_question`，不强推交接。
- **`egm-accept`**：
  仅记录卡片已列明且用户明确接受的风险；不代替评审、部署或源码修改授权。

---

## 9. 进度回报（`egm-progress`）：只能报告，不能自批

允许模型用插件独占的 `egm-progress` 围栏回报执行进度，方便面板显示真实状态。它**只能补充"执行情况"，不能创建许可、审批或独立结论**。

```egm-progress
{"opId": "op-xxxxxx-xxxx", "state": "running", "note": "正在按方案改 router 装配"}
```

- `opId`：必须来自命令上下文给出的真实操作编号（最近操作里可见）；没有就省略，插件不会因此编造记录。
- `state`：`not-started` / `running` / `reported-done` / `failed` / `unknown` 之一。
- `reported-done` 在面板上显示为「模型自称完成（未独立验收）」——它不是验收，也不是独立核实。
- 另可回报需求实质变更：`{"type": "requirement-change", "summary": "..."}`，由后端推进方案版本，模型不能自行改版本号。
- 严禁在此块里写授权、许可、通过/批准结论；这些只来自真实命令与用户点击。
- 程序化核实（运行测试、实际执行）在本轮被禁止，所以进度状态一律属于"模型报告"，不得表述为已实机验证。

---

## 10. 评审记录、问题台账、产物登记与并行整理（0.10.0）

### 10.1 评审记录与 `/egm-run`：重启不重跑，未知不冒充

- 每次 `egm_dispatch`（单角色或多角色批次）都会在 `.egm/runs/<runId>.json` 落一份评审记录，含图纸哈希、章节哈希、每角色作业状态。
- 进程重启或中断后，`/egm-run`（默认）会把未完结作业标为 `unknown` 并提示"进程重启或记录中断：宿主没有可查询的作业状态，按未知处理，未自动重跑"。**严禁声称重启前的评审还在跑、严禁自动重新派金鱼。**
- `/egm-run retry <runId>` 只输出复用/重试计划（哪些角色报告还在、图纸与配置哈希是否匹配），**只出计划，不派发**；汇总阶段永远不复用，必须由大象重写。
- `/egm-run` 同时给出**影响面判断**（`full` 整份重审 / `expand` 扩大范围复审 / `local` 局部复审）与理由、变过的图纸段落（≤8）和建议重审角色。它是**建议**，不是自动重审；模型引用时必须说明判断依据，不得把 `local` 说成"全部审过"。

### 10.2 问题台账与 `/egm-findings`：核实与处置分开

- 台账在 `.egm/tasks/<taskId>/ledger.json`。每条 finding 保留严重度、摘要、原文摘录、核实状态（`unverified`/`confirmed`/`disproven`）与处置状态（`open`/`fixed`/`accepted-risk`/`deferred`）。
- `/egm-findings` 默认列出最近 30 条与台账小结；`add <severity> <summary>` 登记；`verify <id> <state> [evidence]` 核实（**confirmed 必须给证据**）；`dispose <id> <state> [riskScope]` 处置（**accepted-risk 必须写清风险范围**）。
- 台账里有未处理的 blocker 时，`/egm-action proceed` 会被拒绝（`E_OPEN_BLOCKERS`），除非用户显式输入 `/egm-action proceed <id> <specRev> confirm` 表示知情覆盖；覆盖会记入操作历史。
- 未核实不等于成立，也不等于通过；disproven 的结论保留在台账里备查但不算阻塞。与 §1 的核验规则一致。

### 10.3 产物登记与 `/egm-artifact`

- `/egm-artifact <kind> <path>` 把工作区内真实存在的文件登记进台账（kind：brief/draft/design/review-report/review-summary/bootstrap-doc/drift-report/handoff/code-diff/other，超出按 other）。登记时记录 SHA-256 与大小；`design` 会设为当前图纸引用。
- 文件必须真实存在（≤8MB），路径不得逃出工作区；模型不能登记印象中的文件。

### 10.4 材料收集：目录与网址

- `egm_dispatch` 的 `materials` 支持单文件、`dir:` 前缀目录与 `https://` 网址。目录展开有上限（默认 20 个文件、单文件 2MB、总 8MB、深度 6），遵守 `.gitignore`/`.egmignore`；网址只收文本类型，拒绝内网/回环地址，超时与重定向有上限。
- 材料清单与哈希落在 `.egm/materials/`。**`coverage.complete=false` 时必须如实说明缺了哪些材料，严禁用模型印象补齐。**

### 10.5 并行文档整理与 `/egm-bootstrap`

- `/egm-bootstrap plan [--root <dir>]` 给出仓库文档分区计划；`run [分区ID...] [--root <dir>]` 为每个分区开一个零上下文子代理写入 `.egm/bootstrap-staging/<批次>/`（只写暂存，不改源码）；`commit [分区ID...]` 把暂存文档落盘到 `docs/designs/`。
- **`run` 必须先打开 EGM 流程窗口**（与金鱼评审同一授权门）；未开窗会被拒绝（`E_GATE_NOT_OPEN`）。并发只是同时开的子会话数；暂存目录不构成只读隔离，落盘前用户自己看 diff。
- `commit` 从不覆盖已有文件：目标已存在且内容不同时保留 `<name>.egm-candidate.md` 并报告冲突，两份都留。

### 10.6 交接导出与 `/egm-handoff`

- `/egm-handoff export` 生成只读交接文档（任务、目标、关键决定、图纸与产物、评审来源、问题台账、结论与风险、操作记录、未验证项）；`/egm-handoff import <path>` 只做只读预览，**不恢复任何许可、不自动开始任何工作**。

### 10.7 `egm-progress` 扩展：产物与问题上报（仍然只能报告）

进度块新增两种报告类型，写入台账时一律记为模型报告：

```egm-progress
{"type": "artifact", "kind": "design", "path": ".egm/my-design.md", "note": "初稿完成"}
```

```egm-progress
{"type": "finding", "severity": "high", "summary": "一句话摘要", "quote": "原文摘录（可选）", "requiredFix": "建议修法（可选）"}
```

- 边界不变：只补"执行情况"，不创建许可、审批或验收结论；模型上报的 finding 一律 `unverified`，核实与处置只能走 `/egm-findings` 或用户命令；`kind` 不在清单里时整条忽略，不会静默改成 other；上报失败静默，不影响对话。
- 产物登记要求文件真实存在于工作区内，模型不能登记不存在的路径。

### 10.8 自定义角色评审（.egm/config.json）

- 在 `.egm/config.json` 的评审配置（`review.profiles`）中通过 `{id, label, standard}` 声明的自定义角色现已接入 `egm_dispatch` 派发。
- 自定义角色通过 `standard` 字段指定标准文档路径（工作区相对路径）。派发时若 `standard` 非空，作为 `standardPath` 拷入评审房间供金鱼作为评审依据；若 `standard` 为空则不绑定标准。
- 自定义角色支持带 `stage`（5..9）参数进行阶段评审，受 profile 阶段声明约束（若 profile 声明了 stages 范围则校验归属，未限制则兼容所有阶段）。
