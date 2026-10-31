/**
 * dsh-egm 技能资源锚定。
 *
 * 背景：本插件的技能随包发布，`resources/`、`agents/`、`vendor/egm/` 都在
 * **插件包根**下，而不是在 `skills/<name>/` 技能目录里。DSH 会在
 * `<skill_resources>` 里写一行 resourceBase 路径，但：
 *
 *   1. 直接读 `skills/<name>/SKILL.md`（/egm kickoff 就是这条路）时，宿主
 *      的 `<skill_resources>` 根本不会出现；
 *   2. 模型很容易把 `resources/xxx.md` 解析成“技能目录下的 resources/”或
 *      “当前工作目录下的 resources/”，两边都没有文件，于是误报“本机包里
 *      不存在”。
 *
 * 所以这里把“包根 + 每条关键依赖的绝对路径”做成同步 API，由 provider 注入
 * 到技能正文顶部，也供 /egm 命令 kickoff 复用。全部同步：命令 handler 不改
 * 成 async 也能直接调用。
 *
 * 只检查随包声明的依赖；不读取用户文件、不访问凭据、不联网。
 *
 * @module dsh-egm/skill-resources
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 资源缺失错误的稳定错误码。 */
export const E_SKILL_RESOURCES_MISSING = 'E_SKILL_RESOURCES_MISSING'

/**
 * 插件包根。`new URL('../', import.meta.url)` 在 Windows 上带尾分隔符，
 * 统一 resolve 掉，保证 manifest 与 runtime resourceBase 是同一个字符串。
 */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** DSH 的技能名语法：kebab-case。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 技能正文里指向包内文件的相对路径。
 * 与 tests/skill-provider.test.js 的引用扫描保持同一口径。
 */
const REFERENCE_PATTERN = /(?:vendor\/egm\/|resources\/|agents\/)[a-zA-Z0-9_/.-]+\.(?:md|json|yml|yaml)/g

/**
 * 声明为“缺一即拒绝”的核心依赖。
 * 其余被 SKILL.md 正文引用的包内文件同样会检查，但这两份技能的关键模板
 * 单独列出来，避免正文改写时被漏掉。
 */
const CORE_RESOURCES = Object.freeze({
  'egm-gate': Object.freeze([
    'resources/design-template.md',
    'resources/gate-rules.md',
    'resources/interaction-contract.md',
  ]),
  'egm-review': Object.freeze([
    'resources/gate-rules.md',
    'resources/interaction-contract.md',
  ]),
})

/** 把包根相对 key 还原成绝对路径，并拒绝越出包根的 key。 */
function resolveResource(root, key) {
  const absolute = resolve(root, ...key.split('/'))
  if (absolute === root || !absolute.startsWith(root + sep)) return undefined
  return absolute
}

/** 读取 SKILL.md；读不到返回 undefined，由调用方决定如何报缺失。 */
function readSkillText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 从技能正文中提取所有包内引用（去重、保持出现顺序）。 */
function extractReferences(text) {
  const found = []
  const seen = new Set()
  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g')
  for (const match of text.matchAll(pattern)) {
    const key = match[0]
    if (seen.has(key)) continue
    seen.add(key)
    found.push(key)
  }
  return found
}

/** 缺失原因的人类可读标签。 */
const REASON_LABELS = Object.freeze({
  missing: '不存在',
  'not-a-file': '不是普通文件',
  empty: '文件为空',
  'outside-package-root': '越出插件包根',
})

/** 构造带稳定 code 的资源缺失错误。 */
function resourceError(skillName, root, missing) {
  const lines = [
    `dsh-egm 技能 "${skillName}" 的资源不完整，已拒绝加载。`,
    `插件包根：${root}`,
    '缺失或不可用的依赖：',
    ...missing.map((item) => `- ${item.key} → ${item.absolute}（${REASON_LABELS[item.reason] ?? item.reason}）`),
    '处理：请重装或修复 dsh-egm 插件包；禁止按技能正文自行补写缺失的模板、规则或契约后继续。',
  ]
  const error = new Error(lines.join('\n'))
  error.name = 'SkillResourcesMissingError'
  error.code = E_SKILL_RESOURCES_MISSING
  error.skillName = skillName
  error.packageRoot = root
  error.missing = missing.map((item) => item.key)
  error.missingAbsolute = missing.map((item) => item.absolute)
  return error
}

/**
 * 同步校验一个技能的随包资源，并返回 manifest。
 *
 * @param {string} skillName 技能名（kebab-case，与 skills/ 下的目录同名）。
 * @param {string} [packageRoot] 插件包根；默认本模块所在包，测试可传临时副本。
 * @returns {{
 *   skillName: string,
 *   packageRoot: string,
 *   skillDir: string,
 *   skillFile: string,
 *   core: string[],
 *   resources: Record<string, string>,
 *   missing: string[],
 * }}
 * @throws {Error & { code: 'E_SKILL_RESOURCES_MISSING', missing: string[] }}
 *   技能文件或任一随包依赖不存在、不是普通文件、为空、或越出包根时抛出。
 */
export function assertSkillResources(skillName, packageRoot = PACKAGE_ROOT) {
  const root = resolve(packageRoot)
  const missing = []
  const resources = {}

  if (typeof skillName !== 'string' || !SKILL_NAME.test(skillName)) {
    throw resourceError(String(skillName), root, [
      {
        key: `skills/${String(skillName)}/SKILL.md`,
        absolute: join(root, 'skills', String(skillName), 'SKILL.md'),
        reason: 'missing',
      },
    ])
  }

  const skillDir = join(root, 'skills', skillName)
  const skillFile = join(skillDir, 'SKILL.md')
  const text = readSkillText(skillFile)

  if (text === undefined) {
    missing.push({ key: `skills/${skillName}/SKILL.md`, absolute: skillFile, reason: 'missing' })
  } else {
    const core = CORE_RESOURCES[skillName] ?? []
    const keys = [...new Set([...core, ...extractReferences(text)])]

    for (const key of keys) {
      const absolute = resolveResource(root, key)
      if (absolute === undefined) {
        missing.push({ key, absolute: join(root, key), reason: 'outside-package-root' })
        continue
      }
      let info
      try {
        info = statSync(absolute)
      } catch {
        missing.push({ key, absolute, reason: 'missing' })
        continue
      }
      if (!info.isFile()) {
        missing.push({ key, absolute, reason: 'not-a-file' })
        continue
      }
      if (info.size === 0) {
        missing.push({ key, absolute, reason: 'empty' })
        continue
      }
      resources[key] = absolute
    }
  }

  if (missing.length > 0) throw resourceError(skillName, root, missing)

  return {
    skillName,
    packageRoot: root,
    skillDir,
    skillFile,
    core: [...(CORE_RESOURCES[skillName] ?? [])],
    resources,
    missing: [],
  }
}

/**
 * 同步返回“资源锚定说明”，供 provider 注入技能正文顶部，也供 /egm kickoff
 * 直接展示给模型。说明里给出包根、SKILL.md 绝对路径和每条依赖的绝对路径。
 *
 * 依赖缺失时与 {@link assertSkillResources} 抛同一个
 * `E_SKILL_RESOURCES_MISSING` 错误——不会返回半截说明让模型“凑着用”。
 *
 * @param {string} skillName
 * @param {string} [packageRoot]
 * @returns {string}
 */
export function skillResourceInstructions(skillName, packageRoot = PACKAGE_ROOT) {
  const manifest = assertSkillResources(skillName, packageRoot)
  const entries = Object.entries(manifest.resources)
  const coreSet = new Set(manifest.core)

  return [
    '## 资源锚定（dsh-egm 自动注入，优先于正文里的相对路径）',
    '',
    `插件包根（resources/、agents/、vendor/ 等随包文件以此为准；.egm/ 等项目文件仍相对当前工作目录）：${manifest.packageRoot}`,
    `本技能文件：${manifest.skillFile}`,
    `注意：技能目录 ${manifest.skillDir} 里只有 SKILL.md；resources/、agents/、vendor/ 都在插件包根下，不在技能目录里，也不在当前工作目录。`,
    '',
    '关键依赖（包根相对路径 → 绝对路径）：',
    ...entries.map(([key, absolute]) => `- ${key} → ${absolute}${coreSet.has(key) ? '（核心依赖）' : ''}`),
    '',
    '执行规则：',
    '1. 正文里所有 `resources/...`、`agents/...`、`vendor/egm/...` 一律按上面的插件包根解析；读文件时直接用上面给出的绝对路径。',
    '2. 不要到技能目录或当前工作目录下找这些随包文件；那里没有。',
    '3. 任何一条读不到就停下，把缺失的绝对路径原样报告给用户；禁止按正文描述自己补写模板、规则或契约后继续。',
  ].join('\n')
}
