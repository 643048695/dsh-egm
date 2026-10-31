# 上游来源与校验（vendor/egm）

这个目录是 **Google Elephant-Goldfish Model（EGM）原版材料的镜像**，不是 DSH 适配版。
除 `site/`、`distributions/` 外，pin 上的整棵源码树都在这里；文件内容一个字节都没改。
DSH 适配在 `skills/egm-classic-*` 与 `resources/classic-*.md`；先读 `resources/classic-fidelity.md`
弄清哪些能用、哪些不能用。

## 来源

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/google/elephant-goldfish-model |
| commit | `a8380ab5f0aba392c97e31c79f9a6666b3f09f14` |
| 抓取方式 | `codeload.github.com/.../tar.gz/a8380ab5...`（整仓库 tarball，非逐文件 raw） |
| 抓取时间 | 2026-10-28（本机） |
| 许可 | Apache License 2.0；原文见 `vendor/egm/LICENSE`（与包根 `LICENSE` 逐字节相同） |

## 复制了什么（121 个上游文件 + 本文件 + SHA256SUMS）

| 路径 | 内容 | 数量 |
| --- | --- | --- |
| `agents/` | 9 个评审/编排角色人格卡 | 9 |
| `resources/` | `README.md`、`execution_instructions.md`、`document_standards/` 5 份标准 | 7 |
| `skills/` | 7 个 skill 包：`SKILL.md` + `references/`（有则含）+ `assets/icon.svg` + `agents/openai.yaml` + `TEST.md` + `test_scenarios.yaml` | 37 |
| `docs/` | 9 篇文档 + `designs/` 11 篇 + `assets/readme-header.svg` | 21 |
| `tests/` | 上游 pytest 套件（unit / integration / conftest） | 11 |
| `scripts/` | `pack_plugin.py` 等发布打包脚本 | 2 |
| `assets/` | 图标等静态资源 | 1 |
| 根文件 | `LICENSE`、`README.md`、`TESTING.md`、`AGENTS.md`、`AI_POLICY.md`、`CONTRIBUTING.md`、`plugin.json`、`pyproject.toml`、`requirements-dev.txt`、`.gitattributes`、`.gitignore` | 11 |
| 宿主清单 | `.claude-plugin/`、`.codex-plugin/`、`.agents/`、`.github/`（workflows） | 21 |
| 合计 | | 121 |

校验清单：`SHA256SUMS`（在 `vendor/egm/` 下执行 `sha256sum -c SHA256SUMS` 可复验，122 行 = 121 个上游文件 + 本文件）。
本文件自己也在清单里：改动本文件后必须重算整份 `SHA256SUMS`，否则 `UPSTREAM.md: FAILED` 属于预期。重算步骤见文末「重新生成 SHA256SUMS」。

## 校验证据

1. 复制时对每个文件算 sha256 并与 pin tarball 对比：**全部相同，0 个不同，0 个缺失**。
2. `.tmp-egm` 快照（24 个文件）也与 pin 一致：22 个按 kebab 路径直接比对 sha1 相同；
   `egm_drift_report`、`egm_review_loop` 只是快照用了下划线目录名，文件 sha1 与 pin 的
   `egm-drift-report`、`egm-review-loop` 相同。快照缺 `LICENSE`、`docs/`、图标、
   `worker-return.schema.json`、测试套件，所以本目录**以 pin 为准**，不用快照补。
3. 上游自带的 `TEST.md`、`test_scenarios.yaml`、`tests/`、`TESTING.md`、`scripts/` **原样保留供参考**。
   运行情况只有一条可引用：2026-10-28 在本目录副本里跑过 `tests/unit/test_frontmatter.py` 与 `tests/unit/test_scenario_coverage.py`，
   **2 passed**；其余测试（含读 `distributions/`、`site/` 的打包测试）没跑，DSH 里也没跑过任何 EGM 流程。
   不能由此推「上游测试全绿」或「DSH 能跑原版」。

## 未复制的部分

| 未复制 | 原因 |
| --- | --- |
| `site/`（2.0 MB） | 上游文档站的构建产物；不是技能运行期材料 |
| `distributions/`（365 KB） | 上游 `scripts/pack_plugin.py` 打出的发布包；可由脚本再生成 |
| `NOTICE` | 上游仓库**没有** NOTICE 文件；包根 `NOTICE` 是 dsh-egm 自己补的出处声明 |

要完整复现上游 pytest（`tests/unit/test_packaging.py` 会读 `distributions/claude` 与 `site/font.woff2`），
需按上面的 commit 补齐这两个目录。本包不做这个声明：这里的测试**未被运行**。

## 上游材料里对 DSH 无效的引用

这些是原版内容的一部分，**保持原文不动**，但在 DSH 里不可用：

- `${CLAUDE_PLUGIN_ROOT}/docs/claude.md`、Codex / ChatGPT Work / Claude Code / Cowork 的宿主说明；
- `ask_question`（DSH 对应 `ask_user_question`）、`spawn_agent` / `invoke_subagent` / `Agent`
  （DSH 的派发通道是 `egm_dispatch`，插件规则不允许其它金鱼通道）；
- `skills/*/agents/openai.yaml`、`.claude-plugin/`、`.codex-plugin/`、`.agents/`：其它宿主的安装与展示元数据，DSH 不读；
- `docs/` 里指向 `github.com`、`egm.dev`、Medium 的外链。

另外注意：`vendor/egm/AGENTS.md` 是**上游仓库自己的协作守则**（PR 流程、design doc 门槛），
它只描述怎么给上游提 PR，不是 dsh-egm 的规矩；读它时别把上游的 PR 流程套到本包上。

## 修改政策

- `vendor/egm/` 内的上游文件**保持原文**：不翻译、不改措辞、不修链接、不放宽任何规则。
- 适配只发生在 `skills/egm-classic-*`、`resources/classic-*.md`、包根 `NOTICE`，以及本文件与 `SHA256SUMS`。
- 升级上游：换 commit 重抓、重跑逐文件比对、更新本文件与 `SHA256SUMS`，并重新核对
  `lib/dispatch.js` 的角色/标准映射表（那张表是代码里的唯一事实来源）。

## 重新生成 SHA256SUMS

清单覆盖 `vendor/egm/` 下除 `SHA256SUMS` 自身以外的全部文件（121 个上游文件 + `UPSTREAM.md`），
条目按路径字节序排序，格式 `<sha256> *<相对路径>`，**必须用 LF 换行**（用 CRLF 重写会让每条都因行尾回车而 `FAILED open or read`）。

```bash
cd dsh-egm/vendor/egm
python - <<'EOF'
import hashlib, os
rows = []
for root, dirs, files in os.walk('.'):
    for name in files:
        path = os.path.relpath(os.path.join(root, name), '.')
        if path == 'SHA256SUMS':
            continue
        with open(path, 'rb') as fh:
            rows.append((hashlib.sha256(fh.read()).hexdigest(), path))
rows.sort(key=lambda item: item[1].encode())
with open('SHA256SUMS', 'wb') as out:
    for digest, path in rows:
        out.write(f'{digest} *{path}
'.encode())
EOF
sha256sum -c SHA256SUMS | grep -v ': OK$'   # 无输出即全部通过
```

## 源码镜像 vs npm 安装包（重要区别）

本目录是**源码镜像**：121 个上游文件 + 本文件 + `SHA256SUMS`，逐文件哈希与 pin commit 一致。
但**发布出去的 npm 包不是逐字节完整镜像**：

- npm 打包时会强制省略 `.gitignore`（npm 把 `.gitignore` 视作 `.npmignore` 的等价物处理，不随包发布）。
- 实测 `npm pack --dry-run`：全包 155 个条目，其中 `vendor/` 下 122 项
  = 121 个上游文件 − `.gitignore` + `UPSTREAM.md` + `SHA256SUMS`。隐藏目录（`.claude-plugin/`、`.agents/`、`.github/`）、
  `tests/`、`scripts/`、`assets/` 都在包里。
- 因此在**从 npm 安装**的副本里执行 `sha256sum -c SHA256SUMS`，只会看到一条
  `.gitignore: FAILED open or read`（文件不存在，不是内容被改）；其余 121 项应全部 OK。
  在**源码镜像**里执行则 122 项全部 OK。
- 说法上的红线：可以说「源码镜像 121 个上游文件逐字节一致」，**不能说「npm 包 121 文件逐字节完整」**。

清单格式：LF 换行、正斜杠相对路径（Windows 生成的清单若写成反斜杠，换到 Linux/macOS 或其它工具里会读不到文件）。

