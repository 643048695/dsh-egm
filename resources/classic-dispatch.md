# `egm_dispatch` 与 `egm_dispatch_batch` 拔接契约（技能侧看到的真实工具）

本文件描述技能怎么调用金鱼派发通道。**代码随时可能改**：冲突时以 `lib/dispatch.js` 为准。
本次规范基线：0.7.0 并行评审与受控材料改造（新增 `egm_dispatch_batch` 批量派发、真实 range 裁剪副本、sources 受控普通文件复制、以及独立 fresh 汇总代办）。
注意：实现代理交付过程中最终字段/schema 以 captain 对齐为准，本文为当前约定规范，不声称未实现接口已实测。

---

## 1. 工具清单

| 工具 | 适用场景 | 说明 |
| --- | --- | --- |
| `egm_dispatch` | 单角色派发 | 兼容单角色调用（如快档、阶段 5/6/8、单视角调试） |
| `egm_dispatch_batch` | 多角色批量派发（优先推荐） | 用于多角色档位（标准档、狠档）、Stage 7、Stage 9、review-loop、brainstorm 批量派发 |

---

## 2. 单角色调用：`egm_dispatch`

```json
{
  "docPath": ".egm/classic/<slug>/design.md",
  "role": "design_critic",
  "stage": "7",
  "range": { "start": 1, "end": 118 },
  "sources": ["src/foo.ts"],
  "materials": [".egm/classic/<slug>/zoom_out_report.md"]
}
```

参数说明：
- `docPath`: string（必需）。要审的文件路径。
- `role`: string（必需）。10 个白名单短名：兼容角色 `logic` / `feasibility` / `cold` + 上游 7 角色 `design_critic` / `structural` / `style` / `zoom_out` / `comprehension` / `implementation_readiness` / `codebase_details`。
- `stage`: string（可选）。`"5"`–`"9"`，校验角色归属。
- `mode`: string（可选）。`"review"`（默认）或 `"brainstorm"`（限 6 概念视角）。
- `range`: `{ start, end }`（可选）。真实裁剪副本并映射原文行号（详见第 4 节材料机制）。
- `sources`: string[]（可选）。指定普通文件并受控复制（详见第 4 节）。
- `materials`: string[]（可选）。复制进房间的阶段材料（≤10 个文件，每个 ≤2MB）。

---

## 3. 批量派发：`egm_dispatch_batch`（新工具约定）

用于多角色同阶段内并行派发，由工具同批共用不可变图纸快照，并在金鱼完成后由独立的 fresh 子会话汇总整理。

### 调用参数

```json
{
  "docPath": ".egm/classic/<slug>/design.md",
  "tasks": [
    {
      "role": "design_critic",
      "range": { "start": 1, "end": 118 },
      "sources": ["src/app.ts"],
      "materials": []
    },
    {
      "role": "structural",
      "range": { "start": 1, "end": 118 },
      "sources": ["src/app.ts", "src/types.ts"],
      "materials": []
    },
    {
      "role": "style",
      "range": { "start": 1, "end": 118 }
    }
  ],
  "stage": "7",
  "mode": "review",
  "concurrency": 3
}
```

| 参数 | 必填 | 规格约束 | 说明 |
| --- | --- | --- | --- |
| `docPath` | 是 | 工作区内有效文件路径 | 共同图纸路径。工具在批次开始前锁定不可变图纸快照，同批任务共用。 |
| `tasks` | 是 | 数组，长度 1..6 | 批次任务清单。每项为 `{ role, range?, sources?, materials? }`。 |
| `tasks[].role` | 是 | 白名单 10 角色（brainstorm 限 6 视角） | 单个金鱼角色。 |
| `tasks[].range` | 否 | `{ start, end }`，1 起整数行号 | 该任务对应的审查行区间，真实裁剪副本并映射原行号。 |
| `tasks[].sources` | 否 | string[]，≤50 条 | 该任务专用的源码文件清单（指定普通文件受控复制，最少材料）。 |
| `tasks[].materials`| 否 | string[]，≤10 个文件 | 该任务专用的阶段材料文件。 |
| `stage` | 否 | `"5"`–`"9"` | 共同阶段校验。批内所有 task 的 role 必须符合该 stage 规则。 |
| `mode` | 否 | `"review"`（默认）或 `"brainstorm"` | 共同模式。brainstorm 仅限 6 概念视角，不能带 stage 和 range。 |
| `concurrency` | 否 | 整数，默认 3，最大 3 | 批次内并发度。最大不超过 3。 |

### 共同规则

1. **同批共用不可变图纸快照**：批次启动时，工具统一对 `docPath` 进行一次性不可变快照，同批所有金鱼任务均基于此快照运行，防止执行期间文档变化。
2. **阶段依赖顺序不变**：批次并行仅限于**同一阶段内/同一批次内**的角色并发。跨阶段的依赖关系（如 Stage 8 必须依赖 Stage 5 产出的报告）保持不变，依然由技能层按阶段顺序编排。
3. **独立 fresh 汇总代办**：
   - 批次内的所有金鱼报告产出后，由插件自动 spawn 另一个全新独立的子会话（fresh context，无聊天历史）；
   - 该子会话只负责阅读并整理本批次各金鱼的原报告，执行合并去重与结构化汇总；
   - 最终汇总结果由插件父侧负责落盘到指定报告文件；
   - **汇总不算额外评审配额**，不扣减金鱼派发次数；
   - 若汇总子会话执行失败，明确返回汇总失败，**严禁主会话在自己上下文里冒充金鱼代评或伪造汇总**。

---

## 4. 材料新机制与受控副本

本次 0.7.0 对审查材料的控制机制进行了根本性改造，明确材料新含义：

### 4.1 range：真实裁剪副本 + 原文行号映射
- **行为**：工具不再仅把区间写进提示词，而是在房间内真正生成**裁剪后的文档切片副本**提供给金鱼阅读。
- **行号映射**：金鱼在切片中挑出的问题行号，由工具/汇总流程根据切片起始行精确映射回原文档的真实行号。
- **诚信边界**：
  - 原版在上游 `egm-review-loop` 中对 range 仅是提示词指令，上游本身并无强裁剪保证，**不得声称原版有强裁剪保证**；
  - DSH 的真实裁剪副本虽然在文件系统上裁剪了图纸副本，但**裁剪不是权限隔离**；
  - 评审结果依然明确标注 `strictGoldfishReview: false`，硬性禁越读未证实；
  - 不允许把“没输出目录”说成从未运行。

### 4.2 sources：指定普通文件受控复制
- **行为**：`sources` 必须指定具体的工作区**普通文件**（禁止传递整目录或整库盲传）。
- **受控副本**：工具将指定的普通文件复制为房间内的受控副本，而非挂载或直接暴露整个项目目录。
- **按角色最少材料原则**：每个 task 只传递该角色分析所必需的最少源码文件，不要多传无关代码。

---

## 5. 门控、许可与配额扣减规则（严格保留）

派发前必须经过用户本人的授权操作（未注册专用授权模型工具，常规流程要求用户明确操作；插件门控不构成硬权限边界）。0.8.0 优先支持在 EGM 面板持续可找到的「评审许可」区操作，并提供命令双通道：

1. **界面交互（优先推荐）**：在 EGM 面板的「评审许可」区，阅读风险说明后勾选确认框，点击「允许本轮评审」按钮，直接通过原生命令执行一键授权（派发窗口 2 小时/20 次，非隔离许可 10 分钟/6 次），面板展示真实剩余次数与到期时间，并在到期或用尽后就地重新确认续期。
2. **一键授权命令**：`/egm-review-access 确认无隔离`（亦接受 `grant 确认无隔离`），一次性打开派发窗口（2 小时 / 最多 20 次）并开启非隔离许可（10 分钟 / 最多 6 次）；`/egm-review-access revoke` 撤销许可并关闭派发窗口，不影响正在运行的任务。
3. **分步备用命令（无 UI fallback）**：
   - `/egm-open`：打开 2 小时 / 20 次派发窗口（只开窗口，不触发守门流程）。未开 → `E_GATE_NOT_OPEN`。
   - `/egm-unsafe 确认无隔离`：发放 10 分钟 / 最多 6 次非隔离许可。未开 → `E_READONLY_UNVERIFIED`。
   - `/egm-safe`：关闭非隔离许可并关闭派发窗口。

### 批量派发的配额预检与扣减规则
- **扣减标准**：评审仍按**每条金鱼扣一次配额**（即 `tasks.length` 次）。汇总子会话不算评审配额，不扣扣减次数。
- **不足先整批拒绝（Fail-Closed）**：
  - 启动批次前，工具先核对当前剩余非隔离许可配额。
  - **若剩余配额 < `tasks.length`，则整批直接拒绝**（返回 `E_READONLY_UNVERIFIED`，说明配额不足），不启动任何一条金鱼，绝不跑半截。
- **续授权**：
  - 完整五阶段共需 9 条金鱼（Stage 5: 1, Stage 6: 1, Stage 7: 3, Stage 8: 1, Stage 9: 3）。
  - 单次许可仅 6 次，运行完第一批（Stage 5+6+7 占 5 次）后，剩余 1 次不足以运行第二批（Stage 8+9 占 4 次），**必须由用户在 EGM 面板「评审许可」区重新点击允许（或重新输入 `/egm-review-access 确认无隔离` / `/egm-unsafe 确认无隔离`）续授权**后方可继续；系统不自动补配额，绝对不能扩大或绕过授权。

---

## 6. 状态、Partial 与失败语义

- **全部任务产出报告（`manifest.allPassed`）**：
  - 当 `manifest.allPassed === true`（即 `successfulCount === total` 且 `failedCount === 0 && missingCount === 0`）且 `summaryFailed === false` 时，代表**本批金鱼报告全部完成（仍需阅读发现并裁决，绝不代表设计通过或无缺陷）**。
  - `summaryFailed: false` 仅代表汇总子代理代办正常结束，同样不代表设计通过。
- **部分完成状态（`manifest.partial`）**：
  - 若批次中部分金鱼任务超时或失败，结果返回结构中的清单为 `manifest.partial === true`（布尔值，在 `manifest` 对象内，而非顶层状态）；
  - **`manifest.partial` 明确代表报告未全部完成（保留证据缺口）**，绝不能当作设计通过；
  - 失败的任务在报告中明确记录「该角色未跑通/失败」，保留证据缺口；
  - **严禁主会话在自己的对话上下文里替失败的金鱼代评补意见**。
- **汇总失败（`summaryFailed`）**：
  - 若各金鱼已完成但汇总代办失败，返回中 `summaryFailed: true`，保留各金鱼原始报告路径（`successful[i].reportPath`）并明确报错，不得主会话假装金鱼代评。

---

## 7. 真实返回值契约（与 lib/batch-dispatch.js 一致）

### 单角色 `egm_dispatch` 返回
`ok: true`, `role`, `report`, `reportPath`, `range`, `scratch`, `reviewClass: 'unsafe-nonisolated'`, `strictGoldfishReview: false`, `equivalence: { flowEquivalent: false }` 等。

### 批量 `egm_dispatch_batch` 真实返回结构
```json
{
  "ok": true,
  "batchId": "batch-1761748800000-a1b2c3",
  "docPath": ".egm/classic/<slug>/design.md",
  "stage": "7",
  "mode": "review",
  "concurrency": 3,
  "concurrencyPeak": 3,
  "snapshot": {
    "path": ".egm/classic/<slug>/_batch_.../snapshot.md",
    "sha256": "..."
  },
  "manifest": {
    "total": 3,
    "successfulCount": 3,
    "failedCount": 0,
    "missingCount": 0,
    "partial": false,
    "allPassed": true,
    "concurrencyPeak": 3
  },
  "tasks": [
    {
      "role": "design_critic",
      "ok": true,
      "report": "...",
      "reportPath": ".egm/review-.../report.md",
      "scratch": "...",
      "range": { "start": 1, "end": 118, "total": 200, "lineCount": 118, "accessIsolated": false }
    },
    {
      "role": "structural",
      "ok": true,
      "report": "...",
      "reportPath": ".egm/review-.../report.md"
    },
    {
      "role": "style",
      "ok": true,
      "report": "...",
      "reportPath": ".egm/review-.../report.md"
    }
  ],
  "successful": [
    { "role": "design_critic", "reportPath": "...", "report": "..." },
    { "role": "structural", "reportPath": "...", "report": "..." },
    { "role": "style", "reportPath": "...", "report": "..." }
  ],
  "failed": [],
  "missing": [],
  "summary": "...",
  "summaryPath": ".egm/classic/<slug>/critic_report.md",
  "summaryFailed": false,
  "summaryError": null,
  "summarySkipped": false,
  "summaryReason": null,
  "reviewClass": "unsafe-nonisolated",
  "strictGoldfishReview": false,
  "boundary": {
    "uncovered": ["read-only unverified", "range slice is prompt-annotated copy, not sandbox isolation"],
    "riskMitigations": ["pre-flight gate check", "immutable snapshot per batch", "independent fresh synthesis subagent"]
  }
}
```

---

## 8. 错误码速查

| 错误码 | 含义 | 技能应对 |
| --- | --- | --- |
| `E_GATE_NOT_OPEN` | 未开派发窗口或已过期 | 引导用户在 EGM 面板点击「允许本轮评审」，或输入 `/egm-review-access 确认无隔离`（或 `/egm-open`） |
| `E_READONLY_UNVERIFIED` | 未获评审许可或批次剩余配额不足 | 优先引导用户在 EGM 面板勾选风险说明并点击「允许本轮评审」；无 UI 时输入 `/egm-review-access 确认无隔离`（或 `/egm-unsafe 确认无隔离`；若配额不足需说明整批需 N 次） |
| `E_BATCH_INVALID` | 批次参数非法（tasks 为空或超 6，concurrency 超 3 等） | 修正批次参数 |
| `E_RANGE_INVALID` | range 越界或非整数 | 核对行数后重传，或审全文 |
| `E_SOURCE_INVALID` | sources 包含目录或不存在/越界 | 改为工作区内真实普通文件 |
| `E_SUBAGENTS_UNAVAILABLE` | 子代理不可用 | 停手并说明，禁止同上下文顶替 |
| `E_SUMMARY_FAILED` | 独立汇总代办失败 | 报告汇总失败，保留原报告，禁止主会话代评 |
