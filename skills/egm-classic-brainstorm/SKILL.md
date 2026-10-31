---
name: egm-classic-brainstorm
description: 原版 EGM「概念脑暴」的 DSH 适配版：先深聊澄清问题、写锚定假设，再把概念派给 6 个上游视角（优先通过 egm_dispatch_batch 批量并发派发），由独立 fresh 汇总代办整理 concepts_brief.md，最后交接到设计起草或 RFC。用户手动输入才运行，模型不得自行触发；需要面板评审许可或命令授权。
when-to-use: 用户说「先脑暴一下这个想法」「按原版 egm-brainstorm 来」「别急着写文档，先帮我把反对意见想全」，或在 egm-classic-draft 之前想先压一遍方案时。
model-invocable: false
---

# 概念脑暴（DSH 适配版）

## 0. 这是什么

上游 `egm-brainstorm`（`vendor/egm/skills/egm-brainstorm/SKILL.md`）的工序适配版。

原版：synthesizer 并行派 6 个 `Mode: BRAINSTORM` 金鱼 → 汇总成 `concepts_brief.md`。
DSH 适配版：
- **路径基准**：`resources/`、`vendor/`、`agents/` 均以**插件包根**（DSH 的 plugin root）为准，**不是 SKILL.md 同目录**。若找不到文件，应按环境提供的绝对清单复查，**绝对不能自己瞎编模板继续**。当前对话可见真实 working 态工作提示动画，但不得声称实机已验收。
- **批量派发**：优先使用 `egm_dispatch_batch` 一次性提交 6 个视角任务（`mode: "brainstorm"`，并发上限 3），单视角仍可走 `egm_dispatch`。
- **独立 fresh 汇总代办**：批次完成后由独立 spawn 的 fresh 汇总子会话合并各视角产出，由插件父侧落盘到 `.egm/classic/<slug>/concepts_brief.md`。汇总不占用评审配额。
- **门控与配额**：0.8.0 优先支持在 EGM 面板持续可找到的「评审许可」区点击「允许本轮评审」（勾选风险说明）；命令提供一键授权 `/egm-review-access 确认无隔离`（`/egm-review-access revoke` 撤销）；旧分步命令 `/egm-open` 与 `/egm-unsafe 确认无隔离` 保留作为无 UI fallback。6 个视角需 6 次配额，派发前严格做配额预检：配额不足 6 次时整批先拒绝。
- **非隔离声明**：结果标 `strictGoldfishReview: false`，不许说「严格金鱼评审」。

必读：`vendor/egm/skills/egm-brainstorm/SKILL.md`、`resources/classic-dispatch.md`、`resources/classic-fidelity.md`。

## 1. 输入

- 想法/需求（必需）：一句话也行，没有就先问。
- 可选：已有文档、约束（预算、时间、必须兼容的东西）。

## 2. 流程

### Step 1 深聊澄清（不要跳到镜头）

原版在这里强调：**问题探索阶段不要用结构化提问、不要给候选方案**。照做：

- 开放问题一轮一轮聊：现在怎么解决的？谁疼？不做的代价是什么？成功的判据是什么？硬约束有哪些？
- 一次问 2–3 个，不要一口气十条；答得含糊就追一层（「具体是哪个流程慢？」）。
- 不要替用户补答案，直到你能写出下面这段锚定假设。

### Step 2 写锚定假设（Readiness Gate）

```markdown
**问题**：<谁在什么场景下遇到什么，现在怎么凑合>
**假设**：<这个方案为什么能解决；最关键的因果链>
**边界**：<明确不做什么>
**成功判据**：<可验证的指标或可观察行为>
**已知未知**：<还没想清的关键点>
```

写进 `.egm/classic/<slug>/concept.md`（这就是后面派发的 `docPath`）。
`ask_user_question` 问一次：`0` 假设成立，进入镜头 · `1` 先改假设 · `2` 再聊一轮。
选 `1`/`2` 就回 Step 1；没点头不许往下。

### Step 3 派 6 个视角

授权与门控：授权首选界面操作，引导用户在 EGM 面板持续可找到的「评审许可」区阅读风险说明、勾选确认框，并点击「允许本轮评审」按钮（通过原生命令一键开启 2 小时/20 次窗口与 10 分钟/6 次许可，面板展示真实剩余次数与到期时间，用尽就地重新确认续期）。亦可使用一键命令 `/egm-review-access 确认无隔离`（撤销用 `/egm-review-access revoke`），或旧分步命令 `/egm-open`（开 2 小时/20 次窗口）+ `/egm-unsafe 确认无隔离`（开 10 分钟/6 次许可）。
配额预检：6 视角需 6 次配额，检查当前配额是否满 6 次；不足整批先拒绝，请用户重新授权。

**优先批量派发（`egm_dispatch_batch`）**：
```json
{
  "docPath": ".egm/classic/<slug>/concept.md",
  "mode": "brainstorm",
  "concurrency": 3,
  "tasks": [
    { "role": "zoom_out" },
    { "role": "design_critic" },
    { "role": "comprehension" },
    { "role": "implementation_readiness" },
    { "role": "codebase_details" },
    { "role": "structural" }
  ]
}
```

6 个角色盯什么：
1. `zoom_out`：反方／YAGNI、代码精简
2. `design_critic`：成本与配额经济（峰值 QPS、存储、token 预算）
3. `comprehension`：UX 与开发体验（接口直觉、认知负担）
4. `implementation_readiness`：迁移与向后兼容、回滚
5. `codebase_details`：可观测性与 SRE 排障（trace、指标、日志）
6. `structural`：长期技术债与维护（耦合依赖、脆弱状态机）

约束：brainstorm 仅接受这 6 个角色，**不能带 `stage`、不能带 `range`**；传错角色返回 `E_MODE_ROLE_MISMATCH`。

批次派发完成后，若所有视角报告均产出则 `manifest.allPassed: true`（代表报告全部完成，仍需阅读概念简报并裁决），独立 fresh 汇总代办自动整理合并各角色产出，由插件父侧写入 `.egm/classic/<slug>/concepts_brief.md`。各视角单项原始记录写入 `.egm/classic/<slug>/brainstorm/<role>.md`。
若有单视角失败，结果清单表现为 `manifest.partial: true`（`manifest.allPassed: false`），明确注明失败角色与证据缺口，不许主会话代评。

（单视角补充或复跑可调用 `egm_dispatch`：`{ "docPath": "...", "role": "...", "mode": "brainstorm" }`）

### Step 3b （降级）主会话自推六镜头

只在用户明确同意、且工具不可用时使用。逐镜头产出具体条目，并在 `concepts_brief.md` 顶部写：**推演方式：主会话六镜头（非零上下文金鱼）**。

### Step 4 概念简报结构

生成的 `.egm/classic/<slug>/concepts_brief.md` 包含：

```markdown
# <功能名>

- 作者 / 日期
- 推演方式：6 视角金鱼（mode=brainstorm，egm_dispatch_batch 并发派发）+ 独立 fresh 汇总代办整理

## Overview
## Analysis
<按镜头分节：具体风险 → 触发条件 → 缓解或取舍；保留被否掉的方案与理由>
## Goals vs. Non-Goals
**In-Scope Goals**：<可验证 1–3 条>
**Out-of-Scope Non-Goals**：<明确不做，≥2 条>
## Key Decisions & Staging for Next Steps
## 证据范围与未覆盖
<哪几条派发了、哪几条失败/降级、未覆盖哪类问题>
```

报告里严禁宣称「原版 brainstorm 完整实机等价跑通」；同阶段内并发不等于上游完整等价。

### Step 5 呈现结论与权衡方案

在正文中先清晰呈现 6 视角脑暴的核心结论、最具争议的 2–3 个关键风险点，以及**针对各风险点明确提出的具体权衡建议与解法（选项与代价）**，供用户审阅。
严禁在没有清晰方案前空泛反问用户「这几条怎么处理？」。用户评估后若需调整，回 Step 1/2 重新锚定并更新；若需重跑则按规则重新获得授权（许可单次 6 次）。

### Step 6 交接（一问一屏）

在正文结论与方案充分可见的前提下，通过 `ask_user_question` 问一次交接路径：
- `0` 交给 `egm-classic-draft` 写正式设计文档（推荐）
- `1` 写成 RFC 放 `docs/designs/`
- `2` 先做小原型验证
- `3` 到此为止（保留 concepts_brief）

## 3. 不许做的事

- 不许跳过澄清直接给方案清单。
- 不许在没有清晰权衡方案前反问用户技术细节。
- 不许把用户允许评审等同于概念通过或开发授权。
- 不许把主会话自推说成「金鱼认为」；降级必须显式标注。
- 不许在锚定假设没被确认时派发。
- 不许把同批并发宣称为原版 synthesizer 完整等价。
- 不许把 `manifest.allPassed` 说成「概念通过」或「设计无缺陷」；**报告缺失绝不代表通过，执行失败绝不是成功**；不许把 `manifest.partial` 说成报告全部完成。
- 不许把「某镜头没发现问题」当成通过。

## 4. 与原版的差异

| 原版 | 这里 |
| --- | --- |
| synthesizer 并行派 6 镜头 + 汇总 | 优先支持 `egm_dispatch_batch` 批量并发派发（concurrency: 3）+ 独立 fresh 汇总代办；单视角支持 `egm_dispatch` |
| `Mode: BRAINSTORM` | 已支持：`mode: "brainstorm"`，限 6 角色，不绑标准、不接 stage/range |
| `ask_question` | `ask_user_question` |
| `concepts_brief.md` 写当前目录 | 写 `.egm/classic/<slug>/` |
| 交接 `egm-draft` | 交接 `egm-classic-draft` |
