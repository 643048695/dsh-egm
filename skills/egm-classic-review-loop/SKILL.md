---
name: egm-classic-review-loop
description: 原版 EGM「敌意评审循环」的 DSH 适配版：给定文档、目标范围、评审角色清单，逐轮派金鱼挑刺 → 逐条裁决/修正 → 用户决定是否再来一轮。用户手动输入才运行，模型不得自行触发；角色与标准由 egm_dispatch/egm_dispatch_batch 固定映射，不能换标准。
when-to-use: 用户说「跑 EGM 评审循环」「用 design_critic + structural 反复审这份文档」「按原版 review-loop 来」，而不是要完整五阶段时。
model-invocable: false
---

# 敌意评审循环（DSH 适配版）

## 0. 这是什么

上游 `egm-review-loop`（`vendor/egm/skills/egm-review-loop/SKILL.md`）的工序适配版。
原版由 orchestrator 反复「派金鱼 → 收发现 → 交给 `egm-resolve` 改 → 再派」，直到没有发现或用户叫停。

DSH 侧的关键限制与机制：

- **路径基准**：`resources/`、`vendor/`、`agents/` 均以**插件包根**（DSH 的 plugin root）为准，**不是 SKILL.md 同目录**。若找不到文件，应按环境提供的绝对清单复查，**绝对不能自己瞎编模板继续**。当前对话可见真实 working 态工作提示动画，但不得声称实机已验收。
- **标准不能换**：`egm_dispatch` / `egm_dispatch_batch` 把「角色 → 标准」写死在 `lib/dispatch.js`。原版允许调用方指定 `Standards`；这里只接受工具白名单里的固定标准（见 `resources/classic-stages.md` 的角色表）。用户要的标准不在映射里 → 说明限制，不要偷偷换角色去凑标准。
- **派发与并发**：单角色调用 `egm_dispatch`；多角色清单优先调用 `egm_dispatch_batch`（并发上限 3，最多 6 个任务）。同批快照由独立 fresh 汇总代办整理合并，由插件父侧落盘；汇总不扣除配额；`manifest.allPassed` 仅代表报告全部完成（仍需阅读发现并裁决），`manifest.partial` 保留证据缺口，严禁主会话代评补意见。
- **仍是非隔离**：结果标 `strictGoldfishReview:false`，不许说「严格金鱼评审」。
- **范围与材料**：
  - 澄清：原版在已查 review-loop 中对 range 仅是提示词指令（“focus your review on lines X to Y”），上游本身并无强裁剪保证，不得声称原版有强裁剪保证。
  - 本地传 `range` 后生成真实切片裁剪副本供金鱼阅读，行号映射回原文件；但**物理裁剪不是权限隔离**，硬性禁越读未证实，仍须标 `strictGoldfishReview:false`。
  - `sources` 必须指定工作区内普通文件受控复制副本，禁止传目录，最少材料原则。

必读：`resources/classic-fidelity.md`、`resources/classic-dispatch.md`、`resources/classic-report-format.md`。

## 1. 输入（缺什么问什么，一次问一个）

| 参数 | 说明 |
| --- | --- |
| `TargetFile` | 要审的文档路径 |
| `SemanticTarget` | 审哪一块：`full file`，或一个可定位的标题/小节名（如 `§ 2.3 回滚流程`） |
| `Reviewers` | 角色短名数组，如 `["design_critic","structural"]`；只接受工具白名单里的 7 个上游角色（+ 3 个兼容角色，但不要混用） |
| `GoldfishContext` | 额外阅读清单；只放文档点名的源码普通文件，受控复制，走 `sources`，≤50 条，禁止传目录 |

拿到后先复述一遍配置（目标、范围、角色、各角色标准、材料），让用户确认再开始。

## 2. 一轮循环

### 2.1 复算范围（每轮都做）

重新读 `TargetFile`（上一轮可能改过）。`full file` → 整份、不传 `range`；
`SemanticTarget` → 找到该标题的起止行，传 `range={start,end}`（1 起行号，工具会核对总行数并生成切片副本与行号映射）。
每轮都把整份文档快照到 `.egm/classic/<slug>/design.md`，`docPath` 指向快照；行号以原文件为准。

### 2.2 授权与门控派发

授权首选界面操作：引导用户在 EGM 面板持续可找到的「评审许可」区阅读风险说明、勾选确认框，并点击「允许本轮评审」按钮（通过原生命令一键开启 2 小时/20 次窗口与 10 分钟/6 次许可，面板展示真实剩余次数与到期时间，用尽就地重新确认续期）。
亦可使用命令通道：推荐一键命令 `/egm-review-access 确认无隔离`（撤销用 `/egm-review-access revoke`）；旧分步命令 `/egm-open` 与 `/egm-unsafe 确认无隔离` 保留作为无 UI fallback。
授权不满足就返回 `E_GATE_NOT_OPEN` / `E_READONLY_UNVERIFIED`，停下请用户操作，不要绕过。

**配额预检**：批次派发前检查剩余配额，不足 `Reviewers.length` 时整批先拒绝。

- **多角色（`Reviewers.length > 1`）**：优先调用 `egm_dispatch_batch`：
  ```json
  {
    "docPath": ".egm/classic/<slug>/design.md",
    "tasks": [
      { "role": "design_critic", "range": { "start": 12, "end": 88 }, "sources": ["src/auth.js"] },
      { "role": "structural", "range": { "start": 12, "end": 88 }, "sources": ["src/auth.js"] }
    ],
    "concurrency": 3
  }
  ```
  批次完成时由独立 fresh 汇总代办自动整理合并去重，由插件父侧落盘到 `.egm/classic/<slug>/goldfish_review_report.md`。
- **单角色（`Reviewers.length == 1`）**：调用 `egm_dispatch`：
  ```json
  {
    "docPath": ".egm/classic/<slug>/design.md",
    "role": "<reviewer>",
    "range": { "start": 12, "end": 88 },
    "sources": ["src/auth.js"]
  }
  ```

不带 `stage`：本技能是通用循环，不属于五阶段；带了会被阶段-角色校验拦下。
`range` 只在 `SemanticTarget` 是小节时才传；整份文档时省略。

### 2.3 汇总处理

- `ok:true`（单角色）或 `manifest.allPassed:true`（批量）：代表报告全部完成（仍需阅读发现并裁决，绝非设计通过），单角色或批次汇总报告已由插件父侧写到 `.egm/classic/<slug>/goldfish_review_report.md`。
- `manifest.partial:true`、`manifest.allPassed:false` 或 `ok:false`：若批次中有部分失败，如实标明失败角色与证据缺口；`manifest.partial` 属于报告部分完成而非设计通过，保留证据缺口；**报告缺失绝不代表通过，执行失败绝不是成功**，严禁主会话代评补意见。

### 2.4 裁决与拟改呈现（方案先行与代码核查）

紧接 `egm-classic-resolve` 的工序（同一份报告）：逐条给出 `CONTEST` / `ESCALATE` / `PROPOSE FIX` / `DECLINE`。
**必须在聊天中先以正常可见文本完整呈现裁决理由与具体拟改草案**（包含精准代码位置与修改内容）：
- 将金鱼声称对照实际源码与当前版本逐一核查，标明核验状态（`confirmed` / `disproven` / `unverified`）与角色出处；已证伪（`disproven`）项移入审计明细备查，绝不计入阻塞项；未核实（`unverified`）项如实说明证据缺口，不自动等于确认亦不自动当作通过；严禁编造证据；
- **角色分工与动作含义**：金鱼只做独立审查不写代码，不要新增所谓的施工金鱼；大象（主会话）负责整理方案与修改设计图纸；`egm-task-revise` 仅修改设计文档/图纸，绝不改动业务源码；`egm-task-proceed` 明确为「按方案开始实现」才开始编写代码，且绝不绕过未闭环的阻塞项；`egm-task-review` 仅用于针对修改进行补审；
- 若存在待修复项，先出具体方案；随后通过 `egm-actions` 专有动作卡提供直接点击按钮（`egm-task-revise`、`egm-task-review`、`egm-task-proceed`、`egm-task-hold`；已暂缓时用 `egm-task-resume`），避免常规问卷；卡片里的 `taskId` / `taskRevision` 只填命令上下文给出的真实值（`taskRevision` 为方案版本整数），不知道就省略；用户若已授权当前范围内修改，直接按授权执行推进；
- 若全绿无发现，在正文中明确告知通过，直接提示收尾，**严禁无端弹出「修一轮再来」「我认风险」等提问**。
用户明确同意后才落改 `TargetFile`；改完复读文件确认 Markdown 结构。

### 2.5 持续修订与循环推进

在呈现当轮修改结果与当前状态后，若仍有未决项，优先通过 `egm-actions` 按钮直接推进。新一轮会重新复算范围与快照；不要复用上一轮的行号。

**不设人为硬性轮数上限**：删除固定 2 轮额度的硬限制，严禁在次数用尽时强迫用户接受风险或强制停止。按反馈持续修订同一方案。连续几轮反复出现同一批发现且无进展时，**不要替用户下结论说「这是设计取舍、不是缺陷」**，也不得草率宣称「开工后遇到再说」——
做法是停止盲目循环，把重复项、每轮的报告与证据、核心矛盾在正文中清晰摆出来，汇报具体原因并推荐替代换法（如缩小需求边界、换实现方案或人工裁定），交用户最终裁断。**只有用户明确知情并指令接受，才能记成已接受的风险**；模型不得自动认定。真实金鱼派发配额与图纸修订轮数严格分开。

## 3. 落盘

```
.egm/classic/<slug>/
  design.md                  # 本轮快照
  goldfish_review_report.md  # 发现 + 逐条裁决（每轮覆盖写最新，旧轮次可加后缀 -round2）
```

在聊天中必须以正常可见文本呈现关键问题清单（带代码依据 `文件:行号` 与后果）及具体的拟改草案；完整报告与历史追溯落盘供查阅。**严禁在正文中隐匿具体问题仅给路径与统计**。

## 4. 与原版的差异

| 原版 | 这里 |
| --- | --- |
| 调用方可指定 `Standards` | 角色→标准固定映射，换不了；不在映射里就明说 |
| 上游由 orchestrator 驱动循环，但同样要求「每轮结束后必须等用户明确确认才回到下一轮」（见 `vendor/egm/skills/egm-review-loop/SKILL.md:146-150` 的 turn-taking 要求） | 同样不自动连跑：编排者是主会话而不是 orchestrator，每轮末尾用一个三选一问题让用户明确点头；终止条件写成「零发现或用户喊停」，本地是每轮显式询问，不默认继续 |
| 并行 + A/B | 多角色支持 `egm_dispatch_batch` 并发派发 + 独立 fresh 汇总代办；单角色仍走 `egm_dispatch` |
| 行区间 | 原版在 review-loop 仅是指令提示，上游无强裁剪保证；本地生成真实切片裁剪副本并映射行号，但裁剪非权限隔离，标 `strictGoldfishReview:false` |
| 严格只读 | 非隔离，`strictGoldfishReview:false` |

## 5. 失败处理

- `E_SUBAGENTS_UNAVAILABLE`：停手，说明本机派不出零上下文评审，不许同上下文顶替。
- `E_BATCH_INVALID` / `E_RANGE_INVALID` / `E_SOURCE_INVALID`：检查参数，sources 必须为普通文件。
- `E_TIMEOUT` / `E_EMPTY_REPORT`：记「这个角色这一轮没跑到」，报告里保留缺口；不要用别的角色补。
- 用户中途改文档：暂停，改完重读再跑；不要拿旧快照继续。
