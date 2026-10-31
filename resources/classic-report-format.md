# 评审报告格式（汇总、去重、证据范围）

金鱼只交一段自然语言正文；**结构化、去重、落盘由独立 fresh 汇总代办或主会话按本规范完成**。
所有 `egm-classic-*` 技能写报告都按本文件。

## 落盘位置

```
.egm/classic/<slug>/
  design.md                     # 本次评审对象的快照（派发前先写死一份，避免评审中途文档被改）
  zoom_out_report.md            # Stage 5
  comprehension_report.md       # Stage 6
  critic_report.md              # Stage 7（由独立 fresh 汇总代办整理三角色报告并落盘）
  intermediate_zoom_out_report.md  # Stage 8
  implementation_readiness_report.md  # Stage 9（由独立 fresh 汇总代办整理三角色报告并落盘）
  consolidated_review_report.md # uninterrupted 预设的跨阶段汇总
  goldfish_review_report.md     # egm-classic-resolve 的逐条裁决报告
```

原版把这些报告写在当前工作目录（`cwd`）；适配版统一收到 `.egm/classic/<slug>/`，避免污染项目根。
在报告里注明这一点，别让读者以为是在项目根。

## 报告头（每份必填）

```markdown
# <阶段名> 评审报告

- 目标文档：`<路径>`（本次快照 `.egm/classic/<slug>/design.md`）
- 阶段：`<5..9>`（<阶段名>）；预设：`<interactive|uninterrupted|feature_spec|implementation>`
- 角色：`<role>`（人格卡 `vendor/egm/agents/<name>.md`）；固定标准：`vendor/egm/resources/document_standards/<name>.md` 或「无」
- 评审方式：整份文档（未裁剪）｜ 切片真实裁剪副本（原文件第 `<N>`–`<M>` 行，工具已做行号映射）
- 证据范围：`sources` 已给 `<n>` 条受控普通文件副本（列出路径）；`materials` 已给 `<m>` 份（列出文件名与来源）
- 未覆盖与缺失：<明确列出这次没给的东西或失败项，例如「未提供源码」「未提供 Stage 5 报告」「未提供目标详设」「某角色超时/失败（partial 运行）」「切片只覆盖 FeatureRange」>
- 汇总方式：独立 fresh 汇总子会话自动整理 ｜ 主会话人工结构化
- 非隔离声明：本次为**非隔离评审**（`strictGoldfishReview:false`，只读未经验证，裁剪非权限隔离）；不等价于原版 `egm_review` 五阶段流程。
- 评审房间：`<scratch 路径>`（工具原始报告 `report-<role>.md`）
- 生成时间：`<YYYY-MM-DD HH:mm>`
```

## 发现条目

按严重级降序；同一问题只出现一次。

```markdown
### <问题短名> — 严重级：Blocker（🔴）

- 位置：`<文件>:<行号>` 或 `§ <标题>`（指不出来就写 `[无代码依据]`，并降为建议）
- 评审镜头：`<role>`
- 问题：<具体、可核对；不写“不够清晰”这类空话>
- 依据：<文档原文引用 / 源码事实 / 标准条款>
- 建议改法：<能直接落成文字的改法；不要写“优化一下”>
```

严重级沿用原版：

- **Blocker（🔴）**：照这份文档开工会做错东西、做不出来，或埋下不可接受的风险。
- **Major（🟡）**：会明显拖慢、返工或造成误解，但能绕过。
- **Nit（🟢）**：文字、格式、措辞。可以只记录不修。

## 汇总与去重

批次多角色派发（如 Stage 7、Stage 9、review-loop、brainstorm）由工具自动调用独立 fresh 汇总子会话代办整理，由插件父侧落盘；单角色或主会话整理时同样遵循以下规则：

1. **同一位置 + 同一问题**：合并成一条，保留最严的严重级，`评审镜头` 里列出所有提出它的角色。
2. **不同位置但同一根因**：合成一条，位置列多处；不要按角色各抄一遍。
3. **互相冲突的建议**（A 说删、B 说留）：不要替用户选，写成一条「分歧」并列出双方依据。
4. **金鱼原话**：可以引用，但要标明是引用；不要改写成自己的结论还说是金鱼说的。
5. **Partial 与失败处理**：批次若有金鱼超时或失败，结果清单表现为 `manifest.partial: true`（`manifest.allPassed: false`）；**`manifest.allPassed` 仅代表报告全部完成（仍需阅读发现并裁决，绝不代表设计通过或无缺陷）**；**`manifest.partial` 明确代表报告未全部完成（保留证据缺口）**；**报告缺失绝不代表通过，执行失败绝不是成功**；未完成的角色在报告中明确记录「该角色未跑通/失败」，保留证据缺口；**严禁主会话在自己的对话上下文里替金鱼代评补意见**。
6. 数一下：`总发现 n 条（🔴 a / 🟡 b / 🟢 c）`，放在报告头下一行。

## 不许写的句子

- 「原版流程已跑通」「等价于原版」「严格金鱼评审」「已隔离」「只读已验证」。
- 「金鱼认为……」但实际是主会话自己推断的（没跑到就是没跑到）。
- 把「这一条没跑到」或「partial 运行」写成「报告全部完成」或「设计无缺陷」；把「allPassed」写成「设计通过」或「无缺陷」（它仅代表金鱼任务报告已产出）；**报告缺失绝不代表通过，执行失败绝不是成功**。
- 把用户的判断写成金鱼的发现。
- 把「裁剪副本」宣称为「系统级权限隔离」。

## `goldfish_review_report.md`（resolve 用）

`egm-classic-resolve` 产出的是**逐条裁决**，不是新评审：

```markdown
### <问题短名> [`<role>`] — 严重级：<原级>

- 范围：`<文件>:<行号>`
- 描述：<引自评审报告>
- 裁决：`CONTEST` | `ESCALATE` | `PROPOSE FIX` | `DECLINE`
- 理由：<必须可核对：引用文件/符号/文档里的决定；「这是有意的」不算理由>
- 拟改：<精确替换文本；或「不改」+ 原因>
```

裁决规则（原版 `egm-resolve` 的硬约束，照抄不改）：

- `CONTEST` 必须可核对；拿不出评审者能读到的证据，就不许 CONTEST。
- 证据在评审者读不到的地方（团队约定、口头决定）→ `ESCALATE`，交给人。
- 复述测试的缺口不许 CONTEST：新读者看不懂就是文档缺上下文。
- 不许擅自改严重级；不同意就 CONTEST 并写理由。
- 文档是你写的，所以「我想反驳」不是证据。
