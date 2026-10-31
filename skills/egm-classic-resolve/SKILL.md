---
name: egm-classic-resolve
description: 原版 EGM「大象裁决」的 DSH 适配版：读入金鱼评审发现，逐条分类 CONTEST / ESCALATE / PROPOSE FIX / DECLINE，写逐条裁决报告，经用户选择后把获准的修改落到目标文档。用户手动输入才运行，模型不得自行触发；不需要派金鱼，也不需要评审许可（不需要点「允许本轮评审」或输入 /egm-review-access / /egm-unsafe）。
when-to-use: 用户说「处理这些评审发现」「把金鱼的发现裁决一下」「egm-classic-resolve <评审报告>」，或五阶段/循环评审的检查点选了「用 agent 处理发现」时。
model-invocable: false
---

# 金鱼发现裁决（DSH 适配版）

## 0. 这是什么

上游 `egm-resolve`（`vendor/egm/skills/egm-resolve/SKILL.md`）的工序适配版。
它跑在**有上下文的会话**里（知道这份文档为什么这么写），负责顶住不成立的意见、修掉成立的、把读不到证据的交给人。

它**不派金鱼**，所以不需要评审许可（不需要点「允许本轮评审」或输入 `/egm-review-access` / `/egm-unsafe`）。它的产物是裁决，不是新评审。

先读：`resources/classic-report-format.md`（裁决报告格式与硬约束）。

> **路径基准**：`resources/`、`vendor/`、`agents/` 均以**插件包根**（DSH 的 plugin root）为准，**不是 SKILL.md 同目录**。若找不到文件，应按环境提供的绝对清单复查，**绝对不能自己瞎编模板继续**。当前对话可见真实 working 态工作提示动画，但不得声称实机已验收。

## 1. 输入

- `TargetFile`：被评审的文档。
- `LineRange`：行区间或 `full file`（没有就以整份文档为范围，并在报告里写）。
- `FindingsList`：发现清单，来自某份评审报告（`.egm/classic/<slug>/critic_report.md` 等），或用户直接贴的清单。

缺 `FindingsList` 就问「裁决哪份报告的发现？」并给出现有 `.egm/classic/*/` 下的报告路径。
不要自己重新审一遍再假装是金鱼的发现。

## 2. 流程

### Step 1 读原文与发现

读 `TargetFile`（按 `LineRange` 定位）；读发现清单，逐条编号（F1、F2…）。
发现里带行号的，核对原文是否还在那个位置；对不上就标注「行号漂移，按标题定位」。

### Step 2 逐条分类（只能四选一）

| 分类 | 什么时候用 | 硬约束 |
| --- | --- | --- |
| `CONTEST` | 批评不成立，且你能指出**评审者也能读到**的证据（文件+符号，或文档里写下的决定） | 「这是有意的」「你不懂背景」不是证据；拿不出证据就不许 CONTEST |
| `ESCALATE` | 批评可能不成立，但证据在评审者读不到的地方（团队约定、口头决定、外部系统） | 不许顺手改；原样交给用户，说明缺什么信息 |
| `PROPOSE FIX` | 批评成立 | 给出**精确替换文本**或明确删除/移动指令，不写「优化一下」 |
| `DECLINE` | Nit，不值得改 | 记录下来，不修；如果修起来很便宜也可以归到 `PROPOSE FIX` |

另外守四条（原版硬规矩）：不改严重级（不同意就 CONTEST + 理由）；复述类缺口不许 CONTEST（新读者看不懂就是文档缺上下文）；
不为了讨好评审者而堆上下文（只有零上下文子代理需要、人类读者不需要的，走 ESCALATE）；文档是你写的，「想反驳」本身不算证据。

### Step 3 呈现拟改方案并写裁决报告

写 `.egm/classic/<slug>/goldfish_review_report.md`，格式按 `resources/classic-report-format.md` 的
`goldfish_review_report.md` 小节：每条含范围、描述、裁决、理由、拟改。
报告头写：目标、范围、来源报告、发现总数与分类计数、非隔离声明（如果发现来自 `egm_dispatch`）。

**在聊天中必须先以正常可见文本呈现所有发现的裁决与拟改方案**：
- `PROPOSE FIX`：展示具体的修改草案（哪行改成什么）；
- `CONTEST`：给出评审者也能读到的可核对证据；
- `ESCALATE`：说明缺少什么外部信息，需要用户判断；
- `DECLINE`：说明不修理由。
确保用户在看到完整具体的修改方案后再做决定；**严禁在用户看到具体方案前提前弹窗**。

### Step 4 让用户拍板（方案先行与专有动作卡）

在正文完整呈现上述方案后，严禁使用 `ask_user_question` 弹出例行下一步问卷。
- 用户若已明确授权当前范围内修改（如明确表示“按推荐方案改”），展示方案后直接落改 `TargetFile`，无需额外等待；
- 需用户拍板时，通过插件独占的 `egm-actions` 专有围栏输出直接点击按钮：
```egm-actions
{
  "title": "裁决后续操作",
  "taskId": "<命令上下文给出的真实 taskId，不知道就省略>",
  "taskRevision": "<命令上下文给出的方案版本整数，不知道就省略>",
  "items": [
    { "type": "button", "label": "按推荐修改", "action": "egm-task-revise" },
    { "type": "button", "label": "继续复核", "action": "egm-task-review" },
    { "type": "button", "label": "按当前方案动手", "action": "egm-task-proceed" },
    { "type": "button", "label": "先保留方案", "action": "egm-task-hold" }
  ]
}
```
- **角色分工与动作含义**：
  - 金鱼只做独立审查不写代码；大象（主会话）负责整理方案与修改设计文档；
  - `egm-task-revise`：仅将获准的修改写入设计文档（`TargetFile`），**绝不改动业务源码**；
  - `egm-task-proceed`：明确为「按方案开始实现」，此时才获准开始编写代码/改动源码，且**绝对不绕过未闭环的阻塞项**；当前图纸与最近一次成功评审不一致时后端会拒绝，需先补审或用户明确二次确认；
  - `egm-task-review`：仅用于针对修改后的文档进行针对性补审。
  - `taskId` / `taskRevision` 只填真实值（`taskRevision` 是方案版本整数，不是记录修订号），都不知道就两项都省略；
  - 用户点击按钮直接在当前会话内通过远程 RPC 触发固定的宿主命令 `/egm-action revise|review|proceed|hold|resume|complete|reopen <taskId> <taskRevision>`，随后通过 steer context 推进；重复点击或刷新重试复用同一操作记录。
  - 严禁设定人为硬性修图纸轮数上限（如固定 2 轮额度），严禁在次数用尽时强迫接受风险或停止。

### Step 5 落改并复核

按用户选择改 `TargetFile`（用 `edit` 精确替换，不要整篇重写）。
改完：

1. 复读文件，确认 Markdown 结构没坏（标题层级、代码块闭合、表格列数）。
2. 在 `goldfish_review_report.md` 顶部加 `Status: resolved`，并统计：接受 n / CONTEST n / ESCALATE n / DECLINE n。
3. 在聊天里报路径 + 统计 + 仍待用户决定（ESCALATE）的条目；建议下一步：重跑评审（`egm-classic-review-loop`）或收尾。

## 3. 不许做的事

- 不许在用户未见具体拟改方案前提前弹出 `ask_user_question`。
- 不许把用户确认修改设计图纸等同于修改业务源码的授权；修改源码必须在出具明确方案并获用户正式审批后方可执行。
- 不许把 `CONTEST` 写成「用户说不用改」；要有可核对证据。
- 不许擅自合并两条发现后只改一处。
- 不许改文档里没被裁决覆盖的部分。
- 不许在 Step 4 之前改文件。
- 不许声称「已解决全部发现」——ESCALATE 与 DECLINE 永远留痕。

## 4. 与原版的差异

| 原版 | 这里 |
| --- | --- |
| 由 orchestrator 作为子流程自动调用 | 用户手动进入，或从上一步检查点跳进来 |
| 门是 `ask_question` 多选/单选 | `ask_user_question` 一问一屏 |
| 报告写工作目录 | 统一写 `.egm/classic/<slug>/goldfish_review_report.md` |
| 行号由编排器重算 | 自己核对行号，漂移就按标题定位并注明 |
