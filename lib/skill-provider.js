/**
 * dsh-egm skills provider.
 *
 * 技能不走 ~/.dsh/skills，而是随插件包一起发。插件在 apply 里把本 provider
 * 注册到 ctx.skills，DSH 会像发现普通技能一样发现它们。
 *
 * 契约来自 @deepseek-ai/dsh-skill（已按本机 0.2.x 的 registerProvider 实现对齐）：
 *   registerProvider(create: (control) => SkillProvider)
 *   SkillProvider { name, list(options), get(candidate, options) }
 *
 * @module dsh-egm/skill-provider
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E_SKILL_RESOURCES_MISSING,
  PACKAGE_ROOT,
  skillResourceInstructions,
} from './skill-resources.js'

const SKILLS_DIR = join(PACKAGE_ROOT, 'skills')

/** 与 DSH 的 custom 技能根同档（项目根 100 / custom 300 / 用户 400 / bundled 600）。 */
const CUSTOM_SKILL_RANK = 300

/** DSH 的技能名语法：kebab-case。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 把技能目录声明为资源根，DSH 会把它写进技能的 <skill_resources> 里，
 * 模型据此把 `agents/xxx.md`、`resources/xxx.md` 解析成真实路径。
 */
const RESOURCE_BASE = { kind: 'directory', path: PACKAGE_ROOT }

/**
 * 解析 SKILL.md 的 frontmatter。只支持扁平的 `key: value`，够用且不会误伤正文。
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string }}
 */
function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (match === null) return { data: {}, body: normalized }

  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '' && value !== '') data[key] = value
  }
  return { data, body: normalized.slice(match[0].length) }
}

/** frontmatter 里 `model-invocable: false` 等价于 DSH 的 disable-model-invocation。 */
function readInvocation(data) {
  const modelInvocable = (data['model-invocable'] ?? 'true').toLowerCase() !== 'false' && (data['disable-model-invocation'] ?? 'false').toLowerCase() !== 'true'
  const userInvocable = (data['user-invocable'] ?? 'true').toLowerCase() !== 'false'
  return { modelInvocable, userInvocable }
}

/**
 * 扫描包内 skills/ 目录。
 * 任何一个技能坏掉都不影响其它技能，也绝不抛给宿主。
 * @returns {Promise<Array<{ seq: number, dir: string, file: string }>>}
 */
async function scanSkillDirs() {
  let entries
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  const found = []
  let seq = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(SKILLS_DIR, entry.name)
    const file = join(dir, 'SKILL.md')
    try {
      await readFile(file, 'utf8')
    } catch {
      continue
    }
    found.push({ seq: seq++, dir, file })
  }
  return found
}

/**
 * 核心依赖缺失时的技能正文：明确拒绝，而不是让模型照正文自己凑模板。
 * 只影响这一个技能；其它技能的 list/get 照常。
 * @param {string} skillName
 * @param {string} file
 * @param {unknown} error
 * @returns {string}
 */
function renderResourceRefusal(skillName, file, error) {
  const coded = error !== null && typeof error === 'object' && error.code === E_SKILL_RESOURCES_MISSING
  const detail = error instanceof Error ? error.message : String(error)
  return [
    `# 技能不可用：dsh-egm 包内资源缺失（${skillName}）`,
    '',
    `本技能文件：${file}`,
    '',
    coded
      ? detail
      : `加载技能 "${skillName}" 时检查随包资源失败：${detail}`,
    '',
    '请停止当前流程，把上面的缺失清单原样报告给用户，并请其重装或修复 dsh-egm 插件包。',
    '禁止按技能正文自行补写缺失的模板、规则或契约后继续。',
  ].join('\n')
}

/**
 * 创建 dsh-egm 的技能 provider。
 * @returns {{ name: string, list: Function, get: Function }}
 */
export function createSkillProvider() {
  return {
    name: 'dsh-egm',

    async list() {
      const dirs = await scanSkillDirs()
      const candidates = []
      for (const item of dirs) {
        let text
        try {
          text = await readFile(item.file, 'utf8')
        } catch {
          continue
        }
        const { data } = parseFrontmatter(text)
        const name = (data.name ?? item.dir.split(/[\\/]/).pop() ?? '').trim()
        const description = (data.description ?? '').trim()
        if (!SKILL_NAME.test(name) || description === '') continue

        candidates.push({
          name,
          description,
          ...(data['when-to-use'] === undefined ? {} : { whenToUse: data['when-to-use'] }),
          invocation: readInvocation(data),
          provider: 'dsh-egm',
          source: 'custom',
          resourceBase: RESOURCE_BASE,
          rank: CUSTOM_SKILL_RANK,
          locator: { file: item.file, dir: item.dir },
          metadata: { plugin: 'dsh-egm' },
        })
      }
      return candidates
    },

    async get(candidate) {
      const file = candidate?.locator?.file
      if (typeof file !== 'string') return undefined
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return undefined
      }
      const { data, body } = parseFrontmatter(text)
      const instructions = body.replace(/^(?:[ \t]*\r?\n)+/, '')

      // 把“包根 + 关键依赖绝对路径”直接写进正文：/egm kickoff 直接读
      // SKILL.md 时拿不到宿主 <skill_resources>，只靠相对路径会被误判缺失。
      let content
      try {
        content = `${skillResourceInstructions(candidate.name, PACKAGE_ROOT)}\n\n---\n\n${instructions}`
      } catch (error) {
        content = renderResourceRefusal(candidate.name, file, error)
      }

      return {
        name: candidate.name,
        description: candidate.description,
        ...(data['when-to-use'] === undefined ? {} : { whenToUse: data['when-to-use'] }),
        invocation: candidate.invocation,
        provider: 'dsh-egm',
        source: 'custom',
        resourceBase: RESOURCE_BASE,
        path: file,
        content,
      }
    },
  }
}
