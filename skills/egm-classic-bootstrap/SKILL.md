---
name: egm-classic-bootstrap
description: 原版 EGM「仓库文档引导」的 DSH 适配版：按 BFS 分层扫描目录、剪枝测试目录、为每个有代码的目录写 Interface/Invariants/Side Effects 契约文档，最后编译仓库根 Blueprint 并逐个验证链接。用户手动输入才运行，模型不得自行触发；原版的并行子编排器在这里由 bootstrap 库支持按顶层分区并行处理。
when-to-use: 用户说「给这个仓库做 EGM bootstrap」「按原版 bootstrap 生成目录文档」「把每个模块的契约文档补起来」，而不是只写一个 README 时。
model-invocable: false
---

# 仓库文档引导（DSH 适配版）

## 0. 这是什么、降级了什么

上游 `egm-bootstrap`（`vendor/egm/skills/egm-bootstrap/SKILL.md`，458 行）的工序适配版。
原版把剪枝后的子树分给**并行子编排器 worker**，各回一份 `subtree_index` JSON，根编排器再编译成仓库根 Blueprint。

DSH 侧的 bootstrap 库支持按顶层分区并行处理。这里的做法：

- 子树按顶层分区**并行**处理，每批 ≤5 个子树；
- 每个子树处理完立刻写文件 + 写一份 `subtree-<n>.json`（严格按
  `vendor/egm/skills/egm-bootstrap/references/worker-return.schema.json` 的 `subtree_index` 结构）作为断点与汇总输入；
- 树很大时先给规模估计再问要不要继续。

必读：`vendor/egm/resources/execution_instructions.md`（原版执行纪律）、
`vendor/egm/agents/bootstrap_orchestrator.md`（编排者人格）、上述 schema。

## 1. 输入

| 参数 | 说明 |
| --- | --- |
| `path` | 目标仓库根（必需）。相对当前工作区。 |
| `target_filename` | 每个目录写的文件名，默认 `README.md`；不想动人类 README 就用 `EGM.md`。 |
| `dry_run` | 可选：只给计划不写文件。 |

原版的 `is_worker` / `sub_tree_root` 是内部参数，这里不存在——别传、也别假装自己是 worker。

## 2. 纪律（先摆出来）

- **只写文档**，不写/不改任何源码，不跑构建，不 `git add`/`commit`。
- 临时文件、断点 JSON、日志一律放 `.egm/classic/bootstrap/<slug>/`，不落进项目目录。
- 绝不用递归 `find` / `ls -R` 扫全树：按层 BFS，一层一层来。
- 跳过符号链接（防环）；跳过 `.git`、`node_modules`、`venv`、`.venv`、`dist`、`build`、`third_party`、`.antigravity`。
- 读 `.gitignore` 与 `.egmignore`（若存在），把里面忽略的目录也跳过。
- **目录数 >15 必须停下来问**（原版强制安全门）：给目录数、预计写入文件数、预计耗时，`ask_user_question` 选「全树继续 / 只做前 N 层 / 放弃」。

## 3. 流程

### Step 0 摸底

列出根目录内容、找构建清单（`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`Makefile`、`BUILD`）——
这些决定每个目录写什么「验证方式」。`dry_run` 就到此为止，给出计划。

### Step 1 BFS 分层扫描

用一个队列按层推进，记录每个目录的父目录（用于后面写相对链接）。
每层结束后检查规模；累计子目录数 >15 立刻走安全门。

### Step 2 自底向上剪枝

保留「有源码」的目录和「包含有源码子目录」的目录，其余丢弃。

- 源码扩展名：`.c .cc .cpp .cxx .h .hh .hpp .rs .go .zig .lean .java .kt .scala .cs .fs .py .rb .php .lua .sh .bash .ts .tsx .js .jsx .mjs .cjs .swift .m .dart .sql .proto .graphql .gql .thrift .prisma .tf .hcl .cue`
- 测试目录/文件不算源码：`tests`、`testing`、`testdata`、`*_test.*`、`*Test.*`、`test_*.*`、`*.spec.*`
- 剪枝后统计：目录数、最大深度。告诉用户结果，再进 Step 3。

### Step 3 分批策略

- 剪枝后 ≤5 个目录：逐个直接写。
- >5 个：按子树分批，每批 ≤5 个；先写**最深**的子树，再往上编译父目录（父目录要引用子目录链接，必须等子目录文件先存在）。

每批开始前一句话报进度（「第 2/4 批：`services/`、`storage/`」），不要一声不吭跑半小时。

### Step 4 写组件文档（原版 Peanuts 模板）

对每个目录读源码（入口、导出、关键函数、错误路径），写 `<dir>/<target_filename>`：

```markdown
# <目录名>

## Overview
<这个模块负责什么，边界在哪>

## Interface
<对外可见的入口：函数/类/路由/配置项；带签名或路径>

## Invariants
<必须始终成立的条件；并发、顺序、数据形状>

## Side Effects
<写文件/发请求/改全局状态/打日志；没有就写 None>

## Verification
<怎么验证它还对：测试文件、构建命令、手测步骤>
```

规矩：只写读过的东西，没读到就不写；Interface 里的符号必须真在代码里存在；写不准就标 `[未核实]` 而不是编。
写完立刻写断点 JSON（schema 见上），字段填 `path` / `summary` / `interface` / `invariants` / `side_effects`。

### Step 5 编译中间目录与仓库根

自底向上，用子目录的摘要 + 链接写中间目录文档：

```markdown
# <目录名>

## Overview
## Subdirectories & Boundaries
- [`<child>/`](<child>/<target_filename>) — <一句话职责>
## Local Invariants
## Verification
```

仓库根固定用 Blueprint 模板：

```markdown
# <仓库名> Blueprint

## System Overview
## Local Interface & Invariants
## Subdirectories & System Boundaries
## Global Invariants
## Global Side Effects
## System Verification
```

**改名政策（原版 Correction & Modification Policy）**：目标文件已存在时先读它，保留其标题与既有架构总览，
只补缺失章节；不要整篇覆盖，也不要把人家写好的 Overview 换掉。

根目录若直接含源码，原版会派 `goldfish-explorer` 侦察局部符号——这里没有这个角色，改为自己读那几个文件并在报告里注明「根目录符号为本地阅读所得」。

### Step 6 强制收尾核对

逐份**重读**本次创建/修改的每个文件，检查：

1. `Interface` / `Invariants` / `Side Effects` 三节都非空（没有副作用写 `None`，不能空着）；
2. Markdown 合法：标题层级、代码块闭合、表格列数；
3. **每个相对链接指向的文件真的存在**（逐个 stat，不靠目测）；
4. `Verification` 里的命令与仓库实际构建配置对得上（`package.json` 的 scripts、`Makefile` 目标等）。

发现不合格就修，修完再核一遍。最后给用户：写入文件数、跳过目录数、未覆盖部分、核对结果。

### Step 7 可选：漂移复核

问用户要不要立刻跑 `egm-classic-drift-report` 检查「刚写的契约文档 vs 代码」。
要就跑；不要就收尾。

## 4. 不许做的事

- 不许在没问用户的情况下处理 >15 个目录的树。
- 报告里写明处理方式（并行分区或串行分批）。
- 不许把 `TEST.md`/测试代码当业务源码写进 Interface。
- 不许写没读过的接口；不许把「应该」「大概」写进 Invariants。
- 不许改源码、不许 commit、不许把断点文件落进项目目录。

## 5. 与原版的差异

| 原版 | 这里 |
| --- | --- |
| 并行子编排器 worker | 并行分区处理（每批 ≤5 子树），断点 JSON 用同一 schema |
| `is_worker` / `sub_tree_root` 内部角色 | 不存在；单会话一次到底 |
| `goldfish-explorer` 侦察根目录符号 | 自己读，报告注明来源 |
| `ask_question` 安全门 | `ask_user_question` |
| 文档写项目目录 | 同样写项目目录（这是交付物），但断点/日志写 `.egm/classic/bootstrap/` |
