# 原版 EGM 与 DSH 的差异清单（适配边界）

一句话：**原版 7 个 skill 的正文已在 `vendor/egm/` 里原样保存；能在这里跑的是它们的工序骨架，不是原版运行时。**

凡本文标记「不成立」的说法，不许出现在技能输出、README 或给用户的答复里。
本文说「可用」只表示**代码已实现、按实现读过并对得上**，不代表在真实 DSH 会话里端到端跑通过——那件事没有证据。

## 依据

- 上游：`google/elephant-goldfish-model`，commit `a8380ab5f0aba392c97e31c79f9a6666b3f09f14`。
- 镜像校验：`vendor/egm/` **121 个上游文件**与 pin 逐字节一致，见 `vendor/egm/UPSTREAM.md` 与 `vendor/egm/SHA256SUMS`。
  上游的 `TEST.md`、`test_scenarios.yaml`、`tests/`、`TESTING.md`、`scripts/` 也在。运行情况只有一条可说的：
  2026-10-28 在副本里跑过上游 pytest 的 `tests/unit/test_frontmatter.py` 与 `tests/unit/test_scenario_coverage.py`，**2 passed**；
  其余测试（含需要 `distributions/`、`site/` 的打包测试）**没跑**，DSH 里也**没有**端到端跑过 EGM 流程。
- DSH 侧事实来源：`lib/dispatch.js`（角色白名单、阶段映射、提示词、双门控、`egm_dispatch` 与 `egm_dispatch_batch`、受控材料复制与真实 range 裁剪）、
  `lib/skill-provider.js`（技能发现）。这两份代码优先于任何文档，包括本文。
- 本文与代码对齐时间：0.7.0 并行评审与受控材料改造规范基线。

## 能力对照

| 能力 | 原版怎么做 | DSH 现状 | 结论 |
| --- | --- | --- | --- |
| 7 个评审角色 | `agents/<name>.md` 人格卡 | 同样的卡在 `vendor/egm/agents/`；`role` 取 7 个短名，卡由工具复制进评审房间 | 已实现 |
| 角色 ↔ 标准固定映射 | `egm-review-loop` 的 `Standards` 参数 | 写死在 `lib/dispatch.js` 的 `EGM_ROLES`；调用方换不了标准，`style` 不绑标准 | 已实现，且比原版更严 |
| 5 个阶段（5–9） | `egm-review` 逐阶段编排 | `stage` 校验角色是否属于该阶段；跨阶段依赖仍由技能按顺序编排 | 已实现单阶段校验；**跨阶段编排在技能层**，不是工具能力 |
| 阶段对象 = 行区间 | 切出 FeatureRange / DetailedRange 只审其中一段 | `range: {start,end}` 真实生成切片裁剪副本，行号映射回原文件；原版在 review-loop 仅是指令提示，上游无强裁剪保证；本地裁剪副本非权限隔离，硬性禁越读未证实 | 真实裁剪副本已实现；仍标 `strictGoldfishReview:false`，非权限隔离 |
| 源码受控材料 | 传入 reading list | `sources` 要求指定普通文件受控复制副本进房间，按角色最少材料，禁止整目录盲传 | 已实现受控普通文件复制 |
| 跨阶段上下文 | synthesizer 串起各阶段；Stage 8 读 Stage 5 报告，Stage 9 读目标详设 | 无跨阶段工具编排；`materials` 把文件复制给金鱼，由技能显式传递 | 部分可用：技能必须显式传 `materials`，缺失要在报告里写明 |
| 阶段内并行评审 | synthesizer 并行派多个金鱼 | 0.7.0 新增 `egm_dispatch_batch`，支持批次内/阶段内并行（concurrency 默认 3 最大 3，单批上限 6），同批共用不可变图纸快照 | 已实现阶段内并发；不宣称整套五阶段实机等价跑通 |
| brainstorm 6 镜头 | synthesizer 并行派 6 个 `Mode: BRAINSTORM` 金鱼并汇总 | `mode: "brainstorm"` 接入 `egm_dispatch_batch`，单批并发派发 6 视角（concurrency=3），由独立 fresh 汇总子会话整理 | 已实现阶段内并发与代办汇总；不宣称与原版完全等价 |
| 汇总去重 | synthesizer 归一化、去重、写报告 | 批次由独立 fresh spawn 汇总子会话整理原报告，插件父侧落盘；不额外扣评审配额；partial/失败显式报错，禁主会话代评 | 独立 fresh 汇总代办已接入；严禁主会话代评 |
| 零上下文 | 新会话、无历史 | 新建子会话，不继承父对话；单独建评审房间、受控复制材料，但材料仍可能含背景信息 | 不自动继承聊天；不能保证审查材料绝对无背景 |
| 只读隔离 | 角色要求只读 | 仅有创建前只读策略钩子，不覆盖完整 MCP/网络能力，Windows 实机拒写未验证 | 仍不宣称系统隔离，`strictGoldfishReview:false` |
| 派发许可 | 无此概念 | 0.8.0 优先支持在 EGM 面板持续可找到的「评审许可」区（勾选风险说明后点击「允许本轮评审」）；命令提供一键授权 `/egm-review-access 确认无隔离`（`/egm-review-access revoke` 撤销）；旧分步命令 `/egm-open`、`/egm-unsafe 确认无隔离`、`/egm-safe` 保留作为无 UI fallback。批次配额不足整批先拒绝 | 已实现；未注册专用授权模型工具，常规流程要求用户明确操作；插件门控不构成硬权限边界；打开面板/记住启动方式不会自动授权；配额不足整批拒绝；五阶段中途仍须手动续授权 |
| `ask_question` 单选门 | 原版交互闸 | DSH 用 `ask_user_question`（一问一屏，选项带白话代价） | 可用，措辞改写 |
| `spawn_agent` / `invoke_subagent` / `Agent` | 各宿主子代理 | DSH 有 `subagent`，但插件规则只允许 `egm_dispatch` 与 `egm_dispatch_batch` 当金鱼通道 | 不经派发工具的「金鱼」不算金鱼 |
| `egm-bootstrap` 的分区多 worker | 子编排器并行写 README | 降级为串行分批 | 不成立（并行层）：主会话串行分批 |
| `egm-drift-report` | 主会话读文档 + 代码比对 | 同样能做 | 可用 |
| `egm-draft` | 主会话逐节写、逐节确认 | 同样能做 | 可用 |
| `egm-resolve` | 主会话分类并改文档 | 同样能做 | 可用 |
| 行号自动重算、1 次重审上限、暂停/恢复 | 原版编排逻辑 | 技能层文字约定，**不是强制机制**；模型可能不遵守 | 部分可用：别当保证 |

## 命令注册与授权门控

- `lib/index.js` 注册 `/egm`、`/egm-open`、`/egm-unsafe`、`/egm-safe`、`/egm-review-access`。
- 0.8.0 优先支持在 EGM 面板持续可找到的「评审许可」区操作：勾选风险说明后点击「允许本轮评审」即可一键授权；亦可通过 `/egm-review-access 确认无隔离` 一键开启 2 小时/20 次窗口 + 10 分钟/6 次许可，或用 `/egm-review-access revoke` 撤销。
- 旧两道分步命令 `/egm-open` 与 `/egm-unsafe 确认无隔离` 保留作为无 UI / 终端 fallback：开窗口只是打开派发窗口；真正派发仍需用户授权非隔离许可。未注册专用授权模型工具，常规流程要求用户明确操作；插件门控不构成硬权限边界；打开面板或记忆启动方式绝对不自动授权。
- 批次配额规则：`egm_dispatch_batch` 启动前检查剩余非隔离许可，每鱼扣一次。若剩余配额 < 任务数，**整批直接拒绝**；汇总代办不扣配额。完整五阶段 9 次派发仍须中途续授权（系统不自动补配额）。
- `skills/egm-classic-*` 是**技能**，不是斜杠命令，不要承诺「输入 /egm-classic-review 就能触发」。

## 入口与边界（egm-gate 的触发方式）

- `skills/egm-gate/SKILL.md` 的 frontmatter 为 `model-invocable: false`。
- **这不是强制隔离**：文件就在包内，模型仍可以直接读它，或者绕过它自己写图纸。能硬锁的只有派发工具的两道门。

## 不许说的话

- 「原版 EGM 在这里可以直接跑」——原版 skill 的宿主假设在 DSH 不成立。
- 「严格金鱼评审」「已隔离」「只读已验证」——只读不可证实，必须标 `strictGoldfishReview:false`。
- 「等价于原版 `egm_review` 五阶段流程」——工具自己返回 `equivalence.flowEquivalent:false`；同阶段内并行不等于整套五阶段实机等价跑通。
- 「原版有强裁剪保证」——原版在已查 review-loop 仅是指令提示，上游并无强裁剪保证。
- 「裁剪等于系统隔离 / 硬性禁越读已证实」——裁剪只是切片副本，非权限隔离；不允许把“没输出目录”说成从未运行。
- 「partial 等于通过」或在 partial/失败时主会话在自己上下文里替金鱼代评补意见。
- 「上游测试全绿了」——只在副本里跑过 `test_frontmatter.py` / `test_scenario_coverage.py` 两项（2 passed），其余没跑，更不代表 DSH 运行通过。
- 「npm 包是 121 个文件的逐字节完整镜像」——npm 打包会省掉 `vendor/egm/.gitignore`。
- 「/egm-classic-* 是斜杠命令」——未注册。

## 怎么复验

```bash
cd dsh-egm/vendor/egm && sha256sum -c SHA256SUMS          # 121 个上游文件 + UPSTREAM.md 必须全 OK
node <临时目录>/check-skills.mjs dsh-egm                   # 技能 frontmatter / 包根相对链接
grep -n "BRAINSTORM_ROLES\\|E_GATE_NOT_OPEN\\|egm_dispatch_batch" dsh-egm/lib/dispatch.js
```

`egm_dispatch` 与 `egm_dispatch_batch` 的真实入参、返回与错误码见 `resources/classic-dispatch.md`；代码随时可能改动，以 `lib/dispatch.js` 为准。
