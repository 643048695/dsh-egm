---
name: egm-classic-draft
description: 原版 EGM「设计文档起草」的 DSH 适配版：读前序产物（concepts_brief.md / discussion_summary.md / 用户输入），逐节写 design_draft.md，每节停下等用户批准，最后按 zoom-out 标准自检并落到 docs/designs/<FEATURE>.md。用户手动输入才运行，模型不得自行触发；不派金鱼、不需要许可。
when-to-use: 用户说「起草设计文档」「按原版 egm-draft 写」「把这份想法写成 EGM 设计图」，或在 brainstorm 之后要落到文档时。
model-invocable: false
---

# 设计文档起草（DSH 适配版）

## 0. 这是什么

上游 `egm-draft`（`vendor/egm/skills/egm-draft/SKILL.md`）的工序适配版：**一节一停**，用户批准才往下写。
原版的门是 `ask_question`；这里换成 `ask_user_question`（一个问题、一屏、最常用选项排第一）。

先读：`vendor/egm/skills/egm-draft/references/design_doc.md`（章节模板，**必读**）、
`vendor/egm/resources/document_standards/zoom-out-standard.md`（自检标准，**必读**）。
两份都是原版原文，路径相对插件包根。

> **路径基准**：`resources/`、`vendor/`、`agents/` 均以**插件包根**（DSH 的 plugin root）为准，**不是 SKILL.md 同目录**。若找不到文件，应按环境提供的绝对清单复查，**绝对不能自己瞎编模板继续**。`design_draft.md`、`docs/designs/` 相对当前工作区。当前对话可见真实 working 态工作提示动画，但不得声称实机已验收。

## 1. 输入

- `Context File`（可选）：前序产物路径。
- 没给就按原版顺序自动找：`concepts_brief.md` → `discussion_summary.md`（当前目录、`.egm/classic/<slug>/`、`scratch/` 各找一遍）。
- 都没有：问用户「想做什么、给谁用、成功长什么样」，然后**先聊清楚再写**，不要凭一句话硬凑一份设计。

## 2. 流程

### Step 1 读入并确认

读前序产物（若有），用 5–8 行复述：目标、边界、已定决策、还空着的地方。然后问一次「按这个开写？」——得到明确同意才动笔。

### Step 2–5 逐节写（每节一个循环）

按模板顺序写，每节都走同一套循环：

1. 把这一节写进 `.egm/classic/<slug>/design_draft.md`（增量追加/替换，不整篇重写）。
2. 在聊天里给 3–6 行要点 + 文件路径（不要贴整节全文）。
3. `ask_user_question` 只问一个问题：
   - `0` 批准，继续下一节（默认）
   - `1` 要改：请直接在文件里留注释，或写清改什么
4. 用户选 `1` 但没留注释、也没说改什么 → **不要再问一遍**，在聊天里问「具体改哪句？」，然后停手等回答。

章节顺序（按模板，通常）：

| 节 | 内容 | 要点 |
| --- | --- | --- |
| 1 | Overview / Goals / Problem | 为什么做、给谁、不做会怎样；目标要可验证 |
| 2 | Technical Plan | 组件、数据流、接口、失败路径；写清不做什么 |
| 3 | Alternatives | 至少一个被否掉的方案 + 否掉的理由（没有就是没想清楚） |
| 4 | Implementation | 分步计划、依赖、验证方式；能被别人照着做 |
| 5 | 风险与回滚 | 上线失败怎么退、怎么观测 |

任何一节里出现「我们觉得」「应该可以」这类没根据的话，自己先标出来问用户，别写进文档当结论。

### Step 6 收尾落盘

1. 找设计目录：`Context File` 所在目录 → `docs/designs/` → `<project>/docs/designs/`；都没有就用 `docs/designs/`（必要时创建）。
2. `ask_user_question` 确认保存位置（检测到的路径 / 我另给路径）。
3. 若 `<设计目录>/SITEMAP.md` 存在：按它的表格登记新设计（Link、Date、Author、Components、Description），没这张表就不建。
4. **自检**：把 `design_draft.md` 对着 `zoom-out-standard.md` 逐条过一遍。若存在不达标项，在聊天中明确列出问题并附带具体拟改建议，再请用户确认是否采纳建议修改或按现状落盘；**严禁不给修改方案直接反问用户**。
5. 按模板写 `<设计目录>/<FEATURE>.md`：干净 Markdown、相对链接、代码块带语言、不残留 TODO 占位。
6. 保留 `design_draft.md` 作为过程证据；最终文档是 `<FEATURE>.md`。
7. 用插件独占进度块登记最终文档（` ```egm-progress ` 内 `{"type":"artifact","kind":"design","path":"<最终文档路径>"}`），或输入 `/egm-artifact design <最终文档路径>`；同一份正式设计只保留一个当前引用，过程草稿可按需登记为 draft。
8. 收尾报路径 + 一句话摘要 + 建议下一步：`egm-classic-review <FEATURE>.md`（完整五阶段）或 `egm-classic-review-loop`（只挑刺）。

## 3. 不许做的事

- 不许一次写完全部章节再给用户看（原版就是逐节批准；一次写完等于没门）。
- 不许在用户没批准时继续下一节。
- 不许把「自检通过」写成「符合 zoom-out 标准」——只说「按标准逐条核对，剩余 N 项」。
- 不许改动 `docs/designs/` 里其他设计文档。
- 不许声称这是原版 `egm-draft` 运行时；模板与标准是原版原文，流程是适配的。

## 4. 与原版的差异

| 原版 | 这里 |
| --- | --- |
| `ask_question` 单选门 | `ask_user_question`（一问一屏） |
| 草稿写当前目录 `design_draft.md` | 写 `.egm/classic/<slug>/design_draft.md`，最终文档才进 `docs/designs/` |
| 自动探测上下文 | 同样探测，但会先复述让你确认 |
| 链接 `egm-review` | 建议 `egm-classic-review`（本包内的适配技能） |
