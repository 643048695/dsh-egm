/**
 * dsh-egm 资源锚定契约测试。
 *
 * 这些测试不只断言“正文里出现了某个字符串”，而是证明：
 *   - manifest 给出的绝对路径确实指向可读文件；
 *   - 核心依赖缺任何一份时，assert / instructions 都以稳定 code 明确失败；
 *   - 整个插件包搬到别的目录后，路径跟着新包根走，不再指向源开发目录；
 *   - 一个技能的依赖坏了，其它技能仍然可以独立使用。
 *
 * 需要临时副本时用 cpSync 复制真实包（包很小），测试结束统一删除。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertSkillResources,
  skillResourceInstructions,
  E_SKILL_RESOURCES_MISSING,
  PACKAGE_ROOT,
} from '../lib/skill-resources.js'

const SOURCE_ROOT = resolve(PACKAGE_ROOT)
const CORE_GATE = [
  'resources/design-template.md',
  'resources/gate-rules.md',
  'resources/interaction-contract.md',
]

/** 本文件创建的所有临时父目录，测试结束统一清理。 */
const tempParents = []
/** 动态 import 的缓存键，保证同一路径的副本能按不同状态重新加载。 */
let importCounter = 0

after(() => {
  for (const parent of tempParents) {
    rmSync(parent, { recursive: true, force: true })
  }
})

/** 与 package.json 的 `files` 白名单一致：只复制真正会装进宿主的那部分。 */
const PACKAGE_ENTRIES = [
  'lib',
  'skills',
  'agents',
  'resources',
  'vendor',
  'cordis.patch.yml',
  'package.json',
]

/** 复制一份真实插件包（按安装布局）到临时目录，返回副本包根。 */
function copyPackage() {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-egm-resources-'))
  const root = join(parent, 'relocated-dsh-egm')
  for (const entry of PACKAGE_ENTRIES) {
    const source = join(SOURCE_ROOT, entry)
    if (existsSync(source)) cpSync(source, join(root, entry), { recursive: true })
  }
  tempParents.push(parent)
  return root
}

/** 从副本里动态 import 一个模块（带唯一 query，避免命中源包模块缓存）。 */
function importCopy(root, relativePath) {
  const url = `${pathToFileURL(join(root, relativePath)).href}?copy=${importCounter++}`
  return import(url)
}

/** 断言错误是稳定的资源缺失错误，并检查缺失清单与消息。 */
function isMissingError({ keys = [], absolutePaths = [], root } = {}) {
  return (error) => {
    assert.equal(error?.name, 'SkillResourcesMissingError')
    assert.equal(error.code, E_SKILL_RESOURCES_MISSING)
    for (const key of keys) {
      assert.ok(
        error.missing.includes(key),
        `missing should include "${key}", got ${JSON.stringify(error.missing)}`
      )
    }
    for (const absolutePath of absolutePaths) {
      assert.ok(
        error.missingAbsolute.includes(absolutePath),
        `missingAbsolute should include "${absolutePath}"`
      )
      assert.ok(error.message.includes(absolutePath), 'message must name the missing absolute path')
    }
    if (root) assert.ok(error.message.includes(root), 'message must name the package root')
    assert.ok(
      error.message.includes('禁止按技能正文自行补写'),
      'message must forbid improvising the missing template from the skill body'
    )
    return true
  }
}

/** 包内所有带 SKILL.md 的技能名。 */
function skillNames(root = SOURCE_ROOT) {
  return readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}

describe('assertSkillResources on the real package', () => {
  it('returns absolute, inside-root, readable paths for every discovered skill', () => {
    const names = skillNames()
    assert.ok(names.includes('egm-gate'))
    assert.ok(names.includes('egm-review'))
    assert.equal(names.length, 9)

    for (const name of names) {
      const manifest = assertSkillResources(name)

      assert.equal(manifest.skillName, name)
      assert.equal(manifest.packageRoot, SOURCE_ROOT)
      assert.equal(manifest.skillFile, join(SOURCE_ROOT, 'skills', name, 'SKILL.md'))
      assert.deepEqual(manifest.missing, [])

      const skillText = readFileSync(manifest.skillFile, 'utf8')
      assert.match(skillText, /^---/, `${name}: SKILL.md is a real file with frontmatter`)

      for (const [key, absolutePath] of Object.entries(manifest.resources)) {
        assert.ok(key === key.replaceAll('\\', '/'), `${name}: manifest keys are package-root relative POSIX paths`)
        assert.ok(isAbsolute(absolutePath), `${name}: ${key} resolves to an absolute path`)
        assert.ok(
          absolutePath.startsWith(SOURCE_ROOT + sep),
          `${name}: ${key} stays inside the package root`
        )
        assert.equal(absolutePath, resolve(SOURCE_ROOT, ...key.split('/')))
        const info = statSync(absolutePath)
        assert.ok(info.isFile(), `${name}: ${key} is a regular file`)
        assert.ok(info.size > 0, `${name}: ${key} is non-empty`)
      }
    }
  })

  it('declares egm-gate core dependencies and includes each one in the manifest', () => {
    const manifest = assertSkillResources('egm-gate')
    assert.deepEqual(manifest.core, CORE_GATE)
    for (const key of CORE_GATE) {
      assert.ok(manifest.resources[key], `egm-gate manifest contains ${key}`)
    }
    assert.match(readFileSync(manifest.resources['resources/design-template.md'], 'utf8'), /图纸模板/)
  })

  it('refuses unknown or invalid skill names with the stable code', () => {
    assert.throws(
      () => assertSkillResources('egm-does-not-exist'),
      isMissingError({ keys: ['skills/egm-does-not-exist/SKILL.md'] })
    )
    assert.throws(
      () => assertSkillResources('../escape'),
      isMissingError()
    )
  })

  it('returns the anchoring instructions synchronously with every dependency path', () => {
    const text = skillResourceInstructions('egm-gate')
    assert.equal(typeof text, 'string')
    assert.ok(!(text instanceof Promise))

    const manifest = assertSkillResources('egm-gate')
    assert.ok(text.includes(manifest.packageRoot))
    assert.ok(text.includes(manifest.skillFile))
    for (const [key, absolutePath] of Object.entries(manifest.resources)) {
      assert.ok(text.includes(`${key} → ${absolutePath}`), `instructions list ${key} with its absolute path`)
    }
    assert.match(text, /禁止按正文描述自己补写/)
  })
})

describe('missing core resources fail clearly', () => {
  for (const key of CORE_GATE) {
    it(`reports E_SKILL_RESOURCES_MISSING when ${key} is deleted`, () => {
      const root = copyPackage()
      const absolutePath = join(root, ...key.split('/'))
      rmSync(absolutePath)

      assert.throws(
        () => assertSkillResources('egm-gate', root),
        isMissingError({ keys: [key], absolutePaths: [absolutePath], root })
      )
      assert.throws(
        () => skillResourceInstructions('egm-gate', root),
        isMissingError({ keys: [key], absolutePaths: [absolutePath], root }),
        'instructions must not return a half-usable block when a dependency is gone'
      )

      // 同一份副本里，不依赖该文件的技能仍然可用。
      assert.doesNotThrow(() => assertSkillResources('egm-classic-review', root))
    })
  }

  it('reports an empty core dependency instead of accepting it', () => {
    const root = copyPackage()
    const absolutePath = join(root, 'resources', 'gate-rules.md')
    writeFileSync(absolutePath, '')

    assert.throws(
      () => assertSkillResources('egm-review', root),
      (error) => {
        assert.equal(error.code, E_SKILL_RESOURCES_MISSING)
        assert.ok(error.missing.includes('resources/gate-rules.md'))
        assert.match(error.message, /文件为空/)
        return true
      }
    )
  })

  it('reports a missing SKILL.md itself', () => {
    const root = copyPackage()
    rmSync(join(root, 'skills', 'egm-review', 'SKILL.md'))

    assert.throws(
      () => assertSkillResources('egm-review', root),
      isMissingError({ keys: ['skills/egm-review/SKILL.md'] })
    )
  })
})

describe('references discovered in the skill body', () => {
  it('checks a body-declared resource that is not in the core list', () => {
    const root = copyPackage()
    const skillDir = join(root, 'skills', 'egm-synthetic')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# 合成技能\n\n先读 resources/synthetic-template.md，再读 agents/logic-critic.md。\n'
    )

    const missingKey = 'resources/synthetic-template.md'
    assert.throws(
      () => assertSkillResources('egm-synthetic', root),
      isMissingError({ keys: [missingKey], absolutePaths: [join(root, 'resources', 'synthetic-template.md')] })
    )

    writeFileSync(join(root, 'resources', 'synthetic-template.md'), '# 合成模板\n\n内容。\n')
    const manifest = assertSkillResources('egm-synthetic', root)
    assert.deepEqual(manifest.core, [])
    assert.ok(manifest.resources[missingKey])
    assert.ok(manifest.resources['agents/logic-critic.md'], 'existing referenced agent card is also anchored')
  })

  it('refuses a body reference that escapes the package root instead of touching user files', () => {
    const root = copyPackage()
    const skillDir = join(root, 'skills', 'egm-escape')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# 越界引用\n\n读取 resources/../../outside-the-package.md。\n'
    )

    assert.throws(
      () => assertSkillResources('egm-escape', root),
      (error) => {
        assert.equal(error.code, E_SKILL_RESOURCES_MISSING)
        assert.ok(error.missing.some((key) => key.includes('outside-the-package.md')))
        assert.match(error.message, /越出插件包根/)
        return true
      }
    )
  })
})

describe('relocated package follows its new root', () => {
  it('points PACKAGE_ROOT and every resource at the copy, never at the source checkout', async () => {
    const root = copyPackage()
    const relocated = await importCopy(root, 'lib/skill-resources.js')

    assert.equal(relocated.PACKAGE_ROOT, root)
    const manifest = relocated.assertSkillResources('egm-gate')
    assert.equal(manifest.packageRoot, root)
    assert.equal(manifest.skillFile, join(root, 'skills', 'egm-gate', 'SKILL.md'))

    const template = manifest.resources['resources/design-template.md']
    assert.ok(template.startsWith(root + sep), 'resource path follows the relocated root')
    assert.ok(!template.startsWith(SOURCE_ROOT + sep), 'resource path must not point at the source checkout')
    assert.match(readFileSync(template, 'utf8'), /图纸模板/)
  })

  it('keeps all other skills usable when egm-gate loses a core resource', async () => {
    const root = copyPackage()
    rmSync(join(root, 'resources', 'design-template.md'))
    const { createSkillProvider } = await importCopy(root, 'lib/skill-provider.js')
    const relocated = await importCopy(root, 'lib/skill-resources.js')

    const provider = createSkillProvider()
    const candidates = await provider.list()
    assert.equal(candidates.length, 9, 'discovery still sees all nine skills')
    for (const candidate of candidates) {
      assert.equal(resolve(candidate.resourceBase.path), root, `${candidate.name}: resourceBase follows the copy`)
    }

    const gate = candidates.find((candidate) => candidate.name === 'egm-gate')
    assert.ok(gate)
    const broken = await provider.get(gate)
    assert.match(broken.content, /^# 技能不可用：dsh-egm 包内资源缺失（egm-gate）/)
    assert.ok(broken.content.includes(join(root, 'resources', 'design-template.md')))
    assert.ok(!broken.content.includes('## 资源锚定'), 'a broken skill gets no usable anchoring block')
    assert.ok(broken.content.includes('禁止按技能正文自行补写'))

    // 其它技能照常可用，且正文里的绝对路径都是新包根下的真实文件。
    for (const candidate of candidates) {
      if (candidate.name === 'egm-gate') continue
      const skill = await provider.get(candidate)
      assert.match(skill.content, /^## 资源锚定/, `${candidate.name}: still anchored`)
      assert.ok(skill.content.includes(root), `${candidate.name}: names the relocated root`)

      const manifest = relocated.assertSkillResources(candidate.name, root)
      for (const absolutePath of Object.values(manifest.resources)) {
        assert.ok(skill.content.includes(absolutePath), `${candidate.name}: body names ${absolutePath}`)
        assert.ok(statSync(absolutePath).size > 0)
      }
    }
  })
})
